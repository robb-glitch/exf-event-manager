/* ExF runtime: gives the page the same window.claude.use('db' | 'user' | 'assets' | 'sample' | 'downloads')
   interface it had inside Claude, but backed by this server. */
(function () {
  'use strict';
  const J = { 'Content-Type': 'application/json' };

  async function api(url, opts) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts));
    if (r.status === 401) { location.href = '/login'; throw { code: 'auth', message: 'Signed out' }; }
    let body = null;
    try { body = await r.json(); } catch (e) {}
    if (!r.ok) throw { code: (body && body.error) || ('http_' + r.status), message: (body && body.message) || ('Request failed (' + r.status + ')'), status: r.status, body };
    return body;
  }
  const rid = () => { const a = new Uint8Array(15); crypto.getRandomValues(a); return Array.from(a, b => (b % 36).toString(36)).join('').slice(0, 20); };

  /* ---------- realtime ---------- */
  const subs = new Set();
  let es = null;
  function connect() {
    if (es || typeof EventSource === 'undefined') return;
    es = new EventSource('/api/events');
    es.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      subs.forEach(s => { if (s.matches(m.c, m.p)) s.fire(); });
    };
    es.onopen = () => subs.forEach(s => s.fire());
    es.onerror = () => { /* the browser reconnects on its own */ };
  }
  function pokeLocal(coll, p) { subs.forEach(s => { if (s.matches(coll, p)) s.fire(); }); }
  setInterval(() => { if (!document.hidden) subs.forEach(s => s.fire()); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) subs.forEach(s => s.fire()); });
  window.addEventListener('online', () => subs.forEach(s => s.fire()));

  function subscribe(load, matches, cb, errCb) {
    let last = null, dead = false, busy = false, again = false;
    const s = {
      matches,
      fire: async () => {
        if (dead) return;
        if (busy) { again = true; return; }
        busy = true;
        try {
          const snap = await load();
          const sig = snap.__sig;
          if (!dead && sig !== last) { last = sig; cb(snap); }
        } catch (e) { if (!dead && errCb && !(e && e.code === 'auth')) errCb(e); }
        busy = false;
        if (again) { again = false; s.fire(); }
      }
    };
    subs.add(s); connect(); s.fire();
    return () => { dead = true; subs.delete(s); };
  }

  /* ---------- db ---------- */
  const copy = o => JSON.parse(JSON.stringify(o));
  const enc = encodeURIComponent;

  function docSnap(path, d) {
    const id = path.slice(path.lastIndexOf('/') + 1);
    const snap = { id, exists: !!(d && d.exists !== false && d.data), ref: null, version: d && d.version, data() { return snap.exists ? copy(d.data) : undefined; } };
    Object.defineProperty(snap, '__sig', { value: snap.exists ? d.version + ':' + path : 'none:' + path, enumerable: false });
    return snap;
  }
  class DocRef {
    constructor(path) { this.path = path; this.id = path.slice(path.lastIndexOf('/') + 1); this.parent = new CollRef(path.slice(0, path.lastIndexOf('/'))); }
    async get() { const d = await api('/api/db/doc?path=' + enc(this.path)); const s = docSnap(this.path, d); s.ref = this; return s; }
    async set(data) { await api('/api/db/doc?path=' + enc(this.path), { method: 'PUT', headers: J, body: JSON.stringify(data) }); pokeLocal(this.parent.path, this.path); }
    async update(data) {
      try { await api('/api/db/doc?path=' + enc(this.path), { method: 'PATCH', headers: J, body: JSON.stringify(data) }); }
      catch (e) { if (e && e.status === 404) throw { code: 'not_found', message: 'Document not found' }; throw e; }
      pokeLocal(this.parent.path, this.path);
    }
    async delete() { await api('/api/db/doc?path=' + enc(this.path), { method: 'DELETE' }); pokeLocal(this.parent.path, this.path); }
    collection(name) { return new CollRef(this.path + '/' + name); }
    onSnapshot(cb, errCb) {
      return subscribe(() => this.get(), (c, p) => p === this.path, cb, errCb);
    }
  }
  const cmp = (a, op, b) => {
    switch (op) {
      case '==': case 'eq': return a === b;
      case '!=': case 'ne': return a !== b;
      case '<': case 'lt': return a < b;
      case '<=': case 'lte': return a <= b;
      case '>': case 'gt': return a > b;
      case '>=': case 'gte': return a >= b;
      case 'in': return Array.isArray(b) && b.includes(a);
      case 'not-in': return Array.isArray(b) && !b.includes(a);
      case 'array-contains': return Array.isArray(a) && a.includes(b);
      default: return true;
    }
  };
  class CollRef {
    constructor(path, q) { this.path = path; this.q = q || { where: [], order: null, lim: 0 }; }
    doc(id) { return new DocRef(this.path + '/' + (id || rid())); }
    async add(data) { const r = this.doc(); await r.set(data); return r; }
    where(f, op, v) { return new CollRef(this.path, Object.assign({}, this.q, { where: this.q.where.concat([[f, op, v]]) })); }
    orderBy(f, dir) { return new CollRef(this.path, Object.assign({}, this.q, { order: [f, dir === 'desc' ? -1 : 1] })); }
    limit(n) { return new CollRef(this.path, Object.assign({}, this.q, { lim: n })); }
    async get() {
      const rows = await api('/api/db/list?coll=' + enc(this.path));
      let docs = rows.map(r => ({ id: r.id, d: r.data, v: r.version }));
      for (const [f, op, v] of this.q.where) docs = docs.filter(x => cmp(x.d[f], op, v));
      if (this.q.order) { const [f, dir] = this.q.order; docs.sort((a, b) => (a.d[f] > b.d[f] ? 1 : a.d[f] < b.d[f] ? -1 : 0) * dir); }
      if (this.q.lim) docs = docs.slice(0, this.q.lim);
      const out = docs.map(x => { const s = docSnap(this.path + '/' + x.id, { exists: true, data: x.d, version: x.v }); s.ref = new DocRef(this.path + '/' + x.id); return s; });
      const snap = { docs: out, size: out.length, empty: !out.length, forEach(fn) { out.forEach(fn); } };
      Object.defineProperty(snap, '__sig', { value: out.map(s => s.id + ':' + s.version).join('|'), enumerable: false });
      return snap;
    }
    onSnapshot(cb, errCb) {
      return subscribe(() => this.get(), c => c === this.path, cb, errCb);
    }
  }
  const dbNs = { collection: p => new CollRef(p), doc: p => new DocRef(p) };

  /* ---------- user ---------- */
  let meP = null;
  const meGet = () => meP || (meP = api('/api/me'));
  const userNs = {
    isOwner: () => false, canEdit: () => true, can: () => true,
    async id() { return (await meGet()).id; },
    async me() { const m = await meGet(); return { id: m.id, name: m.name, isOwner: !!m.isOwner, avatarUrl: undefined }; },
    async profiles(ids) { const out = await api('/api/people?ids=' + enc((ids || []).join(','))); return out; },
    async search(q) { return api('/api/people/search?q=' + enc(q || '')); }
  };

  /* ---------- assets ---------- */
  const assetsNs = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || 'application/octet-stream';
      return api('/api/assets', { method: 'POST', headers: { 'Content-Type': type }, body: blob });
    },
    async delete(id) { return api('/api/assets/' + enc(id), { method: 'DELETE' }); },
    async list() { return { assets: [], usage: {} }; }
  };

  /* ---------- sample (Claude on the server) ---------- */
  const toDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('read')); r.readAsDataURL(b); });
  async function runSample(input, opts, json) {
    const imgs = opts && opts.images ? (Array.isArray(opts.images) ? opts.images : [opts.images]) : [];
    const images = await Promise.all(imgs.map(b => (typeof b === 'string' ? Promise.resolve(b) : toDataUrl(b))));
    const text = typeof input === 'string' ? input : (input || []).map(t => t.content).join('\n\n');
    try { return await api('/api/sample', { method: 'POST', headers: J, body: JSON.stringify({ input: text, images, json }) }); }
    catch (e) { if (e && e.code === 'invalid_json') throw { code: 'invalid_json', message: 'Could not read the answer.', text: e.body && e.body.text }; throw e; }
  }
  const sampleNs = async (input, opts) => { const r = await runSample(input, opts, false); return { text: r.text, truncated: false }; };
  sampleNs.json = async (input, opts) => (await runSample(input, opts, true)).json;
  sampleNs.limits = async () => ({ images: true });

  /* ---------- downloads ---------- */
  const downloadsNs = {
    async save({ filename, data, type }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || (/\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : /\.json$/i.test(filename) ? 'application/json' : 'application/octet-stream') });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'download'; document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
    }
  };

  const NS = { db: dbNs, user: userNs, assets: assetsNs, sample: sampleNs, downloads: downloadsNs };
  window.claude = { use: async name => NS[name] || null };
})();
