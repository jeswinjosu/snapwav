/* ================= Editing operations and sheets ================= */
function splitCurve(pts, u) {
  const a = pts.filter(p => p.t < u).map(p => ({ t: p.t, v: p.v }));
  const b = pts.filter(p => p.t > u).map(p => ({ t: p.t - u, v: p.v }));
  const mid = valueAt(pts, u);
  a.push({ t: u, v: mid }); b.unshift({ t: 0, v: mid });
  return [a, b];
}
function splitClip(c, at) {
  const u = at - c.start, rate = c.rate || 1;
  const b = cloneClip(c, { start: at, duration: c.duration - u });
  c.curves = c.curves || {}; b.curves = {};
  for (const k in c.curves) { const pts = c.curves[k]; if (!pts || !pts.length) continue; const [x, y] = splitCurve(pts, u); c.curves[k] = x; b.curves[k] = y; }
  if (!c.reversed) { b.offset = c.offset + u * rate; c.duration = u; }
  else { b.offset = c.offset; c.offset = c.offset + (c.duration - u) * rate; c.duration = u; }
  b.fadeIn = 0; b.fadeOut = Math.min(c.fadeOut, b.duration);
  c.fadeOut = 0; c.fadeIn = Math.min(c.fadeIn, c.duration);
  return b;
}
function clipPeak(c) {
  const buf = Engine.buffers.get(c.mediaId); if (!buf) return 0;
  const sr = buf.sampleRate, rate = c.rate || 1;
  const i0 = Math.floor(c.offset * sr), i1 = Math.min(buf.length, Math.ceil((c.offset + c.duration * rate) * sr));
  let pk = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = i0; i < i1; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; } }
  return pk;
}
function wouldCycle(fromId, toId) {
  const seen = new Set();
  const walk = id => {
    if (id === fromId) return true;
    if (seen.has(id)) return false; seen.add(id);
    const t = App.track(id); if (!t) return false;
    if (t.output !== 'master' && walk(t.output)) return true;
    return (t.sends || []).some(s => walk(s.target));
  };
  return walk(toId);
}
function busTargets(t) { return App.project.tracks.filter(b => b.type === 'bus' && b.id !== t.id && !wouldCycle(t.id, b.id)); }

