// Tres "móviles" contra dos relés falsos en memoria (WebSocket real de Node contra servidor propio).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeRelay } from './fake-relay.mjs';
import { SyncEngine } from '../public/sync.js';
import { memoryStore } from '../public/store.js';
import * as C from '../public/core.js';
import * as K from '../public/crypto.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 4000, what = 'condición') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return; await wait(20); }
  throw new Error('Tiempo agotado esperando: ' + what);
}

const session = C.newSession({ title: 'Cena de prueba', n: 3, startDate: '2026-11-16' });
const fast = { backoffBase: 30, backoffMax: 200, sendTimeout: 400, retryDelay: 150, connectTimeout: 1000 };
let relays = [];
const engines = [];

function phone(name, color, store = memoryStore(), identity = K.newIdentity()) {
  const eng = new SyncEngine({ session, store, relays: relays.map((r) => r.url), ...fast });
  engines.push(eng);
  const slots = C.emptySlots(session);
  return { name, color, store, identity, eng, slots };
}
async function send(p, hours, updatedAt = Date.now()) {
  p.slots = C.emptySlots(session);
  for (const [d, h] of hours) C.setBit(p.slots, C.slotIndex(session, d, h), true);
  return p.eng.publish({ name: p.name, color: p.color, slots: p.slots, updatedAt }, p.identity);
}
const names = (eng) => eng.people().map((x) => x.name).sort();

test.before(async () => { relays = [await new FakeRelay().listen(), await new FakeRelay().listen()]; });
test.after(async () => { for (const e of engines) e.stop(); for (const r of relays) await r.close(); });

