import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../public/core.js';

const S = { v: 1, id: 'AAAAAAAAAAAAAAAAAAAAAA', key: new Uint8Array(32).fill(7), title: 'Cena', n: 3, startH: 9, endH: 22, startDate: '2026-11-16' };
const person = (pid, name, color, setter) => { const slots = C.emptySlots(S); setter(slots); return { pid, name, color, slots }; };
// marca horas enteras (sus dos medias horas)
const on = (slots, day, ...hours) => hours.forEach((h) => { C.setBit(slots, C.slotIndex(S, day, h, 0), true); C.setBit(slots, C.slotIndex(S, day, h, 1), true); });
// marca medias horas: 10.5 = 10:30-11:00
const onHalf = (slots, day, ...hs) => hs.forEach((h) => C.setBit(slots, C.slotIndex(S, day, Math.floor(h), h % 1 ? 1 : 0), true));

test('fechas: suma, diferencia, día de la semana y meses', () => {
  assert.equal(C.addDays('2026-11-16', 30), '2026-12-16');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(C.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(C.diffDays('2026-03-28', '2026-03-30'), 2); // cambio de hora en España
  assert.equal(C.weekdayMon('2026-11-16'), 0); // lunes
  assert.equal(C.weekdayMon('2026-11-22'), 6); // domingo
  assert.equal(C.weekdayMon('1970-01-01'), 3); // jueves
  assert.equal(C.formatDayShort('2026-11-20'), 'Vie 20 nov');
  assert.equal(C.formatDayLong('2026-11-19'), 'Jueves 19 de noviembre');
  assert.equal(C.todayStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.ok(C.isValidDateStr('2026-02-28'));
  assert.ok(!C.isValidDateStr('2026-02-30'));
  assert.equal(C.todayIndex(S, new Date(2026, 10, 18, 10)), 2);
});

test('slots: índices, bitmap y base64url ida y vuelta', () => {
  assert.equal(C.hoursOf(S), 13);
  assert.equal(C.slotsPerDay(S), 26);
  assert.equal(C.slotCount(S), 806);
  assert.equal(C.slotBytes(S), 101);
  const b = C.emptySlots(S);
  C.setBit(b, C.slotIndex(S, 0, 9), true);
  C.setBit(b, C.slotIndex(S, 29, 21, 1), true);
  assert.equal(C.slotIndex(S, 29, 21, 1), 779);
  assert.equal(C.slotIndex(S, 1, 9, 1), 27);
  const back = C.slotsFromB64(S, C.slotsToB64(b));
  assert.deepEqual([...back], [...b]);
  assert.equal(C.countBits(back), 2);
  assert.throws(() => C.slotsFromB64(S, C.slotsToB64(new Uint8Array(10))));
  C.setDay(S, b, 3, true);
  assert.ok(C.dayHasAny(S, b, 3));
  assert.equal(C.countBits(b), 28);
  C.setDay(S, b, 3, false);
  assert.ok(!C.dayHasAny(S, b, 3));
});

test('semanas L-D: páginas, repetir y borrar semana', () => {
  // 16-11-2026 es lunes: del 16-11 al 16-12 = 31 días = 4 semanas completas + 3 días (lun 14 a mié 16 dic)
  assert.equal(C.weekCount(S), 5);
  assert.equal(C.weekFirstDay(S, 0), 0);
  assert.equal(C.weekFirstDay(S, 4), 28);
  assert.equal(C.weekOfDay(S, 13), 1);
  assert.equal(C.weekOfDay(S, 99), 4);
  // empezando en jueves, la primera semana empieza 3 días antes del inicio
  const SJ = { ...S, startDate: '2026-11-19' };
  assert.equal(C.weekCount(SJ), 5);
  assert.equal(C.weekFirstDay(SJ, 0), -3);
  assert.equal(C.weekOfDay(SJ, 0), 0);
  assert.equal(C.weekOfDay(SJ, 4), 1); // lunes 23
  const b = C.emptySlots(S);
  on(b, 9, 18, 19); // miércoles de la semana 1
  on(b, 2, 10); // miércoles de la semana 0, ya pasado si fromDay = 3
  const changed = C.repeatWeek(S, b, 1, 3);
  // se copia a los miércoles 16, 23 y 30; el 2 es pasado y no se toca
  for (const d of [16, 23, 30]) { assert.ok(C.getBit(b, C.slotIndex(S, d, 18))); assert.ok(C.getBit(b, C.slotIndex(S, d, 19))); }
  assert.ok(!C.getBit(b, C.slotIndex(S, 1, 18)));
  assert.ok(C.getBit(b, C.slotIndex(S, 2, 10)), 'día pasado intacto');
  assert.equal(changed, 12);
  assert.equal(C.clearWeek(S, b, 2), 4);
  assert.ok(!C.getBit(b, C.slotIndex(S, 16, 18)));
  assert.equal(C.clearWeek(S, b, 0, 3), 0); // el día 2 es pasado: no se borra
  assert.ok(C.getBit(b, C.slotIndex(S, 2, 10)));
});

test('enlace: codificar y decodificar (con y sin clave privada)', () => {
  const s = C.newSession({ title: 'Cumple de Lúa', n: 5, startDate: '2026-11-16' });
  const dec = C.decodeLink('#' + C.encodeLink(s));
  assert.equal(dec.session.title, 'Cumple de Lúa');
  assert.equal(dec.session.n, 5);
  assert.equal(dec.session.startH, 8);
  assert.equal(dec.session.endH, 22);
  assert.deepEqual([...dec.session.key], [...s.key]);
  assert.equal(dec.priv, null);
  const priv = 'ab'.repeat(32);
  assert.equal(C.decodeLink(C.encodeLink(s, priv)).priv, priv);
  assert.equal(C.decodeLink('#basura'), null);
  assert.equal(C.decodeLink(''), null);
  const bad = C.bytesToB64u(C.utf8(JSON.stringify([1, s.id, C.bytesToB64u(s.key), 'x', 25, 9, 22, '2026-11-16'])));
  assert.equal(C.decodeLink(bad), null); // más de 20 personas
});

test('validación de nombres y payloads', () => {
  assert.equal(C.validateName('  Ana  ').value, 'Ana');
  assert.ok(!C.validateName('').ok);
  assert.ok(!C.validateName('x'.repeat(25)).ok);
  assert.ok(!C.validateName('ana', ['Ana']).ok);
  const ok = { v: C.PAYLOAD_VERSION, participantId: '0123456789abcdef', name: 'Ana', color: 'blue', slots: C.slotsToB64(C.emptySlots(S)), updatedAt: 1 };
  assert.ok(C.validatePayload(ok, S));
  assert.equal(C.validatePayload({ ...ok, color: 'lila' }, S), null);
  assert.equal(C.validatePayload({ ...ok, slots: 'AAAA' }, S), null);
  assert.equal(C.validatePayload({ ...ok, participantId: 'xyz' }, S), null);
});

test('fusión: gana el más nuevo; empate por created_at y luego id menor', () => {
  const e = (u, c, id) => ({ payload: { updatedAt: u }, event: { created_at: c, id } });
  assert.ok(C.isNewer(e(2, 1, 'b'), e(1, 5, 'a')));
  assert.ok(!C.isNewer(e(1, 9, 'a'), e(2, 1, 'b')));
  assert.ok(C.isNewer(e(1, 6, 'z'), e(1, 5, 'a')));
  assert.ok(C.isNewer(e(1, 5, 'a'), e(1, 5, 'b')));
  assert.ok(C.isNewer(e(1, 1, 'a'), undefined));
});

test('coincidencia total y mapa de calor', () => {
  const a = person('a', 'Ana', 'red', (s) => on(s, 4, 17, 18, 19));
  const b = person('b', 'Bea', 'blue', (s) => on(s, 4, 18, 19, 20));
  const c = person('c', 'Carlos', 'green', (s) => on(s, 4, 18));
  const people = [a, b, c];
  const counts = C.slotCounts(S, people);
  assert.equal(counts[C.slotIndex(S, 4, 18)], 3);
  assert.equal(counts[C.slotIndex(S, 4, 19)], 2);
  const req = C.requiredCount(S, people.length);
  assert.equal(req, 3);
  assert.ok(C.isFull(counts[C.slotIndex(S, 4, 18)], req));
  assert.ok(!C.isFull(counts[C.slotIndex(S, 4, 19)], req));
  assert.ok(C.weekHasFull(S, counts, req, 0));
  assert.ok(!C.weekHasFull(S, counts, req, 1));
  assert.ok(!C.weekHasFull(S, counts, req, 0, 5)); // desde el sábado ya no
  // si la sesión espera 5 personas y solo hay 3, no hay coincidencia total
  const S5 = { ...S, n: 5 };
  assert.ok(!C.isFull(3, C.requiredCount(S5, 3)));
  // si hay más conocidas que las indicadas, cuentan todas
  assert.equal(C.requiredCount(S, 4), 4);
  // con una sola persona no brilla
  assert.ok(!C.isFull(1, 1));
});

test('mejores bloques: orden por personas, duración y fecha; solo desde hoy', () => {
  const a = person('a', 'Ana', 'red', (s) => { on(s, 4, 17, 18, 19); on(s, 1, 10, 11, 12, 13); on(s, 0, 9, 10); });
  const b = person('b', 'Bea', 'blue', (s) => { on(s, 4, 17, 18, 19, 20); on(s, 1, 10, 11, 12, 13); on(s, 0, 9, 10); });
  const c = person('c', 'Carlos', 'green', (s) => { on(s, 4, 18, 19); on(s, 6, 12); });
  const best = C.bestBlocks(S, [a, b, c], { fromDay: 1 });
  assert.deepEqual(best.map((x) => [x.day, x.startH, x.endH, x.count]), [
    [4, 18, 20, 3], [1, 10, 14, 2], [4, 17, 18, 2],
  ]);
  assert.ok(best[0].full);
  assert.equal(C.formatBlock(best[0]), 'Vie 20 nov · 18:00–20:00 · 3/3');
  // hoy desde la hora actual
  const fromNoon = C.bestBlocks(S, [a, b, c], { fromDay: 1, fromHour: 12 });
  assert.deepEqual(fromNoon.find((x) => x.day === 1) && [fromNoon.find((x) => x.day === 1).startH], [12]);
  assert.ok(C.bestBlocks(S, [a, b, c], { fromDay: 0 }).some((x) => x.day === 0));
  assert.equal(C.bestBlocks(S, [a, b, c], { limit: 2 }).length, 2);
});

test('medias horas: bloques con :30, formato y coincidencia por media hora', () => {
  const a = person('a', 'Ana', 'red', (s) => onHalf(s, 3, 10.5, 11, 11.5));
  const b = person('b', 'Bea', 'blue', (s) => onHalf(s, 3, 10, 10.5, 11, 11.5, 12));
  const best = C.bestBlocks(S, [a, b], { fromDay: 0 });
  assert.deepEqual(best.map((x) => [x.day, x.startH, x.endH, x.count]), [[3, 10.5, 12, 2]]);
  assert.equal(C.formatBlock(best[0]), 'Jue 19 nov · 10:30–12:00 · 2/3');
  assert.equal(C.formatTime(9), '9:00');
  assert.equal(C.formatTime(21.5), '21:30');
  assert.equal(C.slotHour(S, 3), 10.5);
  const counts = C.slotCounts(S, [a, b]);
  assert.equal(counts[C.slotIndex(S, 3, 10, 0)], 1);
  assert.equal(counts[C.slotIndex(S, 3, 10, 1)], 2);
  assert.ok(C.isFull(counts[C.slotIndex(S, 3, 10, 1)], 2));
  assert.ok(!C.isFull(counts[C.slotIndex(S, 3, 10, 0)], 2));
  // desde las 11:30 de hoy: solo queda 11:30-12:00
  const late = C.bestBlocks(S, [a, b], { fromDay: 3, fromHour: 11.5 });
  assert.deepEqual(late.map((x) => [x.startH, x.endH]), [[11.5, 12]]);
});

test('formato antiguo por horas: se convierte duplicando cada hora', () => {
  const old = new Uint8Array(Math.ceil(C.daysOf(S) * C.hoursOf(S) / 8));
  C.setBit(old, 2 * 13 + 1, true); // día 2, 10:00 en el formato por horas
  const b64 = C.slotsToB64(old);
  const bits = C.slotsFromB64(S, b64); // copia local antigua: se acepta y convierte
  assert.equal(bits.length, C.slotBytes(S));
  assert.ok(C.getBit(bits, C.slotIndex(S, 2, 10, 0)) && C.getBit(bits, C.slotIndex(S, 2, 10, 1)));
  assert.equal(C.countBits(bits), 2);
  const base = { participantId: '0123456789abcdef', name: 'Ana', color: 'blue', updatedAt: 1 };
  const p1 = C.validatePayload({ ...base, v: 1, slots: b64 }, S);
  assert.ok(p1 && C.getBit(p1.slots, C.slotIndex(S, 2, 10, 1)));
  // un v1 con longitud nueva o un v2 con longitud antigua se ignoran
  assert.equal(C.validatePayload({ ...base, v: 1, slots: C.slotsToB64(C.emptySlots(S)) }, S), null);
  assert.equal(C.validatePayload({ ...base, v: 2, slots: b64 }, S), null);
  assert.equal(C.validatePayload({ ...base, v: 3, slots: C.slotsToB64(C.emptySlots(S)) }, S), null);
});

test('duración: del día de inicio al mismo día del mes siguiente, ambos incluidos', () => {
  assert.equal(C.daysOf({ startDate: '2026-11-17' }), 31); // 17 nov – 17 dic
  assert.equal(C.daysOf({ startDate: '2026-12-17' }), 32); // 17 dic – 17 ene
  assert.equal(C.daysOf({ startDate: '2027-02-17' }), 29); // 17 feb – 17 mar
  assert.equal(C.daysOf({ startDate: '2027-01-31' }), 29); // 31 ene – 28 feb
  // un horario guardado con 30 días se lee y el día que falta queda vacío
  const old = new Uint8Array(Math.ceil(30 * C.slotsPerDay(S) / 8)); C.setBit(old, 5, true);
  const bits = C.slotsFromB64(S, C.slotsToB64(old));
  assert.equal(bits.length, C.slotBytes(S)); assert.equal(C.countBits(bits), 1);
});
