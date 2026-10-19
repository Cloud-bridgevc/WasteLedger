import { buildPortfolio, lookupsFor, FOOD_ESTIMATE, PLANTED_ISSUES } from '../core/demo-data.js';
import { runPortfolioChecks } from '../core/pipeline.js';
import { aggregateWeights, weightBasis, explainReconciliation, reportToCSV, buildExceptionReport, round2, round3 } from '../core/engine.js';

// ---------- data ----------
const RUN_AT = '2026-10-05T02:00:00Z'; // the fictional nightly run this view shows
const data = buildPortfolio();
const L = lookupsFor(data);
const { reconciliations, anomalies } = runPortfolioChecks(data, { generatedAt: RUN_AT, lookups: L });
const recById = new Map(reconciliations.map((r) => [r.invoiceId, r]));
const invById = new Map(data.invoices.map((i) => [i.id, i]));
const ticketByNo = new Map(data.tickets.map((t) => [t.ticketNo, t]));
const weightById = new Map(data.weights.map((w) => [w.id, w]));
const weightByTicket = new Map(data.weights.map((w) => [w.ticketNo, w]));
const allExceptions = [...reconciliations.flatMap((r) => r.exceptions), ...anomalies];
const reviewable = allExceptions.filter((e) => !e.rollup);
const MONTHS = ['2026-07', '2026-08', '2026-09'];
const monthName = (m) => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// Which invoice line billed each ticket.
const billedOn = new Map();
for (const inv of data.invoices) for (const l of inv.lines) for (const it of l.items || []) {
  billedOn.set(it.ticketNo, [...(billedOn.get(it.ticketNo) || []), { invoiceId: inv.id, lineNo: l.lineNo, quantity: it.quantity }]);
}

// Reviewer decisions stay in this browser only (demo). Production writes them to exception_events.
const STORE_KEY = 'wasteledger.exceptionDecisions.v1';
let decisions = {};
try { decisions = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { decisions = {}; }
const statusOf = (e) => decisions[e.id]?.status || 'open';
function decide(id, status, note) {
  decisions[id] = { status, note: note ?? decisions[id]?.note ?? '', at: new Date().toISOString() };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(decisions)); } catch { /* storage unavailable */ }
}

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const t3 = (kg) => `${(kg / 1000).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`;
const kgf = (kg) => `${Math.round(kg).toLocaleString('en-GB')} kg`;
const fdate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const siteName = (id) => L.sites[id]?.name || id;
const provName = (id) => L.providers[id]?.name || id;
const uniq = (a) => [...new Set(a)];
const SEV_CHIP = { high: ['chip-bad', '✕'], medium: ['chip-warn', '!'], low: ['chip-info', 'i'] };
const STATUS_CHIP = { open: ['chip-bad', '●', 'Open'], disputed: ['chip-warn', '↗', 'Raised with provider'], resolved: ['chip-ok', '✓', 'Resolved'], accepted: ['chip-muted', '–', 'Accepted'] };
const TYPE_LABEL = {
  duplicate_billing: 'Duplicate billing', billed_not_collected: 'Billed, not collected', unknown_ticket_reference: 'Unknown ticket',
  rate_mismatch: 'Rate mismatch', quantity_mismatch: 'Quantity mismatch', weight_not_supported_by_records: 'Unsupported weight',
  line_arithmetic_error: 'Arithmetic error', no_contract_rate: 'No contract rate', collected_not_billed: 'Collected, not billed',
  missing_collection_record: 'Missing collection', duplicate_register_entry: 'Duplicate record', unusual_weight: 'Unusual weight',
  low_confidence_extraction: 'Needs human review',
};
const sevChip = (s) => `<span class="chip ${SEV_CHIP[s][0]}">${SEV_CHIP[s][1]} ${s}</span>`;
const statusChip = (st) => `<span class="chip ${STATUS_CHIP[st][0]}">${STATUS_CHIP[st][1]} ${STATUS_CHIP[st][2]}</span>`;
const basisTag = (b) => `<span class="basis basis-${b}">${b}</span>`;
const options = (list, sel, all = 'All') => `<option value="">${all}</option>` + list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

function download(name, type, body) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openExceptions() {
  return reviewable.filter((e) => statusOf(e) === 'open');
}
function disputedAmount(list = reviewable) {
  return round2(list.filter((e) => ['open', 'disputed'].includes(statusOf(e)) && e.financialImpact > 0).reduce((s, e) => s + e.financialImpact, 0));
}

