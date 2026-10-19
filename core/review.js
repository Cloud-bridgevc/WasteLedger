// Document review: the step between extraction and the operational register.
//
// A document's values only become register records (collection tickets, weight records, invoices)
// when this module accepts it. It accepts only when:
//   - every field read below the confidence threshold has been confirmed or corrected by a person,
//   - a person has confirmed which site and provider the document belongs to,
//   - every value the record needs parses cleanly.
// Every record produced keeps the source documentId. Plain ES module, shared by the dashboard and the Lambda.

export const REVIEW_THRESHOLD = 0.9;

export const REVIEW_STATES = Object.freeze({
  NEEDS_REVIEW: 'needs_review', // at least one field below the threshold
  EXTRACTED: 'extracted', // all fields above the threshold; still needs site/provider confirmation
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
});

// Field keys per document type. Textract expense keys (INVOICE_RECEIPT_ID …) are accepted as aliases.
export const REQUIRED_FIELDS = {
  collection_ticket: ['ticketNo', 'date', 'containers'],
  weighbridge_ticket: ['ticketNo', 'date', 'net'],
  invoice: ['invoiceNo', 'periodFrom', 'periodTo', 'total'],
};
const ALIASES = {
  INVOICE_RECEIPT_ID: 'invoiceNo',
  INVOICE_RECEIPT_DATE: 'issueDate',
  TOTAL: 'total',
  VENDOR_NAME: 'vendor',
};

// ---------- parsing ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

/** '2026-09-21', '21/09/2026', '21.09.26', '21 Sept 2026' → '2026-09-21'. UK day-first. Returns null if unsure. */
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return validDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = s.match(/^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (m) {
    const mon = m[2].toLowerCase();
    const month = MONTHS[mon] ?? MONTHS[mon.slice(0, 3)];
    if (month) return validDate(+m[3], month, +m[1]);
  }
  return null;
}

/** Whole, non-negative count. '2', '2 bins' → 2. '2.5' → null. */
export function parseCount(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)(?:\s*[a-z ]*)?$/i);
  return m ? Number(m[1]) : null;
}

/** '1,284 kg', '1284', '1.284 t', '1.284 tonnes' → kilograms. No unit means kg. */
export function parseWeightKg(raw) {
  const m = String(raw ?? '').trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|t|tonnes?|tons?)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return /^t/i.test(m[2] || '') ? Math.round(n * 1000 * 100) / 100 : n;
}

/** '£1,234.50', '1234.5', 'GBP 12.00' → number. */
export function parseMoney(raw) {
  const m = String(raw ?? '').trim().replace(/^(GBP|£)\s*/i, '').replace(/,/g, '').match(/^-?\d+(?:\.\d{1,4})?$/);
  return m ? Number(m[0]) : null;
}

/** 'NG-558261×2, NG-558268 x 2' → [{ ticketNo, quantity }]. */
export function parseTicketItems(raw) {
  const parts = String(raw ?? '').split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^([A-Z]{1,4}-\d{3,})\s*(?:[×x*:]\s*(\d+))?$/i);
    if (!m) return null;
    out.push({ ticketNo: m[1].toUpperCase(), quantity: m[2] ? Number(m[2]) : 1 });
  }
  return out;
}

// ---------- review state ----------

const keyOf = (f) => ALIASES[f.key] || f.key;

/** The value a record will use: the reviewer's value if there is one, else the extracted value. */
export const valueOf = (f) => (f.reviewedValue !== undefined && f.reviewedValue !== null ? f.reviewedValue : f.value);

export const isReviewed = (f) => Boolean(f.reviewedAt);

export function fieldsNeedingReview(doc, threshold = REVIEW_THRESHOLD) {
  return doc.fields.filter((f) => f.confidence < threshold && !isReviewed(f));
}

/**
 * Applies reviewer decisions. edits: { [fieldKey]: { value?, confirm: true } }.
 * Returns a new document. Each touched field records who reviewed it and when.
 */
