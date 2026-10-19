// Review queue API (API Gateway HTTP API with a JWT authorizer).
//   GET  /api/review/queue
//   GET  /api/review/documents/{id}
//   POST /api/review/documents/{id}/fields    { edits: { ticketNo: { confirm: true }, date: { value: "16/09/2026" } } }
//   POST /api/review/documents/{id}/preview   { confirmation: { siteId, providerId, serviceCode, … } }
//   POST /api/review/documents/{id}/accept    { confirmation: { … } }
//   POST /api/review/documents/{id}/reject    { reason }
// The reviewer and organisation come from the verified token, never from the request body.

import { listQueue, getDocument, saveFieldReviews, previewAccept, accept, reject } from '../lib/review-store.js';

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function identityFrom(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  const reviewer = claims.email;
  const orgId = claims['custom:org_id'];
  const groups = String(claims['cognito:groups'] || '').replace(/[[\]]/g, '').split(/[ ,]+/).filter(Boolean);
  return { reviewer, orgId, canReview: groups.includes('reviewers') || groups.includes('admins') };
}

export async function handler(event) {
  const { reviewer, orgId, canReview } = identityFrom(event);
  if (!reviewer || !orgId) return json(401, { error: 'Sign in required' });

  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body); } catch { return json(400, { error: 'Invalid JSON' }); }
  }
  const id = event.pathParameters?.id;
  const write = event.requestContext?.http?.method === 'POST';
  if (write && !canReview) return json(403, { error: 'Only reviewers can change documents' });

  try {
    switch (event.routeKey) {
      case 'GET /api/review/queue':
        return json(200, { documents: await listQueue(orgId) });
      case 'GET /api/review/documents/{id}': {
        const doc = await getDocument(orgId, id);
        return doc ? json(200, doc) : json(404, { error: 'Document not found' });
      }
      case 'POST /api/review/documents/{id}/fields':
        return json(200, await saveFieldReviews(orgId, id, body.edits || {}, reviewer));
      case 'POST /api/review/documents/{id}/preview':
        return json(200, await previewAccept(orgId, id, body.confirmation || {}));
      case 'POST /api/review/documents/{id}/accept':
        return json(200, await accept(orgId, id, body.confirmation || {}, reviewer));
      case 'POST /api/review/documents/{id}/reject':
        return json(200, await reject(orgId, id, String(body.reason || '').trim(), reviewer));
      default:
        return json(404, { error: 'Not found' });
    }
  } catch (err) {
    if (err.status) return json(err.status, { error: err.message, errors: err.errors });
    console.error('review api error', { routeKey: event.routeKey, id, error: err.message });
    return json(500, { error: 'Something went wrong' });
  }
}
