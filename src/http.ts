/**
 * The HTTP surface (spec §10): one authenticated ingestion API for every
 * sensor, the CallDash webhook, read endpoints, and a small read-only console.
 *
 *   POST /hooks/calldash/:tenant   CallDash envelope, CallDash's HMAC signature
 *   POST /v1/events                any sensor, normalized              Bearer
 *   POST /v1/email                 email metadata                      Bearer
 *   POST /v1/agent                 Metrix Agent START/PAUSE/RESUME/DONE Bearer
 *   POST /v1/links                 explicit or inferred correlation    Bearer
 *   POST /v1/estimates             Discovery interview estimate        Bearer
 *   GET  /v1/boxes, /v1/boxes/:id, /v1/jobs?system=&id=, /v1/report     Bearer
 *   GET  /console, /console/boxes/:id                                  Basic
 *   GET  /health
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TenantConfig } from "./config.ts";
import { AGENT_DONE, AGENT_PAUSE, AGENT_RESUME, AGENT_START, type Metrix } from "./engine.ts";
import { isConfidence, isMode, type Confidence, type Ref, type SourceKind } from "./model.ts";
import { buildReport } from "./report.ts";
import { fromCallDash, parseEnvelope, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyCallDash } from "./sensors/calldash.ts";
import { fromEmail, type EmailMetadata } from "./sensors/email.ts";
import type { Store } from "./store.ts";
import { renderBoxPage, renderConsole } from "./views.ts";

const MAX_BODY = 256 * 1024;
/** /v1/events takes every sensor except Farai's own instruments, which have their own routes. */
const GENERIC_SOURCES: readonly SourceKind[] = ["email", "whatsapp", "system", "manual"];
/** A sensor that does not say how sure it is gets its kind's default. A manual entry must say. */
const DEFAULT_CONFIDENCE: Partial<Record<SourceKind, Confidence>> = {
  email: "B",
  whatsapp: "B",
  system: "B",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AppDeps {
  metrix: Metrix;
  store: Store;
  tenants: TenantConfig[];
}

export function createApp(deps: AppDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(JSON.stringify({ level: "error", msg: "request_failed", path: req.url, error: String(err) }));
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "internal error" : (err as Error).message });
      else res.end();
    });
  });
}

async function handle(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://metrix.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (path === "/health" && method === "GET") return sendJson(res, 200, { ok: true });

  const hook = /^\/hooks\/calldash\/([a-z0-9-]+)$/.exec(path);
  if (hook && method === "POST") return calldashHook(deps, hook[1]!, req, res);

  if (path === "/console" || path.startsWith("/console/")) return consoleRoute(deps, path, url, req, res);

  if (!path.startsWith("/v1/")) throw new HttpError(404, "not found");
  const tenant = bearerTenant(deps.tenants, req);
  const t = tenant.id;
  const { metrix, store } = deps;

  if (method === "POST") {
    const body = await readJson(req);
    switch (path) {
      case "/v1/events":
        return sendIngest(res, wrap400(() => metrix.ingest(t, normalizedEvent(body), transientOf(body))));
      case "/v1/email": {
        const d = tenant.deployment;
        const { input, transient } = wrap400(() =>
          fromEmail(body as unknown as EmailMetadata, {
            // A live feed is B; a reconstruction may say C. Never A: that is Farai's own instruments.
            confidence: body.confidence === "C" ? "C" : "B",
            threading: d.emailThreading,
          }),
        );
        return sendIngest(res, wrap400(() => metrix.ingest(t, input, transient)));
      }
      case "/v1/agent":
        return sendIngest(res, wrap400(() => metrix.ingest(t, agentEvent(tenant, body))));
      case "/v1/links": {
        const refs = refsOf(body.refs);
        const method_ = body.method === "inferred" ? "inferred" : "mapping";
        const result = wrap400(() =>
          metrix.link(t, refs, {
            method: method_,
            reason: str(body.reason, "reason"),
            score: typeof body.score === "number" ? body.score : 1,
            ...(typeof body.linkId === "string" ? { sourceEventId: body.linkId } : {}),
          }),
        );
        return sendIngest(res, result);
      }
      case "/v1/estimates": {
        const boxType = str(body.boxType, "boxType");
        knownBoxType(tenant, boxType);
        const estimate = wrap400(() =>
          metrix.addEstimate(t, {
            boxType,
            label: str(body.label, "label"),
            minutes: Number(body.minutes),
            role: str(body.role, "role"),
            ...(typeof body.note === "string" ? { note: body.note } : {}),
          }),
        );
        return sendJson(res, 201, estimate);
      }
    }
    throw new HttpError(404, "not found");
  }

  if (method === "GET") {
    if (path === "/v1/boxes") {
      return sendJson(res, 200, {
        boxes: store.listBoxes(t, {
          ...optional(url, "boxType"),
          ...optional(url, "from"),
          ...optional(url, "to"),
          limit: Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 1000),
        }),
      });
    }
    const boxMatch = /^\/v1\/boxes\/([0-9a-f-]{36})$/.exec(path);
    if (boxMatch) return sendJson(res, 200, boxDetail(deps, t, boxMatch[1]!));
    if (path === "/v1/jobs") {
      const job = metrix.jobOfRef(t, { system: url.searchParams.get("system") ?? "", id: url.searchParams.get("id") ?? "" });
      if (!job) throw new HttpError(404, "no job has that ref");
      return sendJson(res, 200, job);
    }
    if (path === "/v1/report") return sendJson(res, 200, report(deps, tenant, url));
  }
  throw new HttpError(404, "not found");
}

