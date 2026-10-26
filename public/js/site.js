import { buildPortfolio, DEMO_CASE, lookupsFor, CONTRACTS } from '../core/demo-data.js';
import {
  reconcileInvoice, detectMissingCollections, detectWeightOutliers, detectLowConfidence,
  buildExceptionReport, reportToCSV, explainReconciliation, resetExceptionIds, weightBasis,
} from '../core/engine.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const gbp = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// ---------- build the demo case from the shared engine ----------
const data = buildPortfolio();
const lookups = lookupsFor(data);
const invoice = data.invoices.find((i) => i.id === DEMO_CASE.invoiceId);
const month = { from: invoice.period.from, to: invoice.period.to };
const inMonth = (d) => d >= month.from && d <= month.to;
const siteTickets = data.tickets.filter((t) => t.siteId === DEMO_CASE.siteId && t.providerId === DEMO_CASE.providerId && inMonth(t.date));
const gwTickets = siteTickets.filter((t) => t.serviceCode === 'GW-1100-LIFT');
const gwWeights = data.weights.filter((w) => w.siteId === DEMO_CASE.siteId && w.stream === 'General waste' && inMonth(w.date));
const contract = CONTRACTS.find((c) => c.id === invoice.contractId);

resetExceptionIds();
const rec = reconcileInvoice(invoice, data);
const siteSchedules = data.schedules.filter((s) => s.siteId === DEMO_CASE.siteId && s.providerId === DEMO_CASE.providerId);
const missing = detectMissingCollections({ schedules: siteSchedules, tickets: data.tickets, period: month });
const allSiteWeights = data.weights.filter((w) => w.siteId === DEMO_CASE.siteId);
const outliers = detectWeightOutliers(allSiteWeights).filter((e) => inMonth(e.date));
const review = detectLowConfidence(data.extractions.filter((x) => x.siteId === DEMO_CASE.siteId));
const report = buildExceptionReport({
  title: `Exception report: ${lookups.sites[invoice.siteId].name}, September 2026`,
  generatedAt: new Date().toISOString(),
  period: month,
  reconciliations: [rec],
  anomalies: [...missing, ...outliers, ...review],
  lookups,
});

// ---------- hero card ----------
function renderHero() {
  $('#hc-title').textContent = `Invoice ${invoice.id}`;
  $('#hc-meta').textContent = `${lookups.providers[invoice.providerId].name} · ${lookups.sites[invoice.siteId].name}`;
  $('#hc-rows').innerHTML = rec.lines.map((l) => `
    <div class="hc-row ${l.status === 'discrepancy' ? 'bad' : ''}">
      <span>${esc(shortName(l.serviceCode))}</span>
      <span class="chip ${l.status === 'discrepancy' ? 'chip-bad' : 'chip-ok'}">${l.status === 'discrepancy' ? '✕ Query' : '✓ Matched'}</span>
      <span class="amt">${gbp(l.billed.amount)}</span>
    </div>`).join('');
  $('#hc-var').textContent = gbp(rec.totals.variance);
  $('#hc-status').textContent = `${rec.exceptions.filter((e) => !e.rollup && e.severity !== 'low').length} exceptions`;
  $('#hc-status').className = 'chip chip-bad';
  $('#hc-badge').textContent = `Supported by records: ${gbp(rec.totals.supported)}`;
}

function shortName(code) {
  return { 'GW-1100-LIFT': 'General waste lifts', 'GW-DISPOSAL': 'General waste disposal (t)', 'DMR-1100-LIFT': 'Mixed recycling lifts', 'ADMIN-MONTHLY': 'Account fee' }[code] || code;
}

