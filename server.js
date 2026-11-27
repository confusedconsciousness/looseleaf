// Looseleaf server: static files, sign-in, sessions API, live sync (needs Node 22.5+).
// Node built-ins only, plus `pg` when DATABASE_URL points at Postgres.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = +process.env.PORT || 4322;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.PASSWORD || '';
const MAX_BODY = 25 * 1024 * 1024;
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'] };

/* ---------- storage ---------- */

// One query function, two stores: Postgres when DATABASE_URL is set (hosting), otherwise a local
// SQLite file (no setup). Queries are written for Postgres; SQLite reads `$1` as `?1`.
let q;
if (process.env.DATABASE_URL) {
  const pg = require('pg');
  pg.types.setTypeParser(20, Number); // BIGINT timestamps arrive as numbers, not strings
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  q = async (sql, params = []) => (await pool.query(sql, params)).rows;
} else {
  const { DatabaseSync } = require('node:sqlite');
  const lite = new DatabaseSync(process.env.DB || path.join(__dirname, 'looseleaf.db'));
  q = async (sql, params = []) => {
    const st = lite.prepare(sql.replace(/\$(\d+)/g, '?$1'));
    return /^\s*SELECT/i.test(sql) ? st.all(...params) : (st.run(...params), []);
  };
}
// ponytail: each scene is one JSON text column, images included; move images to their own table
// (or object storage) when scenes with many images make every save slow.
const ready = q(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT '{"elements":[],"files":{}}',
  created BIGINT NOT NULL, updated BIGINT NOT NULL)`);

// A save reads, merges, then writes. The database calls are async, so saves run one at a time;
// otherwise two devices saving at once could each overwrite the other's merge.
// ponytail: one in-process queue. With more than one server instance, use a transaction with
// SELECT ... FOR UPDATE instead.
let tail = Promise.resolve();
const serial = (fn) => (tail = tail.then(fn, fn));

// Element-level last-writer-wins, the rule Excalidraw's own collab uses: the higher `version`
// wins, ties go to the lower `versionNonce`. Deletes arrive as tombstones (isDeleted), so they
// merge the same way. Returns null when nothing changed, so no-op saves don't echo to clients.
// ponytail: tombstones are kept forever; prune isDeleted elements older than a day if scenes bloat.
function merge(stored, incoming) {
  const byId = new Map(stored.map((e) => [e.id, e]));
  let changed = false;
  for (const e of incoming) {
    const old = byId.get(e.id);
    if (!old || e.version > old.version || (e.version === old.version && e.versionNonce < old.versionNonce)) {
      byId.set(e.id, e);
      changed = true;
    }
  }
  if (!changed) return null;
  // `index` is Excalidraw's fractional z-order key; plain string order is what it uses too.
  return [...byId.values()].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function validate(body) {
  if (!isObj(body)) return 'body must be an object';
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80)) return 'name must be 1-80 characters';
  if ('elements' in body && !(Array.isArray(body.elements) && body.elements.every((e) => isObj(e) && typeof e.id === 'string' && Number.isFinite(e.version)))) return 'elements must be Excalidraw elements';
  if ('files' in body && !isObj(body.files)) return 'files must be an object';
  return null;
}

/* ---------- sign-in ---------- */

// One password, one owner. Signing in sets a cookie holding an expiry time signed with a key
// derived from the password: nothing to store, it survives restarts, and changing the password
// signs every device out.
const MONTH = 30 * 24 * 60 * 60;
const KEY = crypto.createHash('sha256').update('looseleaf session ' + PASSWORD).digest();
const sign = (exp) => exp + '.' + crypto.createHmac('sha256', KEY).update(String(exp)).digest('base64url');
const same = (a, b) => {
  const hash = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
};
function authed(req) {
  if (!PASSWORD) return true; // local use: the server only listens on this machine
  const token = /(?:^|; )looseleaf=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
  const exp = +token.split('.')[0];
  return exp > Date.now() && same(token, sign(exp));
}
const cookie = (req, value, maxAge) =>
  `looseleaf=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

// ponytail: one global count of wrong passwords, so a burst of guesses also blocks you from
// signing in on a new device for 15 minutes (devices already signed in keep working). Count per
// IP once the proxy in front is known and its forwarded address can be trusted.
let fails = [];

/* ---------- http ---------- */