const Edit = {
  selected() { const out = []; for (const t of App.project.tracks) for (const c of t.clips) if (App.sel.has(c.id)) out.push([t, c]); return out; },
  toggleTrack(id, k) { const t = App.track(id); History.push(); t[k] = !t[k]; changed('mix'); haptic(); },
  split(at = Engine.time()) {
    const inside = c => at > c.start + 0.005 && at < c.start + c.duration - 0.005;
    let list = this.selected().filter(([, c]) => inside(c));
    if (!list.length && !App.sel.size) { const t = App.track(App.selTrack); if (t) list = t.clips.filter(inside).map(c => [t, c]); }
    if (!list.length) { toast('Move the playhead over a clip to split it'); return; }
    mutate(() => { App.sel.clear(); for (const [t, c] of list) { const b = splitClip(c, at); t.clips.push(b); App.sel.add(b.id); } });
    haptic();
  },
  duplicate() {
    const list = this.selected(); if (!list.length) return;
    const minS = Math.min(...list.map(([, c]) => c.start)), maxE = Math.max(...list.map(([, c]) => c.start + c.duration));
    const shift = list.length > 1 ? maxE - minS : list[0][1].duration;
    mutate(() => { App.sel.clear(); for (const [t, c] of list) { const n = cloneClip(c, { start: c.start + shift }); t.clips.push(n); App.sel.add(n.id); } });
  },
  copy() {
    const list = this.selected(); if (!list.length) return false;
    const audio = App.project.tracks.filter(t => t.type === 'audio');
    const minS = Math.min(...list.map(([, c]) => c.start)), baseTi = Math.min(...list.map(([t]) => audio.indexOf(t)));
    App.clipboard = list.map(([t, c]) => ({ dt: audio.indexOf(t) - baseTi, rel: c.start - minS, clip: JSON.parse(JSON.stringify(c)) }));
    toast(`Copied ${list.length} clip${list.length > 1 ? 's' : ''}`, { ms: 1200 });
    return true;
  },
  cut() { if (this.copy()) this.remove(true); },
  paste(at = Engine.time(), trackId = App.selTrack) {
    if (!App.clipboard) return;
    let audio = App.project.tracks.filter(t => t.type === 'audio');
    mutate(P => {
      if (!audio.length) { P.tracks.push(newTrack('Audio 1', App.nextColor())); audio = P.tracks.filter(t => t.type === 'audio'); }
      let base = audio.findIndex(t => t.id === trackId); if (base < 0) base = 0;
      App.sel.clear();
      for (const it of App.clipboard) {
        let ti = base + it.dt;
        while (ti >= audio.length) { const nt = newTrack('Audio ' + (audio.length + 1), App.nextColor()); P.tracks.push(nt); audio.push(nt); }
        const c = cloneClip(it.clip, { start: Math.max(0, at + it.rel) });
        audio[ti].clips.push(c); App.sel.add(c.id);
      }
    });
  },
  remove(silent) {
    if (!App.sel.size) {
      const sp = Arrange.selPoint;
      if (sp && sp.pts) { mutate(() => { const i = sp.pts.indexOf(sp.p); if (i >= 0) sp.pts.splice(i, 1); }); Arrange.selPoint = null; }
      return;
    }
    const n = App.sel.size;
    mutate(P => { for (const t of P.tracks) t.clips = t.clips.filter(c => !App.sel.has(c.id)); App.sel.clear(); });
    if (!silent) toast(`Deleted ${n} clip${n > 1 ? 's' : ''}`, { action: 'Undo', onAction: () => History.doUndo() });
  },
  reverse() { const l = this.selected(); if (!l.length) return; mutate(() => { for (const [, c] of l) c.reversed = !c.reversed; }); },
  normalize() {
    const l = this.selected(); if (!l.length) return;
    mutate(() => { for (const [, c] of l) { const pk = clipPeak(c); if (pk > 0.0001) c.gain = clamp(dbToGain(-0.3) / pk, 0.01, 63); } });
    toast('Normalized to −0.3 dBFS', { ms: 1500 });
  },
  toggleMute() { const l = this.selected(); if (!l.length) return; const v = !l[0][1].muted; mutate(() => { for (const [, c] of l) c.muted = v; }); },
  quickFades(sec = 0.05) { const l = this.selected(); mutate(() => { for (const [, c] of l) { c.fadeIn = Math.min(sec, c.duration / 2); c.fadeOut = Math.min(sec, c.duration / 2); } }); },
  selectAll() { App.sel.clear(); for (const t of App.project.tracks) for (const c of t.clips) App.sel.add(c.id); App.emit('sel'); },
  selectTrackClips(id) { App.sel.clear(); for (const c of App.track(id).clips) App.sel.add(c.id); App.emit('sel'); },
  addMarker(at = Engine.time()) {
    const P = App.project;
    mutate(() => { P.markers.push({ id: uid(), t: Math.max(0, at), name: '', color: '#E5E7EB' }); P.markers.sort((a, b) => a.t - b.t); });
    haptic();
  },
  /* Marker pill: removes the marker within 100 ms of the playhead, otherwise adds one at the playhead */
  toggleMarker() {
    const near = Arrange.nearMarker();
    if (near) { mutate(P => { P.markers = P.markers.filter(m => m !== near); }); haptic(); toast('Marker removed', { ms: 1200, action: 'Undo', onAction: () => History.doUndo() }); }
    else this.addMarker(Engine.time());
  },
};

