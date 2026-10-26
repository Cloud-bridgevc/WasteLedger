// Vercel Serverless Function: POST /api/demo-request
import { validateDemoRequest, toHubSpotContact, SEGMENTS } from '../backend/lib/demo-request.js';
import { upsertContact, createDemoDeal } from '../backend/lib/hubspot.js';

async function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch { return null; }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await getBody(req);
  if (body === null) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { ok, errors, value } = validateDemoRequest(body);
  if (!ok) {
    return res.status(422).json({ error: errors.join('; ') });
  }

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (token) {
    try {
      const contact = await upsertContact(token, toHubSpotContact(value));
      if (process.env.HUBSPOT_SALES_PIPELINE_ID && process.env.HUBSPOT_DEMO_REQUESTED_STAGE_ID) {
        await createDemoDeal(token, {
          contactId: contact.id,
          company: value.company,
          segment: SEGMENTS[value.segment],
          siteCountBand: value.site_count,
          pipelineId: process.env.HUBSPOT_SALES_PIPELINE_ID,
          stageId: process.env.HUBSPOT_DEMO_REQUESTED_STAGE_ID,
        });
      }
      return res.status(202).json({ status: 'received', delivered: 'hubspot' });
    } catch (err) {
      console.error('HubSpot demo request submission error:', err?.message);
      return res.status(502).json({ error: 'Could not record your request right now' });
    }
  }

  // Preview or demo deployment without HubSpot credentials configured
  return res.status(202).json({ status: 'received', delivered: 'demo-mode' });
}
