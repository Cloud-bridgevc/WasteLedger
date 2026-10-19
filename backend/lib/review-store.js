// PostgreSQL side of document review. The rules live in core/review.js. This module loads
// documents into that shape, saves reviewer decisions and writes accepted records in one transaction.

import { getPool, loadContractsForSites } from './db.js';
import { applyFieldReviews, acceptDocument, rejectDocument, buildRecords, stateOf, REVIEW_STATES } from '../../core/review.js';

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

function toDoc(row, fields, lines) {
  return {
    documentId: row.id,
    fileName: row.file_name,
    docType: row.doc_type,
    classificationConfidence: row.classification_confidence == null ? null : Number(row.classification_confidence),
    classifiedBy: row.classified_by,
    state: row.state,
    receivedAt: row.received_at,
    fields: fields.map((f) => ({
      id: f.id, key: f.field_key, label: f.field_label, value: f.raw_value ?? '', confidence: Number(f.confidence),
      reviewedValue: f.reviewed_value ?? undefined, reviewedBy: f.reviewed_by ?? undefined, reviewedAt: f.reviewed_at ? f.reviewed_at.toISOString() : undefined,
      page: f.page, bbox: f.bbox,
    })),
    lines: lines.length ? lines.map((l) => ({ ...l.extracted, ...(l.reviewed || {}), reviewedBy: l.reviewed_by ?? undefined, reviewedAt: l.reviewed_at ? l.reviewed_at.toISOString() : undefined })) : undefined,
  };
}

async function loadDoc(q, orgId, documentId, { lock = false } = {}) {
  const [row] = await q(`SELECT * FROM documents WHERE id = $1 AND org_id = $2${lock ? ' FOR UPDATE' : ''}`, [documentId, orgId]);
  if (!row) return null;
  const fields = await q('SELECT * FROM extracted_fields WHERE document_id = $1 ORDER BY id', [documentId]);
  const lines = await q('SELECT * FROM extracted_lines WHERE document_id = $1 ORDER BY line_index', [documentId]);
  return toDoc(row, fields, lines);
}

const query = (client) => (sql, params) => client.query(sql, params).then((r) => r.rows);

export async function listQueue(orgId) {
  const db = await getPool();
  const q = query(db);
  const rows = await q(`SELECT id FROM documents WHERE org_id = $1 AND state IN ('needs_review', 'extracted') ORDER BY received_at`, [orgId]);
  const docs = [];
  for (const r of rows) docs.push(await loadDoc(q, orgId, r.id));
  return docs.map((d) => ({ ...d, reviewState: stateOf(d) }));
}

export async function getDocument(orgId, documentId) {
  const db = await getPool();
  const doc = await loadDoc(query(db), orgId, documentId);
  return doc && { ...doc, reviewState: stateOf(doc) };
}

/** Context that buildRecords needs to check site, provider, service and duplicates. */
async function contextFor(q, orgId, doc) {
  const sites = (await q('SELECT id, name FROM sites WHERE org_id = $1', [orgId]));
  const providers = await q('SELECT id, name FROM providers');
  const contracts = await loadContractsForSites(q, sites.map((s) => s.id));
  const ticketNo = doc.fields.find((f) => f.key === 'ticketNo');
  const no = ticketNo ? String(ticketNo.reviewedValue ?? ticketNo.value).trim().toUpperCase() : null;
  const tickets = (await q('SELECT * FROM collection_tickets WHERE document_id = $1 OR ticket_no = $2', [doc.documentId, no])).map((t) => ({
    id: t.id, ticketNo: t.ticket_no, siteId: t.site_id, providerId: t.provider_id, serviceCode: t.service_code, stream: t.stream, date: iso(t.collected_on),
    scheduledContainers: t.scheduled_containers, containers: t.containers, status: t.status, note: t.note, documentId: t.document_id, source: t.source,
  }));
  const weights = (await q('SELECT id, document_id AS "documentId" FROM weight_records WHERE document_id = $1', [doc.documentId]));
  const invNo = doc.fields.find((f) => f.key === 'invoiceNo' || f.key === 'INVOICE_RECEIPT_ID');
  const invoices = invNo ? await q('SELECT id FROM invoices WHERE id = $1', [String(invNo.reviewedValue ?? invNo.value).trim()]) : [];
  // Ticket dates for invoice line items.
  const lineTickets = (doc.lines || []).flatMap((l) => String(l.tickets || '').split(/[,;\n]+/).map((x) => x.trim().split(/\s*[×x*:]/)[0].toUpperCase()).filter(Boolean));
  if (lineTickets.length) {
    for (const t of await q('SELECT ticket_no, collected_on FROM collection_tickets WHERE ticket_no = ANY($1)', [lineTickets])) tickets.push({ ticketNo: t.ticket_no, date: iso(t.collected_on) });
  }
  return { sites, providers, contracts, tickets, weights, invoices };
}

