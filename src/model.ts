/**
 * The Metrix model: a process is a black box with an IN boundary and an OUT
 * boundary. Elapsed time is OUT minus IN. A box may contain child boxes built
 * from exactly the same model; nothing else is needed to describe a handoff,
 * because a handoff is just the boundary between two boxes.
 *
 * Source events are kept for audit, but they serve the boxes: the box is the
 * product's centre, not a universal event ontology.
 */

/**
 * How a timestamp was obtained (spec §8). Ordered: A is best, D is weakest.
 * A box is only as good as its weaker boundary.
 */
export type Confidence = "A" | "B" | "C" | "D";
export const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = {
  A: "Instrumented",
  B: "System",
  C: "Historical",
  D: "Interview",
};

/** The same box definition is measured in every mode, so before/after comparisons hold. */
export type Mode = "BASELINE" | "ASSISTED" | "AUTOMATED";
export const MODES: readonly Mode[] = ["BASELINE", "ASSISTED", "AUTOMATED"];

/** Where a source event came from. Only metadata travels; never message bodies. */
export type SourceKind = "calldash" | "email" | "whatsapp" | "system" | "agent" | "manual";

/** A customer or Farai identifier, e.g. { system: "brusato-quote", id: "2026/418" }. */
export interface Ref {
  system: string;
  id: string;
}

/** One observed fact from a sensor, normalized. */
export interface SourceEvent {
  /** Farai id. */
  id: string;
  tenantId: string;
  source: SourceKind;
  /** The sensor's own id for this event; (tenant, source, sourceEventId) is unique. */
  sourceEventId: string;
  /** e.g. REQUEST_COMPLETE, EMAIL_RECEIVED, EMAIL_SENT. */
  eventType: string;
  /** When it happened, ISO-8601 UTC. */
  occurredAt: string;
  /** When Metrix received it. */
  receivedAt: string;
  confidence: Confidence;
  /** Set when the sensor knows the mode (e.g. an assisted intake); otherwise the tenant schedule decides. */
  mode?: Mode;
  refs: Ref[];
  /** Small, non-content metadata (direction, mailbox, attachment count, ...). */
  attrs: Record<string, string | number | boolean>;
}

/** A sensor's event before Metrix assigns an id and receipt time. */
export type SourceEventInput = Omit<SourceEvent, "id" | "tenantId" | "receivedAt">;

/** A measured boundary: the event that decided it, and how sure we are. */
export interface Boundary {
  eventType: string;
  at: string;
  source: SourceKind;
  confidence: Confidence;
  eventId: string;
}

/** The essential object (spec §3). */
export interface ProcessBox {
  /** Farai internal id. */
  id: string;
  tenantId: string;
  /** The job this box measures; every identifier for the job points at it. */
  jobId: string;
  boxType: string;
  parentId: string | null;
  in: Boundary | null;
  out: Boundary | null;
  /** OUT minus IN in milliseconds; null while either boundary is missing. */
  elapsedMs: number | null;
  /** Sum of measured human work intervals (agent); null when none were measured. */
  activeMs: number | null;
  mode: Mode;
  /** The weaker of the two boundaries' confidences; null until both exist. */
  confidence: Confidence | null;
  /** OUT-type events after the OUT boundary (revisions, resends). Counted, not measured. */
  laterOutCount: number;
  /** Closed once both boundaries exist. An OUT with no IN stays open: its IN is unknown, not instant. */
  status: "open" | "closed";
  updatedAt: string;
}

/** How an identifier came to belong to a job (spec §6: keep the reason). */
export interface RefLink extends Ref {
  jobId: string;
  method: "exact" | "mapping" | "inferred";
  reason: string;
  /** 0..1; exact and mapping links are 1. */
  score: number;
  linkedAt: string;
}

/** One human work interval on a box (the Metrix Agent's START/PAUSE/DONE). */
export interface WorkInterval {
  id: string;
  boxId: string;
  startedAt: string;
  endedAt: string | null;
  source: SourceKind;
}

/** A Discovery estimate: staff say how long a box usually takes. Always confidence D. */
export interface Estimate {
  id: string;
  tenantId: string;
  boxType: string;
  /** e.g. "straightforward", "difficult". */
  label: string;
  minutes: number;
  /** Who said it, by role ("estimator", "office manager"), never a name. */
  role: string;
  note?: string;
  recordedAt: string;
}

export function worseConfidence(a: Confidence, b: Confidence): Confidence {
  return a > b ? a : b;
}

export function isConfidence(value: unknown): value is Confidence {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

export function isMode(value: unknown): value is Mode {
  return value === "BASELINE" || value === "ASSISTED" || value === "AUTOMATED";
}
