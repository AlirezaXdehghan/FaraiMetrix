/**
 * The Metrix engine: take a normalized sensor event, keep it, put it on the
 * right job, and re-measure that job's boxes.
 *
 * Measurement is recomputed from the job's stored events every time, never
 * patched incrementally. So delivery order does not matter (a quote email that
 * arrives before the call's REQUEST_COMPLETE still lands correctly), a
 * duplicate delivery changes nothing, and merging two jobs is just moving rows.
 */

import { randomUUID } from "node:crypto";
import {
  canonicalRef,
  couldMatchTransient,
  extractRefs,
  matchBoundaries,
  modeAt,
  type BoxDefinition,
  type Deployment,
} from "./deployment.ts";
import {
  worseConfidence,
  type Boundary,
  type Estimate,
  type ProcessBox,
  type Ref,
  type RefLink,
  type SourceEventInput,
} from "./model.ts";
import type { StoredEvent, Store } from "./store.ts";

/** Transient metadata a sensor may hand over for matching. Never stored. */
export interface Transient {
  subject?: string;
  attachments?: string[];
}

export interface IngestResult {
  event: StoredEvent;
  duplicate: boolean;
  /** Null when the event carried no identifier at all. */
  jobId: string | null;
  boxes: ProcessBox[];
}

export interface JobView {
  jobId: string;
  refs: RefLink[];
  events: StoredEvent[];
  boxes: ProcessBox[];
}

/** Agent event types (the Metrix Agent's buttons). `attrs.boxType` says which box. */
export const AGENT_START = "AGENT_START";
export const AGENT_PAUSE = "AGENT_PAUSE";
export const AGENT_RESUME = "AGENT_RESUME";
export const AGENT_DONE = "AGENT_DONE";

export class Metrix {
  private readonly store: Store;
  private readonly deployments: ReadonlyMap<string, Deployment>;
  private readonly now: () => Date;

  constructor(store: Store, deployments: ReadonlyMap<string, Deployment>, now: () => Date = () => new Date()) {
    this.store = store;
    this.deployments = deployments;
    this.now = now;
  }

  deployment(tenantId: string): Deployment {
    const d = this.deployments.get(tenantId);
    if (!d) throw new Error(`no deployment for tenant "${tenantId}"`);
    return d;
  }

  /**
   * `refresh`: when the event was seen before, match it again against the
   * current deployment with the metadata given now (and add any identifiers it
   * yields) instead of answering "duplicate". Re-importing a mailbox with
   * `--refresh` is how changed subject or filename rules reach old emails:
   * that metadata was never stored, so it can only be re-read from the source.
   */
  ingest(tenantId: string, input: SourceEventInput, transient: Transient = {}, options: IngestOptions = {}): IngestResult {
    const deployment = this.deployment(tenantId);
    const occurredAt = isoOrThrow(input.occurredAt, "occurredAt");
    const { link } = options;
    return this.store.transaction(() => {
      const existing = this.store.findEventBySourceId(tenantId, input.source, input.sourceEventId);
      if (existing && options.refresh) {
        const ctx = { event: { ...input, occurredAt }, ...transient };
        const refs = dedupeRefs(
          [...existing.refs, ...input.refs, ...extractRefs(deployment, ctx)].map((r) => canonicalRef(deployment, r)),
        );
        const matches = matchBoundaries(deployment, ctx);
        const jobId = refs.length ? this.resolveJob(tenantId, refs, input, link) : null;
        const event: StoredEvent = { ...existing, refs, matches, jobId };
        this.store.updateEventMatching(tenantId, event.id, refs, matches, jobId);
        return { event, duplicate: true, jobId, boxes: jobId ? this.measureJob(tenantId, jobId) : [] };
      }
      if (existing) {
        return {
          event: existing,
          duplicate: true,
          jobId: existing.jobId,
          boxes: existing.jobId ? this.store.boxesOfJob(tenantId, existing.jobId) : [],
        };
      }
      const ctx = { event: { ...input, occurredAt }, ...transient };
      const refs = dedupeRefs([...input.refs, ...extractRefs(deployment, ctx)].map((r) => canonicalRef(deployment, r)));
      const matches = matchBoundaries(deployment, ctx);
      const jobId = refs.length ? this.resolveJob(tenantId, refs, input, link) : null;
      const event: StoredEvent = {
        ...input,
        occurredAt,
        id: randomUUID(),
        tenantId,
        receivedAt: this.now().toISOString(),
        refs,
        matches,
        jobId,
      };
      this.store.insertEvent(event);
      const boxes = jobId ? this.measureJob(tenantId, jobId) : [];
      return { event, duplicate: false, jobId, boxes };
    });
  }

