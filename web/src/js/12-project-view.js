/* ================= Project view: sessions, export, settings ================= */
async function renderWithProgress(title, opts) {
  const b = busy(title, 'Rendering…');
  try {
    const out = await Engine.render(Object.assign({}, opts, { onProgress: p => b.set(p * 0.9, `Rendering ${Math.round(p * 100)}%`) }));
    b.set(0.95, 'Encoding'); await new Promise(r => setTimeout(r, 20));
    return { out, b };
  } catch (e) { b.done(); throw e; }
}
function normalizeBuffer(buf, db = -0.3) {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; } }
  if (pk < 1e-5) return;
  const k = dbToGain(db) / pk;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
}
/* ---------- MP3 (LAME via lamejs, loaded only when needed) ---------- */
let _lameP = null;
function loadLame() {
  if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve();
  if (_lameP) return _lameP;
  const srcs = (window.SNAPWAV_PWA || window.SnapWavAndroid ? ['vendor/lame.min.js'] : []).concat(['https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js']);
  _lameP = (async () => {
    for (const src of srcs) {
      try {
        await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = rej; (document.head || document.body).append(sc); });
        if (window.lamejs && window.lamejs.Mp3Encoder) return;
      } catch (e) { /* try next source */ }
    }
    _lameP = null;
    throw new Error('the MP3 encoder could not load. Check your connection and try again.');
  })();
  return _lameP;
}
async function encodeMp3(buf, kbps, onProgress) {
  await loadLame();
  const ch = buf.numberOfChannels > 1 ? 2 : 1;
  const enc = new window.lamejs.Mp3Encoder(ch, buf.sampleRate, kbps);
  const toI16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const x = f[i]; o[i] = x <= -1 ? -32768 : x >= 1 ? 32767 : Math.round(x * 32767); } return o; };
  const L = toI16(buf.getChannelData(0)), R = ch === 2 ? toI16(buf.getChannelData(1)) : null;
  const block = 1152 * 16, out = [];
  for (let i = 0, n = 0; i < L.length; i += block, n++) {
    const d = ch === 2 ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)) : enc.encodeBuffer(L.subarray(i, i + block));
    if (d.length) out.push(new Uint8Array(d));
    if (n % 8 === 0) { onProgress && onProgress(i / L.length); await new Promise(r => setTimeout(r, 0)); }
  }
  const e = enc.flush(); if (e.length) out.push(new Uint8Array(e));
  onProgress && onProgress(1);
  return new Blob(out, { type: 'audio/mpeg' });
}
const MP3_RATES = [32000, 44100, 48000];

