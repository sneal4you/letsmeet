// sync.js - sincronización por relés Nostr (NIP-01) usados como buzón cifrado.
// Transporte inyectable: `connect(url)` debe devolver un objeto con la API de WebSocket
// (send, close, onopen, onmessage, onclose, onerror).
import { KIND, RELAYS, PID_RE, validatePayload, isNewer, pidFromPubkey, slotsToB64 } from './core.js';
import { deriveSessionKeys, encryptJSON, decryptJSON, signEvent, verifyEvent } from './crypto.js';

const keyOf = (kind, sid) => `${kind}:${sid}`;
const tagVals = (ev, name) => ev.tags.filter((t) => t[0] === name).map((t) => t[1]);
// Un payload válido cifrado ocupa unos cientos de bytes: lo que pase de estos límites se descarta sin procesar.
export const MAX_MESSAGE = 32 * 1024;
export const MAX_CONTENT = 4096;

export class SyncEngine {
  constructor({
    session, store, relays = RELAYS,
    connect = (url) => new WebSocket(url),
    now = () => Date.now(),
    backoffBase = 1000, backoffMax = 60000,
    connectTimeout = 10000, sendTimeout = 8000, retryDelay = 15000,
    gossipLimit = 60,
    log = () => {},
  }) {
    Object.assign(this, { session, store, relays, connect, now, backoffBase, backoffMax, connectTimeout, sendTimeout, retryDelay, gossipLimit, log });
    this.participants = new Map(); // pid -> {pid,pubkey,name,color,slots,updatedAt,payload,event}
    this.events = {}; // pid -> evento firmado original (el más nuevo)
    this.pins = {}; // pid -> pubkey fijada
    this.outbox = null; // evento propio pendiente de confirmar
    this.status = 'idle'; // idle | sending | sent | queued
    this.synced = false; // algún relé ya ha respondido EOSE
    this.conns = new Map();
    this.listeners = new Set();
    this.rejectedBy = new Set();
    this.queue = Promise.resolve();
    this.running = false;
    this.paused = false;
    this.ready = false;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, detail = {}) { for (const fn of this.listeners) { try { fn(type, detail); } catch (e) { this.log('listener', e); } } }

  async init() {
    if (this.ready) return this;
    const { encKey, topic } = await deriveSessionKeys(this.session.key, this.session.id);
    this.encKey = encKey; this.topic = topic;
    const sid = this.session.id;
    this.events = (await this.store.get(keyOf('ev', sid))) || {};
    this.pins = (await this.store.get(keyOf('pins', sid))) || {};
    this.outbox = (await this.store.get(keyOf('out', sid))) || null;
    for (const [pid, ev] of Object.entries(this.events)) {
      const payload = validatePayload(await decryptJSON(this.encKey, ev.content), this.session);
      if (payload && payload.participantId === pid) this.participants.set(pid, this._entry(payload, ev));
    }
    if (this.outbox) this.status = 'queued';
    this.ready = true;
    return this;
  }

  _entry(payload, ev) {
    return { pid: payload.participantId, pubkey: ev.pubkey, name: payload.name, color: payload.color, slots: payload.slots, updatedAt: payload.updatedAt, payload, event: ev };
  }

  people() { return [...this.participants.values()]; }

  connection() {
    let open = 0; let connecting = 0;
    for (const c of this.conns.values()) { if (c.state === 'open') open++; else if (c.state === 'connecting') connecting++; }
    return { open, connecting, total: this.conns.size, paused: this.paused, running: this.running };
  }

  // ---------- ciclo de vida ----------
  start() {
    if (this.running) return;
    this.running = true; this.paused = false;
    for (const url of this.relays) {
      const conn = { url, ws: null, state: 'closed', attempts: 0, timer: null, initialDone: false, gossipDone: false, returned: new Map() };
      this.conns.set(url, conn);
      this._connect(conn);
    }
  }

  stop() {
    this.running = false;
    this._closeAll();
    this.conns.clear();
    clearTimeout(this.sendTimer); clearTimeout(this.retryTimer);
    this.emit('conn', this.connection());
  }

