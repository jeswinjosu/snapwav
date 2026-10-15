'use strict';
/* ================= Utilities ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const uid = () => Math.random().toString(36).slice(2, 9) + (Date.now() % 1e6).toString(36);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const isTouch = () => matchMedia('(pointer: coarse)').matches;
const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

/* Volume law: fader position p (0..1) <-> linear gain g = 2p² (p = .7071 is 0 dB, top is +6 dB) */
const posToGain = p => 2 * p * p;
const gainToPos = g => Math.sqrt(Math.max(0, g) / 2);
const gainToDb = g => g <= 0.00001 ? -Infinity : 20 * Math.log10(g);
const dbToGain = db => db <= -96 ? 0 : Math.pow(10, db / 20);
const fmtDb = db => !isFinite(db) || db < -95 ? '-∞' : (db > 0.05 ? '+' : '') + db.toFixed(1);
const fmtPan = p => Math.abs(p) < 0.005 ? 'C' : (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100);

function fmtTime(sec, ms = true) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60), s = sec - m * 60;
  const ss = Math.floor(s).toString().padStart(2, '0');
  return ms ? `${m}:${ss}.${Math.floor((s % 1) * 1000).toString().padStart(3, '0')}` : `${m}:${ss}`;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? 'Today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
function safeName(s) { return String(s || 'untitled').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 80) || 'untitled'; }
function baseName(fn) { return String(fn).replace(/\.[^.]+$/, ''); }

/* Tiny DOM builder */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') { for (const sk in v) { if (sk.startsWith('--')) e.style.setProperty(sk, v[sk]); else e.style[sk] = v[sk]; } }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

/* Local settings (per device) */
const Settings = {
  _d: { timeMode: 'elapsed', follow: true, haptics: true, lastProject: null, exportBits: 16, exportRate: 0, theme: 'system' },
  get(k) { try { const v = localStorage.getItem('snapwav.' + k); return v == null ? this._d[k] : JSON.parse(v); } catch (e) { return this._d[k]; } },
  set(k, v) { try { localStorage.setItem('snapwav.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  /* one-time move of settings saved under the app's former name */
  migrate() { try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('strata.')) { const n = 'snapwav.' + k.slice(7); if (localStorage.getItem(n) == null) localStorage.setItem(n, localStorage.getItem(k)); localStorage.removeItem(k); } } } catch (e) { /* storage blocked */ } },
};

/* ---------- Theme: dark and light, both built on the logo orange ----------
   CSS colours live in style.css (:root[data-theme]); these are the matching colours for canvas drawing. */
const PALETTES = {
  dark: {
    bg: '#0F0F11', row: '#141417', rowSel: '#241C1A', line: '#26262B', line2: '#36363C', bar: '#45454D',
    text: '#F4F4F5', dim: '#B4B4BC', faint: '#93939C', accent: '#FF8A3D', onAccent: '#18181B',
    play: '#F4F4F5', marker: '#D4D4D8', ruler: '#18181B', rulerBand: '#121214', tickMajor: '#5C5C66', tickMinor: '#34343A',
    laneTall: '#161312', clipText: '#18181B', clipBody: 0.17, clipStrip: 0.85, wave: 0.95,
    fadeFill: 'rgba(0,0,0,0.45)', fadeLine: 'rgba(255,255,255,0.8)', handle: '#FFFFFF', selLine: '#FFFFFF',
    hatch: 'rgba(255,255,255,0.05)', labelBg: 'rgba(15,15,17,0.88)', bubble: '#37373D', bubbleText: '#F4F4F5',
    knobRing: '#37373D', knobCenter: '#2B2B30', knobPtr: '#F4F4F5',
  },
  light: {
    bg: '#F4F4F5', row: '#FFFFFF', rowSel: '#FBF3F0', line: '#E4E4E7', line2: '#D1D1D6', bar: '#B4B4BC',
    text: '#18181B', dim: '#4E4E56', faint: '#62626B', accent: '#B53C0B', onAccent: '#FFFFFF',
    play: '#18181B', marker: '#52525B', ruler: '#FFFFFF', rulerBand: '#F4F4F5', tickMajor: '#8A8A93', tickMinor: '#D4D4D8',
    laneTall: '#FBF6F3', clipText: '#FFFFFF', clipBody: 0.12, clipStrip: 0.95, wave: 1,
    fadeFill: 'rgba(255,255,255,0.55)', fadeLine: 'rgba(24,24,27,0.75)', handle: '#FFFFFF', selLine: '#18181B',
    hatch: 'rgba(0,0,0,0.05)', labelBg: 'rgba(255,255,255,0.92)', bubble: '#3F3F46', bubbleText: '#FFFFFF',
    knobRing: '#D1D1D6', knobCenter: '#EFEFF1', knobPtr: '#18181B',
  },
};
const Theme = {
  mode: 'dark', col: Object.assign({}, PALETTES.dark), night: null,
  pref() { const p = Settings.get('theme'); return p === 'light' || p === 'dark' ? p : 'system'; },
  systemDark() {
    if (this.night != null) return this.night;
    try { return !matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return true; }
  },
  resolve() { const p = this.pref(); return p === 'system' ? (this.systemDark() ? 'dark' : 'light') : p; },
  apply() {
    const m = this.resolve(), changedMode = m !== this.mode;
    this.mode = m;
    Object.assign(this.col, PALETTES[m]);
    document.documentElement.dataset.theme = m;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', PALETTES[m].bg);
    try { if (window.SnapWavAndroid && window.SnapWavAndroid.setBars) window.SnapWavAndroid.setBars(PALETTES[m].bg, m === 'light'); } catch (e) { /* older app */ }
    if (changedMode && typeof App !== 'undefined' && App.emit) App.emit('theme', m);
  },
  set(p) { Settings.set('theme', p); this.apply(); },
  init() {
    try { const i = window.SnapWavAndroid && JSON.parse(window.SnapWavAndroid.info()); if (i && typeof i.night === 'boolean') this.night = i.night; } catch (e) { /* browser */ }
    try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (this.night == null) this.apply(); }); } catch (e) { /* old browser */ }
    window.snapwavSystemTheme = night => { this.night = !!night; this.apply(); };
    this.apply();
  },
};

