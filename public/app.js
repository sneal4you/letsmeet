// app.js - interfaz de Quedamos. Sin frameworks. Nunca innerHTML con datos de usuario.
import * as C from './core.js';
import { newIdentity, identityFromPriv } from './crypto.js';
import { SyncEngine, forgetSession } from './sync.js';
import { openStore } from './store.js';

const root = document.getElementById('app');
const toasts = document.getElementById('toasts');
let store = null;
let ctx = null; // sesión abierta

// Solo para pruebas locales (arnés de capturas): ?test-relay=ws://127.0.0.1:PUERTO sustituye la lista de relés.
// Solo acepta ws:// a localhost. En producción nadie pasa ese parámetro y, aunque se pasase, la CSP de
// index.html no permite conexiones ws:// (el arnés amplía la CSP únicamente en la copia que sirve a WebKit).
const TEST_RELAY = (() => {
  try {
    const v = new URLSearchParams(location.search).get('test-relay');
    return v && /^ws:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(v) ? v : null;
  } catch { return null; }
})();
const engineOpts = TEST_RELAY ? { relays: [TEST_RELAY] } : {};

// ---------- utilidades DOM ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  back: [['path', 'M15 18l-6-6 6-6']],
  next: [['path', 'M9 6l6 6-6 6']],
  share: [['path', 'M12 3v12M8 7l4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6']],
  settings: [['path', 'M4 7h9M17 7h3M4 17h3M11 17h9'], ['circle', 15, 7, 2], ['circle', 9, 17, 2]],
  plus: [['path', 'M12 5v14M5 12h14']],
  minus: [['path', 'M5 12h14']],
  check: [['path', 'M5 12.5l4.5 4.5L19 7']],
  trash: [['path', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13']],
  copy: [['path', 'M9 9h10v10H9zM5 15V5h10']],
  repeat: [['path', 'M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5']],
  erase: [['path', 'M6 6l12 12M18 6L6 18']],
  link: [['path', 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1']],
};
function icon(name) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico'); s.setAttribute('aria-hidden', 'true');
  for (const [t, ...a] of ICONS[name]) {
    const e = document.createElementNS(NS, t);
    if (t === 'path') e.setAttribute('d', a[0]);
    else { e.setAttribute('cx', a[0]); e.setAttribute('cy', a[1]); e.setAttribute('r', a[2]); }
    s.append(e);
  }
  return s;
}
const colorClass = (id) => `c-${C.COLOR_IDS.includes(id) ? id : 'graphite'}`;
const vibrate = (ms) => { try { navigator.vibrate?.(ms); } catch { /* nada */ } };
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(msg, action, ms = 3800) {
  const el = h('div', { class: 'toast', role: 'status' }, h('span', { text: msg }));
  if (action) el.append(h('button', { class: 'toast-btn', type: 'button', onclick: () => { dismiss(); action.fn(); } }, action.label));
  toasts.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let gone = false;
  function dismiss() { if (gone) return; gone = true; el.classList.remove('in'); setTimeout(() => el.remove(), 300); }
  setTimeout(dismiss, action ? ms + 3000 : ms);
  return dismiss;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* alternativa */ }
  try {
    const ta = h('textarea', { class: 'offscreen', readonly: true }); ta.value = text;
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

// ---------- plataforma ----------
const UA = navigator.userAgent || '';
const isIOS = /iP(hone|od|ad)/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// Navegadores dentro de otras apps (WhatsApp, Instagram, Facebook, WebView de Android): guardan sus datos aparte.
const inAppBrowser = /WhatsApp|FBAN|FBAV|Instagram|Line\/|; wv\)/i.test(UA);

// ---------- datos locales ----------
const meKey = (sid) => `me:${sid}`;
async function listSessions() { return (await store.get('sessions')) || []; }
async function rememberSession(session, data) {
  const list = (await listSessions()).filter((s) => s.id !== session.id);
  list.unshift({ id: session.id, data, title: session.title, startDate: session.startDate, n: session.n, openedAt: Date.now() });
  await store.set('sessions', list);
}
/**
 * Salir de una quedada: se publica con mi clave una baja (mismo d-tag, más nueva, slots vacíos) para que los
 * demás me quiten. La baja queda en cola (lista 'leaving') hasta que un relé la confirme, aunque la quedada ya
 * no esté en la lista; entonces se borra todo lo local. Si vuelvo a abrir el enlace, entro como persona nueva.
 */
async function removeSession(sid) {
  const s = (await listSessions()).find((x) => x.id === sid);
  await store.set('sessions', (await listSessions()).filter((x) => x.id !== sid));
  const me = await store.get(meKey(sid));
  const dec = s && C.decodeLink(s.data);
  await store.del(meKey(sid));
  if (!dec || !me?.priv || !me.name) { await forgetSession(store, sid); return; }
  stopBg(sid);
  const eng = await new SyncEngine({ session: dec.session, store, ...engineOpts }).init();
  const prev = eng.participants.get(me.pid);
  await eng.publish({ name: me.name, color: me.color || 'blue', slots: C.emptySlots(dec.session), updatedAt: Math.max(Date.now(), (prev?.updatedAt || 0) + 1), left: true }, me);
  const leaving = ((await store.get('leaving')) || []).filter((x) => x.id !== sid);
  leaving.push({ id: sid, data: s.data });
  await store.set('leaving', leaving);
  flushPending().catch((e) => console.error(e));
}
async function leftDone(sid) {
  await store.set('leaving', ((await store.get('leaving')) || []).filter((x) => x.id !== sid));
  if (!(await listSessions()).some((x) => x.id === sid)) await forgetSession(store, sid);
}

// Envíos que quedaron en cola en quedadas que no están abiertas: se mandan en segundo plano (máx. 60 s por intento).
const bgEngines = new Map();
async function flushPending() {
  const leaving = (await store.get('leaving')) || [];
  for (const s of [...await listSessions(), ...leaving.map((x) => ({ ...x, leaving: true }))]) {
    if (!(await store.get(`out:${s.id}`))) { if (s.leaving) await leftDone(s.id); continue; }
    if (bgEngines.has(s.id) || ctx?.session.id === s.id) continue;
    const dec = C.decodeLink(s.data); if (!dec) continue;
    const eng = new SyncEngine({ session: dec.session, store, ...engineOpts });
    bgEngines.set(s.id, eng);
    let timer = null;
    const done = () => { clearTimeout(timer); eng.stop(); if (bgEngines.get(s.id) === eng) bgEngines.delete(s.id); };
    timer = setTimeout(done, 60000);
    eng.on(async (type) => {
      if (type !== 'sent') return;
      done();
      if (s.leaving) { await leftDone(s.id); return; }
      const me = await store.get(meKey(s.id));
      if (me && !me.sentOnce) await store.set(meKey(s.id), { ...me, sentOnce: true });
      document.querySelector(`[data-pending="${s.id}"]`)?.remove(); // sin repintar el inicio (no borra lo que se esté escribiendo)
    });
    try { await eng.init(); if (bgEngines.get(s.id) === eng) eng.start(); } catch (e) { console.error(e); done(); }
  }
}
function stopBg(sid) { const e = bgEngines.get(sid); if (e) { bgEngines.delete(sid); e.stop(); } }

const memoryBanner = () => (store.persistent ? null : h('p', { class: 'banner warn', role: 'alert', text: 'Este navegador no deja guardar datos: lo que marques se perderá al cerrar.' }));
function inviteUrl(session) { return `${location.origin}${location.pathname}#${C.encodeLink(session)}`; }
function personalUrl() { return `${location.origin}${location.pathname}#${C.encodeLink(ctx.session, ctx.me.priv)}`; }

// ---------- arranque y rutas ----------
async function boot() {
  store = await openStore();
  try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', () => { ctx?.engine.resume(); flushPending().catch(() => {}); });
  window.addEventListener('pagehide', () => flushMe());
  registerSW();
  await route();
}

async function route() {
  await closeCtx();
  const hash = location.hash.slice(1);
  if (!hash) return renderHome();
  const dec = C.decodeLink(hash);
  if (!dec) {
    history.replaceState(null, '', location.pathname + location.search);
    renderHome();
    toast('El enlace no es válido o está incompleto.');
    return;
  }
  const { session, priv } = dec;
  const data = C.encodeLink(session);
  if (priv) history.replaceState(null, '', location.pathname + location.search + '#' + data); // la clave privada no se queda en la barra
  let me = await store.get(meKey(session.id));
  if (priv && (!me || me.priv !== priv)) {
    me = { ...identityFromPriv(priv), name: '', color: null, slots: C.slotsToB64(C.emptySlots(session)), updatedAt: 0, dirty: false, restored: true };
    await store.set(meKey(session.id), me);
    toast('Identidad recuperada. Buscando tus datos…');
  }
  await rememberSession(session, data);
  await openSession(session, me);
}

async function closeCtx() {
  if (!ctx) return;
  flushMe();
  clearTimeout(ctx.hideTimer);
  ctx.unsub?.();
  ctx.engine.stop();
  ctx = null;
}

// ---------- piezas comunes ----------
function brandMark() { return h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')); }
function group(title, ...rows) {
  return h('section', { class: 'group' },
    title ? h('h2', { class: 'group-title', text: title }) : null,
    h('div', { class: 'group-body glass' }, rows));
}
function row(label, control, extra = '') {
  return h('div', { class: `row ${extra}` }, label ? h('span', { class: 'row-label', text: label }) : null, control);
}

// ---------- inicio ----------
async function renderHome() {
  document.title = "Let's Meet";
  window.scrollTo(0, 0);
  const sessions = await listSessions();
  const pending = new Set();
  for (const s of sessions) if ((await store.get(`out:${s.id}`)) || (await store.get(meKey(s.id)))?.dirty) pending.add(s.id);
  flushPending().catch((e) => console.error(e));
  let n = 4; let color = 'blue';
  const title = h('input', { id: 'f-title', class: 'input bare', maxlength: C.TITLE_MAX, placeholder: 'Trabajo de grupo, reunión de equipo…', autocomplete: 'off', enterkeyhint: 'next', 'aria-label': 'Título' });
  const name = h('input', { id: 'f-name', class: 'input bare', maxlength: C.NAME_MAX, placeholder: 'Tu nombre', autocomplete: 'given-name', enterkeyhint: 'done', 'aria-label': 'Tu nombre' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const nOut = h('output', { class: 'stepper-value', 'aria-live': 'polite', text: n });
  const setN = (v) => { n = Math.min(C.MAX_PEOPLE, Math.max(C.MIN_PEOPLE, v)); nOut.textContent = n; minus.disabled = n <= C.MIN_PEOPLE; plus.disabled = n >= C.MAX_PEOPLE; };
  const minus = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Una persona menos', onclick: () => setN(n - 1) }, icon('minus'));
  const plus = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Una persona más', onclick: () => setN(n + 1) }, icon('plus'));
  const from = h('select', { class: 'pill-select', 'aria-label': 'Desde' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, text: C.formatHour(i) })));
  const to = h('select', { class: 'pill-select', 'aria-label': 'Hasta' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i + 1, text: C.formatHour(i + 1) })));
  from.value = '8'; to.value = '22';
  const palWrap = h('div', { class: 'row-block' });
  const nc = nameColor(name, palWrap);
  const drawPal = () => { nc.paint(color); palWrap.replaceChildren(palette({ selected: color, taken: new Map(), onPick: (c) => { color = c; nc.close(); drawPal(); } })); };
  drawPal();

  async function create(e) {
    e.preventDefault();
    err.textContent = '';
    const t = C.validateTitle(title.value);
    if (!t.ok) { err.textContent = t.error; title.focus(); return; }
    const nm = C.validateName(name.value);
    if (!nm.ok) { err.textContent = nm.error; name.focus(); return; }
    const startH = Number(from.value); const endH = Number(to.value);
    if (endH <= startH) { err.textContent = 'La hora final tiene que ser posterior a la inicial.'; return; }
    const session = C.newSession({ title: t.value, n, startH, endH });
    const me = { ...newIdentity(), name: nm.value, color, slots: C.slotsToB64(C.emptySlots(session)), updatedAt: Date.now(), dirty: false, created: true };
    await store.set(meKey(session.id), me);
    location.hash = C.encodeLink(session);
  }

  const list = sessions.length
    ? group('Tus quedadas', sessions.map((s) => h('div', { class: 'row link-row', 'data-sid': s.id },
      h('a', { class: 'list-main', href: '#' + s.data },
        h('span', { class: 'list-title', text: s.title }),
        h('span', { class: 'list-best' }),
        pending.has(s.id) ? h('span', { class: 'list-sub warn', 'data-pending': s.id, text: 'Cambios sin enviar' }) : null),
      h('button', {
        type: 'button', class: 'icon-btn subtle', 'aria-label': `Quitar «${s.title}» de este móvil`,
        onclick: async () => { if (!confirm(`¿Quitar «${s.title}»? Saldrás de la quedada y se borrarán tus horas para todos.`)) return; await removeSession(s.id); renderHome(); },
      }, icon('trash')))))
    : null;

  const iosApp = isIOS && standalone();
  root.replaceChildren(h('main', { class: 'screen home' },
    h('header', { class: 'brand' }, brandMark(),
      h('h1', { class: 'large-title', text: "Let's Meet" })),
    memoryBanner(),
    list,
    h('form', { class: 'create', onsubmit: create, novalidate: true },
      group('Nombre', nc.rows),
      group('Nueva quedada',
        row(null, title),
        h('div', { class: 'row compact-row' },
          h('div', { class: 'stepper', role: 'group', 'aria-label': 'Personas, contándote a ti' }, minus, nOut, plus),
          h('div', { class: 'range', role: 'group', 'aria-label': 'Horas' }, from, h('span', { class: 'muted', text: 'a' }), to))),
      err,
      h('button', { type: 'submit', class: 'btn primary wide' }, 'Crear quedada')),
    joinBox(iosApp && !sessions.length)));
  setN(n);
  fillHomeBest(sessions).catch((e) => console.error(e));
}

// Mejores horas de cada quedada del inicio, con los datos guardados en este móvil (sin conectar a relés).
async function fillHomeBest(sessions) {
  for (const s of sessions) {
    const rowEl = root.querySelector(`.link-row[data-sid="${s.id}"]`);
    const out = rowEl?.querySelector('.list-best');
    if (!out) continue;
    let blocks = [];
    let people = [];
    let myColor = null;
    let total = 0;
    try {
      const dec = C.decodeLink(s.data);
      if (dec) {
        const session = dec.session;
        const eng = await new SyncEngine({ session, store, ...engineOpts }).init();
        const me = await store.get(meKey(s.id));
        myColor = me?.color || null;
        const others = eng.people().filter((p) => !me || p.pid !== me.pid);
        const ps = others.map((p) => ({ pid: p.pid, slots: p.slots }));
        if (me?.name) { try { ps.push({ pid: me.pid, slots: C.slotsFromB64(session, me.slots) }); } catch { /* copia dañada */ } }
        total = session.n;
        people = [...(me?.name ? [{ name: me.name, color: me.color, me: true }] : []), ...others.map((p) => ({ name: p.name, color: p.color }))];
        const today = C.todayIndex(session);
        const now = new Date();
        const fromHour = (Math.floor((now.getHours() * 60 + now.getMinutes()) / 30) + 1) / 2;
        if (ps.length >= 2 && today < C.DAYS) blocks = C.bestBlocks(session, ps, { fromDay: Math.max(0, today), fromHour: today >= 0 ? fromHour : 0, limit: 50 }).filter((b) => b.full).slice(0, 2);
      }
    } catch (e) { console.error(e); }
    if (!out.isConnected) return; // se ha salido del inicio
    const full = blocks.filter((b) => b.full);
    out.replaceChildren(...(full.length
      ? full.map((b) => h('span', { class: 'list-sub', text: `${C.formatDayShort(b.date)} · ${C.formatTime(b.startH)}–${C.formatTime(b.endH)} · Todos` }))
      : people.length
        ? [h('span', { class: 'list-sub', text: `${people.length} de ${Math.max(total, people.length)} han enviado` }),
            h('span', { class: 'chips home-chips' }, ...people.map((p) => h('span', { class: `chip ${colorClass(p.color)}` }, h('span', { class: 'chip-dot' }), p.me ? `${p.name} (tú)` : p.name)),
              ...Array.from({ length: Math.max(0, total - people.length) }, () => h('span', { class: 'chip pending', text: 'Pendiente' })))]
        : [h('span', { class: 'list-sub', text: 'Aún nadie ha marcado' })]));
    rowEl.classList.toggle('full', full.length > 0);
    if (myColor) rowEl.classList.add('mine', colorClass(myColor));
  }
}

// "Unirse a una quedada": despliega el campo para pegar el enlace (en la app instalada no hay barra de direcciones).
function joinBox(openNow) {
  const card = pasteLinkCard(openNow);
  const btn = h('button', { type: 'button', class: 'btn tinted wide join-toggle', 'aria-expanded': 'false', 'aria-controls': 'join-card' }, icon('link'), 'Unirse a una quedada');
  card.id = 'join-card';
  const set = (open) => {
    card.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open) { card.querySelector('input').focus({ preventScroll: true }); card.offerClipboard(); }
  };
  btn.onclick = () => set(card.hidden);
  card.hidden = true;
  if (openNow) { card.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  return h('div', { class: 'join-box' }, btn, card);
}
const linkFrag = (v) => { v = String(v || '').trim(); const i = v.indexOf('#'); return i >= 0 ? v.slice(i + 1) : v; };

// En la app instalada no hay barra de direcciones (y en iPhone no comparte datos con Safari): pegar un enlace.
function pasteLinkCard(first) {
  const input = h('input', { class: 'input bare', type: 'url', inputmode: 'url', placeholder: 'Pega aquí el enlace', autocomplete: 'off', 'aria-label': 'Enlace de una quedada' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const clip = h('div', { class: 'row-block', hidden: true });
  const open = (e) => {
    e.preventDefault();
    const frag = linkFrag(input.value);
    if (!input.value.trim()) { err.textContent = 'Pega aquí el enlace que te han pasado.'; input.focus(); return; }
    if (!C.decodeLink(frag)) { err.textContent = 'Ese enlace no es de una quedada o está incompleto. Copia el enlace entero de la invitación.'; input.focus(); return; }
    location.hash = frag;
  };
  input.addEventListener('input', () => { err.textContent = ''; });
  const note = first && isIOS
    ? 'En iPhone, esta app guarda sus datos aparte de Safari. Si ya marcaste horas en Safari, copia allí tu enlace personal (Ajustes de la quedada) y pégalo aquí: seguirás siendo tú.'
    : 'Pega el enlace del grupo o tu enlace personal.';
  const form = h('form', { class: 'group', onsubmit: open, novalidate: true },
    h('div', { class: 'group-body glass' }, clip, row(null, input), h('div', { class: 'row-block' }, h('button', { type: 'submit', class: 'btn primary wide' }, 'Unirse'))),
    err,
    h('p', { class: 'group-foot', text: note }));
  // Si el portapapeles ya tiene un enlace válido, ofrecer pegarlo (si el navegador deja leerlo).
  form.offerClipboard = async () => {
    try {
      const t = await navigator.clipboard?.readText?.();
      if (!t || !C.decodeLink(linkFrag(t)) || input.value.trim()) return;
      clip.hidden = false;
      clip.replaceChildren(h('button', { type: 'button', class: 'btn tinted wide', onclick: () => { input.value = t.trim(); err.textContent = ''; clip.hidden = true; } }, 'Pegar el enlace copiado'));
    } catch { /* sin permiso: se pega a mano */ }
  };
  return form;
}

// ---------- paleta ----------
// Nombre y color en una fila: un círculo con el color elegido; al tocarlo se despliega la paleta.
function nameColor(name, palWrap) {
  const dot = h('button', { type: 'button', class: 'color-toggle', 'aria-expanded': 'false', 'aria-controls': 'pal-' + (++nameColor.n) });
  palWrap.id = dot.getAttribute('aria-controls');
  palWrap.hidden = true;
  const set = (open) => { palWrap.hidden = !open; dot.setAttribute('aria-expanded', String(open)); };
  dot.onclick = () => { vibrate(6); set(palWrap.hidden); };
  return {
    rows: [h('div', { class: 'row name-row' }, name, dot), palWrap],
    paint: (c) => {
      dot.className = `color-toggle ${c ? colorClass(c) : ''}`;
      dot.setAttribute('aria-label', `Color: ${C.COLORS.find((x) => x.id === c)?.name || 'sin elegir'}. Cambiar`);
    },
    close: () => set(false),
  };
}
nameColor.n = 0;
function palette({ selected, taken, onPick }) {
  return h('div', { class: 'palette', role: 'radiogroup', 'aria-label': 'Color' }, C.COLORS.map((c) => {
    const who = taken.get(c.id);
    return h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(selected === c.id),
      class: `swatch ${colorClass(c.id)}${selected === c.id ? ' on' : ''}${who ? ' taken' : ''}`,
      'aria-label': who ? `${c.name}, lo usa ${who}` : c.name,
      onclick: () => { vibrate(6); onPick(c.id); },
    }, h('span', { class: 'swatch-dot' }, selected === c.id ? icon('check') : null), h('span', { class: 'swatch-who', text: who || '' }));
  }));
}
function takenColors(excludePid) {
  const m = new Map();
  for (const p of ctx.engine.people()) if (p.pid !== excludePid && !m.has(p.color)) m.set(p.color, p.name);
  return m;
}
const firstFree = (taken, pref) => (pref && !taken.has(pref) ? pref : C.COLOR_IDS.find((c) => !taken.has(c)) || pref || 'blue');

// ---------- sesión ----------
async function openSession(session, me) {
  stopBg(session.id);
  const engine = new SyncEngine({ session, store, ...engineOpts });
  ctx = { session, engine, me, slots: me ? C.slotsFromB64(session, me.slots) : C.emptySlots(session), els: {}, view: null, week: null, focus: null };
  await engine.init();
  if (ctx?.engine !== engine) return;
  ctx.unsub = engine.on(onEngine);
  engine.start();
  adoptRemote();
  document.title = `${session.title} · Let's Meet`;
  if (!ctx.me || !ctx.me.name) renderJoin(); else renderSession();
}

function people() {
  const others = ctx.engine.people().filter((p) => !ctx.me || p.pid !== ctx.me.pid).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const mine = ctx.me?.name ? [{ pid: ctx.me.pid, name: ctx.me.name, color: ctx.me.color, slots: ctx.slots, me: true }] : [];
  return [...mine, ...others];
}
// Enviado = algún relé confirmó un envío mío, o mi horario ya está en los relés y no queda nada en cola.
const meSent = () => !!(ctx.me && (ctx.me.sentOnce || (ctx.engine.participants.has(ctx.me.pid) && !ctx.engine.outbox)));

function onEngine(type, d) {
  if (!ctx) return;
  if (type === 'participants') {
    if (ctx.me && d.pid === ctx.me.pid) adoptRemote();
    scheduleRender();
  } else if (type === 'sent') {
    if (ctx.me && !ctx.me.sentOnce) { ctx.me.sentOnce = true; saveMe(true); }
    scheduleRender();
  } else if (type === 'status') {
    fillSendbar(); fillPeople();
  } else if (type === 'conn' || type === 'synced') {
    if (ctx.view === 'join') fillJoinLive(); else fillConn();
  }
}

/** Si llega una versión más nueva de mi propio horario (otro móvil o identidad recuperada), se adopta. */
function adoptRemote() {
  const me = ctx.me; if (!me) return;
  const p = ctx.engine.participants.get(me.pid);
  if (!p || p.left) return;
  if (me.restored) {
    // Identidad recuperada: manda lo recibido; si aquí ya se habían marcado horas, se suman (no se pierde nada).
    const merged = new Uint8Array(p.slots); let extra = false;
    for (let i = 0; i < merged.length; i++) { if (ctx.slots[i] & ~merged[i]) extra = true; merged[i] |= ctx.slots[i]; }
    Object.assign(me, { name: p.name, color: p.color, updatedAt: extra ? Date.now() : p.updatedAt, dirty: extra, restored: false });
    ctx.slots = merged;
    if (ctx.view === 'session') { toast('Tu horario anterior se ha recuperado.'); renderSession(); }
  } else {
    if (p.updatedAt <= me.updatedAt || me.dirty) return;
    Object.assign(me, { name: p.name, color: p.color, updatedAt: p.updatedAt });
    ctx.slots = new Uint8Array(p.slots);
  }
  saveMe(true);
  if (ctx.view === 'join') { toast(`Hola de nuevo, ${me.name}.`); renderSession(); }
}

let meTimer = null;
function saveMe(now = false) {
  if (!ctx?.me) return;
  ctx.me.slots = C.slotsToB64(ctx.slots);
  clearTimeout(meTimer);
  const rec = { ...ctx.me }; const sid = ctx.session.id;
  const doSave = () => store.set(meKey(sid), rec).catch(() => toast('No se ha podido guardar en este móvil.'));
  if (now) doSave(); else meTimer = setTimeout(doSave, 250);
}
function flushMe() { if (ctx?.me) saveMe(true); }

function markDirty() {
  ctx.me.dirty = true;
  ctx.me.updatedAt = Date.now();
  saveMe();
  scheduleRender();
}

async function sendNow() {
  if (!ctx?.me) return;
  const me = ctx.me;
  if (me.restored && !confirm('Todavía no ha llegado tu horario anterior. Si envías ahora, lo sustituirás por este. ¿Enviar igualmente?')) return;
  me.restored = false;
  me.dirty = false;
  me.updatedAt = Math.max(Date.now(), (ctx.engine.participants.get(me.pid)?.updatedAt || 0) + 1);
  saveMe(true);
  fillSendbar();
  try {
    await ctx.engine.publish({ name: me.name, color: me.color, slots: ctx.slots, updatedAt: me.updatedAt }, me);
    vibrate(12);
  } catch (e) {
    console.error(e);
    me.dirty = true; saveMe(true);
    toast('No se ha podido preparar el envío. Inténtalo otra vez.');
  }
  scheduleRender();
}

function onVisibility() {
  if (!ctx) return;
  if (document.hidden) {
    flushMe();
    clearTimeout(ctx.hideTimer);
    ctx.hideTimer = setTimeout(() => ctx?.engine.pause(), 30000);
  } else {
    clearTimeout(ctx.hideTimer);
    ctx.engine.resume();
    if (ctx.view === 'session' && ctx.me?.dirty) toast('Tienes cambios sin enviar.', { label: 'Enviar', fn: sendNow });
    scheduleRender();
  }
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!ctx) return;
    if (ctx.view === 'join') { fillJoinLive(); return; }
    if (ctx.view !== 'session') return;
    if (ctx.painting) { ctx.renderPending = true; return; }
    fillPeople(); fillGrid(); fillBest(); fillSendbar(); fillConn();
  });
}

