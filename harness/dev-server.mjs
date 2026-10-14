// Zero-dependency local harness: runs the Worker's fetch handler under plain Node, with an
// ASSETS shim over public/. Use it when wrangler is unavailable:  node harness/dev-server.mjs
//   PORT=8787  QLOO_API_KEY=...  LINEUPLAB_MOCK=1  (all optional; no key = demo mode)
// Workers AI is not available here, so the LLM steps always run in demo mode.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep) || path.includes('_headers')) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },
};

const env = { ASSETS };
if (process.env.QLOO_API_KEY) env.QLOO_API_KEY = process.env.QLOO_API_KEY;
if (process.env.LINEUPLAB_MOCK) env.LINEUPLAB_MOCK = process.env.LINEUPLAB_MOCK;
if (process.env.QLOO_BASE_URL) env.QLOO_BASE_URL = process.env.QLOO_BASE_URL;

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const pending = [];
      const response = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
      await Promise.allSettled(pending);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('harness error');
      console.error(err);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, () => console.log(`LineupLab (Node harness) on http://localhost:${port}  mode: ${env.QLOO_API_KEY ? 'live Qloo' : 'demo data'}`));
}
