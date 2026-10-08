import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeployment } from "../src/deployment.ts";
import { fromCallDash } from "../src/sensors/calldash.ts";
import { fromEmail } from "../src/sensors/email.ts";
import { BRUSATO, envelope, event, HOUR, MAILBOX, setup } from "./helpers.ts";

const T = "brusato";

function quoteEmail(messageId: string, date: string, extra: { subject?: string; attachments?: string[]; inReplyTo?: string; references?: string[] } = {}) {
  return fromEmail(
    { messageId, direction: "outbound", mailbox: MAILBOX, date, attachments: ["Preventivo_418_2026.pdf"], ...extra },
    { confidence: "B", threading: true },
  );
}

function quotation(boxes: Array<{ boxType: string }>) {
  return boxes.find((b) => b.boxType === "quotation") as import("../src/model.ts").ProcessBox | undefined;
}

test("phone request → quote id bound in CallDash → quote email: one closed box, elapsed = OUT − IN", () => {
  const { metrix } = setup();
  metrix.ingest(T, fromCallDash(envelope("REQUEST_COMPLETE", "2026-10-09T09:00:00Z")));
  metrix.ingest(
    T,
    fromCallDash(
      envelope("CORRELATION_BOUND", "2026-10-09T09:05:00Z", { externalRefs: [{ system: "brusato-quote", id: "418/2026" }] }),
    ),
  );
  const q = quoteEmail("<q1@brusato.example>", "2026-10-09T11:30:00Z");
  const r = metrix.ingest(T, q.input, q.transient);
  const box = quotation(r.boxes)!;
  assert.equal(box.status, "closed");
  assert.equal(box.in?.eventType, "REQUEST_COMPLETE");
  assert.equal(box.out?.eventType, "EMAIL_SENT");
  assert.equal(box.elapsedMs, 2.5 * HOUR);
  assert.equal(box.confidence, "B", "the weaker of A (CallDash) and B (mail server)");
  assert.equal(box.mode, "BASELINE");
  // The subject was used for matching only and is stored nowhere.
  assert.ok(!JSON.stringify(r.event).includes("Preventivo"));
});

test("delivery order does not matter: the quote email first, then the call", () => {
  const { metrix } = setup();
  const q = quoteEmail("<q1@brusato.example>", "2026-10-09T11:30:00Z");
  const first = metrix.ingest(T, q.input, q.transient);
  assert.equal(quotation(first.boxes), undefined, "an OUT alone opens nothing until the gate is met");
  metrix.ingest(T, fromCallDash(envelope("CORRELATION_BOUND", "2026-10-09T09:05:00Z", { externalRefs: [{ system: "brusato-quote", id: "418-2026" }] })));
  const r = metrix.ingest(T, fromCallDash(envelope("REQUEST_COMPLETE", "2026-10-09T09:00:00Z")));
  const box = quotation(r.boxes)!;
  assert.equal(box.elapsedMs, 2.5 * HOUR);
  assert.equal(box.jobId, first.jobId, "the older job survives a merge");
});

test("a duplicate delivery is acknowledged and changes nothing", () => {
  const { metrix, store } = setup();
  const e = fromCallDash(envelope("REQUEST_COMPLETE", "2026-10-09T09:00:00Z"));
  const a = metrix.ingest(T, e);
  const b = metrix.ingest(T, e);
  assert.equal(b.duplicate, true);
  assert.equal(b.event.id, a.event.id);
  assert.equal(store.eventsOfJob(T, a.jobId!).length, 1);
});

test("email-only quotation: request in, quote replied in the same thread", () => {
  const { metrix } = setup();
  const req = fromEmail(
    { messageId: "<r1@cliente.example>", direction: "inbound", mailbox: MAILBOX, date: "2026-10-09T07:00:00Z", subject: "Richiesta trasloco" },
    { confidence: "B", threading: true },
  );
  metrix.ingest(T, req.input, req.transient);
  // A clarification reply in the thread is not a quotation: no PDF named like one.
  const clar = fromEmail(
    { messageId: "<c1@brusato.example>", direction: "outbound", mailbox: MAILBOX, date: "2026-10-09T08:00:00Z", subject: "Re: Richiesta trasloco", inReplyTo: "<r1@cliente.example>" },
    { confidence: "B", threading: true },
  );
  const afterClar = metrix.ingest(T, clar.input, clar.transient);
  assert.equal(quotation(afterClar.boxes)?.status, "open");
  const q = quoteEmail("<q1@brusato.example>", "2026-10-09T10:00:00Z", { references: ["<r1@cliente.example>", "<c1@brusato.example>"] });
  const box = quotation(metrix.ingest(T, q.input, q.transient).boxes)!;
  assert.equal(box.in?.eventType, "EMAIL_RECEIVED");
  assert.equal(box.elapsedMs, 3 * HOUR);
});

