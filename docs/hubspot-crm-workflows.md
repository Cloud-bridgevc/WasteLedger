# HubSpot CRM workflows

How WasteLedger uses HubSpot for sales, onboarding and provider exception handling.
Code that talks to HubSpot: [backend/lib/hubspot.js](../backend/lib/hubspot.js), [backend/handlers/demo-request.js](../backend/handlers/demo-request.js), [backend/lib/demo-request.js](../backend/lib/demo-request.js).

## 1. Audiences

| Segment (`wl_segment`) | Who | What they buy or need | Owner team |
|---|---|---|---|
| `hotel_group` | Group operations, procurement and finance at multi-site hotel groups | Portfolio plan. Lift and missed-collection checks across many service yards | Sales (hospitality) |
| `shopping_centre` | Centre managers, managing agents, service-charge accountants | Portfolio plan. Evidence packs for service-charge reconciliation | Sales (property) |
| `facility_operator` | FM providers and in-house estates teams | Operations or Portfolio plan. Multi-provider directory and exception tracking | Sales (FM) |
| `waste_contractor` | Contractor account managers and billing teams | Enterprise data feed and API. Shared exception threads with customers | Partnerships |
| Sales team | WasteLedger account executives and solutions engineers | Clean routing, demo prep from the form, pipeline visibility | Internal |

## 2. Custom properties

Create these in **Settings → Properties** under the group "WasteLedger".

**Contact**

| Internal name | Type | Values / notes |
|---|---|---|
| `wl_segment` | Dropdown | hotel_group, shopping_centre, facility_operator, waste_contractor, other |
| `wl_site_count_band` | Dropdown | 1–5, 6–15, 16–50, 51–150, 150+ |
| `wl_plan_interest` | Dropdown | Operations, Portfolio, Enterprise |
| `wl_demo_request_message` | Multi-line text | Free text from the form |
| `wl_lead_source_detail` | Single-line text | e.g. "Website demo request form" |

**Company**

| Internal name | Type | Notes |
|---|---|---|
| `wl_company_role` | Dropdown | customer, prospect, waste_contractor |
| `wl_org_id` | Single-line text | WasteLedger organisation ID once onboarded (`organisations.id`) |
| `wl_provider_id` | Single-line text | For contractor companies: `providers.id` |
| `wl_active_sites` | Number | Synced nightly from PostgreSQL |
| `wl_open_exceptions` | Number | Synced nightly. Count of open, non-summary exceptions |
| `wl_amount_in_query` | Number (currency) | Synced nightly. Sum of open + raised exception amounts |

**Deal**: `wl_segment`, `wl_site_count_band` (same options as contact).

**Ticket**: `wl_exception_type` (dropdown matching `EXCEPTION_TYPES` in [core/engine.js](../core/engine.js)), `wl_amount_in_query` (currency), `wl_exception_id` (text, the `exceptions.id` UUID).

## 3. Pipelines

**Sales pipeline: "WasteLedger New Business"**

| Stage | Entry criteria | Exit criteria |
|---|---|---|
| Demo requested | Created by the website form Lambda | Call booked |
| Discovery booked | Meeting scheduled | Sample documents received |
| Sample reconciliation | One month of tickets and invoices from 2–3 sites uploaded to a trial org | Results walk-through held |
| Results reviewed | Customer has seen the exception report from their own data | Proposal sent |
| Proposal | Pricing by site count sent | Signed or lost |
| Closed won / Closed lost | | |

The pipeline and "Demo requested" stage IDs are deployment parameters (`HubSpotSalesPipelineId`, `HubSpotDemoRequestedStageId` in [infra/template.yaml](../infra/template.yaml)).

**Onboarding pipeline: "Customer Onboarding"** (deal pipeline, opened when a deal is Closed won)
Contract signed → Sites and providers loaded → Contracts and rates verified by customer → First month reconciled → Live.

**Ticket pipeline: "Provider Exceptions"**
New → Sent to provider → Provider responded → Credit note received / Explained and accepted → Closed.

## 4. Workflows

