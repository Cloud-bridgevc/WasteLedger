// API Gateway (HTTP API) POST /api/demo-request → validate → HubSpot contact + deal.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { validateDemoRequest, toHubSpotContact, SEGMENTS } from '../lib/demo-request.js';
import { upsertContact, createDemoDeal } from '../lib/hubspot.js';

let token;
async function hubspotToken() {
  if (token) return token;
  const sm = new SecretsManagerClient({});
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: process.env.HUBSPOT_SECRET_ARN }));
  token = JSON.parse(SecretString).accessToken;
  return token;
}

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function handler(event) {
  let body;
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { ok, errors, value } = validateDemoRequest(body);
  if (!ok) return json(422, { error: errors.join('; ') });

  try {
    const t = await hubspotToken();
    const contact = await upsertContact(t, toHubSpotContact(value));
    await createDemoDeal(t, {
      contactId: contact.id,
      company: value.company,
      segment: SEGMENTS[value.segment],
      siteCountBand: value.site_count,
      pipelineId: process.env.HUBSPOT_SALES_PIPELINE_ID,
      stageId: process.env.HUBSPOT_DEMO_REQUESTED_STAGE_ID,
    });
    return json(202, { status: 'received' });
  } catch (err) {
    console.error('demo request failed', { error: err.message, segment: value.segment });
    return json(502, { error: 'Could not record your request right now' });
  }
}
