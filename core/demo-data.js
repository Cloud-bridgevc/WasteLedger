// Fictional demonstration data. Every organisation, site, provider, ticket, weight and invoice
// here is made up. Rates are illustrative and are not market prices.
//
// The generator is deterministic (seeded), so the dashboard, the public demo and the tests
// all see the same records. A few problems are planted on purpose. They are listed in
// PLANTED_ISSUES so the README and the tests can check that the engine finds them.

import { datesBetween, weekdayOf, round3 } from './engine.js';

export const ORGANISATION = {
  id: 'ORG-CVE',
  name: 'Calder & Vale Estates',
  note: 'Fictional demonstration portfolio',
};

export const SITES = [
  { id: 'SITE-LDS', name: 'Harbourline Grand, Leeds', type: 'Hotel', city: 'Leeds', rooms: 212 },
  { id: 'SITE-MAN', name: 'Harbourline Quayside, Manchester', type: 'Hotel', city: 'Manchester', rooms: 168 },
  { id: 'SITE-SHF', name: 'Riverside Exchange, Sheffield', type: 'Shopping centre', city: 'Sheffield', units: 64 },
  { id: 'SITE-BRD', name: 'Kestrel Park Campus, Bradford', type: 'Business campus', city: 'Bradford', buildings: 5 },
];

export const PROVIDERS = [
  { id: 'PRV-NGW', name: 'Northgate Waste Services', streams: ['General waste', 'Dry mixed recycling'], weighing: 'Weighbridge tickets for general waste. On-board vehicle weights for recycling.', contact: 'accounts@northgate-waste.example', licence: 'Fictional — CBDU000001' },
  { id: 'PRV-CLR', name: 'Clearway Recycling Co.', streams: ['Cardboard'], weighing: 'On-board vehicle weights', contact: 'billing@clearway-recycling.example', licence: 'Fictional — CBDU000002' },
  { id: 'PRV-ASH', name: 'Ashdown Organics', streams: ['Food waste'], weighing: 'Not weighed. Provider supplies a volume-based estimate.', contact: 'hello@ashdown-organics.example', licence: 'Fictional — CBDU000003' },
];

export const CONTRACTS = [
  {
    id: 'CT-NGW-2025-03', providerId: 'PRV-NGW', documentId: 'DOC-CT-NGW-2025-03',
    title: 'Mixed commercial waste collection agreement', siteIds: ['SITE-LDS', 'SITE-MAN', 'SITE-SHF', 'SITE-BRD'],
    effectiveFrom: '2025-04-01', effectiveTo: '2027-03-31', currency: 'GBP',
    services: [
      { serviceCode: 'GW-1100-LIFT', stream: 'General waste', container: '1100 L wheeled bin', billing: 'per_lift', unit: 'lift', rate: 18.40, clause: '4.1' },
      { serviceCode: 'GW-DISPOSAL', stream: 'General waste', billing: 'per_tonne', unit: 'tonne', rate: 128.00, clause: '4.3', toleranceT: 0.02 },
      { serviceCode: 'DMR-1100-LIFT', stream: 'Dry mixed recycling', container: '1100 L wheeled bin', billing: 'per_lift', unit: 'lift', rate: 12.60, clause: '4.2' },
      { serviceCode: 'ADMIN-MONTHLY', billing: 'fixed', unit: 'month', rate: 15.00, clause: '6.1', description: 'Duty of care documentation and account fee' },
    ],
  },
  {
    id: 'CT-CLR-2026-01', providerId: 'PRV-CLR', documentId: 'DOC-CT-CLR-2026-01',
    title: 'Baled cardboard collection', siteIds: ['SITE-SHF', 'SITE-BRD'],
    effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', currency: 'GBP',
    services: [
      { serviceCode: 'OCC-BALE-LIFT', stream: 'Cardboard', container: 'Baler collection', billing: 'per_lift', unit: 'collection', rate: 22.00, clause: '3.2' },
    ],
  },
  {
    id: 'CT-ASH-2025-09', providerId: 'PRV-ASH', documentId: 'DOC-CT-ASH-2025-09',
    title: 'Food waste collection', siteIds: ['SITE-LDS', 'SITE-MAN'],
    effectiveFrom: '2025-09-01', effectiveTo: '2027-08-31', currency: 'GBP',
    services: [
      { serviceCode: 'FOOD-240-LIFT', stream: 'Food waste', container: '240 L food caddy', billing: 'per_lift', unit: 'bin', rate: 6.80, clause: '2.1' },
    ],
  },
];

