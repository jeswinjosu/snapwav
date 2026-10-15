/* ================= Project model, history, persistence ================= */
/* Track colours identify tracks, so they stay multi-coloured. Each theme has its own shades:
   light shades on dark backgrounds, deep shades on light backgrounds (checked for 3:1 and 4.5:1 contrast).
   Tracks store the position (0-9); clips store the dark-theme hex, which maps to the same position. */
const TRACK_COLORS = ['#F87171', '#FB923C', '#FACC15', '#4ADE80', '#2DD4BF', '#38BDF8', '#818CF8', '#C084FC', '#F472B6', '#94A3B8'];
const TRACK_COLORS_LIGHT = ['#B91C1C', '#C2410C', '#A16207', '#15803D', '#0F766E', '#0369A1', '#4F46E5', '#7E22CE', '#BE185D', '#475569'];
/* Snap modes: 'default' = clips and markers attract each other, 'beats' = beat grid, 'off' = free */
const SNAP_MODES = { default: 'Default', beats: 'Beats', off: 'Off' };
const SNAP_DIVS = { bar: -1, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/16': 0.25 };
const DEFAULT_TRACK_H = 104;
/* Track heights fit 2, 3, 4 or 5 header icons */
const TRACK_HEIGHTS = [['S', 72], ['M', 104], ['L', 136], ['XL', 168]];

function newTrack(name, color, type = 'audio') {
  return {
    id: uid(), name, type, color, vol: dbToGain(-3), pan: 0, mute: false, phase: false,
    output: 'master', sends: [], fx: [], curves: {}, lanes: [], clips: [], height: DEFAULT_TRACK_H, showLanes: true,
  };
}
function newProject(name = 'Untitled session') {
  return {
    id: uid(), name, app: 'snapwav', version: 2, created: Date.now(), modified: Date.now(),
    bpm: 120, sig: [4, 4], snap: 'default', snapDiv: '1/4', loop: { enabled: false, start: 0, end: 8 },
    markers: [], media: [], master: { vol: 1, fx: [] }, chainPresets: [],
    tracks: [newTrack('Audio 1', 5), newTrack('Audio 2', 3)],
    view: { zoom: 80, scrollX: 0, scrollY: 0 },
  };
}
function normalizeProject(p) {
  p.loop = Object.assign({ enabled: false, start: 0, end: 8 }, p.loop || {});
  p.sig = p.sig || [4, 4]; p.bpm = p.bpm || 120;
  if (!(p.snap in SNAP_MODES)) { p.snapDiv = p.snap in SNAP_DIVS ? p.snap : '1/4'; p.snap = p.snap === 'off' ? 'off' : 'default'; }
  if (!(p.snapDiv in SNAP_DIVS)) p.snapDiv = '1/4';
  delete p.metronome;
  p.chainPresets = p.chainPresets || [];
  p.markers = p.markers || []; p.media = p.media || []; p.master = Object.assign({ vol: 1, fx: [] }, p.master || {});
  p.view = Object.assign({ zoom: 80, scrollX: 0, scrollY: 0 }, p.view || {});
  const normFx = list => (list || []).filter(f => FX[f.type]).map(f => {
    const o = Object.assign({ id: uid(), bypass: false, sync: false }, f, { params: Object.assign(fxDefaults(f.type), f.params || {}) });
    if (!o.link) o.link = o.id;
    return o;
  });
  p.tracks = (p.tracks || []).map(t => {
    const d = newTrack(t.name || 'Track', t.color ?? 0, t.type || 'audio');
    const o = Object.assign(d, t);
    o.height = { 52: 72, 56: 72, 76: 104, 108: 136, 140: 168 }[o.height] || clamp(o.height || DEFAULT_TRACK_H, 72, 168);
    delete o.solo;   // solo was removed in 1.3; mute other tracks instead
    o.curves = Object.assign({}, o.curves || {});
    o.lanes = (o.lanes || []).map(l => Object.assign({ id: uid() }, l));
    o.fx = normFx(o.fx);
    o.clips = (o.clips || []).map(c => {
      const n = Object.assign({ gain: 1, fadeIn: 0, fadeOut: 0, rate: 1, reversed: false, muted: false, offset: 0, name: '', color: null, pan: 0 }, c);
      n.fx = normFx(n.fx); n.curves = Object.assign({}, n.curves || {});
      return n;
    });
    // v1: track automation lanes → curves + lane views
    if (Array.isArray(o.automation)) {
      for (const a of o.automation) { if (a.points && a.points.length) o.curves[a.target] = a.points; o.lanes.push({ id: a.id || uid(), key: a.target }); }
      delete o.automation;
    }
    // v1: effects on audio tracks become effects on every part, keeping their curves inside each part
    if (o.type === 'audio' && o.fx.length) {
      for (const f of o.fx) {
        const link = f.link || f.id;
        for (const c of o.clips) {
          const copy = JSON.parse(JSON.stringify(f)); copy.id = uid(); copy.link = link; copy.sync = true;
          c.fx.push(copy);
          for (const k in f.params) {
            const abs = o.curves[`fx:${f.id}:${k}`];
            if (!abs || !abs.length) continue;
            const rel = abs.filter(q => q.t > c.start && q.t < c.start + c.duration).map(q => ({ t: q.t - c.start, v: q.v }));
            rel.unshift({ t: 0, v: valueAt(abs, c.start) }); rel.push({ t: c.duration, v: valueAt(abs, c.start + c.duration) });
            c.curves[`fx:${link}:${k}`] = rel;
          }
        }
        for (const k in f.params) delete o.curves[`fx:${f.id}:${k}`];
        o.lanes.forEach(l => { const m = /^fx:([^:]+):(.+)$/.exec(l.key); if (m && m[1] === f.id) l.key = `part:fx:${link}:${m[2]}`; });
      }
      o.fx = [];
    }
    return o;
  });
  p.master.fx = normFx(p.master.fx);
  p.version = 2;
  return p;
}
/* Deep copy of a part with fresh effect ids (links kept so curve lanes and sync still group them) */
function cloneClip(c, extra) {
  const n = JSON.parse(JSON.stringify(c));
  n.id = uid();
  (n.fx || []).forEach(f => { f.id = uid(); });
  return Object.assign(n, extra || {});
}

const App = {
  project: null, tab: 'arrange', sel: new Set(), selTrack: null, clipboard: null, multi: false,
  fxTrack: null, listeners: {}, saveState: 'saved',
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  emit(ev, data) { for (const fn of this.listeners[ev] || []) { try { fn(data); } catch (e) { console.error(e); } } },
  track(id) { return this.project.tracks.find(t => t.id === id); },
  clipById(id) { for (const t of this.project.tracks) { const c = t.clips.find(c => c.id === id); if (c) return [t, c]; } return [null, null]; },
  media(id) { return this.project.media.find(m => m.id === id); },
  beat() { return 60 / this.project.bpm * (4 / this.project.sig[1]); },
  bar() { return this.beat() * this.project.sig[0]; },
  beatGrid() { const d = SNAP_DIVS[this.project.snapDiv] || 1; return d === -1 ? this.bar() : 60 / this.project.bpm * d; },
  /* Magnetic snap: clip edges, markers, loop edges, session start (and optionally the playhead) within 10 px */
  magnet(t, { exclude, playhead = true } = {}) {
    const P = this.project, z = (typeof Arrange !== 'undefined' && Arrange.zoom) || 80, tol = 10 / z;
    let best = t, bd = tol, hit = false;
    const cand = v => { const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; hit = true; } };
    cand(0);
    for (const tr of P.tracks) for (const c of tr.clips) { if (exclude && exclude.has(c.id)) continue; cand(c.start); cand(c.start + c.duration); }
    for (const m of P.markers) cand(m.t);
    if (P.loop.end > P.loop.start) { cand(P.loop.start); cand(P.loop.end); }
    if (playhead && typeof Engine !== 'undefined') cand(Engine.time());
    return { t: best, hit };
  },
  snap(t, opts = {}) {
    const mode = this.project.snap;
    if (mode === 'off' || opts.free) return t;
    if (mode === 'beats') { const g = this.beatGrid(); return Math.round(t / g) * g; }
    return this.magnet(t, opts).t;
  },
  palette() { return Theme.mode === 'light' ? TRACK_COLORS_LIGHT : TRACK_COLORS; },
  colorOf(t) { const pal = this.palette(); return pal[(t && t.color) % pal.length] || pal[0]; },
  /* a stored palette colour (from either theme) shown in the current theme */
  themeColor(hex) { if (!hex) return null; let i = TRACK_COLORS.indexOf(hex); if (i < 0) i = TRACK_COLORS_LIGHT.indexOf(hex); return i >= 0 ? this.palette()[i] : hex; },
  clipColor(t, c) { return (c && c.color && this.themeColor(c.color)) || this.colorOf(t); },
  markerColor(m) { return !m || !m.color || m.color === '#E5E7EB' ? Theme.col.marker : this.themeColor(m.color); },
  nextColor() { const used = this.project.tracks.map(t => t.color); for (let i = 0; i < TRACK_COLORS.length; i++) { const c = (used.length + i) % TRACK_COLORS.length; if (!used.includes(c)) return c; } return used.length % TRACK_COLORS.length; },
};

