'use strict';
/*
  ExF Event Manager + Partner Interest form
  One small Express server. Postgres for data. Resend for email. Anthropic API for reading cards.
*/
const express = require('express');
require('express-async-errors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'rdoduck@exfreight.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'ExFreight Partners <onboarding@resend.dev>';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const BASE_URL_ENV = (process.env.BASE_URL || '').replace(/\/+$/, '');

if (!process.env.DATABASE_URL) console.error('DATABASE_URL is not set. Add the Postgres reference variable in Railway.');
if (!SESSION_SECRET) console.error('SESSION_SECRET is not set.');
if (!ACCESS_CODE) console.error('ACCESS_CODE is not set. Nobody will be able to sign in.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && /railway\.internal/.test(process.env.DATABASE_URL) ? false : (process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false })
});
const q = (text, params) => pool.query(text, params);

async function initDb() {
  await q(`create table if not exists docs(
    path text primary key, coll text not null, id text not null, data jsonb not null,
    version int not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await q('create index if not exists docs_coll on docs(coll)');
  await q(`create table if not exists people(
    id text primary key, email text unique not null, name text not null default '',
    created_at timestamptz not null default now(), last_seen timestamptz not null default now())`);
  await q(`create table if not exists assets(
    id text primary key, type text not null, size int not null, data bytea not null,
    owner text, created_at timestamptz not null default now())`);
  await q(`create table if not exists links(
    code text primary key, cid text unique, data jsonb not null, created_at timestamptz not null default now())`);
  await q(`create table if not exists partner(
    id text primary key, email_key text unique not null, data jsonb not null, search_text text not null default '',
    card_image text, submissions int not null default 1, status text not null default 'new',
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
}

/* ---------------- helpers ---------------- */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hmac = s => b64u(crypto.createHmac('sha256', SESSION_SECRET || 'dev').update(s).digest());
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const userIdFor = email => 'u_' + b64u(crypto.createHash('sha256').update(email.toLowerCase()).digest()).slice(0, 22);
const rid = (n = 20) => crypto.randomBytes(n).toString('hex').slice(0, n);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const baseUrl = req => BASE_URL_ENV || (req.protocol + '://' + req.get('host'));

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function makeSession(uid) {
  const payload = b64u(JSON.stringify({ u: uid, e: Date.now() + 90 * 864e5 }));
  return payload + '.' + hmac(payload);
}
function readSession(req) {
  const c = parseCookies(req).xc;
  if (!c) return null;
  const [p, sig] = c.split('.');
  if (!p || !sig || !safeEq(sig, hmac(p))) return null;
  try { const d = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); return d.e > Date.now() ? d.u : null; } catch (e) { return null; }
}
async function auth(req, res, next) {
  const uid = readSession(req);
  if (!uid) return wantsJson(req) ? res.status(401).json({ error: 'auth' }) : res.redirect('/login');
  try {
    const r = await q('select id,email,name from people where id=$1', [uid]);
    if (!r.rows.length) return wantsJson(req) ? res.status(401).json({ error: 'auth' }) : res.redirect('/login');
    req.user = r.rows[0];
    req.user.isOwner = ADMIN_EMAILS.includes(req.user.email.toLowerCase());
    next();
  } catch (e) { next(e); }
}
const wantsJson = req => req.path.startsWith('/api/') || req.path.startsWith('/_blob/');

/* tiny in-memory rate limiter */
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) { const f = v.filter(t => now - t < 36e5); f.length ? hits.set(k, f) : hits.delete(k); } }, 6e5).unref();
const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

/* realtime: server-sent events */
const clients = new Set();
function broadcast(coll, p) {
  const msg = 'data: ' + JSON.stringify({ c: coll, p }) + '\n\n';
  for (const r of clients) { try { r.write(msg); } catch (e) { clients.delete(r); } }
}
setInterval(() => { for (const r of clients) { try { r.write(': hb\n\n'); } catch (e) { clients.delete(r); } } }, 25000).unref();

