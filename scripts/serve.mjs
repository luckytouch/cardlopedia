#!/usr/bin/env node
// Serves site/ locally for development, the same way GitHub Pages will.
// Usage: npm run dev   (or: node scripts/serve.mjs [port] [base])
// Pass a base such as /cardlopedia/ to test it the way a GitHub Pages project site is served.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'site');
const PORT = Number(process.argv[2] || process.env.PORT) || 5173;
const BASE = (process.argv[3] || '/').replace(/^\/?/, '/').replace(/\/?$/, '/');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

try { await fs.access(path.join(SITE, 'data', 'meta.json')); } catch {
  console.warn('site/data is missing. Run `npm run build` first, or most games will show an error.');
}

http.createServer(async (req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === BASE.slice(0, -1)) { res.writeHead(301, { Location: BASE }); return res.end(); }
  rel = rel.startsWith(BASE) ? '/' + rel.slice(BASE.length) : '/\0missing';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(SITE, path.normalize(rel));
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    res.end(await fs.readFile(path.join(SITE, '404.html')));
  }
}).listen(PORT, () => console.log(`Cardlopedia (static) at http://localhost:${PORT}${BASE}`));