/* ---------- Undo / redo (JSON snapshots, audio stays in storage) ---------- */
const History = {
  undo: [], redo: [], pending: null, max: 120,
  snap() { const p = App.project; const v = p.view; p.view = undefined; const s = JSON.stringify(p); p.view = v; return s; },
  push() { this.undo.push(this.snap()); if (this.undo.length > this.max) this.undo.shift(); this.redo = []; this.pending = null; App.emit('history'); },
  begin() { if (!this.pending) this.pending = this.snap(); },
  commit() {
    if (!this.pending) return;
    const before = this.pending; this.pending = null;
    if (before !== this.snap()) { this.undo.push(before); if (this.undo.length > this.max) this.undo.shift(); this.redo = []; App.emit('history'); changed(); }
  },
  cancel() { this.pending = null; },
  restore(s) {
    const view = App.project.view;
    App.project = normalizeProject(JSON.parse(s)); App.project.view = view;
    for (const id of [...App.sel]) if (!App.clipById(id)[1]) App.sel.delete(id);
    if (App.selTrack && !App.track(App.selTrack)) App.selTrack = null;
    changed('all');
  },
  doUndo() { if (!this.undo.length) return; this.redo.push(this.snap()); this.restore(this.undo.pop()); App.emit('history'); toast('Undone', { ms: 1200 }); },
  doRedo() { if (!this.redo.length) return; this.undo.push(this.snap()); this.restore(this.redo.pop()); App.emit('history'); toast('Redone', { ms: 1200 }); },
  clear() { this.undo = []; this.redo = []; this.pending = null; App.emit('history'); },
};

