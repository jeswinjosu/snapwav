/* ================= Landscape side panel: options for the selected track, as tiles ================= */
const SidePanel = {
  init() {
    for (const ev of ['sel', 'change', 'tab', 'layout', 'project']) App.on(ev, () => this.render());
  },
  render() {
    const box = $('#side-track'); if (!box) return;
    if (!isLandscape() || !App.project || !['arrange', 'mixer', 'fx'].includes(App.tab)) { if (box.childElementCount) box.innerHTML = ''; return; }
    const sc = box.parentElement, keep = sc.scrollTop;
    box.innerHTML = '';
    if (App.tab === 'fx' && App.fxTrack === 'master') { box.append(h('p', { class: 'st-empty', text: 'Master effects process the whole mix.' })); return; }
    const t = App.track(App.tab === 'fx' && App.track(App.fxTrack) ? App.fxTrack : App.selTrack);
    if (!t) { box.append(h('p', { class: 'st-empty', text: 'Tap a track to see its options here.' })); return; }
    const col = App.colorOf(t), P = App.project, idx = P.tracks.indexOf(t);
    const nFx = trackFxCount(t), buses = busTargets(t);
    const len = t.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    const head = h('div', { class: 'st-head' }, h('span', { class: 'dot' }),
      h('button', { title: 'Rename track', text: t.name, onclick: () => renameTrack(t.id) }),
      h('small', { text: t.type === 'bus' ? 'Bus' : `${t.clips.length} part${t.clips.length === 1 ? '' : 's'}${len ? ' · ' + fmtTime(len, false) : ''}` }));
    head.style.setProperty('--tc', col);
    box.append(head);
    const tiles = h('div', { class: 'tiles' });
    box.append(tiles);

    // volume and pan for the track (the header has no room for them any more)
    const volAuto = trackAutomated(t, 'vol'), panAuto = trackAutomated(t, 'pan');
    box.append(h('div', { class: 'label-up', style: { margin: '16px 0 6px' }, text: 'Mix' }),
      sliderRow({
        id: 'st-vol', label: volAuto ? 'Volume (follows its curve)' : 'Volume', min: 0, max: 1000, step: 1, value: Math.round(gainToPos(t.vol) * 1000), def: Math.round(gainToPos(1) * 1000),
        fmt: v => fmtDb(gainToDb(posToGain(v / 1000))) + ' dB', color: col, disabled: volAuto,
        onInput: v => { History.begin(); t.vol = v === Math.round(gainToPos(1) * 1000) ? 1 : posToGain(v / 1000); Engine.setTrackParam(t, 'vol'); }, onChange: () => History.commit(),
      }),
      sliderRow({
        id: 'st-pan', label: panAuto ? 'Pan (follows its curve)' : 'Pan', min: -1, max: 1, step: 0.01, value: t.pan, def: 0, fmt: v => fmtPan(v), color: col, disabled: panAuto,
        onInput: v => { History.begin(); t.pan = Math.abs(v) < 0.02 ? 0 : v; Engine.setTrackParam(t, 'pan'); }, onChange: () => History.commit(),
      }));

    const tile = (cls, icon, label, fn, o = {}) => {
      const b = h('button', { class: 'tile ' + cls + (o.on ? ' on' : '') + (o.danger ? ' danger' : ''), disabled: o.disabled, title: o.title || label, 'aria-pressed': o.on != null ? String(!!o.on) : null, html: ic(icon) + `<span>${esc(label)}</span>` });
      if (o.color) b.style.setProperty('--tile-c', o.color);
      b.addEventListener('click', () => { haptic(); fn(); });
      tiles.append(b);
    };
    tile('mute', 'volume-x', 'Mute', () => Edit.toggleTrack(t.id, 'mute'), { on: t.mute });
    tile('', 'wand-sparkles', nFx ? `Effects · ${nFx}` : 'Effects', () => openFxFor(t.id), { color: 'var(--c-fx)', on: nFx > 0 });
    tile('', 'spline', t.lanes.length ? (t.showLanes ? 'Hide curves' : 'Show curves') : 'Curves', () => toggleLanes(t.id), { color: col, on: !!(t.lanes.length && t.showLanes) });
    if (t.lanes.length) tile('', 'list-plus', 'Add curve', () => curvePicker(t.id), { color: col });
    if (buses.length || t.output !== 'master') tile('', 'route', 'Output', () => outputMenu(t.id), { color: 'var(--c-mixer)' });
    if (buses.length || t.sends.length) tile('', 'cable', t.sends.length ? `Sends · ${t.sends.length}` : 'Sends', () => sendsSheet(t.id), { color: 'var(--c-mixer)' });
    tile('', 'palette', 'Colour', () => colourSheet(t.id), { color: col });
    tile('', 'move-vertical', 'Height · ' + heightLabel(t), () => cycleHeight(t.id));
    tile('', 'flip-vertical-2', 'Phase', () => mutate(() => { t.phase = !t.phase; }), { on: t.phase, title: 'Invert phase' });
    tile('', 'pencil', 'Rename', () => renameTrack(t.id));
    if (t.type === 'audio' && t.clips.length) tile('', 'square-dashed-mouse-pointer', 'Select parts', () => Edit.selectTrackClips(t.id));
    tile('', 'copy-plus', 'Duplicate', () => duplicateTrack(t.id));
    tile('', 'arrow-up', 'Move up', () => moveTrack(t.id, -1), { disabled: idx === 0 });
    tile('', 'arrow-down', 'Move down', () => moveTrack(t.id, 1), { disabled: idx === P.tracks.length - 1 });
    tile('', 'trash-2', 'Delete', () => askDeleteTrack(t.id), { danger: true });
    sc.scrollTop = keep;
  },
};
