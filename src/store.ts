/**
 * Durable storage on Node's built-in SQLite. One file, no server, no
 * dependencies. Every table carries tenant_id and every query is scoped by it:
 * customers' operational data never mixes (spec §11).
 *
 * The spec allows PostgreSQL; SQLite is enough for a pilot's volume and keeps
 * the MVP to one process. The engine only talks to the `Store` class, so a
 * Postgres implementation is a drop-in later.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { BoundaryMatch } from "./deployment.ts";
import type { Estimate, ProcessBox, Ref, RefLink, SourceEvent } from "./model.ts";

export interface StoredEvent extends SourceEvent {
  jobId: string | null;
  matches: BoundaryMatch[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  confidence TEXT NOT NULL,
  mode TEXT,
  refs TEXT NOT NULL,
  attrs TEXT NOT NULL,
  matches TEXT NOT NULL,
  job_id TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, source_event_id)
);
CREATE INDEX IF NOT EXISTS events_job ON events (tenant_id, job_id, occurred_at);
CREATE TABLE IF NOT EXISTS refs (
  tenant_id TEXT NOT NULL,
  system TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  method TEXT NOT NULL,
  reason TEXT NOT NULL,
  score REAL NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, system, id)
);
CREATE INDEX IF NOT EXISTS refs_job ON refs (tenant_id, job_id);
CREATE TABLE IF NOT EXISTS boxes (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  box_type TEXT NOT NULL,
  parent_id TEXT,
  in_at TEXT,
  body TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, job_id, box_type)
);
CREATE INDEX IF NOT EXISTS boxes_type ON boxes (tenant_id, box_type, in_at);
CREATE TABLE IF NOT EXISTS estimates (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` atomically. Not re-entrant: callers inside `fn` use the plain methods. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── jobs ─────────────────────────────────────────────────────────────────
  createJob(tenantId: string, id: string, at: string): void {
    this.run("INSERT INTO jobs (tenant_id, id, created_at) VALUES (?, ?, ?)", tenantId, id, at);
  }

  jobCreatedAt(tenantId: string, id: string): string | undefined {
    return this.get<{ created_at: string }>("SELECT created_at FROM jobs WHERE tenant_id = ? AND id = ?", tenantId, id)
      ?.created_at;
  }

  /** Sort key for "which job is older": creation time, then insertion order for ties. */
  jobAge(tenantId: string, id: string): string | undefined {
    const row = this.get<{ created_at: string; seq: number }>(
      "SELECT created_at, rowid AS seq FROM jobs WHERE tenant_id = ? AND id = ?",
      tenantId, id,
    );
    return row && `${row.created_at}#${String(row.seq).padStart(12, "0")}`;
  }

  deleteJob(tenantId: string, id: string): void {
    this.run("DELETE FROM jobs WHERE tenant_id = ? AND id = ?", tenantId, id);
  }

  // ── refs ─────────────────────────────────────────────────────────────────
  findRef(tenantId: string, ref: Ref): RefLink | undefined {
    const row = this.get<RefRow>("SELECT * FROM refs WHERE tenant_id = ? AND system = ? AND id = ?", tenantId, ref.system, ref.id);
    return row && refFromRow(row);
  }

  insertRef(tenantId: string, link: RefLink): void {
    this.run(
      "INSERT INTO refs (tenant_id, system, id, job_id, method, reason, score, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      tenantId, link.system, link.id, link.jobId, link.method, link.reason, link.score, link.linkedAt,
    );
  }

  refsOfJob(tenantId: string, jobId: string): RefLink[] {
    return this.all<RefRow>("SELECT * FROM refs WHERE tenant_id = ? AND job_id = ? ORDER BY linked_at, system, id", tenantId, jobId).map(refFromRow);
  }

  relabelRefs(tenantId: string, jobId: string, method: RefLink["method"], reason: string, score: number): void {
    this.run("UPDATE refs SET method = ?, reason = ?, score = ? WHERE tenant_id = ? AND job_id = ?", method, reason, score, tenantId, jobId);
  }

  moveRefs(tenantId: string, fromJob: string, toJob: string): void {
    this.run("UPDATE refs SET job_id = ? WHERE tenant_id = ? AND job_id = ?", toJob, tenantId, fromJob);
  }

  // ── events ───────────────────────────────────────────────────────────────
  findEventBySourceId(tenantId: string, source: string, sourceEventId: string): StoredEvent | undefined {
    const row = this.get<EventRow>(
      "SELECT * FROM events WHERE tenant_id = ? AND source = ? AND source_event_id = ?",
      tenantId, source, sourceEventId,
    );
    return row && eventFromRow(row);
  }

  insertEvent(e: StoredEvent): void {
    this.run(
      `INSERT INTO events (tenant_id, id, source, source_event_id, event_type, occurred_at, received_at, confidence, mode, refs, attrs, matches, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.tenantId, e.id, e.source, e.sourceEventId, e.eventType, e.occurredAt, e.receivedAt, e.confidence, e.mode ?? null,
      JSON.stringify(e.refs), JSON.stringify(e.attrs), JSON.stringify(e.matches), e.jobId,
    );
  }

  eventsOfJob(tenantId: string, jobId: string): StoredEvent[] {
    return this.all<EventRow>(
      "SELECT * FROM events WHERE tenant_id = ? AND job_id = ? ORDER BY occurred_at, received_at, id",
      tenantId, jobId,
    ).map(eventFromRow);
  }

  updateEventMatching(tenantId: string, id: string, refs: Ref[], matches: BoundaryMatch[], jobId: string | null): void {
    this.run(
      "UPDATE events SET refs = ?, matches = ?, job_id = ? WHERE tenant_id = ? AND id = ?",
      JSON.stringify(refs), JSON.stringify(matches), jobId, tenantId, id,
    );
  }

  allEvents(tenantId: string): StoredEvent[] {
    return this.all<EventRow>("SELECT * FROM events WHERE tenant_id = ? ORDER BY occurred_at, id", tenantId).map(eventFromRow);
  }

  jobIds(tenantId: string): string[] {
    return this.all<{ id: string }>("SELECT id FROM jobs WHERE tenant_id = ? ORDER BY created_at, rowid", tenantId).map((r) => r.id);
  }

  moveEvents(tenantId: string, fromJob: string, toJob: string): void {
    this.run("UPDATE events SET job_id = ? WHERE tenant_id = ? AND job_id = ?", toJob, tenantId, fromJob);
  }

  /** Events that carried no identifier: measured nowhere until a sensor or mapping adds one. */
  uncorrelatedCount(tenantId: string): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND job_id IS NULL", tenantId)?.n ?? 0;
  }

  recentEvents(tenantId: string, limit: number): StoredEvent[] {
    return this.all<EventRow>("SELECT * FROM events WHERE tenant_id = ? ORDER BY received_at DESC, id LIMIT ?", tenantId, limit).map(eventFromRow);
  }

  // ── boxes ────────────────────────────────────────────────────────────────
  boxesOfJob(tenantId: string, jobId: string): ProcessBox[] {
    return this.all<BoxRow>("SELECT body FROM boxes WHERE tenant_id = ? AND job_id = ?", tenantId, jobId).map(boxFromRow);
  }

  getBox(tenantId: string, id: string): ProcessBox | undefined {
    const row = this.get<BoxRow>("SELECT body FROM boxes WHERE tenant_id = ? AND id = ?", tenantId, id);
    return row && boxFromRow(row);
  }

  upsertBox(box: ProcessBox): void {
    this.run(
      `INSERT INTO boxes (tenant_id, id, job_id, box_type, parent_id, in_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, id) DO UPDATE SET job_id = excluded.job_id, box_type = excluded.box_type,
         parent_id = excluded.parent_id, in_at = excluded.in_at, body = excluded.body`,
      box.tenantId, box.id, box.jobId, box.boxType, box.parentId, box.in?.at ?? null, JSON.stringify(box),
    );
  }

  deleteBox(tenantId: string, id: string): void {
    this.run("DELETE FROM boxes WHERE tenant_id = ? AND id = ?", tenantId, id);
  }

  /** Boxes of one type, newest IN first; boxes without an IN last. */
  listBoxes(tenantId: string, filter: { boxType?: string; from?: string; to?: string; limit?: number } = {}): ProcessBox[] {
    const where = ["tenant_id = ?"];
    const args: SQLInputValue[] = [tenantId];
    if (filter.boxType) (where.push("box_type = ?"), args.push(filter.boxType));
    if (filter.from) (where.push("in_at >= ?"), args.push(filter.from));
    if (filter.to) (where.push("in_at < ?"), args.push(filter.to));
    args.push(filter.limit ?? 500);
    return this.all<BoxRow>(
      `SELECT body FROM boxes WHERE ${where.join(" AND ")} ORDER BY in_at IS NULL, in_at DESC, id LIMIT ?`,
      ...args,
    ).map(boxFromRow);
  }

  // ── estimates ────────────────────────────────────────────────────────────
  insertEstimate(e: Estimate): void {
    this.run("INSERT INTO estimates (tenant_id, id, body) VALUES (?, ?, ?)", e.tenantId, e.id, JSON.stringify(e));
  }

  listEstimates(tenantId: string, boxType?: string): Estimate[] {
    return this.all<{ body: string }>("SELECT body FROM estimates WHERE tenant_id = ?", tenantId)
      .map((r) => JSON.parse(r.body) as Estimate)
      .filter((e) => boxType === undefined || e.boxType === boxType)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  // ── plumbing ─────────────────────────────────────────────────────────────
  private run(sql: string, ...args: SQLInputValue[]): void {
    this.db.prepare(sql).run(...args);
  }

  private get<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  private all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
}

interface RefRow {
  system: string;
  id: string;
  job_id: string;
  method: RefLink["method"];
  reason: string;
  score: number;
  linked_at: string;
}

function refFromRow(r: RefRow): RefLink {
  return { system: r.system, id: r.id, jobId: r.job_id, method: r.method, reason: r.reason, score: r.score, linkedAt: r.linked_at };
}

interface EventRow {
  tenant_id: string;
  id: string;
  source: SourceEvent["source"];
  source_event_id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  confidence: SourceEvent["confidence"];
  mode: SourceEvent["mode"] | null;
  refs: string;
  attrs: string;
  matches: string;
  job_id: string | null;
}

function eventFromRow(r: EventRow): StoredEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    source: r.source,
    sourceEventId: r.source_event_id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    receivedAt: r.received_at,
    confidence: r.confidence,
    ...(r.mode ? { mode: r.mode } : {}),
    refs: JSON.parse(r.refs) as Ref[],
    attrs: JSON.parse(r.attrs) as SourceEvent["attrs"],
    matches: JSON.parse(r.matches) as BoundaryMatch[],
    jobId: r.job_id,
  };
}

interface BoxRow {
  body: string;
}

function boxFromRow(r: BoxRow): ProcessBox {
  return JSON.parse(r.body) as ProcessBox;
}
