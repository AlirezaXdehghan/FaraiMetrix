# Farai Metrix

**Measure a business process as a black box.** Find a reliable IN boundary and a
reliable OUT boundary, and measure the time between them. Open the box only when
that is useful.

```
IN  →  [ BUSINESS PROCESS ]  →  OUT
REQUEST COMPLETE  →  [ QUOTATION ]  →  QUOTE SENT
```

This repository implements *Farai Metrix v0.2, Simple Architecture & MVP
Specification* (5 October 2026). The first deployment is the Brusato Trasporti
quotation pilot (`deployments/brusato.json`).

Metrix is separate from CallDash on purpose. CallDash owns the phone
conversation and is **one** of Metrix's sensors. Metrix measures the whole
process across email, phone, messaging, customer systems and a desktop agent.
It never sees call content.

## Run

```sh
npm install                 # dev tools only (TypeScript); no runtime dependencies
npm run gate                # typecheck + tests
cp tenants.example.json tenants.json && cp .env.example .env   # fill in the secrets
node --env-file=.env src/main.ts
```

You need Node ≥ 22.13, which provides built-in SQLite and runs the TypeScript
directly. The console is at `/console`: HTTP Basic, the user is the tenant id
and the password is `consolePassword`. For Docker, see `Dockerfile`.

## The model

| Concept | What it is |
|---|---|
| **Process box** | The core object. It has a type (`quotation`), an IN boundary, an OUT boundary, the elapsed time (OUT − IN), the active time, a mode, a confidence and an optional parent box. |
| **Boundary** | The event that decided IN or OUT: its type, timestamp, source and confidence. |
| **Job** | The business object a box measures. Every identifier for it points at the same job: Brusato's quote number, CallDash's call id, an email thread. Employees never see a Farai number. |
| **Source event** | A normalized sensor fact, stored for audit. It holds metadata only: no bodies, no transcripts, no phone numbers. |
| **Deployment** | Per-customer JSON listing which boxes exist and which events are their IN and OUT. A new box or sensor rule is a config change, not code. |

Behaviour:
- **Boxes are recomputed from stored events on every change.** So delivery order doesn't matter, duplicate deliveries are harmless, and merging two jobs is just moving rows.
- **IN** is the earliest IN event. **OUT** is the earliest OUT event at or after IN.
- **Later OUTs** (revisions, resends) are counted, not measured.
- **An OUT without an IN measures nothing.** The box stays open.
- **Child boxes** use the same model (`parent` in the deployment). A handoff is just the boundary between two boxes.
- **Confidence** (spec §8): **A** instrumented, **B** system, **C** historical, **D** interview. A box's confidence is the weaker of its two boundaries'.
- **Mode** (BASELINE / ASSISTED / AUTOMATED) comes from the deployment's `modeSchedule` at the box's IN time, unless a sensor states it. The box definition stays the same in every mode, so before/after comparisons are legitimate.

## Sensors

| Sensor | How it gets in | Confidence |
|---|---|---|
| CallDash | `POST /hooks/calldash/:tenant`. On CallDash, set `CALLDASH_METRIX_URL` to this URL and `CALLDASH_METRIX_SECRET` to the tenant's `calldash.secret`. Uses CallDash's own HMAC scheme, verified against a vector produced by CallDash's code. | A |
| Email, live | `POST /v1/email` with message metadata. Anything that can see the mailbox can post it: a mail-flow rule, Power Automate, Apps Script, a small IMAP poller. The subject and attachment names are used for matching and then dropped. | B |
| Email, historical | `node scripts/import-eml.ts --tenant brusato <dir>` over exported `.eml` files. It reads headers and attachment names only. | C |
| WhatsApp, customer systems | `POST /v1/events`, normalized. | B by default |
| Metrix Agent | `POST /v1/agent` `{action: start\|pause\|resume\|done, boxType, ref, eventId}`. Active time is the sum of START/RESUME→PAUSE/DONE intervals. | A |
| Interview | `POST /v1/estimates`: what staff say a box takes. It is shown next to the measured numbers and never mixed into them. | D |

Correlation (spec §6) uses **exact identifiers first**:
- **Two ids seen on one event belong to one job.** For example, CallDash's call id plus the quote number an estimator bound to the call.
- **Every Message-ID of an email thread is an identifier**, so a reply joins its request (`emailThreading`).
- **Quote numbers are pulled from subjects and filenames** by the deployment's `refExtractors`. Different spellings of one number (`418_2026`, `418/2026`) normalise to the same id.
- **Explicit or inferred links** go through `POST /v1/links`. An inferred link must carry a reason and a score, and both are kept.

### Changing a rule

Deployments change as we learn the customer's habits. After editing one:
- **Run `node scripts/rematch.ts --tenant <id>`.** It re-matches the stored events and re-measures every job.
- **For subject and filename rules,** re-import the mailbox with `import-eml.ts --refresh`. That metadata was never stored, so rematch can't re-check matches that depended on it, and it keeps them as they were.

## API

All `/v1` routes need `Authorization: Bearer <tenant API key>`.

| Route | |
|---|---|
| `POST /v1/events` | `{source: email|whatsapp|system|manual, sourceEventId, eventType, occurredAt, confidence?: B|C|D, mode?, refs[], attrs{}, subject?, attachments?}`. Confidence A is reserved for Farai's own instruments (the CallDash hook, the agent), and a `manual` entry must state its confidence. |
| `POST /v1/email` | `{messageId, direction, mailbox, date, inReplyTo?, references?, subject?, attachments?}` |
| `POST /v1/agent` | see above |
| `POST /v1/links` | `{refs: [{system,id}, …], method: "mapping"\|"inferred", reason, score?}` |
| `POST /v1/estimates` | `{boxType, label, minutes, role, note?}` |
| `GET /v1/boxes?boxType=&from=&to=` | boxes, newest IN first |
| `GET /v1/boxes/:id` | box, parent, children, identifiers, source events |
| `GET /v1/jobs?system=&id=` | the job an identifier belongs to |
| `GET /v1/report?from=&to=` | per box type, per mode: closed/open count, median, P90, active time, confidence mix, change vs baseline, estimates |

Writes answer `201`, or `200` with `duplicate: true` for an event already seen.

## Privacy (spec §11)

Metrix measures processes, not people:
- **What it stores:** timestamps, identifiers and a few metadata fields. Never message bodies, transcripts, screenshots or phone numbers.
- **Subjects and attachment names** are read during matching and never stored.
- **Isolation:** every table and query is scoped by tenant.
- **The agent** sends only button presses for a named box. It has no screen capture and does no app tracking.
- **No rankings:** the report has no per-employee views.

Still to do per deployment:
- The GDPR basis.
- Retention by data type.
- Agreeing the mailbox access with the customer.

## What is not built yet, by design

The spec's build order (§12) says to add these only when a real deployment
needs them:
- **The desktop Metrix Agent app.** Its API exists, and the `quote-preparation` child box is ready for it.
- **Mail connectors:** a direct Microsoft Graph / Gmail connector. Which one depends on Brusato's mail system (§14 Q3).
- **WhatsApp** specifics.
- **Probabilistic correlation.**
- **PostgreSQL.** `Store` is the only class that touches SQL.

See `docs/ARCHITECTURE.md` for the answers to the spec's engineering questions,
and `docs/BRUSATO.md` for the pilot.
