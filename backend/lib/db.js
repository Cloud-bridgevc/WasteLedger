// PostgreSQL access. Connection details come from Secrets Manager (RDS-managed secret).
// Loaders return records in the shapes core/engine.js expects.

import pg from 'pg';
import { exceptionFingerprint as fingerprint } from '../../core/engine.js';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let pool;

export async function getPool() {
  if (pool) return pool;
  // Local development and integration tests: a plain connection string.
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    return pool;
  }
  const sm = new SecretsManagerClient({});
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
  const s = JSON.parse(SecretString);
  pool = new pg.Pool({
    host: process.env.DB_HOST || s.host,
    port: Number(process.env.DB_PORT || s.port || 5432),
    database: process.env.DB_NAME || s.dbname || 'wasteledger',
    user: s.username,
    password: s.password,
    ssl: { rejectUnauthorized: true },
    max: 4,
  });
  return pool;
}

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const num = (v) => (v == null ? v : Number(v));

/** Loads everything the engine needs for one organisation and period. */
export async function loadOrgData(orgId, period) {
  const db = await getPool();
  const q = (sql, params) => db.query(sql, params).then((r) => r.rows);
  const [org] = await q('SELECT id, name FROM organisations WHERE id = $1', [orgId]);
  const sites = await q('SELECT id, name, site_type AS type, city FROM sites WHERE org_id = $1', [orgId]);
  const siteIds = sites.map((s) => s.id);
  const providers = await q('SELECT DISTINCT p.id, p.name FROM providers p JOIN contracts c ON c.provider_id = p.id JOIN contract_sites cs ON cs.contract_id = c.id WHERE cs.site_id = ANY($1)', [siteIds]);

  const contracts = await loadContractsForSites(q, siteIds);

  const schedules = (await q('SELECT * FROM schedules WHERE site_id = ANY($1)', [siteIds])).map((s) => ({
    id: s.id, siteId: s.site_id, providerId: s.provider_id, serviceCode: s.service_code, stream: s.stream, days: s.days, containers: s.containers, effectiveFrom: iso(s.effective_from),
  }));

  const tickets = (await q('SELECT * FROM collection_tickets WHERE site_id = ANY($1) AND collected_on BETWEEN $2 AND $3', [siteIds, period.from, period.to])).map((t) => ({
    id: t.id, ticketNo: t.ticket_no, siteId: t.site_id, providerId: t.provider_id, serviceCode: t.service_code, stream: t.stream,
    date: iso(t.collected_on), scheduledContainers: t.scheduled_containers, containers: t.containers, status: t.status, note: t.note, documentId: t.document_id, source: t.source,
  }));

  // Weights over a longer window so outlier detection has a baseline.
  const weights = (await q("SELECT * FROM weight_records WHERE site_id = ANY($1) AND weighed_on BETWEEN ($2::date - interval '180 days') AND $3", [siteIds, period.from, period.to])).map((w) => ({
    id: w.id, ticketNo: w.ticket_no, siteId: w.site_id, providerId: w.provider_id, stream: w.stream, date: iso(w.weighed_on),
    netKg: num(w.net_kg), method: w.method, estimateMethod: w.estimate_method, documentId: w.document_id, weighbridge: w.weighbridge,
  }));

  const invRows = await q('SELECT * FROM invoices WHERE site_id = ANY($1) AND period_to BETWEEN $2 AND $3', [siteIds, period.from, period.to]);
  const lineRows = await q('SELECT * FROM invoice_lines WHERE invoice_id = ANY($1) ORDER BY line_no', [invRows.map((i) => i.id)]);
  const itemRows = await q('SELECT * FROM invoice_line_items WHERE invoice_id = ANY($1) ORDER BY item_no', [invRows.map((i) => i.id)]);
  const invoices = invRows.map((i) => ({
    id: i.id, providerId: i.provider_id, siteId: i.site_id, contractId: i.contract_id, currency: i.currency,
    period: { from: iso(i.period_from), to: iso(i.period_to) }, issueDate: iso(i.issue_date), documentId: i.document_id, total: num(i.total),
    lines: lineRows.filter((l) => l.invoice_id === i.id).map((l) => ({
      lineNo: l.line_no, serviceCode: l.service_code, description: l.description, unit: l.unit,
      quantity: num(l.quantity), unitRate: num(l.unit_rate), amount: num(l.amount),
      items: itemRows.filter((x) => x.invoice_id === i.id && x.line_no === l.line_no).map((x) => ({ ticketNo: x.ticket_no, date: iso(x.service_date), quantity: num(x.quantity) })),
    })),
  }));

  const extractions = await q(`SELECT d.id AS document_id, d.doc_type, json_agg(json_build_object('key', f.field_key, 'label', f.field_label, 'value', COALESCE(f.reviewed_value, f.raw_value), 'confidence', CASE WHEN f.reviewed_at IS NOT NULL THEN 1 ELSE f.confidence END)) AS fields
    FROM documents d JOIN extracted_fields f ON f.document_id = d.id WHERE d.org_id = $1 AND d.state = 'needs_review' GROUP BY d.id`, [orgId]);

  return {
    organisation: org, sites, providers, contracts, schedules, period, tickets, weights, invoices,
    extractions: extractions.map((x) => ({ documentId: x.document_id, docType: x.doc_type, fields: x.fields.map((f) => ({ ...f, confidence: Number(f.confidence) })) })),
  };
}