/* Apply a change with an undo step */
function mutate(fn, kind = 'all') { History.push(); fn(App.project); changed(kind); }
function changed(kind = 'all') {
  App.project.modified = Date.now();
  markDirty();
  Engine.sync();
  App.emit('change', kind);
}

/* ---------- Autosave ---------- */
const autosave = debounce(() => saveProject(), 1200);
function markDirty() { setSaveState('dirty'); autosave(); }
function setSaveState(s) { App.saveState = s; App.emit('save', s); }
async function saveProject() {
  try {
    const p = App.project;
    await DB.putProject(JSON.parse(JSON.stringify(p)));
    Settings.set('lastProject', p.id);
    setSaveState('saved');
  } catch (e) {
    console.error(e); setSaveState('err');
    toast('Couldn’t save: ' + (e.message || e), { error: true });
  }
}

/* ---------- Media import ---------- */
const AUDIO_EXT = /\.(wav|wave|mp3|ogg|oga|opus|flac|m4a|aac|mp4|webm|aif|aiff|caf)$/i;
async function importFiles(files, opts = {}) {
  files = [...files].filter(f => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name) || f.type === 'video/mp4' || f.type === 'video/webm');
  if (!files.length) { toast('No audio files in that selection', { error: true }); return []; }
  Engine.init();
  const b = busy(files.length > 1 ? `Importing ${files.length} files` : 'Importing audio', files[0].name);
  const added = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    b.set(i / files.length, f.name);
    try {
      const ab = await f.arrayBuffer();
      const id = uid();
      const buf = await Engine.decode(id, ab.slice(0));
      await DB.putMedia({ id, projectId: App.project.id, name: f.name, type: f.type || '', blob: new Blob([ab], { type: f.type || 'application/octet-stream' }) });
      const m = { id, name: f.name, duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, size: f.size, added: Date.now() };
      added.push(m);
    } catch (e) {
      console.warn(e);
      toast(`Couldn’t read ${f.name}. Try WAV, MP3, OGG, FLAC or M4A.`, { error: true, ms: 4000 });
    }
  }
  b.set(1); b.done();
  if (!added.length) return [];
  History.push();
  App.project.media.push(...added);
  if (opts.place) placeMedia(added, opts.at ?? Engine.time(), opts.trackId, opts.fresh);
  changed('all');
  toast(added.length === 1 ? `Imported ${added[0].name}` : `Imported ${added.length} files`, { color: 'var(--c-media)' });
  return added;
}
/* Put media on the timeline: first item on the chosen/selected empty track, others on new tracks */
/* fresh: each file goes on its own track, an empty one or a new one (Add track → Import / Add from media) */
function placeMedia(list, at, trackId, fresh) {
  const P = App.project;
  let first = true, lastTrack = null;
  for (const m of list) {
    let t = null;
    if (!fresh && first && trackId) t = App.track(trackId);
    if (!fresh && !t && first && App.selTrack) { const s = App.track(App.selTrack); if (s && s.type === 'audio' && !s.clips.some(c => c.start < at + m.duration && c.start + c.duration > at)) t = s; }
    if (!t) { const e = P.tracks.find(x => x.type === 'audio' && !x.clips.length && (!lastTrack || P.tracks.indexOf(x) > P.tracks.indexOf(lastTrack))); t = e || null; }
    if (!t) { t = newTrack(baseName(m.name).slice(0, 24) || 'Audio', App.nextColor()); P.tracks.push(t); }
    else if (!t.clips.length && /^Audio \d+$/.test(t.name)) t.name = baseName(m.name).slice(0, 24);
    const c = { id: uid(), mediaId: m.id, name: baseName(m.name), start: Math.max(0, at), offset: 0, duration: m.duration, gain: 1, fadeIn: 0, fadeOut: 0, rate: 1, reversed: false, muted: false, color: null, pan: 0, fx: [], curves: {} };
    t.clips.push(c);
    App.sel.clear(); App.sel.add(c.id); App.selTrack = t.id;
    lastTrack = t; first = false;
  }
}
function mediaUsage(id) { let n = 0; for (const t of App.project.tracks) for (const c of t.clips) if (c.mediaId === id) n++; return n; }

