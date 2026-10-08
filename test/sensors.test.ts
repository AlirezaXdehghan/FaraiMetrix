import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalRef, extractRefs, matchBoundaries, modeAt, parseDeployment } from "../src/deployment.ts";
import { fromCallDash, parseEnvelope, signCallDash, verifyCallDash } from "../src/sensors/calldash.ts";
import { decodeWords, emlToMetadata, fromEmail, parseEml } from "../src/sensors/email.ts";
import { BRUSATO, envelope, MAILBOX } from "./helpers.ts";

// ── CallDash ───────────────────────────────────────────────────────────────

test("CallDash signature: matches a vector produced by CallDash's own signPayload", () => {
  const secret = "calldash-metrix-secret-0123456789";
  const body = '{"eventType":"REQUEST_COMPLETE","eventId":"evt_1"}';
  const expected = "v1=0d2aadac604041cef5d5130d8814c81f0bbef3323d7d363c7b7901994df64cad";
  assert.equal(signCallDash(secret, body, 1791500000), expected);
  assert.ok(verifyCallDash(secret, body, expected, "1791500000", 1791500010));
  assert.ok(!verifyCallDash(secret, body + " ", expected, "1791500000", 1791500010), "tampered body");
  assert.ok(!verifyCallDash("other-secret-0123456789abcdef", body, expected, "1791500000", 1791500010), "wrong secret");
  assert.ok(!verifyCallDash(secret, body, expected, "1791500000", 1791500000 + 301), "stale");
  assert.ok(!verifyCallDash(secret, body, expected, "17915e5", 1791500010), "non-numeric timestamp");
  assert.ok(!verifyCallDash(secret, body, undefined, "1791500000", 1791500010));
});

test("CallDash envelope: refs from the correlation id and external refs; numbers dropped", () => {
  const e = fromCallDash(
    envelope("REQUEST_COMPLETE", "2026-10-09T09:00:00Z", {
      externalRefs: [{ system: "brusato-quote", id: "418/2026", boundAt: "x" }],
      payload: { from: "+390410000000", to: "+390415555555", direction: "inbound", routes: ["specialista-adr"], formSpecId: "brusato-transport", completeness: 1 },
    }),
  );
  assert.deepEqual(e.refs, [
    { system: "calldash-call", id: "fc_call1" },
    { system: "brusato-quote", id: "418/2026" },
  ]);
  assert.deepEqual(e.attrs, { direction: "inbound", formSpecId: "brusato-transport", completeness: 1, route: "specialista-adr" });
  assert.equal(e.confidence, "A");
  const legacy = fromCallDash(envelope("CALL_STARTED", "2026-10-09T09:00:00Z", { correlationId: null, callId: "c-old" }));
  assert.deepEqual(legacy.refs[0], { system: "calldash-call", id: "c-old" });
});

test("CallDash envelope parsing rejects malformed bodies", () => {
  assert.throws(() => parseEnvelope("nope"), /JSON/);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...envelope("X", "2026-10-09T09:00:00Z"), source: "other" })), /source/);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...envelope("X", "2026-10-09T09:00:00Z"), eventId: "" })), /eventId/);
});

// ── email ──────────────────────────────────────────────────────────────────

const EML = [
  "Message-ID: <q1@brusato.example>",
  "Date: Fri, 9 Oct 2026 13:30:00 +0200",
  "From: Ufficio Preventivi <Preventivi@Brusato.example>",
  "To: Mario Rossi <mario@cliente.example>",
  "Cc: archivio@brusato.example",
  "In-Reply-To: <r1@cliente.example>",
  "References: <r1@cliente.example>",
  "\t<c1@brusato.example>",
  "Subject: =?UTF-8?B?UHJldmVudGl2byBuLiA0MTgvMjAyNiDigJMgdHJhc2xvY28=?=",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Gentile cliente, Content-Disposition: attachment; filename=\"fake.pdf\" in the body is not a header line start",
  "--b",
  "Content-Type: application/pdf",
  "Content-Disposition: attachment;",
  ' filename="Preventivo_418_2026.pdf"',
  "",
  "JVBERi0=",
  "--b--",
].join("\r\n");

test(".eml headers: folded lines, encoded subject, references, attachments; body skipped", () => {
  const p = parseEml(EML);
  assert.equal(p.messageId, "<q1@brusato.example>");
  assert.equal(p.date, "2026-10-09T11:30:00.000Z");
  assert.deepEqual(p.from, ["preventivi@brusato.example"]);
  assert.deepEqual(p.to, ["mario@cliente.example", "archivio@brusato.example"]);
  assert.deepEqual(p.references, ["<r1@cliente.example>", "<c1@brusato.example>"]);
  assert.equal(p.subject, "Preventivo n. 418/2026 – trasloco");
  assert.deepEqual(p.attachments, ["Preventivo_418_2026.pdf"]);
  const meta = emlToMetadata(p, [MAILBOX])!;
  assert.equal(meta.direction, "outbound");
  assert.equal(meta.mailbox, MAILBOX);
  assert.equal(emlToMetadata(p, ["someone@else.example"]), null, "not one of the business's mailboxes");
});

