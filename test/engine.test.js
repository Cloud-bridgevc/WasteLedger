import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolio, DEMO_CASE, lookupsFor } from '../core/demo-data.js';
import { runPortfolioChecks } from '../core/pipeline.js';
import {
  reconcileInvoice, aggregateWeights, measuredTrend, reportToCSV, explainReconciliation, EXCEPTION_TYPES as T,
} from '../core/engine.js';

const data = buildPortfolio();
const { reconciliations, report } = runPortfolioChecks(data, { generatedAt: '2026-10-05T09:00:00Z', lookups: lookupsFor(data) });
const recFor = (pred) => reconciliations.find((r) => pred(data.invoices.find((i) => i.id === r.invoiceId)));
const typesOf = (r) => r.exceptions.map((e) => e.type);

test('generator is deterministic', () => {
  assert.deepEqual(buildPortfolio(), data);
});

test('demo invoice: totals and variance decompose exactly', () => {
  const r = reconciliations.find((x) => x.invoiceId === DEMO_CASE.invoiceId);
  const gw = r.lines.find((l) => l.serviceCode === 'GW-1100-LIFT');
  assert.equal(gw.billed.quantity, 16);
  assert.equal(gw.expected.quantity, 12);
  assert.equal(gw.billed.amount, 316.0);
  assert.equal(gw.expected.amount, 220.8);
  const disp = r.lines.find((l) => l.serviceCode === 'GW-DISPOSAL');
  assert.equal(disp.billed.quantity, 3.85);
  assert.equal(disp.expected.quantity, 3.35);
  assert.equal(disp.weightBasis.verifiedT, 3.35);
  assert.equal(disp.variance, 64.0);
  // Per-item impacts (excluding roll-ups) add up to the invoice variance.
  const itemised = r.exceptions.filter((e) => !e.rollup).reduce((s, e) => s + e.financialImpact, 0);
  assert.equal(Math.round(itemised * 100) / 100, r.totals.variance);
  assert.equal(r.totals.variance, 159.2);
  for (const t of [T.DUPLICATE_BILLING, T.BILLED_NOT_COLLECTED, T.RATE_MISMATCH, T.WEIGHT_UNSUPPORTED]) {
    assert.ok(typesOf(r).includes(t), `expected ${t}`);
  }
});

test('every exception carries evidence', () => {
  for (const e of report.exceptions) assert.ok(e.evidence.length > 0, e.title);
});

test('planted register anomalies are found', () => {
  const missing = report.exceptions.filter((e) => e.type === T.MISSING_COLLECTION).map((e) => `${e.siteId}@${e.date}`);
  assert.deepEqual(missing.sort(), ['SITE-LDS@2026-09-21', 'SITE-SHF@2026-09-16']);
  const dupRec = report.exceptions.filter((e) => e.type === T.DUPLICATE_RECORD);
  assert.equal(dupRec.length, 1);
  assert.equal(dupRec[0].siteId, 'SITE-SHF');
  const outliers = report.exceptions.filter((e) => e.type === T.WEIGHT_OUTLIER);
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].metrics.netKg, 1284);
});

test('other planted invoice issues are found', () => {
  const manAug = recFor((i) => i.siteId === 'SITE-MAN' && i.providerId === 'PRV-NGW' && i.period.from === '2026-08-01');
  assert.ok(typesOf(manAug).includes(T.UNKNOWN_TICKET));
  const manSepFood = recFor((i) => i.siteId === 'SITE-MAN' && i.providerId === 'PRV-ASH' && i.period.from === '2026-09-01');
  assert.ok(manSepFood.exceptions.some((e) => e.type === T.QUANTITY_MISMATCH && !e.rollup));
  const brdAug = recFor((i) => i.siteId === 'SITE-BRD' && i.providerId === 'PRV-NGW' && i.period.from === '2026-08-01');
  assert.ok(typesOf(brdAug).includes(T.RATE_MISMATCH));
  assert.equal(brdAug.totals.variance, 2.5);
});

test('clean invoices reconcile with zero variance', () => {
  const planted = new Set([DEMO_CASE.invoiceId]);
  const dirty = reconciliations.filter((r) => r.totals.variance !== 0).map((r) => r.invoiceId);
  // Demo, MAN Aug DMR, MAN Sep food, BRD Aug fee
  assert.equal(dirty.length, 4, dirty.join(','));
  assert.ok(dirty.some((id) => planted.has(id)));
});

test('weighted totals never mix bases', () => {
  const rows = aggregateWeights(data.weights, ['siteId', 'stream']);
  const food = rows.filter((r) => r.stream === 'Food waste');
  for (const r of food) {
    assert.equal(r.verifiedKg, 0);
    assert.equal(r.reportedKg, 0);
    assert.ok(r.estimatedKg > 0);
    assert.equal(r.measuredKg, 0);
  }
  const trend = measuredTrend(data.weights, { stream: 'Food waste' });
  assert.ok(trend.every((m) => m.changePct === null), 'no trend from estimates alone');
});

test('estimated weights never support a disposal charge', () => {
  const inv = {
    id: 'INV-X', providerId: 'PRV-NGW', siteId: 'SITE-LDS', period: { from: '2026-07-01', to: '2026-07-31' }, documentId: 'D',
    lines: [{ lineNo: 1, serviceCode: 'GW-DISPOSAL', unit: 'tonne', quantity: 1, unitRate: 128, amount: 128 }],
  };
  const weights = [{ id: 'W1', siteId: 'SITE-LDS', stream: 'General waste', date: '2026-07-02', netKg: 1000, method: 'volumetric-estimate' }];
  const r = reconcileInvoice(inv, { contracts: data.contracts, tickets: [], weights });
  assert.equal(r.lines[0].expected.quantity, 0);
  assert.ok(r.exceptions.some((e) => e.type === T.WEIGHT_UNSUPPORTED));
});

test('report exports and explanation use engine numbers', () => {
  const csv = reportToCSV(report);
  assert.ok(csv.split('\n').length === report.exceptions.length + 1);
  const r = reconciliations.find((x) => x.invoiceId === DEMO_CASE.invoiceId);
  const text = explainReconciliation(r, lookupsFor(data));
  assert.match(text, /£159\.20/);
  assert.equal(report.summary.disputedAmount >= 159.2, true);
});
