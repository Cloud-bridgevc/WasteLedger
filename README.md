# WasteLedger

Commercial waste tracking and invoice reconciliation for multi-site organisations.
WasteLedger checks every waste charge against the collection ticket, weight record and contract rate behind it, flags what doesn't match, and produces exception reports that cite their evidence.

> All organisations, sites, providers, tickets, weights and invoices in this repository are **fictional**. Rates are illustrative.

## Run it

```bash
npm run dev
```

Then open http://localhost:5173 (public website) and http://localhost:5173/app.html (dashboard). No install step: the website, dashboard and engine have no dependencies.

```bash
npm test
```

```bash
npm run report
```

`npm run report` prints the exception report for the demo portfolio (add `-- --csv` for CSV).

## What's here

| Path | What it is |
|---|---|
| [core/engine.js](core/engine.js) | Reconciliation, anomaly detection, weight aggregation, report building. Pure JS, runs in browser and Lambda. |
| [core/pipeline.js](core/pipeline.js) | Runs every check over a portfolio |
| [core/review.js](core/review.js) | Document review rules: confidence gate, site/provider confirmation, parsing, mapping documents to tickets, weights and invoices |
| [core/demo-data.js](core/demo-data.js) | Seeded fictional portfolio: 4 sites, 3 providers, 3 contracts, 251 tickets, 249 weight records, 24 invoices, with 11 planted problems listed in `PLANTED_ISSUES` |
| [web/index.html](web/index.html) | Public website: use cases, interactive invoice reconciliation demo, evidence principles, AWS platform, pricing, demo request form |
| [web/app.html](web/app.html) | Dashboard: portfolio, collection register, weight records, provider directory, contract and invoice library, reconciliation, document review queue, exception review, location comparison, reports |
| [backend/](backend/) | Lambda handlers: document ingestion (S3 → Textract → Bedrock), document review API, scheduled reconciliation, demo request → HubSpot |
| [db/schema.sql](db/schema.sql) | PostgreSQL schema. Seed data: `node scripts/seed-sql.mjs` writes [db/seed-demo.sql](db/seed-demo.sql) |
| [infra/template.yaml](infra/template.yaml) | AWS SAM template: KMS-encrypted versioned S3 vault, Lambdas, nightly EventBridge schedule, HTTP API |
| [docs/architecture.md](docs/architecture.md) | Data flow, responsibilities, evidence rules, open items |
| [docs/hubspot-crm-workflows.md](docs/hubspot-crm-workflows.md) | HubSpot properties, pipelines and workflows for hotel groups, shopping centres, facility operators, waste contractors and the sales team |

## The worked example

Invoice `INV-NGW-24117` (fictional Northgate Waste Services → Harbourline Grand, Leeds, September 2026) bills £886.80. The records support £727.60. The £159.20 difference breaks down exactly:

| Exception | Evidence | Amount |
|---|---|---|
| Ticket billed but recorded as not collected | collection ticket with driver note "Bin store blocked", invoice line 1 | £39.50 |
| Same ticket billed twice | collection ticket, invoice line 1 item list | £39.50 |
| Lift rate £19.75 against contracted £18.40 on 12 supported lifts | contract CT-NGW-2025-03 §4.1, invoice line 1 | £16.20 |
| 0.500 t of disposal with no weight records behind it | 6 weighbridge records totalling 3.350 t (verified), invoice line 3 | £64.00 |

It also flags a scheduled Monday collection with no ticket, a weighbridge weight about three times the site median, and a ticket field read at low confidence that needs a reviewer.

The dashboard's **Review queue** holds five documents that arrived late or need a person: the missing Leeds ticket and its weighbridge slip, the missing Sheffield ticket (its date was misread as `16/O9/2026`), the low-confidence ticket above, and an unclassified photo. Accepting the tickets clears the missing-collection exceptions, and the new Leeds ticket is then flagged as collected but not yet billed. Review decisions in the demo are saved in your browser. Clear site data to start again.

## Evidence rules

- Every weight is **verified** (weighbridge slip held), **reported** (provider measurement) or **estimated** (volume × stated assumption). The basis is shown everywhere a weight appears.
- Estimates never support a charge and are never added into measured totals.
- Every exception lists the records it is based on. The database rejects one without evidence.
- WasteLedger does not calculate recycling rates, diversion rates, savings or emissions.
- Bedrock classifies documents and writes explanations. It never computes figures, and an explanation that mentions an amount or record ID not in the facts is thrown away and replaced by the template.

## Deploying (outline)

1. Create an RDS PostgreSQL instance, load `db/schema.sql`, and store the credentials as an RDS-managed secret.
2. Enable the Claude model in Amazon Bedrock for your region.
3. Create a HubSpot private app and save `{"accessToken": "..."}` in Secrets Manager. Set up the properties and pipelines in the HubSpot doc.
4. `cd backend && npm install`, then `sam build -t infra/template.yaml && sam deploy --guided` from the repository root.
5. Host `web/` and `core/` together on S3 + CloudFront, and route `/api/*` to the HTTP API.

To check the review store against a real database (schema and seed loaded):

```bash
DATABASE_URL=postgres://user@localhost:5432/wasteledger node scripts/review-db-check.mjs
```

See [docs/architecture.md](docs/architecture.md#open-items-before-production) for what still needs building before production: the document review service, authentication, and row-level security.
