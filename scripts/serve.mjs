// Servidor estático local sin dependencias. Uso: node scripts/serve.mjs [puerto]   (por defecto 8080)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.LICENSE': 'text/plain; charset=utf-8',
};

export function createServer(root = ROOT) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500).end(); }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.argv[2] || 8080);
  createServer().listen(port, '127.0.0.1', () => console.log(`Quedamos en http://localhost:${port}/  (Ctrl+C para parar)`));
}
