// Relé Nostr falso en memoria: servidor WebSocket mínimo (RFC 6455) sobre node:http, sin dependencias.
import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function matches(f, ev) {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (k[0] !== '#') continue;
    const name = k.slice(1);
    if (!ev.tags.some((t) => t[0] === name && vals.includes(t[1]))) return false;
  }
  return true;
}

export class FakeRelay {
  constructor({ rejectKinds = [] } = {}) {
    this.events = new Map(); // clave reemplazable -> evento
    this.clients = new Set();
    this.rejectKinds = rejectKinds;
    this.received = []; // todos los EVENT recibidos (para comprobaciones)
  }

  async listen(port = 0) {
    this.server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
    this.server.on('upgrade', (req, socket) => this._upgrade(req, socket));
    await new Promise((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = this.server.address().port;
    this.url = `ws://127.0.0.1:${this.port}`;
    return this;
  }

  async close() {
    for (const c of this.clients) c.socket.destroy();
    this.clients.clear();
    if (this.server) await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  /** El relé "olvida" todos los datos. */
  forget() { this.events.clear(); }

  /** Mete un evento sin validar (para simular eventos maliciosos o viejos) y lo difunde. */
  inject(ev) { this.events.set('inj:' + ev.id, ev); this._broadcast(ev); }

  _key(ev) {
    if (ev.kind >= 30000 && ev.kind < 40000) {
      const d = ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
      return `${ev.pubkey}:${ev.kind}:${d}`;
    }
    return ev.id;
  }

  _store(ev) {
    const k = this._key(ev);
    const cur = this.events.get(k);
    if (cur && (cur.created_at > ev.created_at || (cur.created_at === ev.created_at && cur.id <= ev.id))) return false;
    this.events.set(k, ev);
    return true;
  }

  _broadcast(ev) {
    for (const c of this.clients) for (const [sub, filters] of c.subs) if (filters.some((f) => matches(f, ev))) c.send(['EVENT', sub, ev]);
  }

  _upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { socket, subs: new Map(), send: (m) => { if (!socket.destroyed) socket.write(frame(JSON.stringify(m))); } };
    this.clients.add(client);
    let buf = Buffer.alloc(0);
    let parts = [];
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80; const op = buf[0] & 0x0f;
        const masked = buf[1] & 0x80; let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskOff = off; if (masked) off += 4;
        if (buf.length < off + len) return;
        const data = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < data.length; i++) data[i] ^= buf[maskOff + (i & 3)];
        buf = buf.subarray(off + len);
        if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
        if (op === 1 || op === 0) {
          parts.push(data);
          if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; this._onText(client, text); }
        }
      }
    });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
  }

  _onText(client, text) {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    const [type] = msg;
    if (type === 'REQ') {
      const [, sub, ...filters] = msg;
      client.subs.set(sub, filters);
      const out = [...this.events.values()].filter((ev) => filters.some((f) => matches(f, ev)));
      for (const ev of out) client.send(['EVENT', sub, ev]);
      client.send(['EOSE', sub]);
    } else if (type === 'CLOSE') {
      client.subs.delete(msg[1]);
    } else if (type === 'EVENT') {
      const ev = msg[1];
      this.received.push(ev);
      if (this.rejectKinds.includes(ev.kind)) { client.send(['OK', ev.id, false, 'blocked: kind not allowed']); return; }
      const fresh = this._store(ev);
      client.send(['OK', ev.id, true, fresh ? '' : 'duplicate:']);
      if (fresh) this._broadcast(ev);
    }
  }
}
