// store.js - almacenamiento clave/valor permanente: IndexedDB -> localStorage -> memoria (con aviso).
// Todos los valores son JSON serializables.

export function memoryStore() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    kind: 'memory',
    persistent: false,
    async get(k) { return clone(m.get(k)); },
    async set(k, v) { m.set(k, clone(v)); },
    async del(k) { m.delete(k); },
    async keys(prefix = '') { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

function localStore(ls) {
  const P = 'quedamos:';
  return {
    kind: 'localStorage',
    persistent: true,
    async get(k) { const v = ls.getItem(P + k); return v == null ? undefined : JSON.parse(v); },
    async set(k, v) { ls.setItem(P + k, JSON.stringify(v)); },
    async del(k) { ls.removeItem(P + k); },
    async keys(prefix = '') {
      const out = [];
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(P + prefix)) out.push(k.slice(P.length)); }
      return out;
    },
  };
}

function idbStore(db) {
  const S = 'kv';
  const run = (mode, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction(S, mode);
    const st = tx.objectStore(S);
    let result;
    const req = fn(st);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return {
    kind: 'indexedDB',
    persistent: true,
    async get(k) { const v = await run('readonly', (st) => st.get(k)); return v === undefined ? undefined : JSON.parse(v); },
    async set(k, v) { await run('readwrite', (st) => st.put(JSON.stringify(v), k)); },
    async del(k) { await run('readwrite', (st) => st.delete(k)); },
    async keys(prefix = '') { const all = await run('readonly', (st) => st.getAllKeys()); return (all || []).filter((k) => typeof k === 'string' && k.startsWith(prefix)); },
  };
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('quedamos', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
    setTimeout(() => reject(new Error('timeout')), 4000);
  });
}

export async function openStore() {
  try {
    if (globalThis.indexedDB) {
      const s = idbStore(await openIdb());
      await s.set('__probe', 1);
      if ((await s.get('__probe')) === 1) { await s.del('__probe'); return s; }
    }
  } catch { /* siguiente alternativa */ }
  try {
    const ls = globalThis.localStorage;
    if (ls) { ls.setItem('quedamos:__probe', '1'); ls.removeItem('quedamos:__probe'); return localStore(ls); }
  } catch { /* siguiente alternativa */ }
  return memoryStore();
}
