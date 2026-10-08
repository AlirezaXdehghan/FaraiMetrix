/**
 * A deployment says, for one customer, which boxes exist and which sensor
 * events are their IN and OUT boundaries. It is plain JSON (deployments/*.json)
 * so a new box or a new sensor rule is a config change, not code.
 *
 * Matching happens once, at ingest, while the event's metadata (an email
 * subject, say) is still in hand. Only the result is stored, so content a rule
 * needed never has to be kept.
 */

import { isMode, type Mode, type Ref, type SourceEventInput, type SourceKind } from "./model.ts";

/** Fields a matcher or extractor may read. `subject` and `attachments` exist only during ingest. */
export interface MatchContext {
  event: SourceEventInput;
  /** Transient email metadata; never stored. */
  subject?: string;
  attachments?: string[];
}

export interface Matcher {
  source?: SourceKind;
  eventType?: string;
  /** Exact match on a stored attribute, e.g. { "direction": "outbound", "mailbox": "preventivi@..." }. */
  attrs?: Record<string, string | number | boolean>;
  /** Case-insensitive regex on the email subject. */
  subject?: string;
  /** Case-insensitive regex; matches if any attachment filename matches. */
  attachment?: string;
}

export interface BoxDefinition {
  boxType: string;
  label: string;
  /** The box this one sits inside. Its boundaries are measured the same way. */
  parent?: string;
  in: Matcher[];
  out: Matcher[];
  /**
   * When present, the box is measured for a job only once one of the job's
   * events matches. Keeps, say, status-inquiry calls from opening quotation
   * boxes when "call ended" is an IN candidate.
   */
  gate?: Matcher[];
}

/** Pull a customer identifier out of transient metadata (spec §6: exact ids first). */
export interface RefExtractor {
  system: string;
  source?: SourceKind;
  field: "subject" | "attachment";
  /** Regex with a named group `id`. */
  pattern: string;
  /**
   * Rewrite any run of separators (space, _, -, /, .) inside the id to this, so
   * "418_2026" in a filename and "418/2026" in a subject are one quote.
   */
  separator?: string;
}

export interface ModeWindow {
  /** ISO date or date-time; the mode applies to boxes whose IN is at or after it. */
  from: string;
  mode: Mode;
}

export interface Deployment {
  name: string;
  boxes: BoxDefinition[];
  refExtractors: RefExtractor[];
  /** Ordered by `from`. Before the first window, BASELINE. */
  modeSchedule: ModeWindow[];
  /** The business's own mailboxes; decides an imported email's direction. */
  mailboxes: string[];
  /** Join emails of one thread into one job (default true). */
  emailThreading: boolean;
}

export interface BoundaryMatch {
  boxType: string;
  role: "in" | "out" | "gate";
}

export function matchBoundaries(deployment: Deployment, ctx: MatchContext): BoundaryMatch[] {
  const matches: BoundaryMatch[] = [];
  for (const box of deployment.boxes) {
    if (box.in.some((m) => matches_(m, ctx))) matches.push({ boxType: box.boxType, role: "in" });
    if (box.out.some((m) => matches_(m, ctx))) matches.push({ boxType: box.boxType, role: "out" });
    if (box.gate?.some((m) => matches_(m, ctx))) matches.push({ boxType: box.boxType, role: "gate" });
  }
  return matches;
}

function matches_(m: Matcher, ctx: MatchContext): boolean {
  const e = ctx.event;
  if (m.source !== undefined && m.source !== e.source) return false;
  if (m.eventType !== undefined && m.eventType !== e.eventType) return false;
  if (m.attrs) {
    for (const [key, want] of Object.entries(m.attrs)) {
      const have = e.attrs[key];
      if (typeof want === "string" && typeof have === "string") {
        if (want.toLowerCase() !== have.toLowerCase()) return false;
      } else if (have !== want) return false;
    }
  }
  if (m.subject !== undefined && !(ctx.subject !== undefined && regex(m.subject).test(ctx.subject))) return false;
  if (m.attachment !== undefined) {
    const re = regex(m.attachment);
    if (!(ctx.attachments ?? []).some((name) => re.test(name))) return false;
  }
  return true;
}

/**
 * Could this stored event have matched a rule that reads transient metadata
 * (subject, attachment names)? Checks everything except that metadata, which
 * is not stored. Used by rematch to decide which old matches it cannot judge.
 */
export function couldMatchTransient(m: Matcher, event: MatchContext["event"]): boolean {
  if (m.subject === undefined && m.attachment === undefined) return false;
  return matches_({ ...m, subject: undefined, attachment: undefined } as Matcher, { event });
}

export function extractRefs(deployment: Deployment, ctx: MatchContext): Ref[] {
  const refs: Ref[] = [];
  for (const x of deployment.refExtractors) {
    if (x.source !== undefined && x.source !== ctx.event.source) continue;
    const texts = x.field === "subject" ? (ctx.subject !== undefined ? [ctx.subject] : []) : (ctx.attachments ?? []);
    const re = regex(x.pattern);
    for (const text of texts) {
      const id = re.exec(text)?.groups?.id?.trim();
      if (id) refs.push({ system: x.system, id });
    }
  }
  return refs;
}