function exportMixSheet(stems) {
  const P = App.project;
  const end = Engine.songEnd();
  if (end <= 0) { toast('Nothing to export yet. Import some audio first.', { error: true }); return; }
  const hasLoop = P.loop.end - P.loop.start > 0.05;
  const st = { range: P.loop.enabled && hasLoop ? 'loop' : 'song', fmt: Settings.get('exportFmt') || 'wav', bits: Settings.get('exportBits') || 16, kbps: Settings.get('exportKbps') || 192, rate: Settings.get('exportRate') || 0, tail: true, norm: false };
  const body = h('div', {});
  const segs = [], tips = [];
  const seg = (label, opts, key, onPick, help) => {
    const s = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    s.style.setProperty('--rc', 'var(--c-project)');
    const draw = () => { s.innerHTML = ''; for (const [v, l, dis] of opts) s.append(h('button', { class: st[key] === v ? 'on' : '', text: l, disabled: dis, 'aria-pressed': String(st[key] === v), onclick: () => { st[key] = v; draw(); onPick && onPick(); for (const t of tips) t.update(); } })); };
    draw(); segs.push(draw);
    if (!help) return h('div', { class: 'field' }, h('div', { class: 'lbl', text: label }), s);
    const tip = helpTip(label, help); tips.push(tip);
    return h('div', { class: 'field' }, h('div', { class: 'lbl-row' }, h('div', { class: 'lbl', text: label }), tip.btn), tip.tip, s);
  };
  /* live size estimate for the help bubbles: stereo PCM = seconds × rate × 2 channels × bytes per sample */
  const seconds = () => (st.range === 'loop' && hasLoop ? P.loop.end - P.loop.start : end) + (st.tail ? 3 : 0);
  const sizeLine = () => {
    const sr = exportRate(st), sec = seconds(), per = stems ? ' per stem' : '';
    const bytes = st.fmt === 'mp3' ? sec * st.kbps * 125 : 44 + Math.ceil(sec * sr) * 2 * (st.bits / 8);
    const perMin = st.fmt === 'mp3' ? 60 * st.kbps * 125 : 60 * sr * 2 * (st.bits / 8);
    const what = st.fmt === 'mp3' ? `MP3 ${st.kbps} kbps` : `${st.bits === 32 ? '32-bit float' : st.bits + '-bit'} · ${(sr / 1000).toFixed(1)} kHz`;
    const nb = x => String(x).replace(/ (?=(?:B|KB|MB|GB|kHz|kbps)\b)/g, '\u00A0');
    return h('div', { class: 'ht-size', html: `${ic('hard-drive')}<span>This export: about ${nb(fmtBytes(bytes))}${per} <span style="font-weight:400;color:var(--dim)">(${nb(what)}, ${nb(fmtBytes(perMin))} per minute)</span></span>` });
  };
  const rows = list => h('dl', { class: 'ht-rows' }, ...list.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v.replace(/(\d) (?=dB|kHz)/g, '$1\u00A0') })]));
  const bitsHelp = () => [
    h('p', { html: '<b>Bit depth</b> is how finely the loudness of each sample is stored. More bits mean a lower noise floor and more room for later editing. It doesn’t change the tone, only the size.' }),
    rows([
      ['16-bit', 'CD quality, about 96 dB of range. Plenty for listening and sharing. Smallest file.'],
      ['24-bit', 'About 144 dB of range. Choose it if the mix will be edited or mastered further. 1.5× the size of 16-bit.'],
      ['32-bit float', 'Can’t clip, even above 0 dB. Best for moving the mix into another audio editor. 2× the size of 16-bit.'],
    ]),
    sizeLine(),
  ];
  const rateHelp = () => [
    h('p', { html: '<b>Sample rate</b> is how many times per second the sound is measured. Higher rates capture higher pitches, but 44.1\u00A0kHz already covers everything people can hear, so going higher mostly makes the file bigger.' }),
    rows([
      ['Session', `Keeps the rate SnapWav is running at (${(Engine.ctx.sampleRate / 1000).toFixed(1)} kHz), so nothing is resampled.${st.fmt === 'mp3' && !MP3_RATES.includes(Engine.ctx.sampleRate) ? ' MP3 uses 48 kHz instead.' : ''}`],
      ['44.1 kHz', 'The music standard (CDs and streaming). Smallest WAV file.'],
      ['48 kHz', 'The video standard. About 9% larger than 44.1 kHz.'],
    ]),
    st.fmt === 'mp3' ? h('p', { style: { margin: '8px 0 0' }, html: 'For MP3, the size is set by <b>MP3 quality</b>, not the sample rate.' }) : null,
    sizeLine(),
  ].filter(Boolean);
  const wavRow = seg('WAV bit depth', [[16, '16-bit'], [24, '24-bit'], [32, '32-bit float']], 'bits', null, bitsHelp);
  const mp3Row = seg('MP3 quality', [[128, '128 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']], 'kbps');
  const note = h('p', { style: { margin: '10px 0 0', fontSize: '12px', color: 'var(--dim)' } });
  const refresh = () => {
    wavRow.hidden = st.fmt !== 'wav'; mp3Row.hidden = st.fmt !== 'mp3';
    const ext = st.fmt === 'mp3' ? 'MP3' : 'WAV';
    note.textContent = (window.claude && inFrame ? `In this viewer, ${ext} files arrive inside a .zip file. ` : '') + (window.SnapWavAndroid ? 'You’ll choose where to save the file. ' : '') + (st.fmt === 'mp3' ? 'MP3 encoding runs on this device and can take a little while on phones.' : '');
    note.hidden = !note.textContent;
  };
  body.append(...[
    seg('Range', [['song', `Whole song · ${fmtTime(end, false)}`], ['loop', `Loop · ${hasLoop ? fmtTime(P.loop.end - P.loop.start, false) : 'none'}`, !hasLoop]], 'range'),
    seg('Format', [['wav', 'WAV (lossless)'], ['mp3', 'MP3']], 'fmt', refresh),
    wavRow, mp3Row,
    seg('Sample rate', [[0, `Session · ${(Engine.ctx.sampleRate / 1000).toFixed(1)} kHz`], [44100, '44.1 kHz'], [48000, '48 kHz']], 'rate', null, rateHelp),
    switchRow('ex-tail', 'Include effect tails', 'Adds 3 s so reverb and delay can ring out', st.tail, v => { st.tail = v; }, 'var(--c-project)'),
    stems ? null : switchRow('ex-norm', 'Normalize', 'Raise the peak to −0.3 dBFS', st.norm, v => { st.norm = v; }, 'var(--c-project)'),
    note,
  ].filter(Boolean));
  refresh();
  openSheet({
    title: stems ? 'Export stems' : 'Export mix', icon: stems ? 'layers' : 'download', color: 'var(--c-project)', body,
    actions: [{ label: 'Cancel' }, { label: 'Export', primary: true, icon: 'download', onClick: () => { Settings.set('exportFmt', st.fmt); Settings.set('exportBits', st.bits); Settings.set('exportKbps', st.kbps); Settings.set('exportRate', st.rate); (stems ? doExportStems : doExportMix)(st); } }],
  });
}
function exportRate(st) {
  let sr = st.rate || Engine.ctx.sampleRate;
  if (st.fmt === 'mp3' && !MP3_RATES.includes(sr)) sr = 48000;
  return sr;
}
async function doExportMix(st) {
  const P = App.project;
  if (Engine.playing) Engine.pause();
  const range = st.range === 'loop' ? [P.loop.start, P.loop.end] : [0, Engine.songEnd()];
  const name = safeName(P.name) + (st.range === 'loop' ? '-loop' : '');
  let b = null;
  try {
    const r = await renderWithProgress('Exporting mix', { start: range[0], end: range[1], tail: st.tail ? 3 : 0, sampleRate: exportRate(st) });
    const out = r.out; b = r.b;
    if (st.norm) normalizeBuffer(out);
    if (st.fmt === 'mp3') {
      b.set(0.9, 'Loading MP3 encoder');
      const mp3 = await encodeMp3(out, st.kbps || 192, p => b.set(0.9 + p * 0.1, `Encoding MP3 ${Math.round(p * 100)}%`));
      b.done(); b = null;
      await saveFile(name + '.mp3', mp3);
    } else {
      const wav = encodeWav(out, st.bits);
      b.done(); b = null;
      await saveFile(name + '.wav', new Blob([wav], { type: 'audio/wav' }));
    }
  } catch (e) { if (b) b.done(); console.error(e); toast('Export failed: ' + e.message, { error: true, ms: 4500 }); }
}
async function doExportStems(st) {
  const P = App.project;
  if (Engine.playing) Engine.pause();
  const range = st.range === 'loop' ? [P.loop.start, P.loop.end] : [0, Engine.songEnd()];
  const tracks = P.tracks.filter(t => t.type === 'audio' && t.clips.length);
  const b = busy('Exporting stems', '');
  try {
    const files = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const label = `${i + 1} of ${tracks.length}: ${t.name}`;
      b.set(i / tracks.length, label);
      const out = await Engine.render({ start: range[0], end: range[1], tail: st.tail ? 3 : 0, sampleRate: exportRate(st), soloTrack: t.id });
      const base = `${String(i + 1).padStart(2, '0')} ${safeName(t.name)}`;
      if (st.fmt === 'mp3') {
        const mp3 = await encodeMp3(out, st.kbps || 192, p => b.set((i + p) / tracks.length, `${label} · MP3 ${Math.round(p * 100)}%`));
        files.push({ name: base + '.mp3', data: new Uint8Array(await mp3.arrayBuffer()) });
      } else files.push({ name: base + '.wav', data: new Uint8Array(encodeWav(out, st.bits)) });
    }
    b.set(1, 'Packing');
    const zip = await Zip.create(files);
    b.done();
    await saveFile(safeName(P.name) + '-stems.zip', zip);
  } catch (e) { b.done(); console.error(e); toast('Stem export failed: ' + e.message, { error: true, ms: 4500 }); }
}

