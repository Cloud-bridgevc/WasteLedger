// Amazon Textract extraction. Every field keeps its confidence (0–1) and page position.
// Invoices use AnalyzeExpense (line items). Tickets and weight slips use AnalyzeDocument with QUERIES.
// Multi-page PDFs use the asynchronous Start*/Get* APIs.

import {
  TextractClient, StartExpenseAnalysisCommand, GetExpenseAnalysisCommand,
  StartDocumentAnalysisCommand, GetDocumentAnalysisCommand,
} from '@aws-sdk/client-textract';

const textract = new TextractClient({});

// Questions for each document type. Aliases become field keys.
export const QUERIES = {
  collection_ticket: [
    { Alias: 'ticketNo', Text: 'What is the ticket or job number?' },
    { Alias: 'date', Text: 'What is the collection date?' },
    { Alias: 'site', Text: 'What is the site or customer name?' },
    { Alias: 'container', Text: 'What container type was serviced?' },
    { Alias: 'containers', Text: 'How many containers were lifted?' },
    { Alias: 'note', Text: 'What does the driver note say?' },
  ],
  weighbridge_ticket: [
    { Alias: 'ticketNo', Text: 'What is the collection ticket number referenced?' },
    { Alias: 'weighbridgeNo', Text: 'What is the weighbridge ticket number?' },
    { Alias: 'date', Text: 'What is the date weighed?' },
    { Alias: 'gross', Text: 'What is the gross weight?' },
    { Alias: 'tare', Text: 'What is the tare weight?' },
    { Alias: 'net', Text: 'What is the net weight?' },
    { Alias: 'wasteCode', Text: 'What is the EWC or waste code?' },
  ],
};

async function poll(getFn, jobId, maxWaitMs = 120_000) {
  const start = Date.now();
  let delay = 1000;
  const pages = [];
  for (;;) {
    const res = await getFn({ JobId: jobId });
    if (res.JobStatus === 'FAILED') throw new Error(`Textract job ${jobId} failed: ${res.StatusMessage}`);
    if (res.JobStatus === 'SUCCEEDED') {
      pages.push(res);
      let token = res.NextToken;
      while (token) {
        const next = await getFn({ JobId: jobId, NextToken: token });
        pages.push(next);
        token = next.NextToken;
      }
      return pages;
    }
    if (Date.now() - start > maxWaitMs) throw new Error(`Textract job ${jobId} timed out`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);
  }
}

/** Invoice → { fields, lines } with per-field confidence. */
export async function extractInvoice({ bucket, key }) {
  const { JobId } = await textract.send(new StartExpenseAnalysisCommand({ DocumentLocation: { S3Object: { Bucket: bucket, Name: key } } }));
  const pages = await poll((p) => textract.send(new GetExpenseAnalysisCommand(p)), JobId);
  const fields = [];
  const lines = [];
  for (const page of pages) {
    for (const doc of page.ExpenseDocuments || []) {
      for (const f of doc.SummaryFields || []) {
        fields.push({
          key: f.Type?.Text || 'OTHER',
          label: f.LabelDetection?.Text || f.Type?.Text,
          value: f.ValueDetection?.Text ?? '',
          confidence: Math.min(f.Type?.Confidence ?? 100, f.ValueDetection?.Confidence ?? 0) / 100,
          page: f.PageNumber,
          bbox: f.ValueDetection?.Geometry?.BoundingBox,
        });
      }
      for (const group of doc.LineItemGroups || []) {
        for (const item of group.LineItems || []) {
          const cells = Object.fromEntries((item.LineItemExpenseFields || []).map((c) => [c.Type?.Text, { value: c.ValueDetection?.Text ?? '', confidence: (c.ValueDetection?.Confidence ?? 0) / 100 }]));
          lines.push(cells); // ITEM, QUANTITY, UNIT_PRICE, PRICE, EXPENSE_ROW …
        }
      }
    }
  }
  return { fields, lines, jobId: JobId };
}

/** Ticket or weighbridge slip → fields from QUERIES, each with confidence. */
export async function extractByQueries({ bucket, key, docType }) {
  const Queries = QUERIES[docType];
  if (!Queries) throw new Error(`No query set for ${docType}`);
  const { JobId } = await textract.send(new StartDocumentAnalysisCommand({
    DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
    FeatureTypes: ['QUERIES', 'FORMS'],
    QueriesConfig: { Queries },
  }));
  const pages = await poll((p) => textract.send(new GetDocumentAnalysisCommand(p)), JobId);
  const blocks = pages.flatMap((p) => p.Blocks || []);
  const byId = new Map(blocks.map((b) => [b.Id, b]));
  const fields = [];
  for (const q of blocks.filter((b) => b.BlockType === 'QUERY')) {
    const answerIds = (q.Relationships || []).filter((r) => r.Type === 'ANSWER').flatMap((r) => r.Ids);
    const best = answerIds.map((id) => byId.get(id)).sort((a, b) => b.Confidence - a.Confidence)[0];
    const def = Queries.find((x) => x.Text === q.Query?.Text);
    fields.push({
      key: q.Query?.Alias || def?.Alias,
      label: def?.Text,
      value: best?.Text ?? '',
      confidence: best ? best.Confidence / 100 : 0, // no answer → zero confidence → review
      page: best?.Page,
      bbox: best?.Geometry?.BoundingBox,
    });
  }
  return { fields, jobId: JobId };
}

/** Short text sample for classification (first page lines), without running the full analysis. */
export function firstLines(blocks, n = 60) {
  return blocks.filter((b) => b.BlockType === 'LINE' && (b.Page ?? 1) === 1).slice(0, n).map((b) => b.Text).join('\n');
}
