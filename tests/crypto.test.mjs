import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../public/vendor/noble-secp256k1.js';
import * as C from '../public/core.js';
import * as K from '../public/crypto.js';

test('BIP-340: vector oficial nº 0 (firma y verificación)', async () => {
  const sk = C.hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
  const pk = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
  const msg = new Uint8Array(32); const aux = new Uint8Array(32);
  const sig = 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0';
  assert.equal(C.bytesToHex(schnorr.getPublicKey(sk)), pk);
  assert.equal(C.bytesToHex(await schnorr.signAsync(msg, sk, aux)), sig);
  assert.ok(await schnorr.verifyAsync(C.hexToBytes(sig), msg, C.hexToBytes(pk)));
});

test('BIP-340: vector nº 1 solo verificación', async () => {
  const pk = 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659';
  const msg = '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89';
  const sig = '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a';
  assert.ok(await schnorr.verifyAsync(C.hexToBytes(sig), C.hexToBytes(msg), C.hexToBytes(pk)));
  const bad = sig.slice(0, -1) + 'b';
  assert.ok(!(await schnorr.verifyAsync(C.hexToBytes(bad), C.hexToBytes(msg), C.hexToBytes(pk))));
});

test('evento Nostr: id = sha256 de la serialización NIP-01, firma válida, manipulación detectada', async () => {
  const id = K.identityFromPriv('0000000000000000000000000000000000000000000000000000000000000003');
  assert.equal(id.pub, 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  assert.equal(id.pid, id.pub.slice(0, 16));
  const ev = await K.signEvent({ kind: 30078, tags: [['d', 'x:y'], ['t', 'x']], content: 'hola', created_at: 1700000000 }, id.priv);
  // serialización exacta NIP-01
  assert.equal(K.serializeEvent(ev), `[0,"${id.pub}",1700000000,30078,[["d","x:y"],["t","x"]],"hola"]`);
  assert.equal(ev.id, await K.sha256Hex(C.utf8(K.serializeEvent(ev))));
  // el id no depende de la aleatoriedad de la firma
  const ev2 = await K.signEvent({ kind: 30078, tags: [['d', 'x:y'], ['t', 'x']], content: 'hola', created_at: 1700000000 }, id.priv);
  assert.equal(ev2.id, ev.id);
  assert.ok(await K.verifyEvent(ev));
  assert.ok(!(await K.verifyEvent({ ...ev, content: 'adiós' })));
  assert.ok(!(await K.verifyEvent({ ...ev, sig: '00'.repeat(64) })));
  const other = K.newIdentity();
  assert.ok(!(await K.verifyEvent({ ...ev, pubkey: other.pub })));
  assert.ok(!(await K.verifyEvent(null)));
});

test('cifrado AES-GCM ida y vuelta; otra clave o datos alterados no descifran', async () => {
  const s = C.newSession({ title: 'X', n: 2 });
  const k1 = await K.deriveSessionKeys(s.key, s.id);
  const k1b = await K.deriveSessionKeys(s.key, s.id);
  assert.equal(k1.topic, k1b.topic);
  assert.match(k1.topic, /^[0-9a-f]{32}$/);
  const obj = { v: 1, name: 'Ñandú', slots: 'AAAA', updatedAt: 5 };
  const ct = await K.encryptJSON(k1.encKey, obj);
  assert.ok(!ct.includes('and'));
  assert.notEqual(ct, await K.encryptJSON(k1.encKey, obj)); // IV aleatorio
  assert.deepEqual(await K.decryptJSON(k1.encKey, ct), obj);
  const k2 = await K.deriveSessionKeys(C.randomBytes(32), s.id);
  assert.notEqual(k2.topic, k1.topic);
  assert.equal(await K.decryptJSON(k2.encKey, ct), null);
  const raw = C.b64uToBytes(ct); raw[20] ^= 1;
  assert.equal(await K.decryptJSON(k1.encKey, C.bytesToB64u(raw)), null);
  assert.equal(await K.decryptJSON(k1.encKey, '!!'), null);
});