function haptic(ms = 8) {
  if (!Settings.get('haptics')) return;
  try { if (window.SnapWavAndroid) window.SnapWavAndroid.vibrate(ms); else if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* not allowed */ }
}

/* ---------- Toasts ---------- */
function toast(msg, opts = {}) {
  const root = $('#toasts');
  for (const old of [...root.children]) if (old.firstChild && old.firstChild.textContent === msg) old.remove();
  const t = h('div', { class: 'toast' + (opts.error ? ' err' : ''), role: 'status' }, h('span', { style: { flex: '1' } }, msg));
  if (opts.color) t.style.setProperty('--tc', opts.color);
  if (opts.action) t.append(h('button', { onclick: () => { opts.onAction && opts.onAction(); t.remove(); } }, opts.action));
  root.append(t);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => t.remove(), opts.ms || (opts.action ? 5000 : 2600));
}

/* ---------- Help tips ----------
   A small "?" button next to a label. Tapping it opens an explanation bubble right under the label;
   tap it again, tap outside the field or press Escape to close. render() is called on every open
   (and on update()), so the bubble can show live numbers such as an estimated file size. */
const HelpTip = { open: null, seq: 0 };
function helpTip(label, render) {
  const id = 'help-tip-' + (++HelpTip.seq);
  const btn = h('button', { class: 'help-btn', type: 'button', title: `About ${label}`, 'aria-label': `About ${label}`, 'aria-expanded': 'false', 'aria-controls': id, html: ic('circle-help') });
  const tip = h('div', { class: 'help-tip', id, 'aria-live': 'polite', hidden: true });
  const fill = () => { tip.innerHTML = ''; tip.append(...[].concat(render())); };
  let scope = null;
  // closes on click (not pointerdown) so the layout doesn't shift under the finger before the tap lands
  const outside = e => { if (!tip.isConnected || !(scope || btn).contains(e.target)) api.hide(); };
  const esc = e => { if (!tip.isConnected) { api.hide(); return; } if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); api.hide(); btn.focus(); } };
  const api = {
    btn, tip,
    get isOpen() { return !tip.hidden; },
    update() { if (!tip.hidden) fill(); },
    show() {
      if (HelpTip.open && HelpTip.open !== api) HelpTip.open.hide();
      scope = btn.closest('.field') || btn.parentNode;
      fill(); tip.hidden = false;
      const pr = tip.getBoundingClientRect(), br = btn.getBoundingClientRect();
      tip.style.setProperty('--tip-x', Math.max(8, Math.round(br.left + br.width / 2 - pr.left - 6)) + 'px');
      btn.setAttribute('aria-expanded', 'true'); btn.classList.add('on');
      requestAnimationFrame(() => { try { scope.scrollIntoView({ block: 'nearest', behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' }); } catch (e) { /* old WebView */ } });
      HelpTip.open = api;
      document.addEventListener('click', outside, true); document.addEventListener('keydown', esc, true);
    },
    hide() {
      tip.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('on');
      if (HelpTip.open === api) HelpTip.open = null;
      document.removeEventListener('click', outside, true); document.removeEventListener('keydown', esc, true);
    },
  };
  btn.addEventListener('click', () => { haptic(); api.isOpen ? api.hide() : api.show(); });
  return api;
}

/* ---------- Bottom sheets ---------- */
const Sheets = { stack: [] };
const REDUCED_MOTION = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } })();
/* Bottom sheet: slides up from the bottom edge; drag the holding bar (or the title row) down to close it */
function openSheet({ title, icon, color, body, actions, onClose, wide, focus }) {
  const back = h('div', { class: 'sheet-back' });
  const scrim = h('div', { class: 'sheet-scrim' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
  if (wide) sheet.style.maxWidth = '720px';
  const grab = h('div', { class: 'grab-zone', title: 'Drag down to close' }, h('div', { class: 'grab' }));
  sheet.append(grab);
  const head = h('div', { class: 'sheet-head' });
  if (icon) { const b = h('div', { class: 'sh-ic', html: ic(icon) }); b.style.setProperty('--shc', color || 'var(--accent)'); head.append(b); }
  head.append(h('h3', { text: title || '' }));
  const closeBtn = h('button', { class: 'ibtn', 'aria-label': 'Close', html: ic('x') });
  head.append(closeBtn);
  sheet.append(head);
  const api = { el: sheet, body: null, close: () => close() };
  const bodyEl = h('div', { class: 'sheet-body' });
  api.body = bodyEl;
  if (body) typeof body === 'string' ? (bodyEl.innerHTML = body) : bodyEl.append(body);
  sheet.append(bodyEl);
  let actEl = null;
  if (actions && actions.length) {
    actEl = h('div', { class: 'sheet-actions' });
    for (const a of actions) {
      const b = h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), html: (a.icon ? ic(a.icon) : '') + esc(a.label) });
      if (a.primary && color) b.style.setProperty('--accent', color);
      b.addEventListener('click', () => { const r = a.onClick && a.onClick(); if (r !== false) api.close(); });
      actEl.append(b);
    }
    sheet.append(actEl);
  }
  back.append(scrim, sheet);
  document.body.append(back);
  let closed = false, offset = 0;
  function close() {
    if (closed) return; closed = true;
    Sheets.stack = Sheets.stack.filter(s => s !== api);
    back.classList.add('closing');
    back.setAttribute('aria-hidden', 'true');
    sheet.classList.remove('dragging');
    sheet.style.transition = ''; sheet.style.transform = ''; sheet.style.animation = ''; scrim.style.opacity = '';
    sheet.style.setProperty('--drag', offset + 'px');
    if (REDUCED_MOTION.matches) back.remove(); else setTimeout(() => back.remove(), 250);
    onClose && onClose();
  }
  // drag to dismiss
  let drag = null;
  const down = e => {
    if (e.button > 0 || closed) return;
    if (e.currentTarget === head && e.target.closest('button, input, a')) return;
    drag = { id: e.pointerId, y0: e.clientY, last: e.clientY, t: performance.now(), v: 0, h: sheet.offsetHeight };
    sheet.classList.add('dragging'); sheet.style.animation = 'none'; sheet.style.transition = 'none';
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* */ }
  };
  const move = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const now = performance.now(), dt = Math.max(1, now - drag.t);
    drag.v = (e.clientY - drag.last) / dt; drag.last = e.clientY; drag.t = now;
    const dy = e.clientY - drag.y0;
    offset = dy > 0 ? dy : dy / 6;                     // a little resistance when pulled up
    sheet.style.transform = `translateY(${offset}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - Math.max(0, offset) / drag.h));
  };
  const up = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (offset > Math.min(140, d.h * 0.3) || (d.v > 0.55 && offset > 16)) { offset = Math.max(0, offset); api.close(); return; }
    sheet.classList.remove('dragging');
    sheet.style.transition = 'transform .3s var(--ease-spring)'; sheet.style.transform = '';
    scrim.style.transition = 'opacity .3s'; scrim.style.opacity = '';
    offset = 0;
  };
  for (const el of [grab, head]) {
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  scrim.addEventListener('click', () => api.close());
  closeBtn.addEventListener('click', () => api.close());
  Sheets.stack.push(api);
  if (focus) setTimeout(() => { const f = sheet.querySelector('input.tinput'); if (f) { f.focus(); f.select && f.select(); } }, 60);
  else setTimeout(() => { try { closeBtn.focus({ preventScroll: true }); } catch (e) { /* */ } }, 30);
  return api;
}
function closeTopSheet() { const s = Sheets.stack[Sheets.stack.length - 1]; if (s) { s.close(); return true; } return false; }

function confirmSheet(title, message, { ok = 'Confirm', danger = false, icon = 'info', color } = {}) {
  return new Promise(res => {
    let v = false;
    openSheet({
      title, icon, color: color || (danger ? 'var(--c-danger)' : undefined),
      body: h('p', { style: { margin: '0 0 6px', color: 'var(--dim)' }, text: message }),
      actions: [{ label: 'Cancel' }, { label: ok, primary: !danger, danger, onClick: () => { v = true; } }],
      onClose: () => res(v),
    });
  });
}
function promptSheet(title, value, { label = 'Name', ok = 'Save', icon = 'pencil', color, type = 'text' } = {}) {
  return new Promise(res => {
    let v = null;
    const input = h('input', { class: 'tinput', type, value: value ?? '', id: 'prompt-input', autocomplete: 'off' });
    const body = h('div', { class: 'field' }, h('label', { for: 'prompt-input', text: label }), input);
    const s = openSheet({
      title, icon, color, body, focus: true,
      actions: [{ label: 'Cancel' }, { label: ok, primary: true, onClick: () => { v = input.value; } }],
      onClose: () => res(v),
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { v = input.value; s.close(); } });
  });
}
/* items: {icon, label, hint, color, danger, disabled, onClick} | 'sep' */
function menuSheet(title, items, { icon, color } = {}) {
  const m = h('div', { class: 'menu' });
  let s;
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { m.append(h('hr')); continue; }
    const b = h('button', { class: it.danger ? 'danger' : '', disabled: it.disabled, html: ic(it.icon || 'chevron-right') + `<span>${esc(it.label)}</span>` + (it.hint ? `<small>${esc(it.hint)}</small>` : '') });
    if (it.color) b.style.setProperty('--mc', it.color);
    b.addEventListener('click', () => { s.close(); it.onClick && it.onClick(); });
    m.append(b);
  }
  s = openSheet({ title, icon, color, body: m });
  return s;
}

/* Busy overlay with progress */
function busy(title, sub = '') {
  const bar = h('i');
  const subEl = h('small', { text: sub });
  const el = h('div', { class: 'busy' }, h('div', { class: 'box' }, h('b', { text: title }), h('div', { class: 'progress' }, bar), subEl));
  document.body.append(el);
  return {
    set(p, s) { bar.style.width = Math.round(clamp(p, 0, 1) * 100) + '%'; if (s != null) subEl.textContent = s; },
    done() { el.remove(); },
  };
}

/* Range slider helper: sets the filled-track CSS var */
function paintRange(inp) {
  const min = +inp.min || 0, max = +inp.max || 100, v = +inp.value;
  inp.style.setProperty('--p', ((v - min) / (max - min) * 100) + '%');
}

/* Draggable pointer helper with capture; returns cleanup */
function dragOn(el, { down, move, up, tap, dbl }) {
  let st = null, lastTap = 0;
  el.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    st = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, t0: performance.now() };
    down && down(e, st);
  });
  el.addEventListener('pointermove', e => {
    if (!st || e.pointerId !== st.id) return;
    st.x = e.clientX; st.y = e.clientY;
    if (!st.moved && Math.hypot(st.x - st.x0, st.y - st.y0) > 3) st.moved = true;
    if (st.moved) move && move(e, st);
  });
  const end = e => {
    if (!st || e.pointerId !== st.id) return;
    const s = st; st = null;
    up && up(e, s);
    if (!s.moved && e.type === 'pointerup') {
      const now = performance.now();
      if (dbl && now - lastTap < 320) { lastTap = 0; dbl(e, s); } else { lastTap = now; tap && tap(e, s); }
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/* File saving: Claude viewer → downloads capability (allow-listed extensions, else zipped);
   standalone/PWA → normal download link. */
const DL_OK = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'txt', 'json', 'md', 'docx', 'pptx', 'epub', 'csv', 'ttf', 'html', 'svg', 'pdf', 'xlsx', 'zip'];
let _dlCap;
async function getDownloads() {
  if (_dlCap !== undefined) return _dlCap;
  if (!(window.claude && typeof window.claude.use === 'function')) return (_dlCap = null);
  try { _dlCap = await window.claude.use('downloads'); } catch (e) { _dlCap = null; }
  return _dlCap;
}
async function saveFile(filename, blob) {
  if (window.SnapWavAndroid) return nativeSave(filename, blob);
  const ext = filename.split('.').pop().toLowerCase();
  const dl = await getDownloads();
  if (dl) {
    let name = filename, data = blob;
    if (!DL_OK.includes(ext)) {
      data = await Zip.create([{ name: filename, data: new Uint8Array(await blob.arrayBuffer()) }]);
      name = baseName(filename) + '.zip';
    }
    try {
      await dl.save({ filename: name, data });
      toast(name === filename ? `Saved ${name}` : `Saved ${name} (contains ${filename})`, { color: 'var(--c-ok)' });
      return true;
    } catch (e) {
      if (e && e.code === 'declined') toast('Save cancelled');
      else if (e && e.code === 'rate_limited') toast('A save prompt is already open');
      else toast('This view can’t save files: ' + ((e && e.message) || 'unavailable'), { error: true });
      return false;
    }
  }
  if (inFrame && window.claude) { toast('Saving files isn’t available here', { error: true }); return false; }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Saved ${filename}`, { color: 'var(--c-ok)' });
  return true;
}