test("a revised quote is counted, not measured; an OUT before IN belongs to an earlier round", () => {
  const { metrix } = setup();
  const old = quoteEmail("<q0@brusato.example>", "2026-10-08T10:00:00Z");
  metrix.ingest(T, old.input, old.transient);
  metrix.ingest(T, event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z", refs: [{ system: "brusato-quote", id: "418/2026" }] }));
  const q1 = quoteEmail("<q1@brusato.example>", "2026-10-09T10:00:00Z");
  metrix.ingest(T, q1.input, q1.transient);
  const q2 = quoteEmail("<q2@brusato.example>", "2026-10-10T10:00:00Z");
  const box = quotation(metrix.ingest(T, q2.input, q2.transient).boxes)!;
  assert.equal(box.out?.at, "2026-10-09T10:00:00.000Z");
  assert.equal(box.elapsedMs, HOUR);
  assert.equal(box.laterOutCount, 1);
});

test("observed baseline: the gate keeps non-request calls out; a new request's IN is the call's end", () => {
  const { metrix } = setup();
  const status = { correlationId: "fc_status", callId: "status" };
  const s1 = metrix.ingest(T, fromCallDash(envelope("CALL_COMPLETED", "2026-10-09T09:00:00Z", { ...status, payload: { status: "done" } })));
  const s2 = metrix.ingest(T, fromCallDash(envelope("OBSERVATION_READY", "2026-10-09T09:02:00Z", { ...status, payload: { intent: "status_inquiry" } })));
  assert.deepEqual([...s1.boxes, ...s2.boxes], []);

  const req = { correlationId: "fc_req", callId: "req" };
  metrix.ingest(T, fromCallDash(envelope("CALL_COMPLETED", "2026-10-09T10:00:00Z", { ...req, payload: { status: "done", from: "+390410000000" } })));
  const r = metrix.ingest(T, fromCallDash(envelope("OBSERVATION_READY", "2026-10-09T10:02:00Z", { ...req, payload: { intent: "new_request" } })));
  const box = quotation(r.boxes)!;
  assert.equal(box.in?.eventType, "CALL_COMPLETED");
  assert.equal(box.in?.at, "2026-10-09T10:00:00.000Z");
  assert.equal(box.status, "open");
  assert.ok(!JSON.stringify(r).includes("+39041"), "phone numbers are dropped");
});

test("explicit mapping joins two jobs and keeps the reason; inferred links need a score", () => {
  const { metrix } = setup();
  const call = metrix.ingest(T, fromCallDash(envelope("REQUEST_COMPLETE", "2026-10-09T09:00:00Z", { correlationId: "fc_a" })));
  const q = quoteEmail("<q9@brusato.example>", "2026-10-09T12:00:00Z", { attachments: ["Preventivo_77_2026.pdf"] });
  const mail = metrix.ingest(T, q.input, q.transient);
  assert.notEqual(call.jobId, mail.jobId);

  const linked = metrix.link(T, [{ system: "calldash-call", id: "fc_a" }, { system: "brusato-quote", id: "77/2026" }], {
    method: "mapping",
    reason: "estimator confirmed in console",
    score: 1,
  });
  assert.equal(linked.jobId, call.jobId);
  const job = metrix.job(T, call.jobId!)!;
  assert.equal(quotation(job.boxes)?.elapsedMs, 3 * HOUR);
  assert.equal(metrix.job(T, mail.jobId!), undefined, "the merged job is gone");
  const audit = job.events.find((e) => e.eventType === "CORRELATION_LINKED")!;
  assert.equal(audit.attrs.reason, "estimator confirmed in console");

  assert.throws(() => metrix.link(T, [{ system: "x", id: "1" }], { method: "mapping", reason: "r", score: 1 }), /two refs/);
  assert.throws(() => metrix.link(T, [{ system: "x", id: "1" }, { system: "y", id: "2" }], { method: "inferred", reason: "r", score: 0 }), /score/);
  const inferred = metrix.link(T, [{ system: "x", id: "1" }, { system: "y", id: "2" }], { method: "inferred", reason: "same caller, 4 min apart", score: 0.7 });
  const refs = metrix.job(T, inferred.jobId!)!.refs;
  assert.ok(refs.every((r) => r.method === "inferred" && r.score === 0.7 && r.reason === "same caller, 4 min apart"));
});

test("opening the box: agent timing builds a child box inside the quotation, with active time", () => {
  const { metrix } = setup();
  const ref = [{ system: "brusato-quote", id: "418/2026" }];
  metrix.ingest(T, event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z", refs: ref }));
  const agent = (eventType: string, at: string) =>
    metrix.ingest(T, { source: "agent", sourceEventId: `${eventType}@${at}`, eventType, occurredAt: at, confidence: "A", refs: ref, attrs: { boxType: "quote-preparation" } });
  agent("AGENT_START", "2026-10-09T09:30:00Z");
  agent("AGENT_PAUSE", "2026-10-09T09:50:00Z");
  agent("AGENT_PAUSE", "2026-10-09T09:55:00Z"); // stray: ignored
  agent("AGENT_RESUME", "2026-10-09T10:10:00Z");
  const r = agent("AGENT_DONE", "2026-10-09T10:20:00Z");
  const parent = quotation(r.boxes)!;
  const child = r.boxes.find((b) => b.boxType === "quote-preparation")!;
  assert.equal(child.parentId, parent.id);
  assert.equal(child.elapsedMs, 50 * 60_000);
  assert.equal(child.activeMs, 30 * 60_000, "20 min + 10 min of work; the pause is not counted");
  assert.equal(child.confidence, "A");
  assert.equal(parent.status, "open");
});

test("mode comes from the schedule at the IN time, so before/after share one definition", () => {
  const d = parseDeployment({ ...BRUSATO, modeSchedule: [{ from: "2026-11-01", mode: "ASSISTED" }] });
  const { metrix } = setup(d);
  const before = metrix.ingest(T, event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-31T23:00:00Z", refs: [{ system: "brusato-quote", id: "1/2026" }] }));
  const after = metrix.ingest(T, event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-11-01T08:00:00Z", refs: [{ system: "brusato-quote", id: "2/2026" }] }));
  assert.equal(quotation(before.boxes)?.mode, "BASELINE");
  assert.equal(quotation(after.boxes)?.mode, "ASSISTED");
});

test("events without identifiers are kept but put on no job", () => {
  const { metrix, store } = setup();
  const r = metrix.ingest(T, event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z" }));
  assert.equal(r.jobId, null);
  assert.equal(store.uncorrelatedCount(T), 1);
});

test("tenants are isolated: the same quote number is two different jobs", () => {
  const { metrix } = setup(BRUSATO, ["brusato", "other"]);
  const ref = [{ system: "brusato-quote", id: "418/2026" }];
  const a = metrix.ingest("brusato", event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z", refs: ref, sourceEventId: "same" }));
  const b = metrix.ingest("other", event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z", refs: ref, sourceEventId: "same" }));
  assert.equal(b.duplicate, false);
  assert.notEqual(a.jobId, b.jobId);
  assert.equal(metrix.job("other", a.jobId!), undefined);
});

test("bad timestamps are refused", () => {
  const { metrix } = setup();
  assert.throws(() => metrix.ingest(T, event({ eventType: "X", occurredAt: "yesterday-ish" })), /occurredAt/);
});

test("audit: an inferred merge keeps its reason and score on the identifiers it brought over", () => {
  const { metrix } = setup();
  const a = metrix.ingest(T, fromCallDash(envelope("REQUEST_COMPLETE", "2026-10-09T09:00:00Z", { correlationId: "fc_x" })));
  metrix.ingest(T, event({ eventType: "QUOTE_SENT", occurredAt: "2026-10-09T12:00:00Z", refs: [{ system: "brusato-quote", id: "77/2026" }] }));
  metrix.link(T, [{ system: "calldash-call", id: "fc_x" }, { system: "brusato-quote", id: "77/2026" }], {
    method: "inferred",
    reason: "same caller, 4 min apart",
    score: 0.6,
  });
  const refs = metrix.job(T, a.jobId!)!.refs;
  const quote = refs.find((r) => r.system === "brusato-quote")!;
  assert.equal(quote.method, "inferred");
  assert.equal(quote.score, 0.6);
  assert.equal(quote.reason, "same caller, 4 min apart");
  assert.equal(refs.find((r) => r.system === "calldash-call")!.method, "exact", "the surviving job's own ids stay exact");
});

test("audit: timing an inner box does not open a gated parent", () => {
  const { metrix } = setup();
  const ref = [{ system: "brusato-quote", id: "9/2026" }];
  const agent = (eventType: string, at: string) =>
    metrix.ingest(T, { source: "agent", sourceEventId: `${eventType}@${at}`, eventType, occurredAt: at, confidence: "A", refs: ref, attrs: { boxType: "quote-preparation" } });
  agent("AGENT_START", "2026-10-09T09:00:00Z");
  const r = agent("AGENT_DONE", "2026-10-09T09:30:00Z");
  assert.equal(quotation(r.boxes), undefined);
  const child = r.boxes.find((b) => b.boxType === "quote-preparation")!;
  assert.equal(child.parentId, null);
  // Once the job is a request, the parent appears and adopts the child.
  const after = metrix.ingest(T, event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T08:50:00Z", refs: ref }));
  assert.equal(after.boxes.find((b) => b.boxType === "quote-preparation")!.parentId, quotation(after.boxes)!.id);
});

test("audit: rematch applies changed rules to stored events; refresh re-reads transient metadata", () => {
  const { store, metrix: before } = setup();
  const ref = [{ system: "brusato-quote", id: "5/2026" }];
  before.ingest(T, event({ eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z", refs: ref }));
  before.ingest(T, event({ eventType: "QUOTE_SENT", occurredAt: "2026-10-09T10:00:00Z", refs: ref, sourceEventId: "qs" }));
  const q = quoteEmail("<q5@brusato.example>", "2026-10-09T11:00:00Z", { attachments: ["Preventivo_5_2026.pdf"] });
  const closed = quotation(before.ingest(T, q.input, q.transient).boxes)!;
  assert.equal(closed.elapsedMs, HOUR, "system QUOTE_SENT is the first OUT");

  // New rules: QUOTE_SENT no longer counts. Same store, new deployment.
  const changed = parseDeployment({
    ...BRUSATO,
    boxes: BRUSATO.boxes.map((b) => (b.boxType === "quotation" ? { ...b, out: b.out.filter((m) => m.eventType !== "QUOTE_SENT") } : b)),
  });
  const after = new (before.constructor as typeof import("../src/engine.ts").Metrix)(store, new Map([[T, changed]]));
  assert.deepEqual(after.rematch(T), { events: 3, jobs: 1 });
  const job = after.jobOfRef(T, ref[0]!)!;
  const box = quotation(job.boxes)!;
  assert.equal(box.elapsedMs, 2 * HOUR, "the attachment-rule OUT is kept, the dropped QUOTE_SENT rule is gone");
  assert.equal(box.id, closed.id, "same box, re-measured");

  // Refresh: a re-import with metadata the new rules no longer accept drops the OUT.
  const stricter = parseDeployment({
    ...changed,
    boxes: changed.boxes.map((b) => (b.boxType === "quotation" ? { ...b, out: [{ ...b.out[0]!, attachment: "^NEVER$" }] } : b)),
  });
  const strict = new (before.constructor as typeof import("../src/engine.ts").Metrix)(store, new Map([[T, stricter]]));
  const refreshed = strict.ingest(T, q.input, q.transient, { refresh: true });
  assert.equal(refreshed.duplicate, true);
  assert.equal(quotation(refreshed.boxes)!.status, "open");
});
