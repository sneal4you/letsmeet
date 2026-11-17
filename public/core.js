// core.js - lógica pura de Quedamos (sin DOM, sin red). Se usa en el navegador y en los tests de Node.

export const FORMAT_VERSION = 1; // versión del enlace
// Versión del horario enviado: 1 = una casilla por hora (antiguo), 2 = una por media hora.
export const PAYLOAD_VERSION = 2;
export const SLOTS_PER_HOUR = 2;
/** Días de una quedada: del día de inicio al mismo día del mes siguiente, ambos incluidos (29 a 32). */
export function daysOf(session) {
  const { y, m, d } = dateParts(session.startDate);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const end = `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  return diffDays(session.startDate, end) + 1;
}
export const MIN_PEOPLE = 2;
export const MAX_PEOPLE = 20;
export const NAME_MAX = 24;
export const TITLE_MAX = 60;

// Kind NIP-78 (parameterized replaceable). Ver README: se comprobó contra relés reales.
export const KIND = 30078;

// Relés públicos de Nostr usados como buzón cifrado. Si se cambian aquí, actualizar también
// el connect-src de la CSP en index.html.
// Prueba real del 16-11-2026 (scripts/live-test.mjs, kind 30078): nos.lol, relay.primal.net, nostr.mom,
// relay.snort.social y offchain.pub aceptaron y devolvieron el evento. relay.damus.io respondía 503 al
// WebSocket en ese momento (se mantiene: suele ser temporal). relay.nostr.band no conectaba: retirado.
export const RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://relay.damus.io',
];

// 12 colores tipo "Apple system colors". light/dark: tono para cada modo; ink: color de texto encima.
export const COLORS = [
  { id: 'red', name: 'Rojo', light: '#FF3B30', dark: '#FF453A', ink: '#ffffff' },
  { id: 'orange', name: 'Naranja', light: '#FF9500', dark: '#FF9F0A', ink: '#1c1c1e' },
  { id: 'yellow', name: 'Amarillo', light: '#FFCC00', dark: '#FFD60A', ink: '#1c1c1e' },
  { id: 'green', name: 'Verde', light: '#34C759', dark: '#30D158', ink: '#0b2a14' },
  { id: 'mint', name: 'Menta', light: '#00C7BE', dark: '#63E6E2', ink: '#05302e' },
  { id: 'cyan', name: 'Cian', light: '#32ADE6', dark: '#64D2FF', ink: '#062a3a' },
  { id: 'blue', name: 'Azul', light: '#007AFF', dark: '#0A84FF', ink: '#ffffff' },
  { id: 'indigo', name: 'Índigo', light: '#5856D6', dark: '#5E5CE6', ink: '#ffffff' },
  { id: 'purple', name: 'Morado', light: '#AF52DE', dark: '#BF5AF2', ink: '#ffffff' },
  // Rosa más magenta que el systemPink de Apple (#FF2D55), que casi no se distinguía del rojo.
  { id: 'pink', name: 'Rosa', light: '#FF2D92', dark: '#FF4FA8', ink: '#ffffff' },
  { id: 'brown', name: 'Marrón', light: '#A2845E', dark: '#AC8E68', ink: '#ffffff' },
  { id: 'graphite', name: 'Grafito', light: '#636366', dark: '#AEAEB2', ink: '#ffffff' },
];
export const COLOR_IDS = COLORS.map((c) => c.id);

export const WEEKDAYS_LONG = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
export const WEEKDAYS_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
export const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

// ---------- bytes / base64url / hex ----------
export function bytesToB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uToBytes(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('base64url inválido');
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('hex inválido');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function utf8(str) { return new TextEncoder().encode(str); }
export function fromUtf8(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
export function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }

// ---------- fechas (cadenas YYYY-MM-DD en hora local, sin problemas de horario de verano) ----------
const DAY_MS = 86400000;
function pad2(n) { return String(n).padStart(2, '0'); }
export function dateToStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function todayStr(now = new Date()) { return dateToStr(now); }
export function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function dayNumber(s) { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY_MS); }
function fromDayNumber(n) {
  const t = new Date(n * DAY_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
export function addDays(s, n) { return fromDayNumber(dayNumber(s) + n); }
export function diffDays(a, b) { return dayNumber(b) - dayNumber(a); }
/** 0 = lunes ... 6 = domingo */
export function weekdayMon(s) { return ((Math.round(dayNumber(s)) % 7) + 7 + 3) % 7; }
export function dateParts(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
export function dayDate(session, dayIdx) { return addDays(session.startDate, dayIdx); }
export function todayIndex(session, now = new Date()) { return diffDays(session.startDate, todayStr(now)); }
export function formatDayShort(s) { const { m, d } = dateParts(s); return `${WEEKDAYS_SHORT[weekdayMon(s)]} ${d} ${MONTHS_SHORT[m - 1]}`; }
export function formatDayLong(s) { const { m, d } = dateParts(s); const w = WEEKDAYS_LONG[weekdayMon(s)]; return `${w[0].toUpperCase()}${w.slice(1)} ${d} de ${MONTHS_LONG[m - 1]}`; }
export function formatHour(h) { return `${pad2(h)}:00`; }
/** Hora con medias (10.5 -> "10:30"), sin cero delante. */
export function formatTime(h) { const m = Math.round((h % 1) * 60); return `${Math.floor(h)}:${pad2(m)}`; }

// ---------- slots (bitmap de días × medias horas del rango) ----------
export function hoursOf(session) { return session.endH - session.startH; }
/** Casillas (medias horas) por día. */
export function slotsPerDay(session) { return hoursOf(session) * SLOTS_PER_HOUR; }
export function slotCount(session) { return daysOf(session) * slotsPerDay(session); }
export function slotBytes(session) { return Math.ceil(slotCount(session) / 8); }
/** half: 0 = en punto, 1 = y media. */
export function slotIndex(session, day, hour, half = 0) { return day * slotsPerDay(session) + (hour - session.startH) * SLOTS_PER_HOUR + half; }
/** Hora (con decimales) en la que empieza la casilla k del día. */
export function slotHour(session, k) { return session.startH + k / SLOTS_PER_HOUR; }
export function emptySlots(session) { return new Uint8Array(slotBytes(session)); }
export function getBit(bits, i) { return (bits[i >> 3] >> (i & 7)) & 1; }
export function setBit(bits, i, on) { if (on) bits[i >> 3] |= 1 << (i & 7); else bits[i >> 3] &= ~(1 << (i & 7)); }
export function countBits(bits) { let c = 0; for (const b of bits) { let x = b; while (x) { c += x & 1; x >>= 1; } } return c; }
export function slotsToB64(bits) { return bytesToB64u(bits); }
function legacyBytes(session, days = daysOf(session)) { return Math.ceil(days * hoursOf(session) / 8); }
function padTo(bits, n) { const out = new Uint8Array(n); out.set(bits.subarray(0, n)); return out; }
/** Convierte un bitmap antiguo (una casilla por hora) al actual: cada hora marca sus dos medias horas. */
export function expandHourly(session, old) {
  const out = emptySlots(session);
  const total = daysOf(session) * hoursOf(session);
  for (let i = 0; i < total; i++) if (getBit(old, i)) for (let s = 0; s < SLOTS_PER_HOUR; s++) setBit(out, i * SLOTS_PER_HOUR + s, true);
  return out;
}
/**
 * Lee un bitmap. Por defecto acepta también el formato antiguo por horas (copias locales guardadas antes
 * del cambio) y lo convierte. legacy: true = exige el antiguo; false = exige el actual.
 */
export function slotsFromB64(session, str, { legacy } = {}) {
  let bits = b64uToBytes(str);
  // Horarios guardados con otra duración (antes eran 30 días fijos): se ajustan; los días que faltan quedan vacíos.
  const n = slotBytes(session), spd = slotsPerDay(session);
  if (legacy !== true && bits.length !== n) for (let d = 28; d <= 32; d++) if (bits.length === Math.ceil(d * spd / 8)) { bits = padTo(bits, n); break; }
  if (legacy !== false && bits.length !== n) {
    for (let d = 28; d <= 32; d++) if (bits.length === legacyBytes(session, d)) return expandHourly(session, padTo(bits, legacyBytes(session)));
  }
  if (legacy === true || bits.length !== slotBytes(session)) throw new Error('longitud de slots incorrecta');
  const total = slotCount(session);
  // limpiar bits sobrantes del último byte
  for (let i = total; i < bits.length * 8; i++) setBit(bits, i, false);
  return bits;
}
export function dayHasAny(session, bits, day) {
  const h = slotsPerDay(session);
  for (let i = day * h; i < (day + 1) * h; i++) if (getBit(bits, i)) return true;
  return false;
}
export function setDay(session, bits, day, on) {
  const h = slotsPerDay(session);
  for (let i = day * h; i < (day + 1) * h; i++) setBit(bits, i, on);
}
// ---------- semanas (lunes a domingo) ----------
// Los índices de día son relativos a startDate y pueden caer fuera de [0, daysOf(session)) en la primera y la última semana.
/** Nº de semanas L–D que tocan la ventana de la quedada. */
export function weekCount(session) { return Math.ceil((weekdayMon(session.startDate) + daysOf(session)) / 7); }
/** Índice (relativo a startDate) del lunes de la semana `w`; negativo si la semana empieza antes del inicio. */
export function weekFirstDay(session, w) { return w * 7 - weekdayMon(session.startDate); }
/** Semana que contiene el día `day` (acotada a las semanas de la ventana). */
export function weekOfDay(session, day) {
  const w = Math.floor((day + weekdayMon(session.startDate)) / 7);
  return Math.min(weekCount(session) - 1, Math.max(0, w));
}
/**
 * Copia el patrón de la semana `w` a las demás semanas (cada día a ese mismo día de la semana).
 * Solo escribe en días de la ventana desde `fromDay` (no toca días pasados); un día de origen fuera de
 * la ventana no se copia. Devuelve el nº de casillas cambiadas.
 */
export function repeatWeek(session, bits, w, fromDay = 0) {
  const h = slotsPerDay(session);
  const first = weekFirstDay(session, w);
  let changed = 0;
  for (let wd = 0; wd < 7; wd++) {
    const src = first + wd;
    if (src < 0 || src >= daysOf(session)) continue;
    for (let o = 0; o < weekCount(session); o++) {
      if (o === w) continue;
      const dst = weekFirstDay(session, o) + wd;
      if (dst < Math.max(0, fromDay) || dst >= daysOf(session)) continue;
      for (let k = 0; k < h; k++) {
        const v = getBit(bits, src * h + k);
        if (getBit(bits, dst * h + k) !== v) { setBit(bits, dst * h + k, !!v); changed++; }
      }
    }
  }
  return changed;
}
/** Borra la semana `w` (solo días de la ventana desde `fromDay`). Devuelve el nº de casillas borradas. */
export function clearWeek(session, bits, w, fromDay = 0) {
  const h = slotsPerDay(session);
  const first = weekFirstDay(session, w);
  let changed = 0;
  for (let d = Math.max(first, fromDay, 0); d < Math.min(first + 7, daysOf(session)); d++) {
    for (let i = d * h; i < (d + 1) * h; i++) if (getBit(bits, i)) { setBit(bits, i, false); changed++; }
  }
  return changed;
}
/** true si en la semana `w` hay alguna hora (desde `fromDay`) en la que coinciden todos. */
export function weekHasFull(session, counts, required, w, fromDay = 0) {
  const h = slotsPerDay(session);
  const first = weekFirstDay(session, w);
  for (let d = Math.max(first, fromDay, 0); d < Math.min(first + 7, daysOf(session)); d++) {
    for (let i = d * h; i < (d + 1) * h; i++) if (isFull(counts[i], required)) return true;
  }
  return false;
}

// ---------- validación ----------
export function cleanName(name) { return String(name ?? '').replace(/\s+/g, ' ').trim(); }
export function validateName(name, others = []) {
  const n = cleanName(name);
  if (n.length < 1) return { ok: false, error: 'Escribe tu nombre.' };
  if ([...n].length > NAME_MAX) return { ok: false, error: `Máximo ${NAME_MAX} caracteres.` };
  const low = n.toLocaleLowerCase('es');
  if (others.some((o) => cleanName(o).toLocaleLowerCase('es') === low)) return { ok: false, error: 'Ese nombre ya lo usa otra persona del grupo.' };
  return { ok: true, value: n };
}
export function validateTitle(t) {
  const s = cleanName(t);
  if (!s) return { ok: false, error: 'Ponle un título.' };
  if ([...s].length > TITLE_MAX) return { ok: false, error: `Máximo ${TITLE_MAX} caracteres.` };
  return { ok: true, value: s };
}
export const PID_RE = /^[0-9a-f]{16}$/;
/** El participantId se deriva de la clave pública: así una clave distinta no puede suplantarlo. */
export function pidFromPubkey(pubHex) { return pubHex.slice(0, 16); }

export function validatePayload(p, session) {
  if (!p || typeof p !== 'object') return null;
  if (p.v !== 1 && p.v !== PAYLOAD_VERSION) return null;
  if (typeof p.participantId !== 'string' || !PID_RE.test(p.participantId)) return null;
  const nm = validateName(p.name);
  if (!nm.ok) return null;
  if (!COLOR_IDS.includes(p.color)) return null;
  if (!Number.isSafeInteger(p.updatedAt) || p.updatedAt <= 0) return null;
  let slots;
  // v1 (por horas) se convierte duplicando cada hora en sus dos medias horas
  try { slots = slotsFromB64(session, p.slots, { legacy: p.v === 1 }); } catch { return null; }
  // left: la persona ha salido de la quedada (evento de baja con slots vacíos)
  if (p.left !== undefined && p.left !== true) return null;
  return { participantId: p.participantId, name: nm.value, color: p.color, slots, updatedAt: p.updatedAt, left: p.left === true };
}

// ---------- enlace de la sesión ----------
/** session: {v,id,key(Uint8Array 32),title,n,startH,endH,startDate} */
export function encodeLink(session, privHex) {
  const arr = [FORMAT_VERSION, session.id, bytesToB64u(session.key), session.title, session.n, session.startH, session.endH, session.startDate];
  if (privHex) arr.push(privHex);
  return bytesToB64u(utf8(JSON.stringify(arr)));
}
export function decodeLink(hash) {
  try {
    let s = String(hash || '');
    if (s.startsWith('#')) s = s.slice(1);
    if (!s) return null;
    const arr = JSON.parse(fromUtf8(b64uToBytes(s)));
    if (!Array.isArray(arr) || arr[0] !== FORMAT_VERSION) return null;
    const [, id, keyB64, title, n, startH, endH, startDate, priv] = arr;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(id)) return null;
    const key = b64uToBytes(keyB64);
    if (key.length !== 32) return null;
    const t = validateTitle(title);
    if (!t.ok) return null;
    if (!Number.isInteger(n) || n < MIN_PEOPLE || n > MAX_PEOPLE) return null;
    if (!Number.isInteger(startH) || !Number.isInteger(endH) || startH < 0 || endH > 24 || endH <= startH) return null;
    if (!isValidDateStr(startDate)) return null;
    if (priv !== undefined && (typeof priv !== 'string' || !/^[0-9a-f]{64}$/.test(priv))) return null;
    return { session: { v: FORMAT_VERSION, id, key, title: t.value, n, startH, endH, startDate }, priv: priv || null };
  } catch { return null; }
}
export function newSession({ title, n, startH = 8, endH = 22, startDate = todayStr() }) {
  return { v: FORMAT_VERSION, id: bytesToB64u(randomBytes(16)), key: randomBytes(32), title, n, startH, endH, startDate };
}

// ---------- fusión ----------
/**
 * Decide si `cand` debe sustituir a `cur` (entradas {payload:{updatedAt}, event:{created_at,id}}).
 * Gana el updatedAt mayor; empate: created_at mayor; empate: id menor (regla NIP-01).
 */
export function isNewer(cand, cur) {
  if (!cur) return true;
  if (cand.payload.updatedAt !== cur.payload.updatedAt) return cand.payload.updatedAt > cur.payload.updatedAt;
  if (cand.event.created_at !== cur.event.created_at) return cand.event.created_at > cur.event.created_at;
  return cand.event.id < cur.event.id;
}

// ---------- coincidencias ----------
/** people: [{pid,name,color,slots}] */
export function requiredCount(session, knownCount) { return Math.max(session.n, knownCount); }
export function isFull(count, required) { return required >= 2 && count >= required; }
export function slotCounts(session, people) {
  const total = slotCount(session);
  const counts = new Uint8Array(total);
  for (const p of people) for (let i = 0; i < total; i++) if (getBit(p.slots, i)) counts[i]++;
  return counts;
}
export function whoAt(people, i) { return people.filter((p) => getBit(p.slots, i)); }
/**
 * Mejores bloques: medias horas consecutivas del mismo día con exactamente el mismo grupo de personas.
 * startH/endH son horas con decimales (10.5 = 10:30).
 * Orden: nº de personas desc, duración desc, fecha más cercana, hora más temprana.
 * fromDay/fromHour: solo desde hoy (y desde la hora actual, admite medias, en el día de hoy).
 */
export function bestBlocks(session, people, { fromDay = 0, fromHour = 0, limit = 5 } = {}) {
  const h = slotsPerDay(session);
  const step = 1 / SLOTS_PER_HOUR;
  const required = requiredCount(session, people.length);
  const minCount = people.length >= 2 ? 2 : 1;
  const blocks = [];
  for (let day = Math.max(0, fromDay); day < daysOf(session); day++) {
    let cur = null;
    const close = () => { if (cur && cur.pids.length >= minCount) blocks.push(cur); cur = null; };
    for (let k = 0; k < h; k++) {
      const hour = slotHour(session, k);
      if (day === fromDay && hour < fromHour) { close(); continue; }
      const i = day * h + k;
      const pids = people.filter((p) => getBit(p.slots, i)).map((p) => p.pid);
      const key = pids.join(',');
      if (cur && cur.key === key) { cur.endH = hour + step; continue; }
      close();
      if (pids.length) cur = { day, date: dayDate(session, day), startH: hour, endH: hour + step, pids, key };
    }
    close();
  }
  for (const b of blocks) { b.count = b.pids.length; b.full = isFull(b.count, required); b.required = required; delete b.key; }
  blocks.sort((a, b) => (b.count - a.count) || ((b.endH - b.startH) - (a.endH - a.startH)) || (a.day - b.day) || (a.startH - b.startH));
  return blocks.slice(0, limit);
}
export function formatBlock(b) {
  return `${formatDayShort(b.date)} · ${formatTime(b.startH)}–${formatTime(b.endH)} · ${b.count}/${b.required}`;
}
