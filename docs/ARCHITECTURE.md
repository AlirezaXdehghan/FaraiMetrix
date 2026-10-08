# Architecture and the spec's engineering questions

## Shape (spec §10)

One Node process, one SQLite file, no runtime dependencies.

```
sensors ──► /hooks/calldash/:tenant   (CallDash HMAC)
        ──► /v1/events /v1/email /v1/agent /v1/links /v1/estimates   (Bearer)
                    │
                    ▼
      Metrix engine (src/engine.ts)
        1. dedupe on (tenant, source, sourceEventId)
        2. match the event against the deployment: IN / OUT / gate per box type
           (subject and filenames are used here, then dropped)
        3. resolve its identifiers to one job; merge jobs that now share an id
        4. store the event; recompute every box of the job from its events
                    │
                    ▼
      Store (src/store.ts, node:sqlite): jobs, refs, events, boxes, estimates
                    │
                    ▼
      /v1/boxes /v1/jobs /v1/report, /console (read-only HTML)
```

| File | Role |
|---|---|
| `src/model.ts` | Box, Boundary, SourceEvent, Ref, Confidence, Mode |
| `src/deployment.ts` | Per-customer rules: boxes, matchers, gates, id extractors, mode schedule |
| `src/engine.ts` | Ingest, correlation, merge, and the pure `measureBox` |
| `src/store.ts` | SQLite persistence, scoped by tenant |
| `src/report.ts` | Per-mode distributions and the comparison with BASELINE |
| `src/sensors/calldash.ts` | Envelope parsing, signature, mapping |
| `src/sensors/email.ts` | Email metadata, `.eml` header parsing |
| `src/http.ts`, `src/views.ts` | API and console |

The **gate** extends the spec slightly. A box type can say "only measure a job
once one of its events matches X". Brusato needs it because CallDash's OBSERVE
mode has no REQUEST_COMPLETE, so the baseline IN is "call ended". Without the
gate, every status-inquiry call would open a quotation box.

## Answers to §14

**1. Which Brusato identifier connects the request to the quotation email?**
Not known yet. Metrix is built to take whichever one exists:
- Brusato's quote number, extracted from the email subject or the PDF filename. The patterns in `deployments/brusato.json` are placeholders until we see a real quotation email.
- The email thread, for requests that arrive by email.
- For phone requests, the estimator binds the quote number to the CallDash call (`POST /v1/calls/:id/correlate` on CallDash). That emits `CORRELATION_BOUND`, which carries both ids and joins the two.

If Brusato's quote numbers only appear inside the PDF, the binding step is the
fallback for phone requests and the thread for email requests.

**2. Can CallDash emit REQUEST_COMPLETE with that identifier?**
Yes:
- **Today:** `REQUEST_COMPLETE` carries the call's correlation id and every external ref bound so far. A ref bound later still arrives, as `CORRELATION_BOUND`.
- **In OBSERVE (the baseline):** there is no REQUEST_COMPLETE. Metrix uses the end of a call that CallDash classified as `new_request`. That IN is no earlier than the true one, so the baseline is if anything slightly short; it never flatters later modes.
- **Verified:** with the real CallDash service in its Asterisk lab (2026-10-09), events reached Metrix signed, de-duplicated and grouped one job per call, with phone numbers dropped.

**3. Which email system, and what API access?**
Unknown: ask Brusato. The `/v1/email` contract is the same whatever the source:
- **Microsoft 365:** a read-only Graph subscription on the quotes mailbox with `Mail.ReadBasic` (metadata only, no bodies), or a mail-flow rule.
- **Google Workspace:** the Gmail API with the `gmail.metadata` scope.
- **Anything else:** IMAP with an app password on a dedicated mailbox, or a BCC of outgoing quotes into a Farai-only mailbox.

The connector is the only missing piece, and it is small once the system is
known.

**4. Can the outgoing quotation be detected reliably?**
Yes, if Brusato's practice is consistent; we need to see it to know. The current
rule is: sent from the quotes mailbox, with a PDF whose name looks like a quote.
- Clarification replies in the same thread (no such PDF) do not count.
- A revised quote is counted (`laterOutCount`) but doesn't move OUT.
- The rule is config, so it can change after the walkthrough without a code change.

**5. What existing backend, auth, tenant model or storage should be reused?**
- **The contract:** CallDash's envelope and signature scheme, unchanged.
- **The conventions:** zero runtime dependencies, node:sqlite, node:test, the env-or-file secrets pattern, tenant scoping on every row.
- **Not shared:** no code is shared at runtime. Metrix is its own product and CallDash is one sensor, so neither repository depends on the other.

**6. What is the smallest Windows/Mac agent?**
- **The server side exists:** `POST /v1/agent` with start/pause/resume/done for a named box and identifier, and the `quote-preparation` child box is defined.
- **The client** can be a tray app with a quote-number field and three buttons. Tauri gives one codebase for Windows and macOS.
- **Idle handling** is a local timer that sends PAUSE.
- **No screen capture and no app tracking.**

Build it only if the baseline shows the quotation box is worth opening
(§12 step 6).

**7. How much of v0.2 already existed?**
- **Existed, in CallDash:** the sensor side (the event vocabulary, correlation ids, external refs, the signed outbox).
- **New in this repository:** the measurement side (boxes, boundaries, correlation into jobs, confidence, modes, the report).

## What was tested

`npm run gate`:
- **Engine:** order independence, duplicates, merges, gates, revisions, child boxes with active time, modes, tenant isolation.
- **Sensors:** the CallDash signature vector, `.eml` parsing, the Brusato id patterns.
- **Report statistics.**
- **The HTTP surface end to end:** auth, the signed hook, email, links, estimates, limits, the console.

The CallDash → Metrix path was also run live (see Q2).