/**
 * The canonical form of an id, wherever it came from (an extractor, CallDash,
 * an API call), so "418_2026", "418/2026" and "418 / 2026" are one quote when
 * the deployment sets a separator for that system.
 */
export function canonicalRef(deployment: Deployment, ref: Ref): Ref {
  const system = ref.system.trim();
  const separator = deployment.refExtractors.find((x) => x.system === system && x.separator !== undefined)?.separator;
  const id = separator !== undefined ? ref.id.trim().replace(/[\s_\-/.]+/g, separator) : ref.id;
  return { system, id: normalizeRefId(id) };
}

/** Ids compare case- and space-insensitively: "PRV 2026/418" and "prv2026/418" are one quote. */
export function normalizeRefId(id: string): string {
  return id.replace(/\s+/g, "").toUpperCase();
}

export function modeAt(deployment: Deployment, at: string): Mode {
  const t = Date.parse(at);
  let mode: Mode = "BASELINE";
  for (const w of deployment.modeSchedule) {
    if (Date.parse(w.from) <= t) mode = w.mode;
  }
  return mode;
}

const regexCache = new Map<string, RegExp>();
function regex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "i");
    regexCache.set(pattern, re);
  }
  return re;
}

/** Validate a parsed deployment file. Throws with every problem listed. */
export function parseDeployment(raw: unknown): Deployment {
  const problems: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : (problems.push("name is required"), "");
  const boxes = Array.isArray(obj.boxes) ? (obj.boxes as BoxDefinition[]) : (problems.push("boxes must be an array"), []);
  const types = new Set<string>();
  for (const [i, b] of boxes.entries()) {
    if (typeof b.boxType !== "string" || !b.boxType) problems.push(`boxes[${i}].boxType is required`);
    else if (types.has(b.boxType)) problems.push(`boxes[${i}].boxType "${b.boxType}" is defined twice`);
    else types.add(b.boxType);
    if (!Array.isArray(b.in) || !Array.isArray(b.out)) problems.push(`boxes[${i}] needs in and out matcher arrays`);
    if (b.gate !== undefined && !Array.isArray(b.gate)) problems.push(`boxes[${i}].gate must be an array`);
    for (const m of [...(b.in ?? []), ...(b.out ?? []), ...(b.gate ?? [])]) {
      for (const p of [m.subject, m.attachment]) if (p !== undefined) checkRegex(p, `boxes[${i}]`, problems);
    }
  }
  for (const [i, b] of boxes.entries()) {
    if (b.parent !== undefined && !types.has(b.parent)) problems.push(`boxes[${i}].parent "${b.parent}" is not a defined box`);
  }
  // A parent chain must end: a box cannot contain itself.
  for (const b of boxes) {
    const seen = new Set<string>();
    let cur: string | undefined = b.boxType;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        problems.push(`box "${b.boxType}" has a parent cycle`);
        break;
      }
      seen.add(cur);
      cur = boxes.find((x) => x.boxType === cur)?.parent;
    }
  }
  const refExtractors = Array.isArray(obj.refExtractors) ? (obj.refExtractors as RefExtractor[]) : [];
  for (const [i, x] of refExtractors.entries()) {
    checkRegex(x.pattern, `refExtractors[${i}]`, problems);
    if (typeof x.pattern === "string" && !x.pattern.includes("(?<id>")) problems.push(`refExtractors[${i}].pattern needs a named group (?<id>...)`);
  }
  const modeSchedule = Array.isArray(obj.modeSchedule) ? (obj.modeSchedule as ModeWindow[]) : [];
  for (const [i, w] of modeSchedule.entries()) {
    if (!isMode(w.mode)) problems.push(`modeSchedule[${i}].mode must be BASELINE, ASSISTED or AUTOMATED`);
    if (Number.isNaN(Date.parse(w.from))) problems.push(`modeSchedule[${i}].from is not a date`);
  }
  const mailboxes = Array.isArray(obj.mailboxes) ? (obj.mailboxes as unknown[]) : [];
  for (const [i, m] of mailboxes.entries()) {
    if (typeof m !== "string" || !m.includes("@")) problems.push(`mailboxes[${i}] is not an email address`);
  }
  if (obj.emailThreading !== undefined && typeof obj.emailThreading !== "boolean") problems.push("emailThreading must be a boolean");
  if (problems.length) throw new Error(`invalid deployment:\n  ${problems.join("\n  ")}`);
  modeSchedule.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  return {
    name,
    boxes,
    refExtractors,
    modeSchedule,
    mailboxes: (mailboxes as string[]).map((m) => m.trim().toLowerCase()),
    emailThreading: obj.emailThreading !== false,
  };
}

function checkRegex(pattern: unknown, where: string, problems: string[]): void {
  if (typeof pattern !== "string") {
    problems.push(`${where}: pattern must be a string`);
    return;
  }
  try {
    new RegExp(pattern, "i");
  } catch (err) {
    problems.push(`${where}: bad regex ${JSON.stringify(pattern)}: ${(err as Error).message}`);
  }
}
