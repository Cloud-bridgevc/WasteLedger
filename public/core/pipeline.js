// Runs the full check over a portfolio: every invoice, plus anomaly detection on the register.
// The dashboard calls this in the browser. The scheduled Lambda calls it with records loaded from PostgreSQL.

import {
  reconcileInvoice, detectMissingCollections, detectDuplicateRecords, detectWeightOutliers,
  detectLowConfidence, buildExceptionReport, resetExceptionIds,
} from './engine.js';

export function runPortfolioChecks(data, { generatedAt = new Date().toISOString(), lookups } = {}) {
  resetExceptionIds();
  const ctx = { contracts: data.contracts, tickets: data.tickets, weights: data.weights };
  const reconciliations = data.invoices.map((inv) => reconcileInvoice(inv, ctx));
  const anomalies = [
    ...detectMissingCollections({ schedules: data.schedules, tickets: data.tickets, period: data.period }),
    ...detectDuplicateRecords(data.tickets),
    ...detectWeightOutliers(data.weights),
    ...detectLowConfidence(data.extractions || []),
  ];
  const report = buildExceptionReport({
    title: `${data.organisation?.name || 'Portfolio'} — operations exception report`,
    generatedAt,
    period: data.period,
    reconciliations,
    anomalies,
    lookups,
  });
  return { reconciliations, anomalies, report };
}
