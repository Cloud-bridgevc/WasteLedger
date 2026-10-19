import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolio, buildReviewQueue } from '../core/demo-data.js';
import { runPortfolioChecks } from '../core/pipeline.js';
import {
  parseDate, parseCount, parseWeightKg, parseMoney, parseTicketItems, fieldsNeedingReview, applyFieldReviews,
  buildRecords, acceptDocument, rejectDocument, stateOf, suggestSite, REVIEW_STATES,
} from '../core/review.js';

const REVIEWER = 'reviewer@example.test';
const fresh = () => {
  const data = buildPortfolio();
  return { data, queue: buildReviewQueue(data) };
};
const byId = (queue, prefix) => queue.find((d) => d.documentId.startsWith(prefix));

test('parsers accept common formats and refuse what they cannot be sure of', () => {
  assert.equal(parseDate('2026-09-21'), '2026-09-21');
  assert.equal(parseDate('21/09/2026'), '2026-09-21');
  assert.equal(parseDate('21.09.26'), '2026-09-21');
  assert.equal(parseDate('21 Sept 2026'), '2026-09-21');
  assert.equal(parseDate('Mon 21 September 2026'), '2026-09-21');
  assert.equal(parseDate('16/O9/2026'), null, 'letter O is not a zero');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseCount('2'), 2);
  assert.equal(parseCount('2 bins'), 2);
  assert.equal(parseCount('2.5'), null);
  assert.equal(parseWeightKg('1,284 kg'), 1284);
  assert.equal(parseWeightKg('1.284 t'), 1284);
  assert.equal(parseWeightKg('heavy'), null);
  assert.equal(parseMoney('£1,234.50'), 1234.5);
  assert.deepEqual(parseTicketItems('NG-558261×2, ng-558268 x 2'), [{ ticketNo: 'NG-558261', quantity: 2 }, { ticketNo: 'NG-558268', quantity: 2 }]);
  assert.equal(parseTicketItems('see attached'), null);
});

test('queue states: low confidence needs review, unclassified documents never look ready', () => {
  const { queue } = fresh();
  assert.equal(stateOf(byId(queue, 'DOC-TKT-NG-558309')), REVIEW_STATES.NEEDS_REVIEW);
  assert.equal(stateOf(byId(queue, 'DOC-WB-')), REVIEW_STATES.EXTRACTED);
  assert.equal(stateOf(byId(queue, 'DOC-UPL-')), REVIEW_STATES.NEEDS_REVIEW);
});