/* ---------- Loading projects ---------- */
async function loadProject(p, { silent } = {}) {
  Engine.init();
  if (Engine.playing) Engine.pause();
  Engine.stopPreview();
  p = normalizeProject(p);
  const need = p.media.filter(m => !Engine.buffers.has(m.id));
  let b = null;
  if (need.length && !silent) b = busy('Opening ' + p.name, '');
  for (let i = 0; i < need.length; i++) {
    const m = need[i];
    b && b.set(i / need.length, m.name);
    try {
      const rec = await DB.getMedia(m.id);
      if (rec && rec.blob) await Engine.decode(m.id, await rec.blob.arrayBuffer());
      else m.missing = true;
    } catch (e) { console.warn('decode failed', m.name, e); m.missing = true; }
  }
  b && b.done();
  measureSession(p);
  App.project = p;
  App.sel.clear(); App.selTrack = p.tracks[0] ? p.tracks[0].id : null; App.fxTrack = null;
  History.clear();
  Engine.pos = 0; Engine.playFrom = 0; Engine.gsig = ''; Engine.csig = '';
  Engine.sync();
  Settings.set('lastProject', p.id);
  setSaveState('saved');
  App.emit('change', 'all'); App.emit('project'); App.emit('seek');
}
async function createProject(name) {
  if (App.project) await saveProject();
  const p = newProject(name);
  await DB.putProject(p);
  await loadProject(p, { silent: true });
  toast('New session created', { color: 'var(--c-project)' });
}
async function openProjectById(id) {
  if (App.project && App.project.id === id) return;
  if (App.project) await saveProject();
  const p = await DB.getProject(id);
  if (!p) { toast('That session is no longer on this device', { error: true }); return; }
  await loadProject(p);
}
async function duplicateProject(id, newName) {
  const src = id === App.project.id ? JSON.parse(JSON.stringify(App.project)) : await DB.getProject(id);
  if (!src) return null;
  const p = normalizeProject(JSON.parse(JSON.stringify(src)));
  p.id = uid(); p.name = newName || (src.name + ' copy'); p.created = p.modified = Date.now();
  const map = {};
  for (const m of p.media) {
    const rec = await DB.getMedia(m.id);
    const nid = uid(); map[m.id] = nid; m.id = nid;
    if (rec) await DB.putMedia(Object.assign({}, rec, { id: nid, projectId: p.id }));
  }
  for (const t of p.tracks) for (const c of t.clips) if (map[c.mediaId]) c.mediaId = map[c.mediaId];
  await DB.putProject(p);
  return p;
}