// ---------- chart: measured (stacked verified + reported) beside estimated (hatched), per category ----------
let chartSeq = 0;
function basisChart(rows, { height = 240, labelOf = (r) => r.label } = {}) {
  chartSeq += 1;
  const id = `hatch-${chartSeq}`;
  const W = 720, H = height, padL = 52, padB = 34, padT = 12, padR = 8;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.verifiedKg + r.reportedKg, r.estimatedKg)));
  const nice = niceMax(max / 1000) * 1000;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const colW = plotW / rows.length;
  const hasEst = rows.some((r) => r.estimatedKg > 0);
  const barW = Math.min(44, colW * (hasEst ? 0.32 : 0.5));
  const y = (kg) => padT + plotH - (kg / nice) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice);
  const bar = (x, top, bottom, cls, rounded = true, style = '') => {
    const h = bottom - top;
    if (h <= 0.5) return '';
    const r = rounded ? Math.min(4, h, barW / 2) : 0;
    // Flat at the baseline, rounded data end.
    return `<path class="${cls}" ${style} d="M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${bottom} Z"/>`;
  };
  const cols = rows.map((r, i) => {
    const cx = padL + colW * i + colW / 2;
    const mx = hasEst ? cx - barW - 1 : cx - barW / 2;
    const ex = cx + 1;
    const base = y(0);
    const vTop = y(r.verifiedKg);
    const rTop = y(r.verifiedKg + r.reportedKg);
    const gap = r.verifiedKg && r.reportedKg ? 2 : 0; // surface gap between stacked segments
    const tip = `<b>${esc(labelOf(r))}</b><br>Verified: <b>${t3(r.verifiedKg)}</b><br>Reported: <b>${t3(r.reportedKg)}</b>${hasEst ? `<br>Estimated (not measured): <b>${t3(r.estimatedKg)}</b>` : ''}<br>${r.records} records`;
    return `<g class="col">
      ${bar(mx, vTop, base, 'bar bar-verified', !r.reportedKg)}
      ${bar(mx, rTop, vTop - gap, 'bar bar-reported')}
      ${hasEst ? bar(ex, y(r.estimatedKg), base, 'bar bar-estimated', true, `style="fill:url(#${id})"`) : ''}
      <text x="${cx}" y="${H - 12}" text-anchor="middle">${esc(labelOf(r))}</text>
      <rect class="hit" x="${padL + colW * i}" y="${padT}" width="${colW}" height="${plotH}" data-tip="${esc(tip)}"/>
    </g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Recorded weight by evidence basis">
    <defs><pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--surface)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--basis-estimated)" stroke-width="2"/></pattern></defs>
    <g class="grid">${ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${(t / 1000).toLocaleString('en-GB')} t</text>`).join('')}</g>
    ${cols}
  </svg>`;
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v || 1));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
const legend = (withEst = true) => `<div class="legend">${basisTag('verified')} Weighbridge, document held ${basisTag('reported')} Provider-reported ${withEst ? `${basisTag('estimated')} Volume estimate, never added to measured totals` : ''}</div>`;

function wireTips(root) {
  const tip = $('#tip');
  root.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = t.dataset.tip;
    tip.hidden = false;
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  root.addEventListener('mouseleave', () => { tip.hidden = true; });
}

// ---------- drawer ----------
function openDrawer(title, html) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-back').hidden = false;
  $('#drawer-close').focus();
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-back').hidden = true;
}

function excFor(pred) {
  return reviewable.filter((e) => e.evidence.some(pred));
}

function showTicket(ticketNo) {
  const t = ticketByNo.get(ticketNo);
  if (!t) {
    const ex = excFor((x) => x.ticketNo === ticketNo || x.ref?.includes(ticketNo));
    return openDrawer(`Ticket ${ticketNo}`, `<p>No collection record with this number is in the register.</p>${ex.map(excHTML).join('')}`);
  }
  const dupes = data.tickets.filter((x) => x.ticketNo === ticketNo);
  const w = weightByTicket.get(ticketNo);
  const bills = billedOn.get(ticketNo) || [];
  const ex = excFor((x) => x.ticketNo === ticketNo);
  openDrawer(`Collection ticket ${ticketNo}`, `
    <dl class="kv">
      <dt>Status</dt><dd>${t.status === 'collected' ? '<span class="chip chip-ok">✓ Collected</span>' : '<span class="chip chip-warn">! Not collected</span>'}</dd>
      <dt>Date</dt><dd>${fdate(t.date)}</dd>
      <dt>Site</dt><dd>${esc(siteName(t.siteId))}</dd>
      <dt>Provider</dt><dd>${esc(provName(t.providerId))}</dd>
      <dt>Service</dt><dd>${esc(t.serviceCode)} · ${esc(t.stream)}</dd>
      <dt>Containers lifted</dt><dd>${t.containers} of ${t.scheduledContainers} scheduled</dd>
      ${t.note ? `<dt>Driver note</dt><dd>${esc(t.note)}</dd>` : ''}
      <dt>Captured by</dt><dd>${t.source === 'textract' ? 'Document extraction' : 'Manual entry'}${dupes.length > 1 ? ` · <span class="chip chip-warn">! ${dupes.length} register entries</span>` : ''}</dd>
    </dl>
    <p class="sub-h">Source document</p>
    <div class="docbox"><span class="mono">${esc(t.documentId)}</span><span class="muted">s3://wasteledger-documents/…/${esc(t.documentId)}.pdf</span></div>
    <p class="sub-h">Weight record</p>
    ${w ? weightBlock(w) : '<p class="muted" style="margin:0">No weight recorded for this ticket.</p>'}
    <p class="sub-h">Billed on</p>
    ${bills.length ? bills.map((b) => `<div class="docbox"><span><a href="#" data-open-invoice="${b.invoiceId}">${esc(b.invoiceId)}</a> line ${b.lineNo}</span><span>${b.quantity} billed</span></div>`).join('') : '<p class="muted" style="margin:0">Not on any invoice in this period.</p>'}
    ${ex.length ? `<p class="sub-h">Exceptions</p>${ex.map(excHTML).join('')}` : ''}`);
}

function weightBlock(w) {
  const b = weightBasis(w);
  return `<div class="docbox" style="display:grid;gap:4px;justify-content:stretch">
    <div style="display:flex;justify-content:space-between;gap:10px"><strong>${kgf(w.netKg)}</strong>${basisTag(b)}</div>
    <span class="muted">${w.method === 'weighbridge' ? `Weighbridge slip ${esc(w.documentId)} · ${esc(w.weighbridge)}` : w.method === 'on-board' ? 'On-board vehicle weight supplied by the provider. Not independently checked.' : `Estimate: ${esc(w.estimateMethod)}. ${esc(FOOD_ESTIMATE.source)}`}</span>
  </div>`;
}

function showWeight(id) {
  const w = weightById.get(id);
  const ex = excFor((x) => x.ref === id);
  openDrawer(`Weight record ${id}`, `
    <dl class="kv">
      <dt>Date</dt><dd>${fdate(w.date)}</dd>
      <dt>Site</dt><dd>${esc(siteName(w.siteId))}</dd>
      <dt>Stream</dt><dd>${esc(w.stream)}</dd>
      <dt>Ticket</dt><dd><a href="#" data-open-ticket="${w.ticketNo}" class="mono">${esc(w.ticketNo)}</a></dd>
    </dl>
    ${weightBlock(w)}
    ${ex.length ? `<p class="sub-h">Exceptions</p>${ex.map(excHTML).join('')}` : ''}`);
}

function showInvoice(id) {
  const inv = invById.get(id);
  const rec = recById.get(id);
  const c = data.contracts.find((x) => x.id === inv.contractId);
  openDrawer(`Invoice ${id}`, `
    <dl class="kv">
      <dt>Provider</dt><dd>${esc(provName(inv.providerId))}</dd>
      <dt>Site</dt><dd>${esc(siteName(inv.siteId))}</dd>
      <dt>Period</dt><dd>${fdate(inv.period.from)} to ${fdate(inv.period.to)}</dd>
      <dt>Contract</dt><dd><a href="#" data-open-contract="${c.id}">${esc(c.id)}</a></dd>
      <dt>Result</dt><dd>${rec.totals.variance ? `<span class="chip chip-bad">✕ ${gbp(rec.totals.variance)} not supported</span>` : '<span class="chip chip-ok">✓ Reconciled</span>'}</dd>
    </dl>
    <div class="explain">${esc(explainReconciliation(rec, L))}<span class="src">Generated from the reconciliation results only. In production, Amazon Bedrock writes this summary from the same facts and must cite record IDs.</span></div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th>Line</th><th class="r">Billed</th><th class="r">Supported</th><th class="r">Variance</th></tr></thead><tbody>
      ${rec.lines.map((l) => `<tr data-line-detail="${l.lineNo}"><td><strong>${l.lineNo}. ${esc(l.serviceCode)}</strong><br><span class="muted num" style="font-size:12px">${fmtQ(l.billed.quantity, l.unit)} × ${l.billed.unitRate.toFixed(2)} · supported ${fmtQ(l.expected?.quantity ?? 0, l.unit)} × ${(l.expected?.unitRate ?? 0).toFixed(2)}</span>${l.weightBasis ? `<br><span class="muted" style="font-size:12px">${l.weightBasis.verifiedT.toFixed(3)} t verified · ${l.weightBasis.reportedT.toFixed(3)} t reported</span>` : ''}</td>
        <td class="r">${gbp(l.billed.amount)}</td><td class="r">${gbp(l.expected?.amount ?? 0)}</td><td class="r" style="font-weight:700;color:${l.variance ? 'var(--bad)' : 'inherit'}">${l.variance ? gbp(l.variance) : '—'}</td></tr>`).join('')}
      <tr><td><strong>Total</strong></td><td class="r"><strong>${gbp(rec.totals.billed)}</strong></td><td class="r"><strong>${gbp(rec.totals.supported)}</strong></td><td class="r"><strong>${rec.totals.variance ? gbp(rec.totals.variance) : '—'}</strong></td></tr>
    </tbody></table></div>
    <p class="sub-h">Matched records</p>
    <div class="exc-row" style="display:flex;flex-wrap:wrap;gap:6px">${rec.lines.flatMap((l) => l.matchedRecords).map(pill).join('')}</div>
    ${rec.exceptions.length ? `<p class="sub-h">Exceptions</p>${rec.exceptions.map((e) => excHTML(e)).join('')}` : ''}
    <p class="sub-h">Source document</p>
    <div class="docbox"><span class="mono">${esc(inv.documentId)}</span><span class="muted">Issued ${fdate(inv.issueDate)}</span></div>`);
}
const fmtQ = (q, unit) => (unit === 'tonne' ? `${q.toFixed(3)} t` : `${q}`);

function showContract(id) {
  const c = data.contracts.find((x) => x.id === id);
  openDrawer(`Contract ${id}`, `
    <dl class="kv">
      <dt>Title</dt><dd>${esc(c.title)}</dd>
      <dt>Provider</dt><dd>${esc(provName(c.providerId))}</dd>
      <dt>Term</dt><dd>${fdate(c.effectiveFrom)} to ${fdate(c.effectiveTo)}</dd>
      <dt>Sites</dt><dd>${c.siteIds.map(siteName).map(esc).join('<br>')}</dd>
    </dl>
    <table class="t"><thead><tr><th>Clause</th><th>Service</th><th class="r">Rate</th></tr></thead><tbody>
      ${c.services.map((s) => `<tr><td>§${s.clause}</td><td>${esc(s.serviceCode)}<br><span class="muted" style="font-size:12px">${esc(s.stream || s.description || '')}${s.container ? ` · ${esc(s.container)}` : ''}</span></td><td class="r">${gbp(s.rate)} / ${s.unit}</td></tr>`).join('')}
    </tbody></table>
    <div class="docbox"><span class="mono">${esc(c.documentId)}</span><span class="muted">Signed contract PDF</span></div>
    <p class="note">Rates are fictional and illustrative.</p>`);
}

function pill(x) {
  const label = x.ticketNo || x.ref;
  const attr = x.kind === 'collection_ticket' || (x.ticketNo && x.kind !== 'weight_record') ? `data-open-ticket="${esc(x.ticketNo)}"`
    : x.kind === 'weight_record' ? `data-open-weight="${esc(x.ref)}"`
    : x.kind === 'invoice_line' ? `data-open-invoice="${esc(x.ref.split(' line ')[0])}"`
    : x.kind === 'contract' ? `data-open-contract="${esc(x.ref.split(' ')[0])}"` : '';
  const kindLabel = { collection_ticket: 'Ticket', weight_record: 'Weight', invoice_line: 'Invoice', contract: 'Contract', schedule: 'Schedule', document: 'Document' }[x.kind] || '';
  return `<span class="ev-pill" ${attr} title="${esc(kindLabel)}">${esc(kindLabel ? kindLabel + ' ' : '')}${esc(label)}</span>`;
}

function excHTML(e, { actions = false } = {}) {
  const st = statusOf(e);
  const d = decisions[e.id];
  return `<article class="exc sev-${e.severity}" data-exc="${e.id}">
    <div class="top-row"><div><div class="ttl">${esc(e.title)}</div><div class="meta">${esc(e.id)} · ${esc(TYPE_LABEL[e.type] || e.type)} · ${esc(siteName(e.siteId))}${e.providerId ? ` · ${esc(provName(e.providerId))}` : ''}</div></div>
      ${e.financialImpact && !e.rollup ? `<span class="impact">${gbp(e.financialImpact)}</span>` : ''}</div>
    <div class="dt">${esc(e.detail)}</div>
    <div class="row">${sevChip(e.severity)} ${e.rollup ? '<span class="chip chip-muted">Summary row</span>' : statusChip(st)} ${e.evidence.slice(0, 10).map(pill).join('')}${e.evidence.length > 10 ? `<span class="muted" style="font-size:12px">+${e.evidence.length - 10} more</span>` : ''}</div>
    ${d?.note ? `<div class="meta">Note: ${esc(d.note)}</div>` : ''}
    ${actions && !e.rollup ? `<div class="exc-actions">
      ${st !== 'disputed' ? `<button class="btn btn-ghost btn-sm" data-decide="disputed">Raise with provider</button>` : ''}
      ${st !== 'resolved' ? `<button class="btn btn-ghost btn-sm" data-decide="resolved">Mark resolved</button>` : ''}
      ${st !== 'accepted' ? `<button class="btn btn-ghost btn-sm" data-decide="accepted">Accept as valid</button>` : ''}
      ${st !== 'open' ? `<button class="btn btn-ghost btn-sm" data-decide="open">Reopen</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-note>Add note</button>
    </div>` : ''}
  </article>`;
}

