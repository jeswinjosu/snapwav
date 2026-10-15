/* ================= Effects view =================
   Audio tracks: effects live on parts (clips). Buses and master: effects live on the track. */
/* Scroll a chip into view inside its own row only (scrollIntoView would also scroll the page) */
function revealInRow(row, el) {
  const r = row.getBoundingClientRect(), e = el.getBoundingClientRect();
  if (e.left < r.left) row.scrollLeft += e.left - r.left - 8;
  else if (e.right > r.right) row.scrollLeft += e.right - r.right + 8;
}
/* Copy of a saved chain preset's effects, with new ids (shared link when given) */
function presetFx(p, link) {
  const f = newFx(p.type);
  f.params = Object.assign(fxDefaults(p.type), JSON.parse(JSON.stringify(p.params || {})));
  f.bypass = !!p.bypass; f.preset = p.preset || null;
  if (link) { f.link = link; f.sync = true; }
  return f;
}
/* Drop curve points and lanes that belong to part effects no longer on the track */
function pruneFxCurves(t) {
  const live = new Set(); for (const c of t.clips) for (const f of c.fx || []) live.add(fxLink(f));
  for (const c of t.clips) if (c.curves) for (const k in c.curves) { const m = /^fx:([^:]+):/.exec(k); if (m && !partFx(c, m[1])) delete c.curves[k]; }
  t.lanes = t.lanes.filter(l => { const m = /^part:fx:([^:]+):/.exec(l.key); return !m || live.has(m[1]); });
}
const Effects = {
  open: new Set(), graphs: [], grs: [],
  init() {
    App.on('change', () => { if (App.tab === 'fx') this.render(); else this.stale = true; });
  },
  show() { if (!App.fxExplicit) this.followSelection(); App.fxExplicit = false; this.render(); },
  /* Opening Effects from the navigation shows the part that is selected in Arrange (the last one tapped),
     or the selected track when no part is selected. Buttons that open a specific part set App.fxExplicit. */
  followSelection() {
    const ids = [...App.sel];
    for (let i = ids.length - 1; i >= 0; i--) {
      const [t, c] = App.clipById(ids[i]);
      if (c) { App.fxTrack = t.id; App.fxClip = c.id; return; }
    }
    if (App.fxTrack !== 'master' && App.selTrack && App.track(App.selTrack) && App.fxTrack !== App.selTrack) { App.fxTrack = App.selTrack; App.fxClip = null; }
  },
  target() {
    const P = App.project;
    if (App.fxTrack !== 'master' && !App.track(App.fxTrack)) App.fxTrack = App.selTrack && App.track(App.selTrack) ? App.selTrack : (P.tracks[0] ? P.tracks[0].id : 'master');
    if (App.fxTrack === 'master') return { kind: 'master', id: 'master', list: P.master.fx, name: 'Master', color: Theme.col.text, track: null, clip: null };
    const t = App.track(App.fxTrack);
    const base = { id: t.id, name: t.name, color: App.colorOf(t), track: t };
    if (t.type !== 'audio') return Object.assign(base, { kind: 'track', list: t.fx, clip: null });
    const parts = t.clips.slice().sort((a, b) => a.start - b.start);
    let clip = parts.find(c => c.id === App.fxClip) || parts.find(c => App.sel.has(c.id)) || parts[0] || null;
    App.fxClip = clip ? clip.id : null;
    return Object.assign(base, { kind: 'part', list: clip ? clip.fx : null, clip, parts });
  },
  partLabel(tg, c) { return 'Part ' + (tg.parts.indexOf(c) + 1); },
  render() {
    this.stale = false;
    const tg = this.target();
    const scroller = $('#fx-main').parentElement, keepY = scroller.scrollTop;
    // track chips
    const chips = $('#fx-tracks'), keepX = chips.scrollLeft; chips.innerHTML = '';
    const mk = (id, name, color, n) => {
      const b = h('button', { class: 'tchip' + (tg.id === id ? ' on' : ''), html: `<span class="dot"></span><span>${esc(name)}</span>${n ? `<span class="n">${n}</span>` : ''}` });
      b.style.setProperty('--tc', color);
      b.onclick = () => { App.fxTrack = id; if (id !== 'master') { App.selTrack = id; App.fxClip = null; } this.render(); App.emit('sel'); };
      chips.append(b);
      if (tg.id === id) requestAnimationFrame(() => revealInRow(chips, b));
    };
    for (const t of App.project.tracks) mk(t.id, t.name, App.colorOf(t), trackFxCount(t));
    mk('master', 'Master', Theme.col.text, App.project.master.fx.length);
    chips.scrollLeft = keepX;
    const main = $('#fx-main'); main.innerHTML = '';
    this.graphs = []; this.grs = [];
    main.append(h('div', { class: 'sec-title' },
      h('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: tg.color, flex: 'none' } }),
      h('h2', { text: tg.name }),
      h('span', { class: 'grow' }),
      h('span', { class: 'badge acc', text: tg.kind === 'part' ? (tg.parts.length ? `${tg.parts.length} part${tg.parts.length > 1 ? 's' : ''}` : 'No parts') : (tg.list.length ? `${tg.list.length} effect${tg.list.length > 1 ? 's' : ''}` : 'No effects') })));
    if (tg.kind === 'part') {
      if (!tg.parts.length) {
        main.append(h('p', { class: 'empty-note', style: { textAlign: 'left' }, text: 'Effects go on parts of a track. Import audio onto this track, split it where you like, then give each part its own effects.' }));
        main.append(h('button', { class: 'btn', html: ic('upload') + 'Import audio', onclick: () => pickAudio({ place: true, trackId: tg.id }) }));
        scroller.scrollTop = keepY;
        return;
      }
      const row = h('div', { class: 'parts' });
      const keepPX = this.partsX || 0;
      for (const c of tg.parts) {
        const n = (c.fx || []).length;
        const b = h('button', { class: 'pchip-part' + (c === tg.clip ? ' on' : ''), html: `<b>${esc(this.partLabel(tg, c))} · ${esc(c.name || 'Clip')}</b><small>${fmtTime(c.start, false)}–${fmtTime(c.start + c.duration, false)}${n ? ` · <span class="fxn">${n} FX</span>` : ''}</small>` });
        b.style.setProperty('--tc', App.clipColor(tg.track, c));
        b.onclick = () => { App.fxClip = c.id; App.sel.clear(); App.sel.add(c.id); App.selTrack = tg.id; App.emit('sel'); this.render(); };
        row.append(b);
        if (c === tg.clip) requestAnimationFrame(() => revealInRow(row, b));
      }
      row.addEventListener('scroll', () => { this.partsX = row.scrollLeft; }, { passive: true });
      main.append(row);
      row.scrollLeft = keepPX;
      if (!tg.list.length) main.append(h('p', { class: 'empty-note', style: { textAlign: 'left', padding: '0 0 14px' }, text: `${this.partLabel(tg, tg.clip)} has no effects. Effects here only change this part; use “Apply to all parts” on an effect to copy it across the track.` }));
    } else if (!tg.list.length) {
      main.append(h('p', { class: 'empty-note', style: { textAlign: 'left', padding: '0 0 14px' }, text: tg.kind === 'master' ? 'Effects here process the whole mix, for example a gentle compressor or a limiter before export.' : 'Bus effects process everything sent or routed to this bus, such as a shared reverb.' }));
    }
    const list = h('div', { class: 'fx-list' });
    tg.list.forEach((fx, i) => list.append(this.card(fx, i, tg)));
    main.append(list);
    main.append(h('div', { style: { height: '12px' } }));
    main.append(h('button', { class: 'add-fx', html: ic('plus') + (tg.kind === 'part' ? `Add effect to ${esc(this.partLabel(tg, tg.clip))}` : 'Add effect'), onclick: () => this.addSheet(tg) }));
    const nP = App.project.chainPresets.length;
    main.append(h('div', { class: 'btn-row preset-row' },
      h('button', { class: 'btn', style: { '--accent': 'var(--c-fx)' }, disabled: !tg.list.length, title: 'Save these effects and their settings as one preset for this session', html: ic('bookmark-plus') + 'Save as preset', onclick: () => this.savePreset(tg) }),
      h('button', { class: 'btn', disabled: !nP, title: 'Apply a saved preset here', html: ic('bookmark') + 'Presets' + (nP ? ` <span class="n">${nP}</span>` : ''), onclick: () => this.presetsSheet(tg) })));
    scroller.scrollTop = keepY;
    requestAnimationFrame(() => this.graphs.forEach(g => g()));
    setTimeout(() => this.graphs.forEach(g => g()), 120);
  },
  addSheet(tg) {
    const grid = h('div', { class: 'fx-grid' });
    let s;
    for (const type of FX_ORDER) {
      const d = FX[type];
      const b = h('button', { class: 'fx-pick', html: `<span class="fx-ico">${ic(d.icon)}</span><b>${esc(d.name)}</b><small>${esc(d.desc)}</small>` });
      b.style.setProperty('--fc', d.color);
      b.onclick = () => {
        s.close();
        const fx = newFx(type, Object.keys(d.presets)[0]);
        this.open.add(fx.id);
        mutate(() => { tg.list.push(fx); });
        haptic();
      };
      grid.append(b);
    }
    s = openSheet({ title: tg.kind === 'part' ? `Add effect to ${this.partLabel(tg, tg.clip)}` : 'Add effect to ' + tg.name, icon: 'wand-sparkles', color: 'var(--c-fx)', body: grid, wide: true });
  },
  /* Linked copies of this effect on other parts of the same track */
  copies(tg, fx) {
    if (tg.kind !== 'part') return [];
    const link = fxLink(fx);
    return tg.track.clips.filter(c => c !== tg.clip).map(c => ({ c, f: partFx(c, link) })).filter(x => x.f);
  },
  synced(tg, fx) { return fx.sync ? this.copies(tg, fx).filter(x => x.f.sync).map(x => x.f) : []; },
  applyToAll(tg, fx) {
    const link = fxLink(fx);
    let added = 0;
    mutate(() => {
      fx.link = link; fx.sync = true;
      for (const c of tg.track.clips) {
        if (c === tg.clip) continue;
        const ex = partFx(c, link);
        if (ex) { ex.params = JSON.parse(JSON.stringify(fx.params)); ex.bypass = fx.bypass; ex.preset = fx.preset; ex.sync = true; }
        else { const cp = JSON.parse(JSON.stringify(fx)); cp.id = uid(); c.fx = c.fx || []; c.fx.push(cp); added++; }
      }
    });
    toast(`${FX[fx.type].name} is on all ${tg.track.clips.length} parts and stays in sync`, { color: FX[fx.type].color, ms: 3000 });
  },
  removeFx(tg, fx, everywhere) {
    const link = fxLink(fx);
    mutate(() => {
      const strip = (c, f) => {
        c.fx = c.fx.filter(x => x !== f);
        if (c.curves && !partFx(c, link)) for (const k in c.curves) if (k.startsWith(`fx:${link}:`)) delete c.curves[k];
      };
      if (tg.kind === 'part') {
        strip(tg.clip, fx);
        if (everywhere) for (const { c, f } of this.copies(tg, fx)) strip(c, f);
        if (!tg.track.clips.some(c => partFx(c, link))) tg.track.lanes = tg.track.lanes.filter(l => !l.key.startsWith(`part:fx:${link}:`));
      } else {
        const i = tg.list.indexOf(fx); if (i >= 0) tg.list.splice(i, 1);
        if (tg.track) { for (const k in tg.track.curves) if (k.startsWith(`fx:${fx.id}:`)) delete tg.track.curves[k]; tg.track.lanes = tg.track.lanes.filter(l => !l.key.startsWith(`fx:${fx.id}:`)); }
      }
    });
  },
  card(fx, i, tg) {
    const d = FX[fx.type];
    const isOpen = this.open.has(fx.id);
    const card = h('div', { class: 'fxcard' + (fx.bypass ? ' off' : '') });
    card.style.setProperty('--fc', d.color);
    const pwr = h('button', { class: 'ibtn pwr' + (fx.bypass ? '' : ' on'), title: fx.bypass ? 'Turn on' : 'Bypass', 'aria-label': fx.bypass ? 'Turn effect on' : 'Bypass effect', 'aria-pressed': String(!fx.bypass), html: ic('power') });
    pwr.onclick = e => { e.stopPropagation(); mutate(() => { fx.bypass = !fx.bypass; for (const f of this.synced(tg, fx)) f.bypass = fx.bypass; }); haptic(); };
    const more = h('button', { class: 'ibtn', 'aria-label': 'Effect options', html: ic('ellipsis-vertical') });
    more.onclick = e => { e.stopPropagation(); this.menu(fx, i, tg); };
    const copies = this.copies(tg, fx);
    const cBtn = this.curveBtn(fx, tg, d);
    const sub = fx.bypass ? 'Bypassed' : (fx.preset ? 'Preset: ' + fx.preset : this.summary(fx));
    const head = h('div', { class: 'fx-head' },
      h('span', { class: 'fx-pos', text: String(i + 1) }),
      h('span', { class: 'fx-ico', html: ic(d.icon) }),
      h('button', { class: 'fx-title', type: 'button', 'aria-expanded': String(isOpen), 'aria-label': d.name + (isOpen ? ', hide settings' : ', show settings') }, h('span', { class: 'nm', text: d.name }), h('span', { class: 'ps', text: sub + (copies.length ? ` · on ${copies.length + 1} parts${fx.sync ? ', synced' : ''}` : '') })),
      cBtn, pwr, more);
    const toggle = () => { isOpen ? this.open.delete(fx.id) : this.open.add(fx.id); this.render(); };
    head.onclick = toggle;
    card.append(head);
    if (!isOpen) return card;
    const body = h('div', { class: 'fx-body' });
    if (tg.kind === 'part' && tg.parts.length > 1) {
      const lr = h('div', { class: 'link-row', style: { marginTop: '12px' } });
      if (!copies.length) {
        lr.append(h('span', { class: 'grow', html: `Only on <b>${esc(this.partLabel(tg, tg.clip))}</b>` }));
      } else {
        const sw = h('label', { class: 'switch', title: 'Keep settings in sync across parts' }, h('input', { type: 'checkbox', id: 'sync-' + fx.id, checked: !!fx.sync, onchange: e => mutate(() => { const v = e.target.checked; fx.sync = v; for (const { f } of copies) f.sync = v; }) }), h('i'));
        sw.style.setProperty('--rc', d.color);
        lr.append(h('label', { class: 'grow', for: 'sync-' + fx.id, html: `On <b>${copies.length + 1} of ${tg.parts.length}</b> parts · keep in sync` }), sw);
      }
      if (copies.length + 1 < tg.parts.length || !fx.sync) lr.append(h('button', { class: 'btn', style: { height: '34px', '--accent': d.color }, html: ic('copy-plus') + 'Apply to all parts', onclick: () => this.applyToAll(tg, fx) }));
      body.append(lr);
    }
    const pr = h('div', { class: 'presets' });
    for (const name of Object.keys(d.presets)) {
      pr.append(h('button', { class: 'pchip' + (fx.preset === name ? ' on' : ''), text: name, onclick: () => mutate(() => { for (const f of [fx, ...this.synced(tg, fx)]) { Object.assign(f.params, d.presets[name]); f.preset = name; } }) }));
    }
    body.append(pr);
    const inst = () => Engine.graph && Engine.graph.fxMap.get(fx.id);
    if (fx.type === 'eq' || fx.type === 'filter') {
      const cv = h('canvas', { class: 'fx-graph' });
      body.append(cv);
      this.graphs.push(() => this.drawResponse(cv, inst(), d.color, fx.type === 'eq' ? 18 : 30));
    }
    if (fx.type === 'comp') {
      const gm = h('div', { class: 'gr-meter', title: 'Gain reduction' }, h('i'));
      body.append(gm);
      this.grs.push({ el: gm.firstChild, inst });
    }
    for (const [k, spec] of Object.entries(d.params)) body.append(this.param(fx, k, spec, tg, d));
    card.append(body);
    return card;
  },
  summary(fx) {
    const d = FX[fx.type], keys = Object.keys(d.params).filter(k => !d.params[k].type && k !== 'intensity').slice(0, 3);
    const parts = keys.map(k => `${d.params[k].label} ${fmtParam(d.params[k], fx.params[k])}`);
    if (fx.params.intensity != null && fx.params.intensity < 0.995) parts.unshift(`Intensity ${fmtParam(d.params.intensity, fx.params.intensity)}`);
    return parts.slice(0, 3).join(' · ');
  },
  curveKey(tg, fx, k) { return tg.kind === 'part' ? `part:fx:${fxLink(fx)}:${k}` : `fx:${fx.id}:${k}`; },
  param(fx, k, spec, tg, d) {
    const id = `fxp-${fx.id}-${k}`;
    const all = () => [fx, ...this.synced(tg, fx)];
    if (spec.type === 'select') {
      const seg = h('div', { class: 'seg' });
      seg.style.setProperty('--rc', d.color);
      for (const o of spec.options) seg.append(h('button', { class: fx.params[k] === o ? 'on' : '', text: o, onclick: () => mutate(() => { for (const f of all()) { f.params[k] = o; f.preset = null; } }) }));
      return h('div', { class: 'prow', style: { gridTemplateColumns: '84px 1fr' } }, h('label', { text: spec.label }), seg);
    }
    if (spec.type === 'bool') {
      const sw = h('label', { class: 'switch' }, h('input', { type: 'checkbox', id, checked: !!fx.params[k], onchange: e => mutate(() => { for (const f of all()) { f.params[k] = e.target.checked; f.preset = null; } }) }), h('i'));
      sw.style.setProperty('--rc', d.color);
      return h('div', { class: 'prow', style: { gridTemplateColumns: '84px 1fr' } }, h('label', { for: id, text: spec.label }), h('div', {}, sw));
    }
    const inp = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: Math.round(pNorm(spec, fx.params[k]) * 1000), id });
    inp.style.setProperty('--rc', d.color); paintRange(inp);
    const val = h('span', { class: 'val', text: fmtParam(spec, fx.params[k]) });
    const disabledByTime = fx.type === 'delay' && k === 'time' && fx.params.sync !== 'Free';
    if (disabledByTime) { inp.disabled = true; inp.style.opacity = 0.4; val.textContent = fx.params.sync; }
    inp.addEventListener('input', () => {
      History.begin();
      const v = pDenorm(spec, inp.value / 1000);
      for (const f of all()) { f.params[k] = v; f.preset = null; Engine.setFxParam(null, f.id, k, v); }
      paintRange(inp); val.textContent = fmtParam(spec, v);
      if (this.graphs.length) { requestAnimationFrame(() => this.graphs.forEach(g => g())); clearTimeout(this.gt); this.gt = setTimeout(() => this.graphs.forEach(g => g()), 90); }
    });
    inp.addEventListener('change', () => History.commit());
    const lab = h('label', { for: id, text: spec.label, title: spec.label });
    const isDef = Math.abs(pNorm(spec, fx.params[k]) - pNorm(spec, spec.def)) < 0.0005;
    const rst = resetBtn(spec.label, () => mutate(() => { for (const f of all()) { f.params[k] = spec.def; f.preset = null; } }));
    rst.disabled = isDef || disabledByTime;
    inp.addEventListener('input', () => { rst.disabled = Math.abs(inp.value / 1000 - pNorm(spec, spec.def)) < 0.0005; });
    if (tg.track && k === 'intensity') {
      const key = this.curveKey(tg, fx, k);
      const pts = tg.kind === 'part' ? getCurve(tg.track, key, tg.clip) : getCurve(tg.track, key);
      if (pts.length) { val.textContent = 'curve'; val.style.color = d.color; }
    }
    return h('div', { class: 'prow' }, lab, inp, val, rst);
  },
  /* Each effect has one curve: its intensity (wet/dry). The button lives in the card header. */
  curveBtn(fx, tg, d) {
    if (!tg.track) return null;
    const key = this.curveKey(tg, fx, 'intensity'), t = tg.track;
    const lane = t.lanes.some(l => l.key === key);
    const pts = tg.kind === 'part' ? getCurve(t, key, tg.clip) : getCurve(t, key);
    const b = h('button', { class: 'ibtn fx-curve' + (lane ? ' on' : ''), title: lane ? 'Intensity curve (in Arrange)' : 'Draw an intensity curve', 'aria-label': d.name + ' intensity curve', html: ic('spline') });
    b.onclick = e => {
      e.stopPropagation();
      const focus = () => { App.selTrack = t.id; if (tg.clip) { App.sel.clear(); App.sel.add(tg.clip.id); } };
      if (!lane) {
        addLane(t.id, key, true); focus();
        toast(`${d.name} intensity curve added in Arrange`, { action: 'Open', onAction: () => setTab('arrange'), color: d.color });
      } else menuSheet(`${d.name} intensity`, [
        { icon: 'audio-lines', label: 'Show curve in Arrange', onClick: () => { t.showLanes = true; focus(); changed('view'); setTab('arrange'); } },
        tg.kind === 'part' && pts.length && { icon: 'x', label: 'Reset this part’s curve', onClick: () => mutate(() => { delete tg.clip.curves[partSub(key)]; }) },
        { icon: 'trash-2', label: 'Remove curve lane', danger: true, onClick: () => mutate(() => { t.lanes = t.lanes.filter(l => l.key !== key); }) },
      ], { icon: 'spline', color: d.color });
    };
    return b;
  },
  /* ---------- Chain presets: all effects of a part (or bus) saved under one name, kept in this session ---------- */
  async savePreset(tg) {
    if (!tg.list || !tg.list.length) return;
    const P = App.project;
    const guess = tg.list.map(f => FX[f.type].name).join(' + ').slice(0, 32);
    const name = await promptSheet('Save effects as preset', P.chainPresets.some(p => p.name === guess) ? `${guess} ${P.chainPresets.length + 1}` : guess, { color: 'var(--c-fx)' });
    if (!name || !name.trim()) return;
    const fx = tg.list.map(f => ({ type: f.type, params: JSON.parse(JSON.stringify(f.params)), bypass: !!f.bypass, preset: f.preset || null }));
    mutate(() => { P.chainPresets.push({ id: uid(), name: name.trim().slice(0, 40), fx }); });
    toast(`Saved “${name.trim()}”. Apply it to any part from Presets.`, { color: 'var(--c-fx)', ms: 2600 });
  },
  applyPreset(tg, p, mode) {
    const t = tg.track;
    mutate(() => {
      if (tg.kind !== 'part') {
        if (mode === 'replace') tg.list.length = 0;
        for (const x of p.fx) tg.list.push(presetFx(x));
        if (t) { for (const k in t.curves) { const m = /^fx:([^:]+):/.exec(k); if (m && !t.fx.some(f => f.id === m[1])) delete t.curves[k]; } t.lanes = t.lanes.filter(l => { const m = /^fx:([^:]+):/.exec(l.key); return !m || t.fx.some(f => f.id === m[1]); }); }
        return;
      }
      const targets = mode === 'all' ? t.clips : [tg.clip];
      const links = p.fx.map(() => uid());
      for (const c of targets) {
        if (mode === 'replace' || mode === 'all') c.fx = [];
        c.fx = c.fx || [];
        p.fx.forEach((x, i) => c.fx.push(presetFx(x, mode === 'all' && targets.length > 1 ? links[i] : null)));
      }
      pruneFxCurves(t);
    });
    haptic();
    toast(mode === 'all' ? `“${p.name}” applied to all ${t.clips.length} parts` : `“${p.name}” applied`, { color: 'var(--c-fx)', ms: 2000 });
  },
  presetsSheet(tg) {
    const P = App.project;
    const where = tg.kind === 'part' ? this.partLabel(tg, tg.clip) : tg.name;
    const body = h('div', {});
    let s;
    if (!P.chainPresets.length) body.append(h('p', { class: 'empty-note', text: 'No presets yet. Use “Save as preset” to keep a part’s effects under one name.' }));
    const menu = h('div', { class: 'menu' });
    for (const p of P.chainPresets) {
      const b = h('button', { html: ic('bookmark') + `<span>${esc(p.name)}</span><small>${esc(p.fx.map(f => FX[f.type] ? FX[f.type].name : f.type).join(', '))}</small>` });
      b.style.setProperty('--mc', 'var(--c-fx)');
      b.onclick = () => { s.close(); this.presetMenu(tg, p, where); };
      menu.append(b);
    }
    body.append(menu);
    body.append(h('p', { style: { color: 'var(--dim)', fontSize: '12px', margin: '12px 2px 0' }, text: 'Presets are saved with this session only.' }));
    s = openSheet({ title: 'Presets', icon: 'bookmark', color: 'var(--c-fx)', body });
  },
  presetMenu(tg, p, where) {
    const P = App.project;
    const multi = tg.kind === 'part' && tg.parts.length > 1;
    menuSheet(p.name, [
      { icon: 'replace', label: `Replace effects on ${where}`, color: 'var(--c-fx)', onClick: () => this.applyPreset(tg, p, 'replace') },
      tg.list.length && { icon: 'plus', label: `Add to ${where}`, hint: `after ${tg.list.length} effect${tg.list.length > 1 ? 's' : ''}`, onClick: () => this.applyPreset(tg, p, 'add') },
      multi && { icon: 'copy-plus', label: `Apply to all ${tg.parts.length} parts of ${tg.name}`, color: 'var(--c-fx)', onClick: () => this.applyPreset(tg, p, 'all') },
      'sep',
      { icon: 'pencil', label: 'Rename preset', onClick: async () => { const n = await promptSheet('Rename preset', p.name, { color: 'var(--c-fx)' }); if (n && n.trim()) mutate(() => { p.name = n.trim().slice(0, 40); }); } },
      { icon: 'trash-2', label: 'Delete preset', danger: true, onClick: () => mutate(() => { P.chainPresets = P.chainPresets.filter(x => x !== p); }) },
    ], { icon: 'bookmark', color: 'var(--c-fx)' });
  },
  menu(fx, i, tg) {
    const list = tg.list;
    const copies = this.copies(tg, fx);
    menuSheet(FX[fx.type].name, [
      tg.kind === 'part' && tg.parts.length > 1 && { icon: 'copy-plus', label: copies.length ? 'Apply to all parts (update copies)' : 'Apply to all parts of this track', color: FX[fx.type].color, onClick: () => this.applyToAll(tg, fx) },
      { icon: 'arrow-up', label: 'Move up', disabled: i === 0, onClick: () => mutate(() => { list.splice(i, 1); list.splice(i - 1, 0, fx); }) },
      { icon: 'arrow-down', label: 'Move down', disabled: i === list.length - 1, onClick: () => mutate(() => { list.splice(i, 1); list.splice(i + 1, 0, fx); }) },
      { icon: 'copy-plus', label: 'Duplicate here', onClick: () => mutate(() => { const n = JSON.parse(JSON.stringify(fx)); n.id = uid(); n.link = n.id; n.sync = false; list.splice(i + 1, 0, n); }) },
      { icon: 'undo-2', label: 'Reset to defaults', onClick: () => mutate(() => { for (const f of [fx, ...this.synced(tg, fx)]) { f.params = fxDefaults(fx.type); f.preset = null; } }) },
      { icon: 'power', label: fx.bypass ? 'Turn on' : 'Bypass', onClick: () => mutate(() => { fx.bypass = !fx.bypass; for (const f of this.synced(tg, fx)) f.bypass = fx.bypass; }) },
      'sep',
      { icon: 'trash-2', label: tg.kind === 'part' ? `Remove from ${this.partLabel(tg, tg.clip)}` : 'Remove effect', danger: true, onClick: () => this.removeFx(tg, fx, false) },
      copies.length && { icon: 'trash-2', label: `Remove from all ${copies.length + 1} parts`, danger: true, onClick: () => this.removeFx(tg, fx, true) },
    ], { icon: FX[fx.type].icon, color: FX[fx.type].color });
  },
  drawResponse(cv, inst, color, range) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const fx = f => Math.log(f / 20) / Math.log(1000) * W;
    const dy = db => H / 2 - db / range * (H / 2 - 8);
    g.strokeStyle = Theme.col.line; g.lineWidth = 1; g.font = `500 9px ${MONO}`; g.fillStyle = Theme.col.faint;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(fx(f)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 3, H - 4); }
    for (const db of [-range / 2, 0, range / 2]) { const y = Math.round(dy(db)) + 0.5; g.strokeStyle = db === 0 ? Theme.col.line2 : Theme.col.line; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    if (!inst || !inst.filters) return;
    const N = Math.max(64, Math.floor(W));
    const freqs = new Float32Array(N), mag = new Float32Array(N).fill(1), m = new Float32Array(N), ph = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
    for (const f of inst.filters) { f.getFrequencyResponse(freqs, m, ph); for (let i = 0; i < N; i++) mag[i] *= m[i]; }
    g.beginPath();
    for (let i = 0; i < N; i++) { const x = i / (N - 1) * W, y = clamp(dy(20 * Math.log10(Math.max(1e-6, mag[i]))), 1, H - 1); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = color; g.lineWidth = 2; g.stroke();
    g.lineTo(W, dy(0)); g.lineTo(0, dy(0)); g.closePath(); g.fillStyle = hexA(color, 0.12); g.fill();
  },
  frame() {
    if (this.stale) this.render();
    for (const gr of this.grs) { const i = gr.inst(); const r = i && i.reduction ? -i.reduction() : 0; gr.el.style.width = clamp(r / 24, 0, 1) * 100 + '%'; }
  },
};
