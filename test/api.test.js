import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/demo-request.js';

function mockReqRes({ method = 'POST', body = null, headers = {} } = {}) {
  const req = {
    method,
    body,
    headers,
    on: (evt, cb) => {
      if (evt === 'data' && typeof body === 'string') cb(body);
      if (evt === 'end') cb();
    },
  };
  let statusCode = 200;
  let headersSent = {};
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(k, v) {
      headersSent[k] = v;
      return this;
    },
    json(obj) {
      jsonBody = obj;
      return this;
    },
  };
  return { req, res, get: () => ({ statusCode, headers: headersSent, body: jsonBody }) };
}

test('api/demo-request: rejects non-POST methods with 405', async () => {
  const { req, res, get } = mockReqRes({ method: 'GET' });
  await handler(req, res);
  assert.equal(get().statusCode, 405);
});

test('api/demo-request: returns 422 on invalid request body', async () => {
  const { req, res, get } = mockReqRes({ method: 'POST', body: {} });
  await handler(req, res);
  assert.equal(get().statusCode, 422);
  assert.ok(get().body.error);
});

test('api/demo-request: accepts valid submission in demo mode', async () => {
  const valid = {
    firstname: 'Alex',
    lastname: 'Morgan',
    email: 'alex@example.com',
    company: 'Apex Hotels',
    segment: 'hotel_group',
    site_count: '6–15',
    consent: true,
  };
  const { req, res, get } = mockReqRes({ method: 'POST', body: valid });
  await handler(req, res);
  assert.equal(get().statusCode, 202);
  assert.equal(get().body.status, 'received');
  assert.equal(get().body.delivered, 'demo-mode');
});
