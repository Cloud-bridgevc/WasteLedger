-- WasteLedger operational schema (PostgreSQL 15+)
-- Every operational record links to the source document it came from (documents.id).
-- Weights carry a basis; volume estimates are stored with their method and never mixed into measured totals.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE weight_method   AS ENUM ('weighbridge', 'on-board', 'volumetric-estimate');
CREATE TYPE ticket_status   AS ENUM ('collected', 'not_collected');
CREATE TYPE billing_kind    AS ENUM ('per_lift', 'per_tonne', 'fixed');
CREATE TYPE doc_type        AS ENUM ('collection_ticket', 'weighbridge_ticket', 'invoice', 'contract', 'disposal_note', 'other');
CREATE TYPE doc_state       AS ENUM ('received', 'extracted', 'needs_review', 'accepted', 'rejected');
CREATE TYPE exc_severity    AS ENUM ('high', 'medium', 'low');
CREATE TYPE exc_status      AS ENUM ('open', 'disputed', 'resolved', 'accepted');

CREATE TABLE organisations (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  hubspot_company_id text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  name          text NOT NULL,
  site_type     text NOT NULL,             -- Hotel, Shopping centre, Business campus …
  city          text,
  size_value    integer,                   -- rooms / units / buildings: context only, never used to adjust figures
  size_unit     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE providers (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  licence_ref   text,
  weighing_note text,
  accounts_email text,
  hubspot_company_id text
);

CREATE TABLE documents (
  id            text PRIMARY KEY,          -- e.g. DOC-TKT-NG-558261
  org_id        text NOT NULL REFERENCES organisations(id),
  s3_bucket     text NOT NULL,
  s3_key        text NOT NULL,
  s3_version_id text,
  sha256        text NOT NULL,             -- integrity check against the stored object
  doc_type      doc_type,
  classified_by text,                      -- 'bedrock:<model>' | 'user'
  classification_confidence numeric(4,3),
  state         doc_state NOT NULL DEFAULT 'received',
  textract_job  text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (s3_bucket, s3_key, s3_version_id)
);

-- One row per extracted field, so confidence and review are tracked per value.
CREATE TABLE extracted_fields (
  id            bigserial PRIMARY KEY,
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_key     text NOT NULL,
  field_label   text,
  raw_value     text,
  confidence    numeric(4,3) NOT NULL,
  page          integer,
  bbox          jsonb,                     -- Textract geometry, for highlighting in the viewer
  reviewed_value text,
  reviewed_by   text,
  reviewed_at   timestamptz
);
CREATE INDEX ON extracted_fields (document_id);

CREATE TABLE contracts (
  id            text PRIMARY KEY,
  provider_id   text NOT NULL REFERENCES providers(id),
  document_id   text REFERENCES documents(id),
  title         text,
  effective_from date NOT NULL,
  effective_to  date,
  currency      char(3) NOT NULL DEFAULT 'GBP'
);
CREATE TABLE contract_sites (
  contract_id   text REFERENCES contracts(id),
  site_id       text REFERENCES sites(id),
  PRIMARY KEY (contract_id, site_id)
);
CREATE TABLE contract_services (
  contract_id   text REFERENCES contracts(id),
  service_code  text NOT NULL,
  stream        text,
  container     text,
  billing       billing_kind NOT NULL,
  unit          text NOT NULL,
  rate          numeric(12,4) NOT NULL,
  clause        text,
  tolerance_t   numeric(8,3),
  description   text,
  PRIMARY KEY (contract_id, service_code)
);

CREATE TABLE schedules (
  id            text PRIMARY KEY,
  site_id       text NOT NULL REFERENCES sites(id),
  provider_id   text NOT NULL REFERENCES providers(id),
  service_code  text NOT NULL,
  stream        text NOT NULL,
  days          text[] NOT NULL,           -- {'Mon','Thu'}
  containers    integer NOT NULL,
  effective_from date,
  effective_to  date
);

CREATE TABLE collection_tickets (
  id            text PRIMARY KEY,
  ticket_no     text NOT NULL,
  site_id       text NOT NULL REFERENCES sites(id),
  provider_id   text NOT NULL REFERENCES providers(id),
  service_code  text NOT NULL,
  stream        text NOT NULL,
  collected_on  date NOT NULL,
  scheduled_containers integer,
  containers    integer NOT NULL,
  status        ticket_status NOT NULL,
  note          text,
  document_id   text REFERENCES documents(id),
  source        text NOT NULL,             -- 'textract' | 'manual' | 'provider_feed'
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Deliberately not UNIQUE on ticket_no: duplicate entries must be detectable, not silently rejected.
CREATE INDEX ON collection_tickets (ticket_no);
CREATE INDEX ON collection_tickets (site_id, collected_on);

CREATE TABLE weight_records (
  id            text PRIMARY KEY,
  ticket_no     text,
  site_id       text NOT NULL REFERENCES sites(id),
  provider_id   text REFERENCES providers(id),
  stream        text NOT NULL,
  weighed_on    date NOT NULL,
  net_kg        numeric(12,2) NOT NULL CHECK (net_kg >= 0),
  method        weight_method NOT NULL,
  estimate_method text,                    -- required when method = 'volumetric-estimate'
  weighbridge   text,
  document_id   text REFERENCES documents(id),
  CHECK (method <> 'volumetric-estimate' OR estimate_method IS NOT NULL)
);
CREATE INDEX ON weight_records (site_id, weighed_on);

-- Same rule as core/engine.js weightBasis(): verified only with a weighbridge slip on file.
CREATE VIEW weight_records_with_basis AS
SELECT w.*,
  CASE
    WHEN w.method = 'weighbridge' AND w.document_id IS NOT NULL THEN 'verified'
    WHEN w.method = 'volumetric-estimate' THEN 'estimated'
    ELSE 'reported'
  END AS basis
FROM weight_records w;

CREATE TABLE invoices (
  id            text PRIMARY KEY,
  provider_id   text NOT NULL REFERENCES providers(id),
  site_id       text NOT NULL REFERENCES sites(id),
  contract_id   text REFERENCES contracts(id),
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  issue_date    date,
  currency      char(3) NOT NULL DEFAULT 'GBP',
  total         numeric(12,2) NOT NULL,
  document_id   text REFERENCES documents(id)
);
CREATE TABLE invoice_lines (
  invoice_id    text REFERENCES invoices(id) ON DELETE CASCADE,
  line_no       integer,
  service_code  text NOT NULL,
  description   text,
  unit          text,
  quantity      numeric(12,3) NOT NULL,
  unit_rate     numeric(12,4) NOT NULL,
  amount        numeric(12,2) NOT NULL,
  PRIMARY KEY (invoice_id, line_no)
);
CREATE TABLE invoice_line_items (
  invoice_id    text,
  line_no       integer,
  item_no       integer,
  ticket_no     text NOT NULL,
  service_date  date,
  quantity      numeric(12,3) NOT NULL,
  PRIMARY KEY (invoice_id, line_no, item_no),
  FOREIGN KEY (invoice_id, line_no) REFERENCES invoice_lines(invoice_id, line_no) ON DELETE CASCADE
);

-- One row per reconciliation run per invoice. Results are stored whole so a past result can be reproduced.
CREATE TABLE reconciliation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL REFERENCES organisations(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  trigger       text NOT NULL,             -- 'schedule' | 'invoice_received' | 'manual'
  engine_version text NOT NULL,
  summary       jsonb
);
CREATE TABLE reconciliation_results (
  run_id        uuid REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  invoice_id    text REFERENCES invoices(id),
  billed        numeric(12,2) NOT NULL,
  supported     numeric(12,2) NOT NULL,
  variance      numeric(12,2) NOT NULL,
  result        jsonb NOT NULL,            -- full engine output for the invoice
  explanation   text,
  explanation_source text,                 -- 'bedrock:<model>' | 'template'
  PRIMARY KEY (run_id, invoice_id)
);

-- Exceptions keep a stable fingerprint so re-runs update the same exception instead of creating new ones.
CREATE TABLE exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL REFERENCES organisations(id),
  fingerprint   text NOT NULL,
  exc_type      text NOT NULL,
  severity      exc_severity NOT NULL,
  title         text NOT NULL,
  detail        text,
  financial_impact numeric(12,2) NOT NULL DEFAULT 0,
  is_rollup     boolean NOT NULL DEFAULT false,
  site_id       text REFERENCES sites(id),
  provider_id   text REFERENCES providers(id),
  invoice_id    text REFERENCES invoices(id),
  evidence      jsonb NOT NULL,            -- [{kind, ref, ticketNo, documentId}]
  status        exc_status NOT NULL DEFAULT 'open',
  first_seen_run uuid REFERENCES reconciliation_runs(id),
  last_seen_run uuid REFERENCES reconciliation_runs(id),
  hubspot_ticket_id text,
  UNIQUE (org_id, fingerprint),
  CHECK (jsonb_array_length(evidence) > 0)
);
CREATE INDEX ON exceptions (org_id, status);

CREATE TABLE exception_events (
  id            bigserial PRIMARY KEY,
  exception_id  uuid NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,             -- user email or 'system'
  from_status   exc_status,
  to_status     exc_status,
  note          text
);

-- ---------- Document review ----------
-- A person confirms low-confidence fields, the site and the provider before a document's values
-- enter the register (core/review.js, backend/handlers/review-api.js).

ALTER TABLE documents
  ADD COLUMN file_name      text,
  ADD COLUMN confirmation   jsonb,         -- {siteId, providerId, serviceCode, stream, …} as confirmed by the reviewer
  ADD COLUMN reviewed_by    text,
  ADD COLUMN reviewed_at    timestamptz,
  ADD COLUMN reject_reason  text,
  ADD CONSTRAINT reject_needs_reason CHECK (state <> 'rejected' OR reject_reason IS NOT NULL);

-- Invoice line items as extracted, with per-cell confidence, plus the reviewer's corrections.
CREATE TABLE extracted_lines (
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_index    integer NOT NULL,
  extracted     jsonb NOT NULL,            -- {description, quantity, unitRate, amount, confidence:{…}}
  reviewed      jsonb,                     -- {…corrected values, serviceCode, tickets}
  reviewed_by   text,
  reviewed_at   timestamptz,
  PRIMARY KEY (document_id, line_index)
);

-- Who did what to a document, in order.
CREATE TABLE document_reviews (
  id            bigserial PRIMARY KEY,
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  action        text NOT NULL CHECK (action IN ('fields_reviewed', 'accepted', 'rejected')),
  detail        jsonb
);
CREATE INDEX ON document_reviews (document_id);

-- Register records that cite a source document may only come from an accepted document.
-- Manual entries (document_id NULL) are allowed and are labelled by their source column.
CREATE FUNCTION require_accepted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.state = 'accepted'
  ) THEN
    RAISE EXCEPTION 'Document % has not been accepted in review; its values cannot enter %', NEW.document_id, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER collection_tickets_accepted_doc BEFORE INSERT OR UPDATE OF document_id ON collection_tickets
  FOR EACH ROW EXECUTE FUNCTION require_accepted_document();
CREATE TRIGGER weight_records_accepted_doc BEFORE INSERT OR UPDATE OF document_id ON weight_records
  FOR EACH ROW EXECUTE FUNCTION require_accepted_document();
CREATE TRIGGER invoices_accepted_doc BEFORE INSERT OR UPDATE OF document_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION require_accepted_document();
