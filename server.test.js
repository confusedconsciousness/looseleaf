// node --test            runs against an in-memory SQLite database
// DATABASE_URL=postgres://... node --test    runs the same checks against Postgres
if (!process.env.DATABASE_URL) process.env.DB = ':memory:';
process.env.PASSWORD = 'correct horse battery';
const test = require('node:test');
const assert = require('node:assert');
const { merge, validate, server } = require('./server.js');

const el = (id, version, extra = {}) => ({ id, version, versionNonce: 1, index: id, ...extra });

test('merge keeps the newer version of each element and both devices\' additions', () => {
  const out = merge([el('a', 2), el('b', 1)], [el('a', 1, { stale: true }), el('b', 3, { isDeleted: true }), el('c', 1)]);
  assert.deepEqual(out.map((e) => [e.id, e.version]), [['a', 2], ['b', 3], ['c', 1]]);
  assert.equal(out[0].stale, undefined);
  assert.equal(out[1].isDeleted, true); // a delete is a newer version, so it wins
});

test('merge reports no change so saves that add nothing are not rebroadcast', () => {
  assert.equal(merge([el('a', 2)], [el('a', 2), el('a', 1)]), null);
});

test('validate rejects junk', () => {
  assert.ok(validate({ name: '' }));
  assert.ok(validate({ elements: [{ id: 1 }] }));
  assert.equal(validate({ name: 'ok', elements: [el('a', 1)], files: {} }), null);
});

test('sign-in guards the API, and two devices saving the same session both keep their work', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/api/sessions';
  let cookie = '';
  const req = (method, url, body, headers = { 'content-type': 'application/json' }) =>
    fetch(url, { method, headers: { ...headers, cookie }, body: body && JSON.stringify(body) });
  const json = (...a) => req(...a).then((r) => r.json());
  try {
    assert.equal((await req('GET', origin + '/')).status, 200); // the page itself is public
    assert.equal((await req('GET', base)).status, 401);
    assert.equal((await req('GET', base, null, { cookie: 'looseleaf=99999999999999.forged' })).status, 401);
    assert.equal((await req('POST', origin + '/api/login', { password: 'nope' })).status, 403);
    const login = await req('POST', origin + '/api/login', { password: process.env.PASSWORD });
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);

    const s = await json('POST', base, { name: 'Design' });
    assert.equal(typeof s.updated, 'number');
    // Sent at the same moment: device B never saw 'a', yet neither save may clobber the other.
    await Promise.all([json('PUT', base + '/' + s.id, { elements: [el('a', 1)] }), json('PUT', base + '/' + s.id, { elements: [el('b', 1)] })]);
    const put = await json('PUT', base + '/' + s.id, { name: 'Design v2', files: { f1: { id: 'f1' } } });
    // A save that changes nothing must not move `updated`, or every device would refetch for nothing.
    assert.deepEqual(await json('PUT', base + '/' + s.id, { elements: [el('a', 1)] }), { ok: true, updated: put.updated });
    const got = await json('GET', base + '/' + s.id);
    assert.deepEqual(got.elements.map((e) => e.id), ['a', 'b']);
    assert.deepEqual([got.name, Object.keys(got.files)], ['Design v2', ['f1']]);
    assert.equal((await json('GET', base)).find((x) => x.id === s.id).updated, put.updated); // list, scene and save agree
    assert.equal(got.updated, put.updated);
    assert.equal((await req('POST', base, {}, {})).status, 400); // no JSON content-type
    assert.equal((await req('DELETE', base + '/' + s.id)).status, 200);
    assert.equal((await req('GET', base + '/' + s.id)).status, 404);

    for (let i = 0; i < 9; i++) await req('POST', origin + '/api/login', { password: 'guess' + i });
    assert.equal((await req('POST', origin + '/api/login', { password: process.env.PASSWORD })).status, 429); // 10 wrong: locked
  } finally {
    server.close();
  }
});