### W1. Website demo request → routed lead
- **Trigger:** contact created or updated with `wl_lead_source_detail` = "Website demo request form" (the Lambda upserts the contact and creates the deal in "Demo requested").
- **Actions:**
  1. Set lifecycle stage to Lead. Set `hs_lead_status` = New.
  2. If/then branch on `wl_segment`:
     - hotel_group → rotate owner among the hospitality reps
     - shopping_centre → property reps
     - facility_operator → FM reps
     - waste_contractor → Partnerships. Also set company `wl_company_role` = waste_contractor
     - other → round-robin across all reps
  3. Branch on `wl_site_count_band`: 51–150 or 150+ → add a solutions engineer as deal collaborator and set deal priority to High.
  4. Create a task for the owner: "Book demo: review form message" (due in 1 business day).
  5. Send the internal notification to the owner with the form message.
- **Goal:** meeting booked within 1 business day. Enrol in W2 if no meeting after 3 business days.

### W2. Demo follow-up nurture (segment-specific)
- **Trigger:** deal in "Demo requested" for 3 business days with no meeting activity.
- **Actions:** one-to-one emails sent from the owner (not marketing blasts), with copy per segment:
  - Hotels: missed collections still being billed, and lift counts per service yard.
  - Shopping centres: evidence packs for the service-charge audit.
  - FM operators: one directory for many providers and regions.
  - Contractors: fewer invoice disputes and faster payment.
- **Rules:** content describes what the product checks. It never promises savings percentages, recycling rates or emissions reductions. Unenrol when a meeting is booked or the contact replies.

### W3. Sample reconciliation hand-off
- **Trigger:** deal moves to "Sample reconciliation".
- **Actions:** create a task for the solutions engineer to open a trial organisation, and send the contact the secure upload link. When `wl_org_id` is set on the company, post an internal note with the trial dashboard URL.

### W4. Closed won → onboarding
- **Trigger:** deal stage = Closed won.
- **Actions:** set company `wl_company_role` = customer. Create an onboarding deal in "Customer Onboarding". Create tasks: load sites, load providers, upload contracts, **customer sign-off on rate tables** (reconciliation should not go live on rates the customer has not confirmed).

### W5. Provider exception → HubSpot ticket
- **Trigger:** not a HubSpot workflow. The reconciliation service calls `createExceptionTicket()` when a reviewer marks an exception **Raise with provider** in the dashboard.
- **Ticket content:** the exception title, detail, amount in query and the evidence IDs (ticket numbers, invoice line, contract clause). It is linked to the contractor's company record (`wl_provider_id`).
- **HubSpot workflow on the ticket:** assign to the customer's account manager. If still at "Sent to provider" after 10 business days, create a reminder task. When the ticket closes, a webhook calls back to WasteLedger to set the exception to `resolved` or `accepted` with the ticket outcome as the note.

### W6. Account health sync (nightly)
- **Trigger:** after the scheduled reconciliation Lambda finishes.
- **Actions:** update company `wl_active_sites`, `wl_open_exceptions`, `wl_amount_in_query`. A HubSpot workflow alerts the account manager if `wl_open_exceptions` has gone up by 10 or more since the last sync, or if no documents have arrived for 14 days. That usually means a site has stopped uploading.

### W7. Contractor partnership track
- **Trigger:** company `wl_company_role` = waste_contractor and an associated deal is created.
- **Actions:** route to Partnerships. Create tasks for the data-feed technical call and a shared exception workflow agreement. Associate the contractor company with each customer company it serves (association label "Serves"). Account managers can then see which customers are raising exceptions against that contractor.

## 5. Data rules

- Only the fields listed above leave WasteLedger. Ticket images, invoices and weight data stay in AWS. HubSpot gets IDs, counts and amounts.
- The demo form needs explicit consent (`consent: true`), checked in [backend/lib/demo-request.js](../backend/lib/demo-request.js). Store the consent text version alongside the contact if your legal team needs it.
- The HubSpot private-app token is kept in Secrets Manager (`HubSpotSecretArn`). Scopes needed: `crm.objects.contacts.write`, `crm.objects.deals.write`, `crm.objects.companies.write`, `tickets`.
- Rate limits: the client retries on HTTP 429 using `Retry-After`. The nightly sync batches company updates (`/crm/v3/objects/companies/batch/update`, 100 per call).
