// Scheduled reconciliation. EventBridge runs it nightly and when an invoice is accepted.
// Event: {} (all organisations, previous + current month) or { orgId, period: { from, to }, trigger }.

import { runPortfolioChecks } from '../../core/pipeline.js';
import { loadOrgData, saveRun, listOrgIds } from '../lib/db.js';
import { explainReconciliation } from '../lib/bedrock.js';

const ENGINE_VERSION = process.env.ENGINE_VERSION || 'core@0.1.0';

function defaultPeriod(now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

export async function handler(event = {}) {
  const period = event.period || defaultPeriod();
  const orgIds = event.orgId ? [event.orgId] : await listOrgIds();
  const results = [];
  for (const orgId of orgIds) {
    const data = await loadOrgData(orgId, period);
    const lookups = {
      sites: Object.fromEntries(data.sites.map((s) => [s.id, s])),
      providers: Object.fromEntries(data.providers.map((p) => [p.id, p])),
    };
    const { reconciliations, anomalies, report } = runPortfolioChecks(data, { lookups });

    // Bedrock explanations only for invoices with a variance. Clean invoices get the template line.
    const explanations = new Map();
    for (const r of reconciliations) {
      explanations.set(r.invoiceId, r.totals.variance !== 0 ? await explainReconciliation(r, lookups) : { text: null, source: 'none' });
    }

    const exceptions = [...reconciliations.flatMap((r) => r.exceptions), ...anomalies];
    const { runId } = await saveRun({
      orgId, trigger: event.trigger || 'schedule', engineVersion: ENGINE_VERSION,
      reconciliations, exceptions, explanations, summary: report.summary,
    });
    console.log(JSON.stringify({ msg: 'reconciliation complete', orgId, runId, period, ...report.summary }));
    results.push({ orgId, runId, summary: report.summary });
  }
  return { period, results };
}