/* Reset-to-default button used next to sliders */
function resetBtn(label, onClick) {
  const b = h('button', { class: 'rst', type: 'button', title: 'Reset to default', 'aria-label': 'Reset ' + label + ' to default', html: ic('rotate-ccw', 'sm') });
  b.addEventListener('click', ev => { ev.stopPropagation(); haptic(); onClick(); });
  return b;
}
function sliderRow({ id, label, min, max, step, value, fmt, color, onInput, onChange, def, disabled }) {
  const inp = h('input', { type: 'range', min, max, step, value, id, disabled });
  if (color) inp.style.setProperty('--rc', color);
  const val = h('span', { class: 'val', text: fmt(+value) });
  const near = v => Math.abs(v - def) < (+step || 0.001) / 2;
  const rst = def == null ? null : resetBtn(label, () => { inp.value = def; paint(); onInput(+def); if (onChange) onChange(+def); });
  const paint = () => { paintRange(inp); val.textContent = fmt(+inp.value); if (rst) rst.disabled = disabled || near(+inp.value); };
  paint();
  inp.addEventListener('input', () => { paint(); onInput(+inp.value); });
  if (onChange) inp.addEventListener('change', () => onChange(+inp.value));
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), h('div', { class: 'inline-row' }, inp, val, rst));
}
function switchRow(id, label, sub, checked, onChange, color) {
  const inp = h('input', { type: 'checkbox', id, checked });
  inp.addEventListener('change', () => onChange(inp.checked));
  const sw = h('label', { class: 'switch' }, inp, h('i'));
  if (color) sw.style.setProperty('--rc', color);
  return h('div', { class: 'setrow' }, h('div', { class: 'txt' }, h('label', { for: id, text: label }), sub ? h('small', { text: sub }) : null), sw);
}
function swatchRow(current, onPick, includeNone) {
  const row = h('div', { class: 'swatches' });
  const draw = cur => {
    row.innerHTML = '';
    if (includeNone) { const b = h('button', { class: 'swatch' + (cur == null ? ' on' : ''), title: 'Track colour', html: '' }); b.style.setProperty('--sw', 'conic-gradient(#F87171, #FACC15, #4ADE80, #38BDF8, #C084FC, #F87171)'); b.style.background = 'conic-gradient(#F87171, #FACC15, #4ADE80, #38BDF8, #C084FC, #F87171)'; b.onclick = () => { onPick(null); draw(null); }; row.append(b); }
    const pal = App.palette();
    TRACK_COLORS.forEach((c, i) => { const b = h('button', { class: 'swatch' + (cur === i || cur === c || cur === TRACK_COLORS_LIGHT[i] ? ' on' : ''), 'aria-label': 'Colour ' + (i + 1) }); b.style.setProperty('--sw', pal[i]); b.onclick = () => { onPick(i); draw(includeNone ? c : i); }; row.append(b); });
  };
  draw(current);
  return row;
}

function clipInspector(id) {
  const [t, c] = App.clipById(id); if (!c) return;
  History.begin();
  const col = App.clipColor(t, c);
  const m = App.media(c.mediaId);
  const sync = debounce(() => changed('clips'), 160);
  const live = () => { Arrange.draw(); sync(); };
  const name = h('input', { class: 'tinput', id: 'ci-name', value: c.name || '', placeholder: m ? baseName(m.name) : 'Clip' });
  name.addEventListener('input', () => { c.name = name.value; live(); });
  const maxFade = () => Math.min(c.duration, 30);
  const fiRow = sliderRow({ id: 'ci-fi', label: 'Fade in', min: 0, max: maxFade(), step: 0.01, value: c.fadeIn, def: 0, fmt: v => v.toFixed(2) + ' s', color: col, onInput: v => { c.fadeIn = Math.min(v, c.duration - c.fadeOut); live(); } });
  const foRow = sliderRow({ id: 'ci-fo', label: 'Fade out', min: 0, max: maxFade(), step: 0.01, value: c.fadeOut, def: 0, fmt: v => v.toFixed(2) + ' s', color: col, onInput: v => { c.fadeOut = Math.min(v, c.duration - c.fadeIn); live(); } });
  const semis = r => { const s = 12 * Math.log2(r); return (s >= 0 ? '+' : '') + s.toFixed(1) + ' st'; };
  const body = h('div', {},
    h('div', { class: 'field' }, h('label', { for: 'ci-name', text: 'Clip name' }), name),
    sliderRow({ id: 'ci-gain', label: 'Clip gain', min: -24, max: 12, step: 0.1, value: Math.max(-24, gainToDb(c.gain)), def: 0, fmt: v => fmtDb(v) + ' dB', color: col, onInput: v => { c.gain = dbToGain(v); live(); } }),
    fiRow, foRow,
    sliderRow({
      id: 'ci-rate', label: 'Speed (changes pitch)', min: 0.5, max: 2, step: 0.01, value: c.rate || 1, def: 1, fmt: v => '×' + v.toFixed(2) + ' · ' + semis(v), color: col,
      onInput: v => {
        const span = c.duration * (c.rate || 1);
        c.rate = v; c.duration = span / v;
        c.fadeIn = Math.min(c.fadeIn, c.duration); c.fadeOut = Math.min(c.fadeOut, c.duration - c.fadeIn);
        live();
      },
    }),
    sliderRow({ id: 'ci-pan', label: 'Part pan', min: -1, max: 1, step: 0.01, value: c.pan || 0, def: 0, fmt: v => fmtPan(v), color: col, onInput: v => { c.pan = Math.abs(v) < 0.02 ? 0 : v; Engine.setClipPan(c); sync(); } }),
    h('div', { class: 'link-row', style: { margin: '2px 0 6px' } }, h('span', { html: ic('wand-sparkles'), style: { color: 'var(--c-fx)', display: 'inline-flex' } }),
      h('span', { class: 'grow', html: (c.fx && c.fx.length) ? `<b>${c.fx.length} effect${c.fx.length > 1 ? 's' : ''}</b> on this part: ${esc(c.fx.map(f => FX[f.type].name).join(', '))}` : 'No effects on this part yet' }),
      h('button', { class: 'btn', style: { height: '34px' }, text: 'Effects', onclick: () => { closeTopSheet(); openFxFor(t.id, c.id); } })),
    switchRow('ci-mute', 'Mute clip', 'Silences this clip only', c.muted, v => { c.muted = v; live(); }, col),
    switchRow('ci-rev', 'Reverse', 'Plays the region backwards', c.reversed, v => { c.reversed = v; live(); }, col),
    h('div', { class: 'field', style: { marginTop: '12px' } }, h('div', { class: 'lbl', text: 'Colour' }), swatchRow(c.color, i => { c.color = i == null ? null : TRACK_COLORS[i]; live(); }, true)),
    h('p', { class: 'mono', style: { fontSize: '11px', color: 'var(--dim)', margin: '8px 0 0', lineHeight: '1.6' } ,
      html: `Source: ${esc(m ? m.name : 'missing')}${m ? ' · ' + fmtTime(m.duration) : ''}<br>Starts at ${fmtTime(c.start)} · length ${fmtTime(c.duration)}<br>Region ${fmtTime(c.offset)} → ${fmtTime(c.offset + c.duration * (c.rate || 1))}` }),
  );
  openSheet({
    title: 'Clip', icon: 'audio-waveform', color: col, body,
    actions: [
      { label: 'Normalize', icon: 'chevrons-up-down', onClick: () => { const pk = clipPeak(c); if (pk > 0.0001) c.gain = clamp(dbToGain(-0.3) / pk, 0.01, 63); } },
      { label: 'Delete', icon: 'trash-2', danger: true, onClick: () => { t.clips = t.clips.filter(x => x !== c); App.sel.delete(c.id); } },
      { label: 'Done', primary: true },
    ],
    onClose: () => { History.commit(); App.emit('sel'); },
  });
}