// ---------- unirse ----------
function renderJoin() {
  window.scrollTo(0, 0);
  ctx.view = 'join';
  const { session } = ctx;
  const restored = !!ctx.me?.restored;
  let color = null; let picked = false;
  const name = h('input', { class: 'input bare', maxlength: C.NAME_MAX, placeholder: 'Tu nombre', autocomplete: 'given-name', enterkeyhint: 'done', 'aria-label': 'Tu nombre' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const who = h('div', { class: 'chips' });
  const palWrap = h('div', { class: 'row-block' });
  const nc = nameColor(name, palWrap);
  ctx.els = { who, palWrap };
  ctx.drawJoin = () => {
    const taken = takenColors(ctx.me?.pid);
    if (!picked) color = firstFree(taken, color);
    nc.paint(color);
    palWrap.replaceChildren(palette({ selected: color, taken, onPick: (c) => { color = c; picked = true; nc.close(); ctx.drawJoin(); } }));
    const ps = ctx.engine.people().filter((p) => p.pid !== ctx.me?.pid);
    let empty = 'Todavía nadie ha enviado su horario.';
    if (!ctx.engine.synced) {
      const c = ctx.engine.connection();
      empty = c.open || (c.connecting && navigator.onLine !== false) ? 'Buscando a los demás…' : 'Sin conexión: no se puede ver quién está.';
    }
    who.replaceChildren(...(ps.length ? ps.map((p) => chip(p)) : [h('span', { class: 'muted small', text: empty })]));
  };
  ctx.drawJoin();

  async function join(e) {
    e.preventDefault();
    const others = ctx.engine.people().filter((p) => p.pid !== ctx.me?.pid).map((p) => p.name);
    const nm = C.validateName(name.value, others);
    if (!nm.ok) {
      const dup = C.validateName(name.value).ok; // válido salvo por estar repetido
      err.textContent = dup ? `${nm.error} Si eres tú, abre tu enlace personal para recuperar tu horario.` : nm.error;
      name.focus(); return;
    }
    const base = ctx.me || { ...newIdentity(), slots: C.slotsToB64(C.emptySlots(session)) };
    // Identidad recuperada cuyo horario aún no ha llegado: se mantiene `restored` para fusionarlo cuando llegue.
    ctx.me = { ...base, name: nm.value, color, updatedAt: base.restored ? 0 : Date.now(), dirty: false, restored: !!base.restored };
    saveMe(true);
    renderSession();
  }

  // Avisos para no confundir "he perdido mis datos": app de inicio en iPhone y navegadores dentro de otras apps.
  let note = null;
  if (isIOS && standalone()) note = '¿Ya te uniste desde Safari? Esta app guarda sus datos aparte: abre allí Ajustes de la quedada, copia tu enlace personal y pégalo en el inicio de esta app.';
  // En iPhone, WhatsApp abre los enlaces en SFSafariViewController (datos aparte de Safari) sin rastro en el UA: aviso siempre.
  else if (isIOS) note = "Guarda tu enlace personal (Ajustes > Copiar) por si abres Let's Meet en otro navegador o app.";
  else if (inAppBrowser) note = 'Lo que marques se guarda en este navegador. Si luego lo abres en otro, copia antes tu enlace personal en Ajustes para seguir siendo tú.';

  root.replaceChildren(h('main', { class: 'screen join' },
    h('nav', { class: 'navrow' }, h('a', { class: 'icon-btn', href: '#', 'aria-label': 'Inicio' }, icon('back'))),
    memoryBanner(),
    h('header', { class: 'join-head' }, brandMark(),
      h('p', { class: 'kicker', text: restored ? 'Recuperando tu identidad en' : 'Te han invitado a' }),
      h('h1', { class: 'large-title', text: session.title }),
      h('p', { class: 'muted', text: sessionSummary(session) })),
    h('section', { class: 'group' }, h('h2', { class: 'group-title', text: 'Ya están' }), h('div', { class: 'group-body glass pad' }, who)),
    restored ? h('p', { class: 'banner', text: 'Buscando tu horario en los relés. Si no aparece, escribe tu nombre para seguir.' }) : null,
    h('form', { class: 'create', onsubmit: join, novalidate: true },
      group('Nombre', nc.rows),
      err,
      h('button', { type: 'submit', class: 'btn primary wide' }, 'Entrar y marcar mis horas')),
    note ? h('p', { class: 'foot', text: note }) : h('p', { class: 'foot', text: 'Sin cuentas. Tu horario viaja cifrado: solo lo ve quien tiene el enlace.' })));
}
function fillJoinLive() { ctx.drawJoin?.(); }

function sessionSummary(s) {
  return `${C.formatDayShort(s.startDate)} – ${C.formatDayShort(C.addDays(s.startDate, C.DAYS - 1))}, de ${C.formatHour(s.startH)} a ${C.formatHour(s.endH)}`;
}
function chip(p, { extra = '', onclick = null, pressed = null } = {}) {
  const kids = [h('span', { class: 'chip-dot', 'aria-hidden': 'true' }), h('span', { class: 'chip-name', text: p.me ? `${p.name} (tú)` : p.name })];
  if (!onclick) return h('span', { class: `chip ${colorClass(p.color)} ${extra}` }, kids);
  return h('button', { type: 'button', class: `chip ${colorClass(p.color)} ${extra}`, 'aria-pressed': String(!!pressed), onclick }, kids);
}

// ---------- pantalla de sesión: rejilla de horas ----------
function renderSession() {
  if (ctx.view !== 'session') window.scrollTo(0, 0);
  ctx.view = 'session';
  const { session } = ctx;
  const today = C.todayIndex(session);
  if (ctx.week == null) ctx.week = C.weekOfDay(session, Math.max(0, Math.min(today, C.DAYS - 1)));
  const els = ctx.els = {
    progress: h('span', { class: 'progress' }),
    conn: h('span', { class: 'conn', role: 'status' }),
    chips: h('div', { class: 'chips legend', role: 'group', 'aria-label': 'Participantes. Toca a alguien para resaltar sus horas.' }),
    hint: h('div', { class: 'hint-wrap' }),
    prev: h('button', { type: 'button', class: 'week-btn', 'aria-label': 'Semana anterior', onclick: () => setWeek(ctx.week - 1) }, icon('back')),
    next: h('button', { type: 'button', class: 'week-btn', 'aria-label': 'Semana siguiente', onclick: () => setWeek(ctx.week + 1) }, icon('next')),
    weekLabel: h('span', { class: 'week-label', 'aria-live': 'polite' }),
    dots: h('div', { class: 'week-dots', role: 'tablist', 'aria-label': 'Semanas' }),
    dayHead: h('div', { class: 'day-head' }),
    hours: h('div', { class: 'hour-col', 'aria-hidden': 'true' }),
    cells: h('div', { class: 'cells', role: 'grid', 'aria-label': 'Horas de la semana. Toca o arrastra para marcar cuándo puedes.' }),
    best: h('section', { class: 'best', 'aria-label': 'Mejores horas' }),
    status: h('span', { class: 'send-status', role: 'status', 'aria-live': 'polite' }),
    send: h('button', { type: 'button', class: 'btn primary send-btn' }, 'Enviar'),
  };
  els.board = h('section', { class: 'board', 'aria-label': 'Rejilla de horas' },
    els.dayHead,
    h('div', { class: 'board-body' }, els.hours, els.cells, h('span')));
  root.replaceChildren(h('main', { class: 'screen session' },
    h('nav', { class: 'navrow' },
      h('a', { class: 'icon-btn', href: '#', 'aria-label': 'Inicio' }, icon('back')),
      h('span', { class: 'nav-spacer' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Invitar', onclick: invite }, icon('share')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Ajustes de la quedada', onclick: renderSettings }, icon('settings'))),
    h('header', { class: 'session-head' },
      h('h1', { class: 'large-title', text: session.title }),
      h('p', { class: 'session-meta' }, els.progress)),
    memoryBanner(),
    els.chips,
    els.hint,
    els.best,
    els.board),
  // fuera de .screen: su animación de entrada (transform) haría que position: fixed se refiriese a ella
  h('div', { class: 'sendbar glass' }, els.status, els.send));
  bindGrid(els.cells);
  fillPeople(); fillGrid(); fillBest(); fillSendbar(); fillConn();
  if (ctx.me.dirty) toast('Tienes cambios sin enviar.', { label: 'Enviar', fn: sendNow });
}

function fillPeople() {
  if (!ctx || ctx.view !== 'session') return;
  const { els, session } = ctx;
  const ps = people();
  const total = Math.max(session.n, ps.length);
  const sent = ps.filter((p) => !p.me || meSent()).length;
  els.progress.textContent = `${sent} de ${total} han enviado`;
  const pend = Math.max(0, session.n - ps.length);
  if (ctx.focus && !ps.some((p) => p.pid === ctx.focus)) ctx.focus = null;
  els.chips.replaceChildren(
    ...ps.map((p) => chip(p, {
      extra: `${p.me && !meSent() ? 'unsent' : ''}${ctx.focus && ctx.focus !== p.pid ? ' dimmed' : ''}`,
      pressed: ctx.focus === p.pid,
      onclick: () => { ctx.focus = ctx.focus === p.pid ? null : p.pid; vibrate(6); fillPeople(); fillGrid(); },
    })),
    ...Array.from({ length: pend }, () => h('span', { class: 'chip pending', text: 'Pendiente' })));
  // Dos personas que se unieron a la vez pueden haber elegido el mismo nombre o color: avisar.
  const low = (s) => C.cleanName(s).toLocaleLowerCase('es');
  const others = ps.filter((p) => !p.me);
  const sameName = ctx.me && others.some((p) => low(p.name) === low(ctx.me.name));
  const sameColor = ctx.me && others.some((p) => p.color === ctx.me.color);
  if (sameName || sameColor) {
    els.hint.replaceChildren(h('div', { class: 'hint glass' },
      h('div', { class: 'hint-text' }, h('span', { class: 'small', text: `Otra persona usa tu mismo ${sameName ? (sameColor ? 'nombre y color' : 'nombre') : 'color'}. Cámbialo para que os distingan.` })),
      h('button', { type: 'button', class: 'btn tinted small-btn', onclick: renderSettings }, 'Cambiar')));
  } else els.hint.replaceChildren();
}

function fillConn() {
  if (!ctx || ctx.view !== 'session') return;
  const c = ctx.engine.connection();
  let cls = 'off'; let text = 'Sin conexión';
  if (c.open > 0) { cls = 'on'; text = 'Conectado'; } else if (c.paused) { cls = 'wait'; text = 'En pausa'; } else if (c.connecting > 0 && navigator.onLine !== false) { cls = 'wait'; text = 'Conectando…'; }
  ctx.els.conn.className = `conn ${cls}`;
  ctx.els.conn.replaceChildren(h('span', { class: 'conn-dot', 'aria-hidden': 'true' }), h('span', { text }));
  ctx.els.conn.setAttribute('aria-label', `${text}${c.open ? ` a ${c.open} de ${c.total} relés` : ''}`);
}

function fillSendbar() {
  if (!ctx || ctx.view !== 'session') return;
  const { els, me, engine } = ctx;
  let text; let label = 'Enviar'; let disabled = false; let cls = '';
  if (me.dirty) { text = 'Cambios sin enviar'; cls = 'dirty'; }
  else if (engine.status === 'sending') { text = 'Enviando…'; disabled = true; }
  else if (engine.status === 'queued') { text = 'Sin conexión, se enviará al volver'; label = 'Reintentar'; cls = 'queued'; }
  else if (meSent()) { text = 'Tus horas están enviadas'; label = 'Enviado'; disabled = true; cls = 'ok'; }
  else { text = 'Marca tus horas y envía'; }
  els.status.replaceChildren(h('span', { class: 'status-dot', 'aria-hidden': 'true' }), h('span', { text }));
  els.status.className = `send-status ${cls}`;
  els.send.replaceChildren(...(cls === 'ok' ? [icon('check'), label] : [label]));
  els.send.disabled = disabled;
  els.send.onclick = engine.status === 'queued' && !me.dirty ? () => { engine.resume(); engine._flushOutbox(); } : () => sendNow();
}

function computeView() {
  const ps = people();
  const counts = C.slotCounts(ctx.session, ps);
  const required = C.requiredCount(ctx.session, ps.length);
  return { ps, counts, required, today: C.todayIndex(ctx.session) };
}

function weekLabel(session, w) {
  const a = C.addDays(session.startDate, C.weekFirstDay(session, w));
  const b = C.addDays(a, 6);
  const pa = C.dateParts(a); const pb = C.dateParts(b);
  return pa.m === pb.m ? `${pa.d} – ${pb.d} ${C.MONTHS_SHORT[pb.m - 1]}` : `${pa.d} ${C.MONTHS_SHORT[pa.m - 1]} – ${pb.d} ${C.MONTHS_SHORT[pb.m - 1]}`;
}

function setWeek(w, { flash = null } = {}) {
  const n = C.weekCount(ctx.session);
  if (w < 0 || w >= n) return;
  const dir = w === ctx.week ? 0 : (w > ctx.week ? 1 : -1);
  ctx.week = w;
  fillGrid({ dir });
  if (flash) flashBlock(flash);
}

// Relleno de una celda: la celda entera a partes iguales con el color de cada persona disponible
// (franjas verticales lado a lado, siempre en el mismo orden). Vacía: fondo normal.
const avail0 = (ps, i) => ps.some((p) => C.getBit(p.slots, i));
function fillStyle(avail) {
  if (!avail.length) return {};
  const n = avail.length;
  const stops = avail.map((p, j) => `var(--c-${p.color}) ${(j * 100 / n).toFixed(3)}% ${((j + 1) * 100 / n).toFixed(3)}%`);
  return { '--fill': `linear-gradient(90deg, ${stops.join(', ')})` };
}
function applyFill(el, avail) {
  const v = fillStyle(avail)['--fill'];
  if (v) el.style.setProperty('--fill', v); else el.style.removeProperty('--fill');
  el.classList.toggle('filled', !!v);
}

function fillGrid({ dir = 0 } = {}) {
  if (!ctx || ctx.view !== 'session') return;
  const { session, els } = ctx;
  const { ps, counts, required, today } = computeView();
  const hours = C.slotsPerDay(session); // filas: medias horas
  const nW = C.weekCount(session);
  const w = ctx.week;
  const first = C.weekFirstDay(session, w);
  const editableFrom = Math.max(0, today);

  // navegación de semanas
  els.prev.disabled = w <= 0;
  els.next.disabled = w >= nW - 1;

  // cabecera de días
  els.dayHead.replaceChildren(els.prev, ...Array.from({ length: 7 }, (_, wd) => {
    const day = first + wd;
    const date = C.addDays(session.startDate, day);
    const out = day < 0 || day >= C.DAYS;
    return h('span', { class: `dh${day === today ? ' today' : ''}${day < today || out ? ' past' : ''}`, 'aria-label': C.formatDayLong(date) },
      h('span', { class: 'dh-w', text: C.WEEKDAYS_SHORT[wd] }), h('span', { class: 'dh-n', text: String(C.dateParts(date).d) }));
  }), els.next);

  // columna de horas
  els.hours.replaceChildren(...Array.from({ length: C.hoursOf(session) }, (_, k) => h('span', { class: 'hl', text: C.formatTime(session.startH + k) })));

  // celdas
  const isFullAt = (d, k) => d >= 0 && d < C.DAYS && k >= 0 && k < hours && d >= today && C.isFull(counts[d * hours + k], required);
  const focusP = ctx.focus ? ps.find((p) => p.pid === ctx.focus) : null;
  const cells = [];
  ctx.gridPeople = ps;
  els.board.style.setProperty('--rows', C.hoursOf(session));
  els.cells.className = `cells ${colorClass(ctx.me.color)}${focusP ? ' focusing' : ''}`;
  for (let k = 0; k < hours; k++) {
    for (let wd = 0; wd < 7; wd++) {
      const d = first + wd;
      if (d < 0 || d >= C.DAYS) { cells.push(h('span', { class: 'cell out', 'aria-hidden': 'true' })); continue; }
      const i = d * hours + k;
      const past = d < today;
      const mine = !!C.getBit(ctx.slots, i);
      const full = isFullAt(d, k);
      let cls = avail0(ps, i) ? 'cell filled' : 'cell';
      if (past) cls += ' past';
      if (mine) cls += ' mine';
      cls += k % 2 ? ' h2' : ' h1';
      if (full) cls += ' full';
      if (focusP && C.getBit(focusP.slots, i)) cls += ' hl';
      const avail = ps.filter((p) => C.getBit(p.slots, i));
      const hour = C.slotHour(session, k);
      const label = `${C.formatDayShort(C.dayDate(session, d))}, ${C.formatTime(hour)}. ${avail.length ? avail.map((p) => (p.me ? 'tú' : p.name)).join(', ') : 'nadie'}${full ? '. Coincidís todos' : ''}`;
      cells.push(h('button', {
        type: 'button', role: 'gridcell', class: cls, 'data-i': past ? null : i, 'data-d': d, 'data-k': k,
        style: fillStyle(avail),
        'aria-pressed': String(mine), 'aria-label': label, disabled: past || null, tabindex: '-1',
      }));
    }
  }
  // un único elemento enfocable con el teclado: la primera celda editable
  const firstEditable = cells.find((c) => c.dataset?.i);
  if (firstEditable) firstEditable.tabIndex = 0;
  els.cells.replaceChildren(...cells);
  if (dir && !reduceMotion()) {
    for (const el of [els.cells, els.dayHead]) {
      el.classList.remove('slide-l', 'slide-r');
      void el.offsetWidth;
      el.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
    }
  }
  if (today >= C.DAYS && !els.board.querySelector('.ended')) els.board.prepend(h('p', { class: 'banner ended', text: 'Esta quedada ya ha pasado. Puedes crear otra desde el inicio.' }));
}

// Marcar: tocar alterna una celda; mantener y arrastrar pinta un rectángulo (como When2meet):
// si empiezas en una celda vacía, marca; si empiezas en una marcada, borra.
function bindGrid(cellsEl) {
  let drag = null;
  const cellAt = (x, y) => {
    const c = document.elementFromPoint(x, y)?.closest?.('.cell');
    return c && cellsEl.contains(c) && c.dataset.i ? c : null;
  };
  const setCell = (c, on) => {
    const i = Number(c.dataset.i);
    if (!!C.getBit(ctx.slots, i) === on) return false;
    C.setBit(ctx.slots, i, on);
    c.classList.toggle('mine', on);
    c.setAttribute('aria-pressed', String(on));
    applyFill(c, (ctx.gridPeople || []).filter((p) => (p.me ? on : C.getBit(p.slots, i))));
    return true;
  };
  const paint = () => {
    const d0 = Math.min(drag.d0, drag.d1); const d1 = Math.max(drag.d0, drag.d1);
    const k0 = Math.min(drag.k0, drag.k1); const k1 = Math.max(drag.k0, drag.k1);
    let n = 0;
    for (const c of cellsEl.querySelectorAll('.cell[data-i]')) {
      const d = Number(c.dataset.d); const k = Number(c.dataset.k);
      const inside = d >= d0 && d <= d1 && k >= k0 && k <= k1;
      if (setCell(c, inside ? drag.mode : !!C.getBit(drag.snap, Number(c.dataset.i)))) n++;
    }
    if (n) drag.changed = true;
    return n;
  };
  const finish = () => {
    if (!drag) return;
    const changed = drag.changed;
    drag = null;
    ctx.painting = false;
    cellsEl.classList.remove('painting');
    if (changed) markDirty();
    if (ctx.renderPending) { ctx.renderPending = false; scheduleRender(); }
  };
  cellsEl.addEventListener('pointerdown', (e) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const c = e.target.closest?.('.cell');
    if (!c || !c.dataset.i) return;
    e.preventDefault();
    try { cellsEl.setPointerCapture(e.pointerId); } catch { /* opcional */ }
    const d = Number(c.dataset.d); const k = Number(c.dataset.k);
    drag = { id: e.pointerId, d0: d, k0: k, d1: d, k1: k, mode: !C.getBit(ctx.slots, Number(c.dataset.i)), snap: new Uint8Array(ctx.slots), changed: false };
    ctx.painting = true;
    cellsEl.classList.add('painting');
    paint();
    vibrate(8);
  });
  cellsEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const c = cellAt(e.clientX, e.clientY);
    if (!c) return;
    const d = Number(c.dataset.d); const k = Number(c.dataset.k);
    if (d === drag.d1 && k === drag.k1) return;
    drag.d1 = d; drag.k1 = k;
    if (paint()) vibrate(3);
  });
  cellsEl.addEventListener('pointerup', finish);
  cellsEl.addEventListener('pointercancel', finish);
  cellsEl.addEventListener('lostpointercapture', finish);
  // Red de seguridad para navegadores que no respeten touch-action: la página no se mueve al pintar.
  cellsEl.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  cellsEl.addEventListener('contextmenu', (e) => e.preventDefault());
  // Teclado (Intro/Espacio): click con detail 0. Los toques ya se gestionan en pointerdown.
  cellsEl.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    const c = e.target.closest?.('.cell'); if (!c || !c.dataset.i) return;
    setCell(c, !C.getBit(ctx.slots, Number(c.dataset.i)));
    markDirty();
  });
  cellsEl.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.cell'); if (!c) return;
    const all = [...cellsEl.querySelectorAll('.cell[data-i]')];
    const idx = all.indexOf(c); if (idx < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const target = [...cellsEl.children].indexOf(c) + step;
    const t = cellsEl.children[target];
    if (t?.dataset.i) { c.tabIndex = -1; t.tabIndex = 0; t.focus(); }
  });
}

