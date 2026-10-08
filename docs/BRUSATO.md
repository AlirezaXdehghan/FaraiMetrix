# Brusato Trasporti: the first Metrix pilot

Sources:
- *Farai Metrix v0.2*, §9.
- *Brusato User Journey & Operations Discovery Template*.

Deployment: `deployments/brusato.json`.

```
IN: REQUEST COMPLETE ──► [ QUOTATION ] ──► OUT: QUOTE SENT EMAIL
                          └─ quote-preparation (opened later, if useful)
```

## What counts as IN and OUT

| Boundary | Events | Confidence |
|---|---|---|
| IN, phone (HI) | CallDash `REQUEST_COMPLETE` | A |
| IN, phone (OBSERVE baseline) | CallDash `CALL_COMPLETED`, measured only when the call's `OBSERVATION_READY` says `intent: new_request` (the gate) | A |
| IN, email | `EMAIL_RECEIVED` on the quotes mailbox | B live, C imported |
| IN, other | `system REQUEST_COMPLETE` (TMS or CRM, if one records it) | B |
| OUT | `EMAIL_SENT` from the quotes mailbox with a quote PDF attached; or `system QUOTE_SENT` | B live, C imported |

## Steps

1. **Baseline from history (confidence C).** Before anything is installed,
   export a few months of the quotes mailbox (received and sent) as `.eml` and
   run `node scripts/import-eml.ts --tenant brusato ./mail`. That gives
   request→quote times for every emailed request, straight away.
2. **Interview estimates (confidence D).** Use the Discovery template §4 ("How
   long does a straightforward quotation take? A difficult one?") and the §8
   walkthrough. Record each answer with `POST /v1/estimates`, for example
   `{boxType: "quotation", label: "straightforward", minutes: 60, role: "estimator"}`.
   The report shows them next to the measured numbers, never mixed in.
3. **Live baseline (confidence A and B).**
   - **Phone:** connect CallDash: set `CALLDASH_METRIX_URL=https://<metrix>/hooks/calldash/brusato` and `CALLDASH_METRIX_SECRET`.
   - **Email:** connect the email sensor (`/v1/email`).
   - **Linking:** estimators bind the quote number to phone requests in the CallDash console. That is the only change to their work, and only where no automatic link exists.
4. **Read the baseline:**
   - median and P90 request→quote time;
   - how many boxes stay open;
   - how many events carried no identifier at all.

   Decide whether the quotation box needs opening.
5. **Assisted quote:** add `{ "from": "<start date>", "mode": "ASSISTED" }` to
   `modeSchedule`. The box definition doesn't change, so the report compares
   like with like.

## To confirm with Brusato

These come from the Discovery template and the spec's §14. Each one changes a
config value, not code.

| Question | Template § | Changes |
|---|---|---|
| Quotes mailbox address(es) | §7 systems inventory | `mailboxes`, matchers |
| Quote number format, and whether it appears in the subject or the PDF name | §4 | `refExtractors` |
| How a quotation leaves: PDF by email, email body, WhatsApp, management system | §4 | `out` matchers; may add a `system QUOTE_SENT` sensor |
| Whether the TMS or CRM records request or quote timestamps | §7 | a `system` sensor could replace the email rule (confidence B) |
| Mail system and read-only access | §7 | which email connector to build |
| What counts as acceptance | §5 | next box: `quote-acceptance` (quote sent → accepted) |
| Retention, GDPR basis, mailbox-access agreement | — | ops |

## Later boxes, same model

The template's journey (CALL → INTAKE → QUALIFY → QUOTE → ACCEPT → BOOK →
SCHEDULE → EXECUTE → INVOICE) maps to boxes chained by their boundaries: the
OUT of one box is the IN of the next. Add each one only when its boundaries can
be observed and the number would change a decision.
