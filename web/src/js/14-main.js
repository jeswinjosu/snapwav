/* ================= Boot ================= */
async function receiveSharedFiles() {
  // Files shared to the installed PWA from other Android apps (Web Share Target)
  if (!/[?&]shared=1/.test(location.search) || !('caches' in window)) return;
  try {
    const cache = await caches.open('snapwav-share');
    const keys = await cache.keys();
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'shared-audio');
      files.push(new File([blob], name, { type: blob.type }));
      await cache.delete(req);
    }
    history.replaceState(null, '', location.pathname);
    if (files.length) await importFiles(files, { place: true, at: 0 });
  } catch (e) { console.warn('share target', e); }
}

async function boot() {
  Views.arrange = Arrange; Views.mixer = Mixer; Views.fx = Effects; Views.media = Media; Views.project = ProjectView;
  Settings.migrate();
  Theme.init();
  bindShell(); bindPickers();
  Arrange.init(); SidePanel.init(); Mixer.init(); Effects.init(); Media.init(); ProjectView.init();
  // switching between dark and light redraws everything that holds colours (canvas, inline track colours)
  App.on('theme', () => { if (!App.project) return; App.emit('change', 'theme'); App.emit('sel'); Arrange.render(); moveNavIndicator(true); });
  await DB.open();
  Engine.init();
  let p = null;
  try {
    const last = Settings.get('lastProject');
    if (last) p = await DB.getProject(last);
    if (!p) { const list = await DB.listProjects(); if (list.length) p = await DB.getProject(list[0].id); }
  } catch (e) { console.warn(e); }
  if (!p) { p = newProject('My first session'); try { await DB.putProject(p); } catch (e) { /* memory only */ } }
  await loadProject(p, { silent: false });
  setTab('arrange', true);
  updateSaveDot(); updatePlayBtn();
  if (!DB.persistent) toast('This browser blocks storage here. Export an archive to keep your work.', { ms: 5000 });
  await receiveSharedFiles();
  nativeInit();
  if ('serviceWorker' in navigator && !inFrame && window.SNAPWAV_PWA && !window.SnapWavAndroid) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
boot().catch(e => { console.error(e); document.body.append(h('div', { class: 'busy' }, h('div', { class: 'box' }, h('b', { text: 'SnapWav couldn’t start' }), h('small', { text: String(e && e.message || e) })))); });