export function applyFieldReviews(doc, edits, { reviewer, at = new Date().toISOString() }) {
  if (!reviewer) throw new Error('A reviewer is required');
  return {
    ...doc,
    fields: doc.fields.map((f) => {
      const e = edits[keyOf(f)] ?? edits[f.key];
      if (!e) return f;
      const value = e.value !== undefined ? String(e.value).trim() : valueOf(f);
      return { ...f, reviewedValue: value, corrected: value !== f.value, reviewedBy: reviewer, reviewedAt: at };
    }),
    lines: doc.lines?.map((l, i) => {
      const e = edits[`line:${i}`];
      return e ? { ...l, ...e.values, reviewedBy: reviewer, reviewedAt: at } : l;
    }),
  };
}

export function stateOf(doc, threshold = REVIEW_THRESHOLD) {
  if (doc.state === REVIEW_STATES.ACCEPTED || doc.state === REVIEW_STATES.REJECTED) return doc.state;
  if (!REQUIRED_FIELDS[doc.docType] || (doc.classificationConfidence ?? 1) < 0.8) return REVIEW_STATES.NEEDS_REVIEW;
  const lowLines = (doc.lines || []).some((l) => !l.reviewedAt && Math.min(...Object.values(l.confidence || { x: 1 })) < threshold);
  return fieldsNeedingReview(doc, threshold).length || lowLines ? REVIEW_STATES.NEEDS_REVIEW : REVIEW_STATES.EXTRACTED;
}

// ---------- mapping ----------

const field = (doc, key) => doc.fields.find((f) => keyOf(f) === key);
const val = (doc, key) => {
  const f = field(doc, key);
  return f ? valueOf(f) : undefined;
};

/**
 * Validates a document and the reviewer's confirmation, then builds register records.
 * confirmation: { siteId, providerId, serviceCode?, stream?, scheduledContainers?, contractId?, lineServiceCodes? }
 * context: { sites, providers, contracts, tickets, weights, invoices } for consistency checks.
 * Returns { ok, errors, records: { tickets, weights, invoices }, updates } and never throws on bad input.
 */
