# Architecture

```
 Upload (portal, email-in, contractor feed)
        │
        ▼
 ┌──────────────┐   ObjectCreated   ┌────────────────────────┐
 │ Amazon S3    │ ─────────────────▶│ Lambda: ingest-document │
 │ documents    │                   │  1. Textract DetectText │
 │ (versioned,  │                   │  2. Bedrock classify    │
 │  KMS, object │                   │  3. Textract Expense /  │
 │  lock)       │                   │     Queries extraction  │
 └──────────────┘                   │  4. fields + confidence │
                                    └───────────┬────────────┘
                                                ▼
                                   ┌────────────────────────┐
             reviewer confirms ──▶ │ PostgreSQL (RDS)       │
             low-confidence fields │ tickets, weights,      │
                                   │ contracts, invoices,   │
                                   │ exceptions, runs       │
                                   └───────────┬────────────┘
                                               ▼
 EventBridge Scheduler (02:00 Europe/London) ┌────────────────────────────┐
 ──────────────────────────────────────────▶ │ Lambda: reconcile-scheduled│
                                             │  core/pipeline.js (pure)   │
                                             │  Bedrock explanation       │
                                             │  (fact-checked, else       │
                                             │   template)                │
                                             └───────────┬────────────────┘
                                                         ▼
                                     Dashboard · exports · HubSpot tickets
```

## Responsibilities

| Concern | Where | Notes |
|---|---|---|
| Matching, totals, variances, anomaly tests | [core/engine.js](../core/engine.js) | Deterministic, no dependencies. The same code runs in the browser demo, the dashboard, the Lambda and the tests. |
| Field extraction | Amazon Textract ([backend/lib/textract.js](../backend/lib/textract.js)) | `AnalyzeExpense` for invoices. `AnalyzeDocument` + QUERIES for tickets and weighbridge slips. Confidence is stored per field. |
| Document type | Amazon Bedrock ([backend/lib/bedrock.js](../backend/lib/bedrock.js)) | Structured JSON output with a fixed enum. Below 0.8 confidence, or a refusal, sends the document to manual review. |
| Explanations | Amazon Bedrock | The model only sees engine output. Every £ amount and record ID in its text must appear in the facts, or the template explanation is used. |
| Operational records | PostgreSQL ([db/schema.sql](../db/schema.sql)) | Each record links to `documents.id`. Exceptions are de-duplicated by fingerprint across runs. Reviewer decisions are kept in `exception_events`. |
| Scheduling | EventBridge Scheduler → Lambda | Nightly, plus an on-demand event when an invoice is accepted. |

## Evidence rules (enforced in code)

1. **Weight basis.** `weightBasis()` in the engine and the `weight_records_with_basis` view use the same rule: weighbridge with a stored slip = verified, volumetric estimate = estimated, anything else = reported.
2. **Estimates never support charges.** Per-tonne lines use only verified + reported weights.
3. **Totals are never blended.** `aggregateWeights()` returns `verifiedKg`, `reportedKg`, `estimatedKg` separately. `measuredKg` excludes estimates. Trends use measured weight only.
4. **Every exception has evidence.** There is a database `CHECK` on `jsonb_array_length(evidence) > 0`, and a test.
5. **No derived environmental metrics.** The engine has no recycling-rate, diversion, savings or emissions functions. Provider-supplied figures of that kind would be stored as documents and shown as the provider's statement.

## Variance decomposition

For lift lines, billed − supported = Σ(per-ticket problem quantity × billed rate) + supported quantity × (billed rate − contract rate).
Per-ticket exceptions carry the first term. The rate exception carries the second. The line-level quantity exception is a summary row (`rollup: true`) and is left out of totals, so the amount in query is never counted twice. The test `demo invoice: totals and variance decompose exactly` checks this.

## Open items before production

- **Review service.** The UI and API where reviewers confirm low-confidence fields and map accepted documents to tickets, weights and invoices. The ingest Lambda stops at `needs_review` / `extracted` by design.
- **Bedrock access.** Enable the Claude model in the Bedrock console for the deployment region, and confirm the IAM action names for the Bedrock Mantle endpoint in your account (the template grants `bedrock:InvokeModel*` and `bedrock-mantle:CreateInference`).
- **Refusal fallback.** On Bedrock, refusals are handled by sending the document to manual review or by using the template explanation. No second model is called.
- **Auth.** Dashboard sign-in (e.g. Cognito) and per-organisation row-level security in PostgreSQL.
- **Static hosting.** Serve `web/` and `core/` from S3 + CloudFront at the same origin, so the browser can import `../core/*.js`.