// ---------- views ----------
const views = {};

views.portfolio = () => {
  const collected = data.tickets.filter((t) => t.status === 'collected');
  const uniqCollected = uniq(collected.map((t) => t.ticketNo));
  const agg = aggregateWeights(data.weights, []).at(0);
  const billed = round2(reconciliations.reduce((s, r) => s + r.totals.billed, 0));
  const monthly = MONTHS.map((m) => ({ label: monthName(m), ...emptyAgg(), ...aggregateWeights(data.weights.filter((w) => w.date.startsWith(m)), []).at(0) }));
  const open = openExceptions();
  const top = [...open].sort((a, b) => (b.financialImpact || 0) - (a.financialImpact || 0)).slice(0, 5);
  return {
    title: 'Portfolio',
    sub: `${data.sites.length} sites · ${data.providers.length} providers · ${fdate(data.period.from)} to ${fdate(data.period.to)}`,
    html: `
    <div class="kpis">
      <div class="kpi"><span class="lab">Collections recorded</span><span class="val">${uniqCollected.length}</span><button class="ev" data-ev="collections">From ${uniqCollected.length} collection tickets</button></div>
      <div class="kpi"><span class="lab">Measured weight</span><span class="val">${t3(agg.measuredKg)}</span><button class="ev" data-ev="measured">${t3(agg.verifiedKg)} verified · ${t3(agg.reportedKg)} reported</button></div>
      <div class="kpi"><span class="lab">Estimated weight <small>(not measured)</small></span><span class="val">${t3(agg.estimatedKg)}</span><button class="ev" data-ev="estimated">Food waste, volume × assumed density</button></div>
      <div class="kpi"><span class="lab">Invoices checked</span><span class="val">${reconciliations.length}</span><button class="ev" data-ev="invoices">${gbp(billed)} billed</button></div>
      <div class="kpi alert"><span class="lab">Amount in query</span><span class="val">${gbp(disputedAmount())}</span><button class="ev" data-ev="exceptions">${open.length} open exceptions</button></div>
    </div>
    <div class="grid-2">
      <section class="card"><header><div><h2>Recorded weight by month</h2><p>Measured weights are stacked by basis. Estimates are shown separately and never added to measured totals.</p></div></header>
        <div class="body">${basisChart(monthly)}${legend()}</div></section>
      <section class="card"><header><div><h2>Largest open exceptions</h2><p>By amount, then severity</p></div><a class="btn btn-ghost btn-sm" href="#exceptions">Review all</a></header>
        <div class="exc-list">${top.map((e) => excHTML(e)).join('') || '<div class="empty">No open exceptions.</div>'}</div></section>
    </div>
    <section class="card"><header><div><h2>Sites</h2><p>Recorded activity per site for the period</p></div><a class="btn btn-ghost btn-sm" href="#locations">Compare locations</a></header>
      <div class="body sites">${data.sites.map(siteCard).join('')}</div></section>`,
  };
};

function emptyAgg() { return { verifiedKg: 0, reportedKg: 0, estimatedKg: 0, measuredKg: 0, records: 0, recordIds: [] }; }

function siteStats(siteId, weights = data.weights) {
  const ts = data.tickets.filter((t) => t.siteId === siteId);
  const nos = uniq(ts.filter((t) => t.status === 'collected').map((t) => t.ticketNo));
  const lifts = uniq(ts.filter((t) => t.status === 'collected').map((t) => t.ticketNo)).reduce((s, no) => s + ticketByNo.get(no).containers, 0);
  const a = { ...emptyAgg(), ...aggregateWeights(weights.filter((w) => w.siteId === siteId), []).at(0) };
  const recs = reconciliations.filter((r) => r.siteId === siteId);
  const exc = reviewable.filter((e) => e.siteId === siteId);
  return {
    collections: nos.length, lifts, missed: ts.filter((t) => t.status !== 'collected').length, ...a,
    billed: round2(recs.reduce((s, r) => s + r.totals.billed, 0)),
    inQuery: disputedAmount(exc),
    open: exc.filter((e) => statusOf(e) === 'open').length,
  };
}

