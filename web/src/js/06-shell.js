/* ================= Shell: navigation, app bar, transport, shortcuts ================= */
const TABS = {
  arrange: { name: 'Arrange', icon: 'audio-lines' },
  mixer: { name: 'Mixer', icon: 'sliders-vertical' },
  fx: { name: 'Effects', icon: 'wand-sparkles' },
  media: { name: 'Media', icon: 'library' },
  project: { name: 'Project', icon: 'folder-open' },
};
const Views = {};

function setTab(tab, fromHistory) {
  if (!TABS[tab]) return;
  const prev = App.tab;
  App.tab = tab;
  $('#app').dataset.tab = tab;
  for (const k in TABS) $('#v-' + k).hidden = k !== tab;
  for (const b of $$('#bnav button')) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  // page transition: the new section slides in from the side it sits on in the navigation
  if (prev && prev !== tab) {
    const order = Object.keys(TABS), dir = order.indexOf(tab) - order.indexOf(prev);
    const v = $('#v-' + tab);
    v.style.setProperty('--dx', (dir > 0 ? 18 : -18) + 'px');
    v.classList.remove('view-in'); void v.offsetWidth; v.classList.add('view-in');
  }
  moveNavIndicator(!prev || prev === tab);
  $('#sec-badge').innerHTML = ic(TABS[tab].icon);
  $('#sec-name').textContent = TABS[tab].name;
  $('#side-label').textContent = tab === 'arrange' ? 'Tools' : TABS[tab].name;
  App.emit('tab', tab);
  if (Views[tab] && Views[tab].show) Views[tab].show();
  if (!inFrame && !fromHistory && prev !== tab) {
    if (prev === 'arrange') histPush({ tab });
    else if (tab === 'arrange') histBack();
    else try { history.replaceState({ tab }, ''); } catch (e) { /* history blocked */ }
  }
  Loop.kick();
}

/* Bottom navigation: the tinted pill glides to the current section */
function moveNavIndicator(instant) {
  const nav = $('#bnav'), ind = $('#bnav-ind'); if (!nav || !ind) return;
  const btn = nav.querySelector('button[aria-current="page"]'); if (!btn) return;
  const pill = btn.querySelector('.pill'), nr = nav.getBoundingClientRect(), pr = pill.getBoundingClientRect();
  if (!pr.width) return;
  if (instant) ind.classList.add('still');
  ind.style.setProperty('--ix', (pr.left - nr.left) + 'px');
  ind.style.setProperty('--iy', (pr.top - nr.top) + 'px');
  ind.style.width = pr.width + 'px'; ind.style.height = pr.height + 'px';
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => ind.classList.remove('still')));
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => moveNavIndicator(true)).observe(document.getElementById('bnav'));

/* Android back button: close sheets first, then return to Arrange.
   Each open sheet (and each section other than Arrange) owns one history entry. Going back is
   deferred by a tick, so closing one sheet and opening the next (menus do this) reuses the entry
   instead of racing history.back() against pushState, which could leave the app. */
let ignorePop = 0, popDebt = 0, popTimer = 0, inFlight = 0, pushQ = [];
function histFlush() {
  popTimer = 0;
  if (inFlight) { popTimer = setTimeout(histFlush, 30); return; }
  const d = popDebt; popDebt = 0; if (!d) return;
  ignorePop++;
  inFlight = setTimeout(() => histLanded(false), 700);
  try { history.go(-d); } catch (e) { histLanded(false); }
}
/* A traversal finished (or never came): replay entries opened meanwhile */
function histLanded(fromPop) {
  if (!inFlight) return;
  clearTimeout(inFlight); inFlight = 0;
  if (!fromPop) ignorePop = Math.max(0, ignorePop - 1);
  const q = pushQ; pushQ = [];
  for (const st of q) try { history.pushState(st, ''); } catch (e) { /* */ }
}
function histBack() {
  if (inFrame) return;
  if (pushQ.length) { pushQ.pop(); return; }
  popDebt++;
  if (!popTimer) popTimer = setTimeout(histFlush, 0);
}
function histPush(state) {
  if (inFrame) return;
  if (popDebt > 0) { popDebt--; try { history.replaceState(state, ''); } catch (e) { /* */ } return; }
  if (inFlight) { pushQ.push(state); return; }
  try { history.pushState(state, ''); } catch (e) { /* history blocked */ }
}
if (!inFrame) {
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop--; histLanded(true); return; }
    if (Sheets.stack.length) { Sheets.stack[Sheets.stack.length - 1].close(true); return; }
    if (App.tab !== 'arrange') setTab('arrange', true);
  });
  const _open = openSheet;
  openSheet = function (o) {
    const api = _open(o);
    histPush({ sheet: 1 });
    const c = api.close;
    let done = false;
    api.close = function (viaPop) { if (done) return; done = true; if (!viaPop) histBack(); c(); };
    return api;
  };
}

