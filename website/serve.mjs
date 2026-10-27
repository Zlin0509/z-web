import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const port = Number(process.env.PORT || 4321);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
await build();
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = resolve(dist, '.' + pathname);
    if (!file.startsWith(dist + sep) && file !== dist) { res.writeHead(403); res.end(); return; }
    let info = await stat(file);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { Location: pathname + '/' }); res.end(); return; }
      file = resolve(file, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    const body = await readFile(resolve(dist, '404.html')).catch(() => 'Not found');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exit(1); });
if (!process.argv.includes('--no-watch')) {
  async function fingerprint(dir) {
    const values = [];
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      values.push(item.isDirectory() ? await fingerprint(path) : `${path}:${(await stat(path)).mtimeMs}`);
    }
    return values.join('|');
  }
  let previous = await fingerprint(resolve(root, 'website'));
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { const next = await fingerprint(resolve(root, 'website')); if (next !== previous) { await build(); previous = next; } }
    catch (error) { console.error(error.message); }
    finally { busy = false; }
  }, 1000);
}
