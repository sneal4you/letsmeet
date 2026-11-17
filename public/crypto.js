// crypto.js - HKDF, AES-GCM, HMAC (WebCrypto) y eventos Nostr firmados (Schnorr BIP-340).
import { schnorr, utils as secpUtils } from './vendor/noble-secp256k1.js';
import { bytesToB64u, b64uToBytes, bytesToHex, hexToBytes, utf8, fromUtf8, randomBytes } from './core.js';

const subtle = globalThis.crypto.subtle;

async function hkdf(secret, info, length = 32) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) }, base, length * 8);
  return new Uint8Array(bits);
}

/** Claves de la sesión: AES-256-GCM para el contenido y el tag de búsqueda (topic). */
export async function deriveSessionKeys(secret, sessionId) {
  const encRaw = await hkdf(secret, 'quedamos-enc');
  const topicRaw = await hkdf(secret, 'quedamos-topic');
  const encKey = await subtle.importKey('raw', encRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const hmacKey = await subtle.importKey('raw', topicRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await subtle.sign('HMAC', hmacKey, utf8(sessionId)));
  return { encKey, topic: bytesToHex(mac).slice(0, 32) };
}

/** Cifra un objeto JSON: base64url(iv(12) || ciphertext+tag). */
export async function encryptJSON(encKey, obj) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, encKey, utf8(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return bytesToB64u(out);
}
/** Devuelve el objeto o null si no se puede descifrar. */
export async function decryptJSON(encKey, str) {
  try {
    const raw = b64uToBytes(str);
    if (raw.length < 12 + 16) return null;
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, encKey, raw.slice(12));
    return JSON.parse(fromUtf8(new Uint8Array(pt)));
  } catch { return null; }
}

export async function sha256Hex(bytes) { return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes))); }

// ---------- identidad ----------
export function newIdentity() {
  const priv = bytesToHex(secpUtils.randomSecretKey());
  return identityFromPriv(priv);
}
export function identityFromPriv(privHex) {
  const pub = bytesToHex(schnorr.getPublicKey(hexToBytes(privHex)));
  return { priv: privHex, pub, pid: pub.slice(0, 16) };
}

// ---------- eventos Nostr (NIP-01) ----------
export function serializeEvent(ev) {
  return JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
}
export async function eventId(ev) { return sha256Hex(utf8(serializeEvent(ev))); }

export async function signEvent({ kind, tags, content, created_at }, privHex) {
  const priv = hexToBytes(privHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(priv));
  const ev = { pubkey, created_at, kind, tags, content };
  ev.id = await eventId(ev);
  ev.sig = bytesToHex(await schnorr.signAsync(hexToBytes(ev.id), priv));
  return { id: ev.id, pubkey, created_at, kind, tags, content, sig: ev.sig };
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
/** Comprueba forma, id y firma. Nunca lanza. */
export async function verifyEvent(ev) {
  try {
    if (!ev || typeof ev !== 'object') return false;
    if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || !HEX128.test(ev.sig)) return false;
    if (!Number.isInteger(ev.created_at) || !Number.isInteger(ev.kind)) return false;
    if (typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return false;
    if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
    if ((await eventId(ev)) !== ev.id) return false;
    return await schnorr.verifyAsync(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch { return false; }
}