/* docs helpers */
const SEG = '[A-Za-z0-9_\\-.~:@+]{1,200}';
const DOC_RX = new RegExp('^' + SEG + '(/' + SEG + '){1,15}$');
const COLL_RX = new RegExp('^' + SEG + '(/' + SEG + '){0,14}$');
const validDoc = p => typeof p === 'string' && DOC_RX.test(p) && p.split('/').length % 2 === 0 && !p.split('/').some(s => s === '.' || s === '..');
const validColl = p => typeof p === 'string' && COLL_RX.test(p) && p.split('/').length % 2 === 1 && !p.split('/').some(s => s === '.' || s === '..');
const splitPath = p => { const i = p.lastIndexOf('/'); return { coll: p.slice(0, i), id: p.slice(i + 1) }; };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function mergeDeep(target, patch) {
  const out = Object.assign({}, target);
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && v.__delete__ === true) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = mergeDeep(out[k], v);
    else out[k] = v;
  }
  return out;
}
function stripDeletes(v) {
  if (Array.isArray(v)) return v.map(stripDeletes);
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) { if (isObj(x) && x.__delete__ === true) continue; o[k] = stripDeletes(x); } return o; }
  return v;
}

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
app.get('/healthz', (req, res) => res.send('ok'));

const jsonBig = express.json({ limit: '6mb' });
const PUB = path.join(__dirname, 'public');
const sendPage = (res, name) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(PUB, name)); };