  /**
   * Declare that identifiers belong to the same job (spec §6). "mapping" is a
   * human or system statement and counts as exact; "inferred" must carry a
   * reason and a score below 1. Recorded as a manual event so the job's audit
   * trail shows when and why two jobs became one.
   */
  link(tenantId: string, refs: Ref[], options: LinkOptions & { sourceEventId?: string }): IngestResult {
    if (refs.length < 2) throw new Error("link needs at least two refs");
    if (!options.reason.trim()) throw new Error("link needs a reason");
    const score = options.method === "mapping" ? 1 : options.score;
    if (!(score > 0 && score <= 1)) throw new Error("score must be in (0, 1]");
    return this.ingest(
      tenantId,
      {
        source: "manual",
        sourceEventId: options.sourceEventId ?? randomUUID(),
        eventType: "CORRELATION_LINKED",
        occurredAt: this.now().toISOString(),
        confidence: "A",
        refs,
        attrs: { method: options.method, reason: options.reason, score },
      },
      {},
      { link: { ...options, score } },
    );
  }

  job(tenantId: string, jobId: string): JobView | undefined {
    if (!this.store.jobCreatedAt(tenantId, jobId)) return undefined;
    return {
      jobId,
      refs: this.store.refsOfJob(tenantId, jobId),
      events: this.store.eventsOfJob(tenantId, jobId),
      boxes: this.store.boxesOfJob(tenantId, jobId),
    };
  }

  jobOfRef(tenantId: string, ref: Ref): JobView | undefined {
    const link = this.store.findRef(tenantId, canonicalRef(this.deployment(tenantId), ref));
    return link && this.job(tenantId, link.jobId);
  }

  /**
   * Re-match every stored event against the current deployment and re-measure
   * every job: run after changing a deployment's rules. Rules on event type,
   * source and attributes are re-evaluated. Rules on the subject or attachment
   * names cannot be (that metadata is never stored), so matches they made are
   * kept as long as the box still has such a rule; re-import with `refresh` to
   * re-evaluate those.
   */
  rematch(tenantId: string): { events: number; jobs: number } {
    const deployment = this.deployment(tenantId);
    const unjudgeable = (e: StoredEvent, boxType: string, role: string) => {
      const def = deployment.boxes.find((b) => b.boxType === boxType);
      const matchers = def ? (role === "in" ? def.in : role === "out" ? def.out : (def.gate ?? [])) : [];
      return matchers.some((m) => couldMatchTransient(m, e));
    };
    return this.store.transaction(() => {
      let events = 0;
      for (const e of this.store.allEvents(tenantId)) {
        const matches = matchBoundaries(deployment, { event: e });
        for (const m of e.matches) {
          if (unjudgeable(e, m.boxType, m.role) && !matches.some((x) => x.boxType === m.boxType && x.role === m.role)) {
            matches.push(m);
          }
        }
        this.store.updateEventMatching(tenantId, e.id, e.refs, matches, e.jobId);
        events += 1;
      }
      const jobs = this.store.jobIds(tenantId);
      for (const jobId of jobs) this.measureJob(tenantId, jobId);
      return { events, jobs: jobs.length };
    });
  }

  addEstimate(tenantId: string, input: Omit<Estimate, "id" | "tenantId" | "recordedAt">): Estimate {
    this.deployment(tenantId);
    if (!(Number.isFinite(input.minutes) && input.minutes > 0)) throw new Error("minutes must be a positive number");
    const estimate: Estimate = { ...input, id: randomUUID(), tenantId, recordedAt: this.now().toISOString() };
    this.store.insertEstimate(estimate);
    return estimate;
  }

  // ── correlation ──────────────────────────────────────────────────────────

