// Local development server. No dependencies.
//   /            -> web/
//   /core/...    -> core/ (shared engine, imported by the browser as ../core/*.js)
//   POST /api/demo-request -> validated with the same code as the Lambda, then written to data/demo-requests.jsonl
import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDemoRequest } from '../backend/lib/demo-request.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const base = clean.startsWith('/core/') ? root : join(root, 'web');
  const file = join(base, clean === '/' ? 'index.html' : clean);
  if (!file.startsWith(base)) return null;
  return file;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/demo-request') {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 20_000) { res.writeHead(413).end(); return; }
    }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Invalid JSON"}'); return; }
    const { ok, errors, value } = validateDemoRequest(body);
    if (!ok) { res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: errors.join('; ') })); return; }
    await mkdir(join(root, 'data'), { recursive: true });
    await appendFile(join(root, 'data', 'demo-requests.jsonl'), JSON.stringify({ ...value, receivedAt: new Date().toISOString() }) + '\n');
    console.log(`demo request stored locally: ${value.company} (${value.segment})`);
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"status":"received"}');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const file = resolvePath(url.pathname);
  if (!file) { res.writeHead(403).end(); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, () => console.log(`WasteLedger dev server: http://localhost:${PORT}`));