// Containers per visit, collection days, how weight is captured, and typical kg per container
// (used only to generate fictional weights).
export const SCHEDULES = [
  { id: 'SCH-LDS-GW', siteId: 'SITE-LDS', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', stream: 'General waste', days: ['Mon', 'Thu'], containers: 2, weighing: 'weighbridge', kgPer: 205 },
  { id: 'SCH-LDS-DMR', siteId: 'SITE-LDS', providerId: 'PRV-NGW', serviceCode: 'DMR-1100-LIFT', stream: 'Dry mixed recycling', days: ['Wed'], containers: 1, weighing: 'on-board', kgPer: 72 },
  { id: 'SCH-LDS-FOOD', siteId: 'SITE-LDS', providerId: 'PRV-ASH', serviceCode: 'FOOD-240-LIFT', stream: 'Food waste', days: ['Mon', 'Thu'], containers: 3, weighing: 'volumetric-estimate' },
  { id: 'SCH-MAN-GW', siteId: 'SITE-MAN', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', stream: 'General waste', days: ['Tue', 'Fri'], containers: 3, weighing: 'weighbridge', kgPer: 190 },
  { id: 'SCH-MAN-DMR', siteId: 'SITE-MAN', providerId: 'PRV-NGW', serviceCode: 'DMR-1100-LIFT', stream: 'Dry mixed recycling', days: ['Wed'], containers: 2, weighing: 'on-board', kgPer: 68 },
  { id: 'SCH-MAN-FOOD', siteId: 'SITE-MAN', providerId: 'PRV-ASH', serviceCode: 'FOOD-240-LIFT', stream: 'Food waste', days: ['Tue', 'Fri'], containers: 2, weighing: 'volumetric-estimate' },
  { id: 'SCH-SHF-GW', siteId: 'SITE-SHF', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', stream: 'General waste', days: ['Mon', 'Wed', 'Fri'], containers: 4, weighing: 'weighbridge', kgPer: 215 },
  { id: 'SCH-SHF-DMR', siteId: 'SITE-SHF', providerId: 'PRV-NGW', serviceCode: 'DMR-1100-LIFT', stream: 'Dry mixed recycling', days: ['Tue', 'Thu'], containers: 3, weighing: 'on-board', kgPer: 80 },
  { id: 'SCH-SHF-OCC', siteId: 'SITE-SHF', providerId: 'PRV-CLR', serviceCode: 'OCC-BALE-LIFT', stream: 'Cardboard', days: ['Tue'], containers: 1, weighing: 'on-board', kgPer: 540 },
  { id: 'SCH-BRD-GW', siteId: 'SITE-BRD', providerId: 'PRV-NGW', serviceCode: 'GW-1100-LIFT', stream: 'General waste', days: ['Wed'], containers: 2, weighing: 'on-board', kgPer: 180 },
  { id: 'SCH-BRD-DMR', siteId: 'SITE-BRD', providerId: 'PRV-NGW', serviceCode: 'DMR-1100-LIFT', stream: 'Dry mixed recycling', days: ['Wed'], containers: 1, weighing: 'on-board', kgPer: 75 },
  { id: 'SCH-BRD-OCC', siteId: 'SITE-BRD', providerId: 'PRV-CLR', serviceCode: 'OCC-BALE-LIFT', stream: 'Cardboard', days: ['Fri'], containers: 1, weighing: 'on-board', kgPer: 410 },
];

export const PERIOD = { from: '2026-07-01', to: '2026-09-30' };
export const MONTHS = ['2026-07', '2026-08', '2026-09'];

// The worked example on the public site and in the exception report.
export const DEMO_CASE = { siteId: 'SITE-LDS', providerId: 'PRV-NGW', month: '2026-09', invoiceId: 'INV-NGW-24117' };

// Food waste is never weighed. Ashdown supplies this factor. It is shown wherever estimates appear.
export const FOOD_ESTIMATE = { litresPerBin: 240, assumedKgPerLitre: 0.45, source: 'Provider-supplied fill factor (Ashdown Organics service schedule). Not measured.' };

export const PLANTED_ISSUES = [
  'SITE-LDS, Sep: a ticket is billed twice on the general waste lift line',
  'SITE-LDS, Sep: a ticket marked "not collected" is billed',
  'SITE-LDS, Sep: the general waste lift rate is 19.75 against a contracted 18.40',
  'SITE-LDS, Sep: 0.500 t of disposal is billed with no weight records behind it',
  'SITE-LDS, Sep: a scheduled Monday collection has no ticket',
  'SITE-LDS, Sep: one general waste weighbridge record is about three times the site norm',
  'SITE-MAN, Aug: a recycling lift is billed against a ticket number that is not in the register',
  'SITE-MAN, Sep: one food waste ticket is billed for 3 bins when 2 were recorded',
  'SITE-SHF, Sep: a scheduled general waste collection has no ticket',
  'SITE-SHF, Sep: one cardboard ticket was keyed into the register twice',
  'SITE-BRD, Aug: the monthly account fee is charged at 17.50 against a contracted 15.00',
];

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIX = { 'PRV-NGW': 'NG', 'PRV-CLR': 'CW', 'PRV-ASH': 'AO' };
const LDS_SEPT_GW_KG = { '2026-09-03': 412, '2026-09-07': 398, '2026-09-10': 431, '2026-09-17': 1284, '2026-09-24': 405, '2026-09-28': 420 };

export function buildPortfolio() {
  const rand = mulberry32(20260930);
  const tickets = [];
  const weights = [];
  const counters = { 'PRV-NGW': 558000, 'PRV-CLR': 71200, 'PRV-ASH': 30400 };
  let tid = 0;
  let wid = 0;

  const allDates = datesBetween(PERIOD.from, PERIOD.to);
  for (const date of allDates) {
    for (const s of SCHEDULES) {
      if (!s.days.includes(weekdayOf(date))) continue;

      // Planted: missing records (no ticket at all).
      if (s.id === 'SCH-LDS-GW' && date === '2026-09-21') continue;
      if (s.id === 'SCH-SHF-GW' && date === '2026-09-16') continue;

      counters[s.providerId] += 1 + Math.floor(rand() * 3);
      const ticketNo = `${PREFIX[s.providerId]}-${counters[s.providerId]}`;
      tid += 1;
      const notCollected = s.id === 'SCH-LDS-GW' && date === '2026-09-14';
      const t = {
        id: `TKT-${String(tid).padStart(5, '0')}`,
        ticketNo,
        siteId: s.siteId,
        providerId: s.providerId,
        serviceCode: s.serviceCode,
        stream: s.stream,
        date,
        scheduledContainers: s.containers,
        containers: notCollected ? 0 : s.containers,
        status: notCollected ? 'not_collected' : 'collected',
        note: notCollected ? 'Bin store blocked by delivery vehicle. No lift.' : '',
        documentId: `DOC-TKT-${ticketNo}`,
        source: 'textract',
      };
      tickets.push(t);

      // Planted: the same cardboard ticket keyed twice.
      if (s.id === 'SCH-SHF-OCC' && date === '2026-09-15') {
        tid += 1;
        tickets.push({ ...t, id: `TKT-${String(tid).padStart(5, '0')}`, source: 'manual' });
      }

      if (t.status !== 'collected') continue;
      wid += 1;
      if (s.weighing === 'volumetric-estimate') {
        weights.push({
          id: `WR-${String(wid).padStart(5, '0')}`, ticketNo, siteId: s.siteId, providerId: s.providerId, stream: s.stream, date,
          netKg: Math.round(s.containers * FOOD_ESTIMATE.litresPerBin * FOOD_ESTIMATE.assumedKgPerLitre),
          method: 'volumetric-estimate',
          estimateMethod: `${s.containers} × ${FOOD_ESTIMATE.litresPerBin} L × assumed ${FOOD_ESTIMATE.assumedKgPerLitre} kg/L`,
          documentId: null,
        });
        continue;
      }
      let kg = Math.round(s.containers * s.kgPer * (0.88 + rand() * 0.24));
      if (s.id === 'SCH-LDS-GW' && LDS_SEPT_GW_KG[date]) kg = LDS_SEPT_GW_KG[date];
      weights.push({
        id: `WR-${String(wid).padStart(5, '0')}`, ticketNo, siteId: s.siteId, providerId: s.providerId, stream: s.stream, date,
        netKg: kg,
        method: s.weighing,
        documentId: s.weighing === 'weighbridge' ? `DOC-WB-${ticketNo}` : null,
        weighbridge: s.weighing === 'weighbridge' ? 'Northgate Transfer Station, Wakefield (fictional)' : null,
      });
    }
  }

  const invoices = buildInvoices(tickets, weights);
  return { organisation: ORGANISATION, sites: SITES, providers: PROVIDERS, contracts: CONTRACTS, schedules: SCHEDULES, period: PERIOD, tickets, weights, invoices, extractions: buildExtractions(tickets, invoices) };
}

function buildInvoices(tickets, weights) {
  const invoices = [];
  const seq = { 'PRV-NGW': 24100, 'PRV-CLR': 8800, 'PRV-ASH': 3300 };
  for (const month of MONTHS) {
    const from = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    for (const p of PROVIDERS) {
      for (const site of SITES) {
        const contract = CONTRACTS.find((c) => c.providerId === p.id && c.siteIds.includes(site.id));
        if (!contract) continue;
        seq[p.id] += 1;
        const isDemo = site.id === DEMO_CASE.siteId && p.id === DEMO_CASE.providerId && month === DEMO_CASE.month;
        const id = isDemo ? DEMO_CASE.invoiceId : `INV-${p.id.slice(4)}-${seq[p.id]}`;
        const lines = [];
        let lineNo = 0;
        for (const svc of contract.services) {
          if (svc.billing !== 'per_lift') continue;
          const ts = tickets.filter((t) => t.siteId === site.id && t.serviceCode === svc.serviceCode && t.date >= from && t.date <= to);
          if (!ts.length) continue;
          // Providers bill each ticket once. Planted duplicates in the register are de-duplicated here.
          const uniq = [...new Map(ts.map((t) => [t.ticketNo, t])).values()];
          let rate = svc.rate;
          let items = uniq.filter((t) => t.status === 'collected').map((t) => ({ ticketNo: t.ticketNo, date: t.date, quantity: t.containers }));
          if (isDemo && svc.serviceCode === 'GW-1100-LIFT') {
            rate = 19.75;
            const missed = uniq.find((t) => t.status === 'not_collected');
            items.push({ ticketNo: missed.ticketNo, date: missed.date, quantity: missed.scheduledContainers });
            const dup = items.find((it) => it.date === '2026-09-17');
            items.push({ ...dup });
            items.sort((a, b) => a.date.localeCompare(b.date));
          }
          if (site.id === 'SITE-MAN' && month === '2026-08' && svc.serviceCode === 'DMR-1100-LIFT') {
            items.push({ ticketNo: 'NG-561990', date: '2026-08-26', quantity: 2 });
          }
          if (site.id === 'SITE-MAN' && month === '2026-09' && svc.serviceCode === 'FOOD-240-LIFT') {
            items[4] = { ...items[4], quantity: items[4].quantity + 1 };
          }
          const qty = items.reduce((s, it) => s + it.quantity, 0);
          lineNo += 1;
          lines.push({ lineNo, serviceCode: svc.serviceCode, description: `${svc.stream} — ${svc.container} — ${svc.unit}s`, unit: svc.unit, quantity: qty, unitRate: rate, amount: +(qty * rate).toFixed(2), items });
        }
        const disposal = contract.services.find((s) => s.billing === 'per_tonne');
        if (disposal) {
          const billedNos = new Set(lines.flatMap((l) => l.items.map((i) => i.ticketNo)));
          const kg = weights.filter((w) => w.siteId === site.id && w.stream === disposal.stream && w.date >= from && w.date <= to && billedNos.has(w.ticketNo)).reduce((s, w) => s + w.netKg, 0);
          let tonnes = round3(kg / 1000);
          if (isDemo) tonnes = round3(tonnes + 0.5);
          lineNo += 1;
          lines.push({ lineNo, serviceCode: disposal.serviceCode, description: `${disposal.stream} — disposal by weight`, unit: 'tonne', quantity: tonnes, unitRate: disposal.rate, amount: +(tonnes * disposal.rate).toFixed(2) });
        }
        const fee = contract.services.find((s) => s.billing === 'fixed');
        if (fee) {
          const rate = site.id === 'SITE-BRD' && month === '2026-08' ? 17.5 : fee.rate;
          lineNo += 1;
          lines.push({ lineNo, serviceCode: fee.serviceCode, description: fee.description, unit: 'month', quantity: 1, unitRate: rate, amount: rate });
        }
        if (!lines.length) continue;
        const issueDate = datesBetween(to, '2026-10-31')[5];
        invoices.push({
          id, providerId: p.id, siteId: site.id, contractId: contract.id, period: { from, to }, issueDate,
          currency: 'GBP', documentId: `DOC-${id}`, lines,
          total: +lines.reduce((s, l) => s + l.amount, 0).toFixed(2),
        });
      }
    }
  }
  return invoices;
}

// Sample Textract-style output for the demo documents. Confidence is per field (0–1).
function buildExtractions(tickets, invoices) {
  const lds = tickets.filter((t) => t.siteId === 'SITE-LDS' && t.serviceCode === 'GW-1100-LIFT' && t.date.startsWith('2026-09'));
  const missed = lds.find((t) => t.status === 'not_collected');
  const first = lds[0];
  const inv = invoices.find((i) => i.id === DEMO_CASE.invoiceId);
  return [
    {
      documentId: first.documentId, siteId: 'SITE-LDS', docType: 'collection_ticket', classifiedBy: 'bedrock', classificationConfidence: 0.98,
      fields: [
        { key: 'ticketNo', label: 'Ticket number', value: first.ticketNo, confidence: 0.99 },
        { key: 'date', label: 'Collection date', value: first.date, confidence: 0.99 },
        { key: 'site', label: 'Site', value: 'Harbourline Grand', confidence: 0.97 },
        { key: 'container', label: 'Container', value: '1100L GW', confidence: 0.96 },
        { key: 'containers', label: 'Containers lifted', value: String(first.containers), confidence: 0.98 },
        { key: 'driverSig', label: 'Driver signature', value: 'present', confidence: 0.94 },
      ],
    },
    {
      documentId: missed.documentId, siteId: 'SITE-LDS', docType: 'collection_ticket', classifiedBy: 'bedrock', classificationConfidence: 0.97,
      fields: [
        { key: 'ticketNo', label: 'Ticket number', value: missed.ticketNo, confidence: 0.99 },
        { key: 'date', label: 'Collection date', value: missed.date, confidence: 0.98 },
        { key: 'containers', label: 'Containers lifted', value: '0', confidence: 0.82 },
        { key: 'note', label: 'Driver note (handwritten)', value: missed.note, confidence: 0.77 },
      ],
    },
    {
      documentId: inv.documentId, siteId: 'SITE-LDS', docType: 'invoice', classifiedBy: 'bedrock', classificationConfidence: 0.99,
      fields: [
        { key: 'invoiceNo', label: 'Invoice number', value: inv.id, confidence: 0.99 },
        { key: 'period', label: 'Service period', value: `${inv.period.from} to ${inv.period.to}`, confidence: 0.97 },
        { key: 'total', label: 'Invoice total', value: inv.total.toFixed(2), confidence: 0.99 },
        { key: 'lines', label: 'Line items', value: String(inv.lines.length), confidence: 0.96 },
      ],
    },
  ];
}

export function lookupsFor(portfolio) {
  return {
    sites: Object.fromEntries(portfolio.sites.map((s) => [s.id, s])),
    providers: Object.fromEntries(portfolio.providers.map((p) => [p.id, p])),
  };
}