// ---------- documents column ----------
function renderDocs(step) {
  const showStatus = step >= 1;
  const wByTicket = new Map(gwWeights.map((w) => [w.ticketNo, w]));
  const ticketCards = gwTickets.map((t) => {
    const w = wByTicket.get(t.ticketNo);
    return `<div class="doc paper" data-ticket="${t.ticketNo}" data-doc="${t.documentId}">
      <div class="hd"><span>Collection ticket</span><span class="mono">${t.ticketNo}</span></div>
      <table>
        <tr><td>Date</td><td>${fmtDate(t.date)}</td></tr>
        <tr><td>Service</td><td>GW 1100 L</td></tr>
        <tr><td>Lifted</td><td>${t.containers} of ${t.scheduledContainers}</td></tr>
        ${t.note ? `<tr><td colspan="2" style="text-align:left;font-style:italic">“${esc(t.note)}”</td></tr>` : ''}
        ${w ? `<tr data-weight="${w.id}"><td>Weighbridge</td><td>${w.netKg.toLocaleString('en-GB')} kg</td></tr>` : ''}
      </table>
      ${showStatus && t.status !== 'collected' ? '<div style="margin-top:6px"><span class="chip chip-warn">! Not collected</span></div>' : ''}
    </div>`;
  }).join('');

  const missingCards = missing.map((m) => `<div class="doc" data-missing="${m.date}" style="border-style:dashed">
    <div class="row1"><strong>No ticket on file</strong><span class="chip chip-muted">Scheduled</span></div>
    <div class="row2">${fmtDate(m.date)} · GW collection expected</div></div>`).join('');

  const gw = invoice.lines.find((l) => l.serviceCode === 'GW-1100-LIFT');
  const disp = invoice.lines.find((l) => l.serviceCode === 'GW-DISPOSAL');
  const invoiceCard = `<div class="doc paper" data-doc="${invoice.documentId}" data-invoice="1">
    <div class="hd"><span>Invoice</span><span class="mono">${invoice.id}</span></div>
    <table>
      ${invoice.lines.map((l) => `<tr data-line="${l.lineNo}"><td>${l.lineNo}. ${esc(shortName(l.serviceCode))}<br><span style="color:var(--text-3)">${l.quantity} × ${l.unitRate.toFixed(2)}</span></td><td>${l.amount.toFixed(2)}</td></tr>`).join('')}
      <tr><td><strong>Total</strong></td><td><strong>${invoice.total.toFixed(2)}</strong></td></tr>
    </table>
    <details style="margin-top:6px;font-family:var(--font-sans)"><summary style="cursor:pointer;font-size:12px">Line 1 ticket list (${gw.items.length})</summary>
      <table style="margin-top:4px">${gw.items.map((it) => `<tr data-item="${it.ticketNo}"><td class="mono">${it.ticketNo}</td><td>${it.quantity}</td></tr>`).join('')}</table>
    </details>
    <div style="font-size:11px;color:var(--text-3);margin-top:4px;font-family:var(--font-sans)">Line ${disp.lineNo} bills ${disp.quantity.toFixed(3)} t</div>
  </div>`;

  const svc = contract.services;
  const contractCard = `<div class="doc paper" data-doc="${contract.documentId}">
    <div class="hd"><span>Contract</span><span class="mono">${contract.id}</span></div>
    <table>${svc.map((s) => `<tr data-clause="${s.serviceCode}"><td>§${s.clause} ${esc(shortName(s.serviceCode))}</td><td>${s.rate.toFixed(2)}/${s.unit}</td></tr>`).join('')}</table>
  </div>`;

  $('#demo-docs').innerHTML = `
    <h4><span>Invoice</span><span>1</span></h4>${invoiceCard}
    <h4><span>Contract rates</span><span>1</span></h4>${contractCard}
    <h4><span>Collection tickets · GW</span><span>${gwTickets.length}</span></h4>${ticketCards}${step >= 2 ? missingCards : ''}`;
}

