// WasteLedger core engine. Plain ES module with no dependencies.
// The browser demo, the dashboard, the scheduled Lambda and the tests all import it.
//
// Rules for the whole engine:
//  - Every figure it reports carries an evidence list (record and document IDs) and a basis.
//  - The engine never makes up a value. When a figure can't be derived from records,
//    it is reported as missing and never estimated quietly.
//  - Basis tiers for weights:
//      verified  - weighbridge ticket with a stored source document
//      reported  - provider-supplied figure (e.g. on-board vehicle load cell); not independently checked
//      estimated - derived from container volume × an assumed density; always labelled as an estimate

export const BASIS = Object.freeze({
  VERIFIED: 'verified',
  REPORTED: 'reported',
  ESTIMATED: 'estimated',
});

export const SEVERITY = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

export const EXCEPTION_TYPES = Object.freeze({
  DUPLICATE_BILLING: 'duplicate_billing',
  BILLED_NOT_COLLECTED: 'billed_not_collected',
  UNKNOWN_TICKET: 'unknown_ticket_reference',
  RATE_MISMATCH: 'rate_mismatch',
  QUANTITY_MISMATCH: 'quantity_mismatch',
  WEIGHT_UNSUPPORTED: 'weight_not_supported_by_records',
  ARITHMETIC: 'line_arithmetic_error',
  NO_CONTRACT_RATE: 'no_contract_rate',
  UNBILLED_COLLECTION: 'collected_not_billed',
  MISSING_COLLECTION: 'missing_collection_record',
  DUPLICATE_RECORD: 'duplicate_register_entry',
  WEIGHT_OUTLIER: 'unusual_weight',
  LOW_CONFIDENCE_EXTRACTION: 'low_confidence_extraction',
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- small helpers ----------

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(date) {
  return date.toISOString().slice(0, 10);
}

export function weekdayOf(iso) {
  return WEEKDAYS[parseDate(iso).getUTCDay()];
}

export function datesBetween(fromIso, toIso) {
  const out = [];
  for (let d = parseDate(fromIso); d <= parseDate(toIso); d = new Date(d.getTime() + 86400000)) {
    out.push(toISO(d));
  }
  return out;
}

const inPeriod = (iso, period) => iso >= period.from && iso <= period.to;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function weightBasis(record) {
  if (record.method === 'weighbridge' && record.documentId) return BASIS.VERIFIED;
  if (record.method === 'volumetric-estimate') return BASIS.ESTIMATED;
  return BASIS.REPORTED;
}

let exceptionSeq = 0;
function makeException(fields) {
  exceptionSeq += 1;
  return {
    id: fields.id || `EXC-${String(exceptionSeq).padStart(4, '0')}`,
    status: 'open',
    financialImpact: 0,
    evidence: [],
    ...fields,
  };
}

export function resetExceptionIds() {
  exceptionSeq = 0;
}

// ---------- contract lookup ----------

export function findContractService(contracts, { providerId, siteId, serviceCode, date }) {
  for (const c of contracts) {
    if (c.providerId !== providerId) continue;
    if (!c.siteIds.includes(siteId)) continue;
    if (date < c.effectiveFrom || (c.effectiveTo && date > c.effectiveTo)) continue;
    const svc = c.services.find((s) => s.serviceCode === serviceCode);
    if (svc) return { contract: c, service: svc };
  }
  return null;
}

// ---------- invoice reconciliation ----------

/**
 * Reconcile one invoice against the collection register, weight records and contracts.
 * Returns line-level results, exceptions and totals. Each figure lists the records behind it.
 */
export function reconcileInvoice(invoice, { contracts, tickets, weights }) {
  const ticketByNo = new Map(tickets.map((t) => [t.ticketNo, t]));
  const lineResults = [];
  const exceptions = [];
  const invoiceDocs = [invoice.documentId].filter(Boolean);

  for (const line of invoice.lines) {
    const match = findContractService(contracts, {
      providerId: invoice.providerId,
      siteId: invoice.siteId,
      serviceCode: line.serviceCode,
      date: invoice.period.to,
    });
    const lineRef = `${invoice.id} line ${line.lineNo}`;
    const result = {
      lineNo: line.lineNo,
      serviceCode: line.serviceCode,
      description: line.description,
      unit: line.unit,
      billed: { quantity: line.quantity, unitRate: line.unitRate, amount: line.amount },
      contract: match ? { contractId: match.contract.id, unitRate: match.service.rate, unit: match.service.unit } : null,
      expected: null,
      variance: null,
      matchedRecords: [],
      exceptionIds: [],
      status: 'matched',
    };

    // Arithmetic check on the invoice itself.
    if (Math.abs(round2(line.quantity * line.unitRate) - line.amount) > 0.01) {
      const ex = makeException({
        type: EXCEPTION_TYPES.ARITHMETIC,
        severity: SEVERITY.MEDIUM,
        title: `Line ${line.lineNo}: quantity × rate does not equal line amount`,
        detail: `${line.quantity} × ${line.unitRate.toFixed(2)} = ${round2(line.quantity * line.unitRate).toFixed(2)}, invoice shows ${line.amount.toFixed(2)}.`,
        financialImpact: round2(line.amount - line.quantity * line.unitRate),
        evidence: [{ kind: 'invoice_line', ref: lineRef, documentId: invoice.documentId }],
        invoiceId: invoice.id,
        siteId: invoice.siteId,
        providerId: invoice.providerId,
      });
      exceptions.push(ex);
      result.exceptionIds.push(ex.id);
    }

    if (!match) {
      const ex = makeException({
        type: EXCEPTION_TYPES.NO_CONTRACT_RATE,
        severity: SEVERITY.MEDIUM,
        title: `Line ${line.lineNo}: no contracted rate found for ${line.serviceCode}`,
        detail: 'The charge cannot be checked until a matching contract service is on file.',
        evidence: [{ kind: 'invoice_line', ref: lineRef, documentId: invoice.documentId }],
        invoiceId: invoice.id,
        siteId: invoice.siteId,
        providerId: invoice.providerId,
      });
      exceptions.push(ex);
      result.exceptionIds.push(ex.id);
      result.status = 'unverifiable';
      lineResults.push(result);
      continue;
    }

    const contractRate = match.service.rate;
    const kind = match.service.billing; // 'per_lift' | 'per_tonne' | 'fixed'

    let lineExplainedQty = 0;
    if (kind === 'per_lift') {
      // Each invoice item names a ticket and the lifts billed for it. Problems are priced at the
      // billed rate. The rate difference on supported lifts is priced separately (rate check below),
      // so the per-item impacts plus the rate impact add up exactly to the line variance.
      const items = line.items || [];
      const seen = new Map();
      for (const it of items) seen.set(it.ticketNo, [...(seen.get(it.ticketNo) || []), it]);
      let explainedQty = 0;
      let expectedQty = 0;
      const common = { invoiceId: invoice.id, siteId: invoice.siteId, providerId: invoice.providerId };
      const lineEv = { kind: 'invoice_line', ref: lineRef, documentId: invoice.documentId };

      for (const [ref, group] of seen) {
        const billedQty = group.reduce((s, it) => s + it.quantity, 0);
        const t = ticketByNo.get(ref);
        const push = (fields, qty) => {
          explainedQty += qty;
          const ex = makeException({ ...common, financialImpact: round2(qty * line.unitRate), ...fields });
          exceptions.push(ex);
          result.exceptionIds.push(ex.id);
        };
        if (!t || t.siteId !== invoice.siteId) {
          push({
            type: EXCEPTION_TYPES.UNKNOWN_TICKET,
            severity: SEVERITY.HIGH,
            title: `Ticket ${ref} billed but not in the collection register`,
            detail: `Invoice line ${line.lineNo} bills ${billedQty} lifts against ticket ${ref}. No collection record for this site has that number.`,
            evidence: [lineEv],
          }, billedQty);
          continue;
        }
        const tEv = { kind: 'collection_ticket', ref: t.id, ticketNo: t.ticketNo, documentId: t.documentId };
        if (t.status !== 'collected') {
          push({
            type: EXCEPTION_TYPES.BILLED_NOT_COLLECTED,
            severity: SEVERITY.HIGH,
            title: `Ticket ${ref} billed but recorded as not collected`,
            detail: `Ticket ${ref} (${t.date}) records "${t.note || 'not collected'}" with ${t.containers} lifts. The invoice bills ${billedQty} lifts against it.`,
            evidence: [lineEv, tEv],
          }, billedQty);
          continue;
        }
        result.matchedRecords.push({ ...tEv, quantity: t.containers });
        expectedQty += t.containers;
        if (group.length > 1) {
          const dupQty = billedQty - group[0].quantity;
          push({
            type: EXCEPTION_TYPES.DUPLICATE_BILLING,
            severity: SEVERITY.HIGH,
            title: `Ticket ${ref} billed ${group.length} times`,
            detail: `Ticket ${ref} (${t.date}, ${t.containers} lifts) appears ${group.length} times on invoice line ${line.lineNo}. A ticket can only be billed once.`,
            evidence: [lineEv, tEv],
          }, dupQty);
        }
        const overQty = group[0].quantity - t.containers;
        if (overQty !== 0) {
          push({
            type: EXCEPTION_TYPES.QUANTITY_MISMATCH,
            severity: overQty > 0 ? SEVERITY.HIGH : SEVERITY.LOW,
            title: `Ticket ${ref}: ${group[0].quantity} ${line.unit}s billed, ${t.containers} recorded`,
            detail: `The collection ticket records ${t.containers} containers lifted on ${t.date}.`,
            evidence: [lineEv, tEv],
          }, overQty);
        }
      }

      // Collected tickets in period that the invoice did not bill (informational).
      const unbilled = tickets.filter(
        (t) => t.siteId === invoice.siteId && t.providerId === invoice.providerId &&
          t.serviceCode === line.serviceCode && t.status === 'collected' &&
          inPeriod(t.date, invoice.period) && !seen.has(t.ticketNo)
      );
      for (const t of unbilled) {
        const ex = makeException({
          type: EXCEPTION_TYPES.UNBILLED_COLLECTION,
          severity: SEVERITY.LOW,
          title: `Ticket ${t.ticketNo} collected but not billed`,
          detail: `Collection on ${t.date} is in the register but not on this invoice. It may show up on a later invoice.`,
          evidence: [{ kind: 'collection_ticket', ref: t.id, ticketNo: t.ticketNo, documentId: t.documentId }],
          invoiceId: invoice.id, siteId: invoice.siteId, providerId: invoice.providerId,
        });
        exceptions.push(ex);
        result.exceptionIds.push(ex.id);
      }

      lineExplainedQty = explainedQty;
      result.expected = { quantity: expectedQty, unitRate: contractRate, amount: round2(expectedQty * contractRate) };
    } else if (kind === 'per_tonne') {
      // Supported tonnage = weight records for valid, collected tickets in this period for this stream.
      // If the invoice lists tickets, only weights for those collected tickets count.
      const billedRefs = invoice.lines.flatMap((l) => (l.items || []).map((it) => it.ticketNo));
      const refSet = new Set(billedRefs.filter((r) => ticketByNo.get(r)?.status === 'collected'));
      const recs = weights.filter(
        (w) => w.siteId === invoice.siteId && w.stream === match.service.stream &&
          inPeriod(w.date, invoice.period) && (refSet.size === 0 || refSet.has(w.ticketNo))
      );
      const byBasis = { verified: 0, reported: 0, estimated: 0 };
      for (const w of recs) {
        byBasis[weightBasis(w)] += w.netKg;
        result.matchedRecords.push({ kind: 'weight_record', ref: w.id, ticketNo: w.ticketNo, documentId: w.documentId, quantity: round3(w.netKg / 1000), basis: weightBasis(w) });
      }
      // Only verified and provider-reported weights support a disposal charge. Estimates never do.
      const supportedT = round3((byBasis.verified + byBasis.reported) / 1000);
      result.expected = { quantity: supportedT, unitRate: contractRate, amount: round2(supportedT * contractRate) };
      result.weightBasis = {
        verifiedT: round3(byBasis.verified / 1000),
        reportedT: round3(byBasis.reported / 1000),
        estimatedT: round3(byBasis.estimated / 1000),
      };
      const tolerance = match.service.toleranceT ?? 0.02;
      if (line.quantity - supportedT > tolerance) {
        const over = round3(line.quantity - supportedT);
        const ex = makeException({
          type: EXCEPTION_TYPES.WEIGHT_UNSUPPORTED,
          severity: SEVERITY.HIGH,
          title: `${over.toFixed(3)} t billed with no weight records behind it`,
          detail: `Invoice bills ${line.quantity.toFixed(3)} t. Weight records for billable collections add up to ${supportedT.toFixed(3)} t (${result.weightBasis.verifiedT.toFixed(3)} t weighbridge-verified, ${result.weightBasis.reportedT.toFixed(3)} t provider-reported).`,
          financialImpact: round2(over * line.unitRate),
          evidence: [
            { kind: 'invoice_line', ref: lineRef, documentId: invoice.documentId },
            ...recs.map((w) => ({ kind: 'weight_record', ref: w.id, ticketNo: w.ticketNo, documentId: w.documentId })),
          ],
          invoiceId: invoice.id, siteId: invoice.siteId, providerId: invoice.providerId,
        });
        exceptions.push(ex);
        result.exceptionIds.push(ex.id);
      }
    } else {
      // Fixed monthly fee.
      result.expected = { quantity: line.quantity, unitRate: contractRate, amount: round2(line.quantity * contractRate) };
    }

    // Rate check (all billing kinds).
    if (Math.abs(line.unitRate - contractRate) > 0.005) {
      const qtyForRate = result.expected.quantity;
      const ex = makeException({
        type: EXCEPTION_TYPES.RATE_MISMATCH,
        severity: SEVERITY.MEDIUM,
        title: `Line ${line.lineNo}: unit rate ${line.unitRate.toFixed(2)} vs contracted ${contractRate.toFixed(2)}`,
        detail: `Contract ${match.contract.id} sets ${line.serviceCode} at ${contractRate.toFixed(2)} per ${match.service.unit}. Invoice charges ${line.unitRate.toFixed(2)}.`,
        financialImpact: round2(qtyForRate * (line.unitRate - contractRate)),
        evidence: [
          { kind: 'invoice_line', ref: lineRef, documentId: invoice.documentId },
          { kind: 'contract', ref: `${match.contract.id} §${match.service.clause || match.service.serviceCode}`, documentId: match.contract.documentId },
        ],
        invoiceId: invoice.id, siteId: invoice.siteId, providerId: invoice.providerId,
      });
      exceptions.push(ex);
      result.exceptionIds.push(ex.id);
    }

    // Line-level quantity check for lift lines. Per-ticket exceptions above usually explain it in full.
    // Anything they don't explain (e.g. a line total that differs from its items) is the residual.
    if (kind === 'per_lift' && line.quantity !== result.expected.quantity) {
      const diff = line.quantity - result.expected.quantity;
      const residual = diff - lineExplainedQty;
      const ex = makeException({
        type: EXCEPTION_TYPES.QUANTITY_MISMATCH,
        severity: SEVERITY.HIGH,
        title: `Line ${line.lineNo}: ${line.quantity} ${line.unit}s billed, ${result.expected.quantity} supported by collection tickets`,
        detail: residual === 0
          ? `${Math.abs(diff)} ${diff > 0 ? 'more' : 'fewer'} lifts billed than the register supports. The ticket-level exceptions on this line account for all of it.`
          : `${Math.abs(diff)} ${diff > 0 ? 'more' : 'fewer'} lifts billed than the register supports. ${Math.abs(residual)} of them are not explained by any listed ticket.`,
        financialImpact: round2(residual * line.unitRate),
        grossImpact: round2(diff * line.unitRate),
        evidence: [
          { kind: 'invoice_line', ref: lineRef, documentId: invoice.documentId },
          ...result.matchedRecords,
        ],
        invoiceId: invoice.id, siteId: invoice.siteId, providerId: invoice.providerId,
        rollup: residual === 0, // summary row only; its causes are already listed
      });
      exceptions.push(ex);
      result.exceptionIds.push(ex.id);
    }

    result.variance = round2(line.amount - result.expected.amount);
    if (Math.abs(result.variance) > 0.005) result.status = 'discrepancy';
    lineResults.push(result);
  }

  const billedTotal = round2(invoice.lines.reduce((s, l) => s + l.amount, 0));
  const expectedTotal = round2(lineResults.reduce((s, r) => s + (r.expected?.amount || 0), 0));
  return {
    invoiceId: invoice.id,
    siteId: invoice.siteId,
    providerId: invoice.providerId,
    period: invoice.period,
    documentIds: invoiceDocs,
    lines: lineResults,
    exceptions,
    totals: {
      billed: billedTotal,
      supported: expectedTotal,
      variance: round2(billedTotal - expectedTotal),
      currency: invoice.currency || 'GBP',
    },
    status: exceptions.some((e) => e.severity !== SEVERITY.LOW) ? 'exceptions' : 'reconciled',
  };
}

// ---------- anomaly detection on the register ----------

/** Scheduled collection days that have no ticket of any status. */
export function detectMissingCollections({ schedules, tickets, period }) {
  const out = [];
  for (const s of schedules) {
    if (s.effectiveFrom && period.to < s.effectiveFrom) continue;
    for (const d of datesBetween(period.from, period.to)) {
      if (!s.days.includes(weekdayOf(d))) continue;
      if (s.effectiveFrom && d < s.effectiveFrom) continue;
      const found = tickets.some((t) => t.siteId === s.siteId && t.serviceCode === s.serviceCode && t.date === d);
      if (!found) {
        out.push(makeException({
          type: EXCEPTION_TYPES.MISSING_COLLECTION,
          severity: SEVERITY.MEDIUM,
          title: `No collection record for scheduled ${s.serviceCode} on ${d}`,
          detail: `Schedule ${s.id} expects a ${s.days.join('/')} collection. No ticket (collected or missed) is on file for ${weekdayOf(d)} ${d}. Ask the provider for the ticket or a missed-collection note.`,
          evidence: [{ kind: 'schedule', ref: s.id }],
          siteId: s.siteId,
          providerId: s.providerId,
          date: d,
        }));
      }
    }
  }
  return out;
}

/** Same ticket number entered more than once, or two entries for the same site/service/date. */
export function detectDuplicateRecords(tickets) {
  const out = [];
  const byNo = new Map();
  const byKey = new Map();
  for (const t of tickets) {
    byNo.set(t.ticketNo, [...(byNo.get(t.ticketNo) || []), t]);
    const k = `${t.siteId}|${t.serviceCode}|${t.date}`;
    byKey.set(k, [...(byKey.get(k) || []), t]);
  }
  const flagged = new Set();
  for (const [no, group] of byNo) {
    if (group.length < 2) continue;
    group.forEach((t) => flagged.add(t.id));
    out.push(makeException({
      type: EXCEPTION_TYPES.DUPLICATE_RECORD,
      severity: SEVERITY.MEDIUM,
      title: `Ticket number ${no} is in the register ${group.length} times`,
      detail: `Records ${group.map((t) => t.id).join(', ')} share one ticket number. Keep one and archive the rest.`,
      evidence: group.map((t) => ({ kind: 'collection_ticket', ref: t.id, ticketNo: t.ticketNo, documentId: t.documentId })),
      siteId: group[0].siteId,
      providerId: group[0].providerId,
    }));
  }
  for (const [, group] of byKey) {
    if (group.length < 2 || group.every((t) => flagged.has(t.id))) continue;
    out.push(makeException({
      type: EXCEPTION_TYPES.DUPLICATE_RECORD,
      severity: SEVERITY.LOW,
      title: `${group.length} tickets for ${group[0].serviceCode} on ${group[0].date}`,
      detail: 'Two or more tickets have different numbers but the same site, service and date. This could be an extra lift or a double entry.',
      evidence: group.map((t) => ({ kind: 'collection_ticket', ref: t.id, ticketNo: t.ticketNo, documentId: t.documentId })),
      siteId: group[0].siteId,
      providerId: group[0].providerId,
    }));
  }
  return out;
}

/**
 * Robust outlier test per site+stream using the modified z-score (median absolute deviation).
 * A flag means "review this", not "this is wrong".
 */
export function detectWeightOutliers(weights, { threshold = 3.5, minSamples = 5 } = {}) {
  const out = [];
  const groups = new Map();
  for (const w of weights) {
    if (weightBasis(w) === BASIS.ESTIMATED) continue; // estimates are not measurements
    const k = `${w.siteId}|${w.stream}`;
    groups.set(k, [...(groups.get(k) || []), w]);
  }
  for (const [, group] of groups) {
    if (group.length < minSamples) continue;
    const vals = group.map((w) => w.netKg);
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    if (!mad) continue;
    for (const w of group) {
      const z = (0.6745 * (w.netKg - med)) / mad;
      if (Math.abs(z) > threshold) {
        out.push(makeException({
          type: EXCEPTION_TYPES.WEIGHT_OUTLIER,
          severity: SEVERITY.LOW,
          title: `${w.stream} weight ${w.netKg.toLocaleString('en-GB')} kg on ${w.date} is unusual for this site`,
          detail: `Site median is ${Math.round(med).toLocaleString('en-GB')} kg over ${group.length} ${weightBasis(w)} records (modified z-score ${z.toFixed(1)}). Check for an event, a combined lift or a keying error.`,
          evidence: [{ kind: 'weight_record', ref: w.id, ticketNo: w.ticketNo, documentId: w.documentId }],
          siteId: w.siteId,
          date: w.date,
          metrics: { netKg: w.netKg, medianKg: med, zScore: round2(z), sampleSize: group.length },
        }));
      }
    }
  }
  return out;
}

/** Extracted documents with fields below the confidence threshold go to a reviewer. */
export function detectLowConfidence(extractions, threshold = 0.9) {
  return extractions
    .filter((x) => x.fields.some((f) => f.confidence < threshold))
    .map((x) => makeException({
      type: EXCEPTION_TYPES.LOW_CONFIDENCE_EXTRACTION,
      severity: SEVERITY.LOW,
      title: `${x.documentId}: ${x.fields.filter((f) => f.confidence < threshold).length} field(s) need human review`,
      detail: x.fields.filter((f) => f.confidence < threshold).map((f) => `${f.label} read as "${f.value}" (${Math.round(f.confidence * 100)}% confidence)`).join('; '),
      evidence: [{ kind: 'document', ref: x.documentId, documentId: x.documentId }],
      siteId: x.siteId,
    }));
}

// ---------- trend analysis ----------

/**
 * Totals of recorded weight grouped by any of: siteId, stream, providerId, month.
 * Every row splits the total by basis and lists its record IDs, so totals can be traced.
 * Verified, reported and estimated tonnage are never merged into one unlabelled number.
 */
export function aggregateWeights(weights, groupBy = ['siteId']) {
  const rows = new Map();
  for (const w of weights) {
    const keyObj = {};
    for (const g of groupBy) keyObj[g] = g === 'month' ? w.date.slice(0, 7) : w[g];
    const key = JSON.stringify(keyObj);
    if (!rows.has(key)) rows.set(key, { ...keyObj, verifiedKg: 0, reportedKg: 0, estimatedKg: 0, records: 0, recordIds: [] });
    const r = rows.get(key);
    r[`${weightBasis(w)}Kg`] += w.netKg;
    r.records += 1;
    r.recordIds.push(w.id);
  }
  return [...rows.values()].map((r) => ({
    ...r,
    measuredKg: r.verifiedKg + r.reportedKg,
    verifiedShare: r.records ? round3(r.verifiedKg / (r.verifiedKg + r.reportedKg + r.estimatedKg || 1)) : 0,
  }));
}

/** Month-over-month change in measured weight (verified + reported), with no estimates. */
export function measuredTrend(weights, { siteId, stream } = {}) {
  const filtered = weights.filter((w) => (!siteId || w.siteId === siteId) && (!stream || w.stream === stream));
  const rows = aggregateWeights(filtered, ['month']).sort((a, b) => a.month.localeCompare(b.month));
  return rows.map((r, i) => {
    const prev = rows[i - 1];
    return {
      month: r.month,
      measuredKg: r.measuredKg,
      verifiedKg: r.verifiedKg,
      reportedKg: r.reportedKg,
      estimatedKg: r.estimatedKg,
      changePct: prev && prev.measuredKg ? round2(((r.measuredKg - prev.measuredKg) / prev.measuredKg) * 100) : null,
      recordIds: r.recordIds,
    };
  });
}

// ---------- reporting ----------

/**
 * Builds an exception report from reconciliation results and anomaly findings.
 * The report is structured data. Renderers (dashboard, CSV, Bedrock narrative) consume it.
 */
export function buildExceptionReport({ title, generatedAt, period, reconciliations = [], anomalies = [], lookups = {} }) {
  const all = [...reconciliations.flatMap((r) => r.exceptions), ...anomalies];
  const open = all.filter((e) => e.status === 'open');
  // Roll-up rows restate their causes, so they are left out of the financial total.
  const disputed = round2(open.filter((e) => !e.rollup && e.financialImpact > 0).reduce((s, e) => s + e.financialImpact, 0));
  const bySeverity = { high: 0, medium: 0, low: 0 };
  open.forEach((e) => (bySeverity[e.severity] += 1));
  return {
    title,
    generatedAt,
    period,
    summary: {
      invoicesChecked: reconciliations.length,
      billedTotal: round2(reconciliations.reduce((s, r) => s + r.totals.billed, 0)),
      supportedTotal: round2(reconciliations.reduce((s, r) => s + r.totals.supported, 0)),
      netVariance: round2(reconciliations.reduce((s, r) => s + r.totals.variance, 0)),
      disputedAmount: disputed,
      openExceptions: open.length,
      bySeverity,
    },
    methodology: [
      'Lift charges are checked against collection tickets in the register. Only tickets marked "collected" support a charge, and each ticket can be billed once.',
      'Disposal (per-tonne) charges are checked against weight records linked to billable tickets. Weighbridge tickets with a stored document count as verified. Provider-reported weights are accepted but labelled. Volume-based estimates never support a charge.',
      'Unit rates are compared with the contract service in force on the last day of the invoice period.',
      'Unusual weights are flagged with a median-absolute-deviation test (modified z-score above 3.5, at least 5 measured records). A flag asks for review and is not a finding of error.',
      'The disputed amount adds up positive financial impacts of open per-item exceptions. Summary rows are not added again.',
    ],
    exceptions: open.map((e) => ({
      ...e,
      siteName: lookups.sites?.[e.siteId]?.name,
      providerName: lookups.providers?.[e.providerId]?.name,
    })),
    reconciliations,
  };
}

export function reportToCSV(report) {
  const head = ['exception_id', 'type', 'severity', 'site', 'provider', 'invoice', 'title', 'financial_impact', 'evidence'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = report.exceptions.map((e) => [
    e.id, e.type, e.severity, e.siteName || e.siteId, e.providerName || e.providerId || '', e.invoiceId || '',
    e.title, e.rollup ? '' : e.financialImpact.toFixed(2),
    e.evidence.map((x) => x.ticketNo || x.ref).join(' | '),
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}

/**
 * Plain-language explanation built only from engine output.
 * Production calls Bedrock with the same payload (see backend/lib/bedrock.js). This template is
 * the fallback and the offline demo, and it shows the facts the model may use.
 */
export function explainReconciliation(rec, lookups = {}) {
  const site = lookups.sites?.[rec.siteId]?.name || rec.siteId;
  const prov = lookups.providers?.[rec.providerId]?.name || rec.providerId;
  const money = (n) => `£${Math.abs(n).toFixed(2)}`;
  const parts = [];
  if (rec.totals.variance === 0 && rec.exceptions.every((e) => e.severity === SEVERITY.LOW)) {
    parts.push(`${prov} invoice ${rec.invoiceId} for ${site} matches the collection register and contract rates.`);
  } else {
    parts.push(`${prov} invoice ${rec.invoiceId} for ${site} bills ${money(rec.totals.billed)}. The records support ${money(rec.totals.supported)}, a difference of ${money(rec.totals.variance)}${rec.totals.variance < 0 ? ' under-billed' : ''}.`);
  }
  const causes = rec.exceptions.filter((e) => !e.rollup && e.severity !== SEVERITY.LOW);
  for (const e of causes) parts.push(`${e.title}${e.financialImpact ? ` (${money(e.financialImpact)})` : ''}.`);
  return parts.join(' ');
}
