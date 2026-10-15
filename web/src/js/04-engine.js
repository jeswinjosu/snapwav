/* ================= Audio engine ================= */
/* ---------- Curves (automation) ----------
   Track scope: 'vol' | 'pan' | 'fx:<fxId>:<param>'  → points in track.curves[key], absolute seconds
   Part scope:  'part:gain' | 'part:pan' | 'part:fx:<link>:<param>' → points in clip.curves[sub], seconds from clip start */
function valueAt(pts, t) {
  if (!pts || !pts.length) return 0.5;
  if (t <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= t) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  return b.t === a.t ? b.v : lerp(a.v, b.v, (t - a.t) / (b.t - a.t));
}
const isPartKey = k => k.startsWith('part:');
const partSub = k => k.slice(5);
const fxLink = f => f.link || f.id;
function partFx(c, link) { return (c.fx || []).find(f => fxLink(f) === link); }
function curveSpec(t, key) {
  const col = App.colorOf(t);
  if (key === 'vol') return { key, scope: 'track', group: 'Track', label: 'Track volume', short: 'Volume', color: col, toReal: posToGain, fmt: v => fmtDb(gainToDb(posToGain(v))) + ' dB', def: () => gainToPos(t.vol) };
  if (key === 'pan') return { key, scope: 'track', group: 'Track', label: 'Track pan', short: 'Pan', color: col, toReal: v => v * 2 - 1, fmt: v => fmtPan(v * 2 - 1), def: () => (t.pan + 1) / 2 };
  if (key === 'part:gain') return { key, scope: 'part', group: 'Part', label: 'Part volume', short: 'Volume', color: col, toReal: posToGain, fmt: v => fmtDb(gainToDb(posToGain(v))) + ' dB', def: () => gainToPos(1), has: () => true };
  if (key === 'part:pan') return { key, scope: 'part', group: 'Part', label: 'Part pan', short: 'Pan', color: col, toReal: v => v * 2 - 1, fmt: v => fmtPan(v * 2 - 1), def: c => (((c && c.pan) || 0) + 1) / 2, has: () => true };
  let m = /^part:fx:([^:]+):(.+)$/.exec(key);
  if (m) {
    const link = m[1], k = m[2];
    let type = null;
    for (const c of t.clips) { const f = partFx(c, link); if (f) { type = f.type; break; } }
    if (!type || !FX[type] || !FX[type].params[k]) return null;
    const spec = FX[type].params[k];
    return {
      key, scope: 'part', group: FX[type].name, label: `${FX[type].name} · ${spec.label}`, short: spec.label, color: FX[type].color, fxType: type, link, param: k, spec,
      toReal: v => pDenorm(spec, v), fmt: v => fmtParam(spec, pDenorm(spec, v)),
      def: c => { const f = c && partFx(c, link); return pNorm(spec, f ? f.params[k] : spec.def); },
      has: c => !!partFx(c, link),
    };
  }
  m = /^fx:([^:]+):(.+)$/.exec(key);
  if (m) {
    const fx = (t.fx || []).find(f => f.id === m[1]);
    if (!fx || !FX[fx.type] || !FX[fx.type].params[m[2]]) return null;
    const spec = FX[fx.type].params[m[2]];
    return {
      key, scope: 'track', group: FX[fx.type].name, label: `${FX[fx.type].name} · ${spec.label}`, short: spec.label, color: FX[fx.type].color, fxType: fx.type, fx, param: m[2], spec,
      toReal: v => pDenorm(spec, v), fmt: v => fmtParam(spec, pDenorm(spec, v)), def: () => pNorm(spec, fx.params[m[2]] ?? spec.def),
    };
  }
  return null;
}
function getCurve(t, key, c) {
  if (isPartKey(key)) return (c && c.curves && c.curves[partSub(key)]) || [];
  return (t.curves && t.curves[key]) || [];
}
function ensureCurve(t, key, c) {
  if (isPartKey(key)) { c.curves = c.curves || {}; return (c.curves[partSub(key)] = c.curves[partSub(key)] || []); }
  t.curves = t.curves || {}; return (t.curves[key] = t.curves[key] || []);
}
function curveHasPoints(t, key) {
  if (isPartKey(key)) return t.clips.some(c => getCurve(t, key, c).length);
  return getCurve(t, key).length > 0;
}
function trackAutomated(t, key) { return !!(t && t.curves && t.curves[key] && t.curves[key].length); }
/* Where an effect lives: {track, clip|null, fx} */
function fxOwner(fxId) {
  const P = App.project;
  for (const t of P.tracks) {
    const f = (t.fx || []).find(x => x.id === fxId); if (f) return { track: t, clip: null, fx: f };
    for (const c of t.clips) { const g = (c.fx || []).find(x => x.id === fxId); if (g) return { track: t, clip: c, fx: g }; }
  }
  const mf = P.master.fx.find(x => x.id === fxId);
  return mf ? { track: null, clip: null, fx: mf } : null;
}