  /** Segundo plano: cerrar conexiones. */
  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this._closeAll();
    this.emit('conn', this.connection());
  }

  /** Vuelta a primer plano / red disponible: reconectar ya y volver a pedir lo de la sesión. */
  resume() {
    if (!this.running) return;
    this.paused = false;
    for (const c of this.conns.values()) {
      if (c.ws) continue;
      clearTimeout(c.timer); c.attempts = 0;
      this._connect(c);
    }
  }

  _closeAll() {
    for (const c of this.conns.values()) {
      clearTimeout(c.timer); clearTimeout(c.openTimer);
      const ws = c.ws; c.ws = null; c.state = 'closed';
      if (ws) { try { ws.close(); } catch { /* nada */ } }
    }
  }

  _connect(conn) {
    if (!this.running || this.paused || conn.ws) return;
    let ws;
    try { ws = this.connect(conn.url); } catch (e) { this.log('connect', conn.url, e); this._schedule(conn); return; }
    conn.ws = ws; conn.state = 'connecting';
    this.emit('conn', this.connection());
    conn.subId = 'q' + Math.random().toString(36).slice(2, 10);
    conn.eose = false;
    const fail = () => {
      if (conn.ws !== ws) return;
      clearTimeout(conn.openTimer);
      conn.ws = null; conn.state = 'closed';
      try { ws.close(); } catch { /* nada */ }
      this.emit('conn', this.connection());
      this._schedule(conn);
    };
    conn.openTimer = setTimeout(() => { if (conn.state === 'connecting') fail(); }, this.connectTimeout);
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      clearTimeout(conn.openTimer);
      conn.state = 'open'; conn.attempts = 0;
      // Siempre la consulta completa, sin `since`: son pocos eventos reemplazables (uno por persona) y así
      // no se pierde uno enviado tarde con created_at antiguo (cola sin conexión) ni por un reloj adelantado.
      const filter = { kinds: [KIND], '#t': [this.topic], limit: 500 };
      this._send(conn, ['REQ', conn.subId, filter]);
      if (this.outbox) this._sendOutboxTo(conn);
      this.emit('conn', this.connection());
    };
    ws.onmessage = (e) => { if (conn.ws === ws) this._onMessage(conn, typeof e.data === 'string' ? e.data : String(e.data)); };
    ws.onclose = fail;
    ws.onerror = () => { /* llega onclose */ };
  }

  _schedule(conn) {
    if (!this.running || this.paused) return;
    clearTimeout(conn.timer);
    const delay = Math.min(this.backoffMax, this.backoffBase * 2 ** conn.attempts) * (0.75 + Math.random() * 0.5);
    conn.attempts++;
    conn.timer = setTimeout(() => this._connect(conn), delay);
  }

  _send(conn, msg) {
    if (!conn.ws || conn.state !== 'open') return false;
    try { conn.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  _onMessage(conn, data) {
    if (data.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!Array.isArray(msg)) return;
    const [type] = msg;
    if (type === 'EVENT' && msg[1] === conn.subId && msg[2] && typeof msg[2] === 'object') {
      const ev = msg[2];
      if (Array.isArray(ev.tags)) {
        const d = ev.tags.find((t) => Array.isArray(t) && t[0] === 'd')?.[1];
        if (typeof d === 'string' && Number.isInteger(ev.created_at)) conn.returned.set(d, Math.max(conn.returned.get(d) ?? -1, ev.created_at));
      }
      this.ingest(ev);
    } else if (type === 'EOSE' && msg[1] === conn.subId && !conn.eose) {
      conn.eose = true;
      conn.initialDone = true;
      if (!this.synced) { this.synced = true; this.emit('synced'); }
      if (!conn.gossipDone) { conn.gossipDone = true; this.queue.then(() => this._gossip(conn)); }
    } else if (type === 'OK') {
      const [, id, ok, reason] = msg;
      if (this.outbox && id === this.outbox.id) {
        if (ok === true) this._markSent(conn.url);
        else {
          this.log('rechazado', conn.url, reason);
          this.rejectedBy.add(conn.url);
          const open = [...this.conns.values()].filter((c) => c.state === 'open');
          if (open.every((c) => this.rejectedBy.has(c.url))) { clearTimeout(this.sendTimer); this._setStatus('queued'); this._scheduleRetry(); }
        }
      }
    } else if (type === 'NOTICE' || type === 'CLOSED') {
      this.log(type, conn.url, msg.slice(1));
    }
  }

  /**
   * Gossip: una vez por conexión inicial, re-publica tal cual (firmas originales) los eventos guardados
   * que el relé no ha devuelto. Limitado y sin bucles (no se repite al recibir).
   */
  _gossip(conn) {
    if (conn.state !== 'open') return 0;
    let n = 0;
    for (const [pid, ev] of Object.entries(this.events)) {
      if (n >= this.gossipLimit) break;
      const d = `${this.topic}:${pid}`;
      if ((conn.returned.get(d) ?? -1) >= ev.created_at) continue;
      if (this.outbox && this.outbox.id === ev.id) continue;
      if (this._send(conn, ['EVENT', ev])) n++;
    }
    if (n) this.log('gossip', conn.url, n);
    this.emit('gossip', { url: conn.url, count: n });
    return n;
  }

  // ---------- recepción ----------
  ingest(ev) {
    const p = this.queue.then(() => this._ingest(ev)).catch((e) => { this.log('ingest', e); return false; });
    this.queue = p;
    return p;
  }

  // Sin caché de rechazos por id: una copia falsificada con el id de un evento auténtico no debe
  // impedir aceptar después el auténtico que traiga otro relé.
  async _ingest(ev) {
    if (!ev || typeof ev !== 'object' || ev.kind !== KIND || !Array.isArray(ev.tags)) return false;
    if (typeof ev.content !== 'string' || ev.content.length > MAX_CONTENT || ev.tags.length > 16) return false;
    let ds, ts;
    try { ds = tagVals(ev, 'd'); ts = tagVals(ev, 't'); } catch { return false; }
    if (!ts.includes(this.topic) || ds.length !== 1) return false;
    const d = ds[0];
    if (typeof d !== 'string' || !d.startsWith(this.topic + ':')) return false;
    const pid = d.slice(this.topic.length + 1);
    if (!PID_RE.test(pid)) return false;
    if (this.events[pid] && this.events[pid].id === ev.id) return false;
    if (typeof ev.pubkey !== 'string' || pidFromPubkey(ev.pubkey) !== pid) return false;
    const pinned = this.pins[pid];
    if (pinned && pinned !== ev.pubkey) return false;
    if (!Number.isInteger(ev.created_at) || ev.created_at > Math.floor(this.now() / 1000) + 86400) return false;
    if (!(await verifyEvent(ev))) return false;
    const payload = validatePayload(await decryptJSON(this.encKey, ev.content), this.session);
    if (!payload || payload.participantId !== pid) return false;
    const cand = { payload, event: ev };
    const cur = this.participants.get(pid);
    if (cur && !isNewer(cand, cur)) return false;
    this.participants.set(pid, this._entry(payload, ev));
    this.events[pid] = ev;
    if (!pinned) this.pins[pid] = ev.pubkey;
    const sid = this.session.id;
    await this.store.set(keyOf('ev', sid), this.events);
    await this.store.set(keyOf('pins', sid), this.pins);
    this.emit('participants', { pid });
    return true;
  }

  // ---------- envío ----------
  /** identity: {priv,pub,pid}; data: {name,color,slots(Uint8Array),updatedAt} */
  async publish(data, identity) {
    if (!this.ready) await this.init();
    const payload = { v: 1, participantId: identity.pid, name: data.name, color: data.color, slots: slotsToB64(data.slots), updatedAt: data.updatedAt };
    const content = await encryptJSON(this.encKey, payload);
    let created_at = Math.floor(this.now() / 1000);
    const prev = this.events[identity.pid];
    if (prev && created_at <= prev.created_at) created_at = prev.created_at + 1;
    const ev = await signEvent({ kind: KIND, tags: [['d', `${this.topic}:${identity.pid}`], ['t', this.topic]], content, created_at }, identity.priv);
    await this.ingest(ev);
    this.outbox = ev;
    this.rejectedBy = new Set();
    await this.store.set(keyOf('out', this.session.id), ev);
    if (this.status === 'queued') this.status = 'idle';
    this._flushOutbox();
    return ev;
  }

  _setStatus(s) { if (this.status !== s) { this.status = s; this.emit('status', { status: s }); } }

  _sendOutboxTo(conn) {
    if (!this.outbox) return false;
    const ok = this._send(conn, ['EVENT', this.outbox]);
    if (ok) this._armSendTimer();
    return ok;
  }

  _armSendTimer() {
    // En reintentos se mantiene "queued" para no parpadear entre estados.
    if (this.status !== 'queued') this._setStatus('sending');
    clearTimeout(this.sendTimer);
    const id = this.outbox.id;
    this.sendTimer = setTimeout(() => {
      if (this.outbox && this.outbox.id === id) { this._setStatus('queued'); this._scheduleRetry(); }
    }, this.sendTimeout);
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.running) return;
    this.retryTimer = setTimeout(() => this._flushOutbox(), this.retryDelay);
  }

  _flushOutbox() {
    if (!this.outbox) return;
    let any = false;
    for (const c of this.conns.values()) if (this._sendOutboxTo(c)) any = true;
    if (!any) { this._setStatus('queued'); this._scheduleRetry(); }
  }

  async _markSent(url) {
    if (!this.outbox) return;
    const id = this.outbox.id;
    this.outbox = null;
    clearTimeout(this.sendTimer); clearTimeout(this.retryTimer);
    await this.store.del(keyOf('out', this.session.id));
    this._setStatus('sent');
    this.emit('sent', { id, url });
  }
}

/** Borra del almacenamiento todo lo de una sesión. */
export async function forgetSession(store, sid) {
  for (const k of ['ev', 'pins', 'out', 'seen']) await store.del(keyOf(k, sid));
}