export function buildRecords(doc, confirmation = {}, context = {}, threshold = REVIEW_THRESHOLD) {
  const errors = [];
  const pending = fieldsNeedingReview(doc, threshold);
  for (const f of pending) errors.push(`${f.label || f.key} was read at ${Math.round(f.confidence * 100)}% confidence and has not been reviewed`);
  if (doc.state === REVIEW_STATES.REJECTED) errors.push('Document was rejected');
  if (!doc.docType || !REQUIRED_FIELDS[doc.docType]) errors.push(`Document type "${doc.docType || 'unknown'}" cannot be added to the register`);
  if (!confirmation.siteId) errors.push('Confirm which site this document belongs to');
  if (!confirmation.providerId) errors.push('Confirm which provider issued this document');
  if (confirmation.siteId && context.sites && !context.sites.some((s) => s.id === confirmation.siteId)) errors.push(`Unknown site ${confirmation.siteId}`);
  if (confirmation.providerId && context.providers && !context.providers.some((p) => p.id === confirmation.providerId)) errors.push(`Unknown provider ${confirmation.providerId}`);
  for (const k of REQUIRED_FIELDS[doc.docType] || []) {
    const v = val(doc, k);
    if (v === undefined || String(v).trim() === '') errors.push(`${k} is missing`);
  }
  const records = { tickets: [], weights: [], invoices: [] };
  const updates = { tickets: [] };
  if (errors.length) return { ok: false, errors, records, updates };

  const base = { siteId: confirmation.siteId, providerId: confirmation.providerId, documentId: doc.documentId };

  if (doc.docType === 'collection_ticket') {
    const date = parseDate(val(doc, 'date'));
    const containers = parseCount(val(doc, 'containers'));
    if (!date) errors.push(`Collection date "${val(doc, 'date')}" is not a date`);
    if (containers === null) errors.push(`Containers lifted "${val(doc, 'containers')}" is not a whole number`);
    if (!confirmation.serviceCode) errors.push('Confirm the contracted service this ticket is for');
    const svc = findService(context.contracts, base.providerId, base.siteId, confirmation.serviceCode, date);
    if (confirmation.serviceCode && context.contracts && !svc) errors.push(`${confirmation.serviceCode} is not a contracted service for this site and provider on ${date}`);
    if (errors.length) return { ok: false, errors, records, updates };
    const ticketNo = String(val(doc, 'ticketNo')).trim().toUpperCase();
    const ticket = {
      ...base,
      id: `TKT-${doc.documentId.replace(/^DOC-/, '')}`,
      ticketNo,
      serviceCode: confirmation.serviceCode,
      stream: confirmation.stream || svc?.stream,
      date,
      scheduledContainers: confirmation.scheduledContainers ?? containers,
      containers,
      status: containers > 0 ? 'collected' : 'not_collected',
      note: val(doc, 'note') || '',
      source: 'textract',
      reviewedBy: lastReviewer(doc),
    };
    // A document already in the register (same document) is updated, never added twice.
    const existing = (context.tickets || []).find((t) => t.documentId === doc.documentId);
    if (existing) updates.tickets.push({ ...existing, ...ticket, id: existing.id });
    else {
      const clash = (context.tickets || []).find((t) => t.ticketNo === ticketNo);
      if (clash) errors.push(`Ticket ${ticketNo} is already in the register from ${clash.documentId || 'a manual entry'}. Reject this copy or correct the number.`);
      else records.tickets.push(ticket);
    }
  }

  if (doc.docType === 'weighbridge_ticket') {
    const date = parseDate(val(doc, 'date'));
    const netKg = parseWeightKg(val(doc, 'net'));
    if (!date) errors.push(`Date weighed "${val(doc, 'date')}" is not a date`);
    if (netKg === null) errors.push(`Net weight "${val(doc, 'net')}" is not a weight`);
    const gross = field(doc, 'gross') && parseWeightKg(val(doc, 'gross'));
    const tare = field(doc, 'tare') && parseWeightKg(val(doc, 'tare'));
    if (netKg !== null && gross != null && tare != null && Math.abs(gross - tare - netKg) > 1) {
      errors.push(`Gross ${gross} kg − tare ${tare} kg does not equal net ${netKg} kg`);
    }
    if (!confirmation.stream) errors.push('Confirm the waste stream');
    const ticketNo = String(val(doc, 'ticketNo')).trim().toUpperCase();
    if ((context.weights || []).some((w) => w.documentId === doc.documentId)) errors.push('This weighbridge slip is already in the register');
    if (errors.length) return { ok: false, errors, records, updates };
    records.weights.push({
      ...base,
      id: `WR-${doc.documentId.replace(/^DOC-/, '')}`,
      ticketNo,
      stream: confirmation.stream,
      date,
      netKg,
      method: 'weighbridge',
      weighbridge: confirmation.weighbridge || val(doc, 'weighbridge') || null,
      reviewedBy: lastReviewer(doc),
    });
  }

  if (doc.docType === 'invoice') {
    const invoiceNo = String(val(doc, 'invoiceNo')).trim();
    const from = parseDate(val(doc, 'periodFrom'));
    const to = parseDate(val(doc, 'periodTo'));
    const total = parseMoney(val(doc, 'total'));
    if (!from || !to || from > to) errors.push('Service period is not a valid date range');
    if (total === null) errors.push(`Total "${val(doc, 'total')}" is not an amount`);
    if ((context.invoices || []).some((i) => i.id === invoiceNo)) errors.push(`Invoice ${invoiceNo} is already in the register`);
    const lines = [];
    (doc.lines || []).forEach((l, i) => {
      const quantity = Number(String(l.quantity).replace(/,/g, ''));
      const unitRate = parseMoney(l.unitRate);
      const amount = parseMoney(l.amount);
      const serviceCode = confirmation.lineServiceCodes?.[i] || l.serviceCode;
      const items = l.tickets ? parseTicketItems(l.tickets) : [];
      if (!Number.isFinite(quantity) || unitRate === null || amount === null) errors.push(`Line ${i + 1}: quantity, rate or amount does not parse`);
      if (!serviceCode) errors.push(`Line ${i + 1}: choose the contracted service`);
      if (items === null) errors.push(`Line ${i + 1}: ticket list "${l.tickets}" should look like NG-558261×2, NG-558268×2`);
      if (!l.reviewedAt && Math.min(...Object.values(l.confidence || { x: 1 })) < threshold) errors.push(`Line ${i + 1} has low-confidence values and has not been reviewed`);
      lines.push({ lineNo: i + 1, serviceCode, description: l.description, unit: l.unit, quantity, unitRate, amount, items: (items || []).map((it) => ({ ...it, date: ticketDate(context, it.ticketNo) })) });
    });
    if (!lines.length) errors.push('Invoice has no lines');
    const lineSum = Math.round(lines.reduce((s, l) => s + (l.amount || 0), 0) * 100) / 100;
    if (total !== null && lines.length && Math.abs(lineSum - total) > 0.01) errors.push(`Lines add up to ${lineSum.toFixed(2)} but the total reads ${total.toFixed(2)}`);
    if (errors.length) return { ok: false, errors, records, updates };
    records.invoices.push({
      id: invoiceNo, providerId: base.providerId, siteId: base.siteId, contractId: confirmation.contractId || null,
      period: { from, to }, issueDate: parseDate(val(doc, 'issueDate')), currency: 'GBP', documentId: doc.documentId, total, lines,
      reviewedBy: lastReviewer(doc),
    });
  }

  return { ok: errors.length === 0, errors, records: errors.length ? { tickets: [], weights: [], invoices: [] } : records, updates: errors.length ? { tickets: [] } : updates };
}