function updateAppBar() {
  const P = App.project;
  $('#proj-name').textContent = P.name;
  const n = P.tracks.length;
  $('#proj-meta').textContent = `${n} track${n === 1 ? '' : 's'} · ${fmtTime(Engine.songEnd(), false)}`;
  $('#tp-loop').classList.toggle('on', P.loop.enabled);
  updatePos();
}
function updateHistoryBtns() {
  for (const b of $$('[data-hist="undo"]')) b.disabled = !History.undo.length;
  for (const b of $$('[data-hist="redo"]')) b.disabled = !History.redo.length;
}
function updateSaveDot() {
  const d = $('#save-dot');
  d.className = 'save-dot' + (App.saveState === 'dirty' ? ' dirty' : App.saveState === 'err' ? ' err' : '');
  d.title = App.saveState === 'dirty' ? 'Saving…' : App.saveState === 'err' ? 'Not saved' : (DB.persistent ? 'Saved on this device' : 'Not saved: storage unavailable');
}

function updatePos() {
  if (!App.project) return;
  const t = Engine.time(), len = Engine.songEnd();
  const remaining = Settings.get('timeMode') === 'remaining';
  $('#tp-pos-main').textContent = remaining ? '−' + fmtTime(Math.max(0, len - t)) : fmtTime(t);
  $('#tp-pos-alt').textContent = '/ ' + fmtTime(len);
}
function updatePlayBtn() {
  const b = $('#tp-play');
  b.classList.toggle('playing', Engine.playing);
  b.innerHTML = ic(Engine.playing ? 'pause' : 'play');
  b.setAttribute('aria-label', Engine.playing ? 'Pause' : 'Play');
}

/* Shared render loop: runs only while something animates */
const Loop = {
  raf: 0, until: 0,
  kick(ms = 600) { this.until = Math.max(this.until, performance.now() + ms); if (!this.raf) this.raf = requestAnimationFrame(t => this.frame(t)); },
  frame() {
    this.raf = 0;
    updatePos();
    for (const k in Views) if (Views[k].frame && (k === App.tab || Views[k].always)) Views[k].frame();
    if (Engine.playing || performance.now() < this.until) this.raf = requestAnimationFrame(t => this.frame(t));
  },
};

function bindShell() {
  for (const b of $$('#bnav button')) b.addEventListener('click', () => { haptic(); setTab(b.dataset.tab); });
  for (const b of $$('[data-hist="undo"]')) b.onclick = () => History.doUndo();
  for (const b of $$('[data-hist="redo"]')) b.onclick = () => History.doRedo();
  $('#proj-name').onclick = async () => {
    const n = await promptSheet('Rename session', App.project.name, { icon: 'pencil', color: 'var(--c-project)' });
    if (n && n.trim()) mutate(p => { p.name = n.trim().slice(0, 80); });
  };
  $('#tp-play').onclick = () => { haptic(); Engine.toggle(); };
  $('#tp-stop').onclick = () => { haptic(); Engine.stop(); };
  $('#tp-start').onclick = () => Engine.seek(0);
  $('#tp-rew').onclick = () => Engine.seek(Math.max(0, Engine.time() - 5));
  $('#tp-ff').onclick = () => Engine.seek(Engine.time() + 5);
  $('#tp-loop').onclick = () => toggleLoop();
  $('#tp-pos').onclick = () => { Settings.set('timeMode', Settings.get('timeMode') === 'remaining' ? 'elapsed' : 'remaining'); updatePos(); };

  App.on('change', () => { updateAppBar(); });
  App.on('project', () => { updateAppBar(); updateHistoryBtns(); });
  App.on('history', updateHistoryBtns);
  App.on('save', updateSaveDot);
  App.on('transport', () => { updatePlayBtn(); updatePos(); Loop.kick(1500); wakeLock(Engine.playing); });
  App.on('seek', () => { updatePos(); Loop.kick(); });

  document.addEventListener('pointerdown', () => { Engine.init(); Engine.resume(); }, { capture: true });
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden && App.saveState === 'dirty') saveProject(); });
  window.addEventListener('pagehide', () => { if (App.saveState === 'dirty') saveProject(); });
}
function toggleLoop() {
  const P = App.project;
  if (!P.loop.enabled && P.loop.end - P.loop.start < 0.05) { P.loop.start = 0; P.loop.end = Math.max(4, Math.min(8, Engine.songEnd() || 8)); }
  if (!P.loop.enabled && (P.loop.end <= P.loop.start)) P.loop.end = P.loop.start + 4;
  P.loop.enabled = !P.loop.enabled;
  changed('transport');
  haptic();
}

