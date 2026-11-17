// Genera los iconos PNG de la PWA sin dependencias (zlib de Node). Uso: node scripts/icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const over = (dst, src, a) => dst.map((v, i) => v * (1 - a) + src[i] * a);

const BG1 = hex('#5e5ce6'); const BG2 = hex('#0a84ff'); const BG3 = hex('#bf5af2');
const CIRCLES = [
  { x: 0.38, y: 0.42, r: 0.2, c: hex('#ff9f0a') },
  { x: 0.62, y: 0.42, r: 0.2, c: hex('#ff375f') },
  { x: 0.5, y: 0.63, r: 0.2, c: hex('#63e6e2') },
];

/** Color (rgb) y alfa de un punto en coordenadas 0..1. full = sin esquinas transparentes. */
function shade(u, v, { full, scale }) {
  // fondo: degradado diagonal con un brillo suave arriba a la izquierda
  let col = mix(BG1, BG2, Math.min(1, Math.max(0, (u + v) / 2)));
  col = mix(col, BG3, Math.max(0, 1 - Math.hypot(u - 1, v - 1) * 1.6) * 0.5);
  col = mix(col, [1, 1, 1], Math.max(0, 1 - Math.hypot(u - 0.2, v - 0.1) * 2.2) * 0.22);
  let alpha = 1;
  if (!full) {
    // cuadrado redondeado (radio 22 %)
    const r = 0.22; const qx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0); const qy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    if (Math.hypot(qx, qy) > r) alpha = 0;
  }
  // contenido centrado, escalado para la zona segura del icono maskable
  const cu = (u - 0.5) / scale + 0.5; const cv = (v - 0.5) / scale + 0.5;
  for (const c of CIRCLES) {
    const d = Math.hypot(cu - c.x, cv - c.y);
    if (d < c.r) col = over(col, c.c, 0.86);
    else if (d < c.r + 0.012) col = over(col, [1, 1, 1], 0.25 * (1 - (d - c.r) / 0.012));
  }
  // brillo central donde coinciden los tres
  const g = Math.hypot(cu - 0.5, cv - 0.49);
  col = over(col, [1, 1, 1], Math.max(0, 1 - g / 0.11) ** 1.6 * 0.95);
  return [col, alpha];
}

function render(size, opts) {
  const SS = 4; const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const [c, al] = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opts);
      r += c[0] * al; g += c[1] * al; b += c[2] * al; a += al;
    }
    const o = (y * size + x) * 4; const n = SS * SS;
    buf[o] = a ? Math.round((r / a) * 255) : 0; buf[o + 1] = a ? Math.round((g / a) * 255) : 0; buf[o + 2] = a ? Math.round((b / a) * 255) : 0; buf[o + 3] = Math.round((a / n) * 255);
  }
  return png(size, buf);
}

mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, { full: false, scale: 1 }],
  ['icon-512.png', 512, { full: false, scale: 1 }],
  ['icon-maskable-512.png', 512, { full: true, scale: 0.8 }],
  ['apple-touch-icon.png', 180, { full: true, scale: 0.92 }],
];
for (const [name, size, opts] of jobs) { const data = render(size, opts); writeFileSync(path.join(OUT, name), data); console.log(name, size, data.length, 'bytes'); }