function clipMenu() {
  const l = Edit.selected(); if (!l.length) return;
  const one = l.length === 1 ? l[0] : null;
  menuSheet(one ? (one[1].name || 'Clip') : `${l.length} clips`, [
    one && { icon: 'pencil', label: 'Edit clip…', onClick: () => clipInspector(one[1].id) },
    { icon: 'scissors', label: 'Split at playhead', hint: 'S', onClick: () => Edit.split() },
    { icon: 'copy-plus', label: 'Duplicate', hint: 'Ctrl D', onClick: () => Edit.duplicate() },
    { icon: 'copy', label: 'Copy', hint: 'Ctrl C', onClick: () => Edit.copy() },
    { icon: 'scissors', label: 'Cut', hint: 'Ctrl X', onClick: () => Edit.cut() },
    'sep',
    { icon: 'flip-horizontal-2', label: 'Reverse', onClick: () => Edit.reverse() },
    { icon: 'chevrons-up-down', label: 'Normalize to −0.3 dB', onClick: () => Edit.normalize() },
    { icon: 'trending-up', label: 'Add short fades (50 ms)', onClick: () => Edit.quickFades(0.05) },
    { icon: 'volume-x', label: l[0][1].muted ? 'Unmute' : 'Mute', onClick: () => Edit.toggleMute() },
    one && { icon: 'locate-fixed', label: 'Move playhead to clip start', onClick: () => Engine.seek(one[1].start) },
    one && { icon: 'repeat', label: 'Set loop to clip', color: 'var(--c-loop)', onClick: () => mutate(P => { P.loop.start = one[1].start; P.loop.end = one[1].start + one[1].duration; P.loop.enabled = true; }) },
    'sep',
    { icon: 'trash-2', label: 'Delete', danger: true, onClick: () => Edit.remove() },
  ], { icon: 'audio-waveform', color: one ? App.clipColor(one[0], one[1]) : 'var(--accent)' });
}