function siteCard(s) {
  const st = siteStats(s.id);
  return `<button class="site-card" data-site="${s.id}">
    <span class="type">${esc(s.type)}</span>
    <h3>${esc(s.name)}</h3>
    <dl>
      <dt>Collections</dt><dd>${st.collections}</dd>
      <dt>Measured</dt><dd>${t3(st.measuredKg)}</dd>
      <dt>Estimated</dt><dd>${st.estimatedKg ? t3(st.estimatedKg) : '—'}</dd>
      <dt>Billed</dt><dd>${gbp(st.billed)}</dd>
      <dt>In query</dt><dd style="color:${st.inQuery ? 'var(--bad)' : 'inherit'}">${gbp(st.inQuery)}</dd>
      <dt>Open exceptions</dt><dd>${st.open}</dd>
    </dl>
  </button>`;
}

// Generic filter + table view
function tableView({ key, filters, rows, columns, onRow, rowClass, pageSize = 60, extra = '' }) {
  const state = (tableView.state[key] ||= { f: {}, n: pageSize });
  const f = state.f;
  const filtered = rows.filter((r) => filters.every((flt) => !f[flt.id] || flt.test(r, f[flt.id])));
  const shown = filtered.slice(0, state.n);
  return {
    html: `<section class="card" data-table="${key}">
      <div class="filters">${filters.map((flt) => flt.type === 'search'
        ? `<label>${esc(flt.label)}<input type="search" data-f="${flt.id}" value="${esc(f[flt.id] || '')}" placeholder="${esc(flt.placeholder || '')}"></label>`
        : `<label>${esc(flt.label)}<select data-f="${flt.id}">${options(flt.options, f[flt.id])}</select></label>`).join('')}
        <span class="grow">${filtered.length} of ${rows.length} records</span></div>
      ${extra}
      <div class="tbl-wrap"><table class="t"><thead><tr>${columns.map((c) => `<th class="${c.r ? 'r' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((r, i) => `<tr data-row="${i}" class="${rowClass ? rowClass(r) : ''}">${columns.map((c) => `<td class="${c.r ? 'r' : ''}">${c.v(r)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="empty">No records match these filters.</td></tr>`}</tbody></table></div>
      ${filtered.length > shown.length ? `<div class="more"><button class="btn btn-ghost btn-sm" data-more>Show ${Math.min(pageSize, filtered.length - shown.length)} more</button></div>` : ''}
    </section>`,
    wire(root) {
      const card = $(`[data-table="${key}"]`, root);
      $$('[data-f]', card).forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => {
        f[el.dataset.f] = el.value.trim();
        state.n = pageSize;
        const pos = el.selectionStart;
        render();
        const again = $(`[data-table="${key}"] [data-f="${el.dataset.f}"]`);
        if (again) { again.focus(); if (again.tagName === 'INPUT') again.setSelectionRange(pos, pos); }
      }));
      $('[data-more]', card)?.addEventListener('click', () => { state.n += pageSize; render(); });
      $('tbody', card).addEventListener('click', (e) => {
        if (e.target.closest('[data-open-ticket],[data-open-invoice],[data-open-weight]')) return;
        const tr = e.target.closest('tr[data-row]');
        if (tr) onRow(shown[Number(tr.dataset.row)]);
      });
    },
  };
}
tableView.state = {};

const siteOpts = () => data.sites.map((s) => [s.id, s.name]);
const provOpts = () => data.providers.map((p) => [p.id, p.name]);
const streamOpts = () => uniq(data.schedules.map((s) => s.stream)).map((s) => [s, s]);
const monthOpts = () => MONTHS.map((m) => [m, monthName(m)]);

views.collections = () => {
  const tv = tableView({
    key: 'collections',
    rows: [...data.tickets].sort((a, b) => b.date.localeCompare(a.date) || a.siteId.localeCompare(b.siteId)),
    filters: [
      { id: 'q', label: 'Ticket', type: 'search', placeholder: 'e.g. NG-558295', test: (r, v) => r.ticketNo.toLowerCase().includes(v.toLowerCase()) },
      { id: 'site', label: 'Site', options: siteOpts(), test: (r, v) => r.siteId === v },
      { id: 'prov', label: 'Provider', options: provOpts(), test: (r, v) => r.providerId === v },
      { id: 'stream', label: 'Stream', options: streamOpts(), test: (r, v) => r.stream === v },
      { id: 'month', label: 'Month', options: monthOpts(), test: (r, v) => r.date.startsWith(v) },
      { id: 'status', label: 'Status', options: [['collected', 'Collected'], ['not_collected', 'Not collected']], test: (r, v) => r.status === v },
    ],
    columns: [
      { h: 'Date', v: (r) => fdate(r.date) },
      { h: 'Ticket', v: (r) => `<span class="mono">${esc(r.ticketNo)}</span>` },
      { h: 'Site', v: (r) => esc(siteName(r.siteId)) },
      { h: 'Provider', v: (r) => esc(provName(r.providerId)) },
      { h: 'Stream', v: (r) => esc(r.stream) },
      { h: 'Lifted', r: true, v: (r) => `${r.containers} / ${r.scheduledContainers}` },
      { h: 'Status', v: (r) => (r.status === 'collected' ? '<span class="chip chip-ok">✓ Collected</span>' : '<span class="chip chip-warn">! Not collected</span>') },
      { h: 'Billed on', v: (r) => (billedOn.get(r.ticketNo) || []).map((b) => `<a href="#" class="mono" data-open-invoice="${b.invoiceId}">${b.invoiceId}</a>`).join(' ') || '<span class="muted">—</span>' },
      { h: 'Captured', v: (r) => (r.source === 'manual' ? 'Manual' : 'Extracted') },
    ],
    rowClass: (r) => (excFor((x) => x.ticketNo === r.ticketNo).some((e) => e.severity === 'high') ? 'flag' : excFor((x) => x.ticketNo === r.ticketNo).length ? 'flag-warn' : ''),
    onRow: (r) => showTicket(r.ticketNo),
  });
  const missing = anomalies.filter((e) => e.type === 'missing_collection_record');
  return {
    title: 'Collection register',
    sub: 'Every collection ticket from every provider. Flagged rows have open exceptions.',
    actions: `<button class="btn btn-ghost btn-sm" data-export="collections">Export CSV</button>`,
    html: tv.html + (missing.length ? `<section class="card"><header><div><h2>Scheduled collections with no ticket</h2><p>The schedule expected a collection on these days. Nothing is on file.</p></div></header><div class="exc-list">${missing.map((e) => excHTML(e)).join('')}</div></section>` : ''),
    wire: tv.wire,
  };
};

views.weights = () => {
  const st = (tableView.state.weights ||= { f: {}, n: 60 }).f;
  const filt = data.weights.filter((w) => (!st.site || w.siteId === st.site) && (!st.stream || w.stream === st.stream) && (!st.basis || weightBasis(w) === st.basis) && (!st.month || w.date.startsWith(st.month)));
  const monthly = MONTHS.map((m) => ({ label: monthName(m), ...emptyAgg(), ...aggregateWeights(filt.filter((w) => w.date.startsWith(m)), []).at(0) }));
  const outlierIds = new Set(anomalies.filter((e) => e.type === 'unusual_weight').map((e) => e.evidence[0].ref));
  const tv = tableView({
    key: 'weights',
    rows: [...data.weights].sort((a, b) => b.date.localeCompare(a.date)),
    filters: [
      { id: 'site', label: 'Site', options: siteOpts(), test: (r, v) => r.siteId === v },
      { id: 'stream', label: 'Stream', options: streamOpts(), test: (r, v) => r.stream === v },
      { id: 'basis', label: 'Basis', options: [['verified', 'Verified'], ['reported', 'Reported'], ['estimated', 'Estimated']], test: (r, v) => weightBasis(r) === v },
      { id: 'month', label: 'Month', options: monthOpts(), test: (r, v) => r.date.startsWith(v) },
    ],
    extra: `<div class="body">${basisChart(monthly, { height: 200 })}${legend()}<p class="note">The chart follows the filters above. ${filt.some((w) => weightBasis(w) === 'estimated') ? `Estimates use ${FOOD_ESTIMATE.litresPerBin} L × assumed ${FOOD_ESTIMATE.assumedKgPerLitre} kg/L. ${FOOD_ESTIMATE.source}` : ''}</p></div>`,
    columns: [
      { h: 'Date', v: (r) => fdate(r.date) },
      { h: 'Record', v: (r) => `<span class="mono">${r.id}</span>` },
      { h: 'Ticket', v: (r) => `<a href="#" class="mono" data-open-ticket="${r.ticketNo}">${r.ticketNo}</a>` },
      { h: 'Site', v: (r) => esc(siteName(r.siteId)) },
      { h: 'Stream', v: (r) => esc(r.stream) },
      { h: 'Net weight', r: true, v: (r) => `${kgf(r.netKg)}${outlierIds.has(r.id) ? ' <span class="chip chip-info">i Unusual</span>' : ''}` },
      { h: 'Basis', v: (r) => basisTag(weightBasis(r)) },
      { h: 'Source', v: (r) => (r.documentId ? `<span class="mono">${r.documentId}</span>` : r.method === 'on-board' ? 'Provider feed' : 'Calculated') },
    ],
    rowClass: (r) => (outlierIds.has(r.id) ? 'flag-warn' : ''),
    onRow: (r) => showWeight(r.id),
  });
  return { title: 'Waste weight records', sub: 'Each weight shows how it was captured. Totals keep measured and estimated weights apart.', actions: `<button class="btn btn-ghost btn-sm" data-export="weights">Export CSV</button>`, html: tv.html, wire: tv.wire };
};

views.providers = () => ({
  title: 'Service providers',
  sub: 'Contractors, the streams they collect, and how they capture weight',
  html: `<div class="grid-3">${data.providers.map((p) => {
    const cs = data.contracts.filter((c) => c.providerId === p.id);
    const sites = uniq(cs.flatMap((c) => c.siteIds));
    const recs = reconciliations.filter((r) => r.providerId === p.id);
    const exc = reviewable.filter((e) => e.providerId === p.id);
    const bases = uniq(data.weights.filter((w) => w.providerId === p.id).map(weightBasis));
    return `<section class="card"><header><div><h2>${esc(p.name)}</h2><p>${esc(p.licence)}</p></div></header>
      <div class="body" style="display:grid;gap:12px">
        <dl class="kv" style="grid-template-columns:120px 1fr">
          <dt>Streams</dt><dd>${p.streams.map(esc).join(', ')}</dd>
          <dt>Weighing</dt><dd>${esc(p.weighing)}<div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">${bases.map(basisTag).join('')}</div></dd>
          <dt>Sites</dt><dd>${sites.map(siteName).map(esc).join('<br>')}</dd>
          <dt>Contracts</dt><dd>${cs.map((c) => `<a href="#" data-open-contract="${c.id}">${c.id}</a>`).join('<br>')}</dd>
          <dt>Invoices</dt><dd>${recs.length} · ${gbp(recs.reduce((s, r) => s + r.totals.billed, 0))}</dd>
          <dt>In query</dt><dd style="color:${disputedAmount(exc) ? 'var(--bad)' : 'inherit'}">${gbp(disputedAmount(exc))} · ${exc.filter((e) => statusOf(e) === 'open').length} open</dd>
          <dt>Accounts</dt><dd class="mono">${esc(p.contact)}</dd>
        </dl>
      </div></section>`;
  }).join('')}</div>`,
});

views.library = () => {
  const tv = tableView({
    key: 'invoices',
    rows: [...data.invoices].sort((a, b) => b.period.from.localeCompare(a.period.from) || a.siteId.localeCompare(b.siteId)),
    filters: [
      { id: 'q', label: 'Invoice', type: 'search', placeholder: 'e.g. INV-NGW-24117', test: (r, v) => r.id.toLowerCase().includes(v.toLowerCase()) },
      { id: 'site', label: 'Site', options: siteOpts(), test: (r, v) => r.siteId === v },
      { id: 'prov', label: 'Provider', options: provOpts(), test: (r, v) => r.providerId === v },
      { id: 'month', label: 'Month', options: monthOpts(), test: (r, v) => r.period.from.startsWith(v) },
    ],
    columns: [
      { h: 'Invoice', v: (r) => `<span class="mono">${r.id}</span>` },
      { h: 'Provider', v: (r) => esc(provName(r.providerId)) },
      { h: 'Site', v: (r) => esc(siteName(r.siteId)) },
      { h: 'Period', v: (r) => monthName(r.period.from.slice(0, 7)) },
      { h: 'Lines', r: true, v: (r) => r.lines.length },
      { h: 'Total', r: true, v: (r) => gbp(r.total) },
      { h: 'Check', v: (r) => (recById.get(r.id).totals.variance ? '<span class="chip chip-bad">✕ Query</span>' : '<span class="chip chip-ok">✓ Reconciled</span>') },
      { h: 'Document', v: (r) => `<span class="mono">${r.documentId}</span>` },
    ],
    onRow: (r) => showInvoice(r.id),
  });
  return {
    title: 'Contracts & invoices',
    sub: 'Signed agreements with their rate schedules, and every invoice received',
    html: `<section class="card"><header><div><h2>Contracts</h2><p>The rate in force on the last day of an invoice period is the one checked</p></div></header>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Contract</th><th>Provider</th><th>Term</th><th>Sites</th><th>Services</th></tr></thead><tbody>
      ${data.contracts.map((c) => `<tr data-contract="${c.id}"><td><span class="mono">${c.id}</span><br><span class="muted" style="font-size:12px">${esc(c.title)}</span></td><td>${esc(provName(c.providerId))}</td><td>${fdate(c.effectiveFrom)} – ${fdate(c.effectiveTo)}</td><td class="r">${c.siteIds.length}</td><td>${c.services.map((s) => `${esc(s.serviceCode)} <span class="muted num">${gbp(s.rate)}/${s.unit}</span>`).join('<br>')}</td></tr>`).join('')}
      </tbody></table></div></section>
      <h2 style="margin:6px 0 -8px;font-size:15px">Invoices</h2>${tv.html}`,
    wire(root) {
      tv.wire(root);
      $$('[data-contract]', root).forEach((tr) => tr.addEventListener('click', () => showContract(tr.dataset.contract)));
    },
  };
};

views.reconciliation = () => {
  const billed = round2(reconciliations.reduce((s, r) => s + r.totals.billed, 0));
  const supported = round2(reconciliations.reduce((s, r) => s + r.totals.supported, 0));
  const withVar = reconciliations.filter((r) => r.totals.variance !== 0);
  const tv = tableView({
    key: 'recon',
    rows: [...reconciliations].sort((a, b) => Math.abs(b.totals.variance) - Math.abs(a.totals.variance) || b.period.from.localeCompare(a.period.from)),
    filters: [
      { id: 'res', label: 'Result', options: [['query', 'Query'], ['ok', 'Reconciled']], test: (r, v) => (v === 'query' ? r.totals.variance !== 0 : r.totals.variance === 0) },
      { id: 'site', label: 'Site', options: siteOpts(), test: (r, v) => r.siteId === v },
      { id: 'prov', label: 'Provider', options: provOpts(), test: (r, v) => r.providerId === v },
      { id: 'month', label: 'Month', options: monthOpts(), test: (r, v) => r.period.from.startsWith(v) },
    ],
    columns: [
      { h: 'Invoice', v: (r) => `<span class="mono">${r.invoiceId}</span>` },
      { h: 'Site', v: (r) => esc(siteName(r.siteId)) },
      { h: 'Provider', v: (r) => esc(provName(r.providerId)) },
      { h: 'Period', v: (r) => monthName(r.period.from.slice(0, 7)) },
      { h: 'Billed', r: true, v: (r) => gbp(r.totals.billed) },
      { h: 'Supported', r: true, v: (r) => gbp(r.totals.supported) },
      { h: 'Variance', r: true, v: (r) => (r.totals.variance ? `<strong style="color:var(--bad)">${gbp(r.totals.variance)}</strong>` : '—') },
      { h: 'Exceptions', r: true, v: (r) => r.exceptions.filter((e) => !e.rollup).length || '—' },
      { h: 'Result', v: (r) => (r.totals.variance ? '<span class="chip chip-bad">✕ Query</span>' : '<span class="chip chip-ok">✓ Reconciled</span>') },
    ],
    rowClass: (r) => (r.totals.variance ? 'flag' : ''),
    onRow: (r) => showInvoice(r.invoiceId),
  });
  return {
    title: 'Reconciliation',
    sub: `Last scheduled run ${new Date(RUN_AT).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC · ${reconciliations.length} invoices`,
    html: `<div class="kpis">
      <div class="kpi"><span class="lab">Invoices checked</span><span class="val">${reconciliations.length}</span></div>
      <div class="kpi"><span class="lab">Billed</span><span class="val">${gbp(billed)}</span></div>
      <div class="kpi"><span class="lab">Supported by records</span><span class="val">${gbp(supported)}</span></div>
      <div class="kpi alert"><span class="lab">Not supported</span><span class="val">${gbp(billed - supported)}</span></div>
      <div class="kpi"><span class="lab">Invoices in query</span><span class="val">${withVar.length} <small>of ${reconciliations.length}</small></span></div>
    </div>${tv.html}`,
    wire: tv.wire,
  };
};

views.exceptions = () => {
  const st = (tableView.state.exc ||= { f: { status: 'open' } }).f;
  const list = reviewable
    .filter((e) => (!st.status || statusOf(e) === st.status) && (!st.sev || e.severity === st.sev) && (!st.type || e.type === st.type) && (!st.site || e.siteId === st.site))
    .sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity) || (b.financialImpact || 0) - (a.financialImpact || 0));
  const counts = Object.fromEntries(['open', 'disputed', 'resolved', 'accepted'].map((s) => [s, reviewable.filter((e) => statusOf(e) === s).length]));
  return {
    title: 'Exception review',
    sub: 'Charges and records that need a decision. Each one links to the records behind it.',
    actions: `<button class="btn btn-ghost btn-sm" data-export="exceptions">Export CSV</button>`,
    html: `<section class="card">
      <div class="filters">
        <label>Status<select data-ef="status">${options([['open', `Open (${counts.open})`], ['disputed', `Raised with provider (${counts.disputed})`], ['resolved', `Resolved (${counts.resolved})`], ['accepted', `Accepted (${counts.accepted})`]], st.status)}</select></label>
        <label>Severity<select data-ef="sev">${options([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], st.sev)}</select></label>
        <label>Type<select data-ef="type">${options(uniq(reviewable.map((e) => e.type)).map((t) => [t, TYPE_LABEL[t] || t]), st.type)}</select></label>
        <label>Site<select data-ef="site">${options(siteOpts(), st.site)}</select></label>
        <span class="grow">${list.length} shown · ${gbp(disputedAmount(list))} in query</span>
      </div>
      <div class="exc-list">${list.map((e) => excHTML(e, { actions: true })).join('') || '<div class="empty">Nothing here. Try another status.</div>'}</div>
      <p class="note" style="padding:0 18px 16px">In this demo, decisions are saved in your browser only. In production they are written to the exception history in PostgreSQL with the reviewer's name.</p>
    </section>`,
    wire(root) {
      $$('[data-ef]', root).forEach((el) => el.addEventListener('change', () => { st[el.dataset.ef] = el.value; render(); }));
      $$('[data-decide]', root).forEach((b) => b.addEventListener('click', () => { decide(b.closest('[data-exc]').dataset.exc, b.dataset.decide); render(); }));
      $$('[data-note]', root).forEach((b) => b.addEventListener('click', () => {
        const id = b.closest('[data-exc]').dataset.exc;
        const e = reviewable.find((x) => x.id === id);
        openDrawer(`Note on ${id}`, `${excHTML(e)}<label style="display:grid;gap:6px;font-weight:650;font-size:13px">Note<textarea class="note-in" id="note-in">${esc(decisions[id]?.note || '')}</textarea></label><div><button class="btn btn-primary btn-sm" id="note-save">Save note</button></div>`);
        $('#note-save').onclick = () => { decide(id, statusOf(e), $('#note-in').value.trim()); closeDrawer(); render(); };
      }));
    },
  };
};

views.locations = () => {
  const st = (tableView.state.loc ||= { stream: '' });
  const ws = data.weights.filter((w) => !st.stream || w.stream === st.stream);
  const rows = data.sites.map((s) => ({ site: s, ...siteStats(s.id, ws) }));
  const liftsFor = (siteId) => uniq(data.tickets.filter((t) => t.siteId === siteId && t.status === 'collected' && (!st.stream || t.stream === st.stream)).map((t) => t.ticketNo)).reduce((a, no) => a + ticketByNo.get(no).containers, 0);
  const measuredLifts = (siteId) => uniq(ws.filter((w) => w.siteId === siteId && weightBasis(w) !== 'estimated').map((w) => w.ticketNo)).reduce((a, no) => a + ticketByNo.get(no).containers, 0);
  const chartRows = rows.map((r) => ({ label: r.site.city, ...emptyAgg(), ...aggregateWeights(ws.filter((w) => w.siteId === r.site.id), []).at(0) }));
  const streams = uniq(data.schedules.map((s) => s.stream));
  return {
    title: 'Location comparison',
    sub: 'Recorded activity side by side. Site size is shown for context and is not used to adjust the figures.',
    html: `<section class="card"><header><div><h2>Recorded weight by site</h2><p>${fdate(data.period.from)} to ${fdate(data.period.to)}${st.stream ? ` · ${esc(st.stream)}` : ' · all streams'}</p></div>
      <div class="segmented" role="group" aria-label="Stream">${[['', 'All'], ...streams.map((s) => [s, s])].map(([v, l]) => `<button data-stream="${esc(v)}" aria-pressed="${st.stream === v}">${esc(l)}</button>`).join('')}</div></header>
      <div class="body">${basisChart(chartRows)}${legend(chartRows.some((r) => r.estimatedKg))}</div></section>
    <section class="card"><header><div><h2>Comparison table</h2><p>Kg per lift uses measured weights only, divided by lifts that have a measured weight.</p></div></header>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Site</th><th>Type</th><th class="r">Size</th><th class="r">Collections</th><th class="r">Lifts</th><th class="r">Verified</th><th class="r">Reported</th><th class="r">Estimated</th><th class="r">Measured kg / lift</th><th class="r">Billed</th><th class="r">In query</th></tr></thead><tbody>
      ${rows.map((r) => {
        const ml = measuredLifts(r.site.id);
        return `<tr data-site="${r.site.id}"><td><strong>${esc(r.site.name)}</strong></td><td>${esc(r.site.type)}</td>
        <td class="r">${r.site.rooms ? `${r.site.rooms} rooms` : r.site.units ? `${r.site.units} units` : `${r.site.buildings} buildings`}</td>
        <td class="r">${r.collections}</td><td class="r">${liftsFor(r.site.id)}</td>
        <td class="r">${r.verifiedKg ? t3(r.verifiedKg) : '—'}</td><td class="r">${r.reportedKg ? t3(r.reportedKg) : '—'}</td><td class="r">${r.estimatedKg ? t3(r.estimatedKg) : '—'}</td>
        <td class="r">${ml ? Math.round(r.measuredKg / ml) : '—'}</td><td class="r">${gbp(r.billed)}</td><td class="r" style="color:${r.inQuery ? 'var(--bad)' : 'inherit'}">${gbp(r.inQuery)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="note" style="padding:0 18px 16px">Collections, lifts, billed and in-query columns cover all streams. Weight columns follow the stream filter.</p></section>`,
    wire(root) {
      $$('[data-stream]', root).forEach((b) => b.addEventListener('click', () => { st.stream = b.dataset.stream; render(); }));
      $$('tr[data-site]', root).forEach((tr) => tr.addEventListener('click', () => { (tableView.state.collections ||= { f: {}, n: 60 }).f.site = tr.dataset.site; location.hash = 'collections'; }));
    },
  };
};

// Reports
function activityRows(siteFilter, monthFilter) {
  const out = [];
  for (const s of data.sites) {
    if (siteFilter && s.id !== siteFilter) continue;
    for (const stream of uniq(data.schedules.filter((x) => x.siteId === s.id).map((x) => x.stream))) {
      const ts = data.tickets.filter((t) => t.siteId === s.id && t.stream === stream && (!monthFilter || t.date.startsWith(monthFilter)));
      const nos = uniq(ts.map((t) => t.ticketNo));
      const ws = data.weights.filter((w) => w.siteId === s.id && w.stream === stream && (!monthFilter || w.date.startsWith(monthFilter)));
      const a = { ...emptyAgg(), ...aggregateWeights(ws, []).at(0) };
      out.push({ site: s.name, stream, tickets: nos.length, collected: nos.filter((n) => ticketByNo.get(n).status === 'collected').length, notCollected: nos.filter((n) => ticketByNo.get(n).status !== 'collected').length, verifiedT: round3(a.verifiedKg / 1000), reportedT: round3(a.reportedKg / 1000), estimatedT: round3(a.estimatedKg / 1000), weightRecords: a.records });
    }
  }
  return out;
}

views.reports = () => {
  const st = (tableView.state.rep ||= { type: 'exceptions', site: '', month: '' });
  const recs = reconciliations.filter((r) => (!st.site || r.siteId === st.site) && (!st.month || r.period.from.startsWith(st.month)));
  const anoms = anomalies.filter((e) => (!st.site || e.siteId === st.site) && (!st.month || !e.date || e.date.startsWith(st.month)));
  const period = st.month ? { from: `${st.month}-01`, to: data.invoices.find((i) => i.period.from.startsWith(st.month)).period.to } : data.period;
  const scope = `${st.site ? siteName(st.site) : 'All sites'} · ${st.month ? monthName(st.month) : `${monthName(MONTHS[0])} to ${monthName(MONTHS.at(-1))}`}`;
  let preview = '';
  let exportCsv;
  let exportJson;
  if (st.type === 'exceptions') {
    const rep = buildExceptionReport({ title: `Exception report · ${scope}`, generatedAt: new Date().toISOString(), period, reconciliations: recs, anomalies: anoms, lookups: L });
    rep.exceptions = rep.exceptions.filter((e) => !e.rollup && ['open', 'disputed'].includes(statusOf(e))).map((e) => ({ ...e, status: statusOf(e), reviewerNote: decisions[e.id]?.note }));
    rep.summary.openExceptions = rep.exceptions.length;
    rep.summary.disputedAmount = round2(rep.exceptions.filter((e) => e.financialImpact > 0).reduce((s, e) => s + e.financialImpact, 0));
    preview = `<h3>${esc(rep.title)}</h3>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
        <div class="kpi"><span class="lab">Invoices</span><span class="val">${rep.summary.invoicesChecked}</span></div>
        <div class="kpi"><span class="lab">Billed</span><span class="val">${gbp(rep.summary.billedTotal)}</span></div>
        <div class="kpi"><span class="lab">Supported</span><span class="val">${gbp(rep.summary.supportedTotal)}</span></div>
        <div class="kpi alert"><span class="lab">In query</span><span class="val">${gbp(rep.summary.disputedAmount)}</span></div>
      </div>
      <div style="display:grid;gap:10px">${rep.exceptions.map((e) => excHTML(e)).join('') || '<div class="empty">No open or raised exceptions in this scope.</div>'}</div>
      <p class="sub-h">Method</p><ol>${rep.methodology.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>`;
    exportCsv = () => reportToCSV(rep);
    exportJson = () => JSON.stringify({ ...rep, reconciliations: rep.reconciliations.map((r) => ({ invoiceId: r.invoiceId, totals: r.totals, lines: r.lines })) }, null, 2);
  } else {
    const rows = activityRows(st.site, st.month);
    const tot = rows.reduce((a, r) => ({ v: a.v + r.verifiedT, r: a.r + r.reportedT, e: a.e + r.estimatedT }), { v: 0, r: 0, e: 0 });
    preview = `<h3>Collection activity and recorded weight · ${esc(scope)}</h3>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Site</th><th>Stream</th><th class="r">Tickets</th><th class="r">Collected</th><th class="r">Not collected</th><th class="r">Verified t</th><th class="r">Reported t</th><th class="r">Estimated t</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.site)}</td><td>${esc(r.stream)}</td><td class="r">${r.tickets}</td><td class="r">${r.collected}</td><td class="r">${r.notCollected || '—'}</td><td class="r">${r.verifiedT ? r.verifiedT.toFixed(3) : '—'}</td><td class="r">${r.reportedT ? r.reportedT.toFixed(3) : '—'}</td><td class="r">${r.estimatedT ? r.estimatedT.toFixed(3) : '—'}</td></tr>`).join('')}
      <tr><td colspan="5"><strong>Totals (kept separate by basis)</strong></td><td class="r"><strong>${tot.v.toFixed(3)}</strong></td><td class="r"><strong>${tot.r.toFixed(3)}</strong></td><td class="r"><strong>${tot.e.toFixed(3)}</strong></td></tr>
      </tbody></table></div>
      ${legend()}
      <p class="note">Measured weight = verified + reported (${(tot.v + tot.r).toFixed(3)} t). Estimated weight (${tot.e.toFixed(3)} t) is calculated from container volume using ${esc(FOOD_ESTIMATE.source.toLowerCase())} It is not a measurement. This report gives recorded quantities only. It does not calculate recycling rates, diversion rates, savings or emissions.</p>`;
    const head = ['site', 'stream', 'tickets', 'collected', 'not_collected', 'verified_t', 'reported_t', 'estimated_t', 'weight_records'];
    exportCsv = () => [head.join(','), ...rows.map((r) => [r.site, r.stream, r.tickets, r.collected, r.notCollected, r.verifiedT, r.reportedT, r.estimatedT, r.weightRecords].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    exportJson = () => JSON.stringify({ title: 'Collection activity and recorded weight', scope, period, generatedAt: new Date().toISOString(), basisDefinitions: { verified: 'Weighbridge slip held', reported: 'Provider-supplied measurement', estimated: `Volume × assumed density. ${FOOD_ESTIMATE.source}` }, rows }, null, 2);
  }
  return {
    title: 'Reports',
    sub: 'Build a report, check the preview, then export it',
    actions: `<button class="btn btn-ghost btn-sm" id="rep-csv">Export CSV</button><button class="btn btn-ghost btn-sm" id="rep-json">Export JSON</button><button class="btn btn-primary btn-sm" onclick="window.print()">Print / PDF</button>`,
    html: `<section class="card">
      <div class="filters">
        <label>Report<select data-rf="type">${[['exceptions', 'Exception report'], ['activity', 'Collection activity & recorded weight']].map(([v, l]) => `<option value="${v}" ${st.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Site<select data-rf="site">${options(siteOpts(), st.site, 'All sites')}</select></label>
        <label>Month<select data-rf="month">${options(monthOpts(), st.month, 'Whole period')}</select></label>
      </div>
      <div class="report-preview">${preview}</div>
    </section>`,
    wire(root) {
      $$('[data-rf]', root).forEach((el) => el.addEventListener('change', () => { st[el.dataset.rf] = el.value; render(); }));
      $('#rep-csv').onclick = () => download(`wasteledger-${st.type}.csv`, 'text/csv', exportCsv());
      $('#rep-json').onclick = () => download(`wasteledger-${st.type}.json`, 'application/json', exportJson());
    },
  };
};

// ---------- exports for list views ----------
function exportList(kind) {
  const csv = (head, rows) => [head.join(','), ...rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  if (kind === 'collections') download('wasteledger-collections.csv', 'text/csv', csv(['date', 'ticket_no', 'site', 'provider', 'service', 'stream', 'containers', 'scheduled', 'status', 'note', 'document_id'], data.tickets.map((t) => [t.date, t.ticketNo, siteName(t.siteId), provName(t.providerId), t.serviceCode, t.stream, t.containers, t.scheduledContainers, t.status, t.note, t.documentId])));
  if (kind === 'weights') download('wasteledger-weights.csv', 'text/csv', csv(['date', 'record_id', 'ticket_no', 'site', 'stream', 'net_kg', 'method', 'basis', 'document_id', 'estimate_method'], data.weights.map((w) => [w.date, w.id, w.ticketNo, siteName(w.siteId), w.stream, w.netKg, w.method, weightBasis(w), w.documentId, w.estimateMethod])));
  if (kind === 'exceptions') download('wasteledger-exceptions.csv', 'text/csv', reportToCSV({ exceptions: reviewable.map((e) => ({ ...e, siteName: siteName(e.siteId), providerName: e.providerId ? provName(e.providerId) : '' })) }));
}

// ---------- router ----------
function render() {
  const key = (location.hash.slice(1) || 'portfolio').split('?')[0];
  const view = (views[key] || views.portfolio)();
  $('#page-title').textContent = view.title;
  $('#page-sub').textContent = view.sub || '';
  $('#top-actions').innerHTML = view.actions || '';
  const root = $('#view');
  root.innerHTML = view.html;
  view.wire?.(root);
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => exportList(b.dataset.export)));
  $$('[data-nav]').forEach((a) => (a.dataset.nav === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const n = openExceptions().length;
  $('#exc-count').textContent = n || '';
  document.title = `${view.title} · WasteLedger`;
}

function wireGlobal() {
  $('#org-name').textContent = data.organisation.name;
  $('#run-info').innerHTML = `Nightly reconciliation<br>${new Date(RUN_AT).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC<br>${PLANTED_ISSUES.length} problems planted in the demo data`;
  window.addEventListener('hashchange', () => { render(); $('#view').focus({ preventScroll: true }); window.scrollTo(0, 0); $('#side').classList.remove('open'); });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open-ticket],[data-open-invoice],[data-open-weight],[data-open-contract],[data-site],[data-ev]');
    if (!t) return;
    if (t.matches('a')) e.preventDefault();
    if (t.dataset.openTicket) return showTicket(t.dataset.openTicket);
    if (t.dataset.openInvoice) return showInvoice(t.dataset.openInvoice);
    if (t.dataset.openWeight) return showWeight(t.dataset.openWeight);
    if (t.dataset.openContract) return showContract(t.dataset.openContract);
    if (t.matches('.site-card')) { (tableView.state.collections ||= { f: {}, n: 60 }).f.site = t.dataset.site; location.hash = 'collections'; return; }
    if (t.dataset.ev) return showEvidence(t.dataset.ev);
  });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-back').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#menu').addEventListener('click', () => { const o = $('#side').classList.toggle('open'); $('#menu').setAttribute('aria-expanded', String(o)); });
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('wasteledger.theme', document.documentElement.dataset.theme); } catch { /* ignore */ }
  });
  try { const t = localStorage.getItem('wasteledger.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
  wireTips(document.body);
}

// The evidence behind each portfolio figure.
function showEvidence(kind) {
  const agg = aggregateWeights(data.weights, ['siteId']);
  if (kind === 'collections') {
    const rows = data.sites.map((s) => [s.name, uniq(data.tickets.filter((t) => t.siteId === s.id && t.status === 'collected').map((t) => t.ticketNo)).length]);
    return openDrawer('Evidence: collections recorded', `<p style="margin:0">Count of distinct collection tickets marked “collected”. Tickets keyed twice count once. Tickets marked “not collected” are left out.</p><table class="t"><tbody>${rows.map(([n, c]) => `<tr><td>${esc(n)}</td><td class="r">${c}</td></tr>`).join('')}</tbody></table><a class="btn btn-ghost btn-sm" href="#collections">Open the register</a>`);
  }
  if (kind === 'measured' || kind === 'estimated') {
    const est = kind === 'estimated';
    return openDrawer(est ? 'Evidence: estimated weight' : 'Evidence: measured weight', `<p style="margin:0">${est ? `Food waste is not weighed. Each figure is bins × ${FOOD_ESTIMATE.litresPerBin} L × assumed ${FOOD_ESTIMATE.assumedKgPerLitre} kg/L. ${esc(FOOD_ESTIMATE.source)} It is never added to measured totals and never supports a charge.` : 'Measured = verified weighbridge records with a stored slip + provider-reported on-board weights. The two are listed separately.'}</p>
      <table class="t"><thead><tr><th>Site</th>${est ? '<th class="r">Estimated</th>' : '<th class="r">Verified</th><th class="r">Reported</th>'}<th class="r">Records</th></tr></thead><tbody>
      ${agg.map((r) => `<tr><td>${esc(siteName(r.siteId))}</td>${est ? `<td class="r">${t3(r.estimatedKg)}</td>` : `<td class="r">${t3(r.verifiedKg)}</td><td class="r">${t3(r.reportedKg)}</td>`}<td class="r">${data.weights.filter((w) => w.siteId === r.siteId && ((weightBasis(w) === 'estimated') === est)).length}</td></tr>`).join('')}</tbody></table>
      <a class="btn btn-ghost btn-sm" href="#weights">Open weight records</a>`);
  }
  if (kind === 'invoices') location.hash = 'reconciliation';
  if (kind === 'exceptions') location.hash = 'exceptions';
}

wireGlobal();
render();
