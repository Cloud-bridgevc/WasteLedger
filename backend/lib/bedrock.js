// Amazon Bedrock (Claude) for two narrow jobs:
//   1. classifyDocument: decide what kind of waste document an upload is
//   2. explainReconciliation: write a plain-language summary of engine results
// Bedrock never computes totals, matches records or decides whether a charge is valid. That is
// deterministic code in core/engine.js. Explanations are checked against the facts they were given,
// and the template explanation is used if the check fails.

import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { explainReconciliation as templateExplanation } from '../../core/engine.js';

const MODEL = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-opus-5-5';
const client = new AnthropicBedrockMantle({ awsRegion: process.env.BEDROCK_REGION || process.env.AWS_REGION });

const DOC_TYPES = ['collection_ticket', 'weighbridge_ticket', 'invoice', 'contract', 'disposal_note', 'other'];

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['docType', 'confidence', 'providerName', 'reason'],
  properties: {
    docType: { type: 'string', enum: DOC_TYPES },
    confidence: { type: 'number', description: '0 to 1' },
    providerName: { type: ['string', 'null'], description: 'Waste contractor named on the document, or null if none is printed' },
    reason: { type: 'string', description: 'One sentence naming the printed features that decided the type' },
  },
};

function textOf(message) {
  if (message.stop_reason === 'refusal') return null;
  const block = message.content.find((b) => b.type === 'text');
  return block ? block.text : null;
}

/**
 * Classify a document from its first-page text. Low confidence or a refusal sends the
 * document to manual review. It is never guessed.
 */
export async function classifyDocument({ firstPageText, fileName }) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    system: 'You sort commercial waste paperwork for an operations team. Use only what is printed in the text you are given. If the text does not clearly show a document type, choose "other" and give a low confidence.',
    messages: [{
      role: 'user',
      content: `File name: ${fileName}\n\nDocument types:\n- collection_ticket: driver or job ticket for one collection visit (containers lifted, date, site)\n- weighbridge_ticket: gross/tare/net weights from a weighbridge\n- invoice: bill with line items and totals\n- contract: service agreement or rate schedule\n- disposal_note: waste transfer note or consignment note\n- other: anything else\n\nFirst-page text:\n<document>\n${firstPageText.slice(0, 8000)}\n</document>`,
    }],
  });
  const text = textOf(message);
  if (!text) return { docType: 'other', confidence: 0, providerName: null, reason: 'Model declined or returned no text; sent to manual review.', model: MODEL };
  return { ...JSON.parse(text), model: MODEL };
}

const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'citedRecordIds'],
  properties: {
    summary: { type: 'string' },
    citedRecordIds: { type: 'array', items: { type: 'string' } },
  },
};

/** Builds the only facts the model is allowed to use. */
function factsFor(rec, lookups) {
  return {
    invoiceId: rec.invoiceId,
    site: lookups.sites?.[rec.siteId]?.name || rec.siteId,
    provider: lookups.providers?.[rec.providerId]?.name || rec.providerId,
    period: rec.period,
    totals: rec.totals,
    lines: rec.lines.map((l) => ({ lineNo: l.lineNo, serviceCode: l.serviceCode, billed: l.billed, supported: l.expected, variance: l.variance, weightBasis: l.weightBasis })),
    exceptions: rec.exceptions.filter((e) => !e.rollup).map((e) => ({ id: e.id, type: e.type, severity: e.severity, title: e.title, detail: e.detail, financialImpact: e.financialImpact, evidence: e.evidence.map((x) => x.ticketNo || x.ref) })),
  };
}

function allowedIds(facts) {
  return new Set([facts.invoiceId, ...facts.exceptions.flatMap((e) => [e.id, ...e.evidence])]);
}

function allowedAmounts(facts) {
  const nums = [facts.totals.billed, facts.totals.supported, facts.totals.variance,
    ...facts.lines.flatMap((l) => [l.billed.amount, l.supported?.amount, l.variance, l.billed.unitRate, l.supported?.unitRate]),
    ...facts.exceptions.map((e) => e.financialImpact)];
  return new Set(nums.filter((n) => typeof n === 'number').map((n) => Math.abs(n).toFixed(2)));
}

/** Rejects text that cites an unknown record or a money amount not in the facts. */
export function checkExplanation(out, facts) {
  const ids = allowedIds(facts);
  const amounts = allowedAmounts(facts);
  const badIds = out.citedRecordIds.filter((id) => !ids.has(id));
  const money = [...out.summary.matchAll(/£\s?([\d,]+\.\d{2})/g)].map((m) => m[1].replace(/,/g, ''));
  const badAmounts = money.filter((m) => !amounts.has(Number(m).toFixed(2)));
  return { ok: badIds.length === 0 && badAmounts.length === 0, badIds, badAmounts };
}

export async function explainReconciliation(rec, lookups) {
  const facts = factsFor(rec, lookups);
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: EXPLAIN_SCHEMA } },
      system: [
        'You write short explanations of invoice reconciliation results for a facilities team and the waste contractor.',
        'Use only the JSON facts provided. Do not do any arithmetic of your own: every amount you mention must appear in the facts exactly as given, written in pounds with two decimals.',
        'Name the specific ticket numbers or record IDs behind each point and list every ID you mention in citedRecordIds.',
        'Do not speculate about the cause, the contractor\'s intent, environmental impact, recycling rates or emissions.',
        'Write three to six plain sentences. No headings or bullet points.',
      ].join(' '),
      messages: [{ role: 'user', content: `Facts:\n${JSON.stringify(facts, null, 2)}` }],
    });
    const text = textOf(message);
    if (text) {
      const out = JSON.parse(text);
      const check = checkExplanation(out, facts);
      if (check.ok) return { text: out.summary, cited: out.citedRecordIds, source: `bedrock:${MODEL}` };
      console.warn('Explanation failed fact check, using template', { invoiceId: rec.invoiceId, ...check });
    }
  } catch (err) {
    console.warn('Bedrock explanation unavailable, using template', { invoiceId: rec.invoiceId, error: err.message });
  }
  return { text: templateExplanation(rec, lookups), cited: [], source: 'template' };
}