/* ---- login ---- */
const loginPage = (err, v = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ExF Event Manager</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=Public+Sans:wght@400;600;700&display=swap">
<style>
:root{--paper:#E6EAE6;--card:#F5F7F4;--ink:#0F1C1C;--muted:#52615F;--line:#C3CBC6;--signal:#F2B600;--signal-ink:#1B1500;--bad:#B3261E}
@media (prefers-color-scheme:dark){:root{--paper:#0B1111;--card:#121C1C;--ink:#E7EDE8;--muted:#9BAAA6;--line:#2B3A38;--bad:#FF8A80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:16px/1.5 'Public Sans',system-ui,sans-serif;padding:16px}
.box{width:100%;max-width:420px;background:var(--card);border:3px solid var(--ink);padding:24px}
h1{font:900 44px/.9 'Big Shoulders Display',Impact,sans-serif;text-transform:uppercase;margin:0 0 6px}
p{color:var(--muted);margin:0 0 18px}label{display:block;font-weight:600;font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin:12px 0 4px}
input{width:100%;font:inherit;padding:12px;border:2px solid var(--line);background:var(--paper);color:var(--ink);border-radius:2px}
button{margin-top:18px;width:100%;font:900 22px 'Big Shoulders Display',Impact,sans-serif;text-transform:uppercase;letter-spacing:.04em;padding:12px;background:var(--signal);color:var(--signal-ink);border:3px solid var(--ink);cursor:pointer}
.err{color:var(--bad);font-weight:600;margin:0 0 8px}
</style></head><body><form class="box" method="post" action="/login">
<h1>ExF Event Manager</h1><p>Sign in with your name, work email and the team access code.</p>
${err ? '<p class="err">' + esc(err) + '</p>' : ''}
<label for="n">Your name</label><input id="n" name="name" autocomplete="name" required value="${esc(v.name || '')}">
<label for="e">Work email</label><input id="e" name="email" type="email" autocomplete="email" required value="${esc(v.email || '')}">
<label for="c">Access code</label><input id="c" name="code" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form></body></html>`;
app.get('/login', (req, res) => res.type('html').send(loginPage()));
app.post('/login', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const code = String(req.body.code || '');
  if (!limit('login:' + clientIp(req), 10, 15 * 60 * 1000)) return res.status(429).type('html').send(loginPage('Too many attempts. Wait a few minutes.', { name, email }));
  if (!name || !EMAIL_RX.test(email)) return res.status(400).type('html').send(loginPage('Enter your name and a valid email.', { name, email }));
  if (!ACCESS_CODE || !safeEq(code, ACCESS_CODE)) return res.status(401).type('html').send(loginPage('That access code is not right.', { name, email }));
  const id = userIdFor(email);
  await q(`insert into people(id,email,name) values($1,$2,$3)
           on conflict(id) do update set name=excluded.name,last_seen=now()`, [id, email, name]);
  res.setHeader('Set-Cookie', 'xc=' + encodeURIComponent(makeSession(id)) + '; Path=/; Max-Age=' + 90 * 86400 + '; HttpOnly; SameSite=Lax' + (req.secure ? '; Secure' : ''));
  res.redirect('/');
});
app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'xc=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); res.redirect('/login'); });

/* ---- the app (signed in) ---- */
app.get('/', auth, (req, res) => sendPage(res, 'app.html'));
app.get('/shim.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('js').sendFile(path.join(PUB, 'shim.js')); });
app.get('/manifest.json', (req, res) => res.json({ name: 'ExF Event Manager', short_name: 'ExF Events', start_url: '/', display: 'standalone', background_color: '#0F1C1C', theme_color: '#0F1C1C' }));

/* ---- API: identity ---- */
app.get('/api/me', auth, (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email, isOwner: req.user.isOwner }));
app.get('/api/people', auth, async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 64);
  const r = ids.length ? await q('select id,name from people where id = any($1)', [ids]) : { rows: [] };
  const out = {}; r.rows.forEach(p => { out[p.id] = { id: p.id, name: p.name, guest: false }; });
  res.json(out);
});
app.get('/api/people/search', auth, async (req, res) => {
  const s = '%' + String(req.query.q || '').trim().toLowerCase().replace(/[%_]/g, '') + '%';
  const r = await q('select id,name from people where lower(name) like $1 or lower(email) like $1 order by name limit 20', [s]);
  res.json(r.rows.map(p => ({ id: p.id, name: p.name })));
});

/* ---- API: database ---- */
app.get('/api/db/list', auth, async (req, res) => {
  const coll = String(req.query.coll || '');
  if (!validColl(coll)) return res.status(400).json({ error: 'bad collection' });
  const r = await q('select id,data,version from docs where coll=$1 order by created_at', [coll]);
  res.json(r.rows.map(d => ({ id: d.id, data: d.data, version: d.version })));
});
app.get('/api/db/doc', auth, async (req, res) => {
  const p = String(req.query.path || '');
  if (!validDoc(p)) return res.status(400).json({ error: 'bad path' });
  const r = await q('select data,version from docs where path=$1', [p]);
  if (!r.rows.length) return res.json({ exists: false });
  res.json({ exists: true, data: r.rows[0].data, version: r.rows[0].version });
});
app.put('/api/db/doc', auth, jsonBig, async (req, res) => {
  const p = String(req.query.path || '');
  if (!validDoc(p) || !isObj(req.body)) return res.status(400).json({ error: 'bad request' });
  const { coll, id } = splitPath(p);
  const r = await q(`insert into docs(path,coll,id,data) values($1,$2,$3,$4)
    on conflict(path) do update set data=excluded.data,version=docs.version+1,updated_at=now() returning version`, [p, coll, id, JSON.stringify(stripDeletes(req.body))]);
  broadcast(coll, p);
  res.json({ version: r.rows[0].version });
});
app.patch('/api/db/doc', auth, jsonBig, async (req, res) => {
  const p = String(req.query.path || '');
  if (!validDoc(p) || !isObj(req.body)) return res.status(400).json({ error: 'bad request' });
  const { coll } = splitPath(p);
  const c = await pool.connect();
  try {
    await c.query('begin');
    const cur = await c.query('select data,version from docs where path=$1 for update', [p]);
    if (!cur.rows.length) { await c.query('rollback'); return res.status(404).json({ error: 'not found' }); }
    const next = mergeDeep(cur.rows[0].data, req.body);
    const r = await c.query('update docs set data=$2,version=version+1,updated_at=now() where path=$1 returning version', [p, JSON.stringify(next)]);
    await c.query('commit');
    broadcast(coll, p);
    res.json({ version: r.rows[0].version });
  } catch (e) { try { await c.query('rollback'); } catch (_) {} throw e; } finally { c.release(); }
});
app.delete('/api/db/doc', auth, async (req, res) => {
  const p = String(req.query.path || '');
  if (!validDoc(p)) return res.status(400).json({ error: 'bad path' });
  await q('delete from docs where path=$1', [p]);
  broadcast(splitPath(p).coll, p);
  res.json({ ok: true });
});
app.get('/api/events', auth, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

/* ---- API: files (photos, PDFs) ---- */
const ALLOWED_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|text\/(csv|markdown|plain)|application\/json)$/;
app.post('/api/assets', auth, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.test(type)) return res.status(415).json({ error: 'unsupported_type', message: 'That file type is not supported.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty' });
  const id = rid(24);
  await q('insert into assets(id,type,size,data,owner) values($1,$2,$3,$4,$5)', [id, type, req.body.length, req.body, req.user.id]);
  res.json({ id, url: '/_blob/' + id, sizeBytes: req.body.length, contentType: type });
});
app.delete('/api/assets/:id', auth, async (req, res) => {
  await q('delete from assets where id=$1', [req.params.id]);
  res.json({ ok: true });
});
app.get('/_blob/:id', auth, async (req, res) => {
  const r = await q('select type,data from assets where id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).send('Not found');
  res.setHeader('Content-Type', r.rows[0].type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', 'inline');
  res.send(r.rows[0].data);
});

/* ---- API: Claude (card reading and schedule import) ---- */
async function callClaude({ prompt, images = [], system, maxTokens = 2500 }) {
  if (!ANTHROPIC_API_KEY) { const e = new Error('ANTHROPIC_API_KEY is not set on the server.'); e.code = 'not_configured'; throw e; }
  const content = [];
  for (const im of images.slice(0, 6)) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(im || '');
    if (!m) continue;
    if (m[1] === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: m[1], data: m[2] } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: prompt });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ('Claude API error ' + r.status)); e.code = 'api_error'; throw e; }
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function parseJsonLoose(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.search(/[\[{]/); if (a < 0) throw new Error('invalid_json');
  const open = t[a], close = open === '{' ? '}' : ']';
  const b = t.lastIndexOf(close);
  return JSON.parse(t.slice(a, b + 1));
}
app.post('/api/sample', auth, jsonBig, async (req, res) => {
  try {
    const { input, images, json } = req.body || {};
    const text = await callClaude({ prompt: String(input || '').slice(0, 60000), images: Array.isArray(images) ? images : [], system: json ? 'Reply with JSON only, no commentary, no code fences.' : undefined });
    if (json) { try { return res.json({ json: parseJsonLoose(text) }); } catch (e) { return res.status(422).json({ error: 'invalid_json', text }); } }
    res.json({ text });
  } catch (e) { res.status(e.code === 'not_configured' ? 501 : 502).json({ error: e.code || 'error', message: e.message }); }
});

/* ---- short links that pre-fill the partner form ---- */
const PREFILL_KEYS = ['c', 'k', 'w', 'n', 't', 'e', 'p', 'x'];
app.post('/api/links', auth, jsonBig, async (req, res) => {
  const cid = String(req.body && req.body.cid || '').slice(0, 100);
  const data = {};
  if (isObj(req.body && req.body.data)) PREFILL_KEYS.forEach(k => { if (req.body.data[k]) data[k] = String(req.body.data[k]).slice(0, 600); });
  if (!cid) return res.status(400).json({ error: 'cid' });
  const code = rid(8);
  const r = await q(`insert into links(code,cid,data) values($1,$2,$3)
    on conflict(cid) do update set data=excluded.data returning code`, [code, cid, JSON.stringify(data)]);
  res.json({ code: r.rows[0].code, url: baseUrl(req) + '/p/' + r.rows[0].code });
});

/* ---- public: partner interest form ---- */
app.get('/partner', (req, res) => sendPage(res, 'partner.html'));
app.get('/p/:code', (req, res) => sendPage(res, 'partner.html'));
app.get('/api/public/prefill/:code', async (req, res) => {
  if (!limit('pf:' + clientIp(req), 60, 36e5)) return res.status(429).json({});
  const r = await q('select data from links where code=$1', [String(req.params.code).slice(0, 20)]);
  res.json(r.rows.length ? r.rows[0].data : {});
});
const CARD_PROMPT = 'Read this business card image. Return JSON with exactly these string keys: company, website, name, title, email, phone, country. Use an empty string for anything not printed on the card. Do not guess.';
app.post('/api/public/card', jsonBig, async (req, res) => {
  if (!limit('card:' + clientIp(req), 12, 36e5)) return res.status(429).json({ error: 'rate_limited' });
  const image = req.body && req.body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 1.5e6) return res.status(400).json({ error: 'bad image' });
  try {
    const text = await callClaude({ prompt: CARD_PROMPT, images: [image], system: 'Reply with JSON only, no commentary, no code fences.', maxTokens: 500 });
    const o = parseJsonLoose(text), out = {};
    ['company', 'website', 'name', 'title', 'email', 'phone', 'country'].forEach(k => { out[k] = String(o[k] || '').slice(0, 300); });
    res.json(out);
  } catch (e) { res.status(502).json({ error: 'read_failed' }); }
});

const MODE_LABEL = { 'AIR-FIRST': 'Air first mile', 'AIR-FINAL': 'Air final mile', 'LCL-FIRST': 'LCL first mile', 'LCL-FINAL': 'LCL final mile', 'FCL-FIRST': 'FCL first mile', 'FCL-FINAL': 'FCL final mile' };
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const arrStr = (v, n, m) => (Array.isArray(v) ? v : []).map(x => str(x, m)).filter(Boolean).slice(0, n);
const yn = v => (v === 'yes' || v === 'no') ? v : '';

function cleanPartner(b) {
  const r = {
    company: str(b.company, 200), hqCountry: str(b.hqCountry, 4).toUpperCase(), website: str(b.website, 300), details: str(b.details, 4000),
    contactName: str(b.contactName, 200), jobTitle: str(b.jobTitle, 200), email: str(b.email, 200).toLowerCase(), phone: str(b.phone, 80),
    markets: arrStr(b.markets, 300, 4), modes: arrStr(b.modes, 6, 12).filter(m => MODE_LABEL[m]),
    tms: arrStr(b.tms, 10, 40), tmsOther: str(b.tmsOther, 200), iataCertified: yn(b.iataCertified), fmcHbl: yn(b.fmcHbl),
    hqName: str(b.hqName, 80), marketNames: arrStr(b.marketNames, 300, 80), laneNames: arrStr(b.laneNames, 300, 80),
    ownConsolBox: yn(b.ownConsolBox), tradeLanes: arrStr(b.tradeLanes, 300, 4), customsBroker: yn(b.customsBroker), wantsDemo: !!b.wantsDemo
  };
  return r;
}
function partnerText(r, link) {
  return ['ExFreight partner interest' + (r.wantsDemo ? '  (DEMO REQUESTED)' : ''), '',
    'Company: ' + r.company, 'HQ: ' + (r.hqName || r.hqCountry), 'Website: ' + (r.website || '-'), 'Details: ' + (r.details || '-'), '',
    'Contact: ' + r.contactName + ', ' + r.jobTitle, 'Email: ' + r.email, 'Phone: ' + (r.phone || '-'), '',
    'Markets of interest: ' + ((r.marketNames.length ? r.marketNames : r.markets).join(', ') || '-'),
    'Modes: ' + (r.modes.map(m => MODE_LABEL[m]).join(', ') || '-'),
    'IATA certified: ' + (r.iataCertified || '-'), 'FMC certified, can issue a HBL: ' + (r.fmcHbl || '-'),
    'Own consolidation box: ' + (r.ownConsolBox || '-'), 'Trade lanes: ' + ((r.laneNames.length ? r.laneNames : r.tradeLanes).join(', ') || '-'),
    'Licensed customs broker: ' + (r.customsBroker || '-'),
    'Current TMS: ' + ((r.tms.join(', ') + (r.tmsOther ? ' (' + r.tmsOther + ')' : '')) || '-'),
    'Demo of ExFresso and the ExFreight Partner Portal: ' + (r.wantsDemo ? 'YES' : 'No'), '', 'Record: ' + link].join('\n');
}
async function sendNotify(req, r, id, cardImage, isUpdate) {
  const link = baseUrl(req) + '/admin/r/' + id;
  const text = partnerText(r, link);
  if (!RESEND_API_KEY) { console.log('[email skipped: RESEND_API_KEY not set]\n' + text); return; }
  const body = {
    from: MAIL_FROM, to: [NOTIFY_EMAIL], reply_to: r.email,
    subject: (r.wantsDemo ? 'DEMO REQUEST: ' : '') + (isUpdate ? 'Updated partner interest: ' : 'New partner interest: ') + r.company,
    text,
    html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5"><pre style="font:inherit;white-space:pre-wrap">' + esc(text.replace(/\n\nRecord: .*$/s, '')) + '</pre><p><a href="' + esc(link) + '">Open the record</a></p></div>'
  };
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(cardImage || '');
  if (m) body.attachments = [{ filename: 'business-card.' + (m[1] === 'jpeg' ? 'jpg' : m[1]), content: m[2] }];
  const resp = await fetch(process.env.RESEND_URL || 'https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) console.error('Resend error', resp.status, await resp.text().catch(() => ''));
}
app.post('/api/public/partner', jsonBig, async (req, res) => {
  if (!limit('sub:' + clientIp(req), 20, 36e5)) return res.status(429).json({ error: 'rate_limited' });
  const b = req.body || {};
  const r = cleanPartner(b);
  if (!r.company || !r.contactName || !r.jobTitle || !r.hqCountry || !EMAIL_RX.test(r.email) || !r.markets.length || !r.modes.length) return res.status(400).json({ error: 'missing fields' });
  let card = typeof b.cardImage === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.cardImage) && b.cardImage.length < 500000 ? b.cardImage : '';
  const search = [r.company, r.contactName, r.jobTitle, r.email, r.phone, r.website, r.details, r.hqCountry, r.hqName, r.markets.join(' '), r.marketNames.join(' '), r.tradeLanes.join(' '), r.laneNames.join(' '), r.tms.join(' '), r.tmsOther,
    r.iataCertified === 'yes' ? 'iata certified' : '', r.fmcHbl === 'yes' ? 'fmc hbl' : '', r.customsBroker === 'yes' ? 'licensed customs broker' : '', r.wantsDemo ? 'demo requested' : ''].join(' ').toLowerCase();
  const key = r.email;
  const id = b64u(crypto.createHash('sha256').update(key).digest()).slice(0, 16);
  const old = await q('select card_image,submissions from partner where email_key=$1', [key]);
  const isUpdate = old.rows.length > 0;
  if (isUpdate) {
    await q('update partner set data=$2,search_text=$3,card_image=$4,submissions=submissions+1,updated_at=now() where email_key=$1', [key, JSON.stringify(r), search, card || old.rows[0].card_image]);
  } else {
    await q('insert into partner(id,email_key,data,search_text,card_image) values($1,$2,$3,$4,$5)', [id, key, JSON.stringify(r), search, card || null]);
  }
  /* mark any matching contact in the Event Manager as "Partner interest form returned" */
  try {
    const u = await q(`update docs set data = data || $2::jsonb, version=version+1, updated_at=now()
      where coll='contacts' and lower(data->>'email')=$1 returning path`, [key, JSON.stringify({ formReturned: true, formReturnedAt: Date.now() })]);
    u.rows.forEach(x => broadcast('contacts', x.path));
  } catch (e) { console.error('contact flag failed', e.message); }
  sendNotify(req, r, id, card || (old.rows[0] && old.rows[0].card_image), isUpdate).catch(e => console.error('notify failed', e.message));
  res.json({ ok: true });
});

/* ---- admin: partner submissions (password) ---- */
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('ADMIN_PASSWORD is not set.');
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [, pw] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
    if (pw && safeEq(pw, ADMIN_PASSWORD)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Partner submissions"');
  res.status(401).send('Password required');
}
const adminShell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,Segoe UI,sans-serif;margin:0;background:#f5f6fa;color:#1b1d2b}main{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:22px}a{color:#2c3b95}table{width:100%;border-collapse:collapse;background:#fff}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e1e4ee;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#5b6078}.tag{display:inline-block;background:#be2227;color:#fff;border-radius:3px;padding:1px 6px;font-size:12px;font-weight:700}
input[type=search]{padding:9px;border:1px solid #c9cde0;border-radius:4px;width:min(420px,100%)}button,.btn{padding:9px 14px;border:0;border-radius:4px;background:#2c3b95;color:#fff;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;background:#fff;padding:16px;border-radius:4px}dt{color:#5b6078}dd{margin:0}img{max-width:100%;border-radius:4px;border:1px solid #d9dce8}
</style></head><body><main>${body}</main></body></html>`;
app.get('/admin', adminAuth, async (req, res) => {
  const term = String(req.query.q || '').trim().toLowerCase();
  const demo = req.query.demo === '1';
  const params = []; const where = [];
  if (term) { params.push('%' + term.replace(/[%_]/g, '') + '%'); where.push('search_text like $' + params.length); }
  if (demo) where.push("(data->>'wantsDemo')::boolean is true");
  const r = await q('select id,data,submissions,created_at,updated_at from partner' + (where.length ? ' where ' + where.join(' and ') : '') + ' order by updated_at desc limit 500', params);
  const rows = r.rows.map(x => `<tr><td><a href="/admin/r/${esc(x.id)}">${esc(x.data.company)}</a>${x.data.wantsDemo ? ' <span class="tag">DEMO</span>' : ''}</td><td>${esc(x.data.contactName)}<br><small>${esc(x.data.email)}</small></td><td>${esc(x.data.hqCountry)}</td><td>${esc((x.data.modes || []).join(', '))}</td><td><small>${esc(new Date(x.updated_at).toISOString().slice(0, 10))}${x.submissions > 1 ? ' (x' + x.submissions + ')' : ''}</small></td></tr>`).join('');
  res.type('html').send(adminShell('Partner submissions', `<h1>Partner interest submissions (${r.rows.length})</h1>
  <form method="get" style="margin:0 0 12px"><input type="search" name="q" value="${esc(term)}" placeholder="Search company, name, email, country, TMS..."> <label><input type="checkbox" name="demo" value="1" ${demo ? 'checked' : ''}> Demo requested only</label> <button>Search</button> <a class="btn" href="/admin/export.csv${term ? '?q=' + encodeURIComponent(term) : ''}">Export CSV</a></form>
  <table><thead><tr><th>Company</th><th>Contact</th><th>HQ</th><th>Modes</th><th>Updated</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No submissions yet.</td></tr>'}</tbody></table>`));
});
app.get('/admin/r/:id', adminAuth, async (req, res) => {
  const r = await q('select id,data,card_image,submissions,created_at,updated_at from partner where id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).send('Not found');
  const x = r.rows[0], d = x.data;
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v || '-')}</dd>`;
  res.type('html').send(adminShell(d.company, `<p><a href="/admin">&larr; All submissions</a></p><h1>${esc(d.company)} ${d.wantsDemo ? '<span class="tag">DEMO REQUESTED</span>' : ''}</h1>
  <dl>${row('Contact', d.contactName + ', ' + d.jobTitle)}${row('Email', d.email)}${row('Phone', d.phone)}${row('HQ', d.hqName || d.hqCountry)}${row('Website', d.website)}${row('Details', d.details)}
  ${row('Markets of interest', (d.marketNames && d.marketNames.length ? d.marketNames : d.markets || []).join(', '))}${row('Modes', (d.modes || []).map(m => MODE_LABEL[m]).join(', '))}${row('IATA certified', d.iataCertified)}${row('FMC certified, can issue a HBL', d.fmcHbl)}
  ${row('Own consolidation box', d.ownConsolBox)}${row('Trade lanes', (d.laneNames && d.laneNames.length ? d.laneNames : d.tradeLanes || []).join(', '))}${row('Licensed customs broker', d.customsBroker)}${row('Current TMS', (d.tms || []).join(', ') + (d.tmsOther ? ' (' + d.tmsOther + ')' : ''))}
  ${row('Demo requested', d.wantsDemo ? 'YES' : 'No')}${row('First submitted', new Date(x.created_at).toISOString())}${row('Last updated', new Date(x.updated_at).toISOString())}${row('Submissions', String(x.submissions))}</dl>
  ${x.card_image ? '<h2>Business card</h2><img alt="Business card" src="/admin/card/' + esc(x.id) + '" style="max-width:420px">' : ''}
  <p><a class="btn" href="mailto:${esc(d.email)}?subject=${encodeURIComponent('ExFreight Partner Interest')}">Reply by email</a></p>`));
});
app.get('/admin/card/:id', adminAuth, async (req, res) => {
  const r = await q('select card_image from partner where id=$1', [req.params.id]);
  const m = r.rows.length && /^data:(image\/[a-z]+);base64,(.+)$/s.exec(r.rows[0].card_image || '');
  if (!m) return res.status(404).send('No card');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
});
app.get('/admin/export.csv', adminAuth, async (req, res) => {
  const term = String(req.query.q || '').trim().toLowerCase();
  const r = term ? await q('select data,created_at,updated_at from partner where search_text like $1 order by updated_at desc', ['%' + term.replace(/[%_]/g, '') + '%']) : await q('select data,created_at,updated_at from partner order by updated_at desc');
  const cell = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['Company', 'Contact', 'Title', 'Email', 'Phone', 'HQ', 'Website', 'Markets', 'Modes', 'IATA certified', 'FMC HBL', 'Own consol box', 'Trade lanes', 'Customs broker', 'TMS', 'Demo requested', 'First submitted', 'Last updated', 'Details'];
  const lines = [head].concat(r.rows.map(({ data: d, created_at, updated_at }) => [d.company, d.contactName, d.jobTitle, d.email, d.phone, d.hqCountry, d.website, (d.markets || []).join(' '), (d.modes || []).join(' '), d.iataCertified, d.fmcHbl, d.ownConsolBox, (d.tradeLanes || []).join(' '), d.customsBroker, (d.tms || []).join(' ') + (d.tmsOther ? ' ' + d.tmsOther : ''), d.wantsDemo ? 'yes' : 'no', new Date(created_at).toISOString(), new Date(updated_at).toISOString(), d.details]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="partner-submissions.csv"');
  res.send('﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n'));
});

/* ---- errors ---- */
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(err.status || 500).json({ error: 'server', message: err.type === 'entity.too.large' ? 'Too large.' : 'Server error.' });
  res.status(500).send('Server error');
});
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

initDb().then(() => app.listen(PORT, () => console.log('Listening on ' + PORT))).catch(e => { console.error('DB init failed', e); process.exit(1); });