/** Contracts (with services) covering any of the given sites, in core/engine.js shape. */
export async function loadContractsForSites(q, siteIds) {
  const contractRows = await q(`SELECT c.*, array_agg(DISTINCT cs.site_id) AS site_ids FROM contracts c JOIN contract_sites cs ON cs.contract_id = c.id WHERE cs.site_id = ANY($1) GROUP BY c.id`, [siteIds]);
  const services = await q('SELECT * FROM contract_services WHERE contract_id = ANY($1)', [contractRows.map((c) => c.id)]);
  return contractRows.map((c) => ({
    id: c.id, providerId: c.provider_id, documentId: c.document_id, siteIds: c.site_ids,
    effectiveFrom: iso(c.effective_from), effectiveTo: iso(c.effective_to),
    services: services.filter((s) => s.contract_id === c.id).map((s) => ({
      serviceCode: s.service_code, stream: s.stream, container: s.container, billing: s.billing, unit: s.unit,
      rate: num(s.rate), clause: s.clause, toleranceT: num(s.tolerance_t), description: s.description,
    })),
  }));

}

export { exceptionFingerprint as fingerprint } from '../../core/engine.js';

export async function saveRun({ orgId, trigger, engineVersion, reconciliations, exceptions, explanations, summary }) {
  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [run] } = await client.query('INSERT INTO reconciliation_runs (org_id, trigger, engine_version, summary) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, trigger, engineVersion, summary]);
    for (const r of reconciliations) {
      const ex = explanations.get(r.invoiceId);
      await client.query(
        'INSERT INTO reconciliation_results (run_id, invoice_id, billed, supported, variance, result, explanation, explanation_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [run.id, r.invoiceId, r.totals.billed, r.totals.supported, r.totals.variance, r, ex?.text, ex?.source],
      );
    }
    const seen = [];
    for (const e of exceptions) {
      const fp = fingerprint(e);
      seen.push(fp);
      // Re-running never reopens something a reviewer closed. It only refreshes details.
      await client.query(`INSERT INTO exceptions (org_id, fingerprint, exc_type, severity, title, detail, financial_impact, is_rollup, site_id, provider_id, invoice_id, evidence, first_seen_run, last_seen_run)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        ON CONFLICT (org_id, fingerprint) DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail,
          financial_impact = EXCLUDED.financial_impact, evidence = EXCLUDED.evidence, last_seen_run = EXCLUDED.last_seen_run`,
      [orgId, fp, e.type, e.severity, e.title, e.detail, e.financialImpact || 0, !!e.rollup, e.siteId || null, e.providerId || null, e.invoiceId || null, JSON.stringify(e.evidence), run.id]);
    }
    await client.query('UPDATE reconciliation_runs SET finished_at = now() WHERE id = $1', [run.id]);
    await client.query('COMMIT');
    return { runId: run.id, fingerprints: seen };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listOrgIds() {
  const db = await getPool();
  return (await db.query('SELECT id FROM organisations ORDER BY id')).rows.map((r) => r.id);
}

export async function closePool() {
  if (pool) await pool.end();
  pool = undefined;
}
