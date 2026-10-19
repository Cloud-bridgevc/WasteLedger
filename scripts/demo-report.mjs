// Prints the exception report for the fictional demo portfolio. Pass --csv for CSV output.
import { buildPortfolio, lookupsFor } from '../core/demo-data.js';
import { runPortfolioChecks } from '../core/pipeline.js';
import { reportToCSV } from '../core/engine.js';

const data = buildPortfolio();
const { report } = runPortfolioChecks(data, { lookups: lookupsFor(data) });
if (process.argv.includes('--csv')) {
  console.log(reportToCSV(report));
} else {
  console.log(report.title);
  console.log(JSON.stringify(report.summary, null, 2));
  for (const e of report.exceptions) {
    console.log(`${e.id}  [${e.severity}]  ${e.siteName}  ${e.title}${e.financialImpact && !e.rollup ? `  £${e.financialImpact.toFixed(2)}` : ''}`);
  }
}
