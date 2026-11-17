// Prueba real contra relés públicos: publica 1 evento cifrado de una sesión ficticia y lo vuelve a leer.
// Uso: node scripts/live-test.mjs [wss://relé1 wss://relé2 ...]   (por defecto, todos los de core.js)
import * as C from '../public/core.js';
import * as K from '../public/crypto.js';

const relays = process.argv.slice(2).length ? process.argv.slice(2) : C.RELAYS;
const kind = Number(process.env.KIND || C.KIND);

function once(url, msgs, until, ms = 10000) {
  return new Promise((resolve) => {
    const out = [];
    let ws;
    const done = (why) => { clearTimeout(t); try { ws.close(); } catch { /* nada */ } resolve({ why, out }); };
    const t = setTimeout(() => done('timeout'), ms);
    try { ws = new WebSocket(url); } catch (e) { clearTimeout(t); resolve({ why: 'error ' + e.message, out }); return; }
    ws.onopen = () => msgs.forEach((m) => ws.send(JSON.stringify(m)));
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } out.push(m); if (until(m)) done('ok'); };
    ws.onerror = () => done('error de conexión');
  });
}

const session = C.newSession({ title: 'Prueba ficticia', n: 2 });
const keys = await K.deriveSessionKeys(session.key, session.id);
const me = K.newIdentity();
const slots = C.emptySlots(session);
C.setBit(slots, C.slotIndex(session, 1, 18), true);
const payload = { v: C.PAYLOAD_VERSION, participantId: me.pid, name: 'Prueba', color: 'blue', slots: C.slotsToB64(slots), updatedAt: Date.now() };
const ev = await K.signEvent({ kind, tags: [['d', `${keys.topic}:${me.pid}`], ['t', keys.topic]], content: await K.encryptJSON(keys.encKey, payload), created_at: Math.floor(Date.now() / 1000) }, me.priv);
console.log(`kind ${kind} · topic ${keys.topic} · evento ${ev.id.slice(0, 12)}…`);

const results = [];
for (const url of relays) {
  const pub = await once(url, [['EVENT', ev]], (m) => m[0] === 'OK' && m[1] === ev.id);
  const ok = pub.out.find((m) => m[0] === 'OK');
  let back = null;
  if (ok && ok[2] === true) {
    await new Promise((r) => setTimeout(r, 800));
    const sub = 'live' + Math.random().toString(36).slice(2, 7);
    const read = await once(url, [['REQ', sub, { kinds: [kind], '#t': [keys.topic] }]], (m) => m[0] === 'EOSE' && m[1] === sub);
    const got = read.out.find((m) => m[0] === 'EVENT' && m[2]?.id === ev.id)?.[2];
    back = got ? { same: got.sig === ev.sig, valid: await K.verifyEvent(got), decrypted: (await K.decryptJSON(keys.encKey, got.content))?.name === 'Prueba' } : null;
  }
  const r = { relay: url, publicado: ok ? (ok[2] ? 'OK true' : `OK false: ${ok[3]}`) : pub.why, leido: back ? (back.same && back.valid && back.decrypted ? 'sí, idéntico y descifrado' : JSON.stringify(back)) : 'no' };
  results.push(r);
  console.log(`${r.relay}\n  publicar: ${r.publicado}\n  leer:     ${r.leido}`);
}
const good = results.filter((r) => r.publicado === 'OK true' && r.leido.startsWith('sí')).length;
console.log(`\n${good}/${results.length} relés aceptan y devuelven el kind ${kind}.`);