function highlight(refs) {
  $$('.doc.hl, tr.hl', $('#demo-docs')).forEach((n) => n.classList.remove('hl'));
  for (const r of refs) {
    if (r.ticketNo) {
      $$(`[data-ticket="${r.ticketNo}"]`).forEach((n) => n.classList.add('hl'));
      $$(`[data-item="${r.ticketNo}"]`).forEach((n) => n.classList.add('hl'));
    }
    if (r.kind === 'invoice_line') {
      const no = r.ref.split(' line ')[1];
      $(`[data-invoice] [data-line="${no}"]`)?.classList.add('hl');
      $('[data-invoice]')?.classList.add('hl');
    }
    if (r.kind === 'contract') $(`[data-doc="${contract.documentId}"]`)?.classList.add('hl');
    if (r.kind === 'schedule') $$('[data-missing]').forEach((n) => n.classList.add('hl'));
  }
  const first = $('#demo-docs .hl');
  if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- stages ----------
function evidencePills(ev) {
  return ev.slice(0, 8).map((x) => `<span class="ev-pill">${esc(x.ticketNo || x.ref)}</span>`).join('') + (ev.length > 8 ? `<span class="ev-pill">+${ev.length - 8} more</span>` : '');
}

function excCard(e) {
  const sev = { high: 'chip-bad', medium: 'chip-warn', low: 'chip-info' }[e.severity];
  const icon = { high: '✕', medium: '!', low: 'i' }[e.severity];
  return `<article class="exc sev-${e.severity}" data-exc="${e.id}" tabindex="0">
    <div class="top"><div class="ttl">${esc(e.title)}</div>${e.financialImpact && !e.rollup ? `<span class="impact">${gbp(e.financialImpact)}</span>` : ''}</div>
    <div class="dt">${esc(e.detail)}</div>
    <div class="ev"><span class="chip ${sev}">${icon} ${e.severity}</span>${evidencePills(e.evidence)}</div>
  </article>`;
}

function stageExtract() {
  const rows = [];
  const exMap = new Map(data.extractions.map((x) => [x.documentId, x]));
  for (const t of gwTickets) {
    const x = exMap.get(t.documentId);
    const fields = x ? x.fields : [
      { label: 'Ticket number', value: t.ticketNo, confidence: 0.99 },
      { label: 'Containers lifted', value: String(t.containers), confidence: 0.97 },
    ];
    const low = fields.filter((f) => f.confidence < 0.9);
    const minConf = Math.min(...fields.map((f) => f.confidence));
    rows.push(`<tr class="clickable" data-hl-ticket="${t.ticketNo}">
      <td><span class="mono">${t.ticketNo}</span><br><span class="muted" style="font-size:12px">Collection ticket</span></td>
      <td>${fmtDate(t.date)}</td>
      <td class="r">${t.containers}</td>
      <td>${conf(minConf)}</td>
      <td>${low.length ? `<span class="chip chip-warn">! Review ${low.length} field${low.length > 1 ? 's' : ''}</span>` : '<span class="chip chip-ok">✓ Accepted</span>'}</td>
    </tr>`);
  }
  const inv = exMap.get(invoice.documentId);
  rows.unshift(`<tr class="clickable" data-hl-invoice="1">
    <td><span class="mono">${invoice.id}</span><br><span class="muted" style="font-size:12px">Invoice · ${invoice.lines.length} lines</span></td>
    <td>${fmtDate(invoice.issueDate)}</td><td class="r">—</td>
    <td>${conf(Math.min(...inv.fields.map((f) => f.confidence)))}</td>
    <td><span class="chip chip-ok">✓ Accepted</span></td></tr>`);
  const lowDoc = data.extractions.find((x) => x.fields.some((f) => f.confidence < 0.9));
  return `
    <h3>1. Extract records from the documents</h3>
    <p class="hint">Amazon Textract reads each document and Bedrock classifies it. Each field keeps its confidence score. Anything under 90% goes to a reviewer before it can support or dispute a charge.</p>
    <table class="t"><thead><tr><th>Document</th><th>Date</th><th class="r">Lifted</th><th>Lowest field confidence</th><th>Status</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <div class="explain" style="background:var(--warn-soft)">
      <strong>Review queue:</strong> ${esc(lowDoc.documentId)}: ${lowDoc.fields.filter((f) => f.confidence < 0.9).map((f) => `${esc(f.label)} read as “${esc(f.value)}” (${Math.round(f.confidence * 100)}%)`).join('; ')}.
      <span class="src">In this demo the reviewer has confirmed the reading, so the ticket is used as recorded: no lift.</span>
    </div>
    <p class="hint" style="margin-top:14px">Weighbridge weights for the six collected tickets come from the transfer station's slips. They are <span class="basis basis-verified">Verified</span></p>
    <div class="stage-actions"><button class="btn btn-primary" data-go="2">Reconcile against the contract →</button></div>`;
}

function conf(c) {
  return `<span class="conf ${c < 0.9 ? 'low' : ''}"><span class="bar"><i style="width:${Math.round(c * 100)}%"></i></span><span class="num">${Math.round(c * 100)}%</span></span>`;
}

function stageReconcile() {
  const causes = rec.exceptions.filter((e) => !e.rollup && e.severity !== 'low');
  return `
    <h3>2. Reconcile the invoice</h3>
    <p class="hint">Each line is checked against collection tickets, weight records and contract ${esc(contract.id)}. Select a line or an exception to highlight the records behind it.</p>
    <div class="totals">
      <div class="tile"><div class="lab">Billed</div><div class="val">${gbp(rec.totals.billed)}</div></div>
      <div class="tile"><div class="lab">Supported by records</div><div class="val">${gbp(rec.totals.supported)}</div></div>
      <div class="tile var"><div class="lab">Not supported</div><div class="val">${gbp(rec.totals.variance)}</div></div>
    </div>
    <table class="t">
      <thead><tr><th>Line</th><th class="r">Billed</th><th class="r hide-sm">Supported</th><th class="r">Variance</th><th>Result</th></tr></thead>
      <tbody>${rec.lines.map((l) => `<tr class="clickable" data-line-row="${l.lineNo}">
        <td><strong>${esc(shortName(l.serviceCode))}</strong><br><span class="muted num" style="font-size:12px">${fmtQty(l.billed.quantity, l.unit)} × ${l.billed.unitRate.toFixed(2)} billed · ${fmtQty(l.expected.quantity, l.unit)} × ${l.expected.unitRate.toFixed(2)} supported</span></td>
        <td class="r">${gbp(l.billed.amount)}</td>
        <td class="r hide-sm">${gbp(l.expected.amount)}</td>
        <td class="r" style="color:${l.variance ? 'var(--bad)' : 'inherit'};font-weight:700">${l.variance ? gbp(l.variance) : '—'}</td>
        <td>${l.status === 'discrepancy' ? '<span class="chip chip-bad">✕ Query</span>' : '<span class="chip chip-ok">✓ Matched</span>'}</td>
      </tr>`).join('')}</tbody>
    </table>
    <div class="exc-list">${causes.map(excCard).join('')}</div>
    <div class="explain"><strong>Summary.</strong> ${esc(explainReconciliation(rec, lookups))}
      <span class="src">Written only from the reconciliation results above. In production, Amazon Bedrock writes this summary from the same facts and must cite the record IDs it uses.</span></div>
    <div class="stage-actions"><button class="btn btn-ghost" data-go="1">← Back</button><button class="btn btn-primary" data-go="3">Prepare the exception report →</button></div>`;
}

function fmtQty(q, unit) {
  return unit === 'tonne' ? `${q.toFixed(3)} t` : `${q}`;
}

function stageReport() {
  const s = report.summary;
  const disp = rec.lines.find((l) => l.serviceCode === 'GW-DISPOSAL');
  const ops = report.exceptions.filter((e) => !e.invoiceId);
  const billing = report.exceptions.filter((e) => e.invoiceId && !e.rollup && e.severity !== 'low');
  return `
    <h3>3. Exception report</h3>
    <p class="hint">Ready to send to the provider or to accounts payable. Each item lists the records it is based on.</p>
    <div class="report-doc" id="report-doc">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div><strong style="font-size:16px">${esc(report.title)}</strong><div class="muted" style="font-size:13px">${esc(lookups.providers[invoice.providerId].name)} · invoice ${esc(invoice.id)} · period ${invoice.period.from} to ${invoice.period.to}</div></div>
        <span class="chip chip-bad">${s.openExceptions} open</span>
      </div>
      <div class="totals" style="margin-top:16px">
        <div class="tile"><div class="lab">Invoice total</div><div class="val">${gbp(s.billedTotal)}</div></div>
        <div class="tile"><div class="lab">Supported by records</div><div class="val">${gbp(s.supportedTotal)}</div></div>
        <div class="tile var"><div class="lab">Amount in query</div><div class="val">${gbp(s.disputedAmount)}</div></div>
      </div>
      <h4>Billing exceptions</h4>
      <table class="t"><thead><tr><th>Ref</th><th>Finding</th><th>Evidence</th><th class="r">Amount</th></tr></thead>
        <tbody>${billing.map((e) => `<tr data-exc-row="${e.id}" class="clickable"><td class="mono">${e.id}</td><td>${esc(e.title)}</td><td>${e.evidence.map((x) => `<span class="mono" style="font-size:11px">${esc(x.ticketNo || x.ref)}</span>`).join('<br>')}</td><td class="r">${gbp(e.financialImpact)}</td></tr>`).join('')}
        <tr><td></td><td colspan="2"><strong>Total in query</strong></td><td class="r"><strong>${gbp(billing.reduce((a, e) => a + e.financialImpact, 0))}</strong></td></tr></tbody></table>
      <h4>Operational exceptions (no charge impact)</h4>
      <table class="t"><thead><tr><th>Ref</th><th>Finding</th><th>Evidence</th></tr></thead>
        <tbody>${ops.map((e) => `<tr data-exc-row="${e.id}" class="clickable"><td class="mono">${e.id}</td><td>${esc(e.title)}<br><span class="muted" style="font-size:12px">${esc(e.detail)}</span></td><td>${e.evidence.map((x) => `<span class="mono" style="font-size:11px">${esc(x.ticketNo || x.ref)}</span>`).join('<br>')}</td></tr>`).join('')}</tbody></table>
      <h4>Recorded general waste weight this period</h4>
      <p style="margin:0;font-size:14px"><strong class="num">${disp.weightBasis.verifiedT.toFixed(3)} t</strong> <span class="basis basis-verified">Verified</span> from ${gwWeights.filter((w) => weightBasis(w) === 'verified').length} weighbridge records. ${disp.weightBasis.reportedT ? `${disp.weightBasis.reportedT.toFixed(3)} t provider-reported.` : 'No provider-reported or estimated weight was used.'} This report does not calculate recycling rates, savings or emissions.</p>
      <h4>How these figures were worked out</h4>
      <ol>${report.methodology.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
    </div>
    <div class="stage-actions">
      <button class="btn btn-ghost" data-go="2">← Back</button>
      <button class="btn btn-primary" id="dl-csv">Download CSV</button>
      <button class="btn btn-ghost" id="dl-json">Download JSON</button>
      <button class="btn btn-ghost" onclick="window.print()">Print / save as PDF</button>
      <a class="btn btn-lime" href="app.html#exceptions">Open in the dashboard</a>
    </div>`;
}

function download(name, type, body) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let current = 1;
function go(step) {
  current = step;
  $$('.step-btn').forEach((b) => {
    const n = Number(b.dataset.step);
    b.toggleAttribute('aria-current', n === step);
    if (n === step) b.setAttribute('aria-current', 'step');
    b.classList.toggle('done', n < step);
  });
  renderDocs(step);
  const stage = $('#demo-stage');
  stage.innerHTML = step === 1 ? stageExtract() : step === 2 ? stageReconcile() : stageReport();
  stage.scrollTop = 0;
  if (step === 3) {
    $('#dl-csv').onclick = () => download(`wasteledger-${invoice.id}-exceptions.csv`, 'text/csv', reportToCSV(report));
    $('#dl-json').onclick = () => download(`wasteledger-${invoice.id}-report.json`, 'application/json', JSON.stringify({ ...report, reconciliations: undefined, reconciliation: rec }, null, 2));
  }
}

function wireDemo() {
  $$('.step-btn').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.step))));
  const stage = $('#demo-stage');
  stage.addEventListener('click', (e) => {
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) return go(Number(goBtn.dataset.go));
    const exc = e.target.closest('[data-exc], [data-exc-row]');
    if (exc) {
      const id = exc.dataset.exc || exc.dataset.excRow;
      const found = report.exceptions.find((x) => x.id === id) || rec.exceptions.find((x) => x.id === id);
      return found && highlight(found.evidence);
    }
    const line = e.target.closest('[data-line-row]');
    if (line) {
      $$('[data-line-row]').forEach((r) => r.classList.toggle('sel', r === line));
      const l = rec.lines.find((x) => x.lineNo === Number(line.dataset.lineRow));
      return highlight([{ kind: 'invoice_line', ref: `${invoice.id} line ${l.lineNo}` }, ...l.matchedRecords, ...rec.exceptions.filter((x) => l.exceptionIds.includes(x.id)).flatMap((x) => x.evidence)]);
    }
    const t = e.target.closest('[data-hl-ticket]');
    if (t) return highlight([{ ticketNo: t.dataset.hlTicket }]);
    if (e.target.closest('[data-hl-invoice]')) return highlight([{ kind: 'invoice_line', ref: `${invoice.id} line 1` }]);
  });
  stage.addEventListener('focusin', (e) => {
    const exc = e.target.closest('[data-exc]');
    if (exc) highlight(rec.exceptions.find((x) => x.id === exc.dataset.exc)?.evidence || []);
  });
  go(1);
}