  private resolveJob(tenantId: string, refs: Ref[], input: SourceEventInput, link?: LinkOptions): string {
    const known = new Map<string, string>(); // jobId -> age key
    const unlinked: Ref[] = [];
    for (const ref of refs) {
      const found = this.store.findRef(tenantId, ref);
      if (found) known.set(found.jobId, this.store.jobAge(tenantId, found.jobId) ?? "");
      else unlinked.push(ref);
    }
    const at = this.now().toISOString();
    let jobId: string;
    if (known.size === 0) {
      jobId = randomUUID();
      this.store.createJob(tenantId, jobId, at);
    } else {
      // The oldest job survives, so its id (and its boxes' ids) stay stable.
      const ordered = [...known.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      jobId = ordered[0]![0];
      for (const [other] of ordered.slice(1)) this.mergeJobs(tenantId, jobId, other, link);
    }
    const reason =
      link?.reason ??
      (refs.length > 1
        ? `seen together on ${input.source} ${input.eventType} ${input.sourceEventId}`
        : `first seen on ${input.source} ${input.eventType} ${input.sourceEventId}`);
    for (const ref of unlinked) {
      this.store.insertRef(tenantId, {
        ...ref,
        jobId,
        method: link?.method ?? "exact",
        reason,
        score: link?.score ?? 1,
        linkedAt: at,
      });
    }
    return jobId;
  }

  /**
   * Fold job `drop` into `keep`. When a link caused the merge, the identifiers
   * that come over are on this job because of that link, so they take its
   * method, reason and score: an inferred join stays visibly inferred.
   */
  private mergeJobs(tenantId: string, keep: string, drop: string, link?: LinkOptions): void {
    if (link) this.store.relabelRefs(tenantId, drop, link.method, link.reason, link.score);
    this.store.moveEvents(tenantId, drop, keep);
    this.store.moveRefs(tenantId, drop, keep);
    const kept = new Map(this.store.boxesOfJob(tenantId, keep).map((b) => [b.boxType, b]));
    for (const box of this.store.boxesOfJob(tenantId, drop)) {
      if (kept.has(box.boxType)) this.store.deleteBox(tenantId, box.id);
      else this.store.upsertBox({ ...box, jobId: keep });
    }
    this.store.deleteJob(tenantId, drop);
  }

  // ── measurement ──────────────────────────────────────────────────────────

  /** Re-measure every box of a job from its stored events. */
  private measureJob(tenantId: string, jobId: string): ProcessBox[] {
    const deployment = this.deployment(tenantId);
    const events = this.store.eventsOfJob(tenantId, jobId);
    const existing = new Map(this.store.boxesOfJob(tenantId, jobId).map((b) => [b.boxType, b]));
    const defs = new Map(deployment.boxes.map((d) => [d.boxType, d]));

    // Which boxes this job has: any box with a boundary or agent timing, gated
    // where the definition says so, plus every ancestor so the hierarchy holds.
    const wanted = new Set<string>();
    const gateOpen = (def: BoxDefinition) =>
      !def.gate || events.some((e) => e.matches.some((m) => m.boxType === def.boxType && m.role === "gate"));
    for (const def of deployment.boxes) {
      const touched =
        events.some((e) => e.matches.some((m) => m.boxType === def.boxType && m.role !== "gate")) ||
        events.some((e) => e.source === "agent" && e.attrs.boxType === def.boxType);
      if (touched && gateOpen(def)) wanted.add(def.boxType);
    }
    // Ancestors too, but a parent's gate still applies: timing an inner box
    // must not open, say, a quotation box for a job that is not a request.
    // The child then has no parent box until the gate is met.
    for (const type of [...wanted]) {
      for (let p = defs.get(type)?.parent; p !== undefined; p = defs.get(p)?.parent) {
        const def = defs.get(p);
        if (!def || !gateOpen(def)) break;
        wanted.add(p);
      }
    }

    const ids = new Map<string, string>();
    for (const type of wanted) ids.set(type, existing.get(type)?.id ?? randomUUID());
    // A box that no longer qualifies (definition removed or gate no longer met) goes.
    for (const [type, box] of existing) if (!wanted.has(type)) this.store.deleteBox(tenantId, box.id);

    const boxes: ProcessBox[] = [];
    for (const type of wanted) {
      const def = defs.get(type)!;
      const box = measureBox({
        id: ids.get(type)!,
        tenantId,
        jobId,
        def,
        parentId: def.parent !== undefined ? (ids.get(def.parent) ?? null) : null,
        events,
        deployment,
        now: this.now(),
      });
      this.store.upsertBox(box);
      boxes.push(box);
    }
    return boxes;
  }
}

export interface IngestOptions {
  link?: LinkOptions;
  refresh?: boolean;
}

export interface LinkOptions {
  method: "mapping" | "inferred";
  reason: string;
  score: number;
}

/**
 * One box from its job's events. Pure: the same events always give the same box.
 *
 * IN is the earliest IN event. OUT is the earliest OUT event at or after IN;
 * later ones are revisions or resends and are counted, not measured. OUT events
 * before IN belong to an earlier round and are ignored. Without an IN the box
 * stays open with an unknown elapsed time: an OUT alone measures nothing.
 */
export function measureBox(args: {
  id: string;
  tenantId: string;
  jobId: string;
  def: BoxDefinition;
  parentId: string | null;
  events: StoredEvent[];
  deployment: Deployment;
  now: Date;
}): ProcessBox {
  const { def, events } = args;
  const sorted = [...events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.receivedAt.localeCompare(b.receivedAt));
  const role = (e: StoredEvent, r: "in" | "out") => e.matches.some((m) => m.boxType === def.boxType && m.role === r);
  const inEvent = sorted.find((e) => role(e, "in"));
  const outs = sorted.filter((e) => role(e, "out") && (!inEvent || Date.parse(e.occurredAt) >= Date.parse(inEvent.occurredAt)));
  const outEvent = outs[0];
  const inB = inEvent ? boundary(inEvent) : null;
  const outB = outEvent ? boundary(outEvent) : null;
  const elapsedMs = inB && outB ? Date.parse(outB.at) - Date.parse(inB.at) : null;
  const anchor = inEvent ?? outEvent;
  return {
    id: args.id,
    tenantId: args.tenantId,
    jobId: args.jobId,
    boxType: def.boxType,
    parentId: args.parentId,
    in: inB,
    out: outB,
    elapsedMs,
    activeMs: activeTime(sorted, def.boxType),
    mode: anchor?.mode ?? modeAt(args.deployment, anchor?.occurredAt ?? args.now.toISOString()),
    confidence: inB && outB ? worseConfidence(inB.confidence, outB.confidence) : null,
    laterOutCount: Math.max(0, outs.length - 1),
    status: inB && outB ? "closed" : "open",
    updatedAt: args.now.toISOString(),
  };
}

function boundary(e: StoredEvent): Boundary {
  return { eventType: e.eventType, at: e.occurredAt, source: e.source, confidence: e.confidence, eventId: e.id };
}

/**
 * Sum of the agent's closed work intervals on this box type: START or RESUME
 * opens one, PAUSE or DONE closes it. An interval still open is not counted
 * (it has no end yet), and a stray PAUSE without an open interval is ignored.
 */
export function activeTime(sorted: StoredEvent[], boxType: string): number | null {
  let total = 0;
  let intervals = 0;
  let openedAt: number | null = null;
  for (const e of sorted) {
    if (e.source !== "agent" || e.attrs.boxType !== boxType) continue;
    const t = Date.parse(e.occurredAt);
    if (e.eventType === AGENT_START || e.eventType === AGENT_RESUME) {
      if (openedAt === null) openedAt = t;
    } else if (e.eventType === AGENT_PAUSE || e.eventType === AGENT_DONE) {
      if (openedAt !== null) {
        total += Math.max(0, t - openedAt);
        intervals += 1;
        openedAt = null;
      }
    }
  }
  return intervals ? total : null;
}

function dedupeRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const { system, id } of refs) {
    if (!system || !id) continue;
    const key = `${system}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ system, id });
  }
  return out;
}

function isoOrThrow(value: string, name: string): string {
  const t = Date.parse(value);
  if (typeof value !== "string" || Number.isNaN(t)) throw new Error(`${name} is not a valid timestamp`);
  return new Date(t).toISOString();
}