// ── CallDash ───────────────────────────────────────────────────────────────

async function calldashHook(deps: AppDeps, tenantId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tenant = deps.tenants.find((t) => t.id === tenantId);
  const raw = await readBody(req);
  // Same answer for an unknown tenant and a bad signature: no tenant enumeration.
  if (!tenant?.calldash || !verifyCallDash(tenant.calldash.secret, raw, header(req, SIGNATURE_HEADER), header(req, TIMESTAMP_HEADER))) {
    throw new HttpError(401, "bad signature");
  }
  const envelope = wrap400(() => parseEnvelope(raw));
  if (tenant.calldash.tenantId !== undefined && envelope.tenantId !== tenant.calldash.tenantId) {
    throw new HttpError(403, "envelope is for another CallDash tenant");
  }
  sendIngest(res, wrap400(() => deps.metrix.ingest(tenant.id, fromCallDash(envelope))));
}

// ── console ────────────────────────────────────────────────────────────────

function consoleRoute(deps: AppDeps, path: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const tenant = basicTenant(deps.tenants, req);
  if (!tenant) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="Farai Metrix", charset="UTF-8"', "content-type": "text/plain" });
    res.end("authentication required");
    return;
  }
  if (req.method !== "GET") throw new HttpError(405, "read-only");
  if (path === "/console") {
    const r = report(deps, tenant, url);
    const boxes = deps.store.listBoxes(tenant.id, { ...optional(url, "boxType"), limit: 100 });
    return sendHtml(res, renderConsole({ tenantId: tenant.id, deployment: tenant.deployment, report: r, boxes }));
  }
  const m = /^\/console\/boxes\/([0-9a-f-]{36})$/.exec(path);
  if (m) return sendHtml(res, renderBoxPage({ tenantId: tenant.id, deployment: tenant.deployment, ...boxDetail(deps, tenant.id, m[1]!) }));
  throw new HttpError(404, "not found");
}

// ── shared views ───────────────────────────────────────────────────────────

function boxDetail(deps: AppDeps, tenantId: string, boxId: string) {
  const box = deps.store.getBox(tenantId, boxId);
  if (!box) throw new HttpError(404, "no such box");
  const job = deps.metrix.job(tenantId, box.jobId)!;
  const children = job.boxes.filter((b) => b.parentId === box.id);
  const parent = box.parentId ? (job.boxes.find((b) => b.id === box.parentId) ?? null) : null;
  // The events that touched this box or its children, plus links and agent timing.
  const relevantTypes = new Set([box.boxType, ...children.map((c) => c.boxType)]);
  const events = job.events.filter(
    (e) =>
      e.matches.some((mm) => relevantTypes.has(mm.boxType)) ||
      (e.source === "agent" && relevantTypes.has(String(e.attrs.boxType))) ||
      e.eventType === "CORRELATION_LINKED",
  );
  return { box, parent, children, refs: job.refs, events };
}

