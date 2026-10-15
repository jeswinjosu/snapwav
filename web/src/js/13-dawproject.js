/* ================= DAWproject interchange (audio tracks, clips, mix, markers) ================= */
const DawProject = {
  async exportFile() {
    await saveProject();
    const P = App.project;
    const b = busy('Building DAWproject', '');
    try {
      let n = 0; const id = () => 'id' + (n++);
      const f = v => (+v).toFixed(6);
      const masterCh = id();
      const tIds = new Map(), chIds = new Map();
      for (const t of P.tracks) { tIds.set(t.id, id()); chIds.set(t.id, id()); }
      const files = [], paths = new Map();
      const used = P.media.filter(m => mediaUsage(m.id));
      for (let i = 0; i < used.length; i++) {
        const m = used[i];
        b.set(i / Math.max(1, used.length) * 0.8, m.name);
        const rec = await DB.getMedia(m.id); if (!rec) continue;
        const ext = (m.name.match(/\.[^.]+$/) || ['.wav'])[0];
        const path = `audio/${safeName(baseName(m.name)).replace(/\s+/g, '_')}_${m.id}${ext}`;
        paths.set(m.id, path);
        files.push({ name: path, data: new Uint8Array(await rec.blob.arrayBuffer()) });
      }
      const param = (tag, attrs) => `<${tag} ${attrs} id="${id()}" name="${tag}"/>`;
      let tracksXml = '';
      for (const t of P.tracks) {
        const dest = t.output !== 'master' && chIds.get(t.output) ? chIds.get(t.output) : masterCh;
        const sends = (t.sends || []).filter(s => chIds.get(s.target)).map(s =>
          `<Send destination="${chIds.get(s.target)}" type="${s.pre ? 'pre' : 'post'}" id="${id()}" name="Send">${param('Volume', `max="2.000000" min="0.000000" unit="linear" value="${f(s.amount)}"`)}</Send>`).join('');
        tracksXml += `
    <Track contentType="audio" loaded="true" id="${tIds.get(t.id)}" name="${esc(t.name)}" color="${App.colorOf(t)}">
      <Channel audioChannels="2" destination="${dest}" role="${t.type === 'bus' ? 'effect' : 'regular'}" solo="false" id="${chIds.get(t.id)}">
        ${param('Mute', `value="${t.mute}"`)}
        ${param('Pan', `max="1.000000" min="0.000000" unit="normalized" value="${f((t.pan + 1) / 2)}"`)}
        ${param('Volume', `max="2.000000" min="0.000000" unit="linear" value="${f(t.vol)}"`)}${sends ? `\n        <Sends>${sends}</Sends>` : ''}
      </Channel>
    </Track>`;
      }
      tracksXml += `
    <Track contentType="audio notes" loaded="true" id="${id()}" name="Master">
      <Channel audioChannels="2" role="master" solo="false" id="${masterCh}">
        ${param('Mute', 'value="false"')}
        ${param('Pan', 'max="1.000000" min="0.000000" unit="normalized" value="0.500000"')}
        ${param('Volume', `max="2.000000" min="0.000000" unit="linear" value="${f(P.master.vol)}"`)}
      </Channel>
    </Track>`;
      let lanes = '', reversed = 0;
      for (const t of P.tracks) {
        if (t.type !== 'audio' || !t.clips.length) continue;
        let clips = '';
        for (const c of t.clips.slice().sort((a, x) => a.start - x.start)) {
          const m = App.media(c.mediaId), path = paths.get(c.mediaId); if (!m || !path) continue;
          if (c.reversed) reversed++;
          const audio = `<Audio algorithm="raw" channels="${m.channels}" duration="${f(m.duration)}" sampleRate="${m.sampleRate}" timeUnit="seconds" id="${id()}"><File path="${path}"/></Audio>`;
          const rate = c.rate || 1;
          const content = rate === 1 ? audio
            : `<Warps contentTimeUnit="seconds" timeUnit="seconds" id="${id()}">${audio}<Warp time="0.000000" contentTime="${f(c.offset)}"/><Warp time="${f(c.duration)}" contentTime="${f(c.offset + c.duration * rate)}"/></Warps>`;
          clips += `
          <Clip time="${f(c.start)}" duration="${f(c.duration)}" playStart="${f(rate === 1 ? c.offset : 0)}" fadeTimeUnit="seconds" fadeInTime="${f(c.fadeIn)}" fadeOutTime="${f(c.fadeOut)}" name="${esc(c.name || m.name)}"${c.muted ? ' enable="false"' : ''}>${content}</Clip>`;
        }
        lanes += `
      <Lanes track="${tIds.get(t.id)}" id="${id()}">
        <Clips id="${id()}">${clips}
        </Clips>
      </Lanes>`;
      }
      const markers = P.markers.length ? `
    <Markers id="${id()}">${P.markers.map((m, i) => `<Marker time="${f(m.t)}" name="${esc(m.name || 'M' + (i + 1))}" color="${m.color || '#E5E7EB'}"/>`).join('')}</Markers>` : '';
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project version="1.0">
  <Application name="SnapWav" version="1.0"/>
  <Transport>
    <Tempo max="999.000000" min="20.000000" unit="bpm" value="${f(P.bpm)}" id="${id()}" name="Tempo"/>
    <TimeSignature denominator="${P.sig[1]}" numerator="${P.sig[0]}" id="${id()}"/>
  </Transport>
  <Structure>${tracksXml}
  </Structure>
  <Arrangement id="${id()}">${markers}
    <Lanes timeUnit="seconds" id="${id()}">${lanes}
    </Lanes>
  </Arrangement>
</Project>
`;
      const meta = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<MetaData>\n  <Title>${esc(P.name)}</Title>\n  <Comment>Exported from SnapWav</Comment>\n</MetaData>\n`;
      files.unshift({ name: 'project.xml', data: xml }, { name: 'metadata.xml', data: meta });
      b.set(0.9, 'Packing');
      const zip = await Zip.create(files);
      b.done();
      // .dawproject is a zip; the viewer only accepts .zip downloads, so name accordingly there
      const viaViewer = !!(await getDownloads());
      await saveFile(safeName(P.name) + (viaViewer ? '.dawproject.zip' : '.dawproject'), zip);
      if (reversed) toast(`${reversed} reversed clip${reversed > 1 ? 's were' : ' was'} exported forwards (DAWproject has no reverse flag)`, { ms: 4500 });
    } catch (e) { b.done(); console.error(e); toast('DAWproject export failed: ' + e.message, { error: true }); }
  },

  async importFiles(files, fallbackName) {
    const b = busy('Importing DAWproject', '');
    try {
      const dec = new TextDecoder();
      const doc = new DOMParser().parseFromString(dec.decode(files.get('project.xml')), 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('project.xml is not valid XML');
      let title = fallbackName;
      if (files.has('metadata.xml')) { const md = new DOMParser().parseFromString(dec.decode(files.get('metadata.xml')), 'application/xml'); const tt = md.querySelector('Title'); if (tt && tt.textContent.trim()) title = tt.textContent.trim(); }
      const P = newProject(title || 'Imported session');
      P.tracks = [];
      const tempo = doc.querySelector('Transport > Tempo');
      P.bpm = clamp(parseFloat(tempo && tempo.getAttribute('value')) || 120, 20, 300);
      const ts = doc.querySelector('Transport > TimeSignature');
      if (ts) P.sig = [parseInt(ts.getAttribute('numerator')) || 4, parseInt(ts.getAttribute('denominator')) || 4];
      const beat = 60 / P.bpm;
      const toSec = (v, unit) => (parseFloat(v) || 0) * (unit === 'beats' ? beat : 1);
      const nearestColor = hex => {
        if (!/^#?[0-9a-f]{6}/i.test(hex || '')) return null;
        const n = parseInt(hex.replace('#', '').slice(0, 6), 16), r = n >> 16 & 255, g = n >> 8 & 255, bl = n & 255;
        let best = 0, bd = Infinity;
        TRACK_COLORS.forEach((c, i) => { const m = parseInt(c.slice(1), 16); const d = (r - (m >> 16 & 255)) ** 2 + (g - (m >> 8 & 255)) ** 2 + (bl - (m & 255)) ** 2; if (d < bd) { bd = d; best = i; } });
        return best;
      };
      const pval = (ch, tag, def) => { const e = [...ch.children].find(x => x.tagName === tag); if (!e) return def; const v = e.getAttribute('value'); if (tag === 'Mute') return v === 'true'; const unit = e.getAttribute('unit'); let x = parseFloat(v); if (!isFinite(x)) return def; if (unit === 'decibel') x = dbToGain(x); return x; };
      const byTrackId = new Map(), byChannel = new Map();
      let masterCh = null;
      const pending = [];
      for (const te of doc.querySelectorAll('Structure Track')) {
        const ch = [...te.children].find(x => x.tagName === 'Channel');
        const ct = te.getAttribute('contentType') || '';
        if (ch && ch.getAttribute('role') === 'master') { masterCh = ch.getAttribute('id'); const mv = pval(ch, 'Volume', 1); P.master.vol = clamp(mv, 0, 2); continue; }
        if (!ch) continue;
        const isBus = ch.getAttribute('role') === 'effect' || (!/audio/.test(ct) && /tracks/.test(ct));
        if (!isBus && !/audio/.test(ct)) continue;
        const t = newTrack(te.getAttribute('name') || 'Track', nearestColor(te.getAttribute('color')) ?? App.nextColor(), isBus ? 'bus' : 'audio');
        if (isBus) t.height = 72;
        t.vol = clamp(pval(ch, 'Volume', 1), 0, 2);
        t.pan = clamp(pval(ch, 'Pan', 0.5) * 2 - 1, -1, 1);
        t.mute = pval(ch, 'Mute', false);
        P.tracks.push(t);
        byTrackId.set(te.getAttribute('id'), t);
        byChannel.set(ch.getAttribute('id'), t);
        pending.push([t, ch]);
      }
      for (const [t, ch] of pending) {
        const d = ch.getAttribute('destination');
        const bus = d && d !== masterCh ? byChannel.get(d) : null;
        if (bus && bus.type === 'bus' && bus !== t) t.output = bus.id;
        for (const s of ch.querySelectorAll('Sends > Send')) {
          const tgt = byChannel.get(s.getAttribute('destination'));
          if (!tgt || tgt.type !== 'bus' || tgt === t) continue;
          const vol = s.querySelector('Volume');
          t.sends.push({ id: uid(), target: tgt.id, amount: clamp(parseFloat(vol && vol.getAttribute('value')) || 0.5, 0, 2), pre: s.getAttribute('type') === 'pre' });
        }
      }
      // decode audio files referenced by clips
      Engine.init();
      const mediaByPath = new Map();
      const getMedia = async (path) => {
        if (mediaByPath.has(path)) return mediaByPath.get(path);
        const norm = path.replace(/^\.\//, '');
        const data = files.get(norm) || files.get(decodeURIComponent(norm));
        if (!data) { mediaByPath.set(path, null); return null; }
        const mid = uid();
        try {
          const buf = await Engine.decode(mid, data.slice().buffer);
          const name = norm.split('/').pop();
          await DB.putMedia({ id: mid, projectId: P.id, name, type: '', blob: new Blob([data]) });
          const m = { id: mid, name, duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, size: data.length, added: Date.now() };
          P.media.push(m); mediaByPath.set(path, m); return m;
        } catch (e) { console.warn('decode failed', path, e); mediaByPath.set(path, null); return null; }
      };
      const unitOf = el => { for (let e = el; e && e.getAttribute; e = e.parentElement) { const u = e.getAttribute('timeUnit'); if (u) return u; } return 'beats'; };
      let missing = 0, count = 0;
      const clipEls = [];
      const collect = (clipsEl, t, base) => {
        for (const c of [...clipsEl.children].filter(x => x.tagName === 'Clip')) clipEls.push({ c, t, base, unit: unitOf(clipsEl) });
      };
      for (const ln of doc.querySelectorAll('Arrangement Lanes[track]')) {
        const t = byTrackId.get(ln.getAttribute('track'));
        if (!t || t.type !== 'audio') continue;
        for (const cl of [...ln.children].filter(x => x.tagName === 'Clips')) collect(cl, t, 0);
      }
      for (let i = 0; i < clipEls.length; i++) {
        const { c, t, base, unit } = clipEls[i];
        b.set(i / Math.max(1, clipEls.length), `${i + 1} of ${clipEls.length} clips`);
        const start = base + toSec(c.getAttribute('time'), unit);
        const dur = toSec(c.getAttribute('duration'), unit);
        const fu = c.getAttribute('fadeTimeUnit') || unit;
        const kids = [...c.children];
        const nested = kids.find(x => x.tagName === 'Clips') || (kids.find(x => x.tagName === 'Lanes') && kids.find(x => x.tagName === 'Lanes').querySelector('Clips'));
        if (nested) { const ps = toSec(c.getAttribute('playStart') || 0, unitOf(nested)); for (const cc of [...nested.children].filter(x => x.tagName === 'Clip')) clipEls.push({ c: cc, t, base: start - ps, unit: unitOf(nested) }); continue; }
        const warps = kids.find(x => x.tagName === 'Warps');
        const audio = warps ? warps.querySelector('Audio') : kids.find(x => x.tagName === 'Audio');
        const file = audio && audio.querySelector('File');
        if (!file) continue;
        const m = await getMedia(file.getAttribute('path') || '');
        if (!m) { missing++; continue; }
        let offset = 0, rate = 1;
        if (warps) {
          const wu = warps.getAttribute('timeUnit') || unit, cu = warps.getAttribute('contentTimeUnit') || 'seconds';
          const pts = [...warps.children].filter(x => x.tagName === 'Warp').map(w => ({ t: toSec(w.getAttribute('time'), wu), c: toSec(w.getAttribute('contentTime'), cu) }));
          const ps = toSec(c.getAttribute('playStart') || 0, wu);
          if (pts.length >= 2) {
            const a = pts[0], z = pts[pts.length - 1];
            rate = clamp((z.c - a.c) / Math.max(1e-6, z.t - a.t), 0.25, 4);
            offset = a.c + (ps - a.t) * rate;
          } else if (pts.length === 1) offset = pts[0].c + ps;
        } else {
          const au = audio.getAttribute('timeUnit') || 'seconds';
          offset = toSec(c.getAttribute('playStart') || 0, au);
        }
        offset = clamp(offset, 0, m.duration);
        const d2 = Math.min(dur, (m.duration - offset) / rate);
        if (d2 <= 0.005) continue;
        t.clips.push({
          id: uid(), mediaId: m.id, name: c.getAttribute('name') || baseName(m.name), start: Math.max(0, start), offset, duration: d2,
          gain: 1, fadeIn: Math.min(toSec(c.getAttribute('fadeInTime') || 0, fu), d2), fadeOut: Math.min(toSec(c.getAttribute('fadeOutTime') || 0, fu), d2),
          rate, reversed: false, muted: c.getAttribute('enable') === 'false', color: null,
        });
        count++;
      }
      for (const mk of doc.querySelectorAll('Arrangement Markers > Marker')) P.markers.push({ id: uid(), t: toSec(mk.getAttribute('time'), unitOf(mk)), name: '', color: TRACK_COLORS[nearestColor(mk.getAttribute('color')) ?? 9] });
      if (!P.tracks.length) P.tracks.push(newTrack('Audio 1', 5));
      b.done();
      if (App.project) await saveProject();
      await DB.putProject(P);
      await loadProject(P, { silent: true });
      toast(`Imported ${count} clip${count === 1 ? '' : 's'} on ${P.tracks.length} tracks${missing ? ` · ${missing} missing audio file${missing > 1 ? 's' : ''}` : ''}`, { color: 'var(--c-project)', ms: 4000 });
    } catch (e) { b.done(); console.error(e); toast('Couldn’t import DAWproject: ' + e.message, { error: true, ms: 4500 }); }
  },
};