test('A crea, B y C se unen; C estaba desconectado y recibe al conectarse; gossip; eventos falsos y viejos', async (t) => {
  const A = phone('Ana', 'red');
  const B = phone('Bea', 'blue');
  const Cc = phone('Carlos', 'green');

  await A.eng.init(); A.eng.start();
  await until(() => A.eng.connection().open === 2, 4000, 'A conectada');
  await send(A, [[3, 18], [3, 19]]);
  await until(() => A.eng.status === 'sent', 4000, 'A enviado');

  await B.eng.init(); B.eng.start();
  await until(() => names(B.eng).includes('Ana'), 4000, 'B ve a Ana');
  await send(B, [[3, 18], [3, 19], [3, 20]]);
  await until(() => B.eng.status === 'sent', 4000, 'B enviado');
  await until(() => names(A.eng).includes('Bea'), 4000, 'A recibe a Bea en vivo');

  await t.test('C (desconectado mientras B enviaba) recibe todo al conectarse', async () => {
    await Cc.eng.init(); Cc.eng.start();
    await until(() => names(Cc.eng).join() === 'Ana,Bea', 4000, 'C recibe a Ana y Bea');
    await send(Cc, [[3, 18], [3, 19]]);
    await until(() => names(A.eng).length === 3 && names(B.eng).length === 3, 4000, 'todos ven a todos');
    const people = A.eng.people();
    const counts = C.slotCounts(session, people);
    const req = C.requiredCount(session, people.length);
    assert.ok(C.isFull(counts[C.slotIndex(session, 3, 18)], req));
    assert.ok(!C.isFull(counts[C.slotIndex(session, 3, 20)], req));
  });

  const bOriginal = B.eng.events[B.identity.pid];

  await t.test('los relés olvidan; A al abrir re-publica tal cual (gossip) y un móvil nuevo de C lo recupera', async () => {
    for (const r of relays) r.forget();
    // A cierra y vuelve a abrir la app (mismo almacenamiento)
    A.eng.stop();
    const A2 = new SyncEngine({ session, store: A.store, relays: relays.map((r) => r.url), ...fast });
    engines.push(A2);
    await A2.init();
    assert.equal(names(A2).length, 3, 'A conserva las 3 personas sin red');
    const gossips = [];
    A2.on((type, d) => { if (type === 'gossip') gossips.push(d.count); });
    A2.start();
    await until(() => gossips.length === 2, 4000, 'gossip en los dos relés');
    assert.deepEqual(gossips, [3, 3]);
    // C con un móvil nuevo y sin datos
    const Cnew = phone('Carlos', 'green', memoryStore(), Cc.identity);
    await Cnew.eng.init(); Cnew.eng.start();
    await until(() => names(Cnew.eng).length === 3, 4000, 'C nuevo recupera los 3');
    const got = Cnew.eng.events[B.identity.pid];
    assert.equal(got.id, bOriginal.id, 'mismo id');
    assert.equal(got.sig, bOriginal.sig, 'misma firma original');
    // sin bucles: el gossip solo ocurre una vez por apertura
    const before = relays[0].received.length;
    await wait(300);
    assert.equal(relays[0].received.length, before);
    // y C recupera su propio horario (identidad recuperada)
    assert.equal(Cnew.eng.participants.get(Cc.identity.pid).name, 'Carlos');
  });

  await t.test('se ignoran: firma falsa, descifrado imposible, otra clave con el mismo participante', async () => {
    const topic = A.eng.topic;
    const mallory = K.newIdentity();
    const other = await K.deriveSessionKeys(C.randomBytes(32), session.id);
    const pl = (pid) => ({ v: 1, participantId: pid, name: 'Intruso', color: 'pink', slots: C.slotsToB64(C.emptySlots(session)), updatedAt: Date.now() + 10000 });
    const tags = (pid) => [['d', `${topic}:${pid}`], ['t', topic]];
    const now = Math.floor(Date.now() / 1000);
    // 1) firma falsa
    const good = await K.signEvent({ kind: C.KIND, tags: tags(mallory.pid), content: await K.encryptJSON(A.eng.encKey, pl(mallory.pid)), created_at: now }, mallory.priv);
    const badSig = { ...good, sig: good.sig.slice(0, -2) + (good.sig.endsWith('00') ? '11' : '00') };
    // 2) firma buena pero cifrado con otra clave
    const wrongKey = await K.signEvent({ kind: C.KIND, tags: tags(mallory.pid), content: await K.encryptJSON(other.encKey, pl(mallory.pid)), created_at: now }, mallory.priv);
    // 3) otra clave que dice ser B
    const fakeB = await K.signEvent({ kind: C.KIND, tags: tags(B.identity.pid), content: await K.encryptJSON(A.eng.encKey, pl(B.identity.pid)), created_at: now + 5 }, mallory.priv);
    for (const ev of [badSig, wrongKey, fakeB]) relays[0].inject(ev);
    await wait(400);
    for (const e of [B.eng, Cc.eng]) {
      assert.equal(e.people().length, 3);
      assert.ok(!names(e).includes('Intruso'));
      assert.equal(e.participants.get(B.identity.pid).name, 'Bea');
    }
  });

  await t.test('un evento viejo no pisa uno nuevo', async () => {
    const v1 = B.eng.events[B.identity.pid];
    await send(B, [[5, 12]], Date.now() + 1);
    await until(() => Cc.eng.participants.get(B.identity.pid).event.id !== v1.id, 4000, 'C recibe la versión nueva de B');
    const v2id = Cc.eng.participants.get(B.identity.pid).event.id;
    relays[0].inject(v1); relays[1].inject(v1);
    await wait(300);
    assert.equal(Cc.eng.participants.get(B.identity.pid).event.id, v2id);
    assert.ok(C.getBit(Cc.eng.participants.get(B.identity.pid).slots, C.slotIndex(session, 5, 12)));
    // directamente por ingest también
    assert.equal(await Cc.eng.ingest(v1), false);
  });
});

test('sin conexión: queda en cola persistente y se envía al volver el relé', async () => {
  const r = await new FakeRelay().listen();
  const port = r.port; const url = r.url;
  await r.close();
  const store = memoryStore();
  const id = K.newIdentity();
  const eng = new SyncEngine({ session, store, relays: [url], ...fast });
  engines.push(eng);
  await eng.init(); eng.start();
  await eng.publish({ name: 'Dani', color: 'purple', slots: C.emptySlots(session), updatedAt: Date.now() }, id);
  assert.equal(eng.status, 'queued');
  assert.ok(await store.get(`out:${session.id}`), 'cola guardada');
  // se cierra la app con la cola pendiente y se vuelve a abrir
  eng.stop();
  const eng2 = new SyncEngine({ session, store, relays: [url], ...fast });
  engines.push(eng2);
  await eng2.init();
  assert.equal(eng2.status, 'queued');
  eng2.start();
  const r2 = await new FakeRelay().listen(port);
  try {
    await until(() => eng2.status === 'sent', 5000, 'enviado al volver la red');
    assert.equal(await store.get(`out:${session.id}`), undefined);
    assert.equal(r2.received.length >= 1, true);
  } finally { eng2.stop(); await r2.close(); }
});