function ticketDate(context, ticketNo) {
  return (context.tickets || []).find((t) => t.ticketNo === ticketNo)?.date || null;
}

function lastReviewer(doc) {
  return doc.fields.filter(isReviewed).sort((a, b) => String(b.reviewedAt).localeCompare(String(a.reviewedAt)))[0]?.reviewedBy || null;
}

function findService(contracts, providerId, siteId, serviceCode, date) {
  for (const c of contracts || []) {
    if (c.providerId !== providerId || !c.siteIds.includes(siteId)) continue;
    if (date && (date < c.effectiveFrom || (c.effectiveTo && date > c.effectiveTo))) continue;
    const s = c.services.find((x) => x.serviceCode === serviceCode);
    if (s) return s;
  }
  return null;
}

/** Best guess at the site from a printed name. Only a suggestion: the reviewer still confirms it. */
export function suggestSite(doc, sites) {
  const hint = String(val(doc, 'site') || doc.siteHint || '').toLowerCase();
  if (!hint) return null;
  return sites.find((s) => s.name.toLowerCase().includes(hint) || hint.includes(s.name.split(',')[0].toLowerCase()))?.id || null;
}

/** Accepts a document. Throws if it is not ready. Use buildRecords first to show the reviewer what is wrong. */
export function acceptDocument(doc, confirmation, context, { reviewer, at = new Date().toISOString() } = {}) {
  if (!reviewer) throw new Error('A reviewer is required');
  const result = buildRecords(doc, confirmation, context);
  if (!result.ok) {
    const err = new Error(`Document ${doc.documentId} cannot be accepted: ${result.errors.join('; ')}`);
    err.errors = result.errors;
    throw err;
  }
  return {
    document: { ...doc, state: REVIEW_STATES.ACCEPTED, acceptedBy: reviewer, acceptedAt: at, confirmation },
    records: result.records,
    updates: result.updates,
  };
}

export function rejectDocument(doc, { reviewer, reason, at = new Date().toISOString() }) {
  if (!reviewer) throw new Error('A reviewer is required');
  if (!reason) throw new Error('A reason is required to reject a document');
  return { ...doc, state: REVIEW_STATES.REJECTED, rejectedBy: reviewer, rejectedAt: at, rejectReason: reason };
}