function addTrackSheet() {
  const n = App.project.media.length;
  menuSheet('Add track', [
    { icon: 'upload', label: 'Import new track', hint: 'From your files', color: 'var(--c-media)', onClick: () => pickAudio({ place: true, fresh: true }) },
    { icon: 'library', label: 'Add from media', hint: n ? `${n} file${n > 1 ? 's' : ''}` : 'empty', color: 'var(--c-media)', onClick: () => mediaPicker() },
    { icon: 'audio-lines', label: 'Add empty track', color: 'var(--c-arrange)', onClick: () => addEmptyTrack() },
  ], { icon: 'plus', color: 'var(--c-arrange)' });
}
function addEmptyTrack() {
  mutate(P => { const t = newTrack('Audio ' + (P.tracks.filter(x => x.type === 'audio').length + 1), App.nextColor()); P.tracks.push(t); App.selTrack = t.id; });
}
/* Pick a file already in this session's media; it goes onto a new track at the playhead */
function mediaPicker() {
  const P = App.project, body = h('div', {});
  let s;
  const list = P.media.filter(m => !m.missing).sort((a, b) => (b.added || 0) - (a.added || 0));
  if (!list.length) {
    body.append(h('p', { class: 'empty-note', text: 'No audio in this session yet.' }),
      h('div', { class: 'btn-row', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', html: ic('upload') + 'Import audio', onclick: () => { s.close(); pickAudio({ place: true, fresh: true }); } })));
  } else {
    body.append(h('p', { style: { margin: '0 0 10px', color: 'var(--dim)', fontSize: '12.5px' }, text: `Placed on a new track at ${fmtTime(Engine.time())}.` }));
    const menu = h('div', { class: 'menu' });
    for (const m of list) {
      const n = mediaUsage(m.id);
      const b = h('button', { html: ic('file-music') + `<span>${esc(m.name)}</span><small>${fmtTime(m.duration, false)}${n ? ' · used ' + n + '×' : ''}</small>` });
      b.style.setProperty('--mc', 'var(--c-media)');
      b.onclick = () => { s.close(); mutate(() => placeMedia([m], Engine.time(), null, true)); if (App.tab !== 'arrange') setTab('arrange'); };
      menu.append(b);
    }
    body.append(menu);
  }
  s = openSheet({ title: 'Add from media', icon: 'library', color: 'var(--c-media)', body });
}

function trackMenu(id) {
  const t = App.track(id); if (!t) return;
  const col = App.colorOf(t);
  const P = App.project;
  const idx = P.tracks.indexOf(t);
  const name = h('input', { class: 'tinput', id: 'tm-name', value: t.name });
  name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== t.name) mutate(() => { t.name = v.slice(0, 40); }); });
  const heights = TRACK_HEIGHTS;
  const hseg = h('div', { class: 'seg' });
  hseg.style.setProperty('--rc', col);
  const drawH = () => { hseg.innerHTML = ''; for (const [l, v] of heights) hseg.append(h('button', { class: t.height === v ? 'on' : '', text: l, onclick: () => { t.height = v; changed('view'); drawH(); } })); };
  drawH();
  const outName = t.output === 'master' ? 'Master' : ((App.track(t.output) || {}).name || 'Master');
  const menu = h('div', { class: 'menu' });
  const item = (icon, label, hint, fn, o = {}) => {
    const b = h('button', { class: o.danger ? 'danger' : '', disabled: o.disabled, html: ic(icon) + `<span>${esc(label)}</span>` + (hint ? `<small>${esc(hint)}</small>` : '') });
    if (o.color) b.style.setProperty('--mc', o.color);
    b.onclick = () => { s.close(); fn(); };
    menu.append(b);
  };
  item('route', 'Output', outName, () => outputMenu(id), { color: 'var(--c-mixer)' });
  if (busTargets(t).length || t.sends.length) item('cable', 'Sends', t.sends.length ? String(t.sends.length) : 'none', () => sendsSheet(id), { color: 'var(--c-mixer)' });
  const nFx = trackFxCount(t);
  item('wand-sparkles', 'Effects', nFx ? String(nFx) : 'none', () => openFxFor(id), { color: 'var(--accent)' });
  item('spline', 'Add curve lane', '', () => curvePicker(id), { color: col });
  if (t.type === 'audio') item('square-dashed-mouse-pointer', 'Select all clips on track', '', () => Edit.selectTrackClips(id));
  menu.append(h('hr'));
  item('arrow-up', 'Move up', '', () => moveTrack(id, -1), { disabled: idx === 0 });
  item('arrow-down', 'Move down', '', () => moveTrack(id, 1), { disabled: idx === P.tracks.length - 1 });
  item('copy-plus', 'Duplicate track', '', () => duplicateTrack(id));
  item('trash-2', 'Delete track', '', () => askDeleteTrack(id), { danger: true });
  const body = h('div', {},
    h('div', { class: 'field' }, h('label', { for: 'tm-name', text: 'Name' }), name),
    h('div', { class: 'field' }, h('div', { class: 'lbl', text: 'Colour' }), swatchRow(t.color, i => mutate(() => { t.color = i; }))),
    h('div', { class: 'field' }, h('div', { class: 'lbl', text: 'Height' }), hseg),
    switchRow('tm-phase', 'Invert phase', 'Flip polarity of this track', t.phase, v => mutate(() => { t.phase = v; }), col),
    t.lanes.length ? switchRow('tm-lanes', 'Show curve lanes', `${t.lanes.length} lane${t.lanes.length > 1 ? 's' : ''}`, t.showLanes, v => { t.showLanes = v; changed('view'); }, col) : null,
    menu,
  );
  const s = openSheet({ title: t.name, icon: t.type === 'bus' ? 'merge' : 'audio-lines', color: col, body, onClose: () => { const v = name.value.trim(); if (v && v !== t.name) mutate(() => { t.name = v.slice(0, 40); }); } });
}
function moveTrack(id, d) {
  const P = App.project, t = App.track(id), i = P.tracks.indexOf(t), j = i + d;
  if (!t || j < 0 || j >= P.tracks.length) return;
  mutate(() => { P.tracks.splice(i, 1); P.tracks.splice(j, 0, t); });
}
function duplicateTrack(id) {
  const P = App.project, t = App.track(id); if (!t) return;
  mutate(() => {
    const n = JSON.parse(JSON.stringify(t)); n.id = uid(); n.name = (t.name + ' copy').slice(0, 40);
    n.clips.forEach(c => { c.id = uid(); (c.fx || []).forEach(f => { f.id = uid(); }); }); n.sends.forEach(x => { x.id = uid(); });
    const fxMap = {}; n.fx.forEach(f => { const o = f.id; f.id = uid(); f.link = f.id; fxMap[o] = f.id; });
    const re = k => k.replace(/^fx:([^:]+):/, (mm, fid) => `fx:${fxMap[fid] || fid}:`);
    const cv = {}; for (const k in n.curves) cv[re(k)] = n.curves[k]; n.curves = cv;
    n.lanes.forEach(l => { l.id = uid(); l.key = re(l.key); });
    P.tracks.splice(P.tracks.indexOf(t) + 1, 0, n); App.selTrack = n.id;
  });
}
async function askDeleteTrack(id) {
  const t = App.track(id); if (!t) return;
  if (t.clips.length && !(await confirmSheet('Delete track?', `“${t.name}” and its ${t.clips.length} clip${t.clips.length > 1 ? 's' : ''} will be removed. You can undo this.`, { ok: 'Delete', danger: true, icon: 'trash-2' }))) return;
  deleteTrack(id);
}
async function renameTrack(id) {
  const t = App.track(id); if (!t) return;
  const v = await promptSheet('Rename track', t.name, { color: App.colorOf(t) });
  if (v && v.trim() && v.trim() !== t.name) mutate(() => { t.name = v.trim().slice(0, 40); });
}
function colourSheet(id) {
  const t = App.track(id); if (!t) return;
  let s;
  const body = h('div', {}, swatchRow(t.color, i => { mutate(() => { t.color = i; }); s.close(); }));
  s = openSheet({ title: 'Colour · ' + t.name, icon: 'palette', color: App.colorOf(t), body });
}
function cycleHeight(id) {
  const t = App.track(id); if (!t) return;
  const i = TRACK_HEIGHTS.findIndex(([, v]) => v === t.height);
  t.height = TRACK_HEIGHTS[(i + 1) % TRACK_HEIGHTS.length][1];
  changed('view');
}
function heightLabel(t) { const e = TRACK_HEIGHTS.find(([, v]) => v === t.height); return e ? e[0] : 'M'; }
function deleteTrack(id) {
  mutate(P => {
    const t = P.tracks.find(x => x.id === id);
    for (const c of t.clips) App.sel.delete(c.id);
    P.tracks = P.tracks.filter(x => x.id !== id);
    for (const x of P.tracks) { if (x.output === id) x.output = 'master'; x.sends = x.sends.filter(s => s.target !== id); }
    if (App.selTrack === id) App.selTrack = P.tracks[0] ? P.tracks[0].id : null;
    if (App.fxTrack === id) App.fxTrack = null;
  });
}
function outputMenu(id) {
  const t = App.track(id);
  menuSheet('Output of ' + t.name, [
    { icon: t.output === 'master' ? 'check' : 'route', label: 'Master', color: 'var(--c-mixer)', onClick: () => mutate(() => { t.output = 'master'; }) },
    ...busTargets(t).map(b => ({ icon: t.output === b.id ? 'check' : 'merge', label: b.name, color: App.colorOf(b), onClick: () => mutate(() => { t.output = b.id; }) })),
  ], { icon: 'route', color: 'var(--c-mixer)' });
}
function sendsSheet(id) {
  const t = App.track(id); const col = App.colorOf(t);
  const body = h('div', {});
  const draw = () => {
    body.innerHTML = '';
    if (!t.sends.length) body.append(h('p', { class: 'empty-note', text: 'No sends yet. Sends feed a copy of this track into a bus.' }));
    for (const s of t.sends) {
      const b = App.track(s.target); if (!b) continue;
      const bc = App.colorOf(b);
      const row = h('div', { class: 'card', style: { padding: '10px 12px' } });
      row.append(h('div', { class: 'inline-row', style: { marginBottom: '6px' } },
        h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: bc, flex: 'none' } }),
        h('b', { style: { flex: '1', fontSize: '13px' }, text: '→ ' + b.name }),
        h('div', { class: 'seg', style: { '--rc': bc } }, h('button', { class: s.pre ? '' : 'on', text: 'Post', onclick: () => mutate(() => { s.pre = false; }) || draw() }), h('button', { class: s.pre ? 'on' : '', text: 'Pre', onclick: () => mutate(() => { s.pre = true; }) || draw() })),
        h('button', { class: 'ibtn', 'aria-label': 'Remove send', html: ic('x', 'sm'), onclick: () => { mutate(() => { t.sends = t.sends.filter(x => x !== s); }); draw(); } })));
      const inp = h('input', { type: 'range', min: 0, max: 1000, value: Math.round(gainToPos(s.amount) * 1000), id: 'snd-' + s.id, 'aria-label': 'Send level' });
      inp.style.setProperty('--rc', bc); paintRange(inp);
      const val = h('span', { class: 'val', text: fmtDb(gainToDb(s.amount)) + ' dB' });
      inp.addEventListener('input', () => { History.begin(); s.amount = posToGain(inp.value / 1000); paintRange(inp); val.textContent = fmtDb(gainToDb(s.amount)) + ' dB'; Engine.setSend(t, s); });
      inp.addEventListener('change', () => History.commit());
      row.append(h('div', { class: 'inline-row' }, inp, val));
      body.append(row);
    }
    const avail = busTargets(t).filter(b => !t.sends.some(s => s.target === b.id));
    const btns = h('div', { class: 'btn-row', style: { marginTop: '12px' } });
    for (const b of avail) btns.append(h('button', { class: 'btn', html: ic('plus') + 'Send to ' + esc(b.name), onclick: () => { mutate(() => { t.sends.push({ id: uid(), target: b.id, amount: dbToGain(-12), pre: false }); }); draw(); } }));
    body.append(btns);
  };
  draw();
  openSheet({ title: 'Sends · ' + t.name, icon: 'cable', color: col, body });
}