test('una copia falsificada con el mismo id no bloquea el evento auténtico', async () => {
  const B = new SyncEngine({ session, store: memoryStore(), relays: [], ...fast });
  const A = new SyncEngine({ session, store: memoryStore(), relays: [], ...fast });
  engines.push(A, B);
  await B.init(); await A.init();
  const ev = await B.publish({ name: 'Bea', color: 'blue', slots: C.emptySlots(session), updatedAt: Date.now() }, K.newIdentity());
  assert.equal(await A.ingest({ ...ev, sig: '0'.repeat(128) }), false);
  assert.equal(await A.ingest(ev), true);
  assert.deepEqual(names(A), ['Bea']);
});

test('se descartan mensajes y contenidos demasiado grandes sin procesarlos', async () => {
  const A = new SyncEngine({ session, store: memoryStore(), relays: [], ...fast });
  engines.push(A);
  await A.init();
  const id = K.newIdentity();
  const big = await K.signEvent({ kind: C.KIND, tags: [['d', `${A.topic}:${id.pid}`], ['t', A.topic]], content: 'A'.repeat(8 * 1024 * 1024), created_at: Math.floor(Date.now() / 1000) }, id.priv);
  const t0 = Date.now();
  assert.equal(await A.ingest(big), false);
  assert.ok(Date.now() - t0 < 50, 'no se verifica ni se descifra');
});

test('al volver de segundo plano llegan eventos con created_at antiguo (cola sin red) y con relojes adelantados', async () => {
  const r = await new FakeRelay().listen();
  const mk = (now) => { const e = new SyncEngine({ session, store: memoryStore(), relays: [r.url], ...fast, ...(now ? { now } : {}) }); engines.push(e); return e; };
  const A = mk(); const D = mk(() => Date.now() + 6 * 3600e3); const B = mk(() => Date.now() - 3600e3); const E = mk();
  try {
    for (const e of [A, D]) { await e.init(); e.start(); }
    await until(() => A.connection().open === 1 && D.connection().open === 1, 3000, 'conectados');
    await D.publish({ name: 'Dani', color: 'red', slots: C.emptySlots(session), updatedAt: Date.now() }, K.newIdentity());
    await until(() => names(A).includes('Dani'), 3000, 'A recibe a Dani (reloj +6 h)');
    A.pause();
    for (const e of [B, E]) { await e.init(); e.start(); }
    await B.publish({ name: 'Bea', color: 'blue', slots: C.emptySlots(session), updatedAt: Date.now() }, K.newIdentity()); // firmado hace 1 h sin red
    await E.publish({ name: 'Eli', color: 'green', slots: C.emptySlots(session), updatedAt: Date.now() }, K.newIdentity());
    await until(() => B.status === 'sent' && E.status === 'sent', 3000, 'B y E enviados');
    A.resume();
    await until(() => names(A).join() === 'Bea,Dani,Eli', 3000, 'A recibe a Bea y Eli tras volver');
  } finally { for (const e of [A, D, B, E]) e.stop(); await r.close(); }
});

test('relé que rechaza el kind: no cuenta como enviado si ningún otro acepta', async () => {
  const bad = await new FakeRelay({ rejectKinds: [C.KIND] }).listen();
  const eng = new SyncEngine({ session, store: memoryStore(), relays: [bad.url], ...fast });
  engines.push(eng);
  await eng.init(); eng.start();
  await until(() => eng.connection().open === 1, 3000, 'conectado');
  await eng.publish({ name: 'Eva', color: 'mint', slots: C.emptySlots(session), updatedAt: Date.now() }, K.newIdentity());
  await wait(600);
  assert.equal(eng.status, 'queued');
  eng.stop(); await bad.close();
});
