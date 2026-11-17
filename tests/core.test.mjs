import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../public/core.js';

const S = { v: 1, id: 'AAAAAAAAAAAAAAAAAAAAAA', key: new Uint8Array(32).fill(7), title: 'Cena', n: 3, startH: 9, endH: 22, startDate: '2026-11-16' };
const person = (pid, name, color, setter) => { const slots = C.emptySlots(S); setter(slots); return { pid, name, color, slots }; };
const on = (slots, day, ...hours) => hours.forEach((h) => C.setBit(slots, C.slotIndex(S, day, h), true));

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
  assert.equal(C.slotCount(S), 390);
  assert.equal(C.slotBytes(S), 49);
  const b = C.emptySlots(S);
  C.setBit(b, C.slotIndex(S, 0, 9), true);
  C.setBit(b, C.slotIndex(S, 29, 21), true);
  assert.equal(C.slotIndex(S, 29, 21), 389);
  const back = C.slotsFromB64(S, C.slotsToB64(b));
  assert.deepEqual([...back], [...b]);
  assert.equal(C.countBits(back), 2);
  assert.throws(() => C.slotsFromB64(S, C.slotsToB64(new Uint8Array(10))));
  C.setDay(S, b, 3, true);
  assert.ok(C.dayHasAny(S, b, 3));
  assert.equal(C.countBits(b), 15);
  C.setDay(S, b, 3, false);
  assert.ok(!C.dayHasAny(S, b, 3));
});

test('semanas L-D: páginas, repetir y borrar semana', () => {
  // 16-11-2026 es lunes: 30 días = 4 semanas completas + 2 días (lun 14 y mar 15 dic)
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
  // se copia a los miércoles 16 y 23; el 2 es pasado y no se toca
  for (const d of [16, 23]) { assert.ok(C.getBit(b, C.slotIndex(S, d, 18))); assert.ok(C.getBit(b, C.slotIndex(S, d, 19))); }
  assert.ok(!C.getBit(b, C.slotIndex(S, 1, 18)));
  assert.ok(C.getBit(b, C.slotIndex(S, 2, 10)), 'día pasado intacto');
  assert.equal(changed, 4);
  assert.equal(C.clearWeek(S, b, 2), 2);
  assert.ok(!C.getBit(b, C.slotIndex(S, 16, 18)));
  assert.equal(C.clearWeek(S, b, 0, 3), 0); // el día 2 es pasado: no se borra
  assert.ok(C.getBit(b, C.slotIndex(S, 2, 10)));
});

test('enlace: codificar y decodificar (con y sin clave privada)', () => {
  const s = C.newSession({ title: 'Cumple de Lúa', n: 5, startDate: '2026-11-16' });
  const dec = C.decodeLink('#' + C.encodeLink(s));
  assert.equal(dec.session.title, 'Cumple de Lúa');
  assert.equal(dec.session.n, 5);
  assert.equal(dec.session.startH, 9);
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
  const ok = { v: 1, participantId: '0123456789abcdef', name: 'Ana', color: 'blue', slots: C.slotsToB64(C.emptySlots(S)), updatedAt: 1 };
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
