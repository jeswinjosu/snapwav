/* ================= Effects (code-only, no bundled samples) ================= */
const NOTE_DIVS = { '1/16': 0.25, '1/8T': 1 / 3, '1/8': 0.5, '1/8.': 0.75, '1/4T': 2 / 3, '1/4': 1, '1/4.': 1.5, '1/2': 2, '1 bar': 4 };

function fmtParam(spec, v) {
  switch (spec.unit) {
    case 's': return v.toFixed(v < 10 ? 2 : 1) + ' s';
    case 'ms': return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms';
    case 'Hz': return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : (v < 10 ? v.toFixed(2) : Math.round(v)) + ' Hz';
    case 'dB': return (v > 0.05 ? '+' : '') + v.toFixed(1) + ' dB';
    case '%': return Math.round(v * 100) + '%';
    case 'ratio': return v.toFixed(1) + ':1';
    case 'bit': return Math.round(v) + ' bit';
    case 'q': return v.toFixed(2);
    default: return String(Math.round(v * 100) / 100);
  }
}
function pNorm(spec, v) {
  if (spec.curve === 'log') return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  return (v - spec.min) / (spec.max - spec.min);
}
function pDenorm(spec, n) {
  n = clamp(n, 0, 1);
  let v = spec.curve === 'log' ? spec.min * Math.pow(spec.max / spec.min, n) : spec.min + n * (spec.max - spec.min);
  if (spec.step) v = Math.round(v / spec.step) * spec.step;
  return v;
}

function setP(ctx, param, v) {
  if (!isFinite(v)) return;
  if (ctx instanceof OfflineAudioContext || ctx.state !== 'running') { param.value = v; return; }
  param.setTargetAtTime(v, ctx.currentTime, 0.012);
}
const mixDry = m => Math.cos(clamp(m, 0, 1) * Math.PI / 2);
const mixWet = m => Math.sin(clamp(m, 0, 1) * Math.PI / 2);
function wetDry(ctx, m) {
  const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
  input.connect(dry); dry.connect(output); wet.connect(output);
  dry.gain.value = mixDry(m); wet.gain.value = mixWet(m);
  return { input, output, dry, wet, mixTargets: [{ param: dry.gain, map: mixDry }, { param: wet.gain, map: mixWet }] };
}

function makeIR(ctx, seconds, damp) {
  const sr = ctx.sampleRate, len = Math.max(64, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const aEnd = 1 - clamp(damp, 0, 1) * 0.94;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0, sum = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const a = lerp(0.95, aEnd, Math.sqrt(t));
      lp += a * ((Math.random() * 2 - 1) - lp);
      const env = Math.pow(10, -3 * t) * Math.min(1, i / (sr * 0.004));
      d[i] = lp * env; sum += d[i] * d[i];
    }
    const k = 1 / Math.sqrt(sum || 1);
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return buf;
}
function makeNoise(ctx) {
  const sr = ctx.sampleRate, len = sr * 3, buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      let v = (b0 + b1 + b2 + w * 0.1848) * 0.06;
      if (Math.random() < 0.00012) v += (Math.random() * 2 - 1) * 0.9; // crackle
      d[i] = v;
    }
  }
  return buf;
}
function crushCurve(bits) {
  if (bits >= 15.5) return null;
  const n = 8193, steps = Math.pow(2, bits - 1), c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
  return c;
}
function satCurve(drive) {
  if (drive <= 0.001) return null;
  const k = 1 + drive * 9, n = 2049, c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  return c;
}
function distCurve(mode) {
  const n = 4097, c = new Float32Array(n);
  const f = x => {
    if (mode === 'Hard') return clamp(x * 2.2, -0.85, 0.85) / 0.85;
    if (mode === 'Fuzz') return Math.sign(x + 0.08) * (1 - Math.exp(-7 * Math.abs(x + 0.08)));
    if (mode === 'Fold') return Math.sin(x * Math.PI * 1.9);
    return Math.tanh(x * 2.6) / Math.tanh(2.6);
  };
  const z = f(0); // keep silence silent: no DC offset at zero input
  for (let i = 0; i < n; i++) c[i] = f(i / (n - 1) * 2 - 1) - z;
  return c;
}
/* |x| for envelope following (odd length so 0 maps exactly to 0) */
const RECT_CURVE = (() => { const n = 1025, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.abs(i / (n - 1) * 2 - 1); return c; })();