function undoable(before, msg) {
  markDirty();
  toast(msg, { label: 'Deshacer', fn: () => { if (!ctx) return; ctx.slots = before; markDirty(); } });
}
function repeatThisWeek() {
  const { session } = ctx;
  const before = new Uint8Array(ctx.slots);
  const n = C.repeatWeek(session, ctx.slots, ctx.week, Math.max(0, C.todayIndex(session)));
  if (!n) { toast('Las demás semanas ya tienen este mismo horario.'); return; }
  vibrate(10);
  undoable(before, 'Copiado a las demás semanas.');
}
function clearThisWeek() {
  const { session } = ctx;
  const before = new Uint8Array(ctx.slots);
  const n = C.clearWeek(session, ctx.slots, ctx.week, Math.max(0, C.todayIndex(session)));
  if (!n) { toast('No tienes horas marcadas en esta semana.'); return; }
  vibrate(10);
  undoable(before, `${n} ${n === 1 ? 'hora borrada' : 'horas borradas'}.`);
}

function flashBlock(b) {
  const targets = [];
  for (let hr = b.startH; hr < b.endH; hr += 1 / C.SLOTS_PER_HOUR) {
    const el = ctx.els.cells.querySelector(`.cell[data-d="${b.day}"][data-k="${Math.round((hr - ctx.session.startH) * C.SLOTS_PER_HOUR)}"]`);
    if (el) targets.push(el);
  }
  if (!targets.length) return;
  const r = targets[0].getBoundingClientRect(); const r2 = targets[targets.length - 1].getBoundingClientRect();
  const mid = (r.top + r2.bottom) / 2 + window.scrollY - window.innerHeight / 2;
  window.scrollTo({ top: Math.max(0, mid), behavior: reduceMotion() ? 'auto' : 'smooth' });
  for (const el of targets) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  setTimeout(() => targets.forEach((el) => el.classList.remove('flash')), 2200);
}