const ProjectView = {
  init() {
    App.on('change', () => { if (App.tab === 'project') this.render(); else this.stale = true; });
    App.on('save', () => { if (App.tab === 'project') this.renderSaved(); });
    App.on('storage', () => this.renderStorage());
  },
  show() { this.render(); },
  renderSaved() { const el = $('#pv-saved'); if (el) el.textContent = App.saveState === 'saved' ? 'Saved on this device' : App.saveState === 'dirty' ? 'Saving…' : 'Not saved'; },
  async render() {
    this.stale = false;
    const P = App.project, main = $('#project-main');
    const scrollBox = main.parentElement, keep = scrollBox.scrollTop;
    main.innerHTML = '';
    const clips = P.tracks.reduce((n, t) => n + t.clips.length, 0);
    const cur = h('div', { class: 'card' },
      h('h3', { html: ic('folder-open') + 'This session' }),
      h('div', { style: { fontSize: '20px', fontWeight: 600, marginBottom: '2px', wordBreak: 'break-word' }, text: P.name }),
      h('div', { id: 'pv-saved', style: { fontSize: '12px', color: 'var(--dim)', marginBottom: '10px' } }),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', { text: String(P.tracks.length) }), h('span', { text: 'tracks' })),
        h('div', { class: 'stat' }, h('b', { text: String(clips) }), h('span', { text: 'clips' })),
        h('div', { class: 'stat' }, h('b', { text: fmtTime(Engine.songEnd(), false) }), h('span', { text: 'length' })),
        h('div', { class: 'stat' }, h('b', { text: String(P.media.length) }), h('span', { text: 'audio files' })),
        h('div', { class: 'stat' }, h('b', { text: String(P.markers.length) }), h('span', { text: 'markers' })),
        h('div', { class: 'stat' }, h('b', { text: (Engine.ctx ? Engine.ctx.sampleRate / 1000 : 48).toFixed(1) }), h('span', { text: 'kHz' }))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', html: ic('pencil') + 'Rename', onclick: () => $('#proj-name').click() }),
        h('button', { class: 'btn', html: ic('copy-plus') + 'Save a copy', onclick: async () => { await saveProject(); const n = await promptSheet('Save a copy', P.name + ' copy', { color: 'var(--c-project)', icon: 'copy-plus', ok: 'Create copy' }); if (!n) return; const p = await duplicateProject(P.id, n.trim() || P.name + ' copy'); if (p) { await loadProject(p); toast('Now editing ' + p.name, { color: 'var(--c-project)' }); } } }),
        h('button', { class: 'btn primary', html: ic('file-plus') + 'New session', onclick: async () => { const n = await promptSheet('New session', 'Untitled session', { color: 'var(--c-project)', icon: 'file-plus', ok: 'Create' }); if (n != null) createProject(n.trim() || 'Untitled session'); } })));
    const exp = h('div', { class: 'card' },
      h('h3', { html: ic('download') + 'Export' }),
      h('div', { class: 'menu' },
        this.mi('download', 'Export mix', 'WAV or MP3, whole song or loop', () => exportMixSheet(false)),
        this.mi('layers', 'Export stems', 'One WAV or MP3 per track, zipped', () => exportMixSheet(true)),
        this.mi('package', 'Export session archive', '.snapwav.zip with all audio', () => exportProjectZip()),
        this.mi('file-archive', 'Export DAWproject', 'Open in Bitwig, Studio One, yadaw…', () => DawProject.exportFile())));
    const imp = h('div', { class: 'card' },
      h('h3', { html: ic('upload') + 'Import' }),
      h('div', { class: 'menu' },
        this.mi('file-music', 'Import audio files', 'Adds them to Media', () => pickAudio({ place: false })),
        this.mi('package', 'Open session or DAWproject', '.snapwav.zip or .dawproject', () => { const f = $('#file-project'); f.value = ''; f.click(); })));
    const listCard = h('div', { class: 'card' }, h('h3', { html: ic('list-music') + 'Sessions on this device' }));
    const listBox = h('div', { class: 'list' }, h('div', { class: 'empty-note', text: 'Loading…' }));
    listCard.append(listBox);
    const settings = h('div', { class: 'card' }, h('h3', { html: ic('settings-2') + 'Settings' }));
    const tm = h('div', { class: 'seg' }); tm.style.setProperty('--rc', 'var(--c-project)');
    const drawTm = () => { const cur = Settings.get('timeMode') === 'remaining' ? 'remaining' : 'elapsed'; tm.innerHTML = ''; for (const [v, l] of [['elapsed', 'Elapsed'], ['remaining', 'Remaining']]) tm.append(h('button', { class: cur === v ? 'on' : '', text: l, onclick: () => { Settings.set('timeMode', v); drawTm(); updatePos(); } })); };
    drawTm();
    const th = h('div', { class: 'seg' });
    const drawTh = () => { th.innerHTML = ''; for (const [v, l] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) th.append(h('button', { class: Theme.pref() === v ? 'on' : '', text: l, 'aria-pressed': String(Theme.pref() === v), onclick: () => { Theme.set(v); drawTh(); } })); };
    drawTh();
    settings.append(
      h('div', { class: 'setrow' }, h('div', { class: 'txt' }, 'Appearance', h('small', { text: 'Light or dark, or follow the phone' })), th),
      h('div', { class: 'setrow' }, h('div', { class: 'txt' }, 'Time display', h('small', { text: 'Tap the time in the player to switch' })), tm),
      switchRow('set-follow', 'Follow playhead', 'Scroll the timeline during playback', Settings.get('follow'), v => Settings.set('follow', v), 'var(--c-project)'),
      switchRow('set-haptics', 'Haptic feedback', 'Short vibration on taps (Android)', Settings.get('haptics'), v => Settings.set('haptics', v), 'var(--c-project)'),
    );
    const storage = h('div', { class: 'card' }, h('h3', { html: ic('hard-drive') + 'Storage' }));
    storage.append(h('div', { id: 'pv-storage', class: 'store-box' }));
    const stTxt = h('p', { style: { margin: '0 0 10px', color: 'var(--dim)', fontSize: '12.5px' }, text: !DB.persistent ? 'This browser blocked storage, so sessions last only until you close the page. Export an archive to keep your work.' : window.SnapWavAndroid ? 'Sessions and audio are stored inside the SnapWav app on this device. Uninstalling the app removes them, so export an archive to back up or move a session.' : 'Sessions and audio are kept in this browser on this device. Export an archive to back up or move a session.' });
    storage.append(stTxt);
    const persistBtn = h('button', { class: 'btn', html: ic('hard-drive') + 'Keep data when space is low' });
    persistBtn.onclick = async () => { try { const ok = await navigator.storage.persist(); toast(ok ? 'Storage marked as persistent' : 'The browser declined. Data may be cleared when space runs low.', { error: !ok }); } catch (e) { toast('Not supported here', { error: true }); } };
    if (navigator.storage && navigator.storage.persist && DB.persistent) storage.append(h('div', { class: 'btn-row' }, persistBtn));
    const keys = h('div', { class: 'card' }, h('h3', { html: ic('keyboard') + 'Keyboard shortcuts' }),
      h('div', { class: 'kbd-list' }, ...SHORTCUTS.flatMap(([k, d]) => [h('kbd', { text: k }), h('span', { text: d })])));
    const touch = h('div', { class: 'card' }, h('h3', { html: ic('mouse-pointer-2') + 'Touch gestures' }),
      h('div', { class: 'kbd-list' }, ...[
        ['Tap clip', 'Select · double-tap to edit'], ['Drag selected clip', 'Move, also to other tracks'], ['Drag clip edges', 'Trim start or end'],
        ['Drag top dots', 'Fade in / fade out'], ['Long-press', 'Context menu'], ['Pinch', 'Zoom the timeline'], ['Hold − / +', 'Keep zooming'], ['Drag empty space', 'Scroll'],
        ['Ruler top band', 'Draw or move the loop'], ['Ruler', 'Scrub the playhead'], ['Tap a track', 'Select it; it grows taller for curves'],
        ['Marker pill', 'Adds a marker; removes it when the playhead is on one'],
        ['Tap in a curve lane', 'Add a point (snaps to the dashed default)'], ['Double-tap a point', 'Remove it'],
      ].flatMap(([k, d]) => [h('kbd', { text: k }), h('span', { text: d })])));
    const about = h('div', { class: 'card about' }, h('h3', { html: ic('info') + 'About SnapWav' }),
      h('p', { html: 'SnapWav is a lightweight multitrack audio workstation for phones, tablets and desktops. It runs fully in the browser with the Web Audio API and keeps your sessions on your device.' }),
      h('p', { html: 'SnapWav is free software, licensed under the GNU Affero General Public License v3.0.' }),
      h('p', { html: 'Inspired by <a href="https://github.com/mlm-games/yadaw" target="_blank" rel="noopener">yadaw</a> by mlm-games (AGPL-3.0). SnapWav is an independent implementation and shares no code with it.' }),
      h('p', { html: 'Icons: <a href="https://lucide.dev" target="_blank" rel="noopener">Lucide</a> (ISC License). Fonts: Instrument Sans and JetBrains Mono (SIL Open Font License). MP3 export uses <a href="https://lame.sourceforge.io" target="_blank" rel="noopener">LAME</a> through lamejs (LGPL), loaded as a separate script only when you export MP3.' }));
    const left = h('div', {}, cur, exp, imp), right = h('div', {}, listCard, settings, storage, touch, keys, about);
    main.append(h('div', { class: 'sec-title' }, h('h2', { text: 'Project' })), h('div', { class: 'proj-cols' }, left, right));
    this.renderSaved();
    this.renderStorage();
    scrollBox.scrollTop = keep;
    const all = await DB.listProjects().catch(() => []);
    listBox.innerHTML = '';
    if (!all.length) listBox.append(h('div', { class: 'empty-note', text: 'No saved sessions yet.' }));
    for (const p of all) {
      const isCur = p.id === P.id;
      const row = h('div', { class: 'prow-proj' + (isCur ? ' cur' : '') },
        h('div', { class: 'info', onclick: () => { if (!isCur) openProjectById(p.id); } },
          h('div', { style: { fontWeight: 600, fontSize: '13.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, text: p.name }),
          h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--dim)' }, text: `${fmtDate(p.modified)} · ${p.tracks} track${p.tracks === 1 ? '' : 's'} · ${p.clips} clip${p.clips === 1 ? '' : 's'}` })),
        isCur ? h('span', { class: 'badge acc', text: 'Open' }) : h('button', { class: 'btn', style: { height: '34px', padding: '0 12px' }, text: 'Open', onclick: () => openProjectById(p.id) }),
        h('button', { class: 'ibtn', 'aria-label': 'Session options', html: ic('ellipsis-vertical'), onclick: () => this.sessionMenu(p, isCur) }));
      listBox.append(row);
    }
  },
  /* Session storage, measured once when the session is opened (see measureSession) */
  renderStorage() {
    const box = $('#pv-storage'); if (!box) return;
    const st = App.storage, P = App.project;
    box.innerHTML = '';
    if (!st || st.sessionId !== P.id || st.measuring) { box.append(h('p', { class: 'store-note', text: 'Measuring this session…' })); return; }
    if (st.error) { box.append(h('p', { class: 'store-note', text: 'Couldn’t measure storage here.' })); return; }
    const sum = st.audio + st.data;
    const row = (label, v, color) => h('div', { class: 'store-row' }, h('span', { class: 'dot', style: { background: color } }), h('span', { class: 'grow', text: label }), h('b', { class: 'mono', text: fmtBytes(v) }));
    const bar = h('div', { class: 'store-bar' });
    if (sum > 0) {
      const a = h('i', { style: { width: (st.audio / sum * 100).toFixed(1) + '%', background: 'var(--c-media)' } });
      const d = h('i', { style: { width: (st.data / sum * 100).toFixed(1) + '%', background: 'var(--faint)' } });
      bar.append(a, d);
    }
    box.append(
      h('div', { class: 'store-big' }, h('b', { class: 'mono', text: fmtBytes(sum) }), h('span', { text: 'used by this session' })),
      bar,
      row(`Audio files (${P.media.length})`, st.audio, 'var(--c-media)'),
      row('Session data, edits and presets', st.data, 'var(--faint)'),
      st.total != null ? row('All SnapWav data on this device', st.total, 'var(--faint)') : null,
      h('p', { class: 'store-note', text: `Measured when this session was opened at ${new Date(st.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It updates the next time you open the app.` }));
  },
  mi(icon, label, hint, fn) {
    const b = h('button', { html: ic(icon) + `<span style="display:flex;flex-direction:column;line-height:1.25"><span>${esc(label)}</span><small style="margin:0;font-family:var(--f-ui);color:var(--dim);font-size:11.5px">${esc(hint)}</small></span>` });
    b.style.setProperty('--mc', 'var(--c-project)');
    b.onclick = fn; return b;
  },
  sessionMenu(p, isCur) {
    menuSheet(p.name, [
      !isCur && { icon: 'folder-open', label: 'Open', onClick: () => openProjectById(p.id) },
      { icon: 'pencil', label: 'Rename', onClick: async () => {
        const n = await promptSheet('Rename session', p.name, { color: 'var(--c-project)' }); if (!n || !n.trim()) return;
        if (isCur) mutate(P => { P.name = n.trim(); }); else { const full = await DB.getProject(p.id); full.name = n.trim(); await DB.putProject(full); this.render(); }
      } },
      { icon: 'copy-plus', label: 'Duplicate', onClick: async () => { if (isCur) await saveProject(); await duplicateProject(p.id, p.name + ' copy'); this.render(); toast('Duplicated', { color: 'var(--c-project)' }); } },
      'sep',
      { icon: 'trash-2', label: 'Delete session', danger: true, onClick: async () => {
        if (!(await confirmSheet('Delete session?', `“${p.name}” and its audio will be removed from this device. This can’t be undone.`, { ok: 'Delete', danger: true, icon: 'trash-2' }))) return;
        await DB.deleteProject(p.id);
        if (isCur) { const rest = await DB.listProjects(); if (rest.length) { const np = await DB.getProject(rest[0].id); await loadProject(np); } else { const np = newProject('Untitled session'); await DB.putProject(np); await loadProject(np, { silent: true }); } }
        this.render(); toast('Session deleted');
      } },
    ], { icon: 'folder-open', color: 'var(--c-project)' });
  },
};