const clients = new Set(); // open SSE responses
function broadcast(msg) {
  for (const res of clients) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Requiring JSON forces a CORS preflight, so another site's page can't post here.
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new Error('content-type must be application/json'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function send(res, status, body, headers) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  await ready;
  const url = new URL(req.url, 'http://x');
  const now = Date.now();

  // The page and script are public (they hold no data); everything under /api needs the cookie.
  const file = STATIC[url.pathname];
  if (req.method === 'GET' && file) {
    res.writeHead(200, { 'content-type': file[1] + '; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, file[0])).pipe(res);
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    fails = fails.filter((t) => t > now - 15 * 60 * 1000);
    if (fails.length >= 10) return send(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
    if (PASSWORD && !same(String(body?.password ?? ''), PASSWORD)) {
      fails.push(now);
      return send(res, 403, { error: 'Wrong password' });
    }
    return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, sign(now + MONTH * 1000), MONTH) });
  }
  if (url.pathname === '/api/login' && req.method === 'DELETE') {
    return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, '', 0) });
  }
  if (!authed(req)) return send(res, 401, { error: 'sign in first' });

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': hello\n\n');
    clients.add(res);
    const beat = setInterval(() => res.write(': beat\n\n'), 25000); // keeps proxies from closing it
    return req.on('close', () => { clearInterval(beat); clients.delete(res); });
  }

  const m = url.pathname.match(/^\/api\/sessions(?:\/([\w-]+))?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const id = m[1];
  const find = async () => (await q('SELECT * FROM sessions WHERE id = $1', [id]))[0];

  if (!id && req.method === 'GET') {
    return send(res, 200, await q('SELECT id, name, updated FROM sessions ORDER BY created DESC'));
  }
  if (!id && req.method === 'POST') {
    const body = await readJson(req);
    const bad = validate(body);
    if (bad) return send(res, 400, { error: bad });
    const made = { id: crypto.randomUUID(), name: (body.name || 'Untitled').trim(), updated: now };
    await q('INSERT INTO sessions (id, name, created, updated) VALUES ($1, $2, $3, $3)', [made.id, made.name, now]);
    broadcast({ type: 'list', client: body.client });
    return send(res, 201, made);
  }
  if (id && req.method === 'GET') {
    const row = await find();
    if (!row) return send(res, 404, { error: 'no such session' });
    return send(res, 200, { id, name: row.name, updated: row.updated, ...JSON.parse(row.scene) });
  }
  if (id && req.method === 'DELETE') {
    await q('DELETE FROM sessions WHERE id = $1', [id]);
    broadcast({ type: 'list', client: url.searchParams.get('client') });
    return send(res, 200, { ok: true });
  }
  if (id && req.method === 'PUT') {
    const body = await readJson(req);
    const bad = validate(body);
    if (bad) return send(res, 400, { error: bad });
    return serial(async () => {
      const row = await find();
      if (!row) return send(res, 404, { error: 'no such session' });
      let updated = row.updated; // sent back so a device can tell when the server's copy has moved on
      if (body.name && body.name.trim() !== row.name) {
        await q('UPDATE sessions SET name = $1, updated = $2 WHERE id = $3', [body.name.trim(), now, id]);
        broadcast({ type: 'list', client: body.client });
        updated = now;
      }
      const scene = JSON.parse(row.scene);
      const elements = body.elements && merge(scene.elements, body.elements);
      const newFiles = Object.keys(body.files || {}).filter((k) => !scene.files[k]);
      if (elements || newFiles.length) {
        for (const k of newFiles) scene.files[k] = body.files[k];
        await q('UPDATE sessions SET scene = $1, updated = $2 WHERE id = $3',
          [JSON.stringify({ elements: elements || scene.elements, files: scene.files }), now, id]);
        broadcast({ type: 'scene', id, client: body.client });
        updated = now;
      }
      send(res, 200, { ok: true, updated });
    });
  }
  send(res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { if (!res.headersSent) send(res, 400, { error: e.message }); else res.end(); });
});

if (require.main === module) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && PASSWORD.length < 12) {
    console.error('Refusing to listen on ' + HOST + ' without a password of at least 12 characters. Set PASSWORD=...');
    process.exit(1);
  }
  // Hosts wipe their disk on every restart, so the SQLite fallback there would lose every
  // drawing without a word. Better not to start at all.
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !process.env.DATABASE_URL) {
    console.error('Refusing to listen on ' + HOST + ' without DATABASE_URL: a hosted server must store drawings in Postgres.');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => console.log(`Looseleaf on http://${HOST}:${PORT} (${process.env.DATABASE_URL ? 'Postgres' : 'SQLite'}${PASSWORD ? ', sign-in on' : ''})`));
}

module.exports = { merge, validate, server };
