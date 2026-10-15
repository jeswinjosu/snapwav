/* ================= Mixer ================= */
function knobSvg(v, color, bipolar) {
  const a0 = -135, a1 = 135, cx = 22, cy = 22, r = 17;
  const ang = d => (d - 90) * Math.PI / 180;
  const pt = d => [cx + r * Math.cos(ang(d)), cy + r * Math.sin(ang(d))];
  const arc = (from, to) => { const [x0, y0] = pt(from), [x1, y1] = pt(to); const large = Math.abs(to - from) > 180 ? 1 : 0; const sw = to > from ? 1 : 0; return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} ${sw} ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  const val = a0 + (a1 - a0) * v;
  const start = bipolar ? 0 : a0;
  const [px, py] = pt(val);
  return `<svg viewBox="0 0 44 44" class="knob-svg" aria-hidden="true">
    <path d="${arc(a0, a1)}" fill="none" stroke="${Theme.col.knobRing}" stroke-width="4" stroke-linecap="round"/>
    ${Math.abs(val - start) > 0.5 ? `<path d="${arc(Math.min(start, val), Math.max(start, val))}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>` : ''}
    <circle cx="22" cy="22" r="11" fill="${Theme.col.knobCenter}"/>
    <line x1="22" y1="22" x2="${(22 + (px - 22) * 0.62).toFixed(2)}" y2="${(22 + (py - 22) * 0.62).toFixed(2)}" stroke="${Theme.col.knobPtr}" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

const Mixer = {
  strips: new Map(), holds: new Map(),
  init() {
    App.on('change', () => { if (App.tab === 'mixer') this.render(); else this.stale = true; });
    App.on('sel', () => { if (App.tab === 'mixer') this.render(); });
    App.on('layout', () => { if (App.tab === 'mixer') this.render(); else this.stale = true; });
  },
  show() { this.render(); },
  render() {
    if (!App.project) return;
    this.stale = false;
    const box = $('#mx-strips'), keepX = box.scrollLeft, sc = box.parentElement, keepPX = sc ? sc.scrollLeft : 0, keepPY = sc ? sc.scrollTop : 0;
    box.innerHTML = ''; this.strips.clear();
    for (const t of App.project.tracks) box.append(this.strip(t));
    box.append(h('button', { class: 'strip', style: { justifyContent: 'center', alignItems: 'center', borderStyle: 'dashed', color: 'var(--dim)', cursor: 'pointer', background: 'transparent', minHeight: '200px' }, html: ic('plus') + '<span style="font-size:12px">Add track</span>', onclick: () => addTrackSheet() }));
    const m = $('#mx-master'); m.innerHTML = '';
    m.append(this.strip(null));
    box.scrollLeft = keepX; if (sc) { sc.scrollLeft = keepPX; sc.scrollTop = keepPY; }
  },
  fader(t, master) {
    const col = master ? Theme.col.text : App.colorOf(t);
    const get = () => master ? App.project.master.vol : t.vol;
    const automated = !master && trackAutomated(t, 'vol');
    const fader = h('div', { class: 'fader', role: 'slider', tabindex: 0, 'aria-label': (master ? 'Master' : t.name) + ' volume', 'aria-valuemin': -60, 'aria-valuemax': 6 });
    const rail = h('div', { class: 'rail' }), fill = h('div', { class: 'fill' }), thumb = h('div', { class: 'thumb' }), zero = h('div', { class: 'zero' });
    fader.append(rail, zero, fill, thumb);
    const read = h('div', { class: 'db-read' });
    const place = g => {
      const p = gainToPos(g);
      const H = fader.clientHeight || 160;
      const y = 8 + (1 - p) * (H - 16);
      thumb.style.top = y + 'px'; fill.style.height = Math.max(0, H - 8 - y) + 'px';
      zero.style.top = (8 + (1 - gainToPos(1)) * (H - 16)) + 'px';
      read.textContent = fmtDb(gainToDb(g));
      fader.setAttribute('aria-valuenow', Math.round(gainToDb(g)));
    };
    const set = g => {
      g = clamp(g, 0, 2);
      if (master) { App.project.master.vol = g; Engine.setMasterVol(g); }
      else { t.vol = g; Engine.setTrackParam(t, 'vol'); }
      place(g);
    };
    let p0 = 0;
    dragOn(fader, {
      down: () => { if (automated) return; History.begin(); p0 = gainToPos(get()); },
      move: (e, s) => {
        if (automated) return;
        const H = fader.clientHeight - 16;
        const fine = e.shiftKey ? 0.25 : 1;
        set(posToGain(clamp(p0 - (s.y - s.y0) / H * fine, 0, 1)));
      },
      up: () => { if (!automated) History.commit(); },
      tap: () => { if (automated) toast('Volume follows its curve. Reset the Track volume curve in Arrange to use the fader.', { ms: 3200 }); },
      dbl: () => { if (automated) return; History.begin(); set(1); History.commit(); },
    });
    fader.addEventListener('keydown', e => {
      if (automated) return;
      const d = e.key === 'ArrowUp' ? 0.01 : e.key === 'ArrowDown' ? -0.01 : 0; if (!d) return;
      e.preventDefault(); History.begin(); set(posToGain(clamp(gainToPos(get()) + d, 0, 1))); History.commit();
    });
    fader.style.setProperty('--tc', col);
    if (automated) fader.style.opacity = 0.7;
    requestAnimationFrame(() => place(get()));
    return { fader, read, place };
  },
  knob(t) {
    const col = App.colorOf(t);
    const automated = trackAutomated(t, 'pan');
    const k = h('div', { class: 'knob', role: 'slider', tabindex: 0, 'aria-label': t.name + ' pan', 'aria-valuemin': -100, 'aria-valuemax': 100 });
    const val = h('div', { class: 'knob-val' });
    const place = p => { k.innerHTML = knobSvg((p + 1) / 2, col, true); val.textContent = fmtPan(p); k.setAttribute('aria-valuenow', Math.round(p * 100)); };
    const set = p => { t.pan = clamp(p, -1, 1); if (Math.abs(t.pan) < 0.02) t.pan = 0; Engine.setTrackParam(t, 'pan'); place(t.pan); };
    let p0 = 0;
    dragOn(k, {
      down: () => { if (automated) return; History.begin(); p0 = t.pan; },
      move: (e, s) => { if (automated) return; set(p0 + ((s.x - s.x0) - (s.y - s.y0)) / 120); },
      up: () => { if (!automated) History.commit(); },
      tap: () => { if (automated) toast('Pan follows its curve lane.', { ms: 2200 }); },
      dbl: () => { if (automated) return; History.begin(); set(0); History.commit(); },
    });
    k.addEventListener('keydown', e => { if (automated) return; const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0; if (!d) return; e.preventDefault(); History.begin(); set(t.pan + d); History.commit(); });
    place(t.pan);
    if (automated) k.style.opacity = 0.7;
    return { k, val, place };
  },
  strip(t) {
    const master = !t;
    const col = master ? Theme.col.text : App.colorOf(t);
    const s = h('div', { class: 'strip' + (master ? ' master' : '') + (!master && t.id === App.selTrack ? ' sel' : '') });
    s.style.setProperty('--tc', col);
    const head = h('button', { class: 'strip-head', html: `<span class="nm">${esc(master ? 'Master' : t.name)}</span><span class="ty">${master ? 'Output' : t.type === 'bus' ? 'Bus' : 'Audio'}</span>` });
    head.onclick = () => { if (master) return; App.selTrack = t.id; if (isLandscape()) App.emit('sel'); else trackMenu(t.id); };
    s.append(head);
    // inserts
    let fxl = master ? App.project.master.fx : t.fx;
    if (!master && t.type === 'audio') {
      const seen = new Map();
      for (const c of t.clips) for (const f of c.fx || []) if (!seen.has(fxLink(f))) seen.set(fxLink(f), f);
      fxl = [...t.fx, ...seen.values()];
    }
    // four rows of FX chips (two on short landscape screens); the last row becomes "+N more" when they don't fit
    const fxBox = h('div', { class: 'strip-fx' });
    const rowsFit = isLandscape() && innerHeight < 520 ? 2 : 4;
    const shown = fxl.length > rowsFit ? fxl.slice(0, rowsFit - 1) : fxl;
    const openIt = () => openFxFor(master ? 'master' : t.id);
    for (const f of shown) {
      const b = h('button', { class: 'fxmini' + (f.bypass ? ' off' : ''), text: FX[f.type].name, onclick: openIt });
      b.style.setProperty('--fc', FX[f.type].color);
      fxBox.append(b);
    }
    if (fxl.length > shown.length) fxBox.append(h('button', { class: 'fxmini more', text: `+${fxl.length - shown.length} more`, 'aria-label': `${fxl.length - shown.length} more effects on ${master ? 'Master' : t.name}`, onclick: openIt }));
    else if (fxl.length < rowsFit) fxBox.append(h('button', { class: 'fxmini add', html: '+ FX', 'aria-label': `Add an effect to ${master ? 'Master' : t.name}`, onclick: openIt }));
    s.append(fxBox);
    // sends
    if (!master) {
      const sb = h('div', { class: 'strip-sends' });
      for (const snd of t.sends) {
        const b = App.track(snd.target); if (!b) continue;
        const bar = h('button', { class: 'sendbar', html: `<i style="width:${(gainToPos(snd.amount) / gainToPos(2) * 100).toFixed(0)}%"></i><span>${snd.pre ? 'pre ' : ''}${esc(b.name)}</span>` });
        bar.style.setProperty('--sc', App.colorOf(b));
        bar.onclick = () => sendsSheet(t.id);
        sb.append(bar);
      }
      if (!t.sends.length && busTargets(t).length) sb.append(h('button', { class: 'sendbar', style: { '--sc': 'var(--c-mixer)' }, html: '<span>+ Send</span>', onclick: () => sendsSheet(t.id) }));
      if (sb.children.length) s.append(sb);
      const { k, val, place } = this.knob(t);
      s.append(h('div', {}, k, val));
      s.append(h('div', { class: 'ms-row' },
        h('button', { class: 'tb m' + (t.mute ? ' on' : ''), text: 'M', title: 'Mute', onclick: () => Edit.toggleTrack(t.id, 'mute') }),
        h('button', { class: 'tb more', title: 'Track options', 'aria-label': 'Track options · ' + t.name, html: ic('ellipsis-vertical', 'sm'), onclick: () => trackMenu(t.id) })));
      this.strips.set(t.id, { placePan: place });
    } else {
      s.append(h('div', { style: { flex: 'none', height: '4px' } }));
    }
    const { fader, read, place } = this.fader(t, master);
    const meter = h('div', { class: 'meter' + (master ? ' stereo' : '') });
    const bars = master ? [h('div', {}, h('i'), h('b')), h('div', {}, h('i'), h('b'))] : [h('div', {}, h('i'), h('b'))];
    meter.append(...bars);
    s.append(h('div', { class: 'fader-wrap' }, fader, meter));
    s.append(read);
    if (master) {
      const led = h('div', { class: 'clip-led', title: 'Clip indicator (tap to reset)' });
      led.onclick = () => { this.clipHold = 0; led.classList.remove('on'); };
      s.append(led);
      this.masterLed = led;
    } else {
      const outName = t.output === 'master' ? 'Master' : ((App.track(t.output) || {}).name || 'Master');
      s.append(h('button', { class: 'out-btn', text: '→ ' + outName, title: 'Output', onclick: () => outputMenu(t.id) }));
    }
    const rec = this.strips.get(master ? 'master' : t.id) || {};
    Object.assign(rec, { meter, bars, placeVol: place });
    this.strips.set(master ? 'master' : t.id, rec);
    return s;
  },
  frame() {
    if (this.stale) this.render();
    const now = performance.now();
    const upd = (key, peaks) => {
      const rec = this.strips.get(key); if (!rec) return;
      const H = rec.meter.clientHeight; rec.meter.style.setProperty('--mh', H + 'px');
      peaks.forEach((p, i) => {
        const db = gainToDb(p), hgt = clamp((db + 60) / 66, 0, 1);
        const bar = rec.bars[i]; if (!bar) return;
        bar.firstChild.style.height = (hgt * 100).toFixed(1) + '%';
        const hk = key + ':' + i; let hd = this.holds.get(hk);
        if (!hd || hgt >= hd.v || now - hd.t > 1200) { hd = { v: hgt, t: now }; this.holds.set(hk, hd); }
        const b = bar.lastChild; b.style.bottom = (hd.v * 100).toFixed(1) + '%'; b.style.opacity = hd.v > 0.01 ? 0.8 : 0;
      });
    };
    for (const t of App.project.tracks) {
      upd(t.id, [Engine.playing ? Engine.trackPeak(t.id) : 0]);
      if (Engine.playing) {
        const rec = this.strips.get(t.id); if (!rec) continue;
        const vl = trackAutomated(t, 'vol') && t.curves.vol;
        if (vl && rec.placeVol) rec.placeVol(posToGain(valueAt(vl, Engine.time())));
        const pl = trackAutomated(t, 'pan') && t.curves.pan;
        if (pl && rec.placePan) rec.placePan(valueAt(pl, Engine.time()) * 2 - 1);
      }
    }
    const mp = Engine.playing ? Engine.masterPeaks() : [0, 0];
    upd('master', mp);
    if (Math.max(...mp) >= 0.999 && this.masterLed) this.masterLed.classList.add('on');
  },
};
