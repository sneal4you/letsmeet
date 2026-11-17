// Comprueba que el servidor estático sirve el shell de la PWA y que el shell es coherente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, ROOT } from '../scripts/serve.mjs';
import { RELAYS } from '../public/core.js';
import { shellVersion, currentVersion } from '../scripts/bump-sw.mjs';

test('servidor estático: index, manifest, sw, iconos y vendor', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const expect = {
      '': 'text/html', 'index.html': 'text/html', 'manifest.webmanifest': 'application/manifest+json', 'sw.js': 'text/javascript',
      'app.js': 'text/javascript', 'core.js': 'text/javascript', 'crypto.js': 'text/javascript', 'sync.js': 'text/javascript', 'store.js': 'text/javascript',
      'styles.css': 'text/css', 'vendor/noble-secp256k1.js': 'text/javascript',
      'icons/icon-192.png': 'image/png', 'icons/icon-512.png': 'image/png', 'icons/icon-maskable-512.png': 'image/png', 'icons/apple-touch-icon.png': 'image/png',
    };
    for (const [p, type] of Object.entries(expect)) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      assert.ok(res.headers.get('content-type').startsWith(type), `${p}: ${res.headers.get('content-type')}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      assert.ok(buf.length > 0, p);
      if (type === 'image/png') assert.deepEqual([...buf.slice(1, 4)], [80, 78, 71]);
    }
    assert.equal((await fetch(base + 'nada.js')).status, 404);
    assert.notEqual((await fetch(base + '..%2fpackage.json')).status, 200);
    const manifest = await (await fetch(base + 'manifest.webmanifest')).json();
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('shell coherente: CSP con todos los relés, rutas relativas y lista de caché del SW existente', async () => {
  const html = await readFile(`${ROOT}/index.html`, 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  for (const r of RELAYS) assert.ok(csp.includes(r), `CSP sin ${r}`);
  assert.ok(/script-src 'self';/.test(csp) && /style-src 'self';/.test(csp));
  assert.ok(!/(href|src)="\//.test(html), 'rutas absolutas en index.html');
  assert.ok(!/<style|style="/.test(html), 'estilos en línea');
  const sw = await readFile(`${ROOT}/sw.js`, 'utf8');
  const list = JSON.parse('[' + sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
  for (const f of list) if (f !== './') await readFile(`${ROOT}/${f}`);
  const app = await readFile(`${ROOT}/app.js`, 'utf8');
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(/.test(app), 'innerHTML en app.js');
});

test('VERSION del service worker coincide con el hash del shell (si falla: node scripts/bump-sw.mjs)', async () => {
  assert.equal(await currentVersion(), await shellVersion());
});
