// Pone en public/sw.js un VERSION calculado con el hash del shell, para que cada cambio publicado
// genere un service worker nuevo (y el aviso "Hay una versión nueva"). Uso: node scripts/bump-sw.mjs
// Un test (tests/serve.test.mjs) falla si VERSION no coincide con el contenido actual.
import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const VERSION_RE = /const VERSION = '([^']*)';/;

export function shellList(swText) {
  return JSON.parse('[' + swText.match(/const SHELL = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
}

/** Hash de los archivos del shell (sin sw.js) y del resto de sw.js sin la línea VERSION. Fin de línea normalizado. */
export async function shellVersion(root = ROOT) {
  const sw = await readFile(path.join(root, 'sw.js'), 'utf8');
  const h = crypto.createHash('sha256');
  h.update(sw.replace(VERSION_RE, '').replace(/\r\n/g, '\n'));
  for (const f of shellList(sw)) {
    if (f === './') continue;
    let buf = await readFile(path.join(root, f));
    if (!/\.png$/.test(f)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'));
    h.update(f + '\0'); h.update(buf);
  }
  return 'quedamos-' + h.digest('hex').slice(0, 12);
}

export async function currentVersion(root = ROOT) {
  return (await readFile(path.join(root, 'sw.js'), 'utf8')).match(VERSION_RE)[1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(ROOT, 'sw.js');
  const v = await shellVersion();
  const sw = await readFile(file, 'utf8');
  await writeFile(file, sw.replace(VERSION_RE, `const VERSION = '${v}';`));
  console.log('VERSION =', v);
}
