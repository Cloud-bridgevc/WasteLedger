import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolio, DEMO_CASE, lookupsFor } from '../core/demo-data.js';
import { reconcileInvoice } from '../core/engine.js';
import { validateDemoRequest, toHubSpotContact } from '../backend/lib/demo-request.js';
import { fingerprint } from '../backend/lib/db.js';

process.env.AWS_REGION ||= 'eu-west-2';
const { checkExplanation } = await import('../backend/lib/bedrock.js');

const data = buildPortfolio();
const rec = reconcileInvoice(data.invoices.find((i) => i.id === DEMO_CASE.invoiceId), data);
const facts = {
  invoiceId: rec.invoiceId,
  totals: rec.totals,
  lines: rec.lines.map((l) => ({ billed: l.billed, supported: l.expected, variance: l.variance })),
  exceptions: rec.exceptions.filter((e) => !e.rollup).map((e) => ({ id: e.id, financialImpact: e.financialImpact, evidence: e.evidence.map((x) => x.ticketNo || x.ref) })),
};

test('explanation check accepts amounts and IDs that are in the facts', () => {
  const dup = rec.exceptions.find((e) => e.type === 'duplicate_billing');
  const out = { summary: `Invoice ${rec.invoiceId} bills £886.80 but records support £727.60. Ticket ${dup.evidence[1].ticketNo} is billed twice (£39.50).`, citedRecordIds: [rec.invoiceId, dup.evidence[1].ticketNo] };
  assert.equal(rec.totals.billed, 886.8);
  assert.deepEqual(checkExplanation(out, facts), { ok: true, badIds: [], badAmounts: [] });
});

test('explanation check rejects invented amounts and unknown IDs', () => {
  const out = { summary: 'This saved £1,000.00 in landfill tax.', citedRecordIds: ['NG-000000'] };
  const r = checkExplanation(out, facts);
  assert.equal(r.ok, false);
  assert.deepEqual(r.badIds, ['NG-000000']);
  assert.deepEqual(r.badAmounts, ['1000.00']);
});

test('demo request validation', () => {
  const good = { firstname: 'Sam', lastname: 'Lee', email: 'sam@example.com', company: 'Test Co', segment: 'hotel_group', site_count: '6–15', consent: true };
  const r = validateDemoRequest(good);
  assert.equal(r.ok, true);
  assert.equal(toHubSpotContact(r.value).wl_segment, 'hotel_group');
  assert.equal(validateDemoRequest({ ...good, consent: false }).ok, false);
  assert.equal(validateDemoRequest({ ...good, email: 'nope' }).ok, false);
  assert.equal(validateDemoRequest({ ...good, segment: 'bank' }).ok, false);
});

test('exception fingerprints are stable across runs', () => {
  const again = reconcileInvoice(data.invoices.find((i) => i.id === DEMO_CASE.invoiceId), data);
  assert.deepEqual(rec.exceptions.map(fingerprint), again.exceptions.map(fingerprint));
  assert.equal(new Set(rec.exceptions.map(fingerprint)).size, rec.exceptions.length);
});

const { handler: reviewApi, identityFrom } = await import('../backend/handlers/review-api.js');
const evt = (claims, method = 'GET', routeKey = 'GET /api/review/queue') => ({
  routeKey, requestContext: { http: { method }, authorizer: claims ? { jwt: { claims } } : undefined }, pathParameters: { id: 'DOC-1' },
});

test('review API: reviewer and organisation come only from the verified token', async () => {
  assert.equal((await reviewApi(evt(null))).statusCode, 401);
  assert.equal((await reviewApi(evt({ email: 'a@example.test' }))).statusCode, 401, 'no organisation claim');
  const viewer = { email: 'a@example.test', 'custom:org_id': 'ORG-CVE', 'cognito:groups': '[viewers]' };
  const res = await reviewApi({ ...evt(viewer, 'POST', 'POST /api/review/documents/{id}/accept'), body: JSON.stringify({ reviewer: 'someone.else@example.test' }) });
  assert.equal(res.statusCode, 403, 'viewers cannot change documents');
  assert.deepEqual(identityFrom(evt({ email: 'r@example.test', 'custom:org_id': 'ORG-CVE', 'cognito:groups': '[reviewers admins]' })), { reviewer: 'r@example.test', orgId: 'ORG-CVE', canReview: true });
});