const FX = {
  reverb: {
    name: 'Reverb', icon: 'church', color: '#818CF8', desc: 'Rooms, halls and long ambient tails',
    params: {
      decay: { label: 'Decay', min: 0.3, max: 10, def: 2, unit: 's', curve: 'log', auto: false },
      predelay: { label: 'Pre-delay', min: 0, max: 250, def: 12, unit: 'ms' },
      damp: { label: 'Damping', min: 0, max: 1, def: 0.45, unit: '%', auto: false },
      lowcut: { label: 'Low cut', min: 20, max: 1000, def: 120, unit: 'Hz', curve: 'log' },
      mix: { label: 'Mix', min: 0, max: 1, def: 0.3, unit: '%' },
    },
    presets: {
      Room: { decay: 0.7, predelay: 4, damp: 0.55, lowcut: 150, mix: 0.22 },
      Hall: { decay: 2.6, predelay: 22, damp: 0.45, lowcut: 120, mix: 0.3 },
      Plate: { decay: 1.6, predelay: 0, damp: 0.2, lowcut: 200, mix: 0.28 },
      Cathedral: { decay: 6.5, predelay: 40, damp: 0.5, lowcut: 90, mix: 0.35 },
      Ambient: { decay: 9.5, predelay: 60, damp: 0.7, lowcut: 250, mix: 0.5 },
    },
    build(ctx, p) {
      const w = wetDry(ctx, p.mix);
      const pre = ctx.createDelay(1); pre.delayTime.value = p.predelay / 1000;
      const conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = makeIR(ctx, p.decay, p.damp);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.lowcut; hp.Q.value = 0.7;
      w.input.connect(pre); pre.connect(conv); conv.connect(hp); hp.connect(w.wet);
      const regen = ctx instanceof OfflineAudioContext ? (fn => fn()) : debounce(fn => fn(), 140);
      return {
        input: w.input, output: w.output,
        set(k, v) {
          p[k] = v;
          if (k === 'decay' || k === 'damp') regen(() => { conv.buffer = makeIR(ctx, p.decay, p.damp); });
          else if (k === 'predelay') setP(ctx, pre.delayTime, v / 1000);
          else if (k === 'lowcut') setP(ctx, hp.frequency, v);
          else if (k === 'mix') { setP(ctx, w.dry.gain, mixDry(v)); setP(ctx, w.wet.gain, mixWet(v)); }
        },
        targets(k) {
          if (k === 'predelay') return [{ param: pre.delayTime, map: v => v / 1000 }];
          if (k === 'lowcut') return [{ param: hp.frequency, map: v => v }];
          if (k === 'mix') return w.mixTargets;
          return [];
        },
        dispose() { },
      };
    },
  },

  delay: {
    name: 'Delay', icon: 'repeat-2', color: '#38BDF8', desc: 'Echoes and ping-pong, free or synced',
    params: {
      sync: { label: 'Sync', type: 'select', options: ['Free', '1/16', '1/8T', '1/8', '1/8.', '1/4T', '1/4', '1/4.', '1/2', '1 bar'], def: '1/8.' },
      time: { label: 'Time', min: 1, max: 2000, def: 350, unit: 'ms', curve: 'log' },
      feedback: { label: 'Feedback', min: 0, max: 0.95, def: 0.38, unit: '%' },
      tone: { label: 'Tone', min: 300, max: 16000, def: 5000, unit: 'Hz', curve: 'log' },
      pingpong: { label: 'Ping-pong', type: 'bool', def: false },
      mix: { label: 'Mix', min: 0, max: 1, def: 0.3, unit: '%' },
    },
    presets: {
      Slapback: { sync: 'Free', time: 95, feedback: 0.1, tone: 7000, pingpong: false, mix: 0.25 },
      'Dotted 8th': { sync: '1/8.', feedback: 0.4, tone: 5000, pingpong: false, mix: 0.3 },
      'Ping-pong': { sync: '1/8', feedback: 0.5, tone: 4500, pingpong: true, mix: 0.35 },
      'Dub tail': { sync: '1/4', feedback: 0.78, tone: 1800, pingpong: true, mix: 0.4 },
      'Quarter': { sync: '1/4', feedback: 0.3, tone: 9000, pingpong: false, mix: 0.25 },
    },
    build(ctx, p, env) {
      const w = wetDry(ctx, p.mix);
      const dL = ctx.createDelay(4), dR = ctx.createDelay(4);
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = p.tone; tone.Q.value = 0.5;
      const fb = ctx.createGain(); fb.gain.value = p.feedback;
      const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
      const merger = ctx.createChannelMerger(2);
      const secs = () => p.sync && p.sync !== 'Free' ? (60 / env.bpm()) * NOTE_DIVS[p.sync] : p.time / 1000;
      const setTime = () => { const s = clamp(secs(), 0.001, 3.9); setP(ctx, dL.delayTime, s); setP(ctx, dR.delayTime, s); };
      dL.delayTime.value = dR.delayTime.value = clamp(secs(), 0.001, 3.9);
      let wired = null;
      function wire(pp) {
        if (wired === pp) return;
        [mono, dL, dR, tone, fb, merger].forEach(n => { try { n.disconnect(); } catch (e) { /* not connected */ } });
        try { w.input.disconnect(); } catch (e) { /* */ }
        w.input.connect(w.dry);
        if (pp) {
          w.input.connect(mono); mono.connect(dL); dL.connect(tone);
          tone.connect(merger, 0, 0); tone.connect(dR); dR.connect(merger, 0, 1); dR.connect(fb); fb.connect(dL);
          merger.connect(w.wet);
        } else {
          w.input.connect(dL); dL.connect(tone); tone.connect(fb); fb.connect(dL); tone.connect(w.wet);
        }
        wired = pp;
      }
      wire(!!p.pingpong);
      return {
        input: w.input, output: w.output,
        set(k, v) {
          p[k] = v;
          if (k === 'time' || k === 'sync') setTime();
          else if (k === 'feedback') setP(ctx, fb.gain, v);
          else if (k === 'tone') setP(ctx, tone.frequency, v);
          else if (k === 'pingpong') wire(!!v);
          else if (k === 'mix') { setP(ctx, w.dry.gain, mixDry(v)); setP(ctx, w.wet.gain, mixWet(v)); }
        },
        tempo() { setTime(); },
        targets(k) {
          if (k === 'time') return p.sync === 'Free' ? [{ param: dL.delayTime, map: v => v / 1000 }, { param: dR.delayTime, map: v => v / 1000 }] : [];
          if (k === 'feedback') return [{ param: fb.gain, map: v => v }];
          if (k === 'tone') return [{ param: tone.frequency, map: v => v }];
          if (k === 'mix') return w.mixTargets;
          return [];
        },
        dispose() { },
      };
    },
  },

  lofi: {
    name: 'Lo-Fi', icon: 'cassette-tape', color: '#FACC15', desc: 'Bit crush, tape wobble, hiss and crackle',
    params: {
      bits: { label: 'Bit depth', min: 3, max: 16, def: 10, unit: 'bit', step: 1, auto: false },
      drive: { label: 'Saturation', min: 0, max: 1, def: 0.25, unit: '%', auto: false },
      tone: { label: 'Bandwidth', min: 500, max: 16000, def: 6500, unit: 'Hz', curve: 'log' },
      lowcut: { label: 'Low cut', min: 20, max: 1500, def: 80, unit: 'Hz', curve: 'log' },
      wow: { label: 'Wow', min: 0, max: 1, def: 0.25, unit: '%' },
      flutter: { label: 'Flutter', min: 0, max: 1, def: 0.2, unit: '%' },
      noise: { label: 'Noise', min: 0, max: 1, def: 0.15, unit: '%' },
      mix: { label: 'Mix', min: 0, max: 1, def: 1, unit: '%' },
    },
    presets: {
      Cassette: { bits: 12, drive: 0.3, tone: 7500, lowcut: 60, wow: 0.35, flutter: 0.3, noise: 0.18, mix: 1 },
      Vinyl: { bits: 14, drive: 0.15, tone: 9000, lowcut: 50, wow: 0.15, flutter: 0.05, noise: 0.4, mix: 1 },
      '8-bit': { bits: 5, drive: 0, tone: 12000, lowcut: 30, wow: 0, flutter: 0, noise: 0, mix: 1 },
      'AM radio': { bits: 9, drive: 0.55, tone: 3200, lowcut: 450, wow: 0.05, flutter: 0.1, noise: 0.22, mix: 1 },
      Dusty: { bits: 8, drive: 0.4, tone: 4800, lowcut: 120, wow: 0.5, flutter: 0.4, noise: 0.3, mix: 0.75 },
    },
    build(ctx, p) {
      const w = wetDry(ctx, p.mix);
      const sat = ctx.createWaveShaper(); sat.curve = satCurve(p.drive); sat.oversample = '2x';
      const crush = ctx.createWaveShaper(); crush.curve = crushCurve(p.bits);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.tone; lp.Q.value = 0.6;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.lowcut; hp.Q.value = 0.6;
      const wob = ctx.createDelay(0.1); wob.delayTime.value = 0.008;
      const wowOsc = ctx.createOscillator(); wowOsc.frequency.value = 0.55;
      const wowG = ctx.createGain(); wowG.gain.value = p.wow * 0.0028;
      const flOsc = ctx.createOscillator(); flOsc.frequency.value = 7.3;
      const flG = ctx.createGain(); flG.gain.value = p.flutter * 0.00035;
      wowOsc.connect(wowG); wowG.connect(wob.delayTime); flOsc.connect(flG); flG.connect(wob.delayTime);
      wowOsc.start(); flOsc.start();
      // Hiss and crackle follow the input level, so silence stays silent
      const noise = ctx.createBufferSource(); noise.buffer = makeNoise(ctx); noise.loop = true;
      const nG = ctx.createGain(); nG.gain.value = 0;
      const rect = ctx.createWaveShaper(); rect.curve = RECT_CURVE;
      const envLP = ctx.createBiquadFilter(); envLP.type = 'lowpass'; envLP.frequency.value = 9; envLP.Q.value = 0.5;
      const envAmt = ctx.createGain();
      const nLevel = () => p.noise * 3.2;
      envAmt.gain.value = nLevel();
      w.input.connect(rect); rect.connect(envLP); envLP.connect(envAmt); envAmt.connect(nG.gain);
      noise.connect(nG); nG.connect(lp); noise.start();
      w.input.connect(sat); sat.connect(crush); crush.connect(lp); lp.connect(hp); hp.connect(wob); wob.connect(w.wet);
      return {
        input: w.input, output: w.output,
        set(k, v) {
          p[k] = v;
          if (k === 'bits') crush.curve = crushCurve(v);
          else if (k === 'drive') sat.curve = satCurve(v);
          else if (k === 'tone') setP(ctx, lp.frequency, v);
          else if (k === 'lowcut') setP(ctx, hp.frequency, v);
          else if (k === 'wow') setP(ctx, wowG.gain, v * 0.0028);
          else if (k === 'flutter') setP(ctx, flG.gain, v * 0.00035);
          else if (k === 'noise') setP(ctx, envAmt.gain, nLevel());
          else if (k === 'mix') { setP(ctx, w.dry.gain, mixDry(v)); setP(ctx, w.wet.gain, mixWet(v)); }
        },
        targets(k) {
          if (k === 'tone') return [{ param: lp.frequency, map: v => v }];
          if (k === 'lowcut') return [{ param: hp.frequency, map: v => v }];
          if (k === 'wow') return [{ param: wowG.gain, map: v => v * 0.0028 }];
          if (k === 'flutter') return [{ param: flG.gain, map: v => v * 0.00035 }];
          if (k === 'noise') return [{ param: envAmt.gain, map: v => v * 3.2 }];
          if (k === 'mix') return w.mixTargets;
          return [];
        },
        dispose() { try { wowOsc.stop(); flOsc.stop(); noise.stop(); } catch (e) { /* */ } },
      };
    },
  },

  eq: {
    name: 'EQ', icon: 'chart-column', color: '#4ADE80', desc: 'Three-band tone shaping with low cut',
    params: {
      lowcut: { label: 'Low cut', min: 20, max: 1000, def: 20, unit: 'Hz', curve: 'log' },
      lowGain: { label: 'Low', min: -15, max: 15, def: 0, unit: 'dB' },
      lowFreq: { label: 'Low freq', min: 40, max: 600, def: 120, unit: 'Hz', curve: 'log' },
      midGain: { label: 'Mid', min: -15, max: 15, def: 0, unit: 'dB' },
      midFreq: { label: 'Mid freq', min: 150, max: 8000, def: 1000, unit: 'Hz', curve: 'log' },
      midQ: { label: 'Mid width', min: 0.3, max: 8, def: 1, unit: 'q', curve: 'log' },
      highGain: { label: 'High', min: -15, max: 15, def: 0, unit: 'dB' },
      highFreq: { label: 'High freq', min: 1500, max: 16000, def: 8000, unit: 'Hz', curve: 'log' },
    },
    presets: {
      Flat: { lowcut: 20, lowGain: 0, lowFreq: 120, midGain: 0, midFreq: 1000, midQ: 1, highGain: 0, highFreq: 8000 },
      'Vocal presence': { lowcut: 90, lowGain: -2, lowFreq: 200, midGain: 3, midFreq: 3000, midQ: 1, highGain: 2.5, highFreq: 10000 },
      Warm: { lowcut: 30, lowGain: 3, lowFreq: 150, midGain: -1.5, midFreq: 2500, midQ: 0.8, highGain: -3, highFreq: 8000 },
      Bright: { lowcut: 40, lowGain: 0, lowFreq: 120, midGain: 1, midFreq: 4000, midQ: 0.7, highGain: 5, highFreq: 7000 },
      Telephone: { lowcut: 400, lowGain: 0, lowFreq: 120, midGain: 6, midFreq: 1500, midQ: 1.2, highGain: -15, highFreq: 3500 },
      'Bass cut': { lowcut: 180, lowGain: 0, lowFreq: 120, midGain: 0, midFreq: 1000, midQ: 1, highGain: 0, highFreq: 8000 },
    },
    build(ctx, p) {
      const input = ctx.createGain();
      const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.Q.value = 0.707;
      const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf';
      const mid = ctx.createBiquadFilter(); mid.type = 'peaking';
      const hi = ctx.createBiquadFilter(); hi.type = 'highshelf';
      hpf.frequency.value = p.lowcut; lo.gain.value = p.lowGain; lo.frequency.value = p.lowFreq;
      mid.gain.value = p.midGain; mid.frequency.value = p.midFreq; mid.Q.value = p.midQ;
      hi.gain.value = p.highGain; hi.frequency.value = p.highFreq;
      input.connect(hpf); hpf.connect(lo); lo.connect(mid); mid.connect(hi);
      const map = { lowcut: hpf.frequency, lowGain: lo.gain, lowFreq: lo.frequency, midGain: mid.gain, midFreq: mid.frequency, midQ: mid.Q, highGain: hi.gain, highFreq: hi.frequency };
      return {
        input, output: hi,
        set(k, v) { p[k] = v; if (map[k]) setP(ctx, map[k], v); },
        targets(k) { return map[k] ? [{ param: map[k], map: v => v }] : []; },
        filters: [hpf, lo, mid, hi],
        dispose() { },
      };
    },
  },

  comp: {
    name: 'Compressor', icon: 'shrink', color: '#FB923C', desc: 'Even out levels, add punch',
    params: {
      threshold: { label: 'Threshold', min: -60, max: 0, def: -20, unit: 'dB' },
      ratio: { label: 'Ratio', min: 1, max: 20, def: 4, unit: 'ratio', curve: 'log' },
      attack: { label: 'Attack', min: 0.1, max: 200, def: 10, unit: 'ms', curve: 'log' },
      release: { label: 'Release', min: 10, max: 1000, def: 160, unit: 'ms', curve: 'log' },
      knee: { label: 'Knee', min: 0, max: 40, def: 6, unit: 'dB' },
      makeup: { label: 'Makeup', min: 0, max: 24, def: 3, unit: 'dB' },
      mix: { label: 'Mix', min: 0, max: 1, def: 1, unit: '%' },
    },
    presets: {
      Gentle: { threshold: -18, ratio: 2, attack: 20, release: 200, knee: 10, makeup: 2, mix: 1 },
      Vocal: { threshold: -22, ratio: 3.5, attack: 6, release: 120, knee: 6, makeup: 4, mix: 1 },
      Punch: { threshold: -20, ratio: 4, attack: 25, release: 80, knee: 4, makeup: 4, mix: 1 },
      Squash: { threshold: -35, ratio: 10, attack: 2, release: 60, knee: 0, makeup: 10, mix: 0.5 },
      Limiter: { threshold: -3, ratio: 20, attack: 1, release: 60, knee: 0, makeup: 2, mix: 1 },
    },
    build(ctx, p) {
      const w = wetDry(ctx, p.mix);
      const c = ctx.createDynamicsCompressor();
      const mk = ctx.createGain();
      c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.attack.value = p.attack / 1000; c.release.value = p.release / 1000; c.knee.value = p.knee;
      mk.gain.value = dbToGain(p.makeup);
      w.input.connect(c); c.connect(mk); mk.connect(w.wet);
      const map = {
        threshold: [c.threshold, v => v], ratio: [c.ratio, v => v], attack: [c.attack, v => v / 1000], release: [c.release, v => v / 1000],
        knee: [c.knee, v => v], makeup: [mk.gain, v => dbToGain(v)],
      };
      return {
        input: w.input, output: w.output,
        set(k, v) {
          p[k] = v;
          if (map[k]) setP(ctx, map[k][0], map[k][1](v));
          else if (k === 'mix') { setP(ctx, w.dry.gain, mixDry(v)); setP(ctx, w.wet.gain, mixWet(v)); }
        },
        targets(k) { if (k === 'mix') return w.mixTargets; return map[k] ? [{ param: map[k][0], map: map[k][1] }] : []; },
        reduction() { return c.reduction; },
        dispose() { },
      };
    },
  },

  filter: {
    name: 'Filter', icon: 'funnel', color: '#2DD4BF', desc: 'Sweepable filter with LFO for auto-wah',
    params: {
      type: { label: 'Type', type: 'select', options: ['Low-pass', 'High-pass', 'Band-pass', 'Notch'], def: 'Low-pass' },
      cutoff: { label: 'Cutoff', min: 20, max: 20000, def: 1800, unit: 'Hz', curve: 'log' },
      resonance: { label: 'Resonance', min: 0.1, max: 24, def: 1, unit: 'q', curve: 'log' },
      lfoRate: { label: 'LFO rate', min: 0.05, max: 12, def: 1, unit: 'Hz', curve: 'log' },
      lfoDepth: { label: 'LFO depth', min: 0, max: 1, def: 0, unit: '%' },
      mix: { label: 'Mix', min: 0, max: 1, def: 1, unit: '%' },
    },
    presets: {
      Muffled: { type: 'Low-pass', cutoff: 600, resonance: 0.8, lfoRate: 1, lfoDepth: 0, mix: 1 },
      Thin: { type: 'High-pass', cutoff: 700, resonance: 0.9, lfoRate: 1, lfoDepth: 0, mix: 1 },
      'Wah sweep': { type: 'Band-pass', cutoff: 900, resonance: 6, lfoRate: 1.5, lfoDepth: 0.7, mix: 1 },
      'Auto-filter': { type: 'Low-pass', cutoff: 1200, resonance: 5, lfoRate: 0.5, lfoDepth: 0.8, mix: 1 },
      'Radio band': { type: 'Band-pass', cutoff: 1600, resonance: 1.4, lfoRate: 1, lfoDepth: 0, mix: 1 },
    },
    build(ctx, p) {
      const types = { 'Low-pass': 'lowpass', 'High-pass': 'highpass', 'Band-pass': 'bandpass', 'Notch': 'notch' };
      const w = wetDry(ctx, p.mix);
      const f = ctx.createBiquadFilter(); f.type = types[p.type] || 'lowpass'; f.frequency.value = p.cutoff; f.Q.value = p.resonance;
      const lfo = ctx.createOscillator(); lfo.frequency.value = p.lfoRate;
      const dg = ctx.createGain(); dg.gain.value = p.lfoDepth * 2400;
      lfo.connect(dg); dg.connect(f.detune); lfo.start();
      w.input.connect(f); f.connect(w.wet);
      const map = { cutoff: [f.frequency, v => v], resonance: [f.Q, v => v], lfoRate: [lfo.frequency, v => v], lfoDepth: [dg.gain, v => v * 2400] };
      return {
        input: w.input, output: w.output,
        set(k, v) {
          p[k] = v;
          if (k === 'type') f.type = types[v] || 'lowpass';
          else if (map[k]) setP(ctx, map[k][0], map[k][1](v));
          else if (k === 'mix') { setP(ctx, w.dry.gain, mixDry(v)); setP(ctx, w.wet.gain, mixWet(v)); }
        },
        targets(k) { if (k === 'mix') return w.mixTargets; return map[k] ? [{ param: map[k][0], map: map[k][1] }] : []; },
        filters: [f],
        dispose() { try { lfo.stop(); } catch (e) { /* */ } },
      };
    },
  },

  dist: {
    name: 'Distortion', icon: 'zap', color: '#F87171', desc: 'Warm drive to fuzz and wavefolding',
    params: {
      mode: { label: 'Mode', type: 'select', options: ['Soft', 'Hard', 'Fuzz', 'Fold'], def: 'Soft' },
      drive: { label: 'Drive', min: 0, max: 1, def: 0.4, unit: '%' },
      tone: { label: 'Tone', min: 500, max: 16000, def: 8000, unit: 'Hz', curve: 'log' },
      output: { label: 'Output', min: -24, max: 6, def: -6, unit: 'dB' },
      mix: { label: 'Mix', min: 0, max: 1, def: 1, unit: '%' },
    },
    presets: {
      'Warm tube': { mode: 'Soft', drive: 0.3, tone: 9000, output: -3, mix: 1 },
      Crunch: { mode: 'Hard', drive: 0.5, tone: 6500, output: -8, mix: 1 },
      Fuzz: { mode: 'Fuzz', drive: 0.8, tone: 5000, output: -12, mix: 1 },
      Wavefold: { mode: 'Fold', drive: 0.5, tone: 10000, output: -6, mix: 0.6 },
      'Parallel grit': { mode: 'Hard', drive: 0.7, tone: 4000, output: -10, mix: 0.35 },
    },
    build(ctx, p) {
      const w = wetDry(ctx, p.mix);
      const pre = ctx.createGain(); pre.gain.value = 1 + p.drive * 14;
      const sh = ctx.createWaveShaper(); sh.curve = distCurve(p.mode); sh.oversample = '4x';
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = p.tone; tone.Q.value = 0.5;
      const dc = ctx.createBiquadFilter(); dc.type = 'highpass'; dc.frequency.value = 12; dc.Q.value = 0.7;
      const post = ctx.createGain(); post.gain.value = dbToGain(p.output);
      w.input.connect(pre); pre.connect(sh); sh.connect(dc); dc.connect(tone); tone.connect(post); post.connect(w.wet);
      const map = { drive: [pre.gain, v => 1 + v * 14], tone: [tone.frequency, v => v], output: [post.gain, v => dbToGain(v)] };
      return {
        input: w.input, output: w.output,
        set(k, v) {
          p[k] = v;
          if (k === 'mode') sh.curve = distCurve(v);
          else if (map[k]) setP(ctx, map[k][0], map[k][1](v));
          else if (k === 'mix') { setP(ctx, w.dry.gain, mixDry(v)); setP(ctx, w.wet.gain, mixWet(v)); }
        },
        targets(k) { if (k === 'mix') return w.mixTargets; return map[k] ? [{ param: map[k][0], map: map[k][1] }] : []; },
        dispose() { },
      };
    },
  },

  chorus: {
    name: 'Chorus', icon: 'waves', color: '#F472B6', desc: 'Stereo width, shimmer and flanging',
    params: {
      rate: { label: 'Rate', min: 0.05, max: 6, def: 0.8, unit: 'Hz', curve: 'log' },
      depth: { label: 'Depth', min: 0, max: 1, def: 0.5, unit: '%' },
      delay: { label: 'Delay', min: 1, max: 35, def: 14, unit: 'ms' },
      feedback: { label: 'Feedback', min: 0, max: 0.8, def: 0.15, unit: '%' },
      mix: { label: 'Mix', min: 0, max: 1, def: 0.5, unit: '%' },
    },
    presets: {
      Subtle: { rate: 0.4, depth: 0.25, delay: 12, feedback: 0, mix: 0.35 },
      Lush: { rate: 0.8, depth: 0.6, delay: 18, feedback: 0.2, mix: 0.5 },
      Vibrato: { rate: 5, depth: 0.35, delay: 6, feedback: 0, mix: 1 },
      Flanger: { rate: 0.25, depth: 0.5, delay: 2.5, feedback: 0.65, mix: 0.5 },
    },
    build(ctx, p) {
      const w = wetDry(ctx, p.mix);
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      const dL = ctx.createDelay(0.1), dR = ctx.createDelay(0.1);
      dL.delayTime.value = dR.delayTime.value = p.delay / 1000;
      const oL = ctx.createOscillator(), oR = ctx.createOscillator();
      oR.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
      oL.frequency.value = oR.frequency.value = p.rate;
      const gL = ctx.createGain(), gR = ctx.createGain();
      const depthS = v => v * Math.min(0.004, (p.delay / 1000) * 0.9);
      gL.gain.value = gR.gain.value = depthS(p.depth);
      oL.connect(gL); gL.connect(dL.delayTime); oR.connect(gR); gR.connect(dR.delayTime); oL.start(); oR.start();
      const fL = ctx.createGain(), fR = ctx.createGain(); fL.gain.value = fR.gain.value = p.feedback;
      w.input.connect(sp); sp.connect(dL, 0); sp.connect(dR, 1);
      dL.connect(fL); fL.connect(dL); dR.connect(fR); fR.connect(dR);
      dL.connect(mg, 0, 0); dR.connect(mg, 0, 1); mg.connect(w.wet);
      return {
        input: w.input, output: w.output,
        set(k, v) {
          p[k] = v;
          if (k === 'rate') { setP(ctx, oL.frequency, v); setP(ctx, oR.frequency, v); }
          else if (k === 'depth' || k === 'delay') {
            setP(ctx, gL.gain, depthS(p.depth)); setP(ctx, gR.gain, depthS(p.depth));
            if (k === 'delay') { setP(ctx, dL.delayTime, v / 1000); setP(ctx, dR.delayTime, v / 1000); }
          }
          else if (k === 'feedback') { setP(ctx, fL.gain, v); setP(ctx, fR.gain, v); }
          else if (k === 'mix') { setP(ctx, w.dry.gain, mixDry(v)); setP(ctx, w.wet.gain, mixWet(v)); }
        },
        targets(k) {
          if (k === 'rate') return [{ param: oL.frequency, map: v => v }, { param: oR.frequency, map: v => v }];
          if (k === 'depth') return [{ param: gL.gain, map: depthS }, { param: gR.gain, map: depthS }];
          if (k === 'feedback') return [{ param: fL.gain, map: v => v }, { param: fR.gain, map: v => v }];
          if (k === 'mix') return w.mixTargets;
          return [];
        },
        dispose() { try { oL.stop(); oR.stop(); } catch (e) { /* */ } },
      };
    },
  },
};
const FX_ORDER = ['reverb', 'delay', 'lofi', 'eq', 'comp', 'filter', 'dist', 'chorus'];
/* Every effect gets an outer Intensity control (dry ↔ processed crossfade); curves only drive this */
const INTENSITY = { label: 'Intensity', min: 0, max: 1, def: 1, unit: '%' };
for (const k in FX) FX[k].params = Object.assign({ intensity: INTENSITY }, FX[k].params);
/* Each effect has its own identifying colour (cards, mixer labels, curve lanes), in a light shade for the
   dark theme and a deep shade for the light theme. Every shade keeps 4.5:1 contrast on the app's surfaces. */
const FX_COLORS = {
  dark: { reverb: '#A5B4FC', delay: '#38BDF8', lofi: '#FACC15', eq: '#4ADE80', comp: '#FB923C', filter: '#2DD4BF', dist: '#FDA4AF', chorus: '#F0ABFC' },
  light: { reverb: '#4338CA', delay: '#075985', lofi: '#854D0E', eq: '#166534', comp: '#9A3412', filter: '#115E59', dist: '#BE123C', chorus: '#A21CAF' },
};
for (const k in FX) Object.defineProperty(FX[k], 'color', { get: () => (FX_COLORS[Theme.mode] || FX_COLORS.dark)[k], enumerable: true, configurable: true });

function fxDefaults(type) {
  const o = {};
  for (const [k, s] of Object.entries(FX[type].params)) o[k] = s.def;
  return o;
}
function newFx(type, preset) {
  const params = fxDefaults(type);
  if (preset && FX[type].presets[preset]) Object.assign(params, FX[type].presets[preset]);
  const id = uid();
  return { id, link: id, sync: false, type, bypass: false, preset: preset || null, params };
}
function isAutoParam(type, k) { const s = FX[type] && FX[type].params[k]; return !!s && !s.type && s.auto !== false; }
