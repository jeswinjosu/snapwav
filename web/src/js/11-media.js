/* ================= Media pool ================= */
function drawThumb(cv, id, color) {
  const pk = Engine.peaks.get(id);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cv.clientWidth || 64, H = cv.clientHeight || 40;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!pk) { g.strokeStyle = Theme.col.line2; g.beginPath(); g.moveTo(4, H / 2); g.lineTo(W - 4, H / 2); g.stroke(); return; }
  const per = pk.n / W, amp = (H / 2 - 3) / Math.max(0.2, pk.peak || 1);
  g.beginPath();
  for (let x = 0; x < W; x++) {
    let mn = 0, mx = 0;
    const b0 = Math.floor(x * per), b1 = Math.max(b0 + 1, Math.floor((x + 1) * per)), st = Math.max(1, Math.floor((b1 - b0) / 32));
    for (let b = b0; b < b1 && b < pk.n; b += st) { if (pk.data[b * 2] < mn) mn = pk.data[b * 2]; if (pk.data[b * 2 + 1] > mx) mx = pk.data[b * 2 + 1]; }
    g.moveTo(x + 0.5, H / 2 - mx * amp); g.lineTo(x + 0.5, H / 2 - mn * amp + 1);
  }
  g.strokeStyle = color; g.lineWidth = 1; g.stroke();
}

const Media = {
  preview: null,
  init() { App.on('change', () => { if (App.tab === 'media') this.render(); else this.stale = true; }); },
  show() { this.render(); },
  render() {
    this.stale = false;
    const P = App.project, main = $('#media-main'), sc = main.parentElement, keepY = sc.scrollTop;
    main.innerHTML = '';
    requestAnimationFrame(() => { sc.scrollTop = keepY; });
    main.append(h('div', { class: 'sec-title' }, h('h2', { text: 'Media' }), h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', html: ic('upload') + 'Import', onclick: () => pickAudio({ place: false }) })));
    const dz = h('div', { class: 'drop-zone' },
      h('div', { class: 'inline-row', style: { color: 'var(--c-media)' }, html: ic('file-music', 'lg') }),
      h('div', { text: isTouch() ? 'Pick audio files from your phone: WAV, MP3, OGG, FLAC, M4A, AAC or Opus.' : 'Drop audio files anywhere, or pick them: WAV, MP3, OGG, FLAC, M4A, AAC or Opus.' }),
      h('button', { class: 'btn', html: ic('folder-open') + 'Choose files', onclick: () => pickAudio({ place: false }) }));
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, () => dz.classList.add('over')));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('over')));
    if (!P.media.length) { main.append(dz); return; }
    const total = P.media.reduce((n, m) => n + (m.size || 0), 0);
    main.append(h('p', { style: { margin: '0 0 12px', color: 'var(--dim)', fontSize: '12.5px' }, text: `${P.media.length} file${P.media.length > 1 ? 's' : ''} · ${fmtBytes(total)} stored on this device. Tap + to place a file at the playhead.` }));
    const list = h('div', { class: 'list media-cols' });
    const users = id => P.tracks.filter(t => t.clips.some(c => c.mediaId === id));
    for (const m of P.media.slice().sort((a, b) => (b.added || 0) - (a.added || 0))) {
      const u = users(m.id), n = mediaUsage(m.id);
      const color = u[0] ? App.colorOf(u[0]) : Theme.col.accent;
      const cv = h('canvas', { width: 64, height: 40 });
      const playing = this.preview === m.id;
      const play = h('button', { class: 'ibtn' + (playing ? ' on' : ''), 'aria-label': playing ? 'Stop preview' : 'Preview', html: ic(playing ? 'square' : 'play'), disabled: m.missing });
      play.onclick = () => {
        if (this.preview === m.id) { Engine.stopPreview(); this.preview = null; this.render(); return; }
        if (Engine.playing) Engine.pause();
        this.preview = m.id; Engine.previewMedia(m.id, () => { this.preview = null; if (App.tab === 'media') this.render(); }); this.render();
      };
      const add = h('button', { class: 'ibtn', 'aria-label': 'Place at playhead', title: 'Place at playhead', html: ic('plus'), disabled: m.missing });
      add.onclick = () => { mutate(() => placeMedia([m], Engine.time(), App.selTrack && App.track(App.selTrack) && App.track(App.selTrack).type === 'audio' ? App.selTrack : null)); toast(`Placed at ${fmtTime(Engine.time())}`, { action: 'Arrange', onAction: () => setTab('arrange'), color: 'var(--c-media)' }); };
      const more = h('button', { class: 'ibtn', 'aria-label': 'More', html: ic('ellipsis-vertical'), onclick: () => this.menu(m) });
      const row = h('div', { class: 'mrow' }, cv,
        h('div', { class: 'info' },
          h('div', { class: 'nm', text: m.name }),
          h('div', { class: 'meta', html: m.missing ? '<span style="color:var(--c-danger)">Missing audio data</span>' : `${fmtTime(m.duration, false)} · ${m.channels === 1 ? 'mono' : 'stereo'} · ${(m.sampleRate / 1000).toFixed(1)} kHz · ${fmtBytes(m.size || 0)}` }),
          h('div', { style: { marginTop: '3px', display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            n ? h('span', { class: 'badge', style: { background: hexA(color, Theme.mode === 'light' ? 0.07 : 0.18), color }, text: `${n} clip${n > 1 ? 's' : ''} · ${u.map(t => t.name).join(', ')}` }) : h('span', { class: 'badge', text: 'Unused' }))),
        play, add, more);
      list.append(row);
      requestAnimationFrame(() => drawThumb(cv, m.id, color));
    }
    main.append(list);
    main.append(h('div', { style: { height: '14px' } }));
    main.append(dz);
  },
  menu(m) {
    menuSheet(m.name, [
      { icon: 'plus', label: 'Place on a new track', onClick: () => mutate(P => { const t = newTrack(baseName(m.name).slice(0, 24), App.nextColor()); P.tracks.push(t); placeMedia([m], Engine.time(), t.id); }) },
      { icon: 'pencil', label: 'Rename', onClick: async () => { const n = await promptSheet('Rename file', m.name, { color: 'var(--c-media)' }); if (n && n.trim()) mutate(() => { m.name = n.trim(); }); } },
      { icon: 'download', label: 'Export as WAV', onClick: async () => { const b = Engine.buffers.get(m.id); if (b) await saveFile(safeName(baseName(m.name)) + '.wav', new Blob([encodeWav(b, 24)], { type: 'audio/wav' })); } },
      'sep',
      { icon: 'trash-2', label: 'Delete from session', danger: true, onClick: () => this.remove(m) },
    ], { icon: 'file-music', color: 'var(--c-media)' });
  },
  async remove(m) {
    const n = mediaUsage(m.id);
    const ok = await confirmSheet('Delete audio file?', `${m.name} will be removed from this device${n ? ` along with ${n} clip${n > 1 ? 's' : ''} that use it` : ''}. This can’t be undone.`, { ok: 'Delete', danger: true, icon: 'trash-2' });
    if (!ok) return;
    const P = App.project;
    for (const t of P.tracks) t.clips = t.clips.filter(c => { if (c.mediaId === m.id) { App.sel.delete(c.id); return false; } return true; });
    P.media = P.media.filter(x => x !== m);
    await DB.deleteMedia(m.id).catch(() => { });
    Engine.forget(m.id);
    History.clear();
    changed('all');
    toast('Deleted ' + m.name);
  },
};
