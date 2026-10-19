// HubSpot CRM v3 calls used by the Lambdas. Auth is a private-app access token in Secrets Manager.
// Object, property and pipeline names are defined in docs/hubspot-crm-workflows.md.

const BASE = 'https://api.hubapi.com';

async function hs(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return hs(token, method, path, body);
  }
  if (!res.ok) throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Create or update a contact by email. */
export async function upsertContact(token, properties) {
  const clean = Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== undefined && v !== ''));
  const out = await hs(token, 'POST', '/crm/v3/objects/contacts/batch/upsert', {
    inputs: [{ idProperty: 'email', id: clean.email, properties: clean }],
  });
  return out.results[0];
}

/** Open a deal in the sales pipeline and link it to the contact. */
export async function createDemoDeal(token, { contactId, company, segment, siteCountBand, pipelineId, stageId }) {
  return hs(token, 'POST', '/crm/v3/objects/deals', {
    properties: {
      dealname: `${company} · WasteLedger demo`,
      pipeline: pipelineId,
      dealstage: stageId,
      wl_segment: segment,
      wl_site_count_band: siteCountBand,
    },
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }], // deal → contact
  });
}

/**
 * Raise a provider-facing billing exception as a HubSpot ticket on the contractor's company record.
 * Only exceptions a reviewer has marked "Raise with provider" are sent.
 */
export async function createExceptionTicket(token, { providerCompanyId, pipelineId, stageId, exception, siteName }) {
  return hs(token, 'POST', '/crm/v3/objects/tickets', {
    properties: {
      subject: `[${exception.severity.toUpperCase()}] ${exception.title}`,
      content: `${exception.detail}\n\nSite: ${siteName}\nInvoice: ${exception.invoiceId || 'n/a'}\nAmount in query: £${(exception.financialImpact || 0).toFixed(2)}\nEvidence: ${exception.evidence.map((x) => x.ticketNo || x.ref).join(', ')}`,
      hs_pipeline: pipelineId,
      hs_pipeline_stage: stageId,
      wl_exception_type: exception.type,
      wl_amount_in_query: exception.financialImpact || 0,
    },
    associations: providerCompanyId
      ? [{ to: { id: providerCompanyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 26 }] }] // ticket → company
      : [],
  });
}
