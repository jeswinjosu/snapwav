/* ================= Arrange: canvas timeline with touch editing ================= */
const LANE_H = 58, LANE_H_SEL = 124, TALL_H = 168;
const HEAD_H = 16;
/* Canvas colours follow the theme (PALETTES in 01-util.js); COL is updated in place when the theme changes */
const COL = Theme.col;
const FONT = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function rrect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

const Arrange = {
  zoom: 80, sx: 0, sy: 0, W: 0, H: 0, RW: 0, RH: 40, dpr: 1,
  rows: [], contentH: 0, gest: null, pointers: new Map(), mom: null, selPoint: null, lastTap: null, hover: null,
  init() {
    this.cv = $('#tl'); this.ov = $('#tl-ov'); this.rc = $('#ruler');
    this.g = this.cv.getContext('2d'); this.og = this.ov.getContext('2d'); this.rg = this.rc.getContext('2d');
    const ro = new ResizeObserver(() => this.resize());
    ro.observe($('#tl-wrap')); ro.observe($('#ruler-wrap'));
    this.bindCanvas(); this.bindRuler(); this.bindHeaders();
    $('#btn-add-track').onclick = () => addTrackSheet();
    // floating zoom pill: tap = one step, press and hold = continuous zoom (a small step every 50 ms)
    $('#zp-fit').onclick = () => { haptic(); this.zoomFit(); };
    for (const [id, f, fHold] of [['#zp-out', 1 / 1.5, 1 / 1.07], ['#zp-in', 1.5, 1.07]]) {
      const b = $(id);
      b.addEventListener('click', e => { if (e.detail === 0) this.zoomBy(f); });
      b.addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); haptic(); this.zoomBy(f); this.startZoomHold(fHold); });
      b.addEventListener('contextmenu', e => e.preventDefault());
    }
    $('#btn-empty-import').onclick = () => pickAudio({ place: true });
    const stopZoom = () => this.stopZoomHold();
    ['pointerup', 'pointercancel', 'blur'].forEach(ev => window.addEventListener(ev, stopZoom));
    App.on('change', () => { if (App.tab === 'arrange') this.render(); else this.stale = true; });
    App.on('sel', () => { if (App.tab === 'arrange') this.render(); else this.stale = true; });
    App.on('project', () => { const v = App.project.view; this.zoom = v.zoom || 80; this.sx = v.scrollX || 0; this.sy = v.scrollY || 0; this.render(); });
    App.on('seek', () => { if (App.tab === 'arrange') { this.followIfNeeded(true); this.drawOverlay(); this.drawRuler(); this.checkMarker(); } });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.render());
  },
  show() { this.resize(); this.render(); },
  resize() {
    if (!App.project) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const wrap = $('#tl-wrap'), rw = $('#ruler-wrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    this.dpr = dpr; this.W = W; this.H = H; this.RW = rw.clientWidth; this.RH = rw.clientHeight;
    for (const c of [this.cv, this.ov]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    this.rc.width = Math.round(this.RW * dpr); this.rc.height = Math.round(this.RH * dpr);
    this.clampScroll();
    this.draw(); this.drawOverlay(); this.drawRuler(); this.syncHeaders();
  },
  render() {
    if (!App.project) return;
    this.stale = false;
    this.layout();
    this.renderHeaders();
    this.renderToolbar();
    this.clampScroll();
    this.draw(); this.drawOverlay(); this.drawRuler();
    const hasClips = App.project.tracks.some(t => t.clips.length);
    $('#tl-empty').hidden = hasClips;
  },
  layout() {
    let y = 0; this.rows = [];
    for (const t of App.project.tracks) {
      const sel = t.id === App.selTrack;
      const th = sel ? Math.max(t.height, TALL_H) : t.height;
      const r = { t, y, h: th, sel, lanes: [] };
      let ly = y + th;
      if (t.showLanes) for (const l of t.lanes) { const lh = sel ? LANE_H_SEL : LANE_H; r.lanes.push({ l, y: ly, h: lh }); ly += lh; }
      r.total = ly - y; this.rows.push(r); y = ly;
    }
    this.contentH = y + 64;
  },
  contentW() { const P = App.project; const end = Math.max(Engine.songEnd(), P.loop.end, ...P.markers.map(m => m.t), 0); return (end + 60) * this.zoom; },
  clampScroll() {
    this.sx = clamp(this.sx, 0, Math.max(0, this.contentW() - this.W * 0.5));
    this.sy = clamp(this.sy, 0, Math.max(0, this.contentH - this.H));
    const v = App.project && App.project.view; if (v) { v.zoom = this.zoom; v.scrollX = this.sx; v.scrollY = this.sy; }
  },
  t2x(t) { return t * this.zoom - this.sx; },
  x2t(x) { return (x + this.sx) / this.zoom; },
  /* Time grid in seconds: [minor step, labelled major step] */
  timeGrid() {
    const z = this.zoom;
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
    const major = steps.find(st => st * z >= 64) || 1200;
    const divs = { 0.25: [5], 0.5: [5, 2], 2: [4, 2], 5: [5], 15: [3], 30: [6, 3], 60: [6, 4, 2], 120: [4, 2], 300: [5], 600: [10, 5], 1200: [4, 2] }[major] || [10, 5, 2];
    let minor = major;
    for (const d of divs) if (major / d * z >= 9) { minor = major / d; break; }
    return [minor, major];
  },
  fmtRuler(t, major) {
    const m = Math.floor(t / 60 + 1e-9), sec = t - m * 60;
    if (major >= 1) return `${m}:${String(Math.round(sec)).padStart(2, '0')}`;
    const dec = major < 0.1 ? 2 : 1;
    return `${m}:${sec.toFixed(dec).padStart(3 + dec, '0')}`;
  },
  isGridAt(t, step) { return Math.abs(t / step - Math.round(t / step)) < 1e-6; },
  nearMarker() {
    if (!App.project) return null;
    const t = Engine.time();
    let best = null, bd = 0.1 + 1e-6;
    for (const m of App.project.markers) { const d = Math.abs(m.t - t); if (d <= bd) { bd = d; best = m; } }
    return best;
  },

  /* ---------- Drawing ---------- */
  draw() {
    if (!App.project) return;
    const g = this.g, W = this.W, H = this.H; if (!W) return;
    const P = App.project;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COL.bg; g.fillRect(0, 0, W, H);
    // rows background
    for (const r of this.rows) {
      const y = r.y - this.sy; if (y > H || y + r.total < 0) continue;
      g.fillStyle = r.t.id === App.selTrack ? COL.rowSel : COL.row;
      g.fillRect(0, y, W, r.h);
      if (r.t.type === 'bus') { g.fillStyle = hexA(App.colorOf(r.t), 0.05); g.fillRect(0, y, W, r.h); }
      for (const ln of r.lanes) { g.fillStyle = COL.bg; g.fillRect(0, ln.y - this.sy, W, ln.h); }
    }
    // grid (seconds); beat lines too when snapping to beats
    const [minor, major] = this.timeGrid();
    const t0 = this.x2t(0), t1 = this.x2t(W);
    const gh = Math.min(H, this.contentH - 64 - this.sy);
    for (let k = Math.floor(t0 / minor); k * minor <= t1; k++) {
      const t = k * minor, x = Math.round(this.t2x(t)) + 0.5;
      g.strokeStyle = this.isGridAt(t, major) ? COL.bar : COL.line;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Math.max(0, gh)); g.stroke();
    }
    if (P.snap === 'beats') {
      const bg = App.beatGrid();
      if (bg * this.zoom >= 6) {
        g.strokeStyle = hexA(COL.accent, 0.26); g.setLineDash([2, 3]);
        for (let k = Math.floor(t0 / bg); k * bg <= t1; k++) { const x = Math.round(this.t2x(k * bg)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Math.max(0, gh)); g.stroke(); }
        g.setLineDash([]);
      }
    }
    // loop overlay
    if (P.loop.end > P.loop.start) {
      const lx0 = this.t2x(P.loop.start), lx1 = this.t2x(P.loop.end);
      if (P.loop.enabled) { g.fillStyle = hexA(COL.accent, 0.06); g.fillRect(lx0, 0, lx1 - lx0, Math.max(0, gh)); }
      g.strokeStyle = hexA(COL.accent, P.loop.enabled ? 0.6 : 0.2); g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(Math.round(lx0) + 0.5, 0); g.lineTo(Math.round(lx0) + 0.5, gh); g.moveTo(Math.round(lx1) + 0.5, 0); g.lineTo(Math.round(lx1) + 0.5, gh); g.stroke();
      g.setLineDash([]);
    }
    // markers
    const near = this.nearMarker();
    for (const m of P.markers) {
      const x = Math.round(this.t2x(m.t)) + 0.5; if (x < -2 || x > W + 2) continue;
      g.strokeStyle = hexA(App.markerColor(m), m === near ? 0.8 : 0.35); g.setLineDash(m === near ? [] : [2, 4]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, gh); g.stroke(); g.setLineDash([]);
    }
    // row separators, clips, lanes
    for (const r of this.rows) {
      const y = r.y - this.sy; if (y > H || y + r.total < 0) continue;
      g.fillStyle = COL.line; g.fillRect(0, y + r.total - 1, W, 1);
      if (r.t.type === 'audio') {
        const clips = r.t.clips.slice().sort((a, b) => (App.sel.has(a.id) ? 1 : 0) - (App.sel.has(b.id) ? 1 : 0));
        for (const c of clips) this.drawClip(g, r.t, c, y, r.h);
      } else if (r.h >= 40) {
        g.fillStyle = hexA(App.colorOf(r.t), 0.5); g.font = `500 11px ${FONT}`;
        const feeders = P.tracks.filter(x => x.output === r.t.id || x.sends.some(s => s.target === r.t.id)).map(x => x.name);
        g.fillText(feeders.length ? 'Bus · fed by ' + feeders.join(', ') : 'Bus · route tracks here from the Mixer', 10, y + r.h / 2 + 4);
      }
      for (const ln of r.lanes) this.drawLane(g, r.t, ln.l, ln.y - this.sy, ln.h, r.sel);
    }
  },
  drawClip(g, t, c, ry, rh) {
    const W = this.W, z = this.zoom;
    const x = this.t2x(c.start), w = c.duration * z;
    if (x > W + 4 || x + w < -4) return;
    const col = App.clipColor(t, c);
    const sel = App.sel.has(c.id);
    const y = ry + 3, h = rh - 7;
    const missing = !Engine.buffers.has(c.mediaId);
    g.save();
    rrect(g, x, y, Math.max(2, w), h, 6);
    g.fillStyle = hexA(col, c.muted || missing ? 0.07 : COL.clipBody); g.fill();
    g.clip();
    // header strip
    g.fillStyle = hexA(col, c.muted ? 0.3 : COL.clipStrip); g.fillRect(x, y, w, HEAD_H);
    // waveform
    const pk = Engine.peaks.get(c.mediaId);
    const wy = y + HEAD_H + 2, wh = h - HEAD_H - 4, mid = wy + wh / 2;
    if (pk && wh > 6) {
      const rate = c.rate || 1, amp = (wh / 2) * Math.min(1.8, Math.max(0.15, c.gain)) / Math.max(0.25, Math.min(1, pk.peak || 1));
      const px0 = Math.max(Math.floor(x), 0), px1 = Math.min(Math.ceil(x + w), W);
      g.beginPath();
      const bps = pk.sr / pk.block;
      for (let px = px0; px < px1; px++) {
        const u0 = (px - x) / z, u1 = (px + 1 - x) / z;
        let s0, s1;
        if (!c.reversed) { s0 = c.offset + u0 * rate; s1 = c.offset + u1 * rate; }
        else { s1 = c.offset + (c.duration - u0) * rate; s0 = c.offset + (c.duration - u1) * rate; }
        let b0 = Math.floor(s0 * bps), b1 = Math.ceil(s1 * bps);
        b0 = clamp(b0, 0, pk.n - 1); b1 = clamp(Math.max(b1, b0 + 1), 1, pk.n);
        const stride = Math.max(1, Math.floor((b1 - b0) / 48));
        let mn = 0, mx = 0;
        for (let b = b0; b < b1; b += stride) { const a = pk.data[b * 2], bb = pk.data[b * 2 + 1]; if (a < mn) mn = a; if (bb > mx) mx = bb; }
        const uc = (u0 + u1) / 2;
        let f = 1;
        if (c.fadeIn > 0 && uc < c.fadeIn) f *= uc / c.fadeIn;
        if (c.fadeOut > 0 && uc > c.duration - c.fadeOut) f *= (c.duration - uc) / c.fadeOut;
        f = Math.max(0, f);
        g.moveTo(px + 0.5, mid - mx * amp * f - 0.5); g.lineTo(px + 0.5, mid - mn * amp * f + 0.5);
      }
      g.strokeStyle = hexA(col, c.muted ? 0.35 : COL.wave); g.lineWidth = 1; g.stroke();
    } else if (missing) {
      g.strokeStyle = hexA(col, 0.25); g.lineWidth = 1;
      for (let k = Math.floor(x / 10) * 10 - h; k < x + w; k += 10) { g.beginPath(); g.moveTo(k, y + h); g.lineTo(k + h, y); g.stroke(); }
    }
    // fades
    const fiw = c.fadeIn * z, fow = c.fadeOut * z;
    g.fillStyle = COL.fadeFill; g.strokeStyle = COL.fadeLine; g.lineWidth = 1.25;
    if (fiw > 1) { g.beginPath(); g.moveTo(x, y + HEAD_H); g.lineTo(x + fiw, y + HEAD_H); g.lineTo(x, y + h); g.closePath(); g.fill(); g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + fiw, y + HEAD_H); g.stroke(); }
    if (fow > 1) { g.beginPath(); g.moveTo(x + w, y + HEAD_H); g.lineTo(x + w - fow, y + HEAD_H); g.lineTo(x + w, y + h); g.closePath(); g.fill(); g.beginPath(); g.moveTo(x + w, y + h); g.lineTo(x + w - fow, y + HEAD_H); g.stroke(); }
    // label
    if (w > 24) {
      g.font = `600 10.5px ${FONT}`; g.fillStyle = c.muted ? COL.dim : COL.clipText;
      let label = c.name || (App.media(c.mediaId) || {}).name || 'Clip';
      const tags = [];
      if (c.reversed) tags.push('REV'); if ((c.rate || 1) !== 1) tags.push('×' + (+c.rate).toFixed(2)); if (Math.abs(c.gain - 1) > 0.01) tags.push(fmtDb(gainToDb(c.gain)) + 'dB'); if (c.muted) tags.push('MUTED'); if (missing) tags.push('OFFLINE');
      const tag = tags.join(' · ');
      const lx = Math.max(x + 6, 6);
      g.fillText(label, lx, y + 11.5, Math.max(10, w - 12 - (tag ? g.measureText(tag).width + 8 : 0)));
      if (tag && w > 90) { g.font = `600 9px ${MONO}`; const tw = g.measureText(tag).width; g.fillText(tag, Math.min(x + w, W) - tw - 6, y + 11.5); }
    }
    g.restore();
    // selection + handles
    if (sel) {
      rrect(g, x + 0.5, y + 0.5, Math.max(2, w - 1), h - 1, 6);
      g.strokeStyle = COL.selLine; g.lineWidth = 2; g.stroke();
      if (w > 18) {
        g.fillStyle = COL.selLine;
        rrect(g, x + 2, y + h / 2 - 12, 5, 24, 2.5); g.fill();
        rrect(g, x + w - 7, y + h / 2 - 12, 5, 24, 2.5); g.fill();
        for (const fx of [x + Math.max(fiw, 0), x + w - Math.max(fow, 0)]) {
          g.beginPath(); g.arc(clamp(fx, x + 6, x + w - 6), y + HEAD_H, 5, 0, Math.PI * 2);
          g.fillStyle = COL.handle; g.fill(); g.lineWidth = 2; g.strokeStyle = col; g.stroke();
        }
      }
    }
  },
  laneVY(y, h) { return v => y + 9 + (1 - v) * (h - 18); },
  drawCurve(g, pts, x0, x1, toX, vy, col, fill, yBottom, selP) {
    // polyline from x0 to x1 through the points (points are in the curve's own time base)
    g.beginPath();
    g.moveTo(x0, vy(pts.v0));
    for (const p of pts.list) { const x = toX(p.t); if (x < x0 - 1 || x > x1 + 1) continue; g.lineTo(x, vy(p.v)); }
    g.lineTo(x1, vy(pts.v1));
    g.strokeStyle = col; g.lineWidth = 2; g.stroke();
    if (fill) { g.lineTo(x1, yBottom); g.lineTo(x0, yBottom); g.closePath(); g.fillStyle = hexA(col, 0.12); g.fill(); }
    for (const p of pts.list) {
      const x = toX(p.t); if (x < Math.max(-8, x0 - 6) || x > Math.min(this.W + 8, x1 + 6)) continue;
      const isSel = selP === p;
      g.beginPath(); g.arc(x, vy(p.v), isSel ? 7 : 5, 0, Math.PI * 2);
      g.fillStyle = isSel ? COL.handle : COL.bg; g.fill(); g.lineWidth = 2; g.strokeStyle = col; g.stroke();
    }
  },
  drawGuide(g, x0, x1, y, col, label) {
    g.strokeStyle = hexA(col, 0.55); g.lineWidth = 1; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(x0, Math.round(y) + 0.5); g.lineTo(x1, Math.round(y) + 0.5); g.stroke(); g.setLineDash([]);
    if (label && x1 - x0 > 90) { g.font = `600 9px ${FONT}`; g.fillStyle = hexA(col, 0.8); const w = g.measureText('default').width; g.fillText('default', Math.min(x1, this.W) - w - 6, y - 4); }
  },
  drawLane(g, t, lane, y, h, tall) {
    const W = this.W;
    const sp = curveSpec(t, lane.key);
    g.fillStyle = tall ? COL.laneTall : COL.bg; g.fillRect(0, y, W, h);
    g.fillStyle = COL.line2; g.fillRect(0, y, W, 1);
    g.font = `500 10.5px ${FONT}`;
    if (!sp) { g.fillStyle = COL.faint; g.fillText('This parameter is no longer available. Pick another from the lane name.', 10, y + h / 2 + 4); return; }
    const vy = this.laneVY(y, h), col = sp.color;
    const selP = this.selPoint && this.selPoint.p;
    if (sp.scope === 'track') {
      const pts = getCurve(t, lane.key);
      this.drawGuide(g, 0, W, vy(sp.def()), col, true);
      if (pts.length) {
        const list = { list: pts, v0: valueAt(pts, this.x2t(0)), v1: valueAt(pts, this.x2t(W)) };
        this.drawCurve(g, list, 0, W, tt => this.t2x(tt), vy, col, true, y + h, selP);
      } else { g.fillStyle = COL.faint; g.fillText('Tap to add a point. Drag points; double-tap removes one.', 10, y + h - 24); }
    } else {
      // part scope: each part carries its own curve, drawn only inside the part
      for (const c of t.clips) {
        const x0 = this.t2x(c.start), x1 = this.t2x(c.start + c.duration);
        if (x1 < -4 || x0 > W + 4) continue;
        const cx0 = Math.max(x0, -4), cx1 = Math.min(x1, W + 4);
        if (!sp.has(c)) {
          g.save(); g.beginPath(); g.rect(cx0, y + 1, cx1 - cx0, h - 1); g.clip();
          g.strokeStyle = COL.hatch;
          for (let k = Math.floor(cx0 / 9) * 9 - h; k < cx1; k += 9) { g.beginPath(); g.moveTo(k, y + h); g.lineTo(k + h, y); g.stroke(); }
          if (cx1 - cx0 > 110) { g.fillStyle = COL.faint; g.fillText(`No ${FX[sp.fxType] ? FX[sp.fxType].name : 'effect'} on this part`, cx0 + 8, y + h / 2 + 4); }
          g.restore();
          continue;
        }
        g.fillStyle = hexA(col, App.sel.has(c.id) ? 0.11 : 0.06); g.fillRect(cx0, y + 1, cx1 - cx0, h - 1);
        g.strokeStyle = hexA(col, 0.35); g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(Math.round(x0) + 0.5, y + 1); g.lineTo(Math.round(x0) + 0.5, y + h); g.moveTo(Math.round(x1) - 0.5, y + 1); g.lineTo(Math.round(x1) - 0.5, y + h); g.stroke(); g.setLineDash([]);
        this.drawGuide(g, cx0, cx1, vy(sp.def(c)), col, true);
        const pts = getCurve(t, lane.key, c);
        if (pts.length) {
          g.save(); g.beginPath(); g.rect(cx0, y, cx1 - cx0, h); g.clip();
          const list = { list: pts, v0: valueAt(pts, (Math.max(x0, -4) - x0) / this.zoom), v1: valueAt(pts, (cx1 - x0) / this.zoom) };
          this.drawCurve(g, list, cx0, cx1, tt => this.t2x(c.start + tt), vy, col, true, y + h, selP);
          g.restore();
        } else if (cx1 - cx0 > 120) { g.fillStyle = COL.faint; g.fillText('Tap to shape this part', cx0 + 8, y + h - 24); }
      }
    }
    g.font = `600 10px ${FONT}`;
    const lbl = sp.label;
    const lw = g.measureText(lbl).width;
    g.fillStyle = COL.labelBg; rrect(g, 6, y + h - 19, lw + 10, 15, 4); g.fill();
    g.fillStyle = hexA(col, 0.95); g.fillText(lbl, 11, y + h - 8);
  },
  drawOverlay() {
    if (!App.project) return;
    const g = this.og, W = this.W, H = this.H; if (!W) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const x = Math.round(this.t2x(Engine.time())) + 0.5;
    if (x >= -1 && x <= W + 1) {
      g.strokeStyle = COL.play; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Math.min(H, this.contentH - 64 - this.sy)); g.stroke();
    }
    const gs = this.gest;
    if (gs && gs.ghostX != null) { g.strokeStyle = hexA(COL.accent, 0.85); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(gs.ghostX + 0.5, 0); g.lineTo(gs.ghostX + 0.5, H); g.stroke(); g.setLineDash([]); }
    if (gs && gs.mode === 'point' && gs.bubble) {
      const b = gs.bubble;
      g.font = `600 11px ${MONO}`;
      const txt = b.text, w = g.measureText(txt).width + 16;
      let bx = clamp(b.x - w / 2, 4, W - w - 4), by = b.y - 38; if (by < 4) by = b.y + 16;
      g.fillStyle = b.snapped ? b.color : COL.bubble; rrect(g, bx, by, w, 22, 6); g.fill();
      g.fillStyle = b.snapped ? COL.clipText : COL.bubbleText; g.fillText(txt, bx + 8, by + 15);
    }
  },
  drawRuler() {
    if (!App.project) return;
    const g = this.rg, W = this.RW, H = this.RH; if (!W) return;
    const P = App.project;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COL.ruler; g.fillRect(0, 0, W, H);
    // loop band
    g.fillStyle = COL.rulerBand; g.fillRect(0, 0, W, 15);
    if (P.loop.end > P.loop.start) {
      const x0 = this.t2x(P.loop.start), x1 = this.t2x(P.loop.end);
      g.fillStyle = hexA(COL.accent, P.loop.enabled ? 1 : 0.18);
      rrect(g, x0, 2, Math.max(4, x1 - x0), 11, 4); g.fill();
      if (P.loop.enabled && x1 - x0 > 40) { g.fillStyle = COL.onAccent; g.font = `700 9px ${FONT}`; g.fillText('LOOP', x0 + 6, 11); }
    }
    // ticks and time labels (minutes:seconds)
    const [minor, major] = this.timeGrid();
    const t0 = this.x2t(0), t1 = this.x2t(W);
    g.font = `500 10px ${MONO}`;
    for (let k = Math.floor(t0 / minor); k * minor <= t1; k++) {
      const t = k * minor, x = Math.round(this.t2x(t)) + 0.5;
      const isMajor = this.isGridAt(t, major), isHalf = !isMajor && this.isGridAt(t, major / 2);
      g.strokeStyle = isMajor ? COL.tickMajor : COL.tickMinor;
      g.beginPath(); g.moveTo(x, isMajor ? 17 : isHalf ? 29 : 33); g.lineTo(x, H); g.stroke();
      if (isMajor && t >= -1e-9) { g.fillStyle = COL.dim; g.fillText(this.fmtRuler(Math.max(0, t), major), x + 4, 27); }
    }
    // markers: flags only; the one at the playhead (±100 ms) is highlighted and can be removed from the Marker pill
    const near = this.nearMarker();
    for (const m of P.markers) {
      const x = this.t2x(m.t); if (x < -12 || x > W + 12) continue;
      const c = App.markerColor(m), hi = m === near;
      if (hi) { g.fillStyle = hexA(COL.accent, 0.28); g.beginPath(); g.arc(x + 4, 21, 11, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = c; g.beginPath(); g.moveTo(x, 15); g.lineTo(x + (hi ? 10 : 7), 15); g.lineTo(x + (hi ? 10 : 7), hi ? 24 : 22); g.lineTo(x, hi ? 29 : 26); g.closePath(); g.fill();
      g.fillRect(x, 15, hi ? 2 : 1.5, H - 15);
    }
    // playhead
    const px = this.t2x(Engine.time());
    if (px > -8 && px < W + 8) {
      g.fillStyle = COL.play;
      g.beginPath(); g.moveTo(px - 6, H - 10); g.lineTo(px + 6, H - 10); g.lineTo(px, H); g.closePath(); g.fill();
    }
    g.fillStyle = COL.line; g.fillRect(0, H - 1, W, 1);
  },
  frame() {
    if (!App.project) return;
    if (this.stale) this.render();
    if (Engine.playing) this.followIfNeeded(false);
    this.drawOverlay(); this.drawRuler();
    // header meters (vertical bar on the header's right edge)
    for (const r of this.rows) {
      const el = this.meterEls && this.meterEls.get(r.t.id); if (!el) continue;
      const p = Engine.playing ? Engine.trackPeak(r.t.id) : 0;
      const db = gainToDb(p); const w = clamp((db + 48) / 54, 0, 1);
      el.style.height = (w * 100).toFixed(1) + '%';
    }
    this.checkMarker();
  },
  /* Re-render the Marker pill when the playhead enters or leaves a marker's ±100 ms window */
  checkMarker() {
    const m = this.nearMarker(), id = m ? m.id : null;
    if (id !== this.nearId) { this.nearId = id; this.renderToolbar(); this.draw(); }
  },
  followIfNeeded(force) {
    if (!Settings.get('follow') || (this.gest && this.gest.mode !== 'pending')) return;
    const x = this.t2x(Engine.time());
    if (x > this.W * 0.92 || x < 0 || (force && (x > this.W || x < 0))) {
      this.sx = Math.max(0, Engine.time() * this.zoom - this.W * 0.12);
      this.clampScroll(); this.draw();
    }
  },

  /* ---------- Hit testing ---------- */
  rowAtY(cy) { for (const r of this.rows) if (cy >= r.y && cy < r.y + r.total) return r; return null; },
  hit(x, y, pointerType) {
    const cy = y + this.sy, t = this.x2t(x), touch = pointerType !== 'mouse';
    const r = this.rowAtY(cy);
    if (!r) return { type: 'empty', t };
    if (cy < r.y + r.h) {
      if (r.t.type === 'audio') {
        const clips = r.t.clips.slice().sort((a, b) => (App.sel.has(b.id) ? 1 : 0) - (App.sel.has(a.id) ? 1 : 0));
        const ry = cy - r.y;
        for (const c of clips) {
          const cx = this.t2x(c.start), cw = c.duration * this.zoom;
          const sel = App.sel.has(c.id);
          const tol = sel ? (touch ? 14 : 6) : 0;
          if (x < cx - tol || x > cx + cw + tol) continue;
          if (sel || !touch) {
            const edge = Math.min(touch ? 22 : 8, Math.max(6, cw / 3));
            if (ry < HEAD_H + 14 && ry > 0) {
              const fi = cx + Math.max(c.fadeIn * this.zoom, 0), fo = cx + cw - Math.max(c.fadeOut * this.zoom, 0);
              const ft = touch ? 16 : 7;
              if (Math.abs(x - clamp(fi, cx + 6, cx + cw - 6)) < ft && (sel || x - cx < cw / 2)) return { type: 'clip', zone: 'fadeIn', r, t: r.t, c };
              if (Math.abs(x - clamp(fo, cx + 6, cx + cw - 6)) < ft && (sel || x - cx >= cw / 2)) return { type: 'clip', zone: 'fadeOut', r, t: r.t, c };
            }
            if (x < cx + edge) return { type: 'clip', zone: 'trimL', r, t: r.t, c };
            if (x > cx + cw - edge) return { type: 'clip', zone: 'trimR', r, t: r.t, c };
          }
          if (x >= cx && x <= cx + cw) return { type: 'clip', zone: 'body', r, t: r.t, c };
        }
      }
      return { type: 'track', r, t: r.t, time: t };
    }
    for (const ln of r.lanes) {
      if (cy < ln.y || cy >= ln.y + ln.h) continue;
      const vy = this.laneVY(ln.y, ln.h);
      const v = clamp(1 - (cy - ln.y - 9) / (ln.h - 18), 0, 1);
      const sp = curveSpec(r.t, ln.l.key);
      const base = { r, t: r.t, lane: ln.l, ln, sp, time: t, v };
      if (!sp) return Object.assign(base, { type: 'lane', bad: true });
      let best = null, bd = touch ? 22 : 10;
      if (sp.scope === 'track') {
        const pts = getCurve(r.t, ln.l.key);
        for (const p of pts) { const d = Math.hypot(this.t2x(p.t) - x, vy(p.v) - cy); if (d < bd) { bd = d; best = { p, pts, clip: null }; } }
        return best ? Object.assign(base, { type: 'point' }, best) : Object.assign(base, { type: 'lane', clip: null });
      }
      for (const c of r.t.clips) {
        const pts = getCurve(r.t, ln.l.key, c);
        for (const p of pts) { if (p.t < -0.001 || p.t > c.duration + 0.001) continue; const d = Math.hypot(this.t2x(c.start + p.t) - x, vy(p.v) - cy); if (d < bd) { bd = d; best = { p, pts, clip: c }; } }
      }
      if (best) return Object.assign(base, { type: 'point' }, best);
      const clip = r.t.clips.filter(c => t >= c.start && t <= c.start + c.duration).sort((a, b) => (App.sel.has(b.id) ? 1 : 0) - (App.sel.has(a.id) ? 1 : 0))[0] || null;
      return Object.assign(base, { type: 'lane', clip, missing: clip ? !sp.has(clip) : false });
    }
    return { type: 'track', r, t: r.t, time: t };
  },

  /* ---------- Gestures ---------- */
  bindCanvas() {
    const el = this.ov;
    const local = e => { const b = el.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    el.addEventListener('contextmenu', e => { e.preventDefault(); const [x, y] = local(e); this.longPress(this.hit(x, y, 'mouse'), e); });
    el.addEventListener('pointerdown', e => {
      if (e.button === 2) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* */ }
      const [x, y] = local(e);
      this.pointers.set(e.pointerId, { x, y });
      this.stopMomentum();
      if (this.pointers.size === 2) {
        if (this.gest && ['move', 'trimL', 'trimR', 'fadeIn', 'fadeOut', 'point'].includes(this.gest.mode)) this.endEdit();
        clearTimeout(this.lpTimer);
        const [a, b] = [...this.pointers.values()];
        this.gest = { mode: 'pinch', d0: Math.max(20, Math.abs(a.x - b.x)), z0: this.zoom, tc: this.x2t((a.x + b.x) / 2), cy0: (a.y + b.y) / 2, sy0: this.sy };
        return;
      }
      if (this.pointers.size > 2) return;
      const h = this.hit(x, y, e.pointerType);
      const gs = { mode: 'pending', h, x0: x, y0: y, sx0: this.sx, sy0: this.sy, type: e.pointerType, shift: e.shiftKey || e.ctrlKey || e.metaKey, alt: e.altKey, vel: [] };
      if (h.type === 'clip' && h.zone !== 'body') { gs.mode = h.zone; this.beginEdit(gs); }
      else if (h.type === 'clip' && (App.sel.has(h.c.id) || e.pointerType === 'mouse')) gs.intent = 'move';
      else if (h.type === 'point') gs.intent = 'point';
      else gs.intent = 'pan';
      this.gest = gs;
      clearTimeout(this.lpTimer);
      if (gs.mode === 'pending') this.lpTimer = setTimeout(() => { if (this.gest === gs && gs.mode === 'pending') { gs.mode = 'done'; haptic(15); this.longPress(h, e); } }, 520);
    });
    el.addEventListener('pointermove', e => {
      const [x, y] = local(e);
      if (!this.pointers.has(e.pointerId)) { if (e.pointerType === 'mouse') this.hoverCursor(x, y); return; }
      this.pointers.set(e.pointerId, { x, y });
      const gs = this.gest; if (!gs) return;
      if (gs.mode === 'pinch') {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const d = Math.max(20, Math.abs(a.x - b.x));
        this.zoom = clamp(gs.z0 * d / gs.d0, 0.5, 2500);
        this.sx = gs.tc * this.zoom - (a.x + b.x) / 2;
        this.sy = gs.sy0 - ((a.y + b.y) / 2 - gs.cy0);
        this.clampScroll(); this.draw(); this.drawOverlay(); this.drawRuler(); this.syncHeaders();
        return;
      }
      const dx = x - gs.x0, dy = y - gs.y0;
      if (gs.mode === 'pending') {
        if (Math.hypot(dx, dy) < (gs.type === 'mouse' ? 3 : 8)) return;
        clearTimeout(this.lpTimer);
        if (gs.intent === 'move') {
          if (!App.sel.has(gs.h.c.id)) { App.sel.clear(); App.sel.add(gs.h.c.id); App.selTrack = gs.h.t.id; App.emit('sel'); }
          gs.mode = 'move'; this.beginEdit(gs);
        } else if (gs.intent === 'point') { gs.mode = 'point'; this.beginEdit(gs); }
        else gs.mode = 'pan';
      }
      gs.x = x; gs.y = y;
      if (gs.mode === 'pan') {
        this.sx = gs.sx0 - dx; this.sy = gs.sy0 - dy;
        gs.vel.push({ x, y, t: performance.now() }); if (gs.vel.length > 6) gs.vel.shift();
        this.clampScroll(); this.draw(); this.drawOverlay(); this.drawRuler(); this.syncHeaders();
      } else if (gs.mode !== 'done') { this.applyEdit(gs, x, y, e); this.edgeScroll(gs); }
    });
    const up = e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const gs = this.gest; if (!gs) return;
      if (gs.mode === 'pinch') { if (this.pointers.size === 0) this.gest = null; return; }
      clearTimeout(this.lpTimer);
      cancelAnimationFrame(this.esRaf); this.esRaf = 0;
      if (gs.mode === 'pending' && e.type === 'pointerup') this.tap(gs.h, gs, e);
      else if (gs.mode === 'pan') this.startMomentum(gs);
      else if (['move', 'trimL', 'trimR', 'fadeIn', 'fadeOut', 'point'].includes(gs.mode)) this.endEdit();
      this.gest = null;
      this.drawOverlay();
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const [x] = local(e);
      if (e.ctrlKey || e.metaKey) { this.zoomAt(Math.exp(-e.deltaY * 0.01), x); return; }
      const dx = e.shiftKey ? e.deltaY : e.deltaX, dy = e.shiftKey ? 0 : e.deltaY;
      this.sx += dx; this.sy += dy; this.clampScroll(); this.draw(); this.drawOverlay(); this.drawRuler(); this.syncHeaders();
    }, { passive: false });
  },
  hoverCursor(x, y) {
    const h = this.hit(x, y, 'mouse');
    const cur = h.type === 'clip' ? (h.zone === 'body' ? 'grab' : h.zone.startsWith('trim') ? 'ew-resize' : 'col-resize') : h.type === 'point' ? 'move' : h.type === 'lane' ? 'crosshair' : 'default';
    this.ov.style.cursor = cur;
  },
  startMomentum(gs) {
    const v = gs.vel; if (v.length < 2) return;
    const a = v[0], b = v[v.length - 1], dt = b.t - a.t;
    if (dt <= 0 || performance.now() - b.t > 80) return;
    let vx = (b.x - a.x) / dt * 16, vy = (b.y - a.y) / dt * 16;
    const step = () => {
      vx *= 0.94; vy *= 0.94;
      if (Math.abs(vx) < 0.3 && Math.abs(vy) < 0.3) { this.mom = null; return; }
      this.sx -= vx; this.sy -= vy; this.clampScroll(); this.draw(); this.drawOverlay(); this.drawRuler(); this.syncHeaders();
      this.mom = requestAnimationFrame(step);
    };
    this.mom = requestAnimationFrame(step);
  },
  stopMomentum() { if (this.mom) cancelAnimationFrame(this.mom); this.mom = null; },
  edgeScroll(gs) {
    if (this.esRaf) return;
    const tick = () => {
      this.esRaf = 0;
      if (this.gest !== gs || !['move', 'trimL', 'trimR'].includes(gs.mode)) return;
      const m = 28; let d = 0;
      if (gs.x > this.W - m) d = (gs.x - (this.W - m)) * 0.6; else if (gs.x < m && this.sx > 0) d = -(m - gs.x) * 0.6;
      if (!d) return;
      this.sx += d; this.clampScroll(); gs.x0 -= d; gs.sx0 = this.sx;
      this.applyEdit(gs, gs.x, gs.y, {});
      this.esRaf = requestAnimationFrame(tick);
    };
    this.esRaf = requestAnimationFrame(tick);
  },
  beginEdit(gs) {
    History.begin();
    const h = gs.h;
    if (gs.mode === 'move') {
      gs.audio = App.project.tracks.filter(t => t.type === 'audio');
      gs.orig = [];
      for (const t of App.project.tracks) for (const c of t.clips) if (App.sel.has(c.id)) gs.orig.push({ c, start: c.start, ti: gs.audio.indexOf(t) });
      gs.primary = gs.orig.find(o => o.c === h.c);
    } else if (h.c) gs.o = { start: h.c.start, offset: h.c.offset, duration: h.c.duration, fadeIn: h.c.fadeIn, fadeOut: h.c.fadeOut, curves: JSON.parse(JSON.stringify(h.c.curves || {})) };
    else if (h.p) { this.selPoint = { lane: h.lane, p: h.p, pts: h.pts, clip: h.clip }; }
  },
  applyEdit(gs, x, y, e) {
    const h = gs.h, z = this.zoom, dx = x - gs.x0;
    const noSnap = e && e.altKey;
    const excl = gs.excl || (gs.excl = new Set(gs.mode === 'move' ? gs.orig.map(o => o.c.id) : h.c ? [h.c.id] : []));
    const snap = t => noSnap ? t : App.snap(t, { exclude: excl, playhead: true });
    if (gs.mode === 'move') {
      const pr = gs.primary;
      const raw = pr.start + dx / z;
      let ns = raw;
      if (!noSnap && App.project.snap === 'default') {
        // either edge of the moved clip can lock onto other clips, markers, the loop or the playhead
        const dur = pr.c.duration, a = App.magnet(raw, { exclude: excl }), b = App.magnet(raw + dur, { exclude: excl });
        if (a.hit && (!b.hit || Math.abs(a.t - raw) <= Math.abs(b.t - raw - dur))) ns = a.t; else if (b.hit) ns = b.t - dur;
      } else ns = snap(raw);
      let delta = ns - pr.start;
      const minStart = Math.min(...gs.orig.map(o => o.start));
      delta = Math.max(delta, -minStart);
      const r = this.rowAtY(y + this.sy);
      let tiDelta = 0;
      if (r && r.t.type === 'audio') {
        tiDelta = gs.audio.indexOf(r.t) - pr.ti;
        if (gs.orig.some(o => o.ti + tiDelta < 0 || o.ti + tiDelta >= gs.audio.length)) tiDelta = gs.lastTi || 0;
      } else tiDelta = gs.lastTi || 0;
      gs.lastTi = tiDelta;
      for (const o of gs.orig) {
        o.c.start = o.start + delta;
        const target = gs.audio[o.ti + tiDelta];
        const cur = gs.audio.find(t => t.clips.includes(o.c));
        if (cur !== target) { cur.clips.splice(cur.clips.indexOf(o.c), 1); target.clips.push(o.c); }
      }
      App.selTrack = gs.audio[pr.ti + tiDelta].id;
      gs.ghostX = this.t2x(pr.start + delta);
    } else if (h.c) {
      const c = h.c, o = gs.o, rate = c.rate || 1;
      const m = App.media(c.mediaId); const srcDur = (m && m.duration) || (o.offset + o.duration * rate);
      if (gs.mode === 'trimL') {
        let ns = snap(o.start + dx / z);
        let d = ns - o.start;
        d = Math.min(d, o.duration - 0.02);
        if (!c.reversed) d = Math.max(d, -o.offset / rate);
        else d = Math.max(d, -(srcDur - o.offset - o.duration * rate) / rate);
        d = Math.max(d, -o.start);
        c.start = o.start + d; c.duration = o.duration - d;
        if (!c.reversed) c.offset = o.offset + d * rate;
        for (const k in o.curves) c.curves[k] = o.curves[k].map(q => ({ t: q.t - d, v: q.v }));
        c.fadeIn = Math.min(o.fadeIn, c.duration); c.fadeOut = Math.min(o.fadeOut, c.duration - c.fadeIn);
        gs.ghostX = this.t2x(c.start);
      } else if (gs.mode === 'trimR') {
        let ne = snap(o.start + o.duration + dx / z);
        let d = ne - (o.start + o.duration);
        d = Math.max(d, 0.02 - o.duration);
        if (!c.reversed) d = Math.min(d, (srcDur - o.offset - o.duration * rate) / rate);
        else d = Math.min(d, o.offset / rate);
        c.duration = o.duration + d;
        if (c.reversed) c.offset = o.offset - d * rate;
        c.fadeOut = Math.min(o.fadeOut, c.duration); c.fadeIn = Math.min(o.fadeIn, c.duration - c.fadeOut);
        gs.ghostX = this.t2x(c.start + c.duration);
      } else if (gs.mode === 'fadeIn') {
        c.fadeIn = clamp(o.fadeIn + dx / z, 0, c.duration - c.fadeOut);
      } else if (gs.mode === 'fadeOut') {
        c.fadeOut = clamp(o.fadeOut - dx / z, 0, c.duration - c.fadeIn);
      }
    } else if (gs.mode === 'point') {
      const ln = h.ln, pts = h.pts, i = pts.indexOf(h.p), sp = h.sp;
      const base = h.clip ? h.clip.start : 0;
      let ta = Math.max(0, this.x2t(x));
      if (!noSnap) {
        ta = App.snap(ta, { playhead: true });
        if (h.clip) { if (Math.abs(this.t2x(h.clip.start) - x) < 12) ta = h.clip.start; if (Math.abs(this.t2x(h.clip.start + h.clip.duration) - x) < 12) ta = h.clip.start + h.clip.duration; }
      }
      let tt = ta - base;
      const lo = i > 0 ? pts[i - 1].t + 0.001 : 0, hiN = i < pts.length - 1 ? pts[i + 1].t - 0.001 : Infinity;
      const hi = h.clip ? Math.min(hiN, h.clip.duration) : hiN;
      tt = clamp(tt, Math.max(lo, 0), Math.max(lo, hi));
      let v = clamp(1 - (y + this.sy - ln.y - 9) / (ln.h - 18), 0, 1);
      const dv = sp.def(h.clip);
      const vy = this.laneVY(ln.y - this.sy, ln.h);
      const snapped = !noSnap && Math.abs(vy(v) - vy(dv)) < 10;
      if (snapped) v = dv;
      h.p.t = tt; h.p.v = v;
      gs.ghostX = this.t2x(base + tt);
      gs.bubble = { x: this.t2x(base + tt), y: vy(v), text: sp.fmt(v) + (snapped ? ' · default' : ''), snapped, color: sp.color };
      if (snapped && !gs.wasSnapped) haptic(6);
      gs.wasSnapped = snapped;
    }
    this.draw(); this.drawOverlay();
  },
  endEdit() {
    const gs = this.gest; if (gs) gs.ghostX = null;
    History.commit();
    this.render();
  },
  tap(h, gs, e) {
    const now = performance.now();
    const dbl = this.lastTap && now - this.lastTap.t < 330 && Math.hypot(this.lastTap.x - gs.x0, this.lastTap.y - gs.y0) < 24;
    this.lastTap = dbl ? null : { t: now, x: gs.x0, y: gs.y0 };
    if (h.type === 'clip') {
      if (gs.shift || App.multi) { App.sel.has(h.c.id) ? App.sel.delete(h.c.id) : App.sel.add(h.c.id); }
      else { App.sel.clear(); App.sel.add(h.c.id); }
      App.selTrack = h.t.id; this.selPoint = null;
      App.emit('sel');
      if (dbl) clipInspector(h.c.id);
      return;
    }
    if (h.type === 'point') {
      if (dbl) { mutate(() => { h.pts.splice(h.pts.indexOf(h.p), 1); }); this.selPoint = null; return; }
      this.selPoint = { lane: h.lane, p: h.p, pts: h.pts, clip: h.clip }; this.draw();
      return;
    }
    if (h.type === 'lane') {
      if (h.bad) { curvePicker(h.t.id, h.lane.id); return; }
      if (App.selTrack !== h.t.id) { App.selTrack = h.t.id; App.emit('sel'); }
      addCurvePoint(h.t, h.lane.key, h.clip, h.time, h.v, h.sp, h.missing);
      return;
    }
    if (h.type === 'track') {
      if (App.sel.size && !App.multi) App.sel.clear();
      App.selTrack = h.t.id; this.selPoint = null;
      Engine.seek(Math.max(0, App.snap(h.time, { playhead: false })));
      App.emit('sel');
      return;
    }
    if (!App.multi) App.sel.clear(); this.selPoint = null;
    Engine.seek(Math.max(0, App.snap(h.t, { playhead: false })));
    App.emit('sel');
  },
  longPress(h) {
    if (h.type === 'clip') {
      if (!App.sel.has(h.c.id)) { App.sel.clear(); App.sel.add(h.c.id); App.selTrack = h.t.id; App.emit('sel'); }
      clipMenu();
    } else if (h.type === 'point') {
      menuSheet(h.sp.label + ' · ' + h.sp.fmt(h.p.v), [
        { icon: 'locate-fixed', label: 'Set to default', hint: h.sp.fmt(h.sp.def(h.clip)), onClick: () => mutate(() => { h.p.v = h.sp.def(h.clip); }) },
        { icon: 'trash-2', label: 'Delete point', danger: true, onClick: () => mutate(() => { h.pts.splice(h.pts.indexOf(h.p), 1); }) },
        { icon: 'x', label: h.clip ? 'Clear this part’s curve' : 'Clear curve', danger: true, onClick: () => mutate(() => { h.pts.length = 0; }) },
      ], { icon: 'spline', color: h.sp.color });
    } else if (h.type === 'track' || h.type === 'lane') {
      const at = Math.max(0, App.snap(h.time, { playhead: false }));
      App.selTrack = h.t.id; App.emit('sel');
      menuSheet(h.t.name, [
        h.t.type === 'audio' && { icon: 'upload', label: 'Import audio here', hint: fmtTime(at), color: 'var(--c-media)', onClick: () => pickAudio({ place: true, at, trackId: h.t.id }) },
        h.t.type === 'audio' && App.clipboard && { icon: 'clipboard-paste', label: 'Paste here', hint: fmtTime(at), onClick: () => Edit.paste(at, h.t.id) },
        { icon: 'flag', label: 'Add marker here', hint: fmtTime(at), onClick: () => Edit.addMarker(at) },
        { icon: 'locate-fixed', label: 'Move playhead here', onClick: () => Engine.seek(at) },
        'sep',
        { icon: 'settings-2', label: 'Track options', onClick: () => trackMenu(h.t.id) },
      ], { icon: 'audio-lines', color: App.colorOf(h.t) });
    }
  },

  /* ---------- Ruler ---------- */
  bindRuler() {
    const el = this.rc;
    let st = null;
    const local = e => { const b = el.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    el.addEventListener('pointerdown', e => {
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* */ }
      const [x, y] = local(e);
      const P = App.project, t = Math.max(0, this.x2t(x));
      const touch = e.pointerType !== 'mouse';
      st = { x0: x, y0: y, moved: false, t0: t };
      const near = (tt, tol) => Math.abs(this.t2x(tt) - x) < tol;
      const mk = P.markers.find(m => x >= this.t2x(m.t) - 4 && x <= this.t2x(m.t) + 12 && y >= 12 && y <= 28);
      if (y < 16) {
        History.begin();
        const tol = touch ? 18 : 8;
        if (P.loop.end > P.loop.start && near(P.loop.start, tol)) st.mode = 'ls';
        else if (P.loop.end > P.loop.start && near(P.loop.end, tol)) st.mode = 'le';
        else if (t > P.loop.start && t < P.loop.end) { st.mode = 'lm'; st.ls = P.loop.start; st.le = P.loop.end; }
        else { st.mode = 'lnew'; }
      } else if (mk) { st.mode = 'marker'; st.m = mk; st.lp = setTimeout(() => { if (st && !st.moved) { st.mode = 'done'; markerMenu(mk.id); } }, 520); }
      else { st.mode = 'scrub'; st.was = Engine.playing; if (Engine.playing) Engine.pause(); Engine.seek(t); }
    });
    el.addEventListener('pointermove', e => {
      if (!st) return;
      const [x] = local(e);
      if (!st.moved && Math.abs(x - st.x0) < 4) return;
      st.moved = true;
      const P = App.project, t = Math.max(0, this.x2t(x)), s = v => App.snap(v, { playhead: false });
      if (st.mode === 'ls') P.loop.start = clamp(s(t), 0, P.loop.end - 0.05);
      else if (st.mode === 'le') P.loop.end = Math.max(s(t), P.loop.start + 0.05);
      else if (st.mode === 'lm') { const d = s(st.ls + (t - st.t0)) - st.ls; const dd = Math.max(d, -st.ls); P.loop.start = st.ls + dd; P.loop.end = st.le + dd; }
      else if (st.mode === 'lnew') { const a = s(st.t0), b = s(t); P.loop.start = Math.min(a, b); P.loop.end = Math.max(a, b); P.loop.enabled = true; }
      else if (st.mode === 'scrub') Engine.seek(t);
      else if (st.mode === 'marker') { clearTimeout(st.lp); if (!st.mh) { History.begin(); st.mh = 1; } st.m.t = s(t); }
      this.draw(); this.drawRuler(); this.drawOverlay(); updatePos();
    });
    const up = () => {
      if (!st) return;
      const s = st; st = null;
      clearTimeout(s.lp);
      if (['ls', 'le', 'lm', 'lnew'].includes(s.mode)) {
        const P = App.project;
        if (!s.moved) {
          History.cancel();
          if (s.mode === 'lm' || s.mode === 'ls' || s.mode === 'le') toggleLoop();
          else Engine.seek(App.snap(s.t0, { playhead: false }));
        } else {
          if (P.loop.end - P.loop.start < 0.05) P.loop.end = P.loop.start + 1;
          History.commit();
        }
      } else if (s.mode === 'marker') {
        if (s.mh) History.commit(); else Engine.seek(s.m.t);
      } else if (s.mode === 'scrub') {
        if (!s.moved) Engine.seek(App.snap(s.t0, { playhead: false }));
        if (s.was) Engine.play();
      }
      this.draw(); this.drawRuler(); this.drawOverlay();
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => { e.preventDefault(); const b = el.getBoundingClientRect(); if (e.ctrlKey || e.metaKey || !e.shiftKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - b.left); }, { passive: false });
  },
  zoomAt(f, x) {
    const t = this.x2t(x);
    this.zoom = clamp(this.zoom * f, 0.5, 2500);
    this.sx = t * this.zoom - x;
    this.clampScroll(); this.draw(); this.drawOverlay(); this.drawRuler();
  },
  zoomBy(f) { this.zoomAt(f, clamp(this.t2x(Engine.time()), 0, this.W) || this.W / 2); },
  zoomFit() {
    const end = Math.max(Engine.songEnd(), App.project.loop.enabled ? App.project.loop.end : 0, 8);
    this.zoom = clamp((this.W - 24) / end, 0.5, 2500); this.sx = 0;
    this.clampScroll(); this.draw(); this.drawOverlay(); this.drawRuler();
  },

  /* ---------- Track headers (DOM) ---------- */
  bindHeaders() {
    const box = $('#tl-headers');
    let st = null;
    box.addEventListener('pointerdown', e => { st = { y0: e.clientY, sy0: this.sy, moved: false, id: e.pointerId }; });
    box.addEventListener('pointermove', e => {
      if (!st || e.pointerId !== st.id) return;
      const dy = e.clientY - st.y0;
      if (!st.moved && Math.abs(dy) > 8) { st.moved = true; try { box.setPointerCapture(e.pointerId); } catch (_) { /* */ } }
      if (st.moved) { this.sy = st.sy0 - dy; this.clampScroll(); this.syncHeaders(); this.draw(); this.drawOverlay(); }
    });
    const end = e => { if (st && e.pointerId === st.id) { if (st.moved) { const stop = ev => { ev.stopPropagation(); ev.preventDefault(); }; box.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => box.removeEventListener('click', stop, { capture: true }), 50); } st = null; } };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('wheel', e => { e.preventDefault(); this.sy += e.deltaY; this.clampScroll(); this.syncHeaders(); this.draw(); this.drawOverlay(); }, { passive: false });
  },
  syncHeaders() { const inner = $('#tl-headers-inner'); if (inner) inner.style.transform = `translateY(${-this.sy}px)`; },
  renderHeaders() {
    const inner = $('#tl-headers-inner');
    inner.innerHTML = '';
    this.meterEls = new Map();
    for (const r of this.rows) {
      const t = r.t, col = App.colorOf(t);
      const nFx = trackFxCount(t);
      const el = h('div', { class: 'th' + (t.id === App.selTrack ? ' sel' : ''), style: { height: r.total + 'px' } });
      el.style.setProperty('--tc', col);
      const meter = h('i');
      this.meterEls.set(t.id, meter);
      const B = (cls, icon, title, on, fn, extra) => {
        const b = h('button', { class: 'tb ' + cls + (on ? ' on' : ''), title, 'aria-label': title + ' · ' + t.name, 'aria-pressed': on ? 'true' : 'false', html: ic(icon) + (extra || '') });
        b.addEventListener('click', ev => { ev.stopPropagation(); haptic(); fn(); });
        return b;
      };
      // icons in order of importance; as many as fit the track height
      const buttons = [
        B('m', 'volume-x', 'Mute', t.mute, () => Edit.toggleTrack(t.id, 'mute')),
        B('more', 'ellipsis-vertical', 'Track options', false, () => trackMenu(t.id)),
        B('au', 'spline', 'Curves', !!(t.lanes.length && t.showLanes), () => toggleLanes(t.id)),
        B('fx' + (nFx ? ' has' : ''), 'wand-sparkles', 'Effects', false, () => openFxFor(t.id), nFx ? `<span class="cnt">${nFx}</span>` : ''),
      ];
      const fit = Math.max(1, Math.floor((r.h - 12 + 4) / 32));
      const main = h('div', { class: 'th-main', style: { height: r.h + 'px' }, title: t.name },
        h('div', { class: 'th-icons' }, buttons.slice(0, fit)),
        h('div', { class: 'th-meter' }, meter));
      main.addEventListener('click', () => {
        if (App.selTrack !== t.id) { App.selTrack = t.id; App.emit('sel'); }
        else if (!isLandscape()) trackMenu(t.id);
      });
      el.append(main);
      for (const ln of r.lanes) {
        const sp = curveSpec(t, ln.l.key);
        el.append(h('div', { class: 'th-lane' + (r.sel ? ' tall' : ''), style: { height: ln.h + 'px', '--lc': sp ? sp.color : 'var(--faint)' } },
          h('button', { class: 'lane-btn', title: sp ? sp.label : 'Curve lane', 'aria-label': (sp ? sp.label : 'Curve lane') + ' options', html: ic('spline'), onclick: ev => { ev.stopPropagation(); laneMenu(t.id, ln.l.id); } })));
      }
      inner.append(el);
    }
    inner.append(h('button', { class: 'th-add', title: 'Add track', 'aria-label': 'Add track', html: ic('plus'), onclick: () => addTrackSheet() }));
    this.syncHeaders();
  },

  /* ---------- Toolbar ---------- */
  renderToolbar() {
    const bar = $('#toolbar'); if (!bar || !App.project) return;
    const old = bar.querySelector('.tb-scroll'), keep = old ? old.scrollLeft : 0;
    bar.innerHTML = '';
    const scroll = h('div', { class: 'tb-scroll' });
    bar.append(scroll);
    const into = scroll;
    const chip = (icon, label, fn, o = {}) => {
      const b = h('button', { class: 'chip' + (o.on ? ' on' : '') + (o.danger ? ' danger' : '') + (label ? '' : ' icon-only'), title: o.title || label, 'aria-label': o.title || label, disabled: o.disabled, html: ic(icon) + (label ? `<span>${esc(label)}</span>` : '') });
      if (o.color) b.style.setProperty('--chip-c', o.color);
      if (fn) b.onclick = () => { haptic(); fn(b); };
      into.append(b); return b;
    };
    const sep = () => into.append(h('span', { class: 'tsep' }));
    const n = App.sel.size;
    if (n) {
      if (n > 1) scroll.append(h('span', { class: 'sel-count', text: `${n} clips` }));
      chip('scissors', 'Split', () => Edit.split(), { color: 'var(--accent)', title: 'Split at playhead (S)' });
      chip('copy-plus', 'Duplicate', () => Edit.duplicate());
      chip('copy', 'Copy', () => Edit.copy());
      chip('trash-2', 'Delete', () => Edit.remove(), { danger: true });
      sep();
      chip('flip-horizontal-2', 'Reverse', () => Edit.reverse());
      chip('chevrons-up-down', 'Normalize', () => Edit.normalize());
      chip('pencil', 'Edit', () => clipInspector([...App.sel][0]));
      chip('wand-sparkles', 'Part FX', () => { const [t, c] = App.clipById([...App.sel][0]); if (c) openFxFor(t.id, c.id); }, { color: 'var(--accent)', title: 'Effects on this part' });
      chip('spline', 'Curves', () => { const [t] = App.clipById([...App.sel][0]); if (t) curvePicker(t.id); }, { title: 'Add a curve lane' });
      chip('ellipsis-vertical', '', () => clipMenu(), { title: 'More clip actions' });
      chip('x', '', () => { App.sel.clear(); App.emit('sel'); }, { title: 'Clear selection (Esc)' });
    } else {
      const near = this.nearMarker();
      this.nearId = near ? near.id : null;
      if (near) chip('flag-off', 'Remove marker', () => Edit.toggleMarker(), { on: true, danger: true, title: 'Remove the marker at the playhead' });
      else chip('flag', 'Marker', () => Edit.toggleMarker(), { title: 'Add a marker at the playhead' });
      chip('square-dashed-mouse-pointer', 'Select', () => { App.multi = !App.multi; this.renderToolbar(); toast(App.multi ? 'Multi-select on: tap clips to add them' : 'Multi-select off', { ms: 1400 }); }, { on: App.multi, title: 'Multi-select mode' });
      const P = App.project;
      chip('magnet', 'Snap: ' + SNAP_MODES[P.snap] + (P.snap === 'beats' ? ' ' + (P.snapDiv === 'bar' ? 'bar' : P.snapDiv) : ''), () => snapSheet(), { on: P.snap !== 'off', color: 'var(--accent)' });
      if (App.clipboard) chip('clipboard-paste', 'Paste', () => Edit.paste(), { title: 'Paste at playhead (Ctrl+V)' });
    }
    scroll.scrollLeft = keep;
  },
  startZoomHold(f) {
    this.stopZoomHold();
    this.zoomT1 = setTimeout(() => { this.zoomT2 = setInterval(() => this.zoomBy(f), 50); }, 300);
  },
  stopZoomHold() { clearTimeout(this.zoomT1); clearInterval(this.zoomT2); this.zoomT1 = this.zoomT2 = 0; },
};