async function withTx(fn) {
  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(query(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function assertOpen(doc) {
  if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });
  if (doc.state === REVIEW_STATES.ACCEPTED || doc.state === REVIEW_STATES.REJECTED) {
    throw Object.assign(new Error(`Document is already ${doc.state}`), { status: 409 });
  }
}

/** edits: { [fieldKey]: { value?, confirm: true } } and optionally { 'line:0': { values: {...} } }. */
export async function saveFieldReviews(orgId, documentId, edits, reviewer) {
  return withTx(async (q) => {
    const doc = await loadDoc(q, orgId, documentId, { lock: true });
    assertOpen(doc);
    const reviewed = applyFieldReviews(doc, edits, { reviewer });
    for (const f of reviewed.fields) {
      if (f.reviewedAt && f.reviewedAt !== doc.fields.find((x) => x.id === f.id).reviewedAt) {
        await q('UPDATE extracted_fields SET reviewed_value = $2, reviewed_by = $3, reviewed_at = $4 WHERE id = $1', [f.id, f.reviewedValue, f.reviewedBy, f.reviewedAt]);
      }
    }
    for (const [i, l] of (reviewed.lines || []).entries()) {
      if (edits[`line:${i}`]) await q('UPDATE extracted_lines SET reviewed = $3, reviewed_by = $4, reviewed_at = now() WHERE document_id = $1 AND line_index = $2', [documentId, i, JSON.stringify(edits[`line:${i}`].values), reviewer]);
    }
    const state = stateOf(reviewed);
    await q('UPDATE documents SET state = $2 WHERE id = $1', [documentId, state]);
    await q('INSERT INTO document_reviews (document_id, actor, action, detail) VALUES ($1,$2,$3,$4)', [documentId, reviewer, 'fields_reviewed', JSON.stringify(edits)]);
    return { ...reviewed, reviewState: state };
  });
}

/** Dry run: what accepting would create, or why it can't. */
export async function previewAccept(orgId, documentId, confirmation) {
  const db = await getPool();
  const q = query(db);
  const doc = await loadDoc(q, orgId, documentId);
  assertOpen(doc);
  return buildRecords(doc, confirmation, await contextFor(q, orgId, doc));
}

export async function accept(orgId, documentId, confirmation, reviewer) {
  return withTx(async (q) => {
    const doc = await loadDoc(q, orgId, documentId, { lock: true });
    assertOpen(doc);
    let result;
    try {
      result = acceptDocument(doc, confirmation, await contextFor(q, orgId, doc), { reviewer });
    } catch (err) {
      throw Object.assign(err, { status: 422 });
    }
    // The document must be accepted before its records are written (see the require_accepted_document trigger).
    await q("UPDATE documents SET state = 'accepted', confirmation = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1", [documentId, JSON.stringify(confirmation), reviewer]);
    const { tickets, weights, invoices } = result.records;
    for (const t of tickets) {
      await q(`INSERT INTO collection_tickets (id, ticket_no, site_id, provider_id, service_code, stream, collected_on, scheduled_containers, containers, status, note, document_id, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [t.id, t.ticketNo, t.siteId, t.providerId, t.serviceCode, t.stream, t.date, t.scheduledContainers, t.containers, t.status, t.note || null, t.documentId, t.source]);
    }
    for (const t of result.updates.tickets) {
      await q('UPDATE collection_tickets SET ticket_no = $2, collected_on = $3, containers = $4, status = $5, note = $6, service_code = $7, stream = $8 WHERE id = $1',
        [t.id, t.ticketNo, t.date, t.containers, t.status, t.note || null, t.serviceCode, t.stream]);
    }
    for (const w of weights) {
      await q(`INSERT INTO weight_records (id, ticket_no, site_id, provider_id, stream, weighed_on, net_kg, method, weighbridge, document_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [w.id, w.ticketNo, w.siteId, w.providerId, w.stream, w.date, w.netKg, w.method, w.weighbridge, w.documentId]);
    }
    for (const inv of invoices) {
      await q(`INSERT INTO invoices (id, provider_id, site_id, contract_id, period_from, period_to, issue_date, currency, total, document_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [inv.id, inv.providerId, inv.siteId, inv.contractId, inv.period.from, inv.period.to, inv.issueDate, inv.currency, inv.total, inv.documentId]);
      for (const l of inv.lines) {
        await q('INSERT INTO invoice_lines (invoice_id, line_no, service_code, description, unit, quantity, unit_rate, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [inv.id, l.lineNo, l.serviceCode, l.description, l.unit, l.quantity, l.unitRate, l.amount]);
        for (const [n, it] of l.items.entries()) {
          await q('INSERT INTO invoice_line_items (invoice_id, line_no, item_no, ticket_no, service_date, quantity) VALUES ($1,$2,$3,$4,$5,$6)', [inv.id, l.lineNo, n + 1, it.ticketNo, it.date, it.quantity]);
        }
      }
    }
    await q('INSERT INTO document_reviews (document_id, actor, action, detail) VALUES ($1,$2,$3,$4)', [documentId, reviewer, 'accepted', JSON.stringify({ confirmation, created: { tickets: tickets.length, weights: weights.length, invoices: invoices.length }, updated: { tickets: result.updates.tickets.length } })]);
    return { document: result.document, records: result.records, updates: result.updates };
  });
}

export async function reject(orgId, documentId, reason, reviewer) {
  return withTx(async (q) => {
    const doc = await loadDoc(q, orgId, documentId, { lock: true });
    assertOpen(doc);
    let out;
    try { out = rejectDocument(doc, { reviewer, reason }); } catch (err) { throw Object.assign(err, { status: 422 }); }
    await q("UPDATE documents SET state = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1", [documentId, reason, reviewer]);
    await q('INSERT INTO document_reviews (document_id, actor, action, detail) VALUES ($1,$2,$3,$4)', [documentId, reviewer, 'rejected', JSON.stringify({ reason })]);
    return out;
  });
}
