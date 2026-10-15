/* ================= Native Android wrapper bridge =================
   The Android app (android/) injects window.SnapWavAndroid. In a browser it is absent. */
const Native = window.SnapWavAndroid || null;
const MIME_BY_EXT = { wav: 'audio/wav', mp3: 'audio/mpeg', zip: 'application/zip', dawproject: 'application/octet-stream', json: 'application/json' };

function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const _nativeSaves = {};
window.__snapwavSaveDone = (token, ok, msg) => {
  const r = _nativeSaves[token]; delete _nativeSaves[token];
  if (r) r({ ok, msg });
};
/* Hand a generated file to Android's "Save to…" picker */
async function nativeSave(filename, blob) {
  const ext = filename.split('.').pop().toLowerCase();
  const mime = blob.type || MIME_BY_EXT[ext] || 'application/octet-stream';
  const buf = new Uint8Array(await blob.arrayBuffer());
  const b = buf.length > 3e6 ? busy('Preparing ' + filename, fmtBytes(buf.length)) : null;
  try {
    const token = Native.saveBegin(filename, mime);
    const CH = 393216;
    for (let i = 0, n = 0; i < buf.length; i += CH, n++) {
      Native.saveChunk(token, bytesToB64(buf.subarray(i, i + CH)));
      if (b && n % 4 === 0) { b.set(i / buf.length); await new Promise(r => setTimeout(r, 0)); }
    }
    if (b) b.done();
    const res = await new Promise(r => { _nativeSaves[token] = r; Native.saveEnd(token); });
    if (res.ok) toast('Saved ' + (res.msg || filename), { color: 'var(--c-ok)' });
    else if (res.msg === 'cancelled') toast('Save cancelled');
    else toast('Couldn’t save: ' + res.msg, { error: true });
    return res.ok;
  } catch (e) {
    if (b) b.done();
    toast('Couldn’t save: ' + (e.message || e), { error: true });
    return false;
  }
}
/* Files shared to the app or opened with it ("Share → SnapWav", "Open with") */
window.snapwavReceive = async list => {
  const files = [];
  for (const it of list || []) {
    try {
      const r = await fetch(it.url);
      if (!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      files.push(new File([blob], it.name || 'shared-audio', { type: it.type || blob.type || '' }));
    } catch (e) { console.warn('shared file', it, e); }
  }
  if (!files.length) { toast('Couldn’t read the shared file', { error: true }); return; }
  const proj = files.find(f => /\.(zip|dawproject)$/i.test(f.name));
  if (proj) { await importArchive(proj); return; }
  setTab('arrange');
  await importFiles(files, { place: true });
};
function nativeInit() {
  if (!Native) return;
  document.documentElement.classList.add('native-android');
  try {
    const pending = JSON.parse(Native.takeShared() || '[]');
    if (pending.length) window.snapwavReceive(pending);
  } catch (e) { console.warn(e); }
}