function snapSheet() {
  const P = App.project;
  const body = h('div', {});
  const draw = () => {
    body.innerHTML = '';
    const m = h('div', { class: 'menu' });
    for (const [k, label, desc] of [
      ['default', 'Default', 'Clips, markers, the loop and the playhead pull each other into line.'],
      ['beats', 'Beats', 'Positions lock to a beat grid.'],
      ['off', 'Off', 'Move everything freely.']]) {
      const b = h('button', { html: ic(P.snap === k ? 'check' : 'magnet') + `<span style="display:flex;flex-direction:column;line-height:1.3"><span>${label}</span><small style="margin:0;font-family:var(--f-ui);color:var(--dim);font-size:11.5px">${desc}</small></span>` });
      if (P.snap === k) b.style.setProperty('--mc', 'var(--c-arrange)');
      b.onclick = () => { P.snap = k; changed('view'); draw(); };
      m.append(b);
    }
    body.append(m);
    if (P.snap === 'beats') {
      const seg = h('div', { class: 'seg' }); seg.style.setProperty('--rc', 'var(--c-arrange)');
      for (const d of Object.keys(SNAP_DIVS)) seg.append(h('button', { class: P.snapDiv === d ? 'on' : '', text: d === 'bar' ? 'Bar' : d, onclick: () => { P.snapDiv = d; changed('view'); draw(); } }));
      const bpm = h('input', { class: 'tinput mono', type: 'number', min: 20, max: 300, step: 1, value: Math.round(P.bpm * 10) / 10, id: 'beat-bpm', style: { width: '96px', textAlign: 'center' } });
      bpm.addEventListener('change', () => { const v = parseFloat(bpm.value); if (isFinite(v)) { mutate(p => { p.bpm = clamp(Math.round(v * 10) / 10, 20, 300); }); bpm.value = App.project.bpm; } });
      body.append(
        h('div', { class: 'field', style: { marginTop: '14px' } }, h('div', { class: 'lbl', text: 'Beat grid' }), seg),
        h('div', { class: 'field' }, h('label', { for: 'beat-bpm', text: 'Beats per minute for the grid' }), bpm));
    }
  };
  draw();
  openSheet({ title: 'Snap', icon: 'magnet', color: 'var(--c-arrange)', body });
}
function toggleLanes(id) {
  const t = App.track(id);
  if (!t.lanes.length) { curvePicker(id); return; }
  t.showLanes = !t.showLanes;
  if (t.showLanes) App.selTrack = id;
  changed('view');
}
function trackFxCount(t) {
  if (t.type !== 'audio') return t.fx.length;
  const links = new Set(); for (const c of t.clips) for (const f of c.fx || []) links.add(fxLink(f));
  return links.size + t.fx.length;
}
function openFxFor(trackId, clipId) {
  App.fxExplicit = true;
  App.fxTrack = trackId;
  const t = App.track(trackId);
  if (clipId) App.fxClip = clipId;
  else if (t && t.type === 'audio') { const sel = t.clips.find(c => App.sel.has(c.id)); App.fxClip = sel ? sel.id : (t.clips.find(c => c.id === App.fxClip) ? App.fxClip : (t.clips[0] || {}).id); }
  setTab('fx');
}
/* Add a point to a curve; the first point also drops default anchors at the scope's edges */
function addCurvePoint(t, key, clip, time, v, sp, missing) {
  if (isPartKey(key)) {
    if (!clip) { toast('Part curves live inside a part. Tap inside a part.', { ms: 2200 }); return; }
    if (missing) {
      toast(`This part has no ${FX[sp.fxType] ? FX[sp.fxType].name : 'effect'} yet.`, { action: 'Add it', onAction: () => copyFxToClip(t, sp.link, clip), color: sp.color, ms: 4000 });
      return;
    }
  }
  const lane = Arrange.rows.find(r => r.t === t);
  const vyH = lane ? (lane.lanes.find(l => l.l.key === key) || {}).h || LANE_H : LANE_H;
  const dv = sp.def(clip);
  if (Math.abs(v - dv) * (vyH - 18) < 10) v = dv;
  mutate(() => {
    const pts = ensureCurve(t, key, clip);
    const base = clip ? clip.start : 0;
    const tt = clamp(App.snap(time) - base, 0, clip ? clip.duration : Infinity);
    if (!pts.length) {
      if (clip) { if (tt > 0.01) pts.push({ t: 0, v: dv }); if (tt < clip.duration - 0.01) pts.push({ t: clip.duration, v: dv }); }
      else { const pre = Math.max(0, tt - 1); if (tt > 0.01) pts.push({ t: pre, v: dv }); pts.push({ t: tt + 1, v: dv }); }
    }
    pts.push({ t: tt, v });
    pts.sort((a, b) => a.t - b.t);
  });
  haptic();
}
function copyFxToClip(t, link, clip) {
  const src = t.clips.map(c => partFx(c, link)).find(Boolean); if (!src) return;
  mutate(() => { const f = JSON.parse(JSON.stringify(src)); f.id = uid(); clip.fx.push(f); });
  toast(`${FX[src.type].name} added to this part`, { color: FX[src.type].color });
}
