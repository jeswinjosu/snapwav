/* ================= Storage (IndexedDB, per device) ================= */
const DB = {
  db: null, mem: null,
  async open() {
    if (this.db || this.mem) return;
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('snapwav', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('projects', { keyPath: 'id' });
          const m = d.createObjectStore('media', { keyPath: 'id' });
          m.createIndex('projectId', 'projectId');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      });
    } catch (e) {
      console.warn('IndexedDB unavailable, using memory', e);
      this.mem = { projects: new Map(), media: new Map() };
      return;
    }
    await this.migrateOld().catch(e => console.warn('migration skipped', e));
  },
  /* Sessions saved under the app's former name ("strata-daw") move into this database once */
  async migrateOld() {
    if (!indexedDB.databases) return;
    const list = await indexedDB.databases();
    if (!list.some(d => d.name === 'strata-daw')) return;
    const old = await new Promise((res, rej) => { const r = indexedDB.open('strata-daw'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    try {
      if (!old.objectStoreNames.contains('projects')) return;
      const read = store => new Promise((res, rej) => { const q = old.transaction(store, 'readonly').objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const projects = await read('projects'), media = old.objectStoreNames.contains('media') ? await read('media') : [];
      for (const m of media) if (!(await this.getMedia(m.id))) await this.putMedia(m);
      for (const p of projects) if (!(await this.getProject(p.id))) await this.putProject(p);
    } finally { old.close(); }
    await new Promise(res => { const d = indexedDB.deleteDatabase('strata-daw'); d.onsuccess = d.onerror = d.onblocked = () => res(); });
  },
  get persistent() { return !!this.db; },
  _tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, mode);
      const st = tx.objectStore(store);
      let out;
      Promise.resolve(fn(st)).then(v => { out = v; });
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
    });
  },
  _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async putProject(p) {
    if (this.mem) { this.mem.projects.set(p.id, JSON.parse(JSON.stringify(p))); return; }
    await this._tx('projects', 'readwrite', st => st.put(p));
  },
  async getProject(id) {
    if (this.mem) { const p = this.mem.projects.get(id); return p ? JSON.parse(JSON.stringify(p)) : null; }
    return this._tx('projects', 'readonly', st => this._req(st.get(id)));
  },
  async listProjects() {
    let all;
    if (this.mem) all = [...this.mem.projects.values()];
    else all = await this._tx('projects', 'readonly', st => this._req(st.getAll()));
    return all.map(p => ({
      id: p.id, name: p.name, modified: p.modified, created: p.created,
      tracks: (p.tracks || []).length, clips: (p.tracks || []).reduce((n, t) => n + (t.clips || []).length, 0), bpm: p.bpm,
    })).sort((a, b) => b.modified - a.modified);
  },
  async deleteProject(id) {
    if (this.mem) {
      this.mem.projects.delete(id);
      for (const [k, v] of this.mem.media) if (v.projectId === id) this.mem.media.delete(k);
      return;
    }
    const keys = await this._tx('media', 'readonly', st => this._req(st.index('projectId').getAllKeys(id)));
    await this._tx('media', 'readwrite', st => { for (const k of keys) st.delete(k); });
    await this._tx('projects', 'readwrite', st => st.delete(id));
  },
  async putMedia(rec) {
    if (this.mem) { this.mem.media.set(rec.id, rec); return; }
    await this._tx('media', 'readwrite', st => st.put(rec));
  },
  async getMedia(id) {
    if (this.mem) return this.mem.media.get(id) || null;
    return this._tx('media', 'readonly', st => this._req(st.get(id)));
  },
  async deleteMedia(id) {
    if (this.mem) { this.mem.media.delete(id); return; }
    await this._tx('media', 'readwrite', st => st.delete(id));
  },
};

/* ================= Zip (store writer + reader with deflate support) ================= */
const Zip = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = table[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const enc = new TextEncoder();
  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }
  async function create(files) {
    const parts = [], central = [];
    let offset = 0;
    const { time, date } = dosTime(new Date());
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : (typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(await new Blob([f.data]).arrayBuffer()));
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t read compressed zip files');
    const ds = new DecompressionStream('deflate-raw');
    const out = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  async function read(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const files = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnl + lxl;
      const raw = u8.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else { console.warn('Unsupported zip method', method, name); continue; }
      files.set(name, data);
    }
    return files;
  }
  return { create, read, crc32 };
})();

/* ================= WAV encoder ================= */
function encodeWav(buf, bits = 16) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const bps = bits / 8, float = bits === 32;
  const dataLen = len * ch * bps;
  const ab = new ArrayBuffer(44 + dataLen), dv = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * bps, true); dv.setUint16(32, ch * bps, true); dv.setUint16(34, bits, true);
  w(36, 'data'); dv.setUint32(40, dataLen, true);
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  if (float) {
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { dv.setFloat32(o, chans[c][i], true); o += 4; }
  } else if (bits === 24) {
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
      let s = Math.round(clamp(chans[c][i], -1, 1) * 8388607);
      dv.setUint8(o, s & 255); dv.setUint8(o + 1, (s >> 8) & 255); dv.setUint8(o + 2, (s >> 16) & 255); o += 3;
    }
  } else {
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
      const x = chans[c][i];
      const d = Math.abs(x) > 1e-5 ? (Math.random() - Math.random()) / 32768 : 0; // TPDF dither, but digital silence stays silent
      dv.setInt16(o, Math.round(clamp(x + d, -1, 1) * 32767), true); o += 2;
    }
  }
  return ab;
}