function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) { if (e.key === 'Escape') e.target.blur(); return; }
  if (Sheets.stack.length) { if (e.key === 'Escape') closeTopSheet(); return; }
  // Enter / Space on a keyboard-focused button activates that button instead of the play/stop shortcuts
  // (after a mouse click the button isn't :focus-visible, so Space still plays and pauses)
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('button:focus-visible, a[href]:focus-visible, [role="button"]:focus-visible, [role="switch"]:focus-visible')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  const run = fn => { e.preventDefault(); fn(); };
  if (k === ' ' && !mod) return run(() => Engine.toggle());
  if (k === 'Enter' && !mod) return run(() => Engine.stop());
  if (k === 'Home') return run(() => Engine.seek(0));
  if (k === 'End') return run(() => Engine.seek(Engine.songEnd()));
  if (mod && (k === 'z' || k === 'Z')) return run(() => e.shiftKey ? History.doRedo() : History.doUndo());
  if (mod && (k === 'y' || k === 'Y')) return run(() => History.doRedo());
  if (mod && (k === 's' || k === 'S')) return run(() => { saveProject().then(() => toast('Saved', { ms: 1000 })); });
  if (mod && (k === 'e' || k === 'E')) return run(() => exportMixSheet());
  if (mod && (k === 'i' || k === 'I')) return run(() => pickAudio({ place: true }));
  if (mod && (k === 'd' || k === 'D')) return run(() => Edit.duplicate());
  if (mod && (k === 'c' || k === 'C')) return run(() => Edit.copy());
  if (mod && (k === 'x' || k === 'X')) return run(() => Edit.cut());
  if (mod && (k === 'v' || k === 'V')) return run(() => Edit.paste());
  if (mod && (k === 'a' || k === 'A')) return run(() => Edit.selectAll());
  if (mod) return;
  if (k === 'Delete' || k === 'Backspace') return run(() => Edit.remove());
  if (k === 'Escape') return run(() => { App.sel.clear(); App.emit('change', 'sel'); });
  if (k === 's' || k === 'S') return run(() => Edit.split());
  if (k === 'l' || k === 'L') return run(() => toggleLoop());
  if (k === 'm') return run(() => setTab(App.tab === 'mixer' ? 'arrange' : 'mixer'));
  if (k === 'M') return run(() => Edit.toggleMarker());
  if (k === '+' || k === '=') return run(() => Arrange.zoomBy(1.4));
  if (k === '-' || k === '_') return run(() => Arrange.zoomBy(1 / 1.4));
  if (k === 'f' || k === 'F') return run(() => Arrange.zoomFit());
  if (k === 'ArrowLeft') return run(() => Engine.seek(Math.max(0, Engine.time() - (e.shiftKey ? 5 : 1))));
  if (k === 'ArrowRight') return run(() => Engine.seek(Engine.time() + (e.shiftKey ? 5 : 1)));
  if (/^[1-5]$/.test(k)) return run(() => setTab(Object.keys(TABS)[+k - 1]));
}
const SHORTCUTS = [
  ['Space', 'Play / pause'], ['Enter', 'Stop (back to start point)'], ['Home / End', 'Go to start / end'], ['← / →', 'Move playhead 1 s (Shift: 5 s)'],
  ['L', 'Loop on / off'], ['S', 'Split at playhead'], ['Ctrl D', 'Duplicate clips'],
  ['Ctrl C / X / V', 'Copy / cut / paste'], ['Delete', 'Delete selection'], ['Ctrl A', 'Select all clips'], ['Esc', 'Clear selection'],
  ['Ctrl Z', 'Undo'], ['Ctrl Shift Z', 'Redo'], ['Shift M', 'Add marker, or remove the one at the playhead'], ['+ / − / F', 'Zoom in / out / fit'],
  ['M', 'Toggle mixer'], ['1 – 5', 'Switch section'], ['Ctrl I', 'Import audio'], ['Ctrl E', 'Export mix'], ['Ctrl S', 'Save now'],
];

/* Audio file picker */
let pickOpts = {};
function pickAudio(opts = {}) { pickOpts = opts; const f = $('#file-audio'); f.value = ''; f.click(); }
function bindPickers() {
  $('#file-audio').addEventListener('change', async e => {
    const files = [...e.target.files]; if (!files.length) return;
    const o = pickOpts; pickOpts = {};
    await importFiles(files, { place: !!o.place, at: o.at, trackId: o.trackId, fresh: !!o.fresh });
  });
  $('#file-project').addEventListener('change', async e => { const f = e.target.files[0]; if (f) await importArchive(f); });
  // drag & drop anywhere (desktop / tablets)
  document.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', async e => {
    const files = [...(e.dataTransfer.files || [])]; if (!files.length) return;
    e.preventDefault();
    const proj = files.find(f => /\.(zip|dawproject)$/i.test(f.name));
    if (proj) return importArchive(proj);
    await importFiles(files, { place: App.tab === 'arrange' });
  });
}

/* Keep the screen on during playback (Android dims quickly) */
let _wl = null;
async function wakeLock(on) {
  if (window.SnapWavAndroid) { try { window.SnapWavAndroid.keepScreenOn(!!on); } catch (e) { /* */ } return; }
  try {
    if (on && !_wl && navigator.wakeLock) { _wl = await navigator.wakeLock.request('screen'); _wl.addEventListener('release', () => { _wl = null; }); }
    else if (!on && _wl) { const w = _wl; _wl = null; await w.release(); }
  } catch (e) { _wl = null; }
}

/* Landscape layout (tracks left, tools right) follows the CSS media query */
const LANDSCAPE = matchMedia('(orientation: landscape) and (min-width: 600px)');
function isLandscape() { return LANDSCAPE.matches; }
LANDSCAPE.addEventListener ? LANDSCAPE.addEventListener('change', () => App.emit('layout')) : LANDSCAPE.addListener(() => App.emit('layout'));