function report(deps: AppDeps, tenant: TenantConfig, url: URL) {
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (v !== undefined && Number.isNaN(Date.parse(v))) throw new HttpError(400, `${name} is not a date`);
  }
  return buildReport({
    boxes: deps.store.listBoxes(tenant.id, {
      ...(from ? { from: new Date(from).toISOString() } : {}),
      ...(to ? { to: new Date(to).toISOString() } : {}),
      limit: 100_000,
    }),
    definitions: tenant.deployment.boxes,
    estimates: deps.store.listEstimates(tenant.id),
    uncorrelatedEvents: deps.store.uncorrelatedCount(tenant.id),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
}

// ── request parsing ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function normalizedEvent(body: Json) {
  const source = body.source as SourceKind;
  if (!GENERIC_SOURCES.includes(source)) throw new HttpError(400, `source must be one of ${GENERIC_SOURCES.join(", ")}`);
  const confidence = body.confidence ?? DEFAULT_CONFIDENCE[source];
  // A (instrumented) is reserved for Farai's own instruments, which have their
  // own authenticated routes (the CallDash hook, /v1/agent).
  if (confidence === "A") throw new HttpError(400, "confidence A is only for Farai instruments (CallDash hook, agent)");
  if (!isConfidence(confidence)) throw new HttpError(400, "confidence must be B, C or D");
  if (body.mode !== undefined && !isMode(body.mode)) throw new HttpError(400, "mode must be BASELINE, ASSISTED or AUTOMATED");
  return {
    source,
    sourceEventId: str(body.sourceEventId, "sourceEventId"),
    eventType: str(body.eventType, "eventType"),
    occurredAt: str(body.occurredAt, "occurredAt"),
    confidence,
    ...(isMode(body.mode) ? { mode: body.mode } : {}),
    refs: refsOf(body.refs ?? []),
    attrs: attrsOf(body.attrs),
  };
}

function transientOf(body: Json) {
  return {
    ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
    ...(Array.isArray(body.attachments) ? { attachments: body.attachments.filter((a): a is string => typeof a === "string") } : {}),
  };
}

const AGENT_ACTIONS: Record<string, string> = { start: AGENT_START, pause: AGENT_PAUSE, resume: AGENT_RESUME, done: AGENT_DONE };

function agentEvent(tenant: TenantConfig, body: Json) {
  const eventType = AGENT_ACTIONS[String(body.action)];
  if (!eventType) throw new HttpError(400, "action must be start, pause, resume or done");
  const boxType = str(body.boxType, "boxType");
  knownBoxType(tenant, boxType);
  const ref = refsOf([body.ref])[0]!;
  return {
    source: "agent" as const,
    sourceEventId: str(body.eventId, "eventId"),
    eventType,
    occurredAt: typeof body.at === "string" ? body.at : new Date().toISOString(),
    confidence: "A" as const,
    refs: [ref],
    // Only the box. No device or user id: Metrix measures processes, not people.
    attrs: { boxType },
  };
}

function refsOf(value: unknown): Ref[] {
  if (!Array.isArray(value)) throw new HttpError(400, "refs must be an array of {system, id}");
  return value.map((r, i) => {
    const ref = r as Partial<Ref>;
    if (typeof ref?.system !== "string" || !ref.system || typeof ref.id !== "string" || !ref.id) {
      throw new HttpError(400, `refs[${i}] needs a system and an id`);
    }
    return { system: ref.system.slice(0, 64), id: ref.id.slice(0, 256) };
  });
}

function attrsOf(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "attrs must be an object");
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(value as Json);
  if (entries.length > 20) throw new HttpError(400, "attrs is metadata: at most 20 keys");
  for (const [k, v] of entries) {
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else throw new HttpError(400, `attrs.${k} must be a string, number or boolean`);
  }
  return out;
}

function knownBoxType(tenant: TenantConfig, boxType: string): void {
  if (!tenant.deployment.boxes.some((b) => b.boxType === boxType)) throw new HttpError(400, `unknown boxType "${boxType}"`);
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value.trim();
}

function optional(url: URL, name: string): Record<string, string> {
  const v = url.searchParams.get(name);
  return v ? { [name]: v } : {};
}

function wrap400<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, (err as Error).message);
  }
}

// ── auth ───────────────────────────────────────────────────────────────────

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function bearerTenant(tenants: TenantConfig[], req: IncomingMessage): TenantConfig {
  const m = /^Bearer\s+(.+)$/i.exec(header(req, "authorization") ?? "");
  const key = m?.[1]?.trim();
  if (key) {
    for (const t of tenants) if (t.apiKeys.some((k) => sameSecret(k, key))) return t;
  }
  throw new HttpError(401, "missing or unknown API key");
}

function basicTenant(tenants: TenantConfig[], req: IncomingMessage): TenantConfig | undefined {
  const m = /^Basic\s+(.+)$/i.exec(header(req, "authorization") ?? "");
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  const t = tenants.find((x) => x.id === user);
  return t?.consolePassword && sameSecret(t.consolePassword, pass) ? t : undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// ── io ─────────────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const raw = await readBody(req);
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Json;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function sendIngest(res: ServerResponse, r: ReturnType<Metrix["ingest"]>): void {
  sendJson(res, r.duplicate ? 200 : 201, {
    eventId: r.event.id,
    duplicate: r.duplicate,
    jobId: r.jobId,
    boxes: r.boxes,
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(html);
}