/* ---------- Project archive (.zip with project.json + media) ---------- */
async function exportProjectZip() {
  await saveProject();
  const P = App.project;
  const b = busy('Packing project', '');
  try {
    const files = [];
    const p = JSON.parse(JSON.stringify(P));
    for (let i = 0; i < p.media.length; i++) {
      const m = p.media[i];
      b.set(i / Math.max(1, p.media.length), m.name);
      const rec = await DB.getMedia(m.id);
      if (!rec) continue;
      const ext = (m.name.match(/\.[^.]+$/) || ['.bin'])[0];
      m.file = `media/${m.id}${ext}`;
      files.push({ name: m.file, data: new Uint8Array(await rec.blob.arrayBuffer()) });
    }
    files.unshift({ name: 'project.json', data: JSON.stringify(p, null, 1) });
    const blob = await Zip.create(files);
    b.done();
    await saveFile(safeName(P.name) + '.snapwav.zip', blob);
  } catch (e) { b.done(); toast('Couldn’t pack the project: ' + e.message, { error: true }); }
}
async function importArchive(file) {
  const b = busy('Reading ' + file.name, '');
  try {
    const files = await Zip.read(await file.arrayBuffer());
    if (files.has('project.json')) {
      const p = normalizeProject(JSON.parse(new TextDecoder().decode(files.get('project.json'))));
      p.id = uid(); p.modified = Date.now();
      Engine.init();
      for (let i = 0; i < p.media.length; i++) {
        const m = p.media[i];
        b.set(i / Math.max(1, p.media.length), m.name);
        const data = m.file && files.get(m.file);
        const nid = uid();
        for (const t of p.tracks) for (const c of t.clips) if (c.mediaId === m.id) c.mediaId = nid;
        m.id = nid; delete m.file;
        if (data) await DB.putMedia({ id: nid, projectId: p.id, name: m.name, type: '', blob: new Blob([data]) });
      }
      b.done();
      if (App.project) await saveProject();
      await DB.putProject(p);
      await loadProject(p);
      toast('Imported ' + p.name, { color: 'var(--c-project)' });
      return;
    }
    if (files.has('project.xml')) { b.done(); await DawProject.importFiles(files, baseName(file.name)); return; }
    throw new Error('No project.json or project.xml inside');
  } catch (e) { b.done(); toast('Couldn’t import: ' + e.message, { error: true, ms: 4000 }); }
}

/* Storage used by one session, measured when the app opens it (not refreshed on every edit) */
async function measureSession(p) {
  App.storage = { sessionId: p.id, measuring: true };
  try {
    let audio = 0;
    for (const m of p.media) { const rec = await DB.getMedia(m.id); if (rec && rec.blob) audio += rec.blob.size; }
    const data = new Blob([JSON.stringify(p)]).size;
    let total = null, quota = null;
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); total = e.usage || 0; quota = e.quota || null; } } catch (e) { /* not supported */ }
    App.storage = { sessionId: p.id, audio, data, total, quota, at: Date.now() };
  } catch (e) { App.storage = { sessionId: p.id, error: true }; }
  App.emit('storage');
}