// ---------- demo request form ----------
function wireForm() {
  const form = $('#demo-form');
  $$('[data-plan]').forEach((a) => a.addEventListener('click', () => { form.plan_interest.value = a.dataset.plan; }));
  const setErr = (el, msg) => {
    el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    const err = el.parentElement.querySelector('.err');
    if (err) err.textContent = msg || '';
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let ok = true;
    for (const el of form.querySelectorAll('[required]')) {
      if (el.type === 'checkbox') {
        $('#consent-err').textContent = el.checked ? '' : 'Please tick to let us contact you.';
        ok = ok && el.checked;
        continue;
      }
      let msg = el.value.trim() ? '' : 'Required';
      if (!msg && el.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value)) msg = 'Enter a valid email address';
      setErr(el, msg);
      ok = ok && !msg;
    }
    if (!ok) return form.querySelector('[aria-invalid="true"]')?.focus();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Sending…';
    const body = Object.fromEntries(new FormData(form));
    body.consent = form.consent.checked;
    body.page = location.pathname;
    try {
      const res = await fetch('/api/demo-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      $('#form-wrap').innerHTML = `<div class="form-ok" role="status">Thanks, ${esc(body.firstname)}. We've got your request and will email ${esc(body.email)} within one working day to book a time.</div>`;
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Request a demo';
      $('#consent-err').textContent = `We couldn't send your request (${err.message}). Please try again.`;
    }
  });
}

function wireNav() {
  const btn = $('#menu-btn');
  btn.addEventListener('click', () => {
    const open = $('#nav-links').classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
  $$('#nav-links a').forEach((a) => a.addEventListener('click', () => $('#nav-links').classList.remove('open')));
}

renderHero();
wireDemo();
wireForm();
wireNav();