function fillBest() {
  if (!ctx || ctx.view !== 'session') return;
  const { session, els } = ctx;
  const { ps, today } = computeView();
  const now = new Date();
  // desde la siguiente media hora
  const fromHour = (Math.floor((now.getHours() * 60 + now.getMinutes()) / 30) + 1) / 2;
  const blocks = ps.length < 2 ? [] : C.bestBlocks(session, ps, { fromDay: Math.max(0, today), fromHour: today >= 0 ? fromHour : 0, limit: 50 }).filter((b) => b.full).slice(0, 6);
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  // sin coincidencias no ocupa sitio
  if (!blocks.length) { els.best.replaceChildren(); return; }
  els.best.replaceChildren(
    h('h2', { class: 'best-title', text: 'Mejores horas' }),
    h('ol', { class: 'best-list' }, blocks.map((b) => h('li', {},
      h('button', {
        type: 'button', class: `best-item glass${b.full ? ' full' : ''}`,
        onclick: () => setWeek(C.weekOfDay(session, b.day), { flash: b }),
        'aria-label': `${C.formatBlock(b)}. ${b.pids.map((id) => byPid.get(id)?.name).join(', ')}. Ver en la rejilla`,
      },
      h('span', { class: 'best-line' },
        h('span', { class: 'best-when', text: `${C.formatDayShort(b.date)} · ${C.formatTime(b.startH)}–${C.formatTime(b.endH)}` }),
        h('span', { class: 'best-count', text: b.full ? 'Todos' : `${b.count}/${b.required}` })),
      h('span', { class: 'best-who' }, b.pids.map((id) => { const p = byPid.get(id); return p ? h('span', { class: `who ${colorClass(p.color)}` }, h('span', { class: 'chip-dot' }), p.me ? 'Tú' : p.name) : null; })))))));
}