class Graph {
  constructor(ctx, P, opts = {}) {
    this.ctx = ctx; this._P = P; this.opts = opts;
    this.tracks = new Map(); this.clips = new Map(); this.fxMap = new Map(); this.master = null;
    const self = this;
    this.env = { bpm: () => self.P.bpm };
  }
  /* The live graph always reads the current project object (undo/redo replace it) */
  get P() { return this.opts.offline ? this._P : App.project; }
  chain(list, from, to) {
    const out = [];
    let prev = from;
    for (const fx of list) {
      if (!FX[fx.type]) continue;
      const p = Object.assign(fxDefaults(fx.type), JSON.parse(JSON.stringify(fx.params || {})));
      const inst = FX[fx.type].build(this.ctx, p, this.env);
      inst.p = p;
      // Intensity: crossfade between the untouched signal and the effect's output
      const ctx = this.ctx, xin = ctx.createGain(), xout = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
      const a = clamp(p.intensity ?? 1, 0, 1);
      wet.gain.value = a; dry.gain.value = 1 - a;
      xin.connect(inst.input); inst.output.connect(wet); wet.connect(xout); xin.connect(dry); dry.connect(xout);
      const baseSet = inst.set.bind(inst), baseTargets = inst.targets.bind(inst);
      inst.set = (k, v) => { if (k === 'intensity') { p.intensity = v; setP(ctx, wet.gain, v); setP(ctx, dry.gain, 1 - v); } else baseSet(k, v); };
      inst.targets = k => k === 'intensity' ? [{ param: wet.gain, map: v => v }, { param: dry.gain, map: v => 1 - v }] : baseTargets(k);
      inst.xf = { input: xin, output: xout, wet, dry };
      this.fxMap.set(fx.id, inst);
      out.push({ id: fx.id, type: fx.type, bypass: fx.bypass, inst });
      if (fx.bypass) continue;
      prev.connect(xin); prev = xout;
    }
    prev.connect(to);
    return out;
  }
  build() {
    const ctx = this.ctx, P = this.P, live = !this.opts.offline;
    const m = {};
    m.input = ctx.createGain();
    m.vol = ctx.createGain(); m.vol.gain.value = P.master.vol;
    m.fx = this.chain(P.master.fx || [], m.input, m.vol);
    m.vol.connect(ctx.destination);
    if (live) {
      m.split = ctx.createChannelSplitter(2);
      m.aL = ctx.createAnalyser(); m.aR = ctx.createAnalyser(); m.aL.fftSize = m.aR.fftSize = 1024;
      m.vol.connect(m.split); m.split.connect(m.aL, 0); m.split.connect(m.aR, 1);
    }
    this.master = m;
    for (const t of P.tracks) {
      const n = { id: t.id, sends: new Map() };
      n.input = ctx.createGain();
      n.input.channelCount = 2; n.input.channelCountMode = 'explicit'; n.input.channelInterpretation = 'speakers';
      n.phase = ctx.createGain(); n.phase.gain.value = t.phase ? -1 : 1;
      n.post = ctx.createGain();
      n.vol = ctx.createGain(); n.vol.gain.value = t.vol;
      n.pan = ctx.createStereoPanner(); n.pan.pan.value = t.pan;
      n.mute = ctx.createGain();
      n.input.connect(n.phase);
      n.fx = this.chain(t.fx || [], n.phase, n.post);
      n.post.connect(n.vol); n.vol.connect(n.pan); n.pan.connect(n.mute);
      if (live) { n.an = ctx.createAnalyser(); n.an.fftSize = 1024; n.mute.connect(n.an); }
      this.tracks.set(t.id, n);
      if (t.type === 'audio') for (const c of t.clips) this.clipChain(c, n, t.id);
    }
    for (const t of P.tracks) {
      const n = this.tracks.get(t.id);
      const dest = this.tracks.get(t.output);
      const destT = P.tracks.find(x => x.id === t.output);
      n.mute.connect(dest && dest !== n && destT && destT.type === 'bus' ? dest.input : m.input);
      for (const s of t.sends || []) {
        const b = this.tracks.get(s.target);
        if (!b || b === n) continue;
        const g = ctx.createGain(); g.gain.value = 0;
        (s.pre ? n.post : n.pan).connect(g); g.connect(b.input);
        n.sends.set(s.id, g);
      }
    }
    this.applyMix();
  }
  /* Per-part chain: in → part effects → part volume → part pan → track input */
  clipChain(c, n, trackId) {
    const ctx = this.ctx;
    const ch = { id: c.id, trackId };
    ch.input = ctx.createGain(); ch.input.channelCount = 2; ch.input.channelCountMode = 'explicit'; ch.input.channelInterpretation = 'speakers';
    ch.vol = ctx.createGain();
    ch.pan = ctx.createStereoPanner(); ch.pan.pan.value = c.pan || 0;
    ch.fx = this.chain(c.fx || [], ch.input, ch.vol);
    ch.vol.connect(ch.pan);
    ch.pan.connect(n.input);
    this.clips.set(c.id, ch);
  }
  audibleSet() {
    const P = this.P, solo = this.opts.soloTrack;
    // only used to render one track at a time (stem export); there is no solo button
    const soloed = solo ? P.tracks.filter(t => t.id === solo) : [];
    if (!soloed.length) return null;
    const ok = new Set();
    const walk = id => {
      if (ok.has(id)) return; ok.add(id);
      const t = P.tracks.find(x => x.id === id); if (!t) return;
      if (t.output && t.output !== 'master') walk(t.output);
      for (const s of t.sends || []) walk(s.target);
    };
    soloed.forEach(t => walk(t.id));
    return ok;
  }
  applyMix() {
    const aud = this.audibleSet();
    for (const t of this.P.tracks) {
      const n = this.tracks.get(t.id); if (!n) continue;
      const on = !t.mute && (!aud || aud.has(t.id)) ? 1 : 0;
      n.on = on;
      setP(this.ctx, n.mute.gain, on);
      for (const s of t.sends || []) { const g = n.sends.get(s.id); if (g) setP(this.ctx, g.gain, on * s.amount); }
    }
  }
  fxInst(_trackId, fxId) { return this.fxMap.get(fxId) || null; }
  /* Every curve with points: {pts, toReal, targets, offset, region} */
  curves() {
    const out = [];
    for (const t of this.P.tracks) {
      const n = this.tracks.get(t.id); if (!n) continue;
      for (const key in (t.curves || {})) {
        const pts = t.curves[key]; if (!pts || !pts.length) continue;
        const sp = curveSpec(t, key); if (!sp) continue;
        let targets = [];
        if (key === 'vol') targets = [{ param: n.vol.gain, map: v => v }];
        else if (key === 'pan') targets = [{ param: n.pan.pan, map: v => v }];
        else if (sp.fx && !sp.fx.bypass) { const i = this.fxMap.get(sp.fx.id); if (i) targets = i.targets(sp.param); }
        if (targets.length) out.push({ pts, toReal: sp.toReal, targets, offset: 0, region: null });
      }
      if (t.type !== 'audio') continue;
      for (const c of t.clips) {
        const ch = this.clips.get(c.id); if (!ch || !c.curves) continue;
        for (const sub in c.curves) {
          const pts = c.curves[sub]; if (!pts || !pts.length) continue;
          let targets = [], toReal;
          if (sub === 'gain') { targets = [{ param: ch.vol.gain, map: v => v }]; toReal = posToGain; }
          else if (sub === 'pan') { targets = [{ param: ch.pan.pan, map: v => v }]; toReal = v => v * 2 - 1; }
          else {
            const mm = /^fx:([^:]+):(.+)$/.exec(sub); if (!mm) continue;
            const f = partFx(c, mm[1]); if (!f || f.bypass || !FX[f.type] || !FX[f.type].params[mm[2]]) continue;
            const i = this.fxMap.get(f.id); if (!i) continue;
            targets = i.targets(mm[2]); const spec = FX[f.type].params[mm[2]]; toReal = v => pDenorm(spec, v);
          }
          if (targets.length) out.push({ pts, toReal, targets, offset: c.start, region: [c.start, c.start + c.duration] });
        }
      }
    }
    return out;
  }
  /* Schedule clips for a segment {songStart, songEnd, ctxStart} */
  scheduleClips(seg, getBuf, sources) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    for (const t of this.P.tracks) {
      if (t.type !== 'audio') continue;
      const n = this.tracks.get(t.id); if (!n) continue;
      for (const c of t.clips) {
        if (c.muted) continue;
        const cs = c.start, ce = c.start + c.duration;
        const s = Math.max(cs, seg.songStart), e = Math.min(ce, seg.songEnd);
        if (e - s < 0.003) continue;
        const buf = getBuf(c.mediaId, c.reversed); if (!buf) continue;
        const rate = c.rate || 1;
        let when = seg.ctxStart + (s - seg.songStart);
        let sIn = s;
        if (when < now) { sIn = s + (now - when) + 0.005; when = now + 0.005; if (sIn >= e) continue; }
        const u0 = sIn - cs, u1 = e - cs;
        const srcOff = c.reversed ? (buf.duration - c.offset - c.duration * rate) + u0 * rate : c.offset + u0 * rate;
        if (srcOff >= buf.duration) continue;
        const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
        const g = ctx.createGain();
        const ch = this.clips.get(c.id);
        src.connect(g); g.connect(ch ? ch.input : n.input);
        const gainAt = u => {
          let f = c.gain;
          if (c.fadeIn > 0 && u < c.fadeIn) f *= Math.max(0, u / c.fadeIn);
          if (c.fadeOut > 0 && u > c.duration - c.fadeOut) f *= Math.max(0, (c.duration - u) / c.fadeOut);
          return f;
        };
        const T = u => when + (u - u0);
        const cutIn = u0 > 0.002 && !(c.fadeIn > 0 && u0 < c.fadeIn);
        if (cutIn) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(gainAt(u0 + 0.004), T(u0 + 0.004)); }
        else g.gain.setValueAtTime(gainAt(u0), when);
        if (c.fadeIn > 0 && c.fadeIn > u0 && c.fadeIn < u1) g.gain.linearRampToValueAtTime(gainAt(c.fadeIn), T(c.fadeIn));
        const foStart = c.duration - c.fadeOut;
        if (c.fadeOut > 0 && foStart > u0 && foStart < u1) { g.gain.setValueAtTime(gainAt(foStart), T(foStart)); }
        const cutOut = u1 < c.duration - 0.002;
        if (cutOut) {
          const ue = Math.max(u0, u1 - 0.004);
          g.gain.linearRampToValueAtTime(gainAt(ue), T(ue));
          g.gain.linearRampToValueAtTime(0, T(u1));
        } else g.gain.linearRampToValueAtTime(gainAt(u1), T(u1));
        const dur = (u1 - u0) * rate;
        try { src.start(when, Math.max(0, srcOff), dur); src.stop(T(u1) + 0.02); } catch (err) { console.warn(err); continue; }
        sources.push({ src, g, trackId: t.id, clipId: c.id, end: T(u1) + 0.02 });
      }
    }
  }
  scheduleAutomation(seg, fromCtx, first) {
    const s0 = seg.songStart + Math.max(0, fromCtx - seg.ctxStart);
    const atCtx = s => seg.ctxStart + (s - seg.songStart);
    for (const cv of this.curves()) {
      const { pts, toReal, targets, offset, region } = cv;
      const val = s => toReal(valueAt(pts, s - offset));
      if (first) for (const { param, map } of targets) { param.cancelScheduledValues(0); param.setValueAtTime(map(val(clamp(s0, region ? region[0] : 0, region ? region[1] : Infinity))), Math.max(this.ctx.currentTime, 0)); }
      let a = s0, b = seg.songEnd;
      if (region) { a = Math.max(a, region[0]); b = Math.min(b, region[1]); }
      if (!(b > a) || a >= seg.songEnd) continue;
      for (const { param, map } of targets) {
        param.setValueAtTime(map(val(a)), atCtx(a));
        for (const p of pts) {
          const at = offset + p.t;
          if (at <= a) continue;
          if (at >= b) break;
          param.linearRampToValueAtTime(map(toReal(p.v)), atCtx(at));
        }
        if (isFinite(b)) param.linearRampToValueAtTime(map(val(b)), Math.max(atCtx(a) + 0.0005, atCtx(b) - 0.002));
      }
    }
  }
  /* Static (non-playing) parameter values: curve value at position, else stored value */
  applyStatic(pos, playing) {
    const ctx = this.ctx;
    const setFx = (f, data, curveOf) => {
      for (const k in data.params) {
        const pts = curveOf(k);
        if (pts && pts.length) {
          if (playing) continue;
          const v = pDenorm(FX[f.type].params[k], valueAt(pts.pts, pts.at));
          for (const tg of f.inst.targets(k)) tg.param.cancelScheduledValues(0);
          f.inst.set(k, v);
        } else if (f.inst.p[k] !== data.params[k]) f.inst.set(k, data.params[k]);
      }
    };
    const curveParam = (param, pts, at, toReal, fallback) => {
      if (pts && pts.length) { if (playing) return; param.cancelScheduledValues(0); setP(ctx, param, toReal(valueAt(pts, at))); }
      else setP(ctx, param, fallback);
    };
    for (const t of this.P.tracks) {
      const n = this.tracks.get(t.id); if (!n) continue;
      const cv = t.curves || {};
      setP(ctx, n.phase.gain, t.phase ? -1 : 1);
      curveParam(n.vol.gain, cv.vol, pos, posToGain, t.vol);
      curveParam(n.pan.pan, cv.pan, pos, v => v * 2 - 1, t.pan);
      for (const f of n.fx) {
        const data = (t.fx || []).find(x => x.id === f.id); if (!data) continue;
        setFx(f, data, k => { const p = cv[`fx:${f.id}:${k}`]; return p && p.length ? { pts: p, at: pos, length: p.length } : null; });
      }
      if (t.type !== 'audio') continue;
      for (const c of t.clips) {
        const ch = this.clips.get(c.id); if (!ch) continue;
        const cc = c.curves || {}, rel = clamp(pos - c.start, 0, c.duration);
        curveParam(ch.vol.gain, cc.gain, rel, posToGain, 1);
        curveParam(ch.pan.pan, cc.pan, rel, v => v * 2 - 1, c.pan || 0);
        for (const f of ch.fx) {
          const data = (c.fx || []).find(x => x.id === f.id); if (!data) continue;
          setFx(f, data, k => { const p = cc[`fx:${fxLink(data)}:${k}`]; return p && p.length ? { pts: p, at: rel, length: p.length } : null; });
        }
      }
    }
    setP(ctx, this.master.vol.gain, this.P.master.vol);
    for (const f of this.master.fx) {
      const data = (this.P.master.fx || []).find(x => x.id === f.id); if (!data) continue;
      for (const k in data.params) if (f.inst.p[k] !== data.params[k]) f.inst.set(k, data.params[k]);
    }
    this.applyMix();
  }
  allFx() { return [...this.fxMap.values()]; }
  transport(on, when) { for (const i of this.allFx()) if (i.transport) i.transport(on, when); }
  tempo() { for (const i of this.allFx()) if (i.tempo) i.tempo(); }
  dispose() {
    for (const i of this.allFx()) { try { i.dispose(); } catch (e) { /* */ } }
    const all = [this.master.input, this.master.vol, this.master.split];
    for (const n of this.tracks.values()) all.push(n.input, n.phase, n.post, n.vol, n.pan, n.mute, ...n.sends.values());
    for (const ch of this.clips.values()) all.push(ch.input, ch.vol, ch.pan);
    for (const i of this.allFx()) all.push(i.input, i.output, i.xf && i.xf.input, i.xf && i.xf.output, i.xf && i.xf.wet, i.xf && i.xf.dry);
    for (const x of all) { if (x) try { x.disconnect(); } catch (e) { /* */ } }
  }
}