test("encoded words: Q encoding, Latin-1, adjacent words joined", () => {
  assert.equal(decodeWords("=?iso-8859-1?Q?Offerta_n=B0_12/2026?="), "Offerta n° 12/2026");
  assert.equal(decodeWords("=?UTF-8?Q?Ciao?= =?UTF-8?Q?_mondo?="), "Ciao mondo");
});

test("email metadata: thread ids become refs; threading can be switched off", () => {
  const m = { messageId: "<a@x>", direction: "outbound" as const, mailbox: MAILBOX, date: "2026-10-09T09:00:00Z", inReplyTo: "<b@x>", references: ["<c@x>", "<b@x>"] };
  assert.deepEqual(fromEmail(m, { confidence: "B", threading: true }).input.refs.map((r) => r.id), ["a@x", "b@x", "c@x"]);
  assert.deepEqual(fromEmail(m, { confidence: "B", threading: false }).input.refs.map((r) => r.id), ["a@x"]);
  assert.throws(() => fromEmail({ ...m, messageId: " " }, { confidence: "B", threading: true }), /messageId/);
  assert.throws(() => fromEmail({ ...m, mailbox: "nobody" }, { confidence: "B", threading: true }), /mailbox/);
});

// ── deployment rules ───────────────────────────────────────────────────────

test("Brusato rules: quote number from subject or filename, one canonical id", () => {
  const ctx = (subject: string, attachments: string[] = []) => ({
    event: { source: "email" as const, sourceEventId: "x", eventType: "EMAIL_SENT", occurredAt: "2026-10-09T09:00:00Z", confidence: "B" as const, refs: [], attrs: { mailbox: MAILBOX } },
    subject,
    attachments,
  });
  const ids = (subject: string, attachments: string[] = []) =>
    extractRefs(BRUSATO, ctx(subject, attachments)).map((r) => canonicalRef(BRUSATO, r).id);
  assert.deepEqual(ids("Preventivo n. 418/2026"), ["418/2026"]);
  assert.deepEqual(ids("Re: PREV. 418 - 2026"), ["418/2026"]);
  assert.deepEqual(ids("Offerta nr 7/26", ["offerta_7_26.pdf"]), ["7/26", "7/26"]);
  assert.deepEqual(ids("Richiesta trasloco"), []);
  assert.deepEqual(canonicalRef(BRUSATO, { system: "brusato-quote", id: " 418_2026 " }), { system: "brusato-quote", id: "418/2026" });
  assert.deepEqual(canonicalRef(BRUSATO, { system: "other", id: "a-b" }), { system: "other", id: "A-B" });

  assert.deepEqual(matchBoundaries(BRUSATO, ctx("Re: richiesta", ["Preventivo_418_2026.PDF"])), [{ boxType: "quotation", role: "out" }]);
  assert.deepEqual(matchBoundaries(BRUSATO, ctx("Re: richiesta", ["planimetria.pdf"])), [], "not a quote PDF");
});

test("deployment validation lists every problem", () => {
  assert.throws(
    () =>
      parseDeployment({
        name: "x",
        boxes: [
          { boxType: "a", label: "A", parent: "b", in: [], out: [{ subject: "(" }] },
          { boxType: "b", label: "B", parent: "a", in: [], out: [] },
          { boxType: "c", label: "C", parent: "nope", in: [], out: [] },
        ],
        refExtractors: [{ system: "q", field: "subject", pattern: "(\\d+)" }],
        modeSchedule: [{ from: "soon", mode: "FAST" }],
        mailboxes: ["not-an-address"],
      }),
    (err: Error) =>
      ["bad regex", "parent cycle", '"nope" is not a defined box', "named group", "mode must be", "is not a date", "not an email address"].every((s) =>
        err.message.includes(s),
      ),
  );
});

test("mode schedule: latest window at or before the time", () => {
  const d = parseDeployment({
    name: "x",
    boxes: [],
    modeSchedule: [
      { from: "2027-01-01", mode: "AUTOMATED" },
      { from: "2026-11-01", mode: "ASSISTED" },
    ],
  });
  assert.equal(modeAt(d, "2026-10-31T23:59:59Z"), "BASELINE");
  assert.equal(modeAt(d, "2026-11-01T00:00:00Z"), "ASSISTED");
  assert.equal(modeAt(d, "2027-03-01T00:00:00Z"), "AUTOMATED");
});