// ---------- invitar ----------
async function invite() {
  const url = inviteUrl(ctx.session);
  if (navigator.share) {
    try { await navigator.share({ title: `Let's Meet: ${ctx.session.title}`, text: `Marca cuándo puedes para «${ctx.session.title}»:`, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  if (await copyText(url)) toast('Enlace copiado. Pégalo en el grupo.');
  else toast('No se ha podido copiar. Copia la dirección de la barra del navegador.');
}

// ---------- ajustes de la sesión (pantalla propia) ----------
function renderSettings() {
  if (!ctx?.me) return;
  ctx.view = 'settings';
  window.scrollTo(0, 0);
  const me = ctx.me;
  let color = me.color;
  const name = h('input', { class: 'input bare', maxlength: C.NAME_MAX, value: me.name, autocomplete: 'given-name', 'aria-label': 'Tu nombre' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const palWrap = h('div', { class: 'row-block' });
  const nc = nameColor(name, palWrap);
  const draw = () => { nc.paint(color); palWrap.replaceChildren(palette({ selected: color, taken: takenColors(me.pid), onPick: (c) => { color = c; nc.close(); draw(); } })); };
  draw();
  const back = () => renderSession();
  const save = (e) => {
    e.preventDefault();
    // El nombre solo se compara con los demás si se ha cambiado (si ya coincidía, se puede cambiar solo el color).
    const changed = C.cleanName(name.value) !== me.name;
    const others = changed ? ctx.engine.people().filter((x) => x.pid !== me.pid).map((x) => x.name) : [];
    const nm = C.validateName(name.value, others);
    if (!nm.ok) { err.textContent = nm.error; return; }
    if (nm.value === me.name && color === me.color) { back(); return; }
    me.name = nm.value; me.color = color;
    markDirty();
    back();
    toast('Guardado. Pulsa Enviar para que lo vea el grupo.');
  };
  const iosSafari = isIOS && !standalone();
  root.replaceChildren(h('main', { class: 'screen settings' },
    h('nav', { class: 'navrow' }, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Volver', onclick: back }, icon('back'))),
    h('header', { class: 'session-head' }, h('h1', { class: 'large-title', text: 'Ajustes' }), h('p', { class: 'muted', text: ctx.session.title })),
    h('form', { class: 'create', onsubmit: save, novalidate: true },
      group('Nombre', nc.rows),
      err,
      h('button', { type: 'submit', class: 'btn primary wide' }, 'Guardar')),
    h('section', { class: 'group' },
      h('h2', { class: 'group-title', text: 'Enlaces' }),
      h('div', { class: 'group-body glass' },
        h('button', { type: 'button', class: 'row action', onclick: async () => { toast((await copyText(inviteUrl(ctx.session))) ? 'Enlace de invitación copiado.' : 'No se ha podido copiar.'); } }, icon('copy'), 'Copiar enlace de invitación'),
        h('button', { type: 'button', class: 'row action', onclick: copyPersonal }, icon('copy'), 'Copiar mi enlace personal')),
      h('p', { class: 'group-foot warn', text: 'Tu enlace personal lleva tu clave: sirve para seguir siendo tú en otro móvil o navegador. No lo compartas: quien lo tenga puede escribir en tu nombre.' }),
      iosSafari ? h('p', { class: 'group-foot', text: 'En iPhone, la app añadida a la pantalla de inicio guarda sus datos aparte de Safari. Si la usas, copia antes tu enlace personal y pégalo dentro de la app.' }) : null,
      inAppBrowser ? h('p', { class: 'group-foot', text: 'Estás en el navegador de otra app. Si pasas a Safari o Chrome, copia antes tu enlace personal y ábrelo allí.' }) : null),
    h('section', { class: 'group' },
      h('div', { class: 'group-body glass' }, h('button', { type: 'button', class: 'row action danger', onclick: leave }, icon('trash'), 'Salir de la quedada')))));
}
async function copyPersonal() {
  toast((await copyText(personalUrl())) ? 'Enlace personal copiado. No lo compartas con nadie.' : 'No se ha podido copiar.');
}
async function leave() {
  if (!confirm('¿Salir de esta quedada? Saldrás de la quedada y se borrarán tus horas para todos.')) return;
  const sid = ctx.session.id;
  await closeCtx();
  await removeSession(sid);
  location.hash = '';
}

// ---------- service worker ----------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller; // en la primera instalación no se recarga
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading || !hadController) return; reloading = true; flushMe(); location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => toast("Hay una versión nueva de Let's Meet.", { label: 'Actualizar', fn: () => w.postMessage('SKIP_WAITING') }, 8000);
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(() => { /* sin SW (p. ej. navegador de otra app): la app funciona igual con red */ });
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ctx?.view === 'settings') renderSession(); });

boot().catch((e) => {
  console.error(e);
  root.replaceChildren(h('main', { class: 'screen' }, h('div', { class: 'group-body glass pad' }, h('h1', { text: "No se ha podido abrir Let's Meet" }), h('p', { class: 'muted', text: String(e?.message || e) }))));
});