function computePeaks(buf) {
  const B = 256, len = buf.length, n = Math.ceil(len / B);
  const out = new Float32Array(n * 2);
  const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  const k = 1 / chs.length;
  let peak = 0;
  for (let b = 0; b < n; b++) {
    let mn = 1, mx = -1;
    const e = Math.min(len, (b + 1) * B);
    for (let i = b * B; i < e; i++) {
      let s = 0; for (let c = 0; c < chs.length; c++) s += chs[c][i];
      s *= k;
      if (s < mn) mn = s; if (s > mx) mx = s;
    }
    out[b * 2] = mn; out[b * 2 + 1] = mx;
    if (-mn > peak) peak = -mn; if (mx > peak) peak = mx;
  }
  return { data: out, block: B, sr: buf.sampleRate, n, peak };
}

const Engine = {
  ctx: null, graph: null, buffers: new Map(), revBuffers: new Map(), peaks: new Map(),
  playing: false, pos: 0, playFrom: 0, segments: [], sources: [], timer: null, lastClick: 0,
  gsig: '', csig: '', meterBuf: null, previewSrc: null,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { this.ctx = new AC(); }
    this.meterBuf = new Float32Array(1024);
    this.metroGain = this.ctx.createGain(); this.metroGain.connect(this.ctx.destination);
  },
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => { }); },
  async decode(id, arrayBuffer) {
    const buf = await new Promise((res, rej) => {
      const p = this.ctx.decodeAudioData(arrayBuffer, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    this.buffers.set(id, buf);
    this.peaks.set(id, computePeaks(buf));
    return buf;
  },
  getBuffer(id, reversed) {
    const b = this.buffers.get(id); if (!b || !reversed) return b || null;
    let r = this.revBuffers.get(id);
    if (!r) {
      r = this.ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
      for (let c = 0; c < b.numberOfChannels; c++) { const s = b.getChannelData(c), d = r.getChannelData(c); for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i]; }
      this.revBuffers.set(id, r);
    }
    return r;
  },
  forget(id) { this.buffers.delete(id); this.revBuffers.delete(id); this.peaks.delete(id); },
  sigs(P) {
    const fxs = l => (l || []).map(f => [f.id, f.type, f.bypass]);
    const g = JSON.stringify([
      P.tracks.map(t => [t.id, t.type, t.output, fxs(t.fx), (t.sends || []).map(s => [s.id, s.target, s.pre]), t.type === 'audio' ? t.clips.map(c => [c.id, fxs(c.fx)]) : 0]),
      fxs(P.master.fx),
    ]);
    const c = JSON.stringify([P.bpm, P.loop, P.tracks.map(t => [t.id, t.curves, t.clips.map(c => [c.id, c.mediaId, c.start, c.offset, c.duration, c.gain, c.fadeIn, c.fadeOut, c.rate, c.reversed, c.muted, c.curves])])]);
    return [g, c];
  },
  /* Bring the live graph in line with the project. Cheap when nothing structural changed. */
  sync() {
    if (!this.ctx || !App.project) return;
    const P = App.project;
    const [g, c] = this.sigs(P);
    const tempoChanged = this.graph && this.lastBpm !== P.bpm;
    this.lastBpm = P.bpm;
    if (!this.graph || g !== this.gsig || this.project !== P) { this.project = P; this.gsig = g; this.rebuild(); }
    else this.graph.applyStatic(this.time(), this.playing);
    if (tempoChanged) this.graph.tempo();
    if (c !== this.csig) { this.csig = c; if (this.playing) this.play(this.time()); }
  },
  rebuild() {
    const old = this.graph;
    this.graph = new Graph(this.ctx, App.project);
    this.graph.build();
    this.graph.transport(this.playing, this.ctx.currentTime);
    if (this.playing) {
      for (const s of this.sources) {
        try {
          s.g.disconnect();
          const ch = this.graph.clips.get(s.clipId), n = this.graph.tracks.get(s.trackId);
          if (ch) s.g.connect(ch.input); else if (n) s.g.connect(n.input);
        } catch (e) { /* */ }
      }
      const now = this.ctx.currentTime;
      let first = true;
      for (const seg of this.segments) {
        if (seg.ctxStart + (seg.songEnd - seg.songStart) <= now) continue;
        this.graph.scheduleAutomation(seg, Math.max(now + 0.01, seg.ctxStart), first); first = false;
      }
    } else this.graph.applyStatic(this.pos, false);
    if (old) old.dispose();
  },
  songEnd() {
    let e = 0;
    for (const t of App.project.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.duration);
    return e;
  },
  time() {
    if (!this.playing) return this.pos;
    const ctx = this.ctx;
    const t = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    let seg = this.segments[0];
    for (const s of this.segments) if (s.ctxStart <= t) seg = s;
    if (!seg) return this.pos;
    return clamp(seg.songStart + (t - seg.ctxStart), seg.songStart, seg.songEnd);
  },
  play(from) {
    this.init(); this.resume();
    if (this.playing) this.stopSources();
    if (from == null) from = this.pos;
    from = Math.max(0, from);
    if (!this.graph || this.project !== App.project) this.sync();
    const P = App.project, ctx = this.ctx;
    const t0 = ctx.currentTime + 0.04;
    const L = P.loop;
    const looping = L.enabled && L.end - L.start > 0.05 && from < L.end;
    if (!this.playing) this.playFrom = from;
    this.playing = true;
    this.segments = [{ songStart: from, songEnd: looping ? L.end : Infinity, ctxStart: t0 }];
    this.lastClick = t0 - 1;
    this.graph.scheduleClips(this.segments[0], (id, r) => this.getBuffer(id, r), this.sources);
    this.graph.scheduleAutomation(this.segments[0], t0, true);
    this.graph.transport(true, t0);
    this.tick();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 25);
    App.emit('transport');
  },
  tick() {
    if (!this.playing) return;
    const ctx = this.ctx, P = App.project, ahead = ctx.currentTime + 0.35;
    const L = P.loop;
    let last = this.segments[this.segments.length - 1];
    if (L.enabled && isFinite(last.songEnd)) {
      let guard = 0;
      while (last.ctxStart + (last.songEnd - last.songStart) < ahead && guard++ < 8) {
        const seg = { songStart: L.start, songEnd: L.end, ctxStart: last.ctxStart + (last.songEnd - last.songStart) };
        this.segments.push(seg);
        this.graph.scheduleClips(seg, (id, r) => this.getBuffer(id, r), this.sources);
        this.graph.scheduleAutomation(seg, seg.ctxStart, false);
        last = seg;
      }
    }
    const now = ctx.currentTime;
    while (this.segments.length > 2 && this.segments[1].ctxStart + (this.segments[1].songEnd - this.segments[1].songStart) < now - 1) this.segments.shift();
    if (this.sources.length > 64) this.sources = this.sources.filter(s => s.end > now);
  },
  stopSources() {
    for (const s of this.sources) { try { s.src.stop(); } catch (e) { /* */ } try { s.g.disconnect(); } catch (e) { /* */ } }
    this.sources = [];
  },
  pause() {
    if (!this.playing) return;
    this.pos = this.time();
    this.playing = false;
    clearInterval(this.timer);
    this.stopSources();
    this.cutTails();
    App.emit('transport');
  },
  /* Silence reverb and delay tails on pause: fade the old graph out and swap in a fresh one */
  cutTails() {
    const old = this.graph; if (!old) return;
    const now = this.ctx.currentTime, gp = old.master.vol.gain;
    try { gp.cancelScheduledValues(now); gp.setValueAtTime(gp.value, now); gp.linearRampToValueAtTime(0, now + 0.03); } catch (e) { /* */ }
    this.graph = new Graph(this.ctx, App.project);
    this.graph.build();
    this.graph.applyStatic(this.pos, false);
    setTimeout(() => old.dispose(), 120);
    App.emit('graph');
  },
  toggle() { this.playing ? this.pause() : this.play(); },
  stop() {
    if (this.playing) { this.pause(); this.pos = this.playFrom; }
    else this.pos = this.pos === this.playFrom ? 0 : (this.pos > 0 && this.playFrom > 0 && this.pos !== this.playFrom ? this.playFrom : 0);
    if (this.graph) this.graph.applyStatic(this.pos, false);
    App.emit('transport'); App.emit('seek');
  },
  seek(t) {
    t = Math.max(0, t);
    if (this.playing) { this.playFrom = t; this.play(t); }
    else { this.pos = t; if (this.graph) this.graph.applyStatic(t, false); }
    App.emit('seek');
  },
  peak(an) {
    if (!an) return 0;
    an.getFloatTimeDomainData(this.meterBuf);
    let m = 0; const b = this.meterBuf;
    for (let i = 0; i < b.length; i++) { const v = b[i] < 0 ? -b[i] : b[i]; if (v > m) m = v; }
    return m;
  },
  trackPeak(id) { const n = this.graph && this.graph.tracks.get(id); return n ? this.peak(n.an) : 0; },
  masterPeaks() { if (!this.graph) return [0, 0]; return [this.peak(this.graph.master.aL), this.peak(this.graph.master.aR)]; },
  /* Live parameter setters (no re-sync needed) */
  setTrackParam(t, k) {
    if (!this.graph) return;
    const n = this.graph.tracks.get(t.id); if (!n) return;
    if (k === 'vol' && !trackAutomated(t, 'vol')) setP(this.ctx, n.vol.gain, t.vol);
    if (k === 'pan' && !trackAutomated(t, 'pan')) setP(this.ctx, n.pan.pan, t.pan);
    if (k === 'phase') setP(this.ctx, n.phase.gain, t.phase ? -1 : 1);
    if (k === 'mix') this.graph.applyMix();
  },
  setClipPan(c) {
    const ch = this.graph && this.graph.clips.get(c.id);
    if (ch && !(c.curves && c.curves.pan && c.curves.pan.length)) setP(this.ctx, ch.pan.pan, c.pan || 0);
  },
  setSend(t, s) {
    if (!this.graph) return;
    const n = this.graph.tracks.get(t.id); const g = n && n.sends.get(s.id);
    if (g) setP(this.ctx, g.gain, (n.on ?? 1) * s.amount);
  },
  setMasterVol(v) { if (this.graph) setP(this.ctx, this.graph.master.vol.gain, v); },
  setFxParam(_trackId, fxId, k, v) {
    if (!this.graph) return;
    const o = fxOwner(fxId);
    if (o && this.playing) {
      const pts = o.clip ? (o.clip.curves || {})[`fx:${fxLink(o.fx)}:${k}`] : o.track && (o.track.curves || {})[`fx:${fxId}:${k}`];
      if (pts && pts.length) return;
    }
    const inst = this.graph.fxMap.get(fxId);
    if (inst) inst.set(k, v);
  },
  previewMedia(id, onEnd) {
    this.init(); this.resume(); this.stopPreview();
    const buf = this.buffers.get(id); if (!buf) return;
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.ctx.destination);
    s.onended = () => { if (this.previewSrc === s) { this.previewSrc = null; onEnd && onEnd(); } };
    s.start(); this.previewSrc = s;
  },
  stopPreview() { if (this.previewSrc) { const s = this.previewSrc; this.previewSrc = null; try { s.stop(); } catch (e) { /* */ } } },
  /* Offline render of [start, end) with optional tail; soloTrack renders a stem */
  async render({ start, end, tail = 0, sampleRate, soloTrack, onProgress }) {
    const P = App.project;
    const sr = sampleRate || this.ctx.sampleRate;
    const len = Math.max(1, Math.ceil((end - start + tail) * sr));
    const octx = new OfflineAudioContext(2, len, sr);
    const g = new Graph(octx, P, { offline: true, soloTrack });
    g.build();
    g.applyStatic(start, true);
    g.transport(true, 0);
    const seg = { songStart: start, songEnd: end, ctxStart: 0 };
    g.scheduleClips(seg, (id, r) => this.getBuffer(id, r), []);
    g.scheduleAutomation(seg, 0, true);
    if (onProgress && octx.suspend) {
      const total = len / sr;
      for (let i = 1; i < 10; i++) {
        const at = Math.floor(total * i / 10 * sr / 128) * 128 / sr;
        if (at <= 0 || at >= total) continue;
        octx.suspend(at).then(() => { onProgress(i / 10); octx.resume(); }).catch(() => { });
      }
    }
    const out = await octx.startRendering();
    onProgress && onProgress(1);
    g.dispose();
    return out;
  },
};