/* ---------- Curve lanes ---------- */
function curveChoices(t) {
  const groups = [];
  const trackItems = [{ key: 'vol', label: 'Track volume', color: App.colorOf(t) }, { key: 'pan', label: 'Track pan', color: App.colorOf(t) }];
  for (const f of t.fx) trackItems.push({ key: `fx:${f.id}:intensity`, label: `${FX[f.type].name} intensity`, color: FX[f.type].color });
  groups.push({ title: t.type === 'bus' ? 'Bus' : 'Whole track', items: trackItems });
  if (t.type === 'audio') {
    const items = [{ key: 'part:gain', label: 'Part volume', color: App.colorOf(t) }, { key: 'part:pan', label: 'Part pan', color: App.colorOf(t) }];
    groups.push({ title: 'Each part', items });
    const seen = new Map();
    for (const c of t.clips) for (const f of c.fx || []) { const l = fxLink(f); if (!seen.has(l)) seen.set(l, { f, n: 0 }); seen.get(l).n++; }
    for (const [link, { f, n }] of seen) items.push({ key: `part:fx:${link}:intensity`, label: `${FX[f.type].name} intensity`, hint: `${n} of ${t.clips.length} part${t.clips.length > 1 ? 's' : ''}`, color: FX[f.type].color });
  }
  return groups;
}
function curvePicker(trackId, laneId) {
  const t = App.track(trackId); if (!t) return;
  const lane = laneId && t.lanes.find(l => l.id === laneId);
  const body = h('div', {});
  let s;
  for (const g of curveChoices(t)) {
    body.append(h('div', { class: 'label-up picker-group', style: g.color ? { color: g.color } : null, text: g.title }));
    const m = h('div', { class: 'menu' });
    for (const it of g.items) {
      const shown = t.lanes.some(l => l.key === it.key), cur = lane && lane.key === it.key;
      const b = h('button', { html: ic(cur || shown ? 'check' : 'spline') + `<span>${esc(it.label)}</span>` + (curveHasPoints(t, it.key) ? '<small>has points</small>' : it.hint ? `<small>${esc(it.hint)}</small>` : '') });
      b.style.setProperty('--mc', it.color);
      b.onclick = () => { s.close(); pickCurve(t, it.key, lane); };
      m.append(b);
    }
    body.append(m);
  }
  if (t.type === 'audio' && !t.clips.some(c => (c.fx || []).length)) body.append(h('p', { class: 'empty-note', style: { textAlign: 'left', padding: '8px 0 0' }, text: 'Add effects to a part and their intensity shows up here, so you can draw curves for it.' }));
  s = openSheet({ title: lane ? 'Change curve parameter' : 'Add curve lane · ' + t.name, icon: 'spline', color: App.colorOf(t), body });
}
function pickCurve(t, key, lane) {
  if (!lane && t.lanes.some(l => l.key === key)) { t.showLanes = true; App.selTrack = t.id; changed('view'); if (App.tab !== 'arrange') setTab('arrange'); return; }
  mutate(() => {
    if (lane) lane.key = key; else t.lanes.push({ id: uid(), key });
    t.showLanes = true; App.selTrack = t.id;
  });
  if (App.tab !== 'arrange') setTab('arrange');
  const sp = curveSpec(t, key);
  toast(sp && sp.scope === 'part' ? 'Tap inside a part to shape its curve. Points snap to the dashed default line.' : 'Tap the lane to add points. They snap to the dashed default line.', { color: sp ? sp.color : undefined, ms: 3200 });
}
function addLane(trackId, key, quiet) {
  const t = App.track(trackId); if (!t) return;
  if (t.lanes.some(l => l.key === key)) { t.showLanes = true; changed('view'); return; }
  mutate(() => { t.lanes.push({ id: uid(), key }); t.showLanes = true; });
  if (!quiet) toast('Curve lane added. Tap inside it to draw points.', { color: App.colorOf(t) });
}
function laneMenu(trackId, laneId) {
  const t = App.track(trackId); const lane = t.lanes.find(a => a.id === laneId); if (!lane) return;
  const sp = curveSpec(t, lane.key);
  const has = curveHasPoints(t, lane.key);
  const clearAll = () => { if (isPartKey(lane.key)) for (const c of t.clips) { if (c.curves) delete c.curves[partSub(lane.key)]; } else delete t.curves[lane.key]; };
  const selClip = t.clips.find(c => App.sel.has(c.id));
  menuSheet(sp ? sp.label : 'Curve lane', [
    { icon: 'list-music', label: 'Change parameter…', onClick: () => curvePicker(trackId, laneId) },
    sp && sp.scope === 'part' && selClip && { icon: 'x', label: 'Reset selected part to default', disabled: !getCurve(t, lane.key, selClip).length, onClick: () => mutate(() => { delete selClip.curves[partSub(lane.key)]; }) },
    { icon: 'x', label: sp && sp.scope === 'part' ? 'Reset all parts to default' : 'Reset curve to default', disabled: !has, onClick: () => mutate(clearAll) },
    { icon: 'plus', label: 'Add another curve lane', onClick: () => curvePicker(trackId) },
    { icon: 'chevron-up', label: 'Hide curve lanes', onClick: () => { t.showLanes = false; changed('view'); } },
    'sep',
    { icon: 'trash-2', label: has ? 'Remove lane and its points' : 'Remove lane', danger: true, onClick: () => mutate(() => { if (has) clearAll(); t.lanes = t.lanes.filter(a => a !== lane); }) },
  ], { icon: 'spline', color: sp ? sp.color : App.colorOf(t) });
}
function markerMenu(id) {
  const P = App.project; const m = P.markers.find(x => x.id === id); if (!m) return;
  menuSheet('Marker at ' + fmtTime(m.t), [
    { icon: 'locate-fixed', label: 'Move playhead here', onClick: () => Engine.seek(m.t) },
    { icon: 'move-horizontal', label: 'Move marker to playhead', hint: fmtTime(Engine.time()), onClick: () => mutate(() => { m.t = Engine.time(); P.markers.sort((a, b) => a.t - b.t); }) },
    'sep',
    { icon: 'flag-off', label: 'Remove marker', danger: true, onClick: () => mutate(() => { P.markers = P.markers.filter(x => x !== m); }) },
  ], { icon: 'flag', color: App.markerColor(m) });
}
