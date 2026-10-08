/**
 * CallDash: the telephone sensor (spec §4.2).
 *
 * CallDash forwards a fixed vocabulary of envelopes (CallDash
 * packages/server/src/metrix.ts) through its webhook outbox, signed as
 *   x-calldash-signature: v1=HMAC-SHA256(secret, "<unix seconds>.<raw body>")
 *   x-calldash-timestamp: <unix seconds>
 *   x-calldash-event-id:  <event id>
 * Delivery is at-least-once and unordered; the engine is idempotent on the
 * event id and recomputes from stored events, so both are fine.
 *
 * Only identifiers and a few metadata fields are kept. CallDash adds the
 * caller's and callee's numbers to most payloads; Metrix drops them. A phone
 * number identifies a customer, not a job.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ref, SourceEventInput } from "../model.ts";

export const SIGNATURE_HEADER = "x-calldash-signature";
export const TIMESTAMP_HEADER = "x-calldash-timestamp";
export const TOLERANCE_SECONDS = 300;

/** The ref system for a CallDash call. Its correlation id (fc_…) joins every event of one call. */
export const CALL_REF_SYSTEM = "calldash-call";

export interface MetrixEnvelope {
  eventType: string;
  eventId: string;
  occurredAt: string;
  source: "calldash";
  tenantId: string;
  correlationId: string | null;
  externalRefs: Array<{ system: string; id: string; boundAt?: string }>;
  callId: string;
  payload: Record<string, unknown>;
}

export function signCallDash(secret: string, body: string, timestampSeconds: number): string {
  return `v1=${createHmac("sha256", secret).update(`${timestampSeconds}.${body}`, "utf8").digest("hex")}`;
}

export function verifyCallDash(
  secret: string,
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  if (!secret || !signature || !timestamp || !/^\d{1,15}$/.test(timestamp.trim())) return false;
  const ts = Number(timestamp.trim());
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signCallDash(secret, body, ts));
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Parse and check an envelope. Throws with a message fit for a 400. */
export function parseEnvelope(body: string): MetrixEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error("body is not JSON");
  }
  const e = raw as Partial<MetrixEnvelope>;
  for (const key of ["eventType", "eventId", "occurredAt", "tenantId", "callId"] as const) {
    if (typeof e[key] !== "string" || !e[key]) throw new Error(`${key} is required`);
  }
  if (e.source !== "calldash") throw new Error('source must be "calldash"');
  if (!Array.isArray(e.externalRefs)) throw new Error("externalRefs must be an array");
  if (typeof e.payload !== "object" || e.payload === null) throw new Error("payload must be an object");
  return e as MetrixEnvelope;
}

export function fromCallDash(env: MetrixEnvelope): SourceEventInput {
  const refs: Ref[] = [{ system: CALL_REF_SYSTEM, id: env.correlationId ?? env.callId }];
  for (const r of env.externalRefs) {
    if (typeof r?.system === "string" && typeof r?.id === "string") refs.push({ system: r.system, id: r.id });
  }
  return {
    source: "calldash",
    sourceEventId: env.eventId,
    eventType: env.eventType,
    occurredAt: env.occurredAt,
    // Farai's own instrument: the timestamp is CallDash's, not reconstructed.
    confidence: "A",
    refs,
    attrs: attrsOf(env),
  };
}

/** The metadata a deployment may match on. Never numbers, transcripts or field values. */
function attrsOf(env: MetrixEnvelope): SourceEventInput["attrs"] {
  const p = env.payload;
  const attrs: SourceEventInput["attrs"] = {};
  const put = (key: string, value: unknown) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") attrs[key] = value;
  };
  put("direction", p.direction);
  switch (env.eventType) {
    case "REQUEST_COMPLETE":
      put("formSpecId", p.formSpecId);
      put("completeness", p.completeness);
      if (Array.isArray(p.routes) && typeof p.routes[0] === "string") attrs.route = p.routes[0];
      break;
    case "REQUEST_CREATED":
      put("formSpecId", p.formSpecId);
      break;
    case "OBSERVATION_READY":
      put("intent", p.intent);
      put("language", p.language);
      put("probableRepeat", p.probableRepeat);
      break;
    case "CALL_COMPLETED":
      put("status", p.status);
      put("endStatus", p.endStatus);
      put("durationSec", p.durationSec);
      break;
    case "CALL_OUTCOME":
      put("outcome", p.outcome);
      break;
  }
  return attrs;
}