test('a low-confidence field blocks acceptance until a person reviews it', () => {
  const { data, queue } = fresh();
  const doc = byId(queue, 'DOC-TKT-NG-558309');
  const confirmation = { siteId: 'SITE-LDS', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', scheduledContainers: 2 };
  const before = buildRecords(doc, confirmation, data);
  assert.equal(before.ok, false);
  assert.match(before.errors[0], /71% confidence/);
  assert.equal(before.records.tickets.length, 0, 'nothing is produced while blocked');
  assert.throws(() => acceptDocument(doc, confirmation, data, { reviewer: REVIEWER }), /cannot be accepted/);

  const reviewed = applyFieldReviews(doc, { containers: { confirm: true } }, { reviewer: REVIEWER, at: '2026-10-05T09:00:00Z' });
  assert.deepEqual(fieldsNeedingReview(reviewed), []);
  const field = reviewed.fields.find((f) => f.key === 'containers');
  assert.equal(field.reviewedBy, REVIEWER);
  assert.equal(field.corrected, false);
  const after = acceptDocument(reviewed, confirmation, data, { reviewer: REVIEWER });
  assert.equal(after.document.state, REVIEW_STATES.ACCEPTED);
  assert.equal(after.records.tickets.length, 1);
});

test('site and provider must be confirmed by a person, even when the printed name matches', () => {
  const { data, queue } = fresh();
  const doc = applyFieldReviews(byId(queue, 'DOC-TKT-NG-558309'), { containers: { confirm: true } }, { reviewer: REVIEWER });
  assert.equal(suggestSite(doc, data.sites), 'SITE-LDS');
  const r = buildRecords(doc, { serviceCode: 'GW-1100-LIFT' }, data);
  assert.deepEqual(r.errors, ['Confirm which site this document belongs to', 'Confirm which provider issued this document']);
  const wrong = buildRecords(doc, { siteId: 'SITE-LDS', providerId: 'PRV-CLR', serviceCode: 'GW-1100-LIFT' }, data);
  assert.match(wrong.errors.join(), /not a contracted service/);
});

test('ticket mapping keeps the source document and derives status from containers lifted', () => {
  const { data, queue } = fresh();
  const doc = applyFieldReviews(byId(queue, 'DOC-TKT-NG-558309'), { containers: { value: '0' } }, { reviewer: REVIEWER });
  const { records } = acceptDocument(doc, { siteId: 'SITE-LDS', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', scheduledContainers: 2 }, data, { reviewer: REVIEWER });
  const t = records.tickets[0];
  assert.equal(t.documentId, doc.documentId);
  assert.equal(t.date, '2026-09-21');
  assert.equal(t.stream, 'General waste');
  assert.equal(t.containers, 0);
  assert.equal(t.status, 'not_collected');
  assert.equal(t.reviewedBy, REVIEWER);
  assert.equal(doc.fields.find((f) => f.key === 'containers').corrected, true);
});

test('a misread date confirmed as read is refused; the corrected value is accepted', () => {
  const { data, queue } = fresh();
  const doc = byId(queue, 'DOC-TKT-NG-558298');
  const c = { siteId: 'SITE-SHF', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', scheduledContainers: 4 };
  const asRead = applyFieldReviews(doc, { date: { confirm: true } }, { reviewer: REVIEWER });
  assert.match(buildRecords(asRead, c, data).errors.join(), /"16\/O9\/2026" is not a date/);
  const fixed = applyFieldReviews(doc, { date: { value: '16/09/2026' } }, { reviewer: REVIEWER });
  assert.equal(buildRecords(fixed, c, data).records.tickets[0].date, '2026-09-16');
});

test('weighbridge slip becomes a verified weight record and gross − tare is checked', () => {
  const { data, queue } = fresh();
  const doc = byId(queue, 'DOC-WB-');
  const c = { siteId: 'SITE-LDS', providerId: 'PRV-NGW', stream: 'General waste' };
  const { records } = acceptDocument(doc, c, data, { reviewer: REVIEWER });
  const w = records.weights[0];
  assert.equal(w.netKg, 415);
  assert.equal(w.method, 'weighbridge');
  assert.equal(w.documentId, doc.documentId);
  const bad = applyFieldReviews(doc, { net: { value: '450 kg' } }, { reviewer: REVIEWER });
  assert.match(buildRecords(bad, c, data).errors.join(), /does not equal net/);
});

test('a document already in the register is updated, never added twice; duplicates are refused', () => {
  const { data, queue } = fresh();
  const doc = applyFieldReviews(byId(queue, 'DOC-TKT-NG-558295'), { containers: { confirm: true }, note: { confirm: true } }, { reviewer: REVIEWER });
  const c = { siteId: 'SITE-LDS', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', scheduledContainers: 2 };
  const out = acceptDocument(doc, c, data, { reviewer: REVIEWER });
  assert.equal(out.records.tickets.length, 0);
  assert.equal(out.updates.tickets.length, 1);
  assert.equal(out.updates.tickets[0].id, data.tickets.find((t) => t.documentId === doc.documentId).id);

  const copy = { ...byId(queue, 'DOC-TKT-NG-558309'), documentId: 'DOC-COPY-1' };
  const reviewedCopy = applyFieldReviews(copy, { containers: { confirm: true }, ticketNo: { value: 'NG-558261' } }, { reviewer: REVIEWER });
  assert.match(buildRecords(reviewedCopy, c, data).errors.join(), /already in the register/);
});

test('unclassified documents cannot be accepted; rejecting needs a reason', () => {
  const { data, queue } = fresh();
  const doc = byId(queue, 'DOC-UPL-');
  assert.match(buildRecords(doc, { siteId: 'SITE-LDS', providerId: 'PRV-NGW' }, data).errors.join(), /cannot be added to the register/);
  assert.throws(() => rejectDocument(doc, { reviewer: REVIEWER }), /reason is required/);
  const r = rejectDocument(doc, { reviewer: REVIEWER, reason: 'Not a waste document' });
  assert.equal(r.state, REVIEW_STATES.REJECTED);
  assert.equal(buildRecords(r, { siteId: 'SITE-LDS', providerId: 'PRV-NGW' }, data).ok, false);
});

test('invoice mapping: lines, ticket items and total must agree', () => {
  const { data } = fresh();
  const known = data.tickets.find((t) => t.siteId === 'SITE-SHF' && t.serviceCode === 'OCC-BALE-LIFT');
  const doc = {
    documentId: 'DOC-INV-CLR-TEST', docType: 'invoice', classificationConfidence: 0.99,
    fields: [
      { key: 'INVOICE_RECEIPT_ID', label: 'Invoice number', value: 'INV-CLR-TEST-1', confidence: 0.99 },
      { key: 'periodFrom', label: 'Period from', value: '01/10/2026', confidence: 0.97 },
      { key: 'periodTo', label: 'Period to', value: '31/10/2026', confidence: 0.97 },
      { key: 'TOTAL', label: 'Total', value: '£44.00', confidence: 0.98 },
    ],
    lines: [{ description: 'Baler collection', quantity: '2', unitRate: '22.00', amount: '44.00', tickets: `${known.ticketNo}×2`, confidence: { quantity: 0.97, unitRate: 0.98, amount: 0.99 } }],
  };
  const c = { siteId: 'SITE-SHF', providerId: 'PRV-CLR', contractId: 'CT-CLR-2026-01' };
  assert.match(buildRecords(doc, c, data).errors.join(), /Line 1: choose the contracted service/);
  const ok = buildRecords(doc, { ...c, lineServiceCodes: ['OCC-BALE-LIFT'] }, data);
  assert.equal(ok.ok, true, ok.errors.join());
  const inv = ok.records.invoices[0];
  assert.equal(inv.id, 'INV-CLR-TEST-1');
  assert.equal(inv.documentId, doc.documentId);
  assert.deepEqual(inv.period, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(inv.lines[0].items, [{ ticketNo: known.ticketNo, quantity: 2, date: known.date }]);
  const wrongTotal = { ...doc, fields: doc.fields.map((f) => (f.key === 'TOTAL' ? { ...f, value: '£54.00' } : f)) };
  assert.match(buildRecords(wrongTotal, { ...c, lineServiceCodes: ['OCC-BALE-LIFT'] }, data).errors.join(), /add up to 44.00/);
  const lowLine = { ...doc, lines: [{ ...doc.lines[0], confidence: { amount: 0.6 } }] };
  assert.match(buildRecords(lowLine, { ...c, lineServiceCodes: ['OCC-BALE-LIFT'] }, data).errors.join(), /Line 1 has low-confidence values/);
});

test('accepting the late paperwork clears the planted exceptions it answers', () => {
  const { data, queue } = fresh();
  const titles = () => {
    const { reconciliations, anomalies } = runPortfolioChecks(data);
    return [...reconciliations.flatMap((r) => r.exceptions), ...anomalies].map((e) => `${e.type}|${e.siteId}|${e.date || ''}|${e.title}`);
  };
  const before = titles();
  assert.ok(before.some((t) => t.startsWith('missing_collection_record|SITE-LDS|2026-09-21')));
  assert.ok(before.some((t) => t.startsWith('low_confidence_extraction')));

  const lds = acceptDocument(applyFieldReviews(byId(queue, 'DOC-TKT-NG-558309'), { containers: { confirm: true } }, { reviewer: REVIEWER }),
    { siteId: 'SITE-LDS', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', scheduledContainers: 2 }, data, { reviewer: REVIEWER });
  data.tickets.push(...lds.records.tickets);
  const existing = applyFieldReviews(byId(queue, 'DOC-TKT-NG-558295'), { containers: { confirm: true }, note: { confirm: true } }, { reviewer: REVIEWER });
  data.extractions = data.extractions.map((x) => (x.documentId === existing.documentId ? { ...x, fields: existing.fields } : x));

  const after = titles();
  assert.ok(!after.some((t) => t.startsWith('missing_collection_record|SITE-LDS|2026-09-21')));
  assert.ok(!after.some((t) => t.startsWith('low_confidence_extraction')));
  assert.ok(after.some((t) => t.startsWith('collected_not_billed') && t.includes(lds.records.tickets[0].ticketNo)), 'the new ticket is flagged as not yet billed');
});
