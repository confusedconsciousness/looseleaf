// Looseleaf client: a sessions sidebar around the Excalidraw editor, synced through the server.
// Organised top to bottom: state → server calls → sync (outbox / flush / pull / check) → sessions → sidebar → events.
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, MainMenu, reconcileElements, CaptureUpdateAction } from '@excalidraw/excalidraw';

const $ = (id) => document.getElementById(id);
const client = Math.random().toString(36).slice(2); // tags our writes so the event stream can skip them
const root = createRoot($('canvas'));
const narrow = () => innerWidth < 700;
// A scene's version is the sum of its elements' versions: any edit, delete or undo raises it.
const version = (els) => els.reduce((n, e) => n + e.version, 0);

let sessions = [];    // [{ id, name, updated }]
let cur = null;       // id of the open session
let api = null;       // Excalidraw's imperative API for the open session
let theme = 'light';
let library = [];     // Excalidraw library items, shared by every session on this device
let pendingLib = '';  // a library URL waiting for the editor to mount

// Looseleaf is local-first: the editor never waits for the network. Each session opened on this
// device is kept in `docs` with, per element, the version the server has confirmed (`acked`).
// An element whose version differs from that is unsent work. What is unsent is never tracked by
// a flag that could go stale: it is recomputed from the editor and `acked` every time.
const docs = new Map();  // id -> { elements, files, acked: Map<elementId, version>, sentFiles: Set, updated }
let seen = 0;            // scene version at the last onChange, to notice an edit cheaply
let nfiles = 0;          // image count at the last onChange
let timer = 0;           // the next check for a pause in drawing
let edited = 0;          // when the scene last changed
let due = 0;             // while drawing without a pause, send by this time anyway
let sending = false;     // a flush is running
let again = false;       // another flush was asked for while one was running
let failing = false;     // the last flush could not reach the server
let ready = false;       // the open editor has loaded its scene (before that it reports an empty one)
let pullWhenReady = false;
let fit = false;         // the open session still needs its first zoom-to-fit
let unsyncedSince = 0;   // when the oldest work still unsent was first noticed (0: all on the server)
let unstored = false;    // unsent work could not be written to this device's storage either
let leaving = false;     // the tab is closing

// Per-device memory, in localStorage: where you were looking in each session, and tool settings.
const PREFS = /^currentItem|^(objectsSnapModeEnabled|gridModeEnabled|gridSize|gridStep|bindingPreference|isMidpointSnappingEnabled|preferredSelectionTool|boxSelectionMode|minimapEnabled|penMode)$/;
let views = {};       // session id -> { scrollX, scrollY, zoom }
let prefs = {};       // editor settings matching PREFS

// Excalidraw draws selection outlines and arrow handles on its "interactive" canvas in a purple
// that is hard-coded in its source, with no setting for it. So recolour at the canvas itself: any
// blue-to-purple colour set on that canvas becomes the theme's accent instead. Your drawing is
// painted on a different canvas, so purple shapes you draw are untouched.
// ponytail: this patches CanvasRenderingContext2D for the whole page. Remove it once Excalidraw
// exposes these colours as theme variables.
const ACCENT = { dark: '255,225,26', light: '176,132,0' }; // yellow on ink; amber on white, where yellow is invisible
const tints = new Map();
function retint(c) {
  const key = theme + c;
  if (tints.has(key)) return tints.get(key);
  let m, r, g, b, a = 1, out = c;
  if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c))) {
    [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    if (m[2]) a = parseInt(m[2], 16) / 255;
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) {
    [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  }
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread >= 40 && b === Math.max(r, g, b)) { // not a grey, and blue is its strongest channel
    const hue = 240 + (60 * (r - g)) / spread;
    if (hue >= 205 && hue <= 285) out = `rgba(${ACCENT[theme]},${a})`;
  }
  tints.set(key, out);
  return out;
}
for (const prop of ['strokeStyle', 'fillStyle']) {
  const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, prop);
  Object.defineProperty(CanvasRenderingContext2D.prototype, prop, {
    ...d,
    set(v) {
      d.set.call(this, typeof v === 'string' && this.canvas.classList?.contains('interactive') ? retint(v) : v);
    },
  });
}

const STATUS = { synced: 'Synced', saving: 'Saving…', offline: 'Offline. Retrying…' };
function status(s) {
  $('status').dataset.s = s;
  $('status').textContent = STATUS[s];
}
// The footer says where saving stands. The footer is easy to miss for hours (and hidden when the
// sidebar is shut), so if nothing has reached the server for 15 seconds a small cloud-off icon
// appears over the canvas too; tapping it says what that means.
function show() {
  const left = pending();
  unsyncedSince = left ? unsyncedSince || Date.now() : 0;
  status(!left ? 'synced' : failing ? 'offline' : 'saving');
  const mins = Math.floor((Date.now() - unsyncedSince) / 60000);
  $('alarm').hidden = !left || Date.now() - unsyncedSince < 15000;
  if ($('alarm').hidden && $('alarm-msg').matches(':popover-open')) $('alarm-msg').hidePopover();
  $('alarm-msg').textContent = (mins ? `Not synced for ${mins} min. ` : 'Not synced yet. ') + (unstored
    ? 'These changes exist only in this tab: keep it open until this message goes away.'
    : 'Your changes are stored on this device and will sync when the server is reachable. They are not on your other devices yet.');
}

// Every request has a deadline. Without one, a request stranded by a sleeping laptop or a dropped
// connection never finishes, and everything queued behind it waits forever.
async function call(method, url, body) {
  const json = body && JSON.stringify({ ...body, client });
  const res = await fetch(url, {
    method,
    headers: body && { 'content-type': 'application/json' },
    body: json,
    signal: AbortSignal.timeout(45000),
    keepalive: !!json && json.length < 60000 && (leaving || document.hidden), // lets a last small save outlive the tab
  });
  if (res.status === 401 && !$('login').open) $('login').showModal(); // not signed in on this device
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || res.statusText), { status: res.status });
  return res.json();
}
// Event handlers run through this so a dropped connection shows in the status line, not the console.
const safe = (fn) => (...a) => Promise.resolve(fn(...a)).catch(() => status('offline'));

/* ---------- sync ---------- */

const loading = new Map(); // downloads in flight, so a preload and a click share one request
function load(id) {
  if (!loading.has(id)) loading.set(id, call('GET', '/api/sessions/' + id).finally(() => loading.delete(id)));
  return loading.get(id);
}

// Takes a scene from the server as this device's copy: everything in it is confirmed.
function adopt(id, s) {
  const d = { elements: s.elements, files: s.files, acked: new Map(s.elements.map((e) => [e.id, e.version])), sentFiles: new Set(Object.keys(s.files)), updated: s.updated };
  docs.set(id, d);
  return d;
}
const unsent = (d) => d.elements.filter((e) => d.acked.get(e.id) !== e.version);
const newFiles = (d) => Object.fromEntries(Object.entries(d.files).filter(([k]) => !d.sentFiles.has(k)));
const owes = (d) => unsent(d).length > 0 || Object.keys(newFiles(d)).length > 0;
const pending = () => [...docs.values()].some(owes);

// Copies the editor's scene, view and settings into this device's memory. Only from an editor
// that has finished loading: while it loads, its scene is empty, and copying that would make
// unsent work look as if it had never been drawn.
function snapshot() {
  const d = ready && api && docs.get(cur);
  if (!d) return;
  d.elements = api.getSceneElementsIncludingDeleted();
  d.files = api.getFiles();
  const st = api.getAppState();
  if (!fit) views[cur] = { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom };
  prefs = Object.fromEntries(Object.entries(st).filter(([k]) => PREFS.test(k)));
  keep('views', Object.fromEntries(sessions.filter((s) => views[s.id]).map((s) => [s.id, views[s.id]])));
  keep('prefs', prefs);
}
// Writes to localStorage only when the value changed (null removes it). False if it didn't fit.
const kept = {};
function keep(k, v) {
  const json = v == null ? null : JSON.stringify(v);
  if ((kept[k] ?? null) === json) return true;
  try {
    if (json == null) localStorage.removeItem(k);
    else localStorage.setItem(k, json);
    kept[k] = json;
    return true;
  } catch {
    return false;
  }
}

// The outbox. Unsent work is also written to this device's storage, so it survives a reload, a
// crash, a discarded tab or a closed laptop, and is sent the next time Looseleaf opens here.
// ponytail: localStorage holds about 5 MB, so a large unsent image may not fit; then the banner
// says the work exists only in this tab. Move the outbox to IndexedDB to lift that.
const boxKey = (id) => `unsent:${id}:${client}`;
function stash() {
  unstored = false;
  for (const [id, d] of docs) {
    const box = owes(d) ? { name: sessions.find((s) => s.id === id)?.name, elements: unsent(d), files: newFiles(d) } : null;
    if (!keep(boxKey(id), box)) unstored = true;
  }
}
// Sends what earlier tabs on this device left in the outbox. Returns the ids it delivered to.
async function recover() {
  let keys = [];
  try { keys = Object.keys(localStorage).filter((k) => k.startsWith('unsent:') && !k.endsWith(':' + client)); } catch {}
  const done = [];
  for (const k of keys) {
    try {
      const box = JSON.parse(localStorage.getItem(k));
      let id = k.split(':')[1];
      try {
        await call('PUT', '/api/sessions/' + id, { elements: box.elements, files: box.files });
      } catch (e) {
        if (e.status !== 404) throw e;
        // The session was deleted meanwhile. The work is still worth more than the tidiness.
        id = (await call('POST', '/api/sessions', { name: ('Recovered ' + (box.name || 'session')).slice(0, 80) })).id;
        await call('PUT', '/api/sessions/' + id, { elements: box.elements, files: box.files });
      }
      localStorage.removeItem(k);
      done.push(id);
    } catch {} // still in the outbox for the next attempt
  }
  return done;
}

// Sends each session's unsent elements. Only what changed goes up, and the server merges it into
// the stored scene, so this stays small however big the drawing gets. True once all is sent.
async function flush() {
  clearTimeout(timer);
  timer = due = 0;
  if (sending) return !(again = true);
  sending = true;
  failing = false;
  const from = Date.now(); // everything drawn before this is in the snapshot below
  try {
    snapshot(); // also how a pan or zoom with no edit gets remembered
    stash();
    for (const [id, d] of [...docs]) {
      const elements = unsent(d);
      const files = newFiles(d);
      if (!elements.length && !Object.keys(files).length) continue;
      try {
        const res = await call('PUT', '/api/sessions/' + id, { elements, files });
        for (const e of elements) d.acked.set(e.id, e.version);
        for (const k in files) d.sentFiles.add(k);
        d.updated = res.updated;
      } catch (e) {
        // 404: the session was deleted on another device while this one still had work for it.
        if (e.status === 404) await rehome(id, d).catch(() => (failing = true));
        else failing = true;
      }
    }
    snapshot(); // anything drawn while those were in flight is still unsent
    stash();
    // All of that reached the server, so whatever is still unsent was drawn after `from`. Without
    // this, steady drawing always leaves something unsent and the banner fires while saves work.
    if (!failing) unsyncedSince = from;
  } finally {
    sending = false; // whatever happened above, the next flush must be able to run
  }
  show();
  if (again || pending()) arm(failing ? 3000 : 300);
  again = false;
  return !failing && !pending();
}
// Unsent work for a session that no longer exists goes into a new one instead of being dropped.
async function rehome(id, d) {
  const name = ('Recovered ' + (sessions.find((s) => s.id === id)?.name || 'session')).slice(0, 80);
  const s = await call('POST', '/api/sessions', { name });
  await call('PUT', '/api/sessions/' + s.id, { elements: d.elements, files: d.files });
  docs.delete(id);
  keep(boxKey(id), null);
  if (id === cur) history.replaceState(null, '', '#' + s.id);
  safe(refresh)();
}
// Saving waits for a pause: while edits are still arriving it checks again shortly, up to `due`.
function arm(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = 0;
    const now = Date.now();
    if (now - edited < 600 && now < due) arm(300);
    else flush();
  }, ms);
}

// The server's copy of the open session, folded into what's on screen: after another device
// changed it, after reconnecting, and after showing a cached copy.
async function pull() {
  const id = cur;
  if (!id) return;
  if (!ready) return void (pullWhenReady = true);
  const remote = await load(id);
  const d = docs.get(id);
  if (!d) return;
  if (id !== cur || !ready || !api) return void (owes(d) || adopt(id, remote));
  const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote.elements, api.getAppState());
  api.addFiles(Object.values(remote.files));
  api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER }); // stays out of undo
  for (const e of remote.elements) d.acked.set(e.id, e.version);
  for (const k in remote.files) d.sentFiles.add(k);
  d.updated = remote.updated;
  d.elements = merged;
  seen = version(merged);
  nfiles = Object.keys(api.getFiles()).length;
  if (owes(d)) arm(300); // our own edits the server hasn't got yet
}

// Runs on every editor update, including pointer moves, so it only compares two numbers and makes
// sure a check is scheduled. The check itself works out what is unsent from scratch.
function onChange(elements, appState, files) {
  if (appState.theme !== theme) setTheme(appState.theme);
  const v = version(elements);
  const n = Object.keys(files).length;
  if (v !== seen || n !== nfiles) {
    seen = v;
    nfiles = n;
    edited = Date.now();
    due ||= edited + 8000;
    unsyncedSince ||= edited;
    if (ready) status('saving');
  }
  if (!timer) arm(700);
}

// The event stream can die without a sound (a laptop waking, a proxy that buffers it), and a tab
// can sit open for days. So besides the stream: whenever the tab comes to the front, the network
// returns, and once a minute, send anything unsent, deliver old outboxes, reload the list, and
// fetch the open session if the server's copy has moved on.
let checked = 0;
const check = safe(async () => {
  if (document.hidden || $('login').open || Date.now() - checked < 5000) return;
  checked = Date.now();
  flush();
  const recovered = await recover();
  await refresh();
  const s = sessions.find((x) => x.id === cur);
  if (recovered.includes(cur) || (s && docs.get(cur) && s.updated !== docs.get(cur).updated)) await pull();
});

/* ---------- sessions ---------- */

// Excalidraw's default menu minus its "Excalidraw links" group (their GitHub, X and Discord).
const MENU = h(MainMenu, null,
  ...['LoadScene', 'SaveToActiveFile', 'Export', 'SaveAsImage', 'SearchMenu', 'Help', 'ClearCanvas']
    .map((k) => h(MainMenu.DefaultItems[k], { key: k })),
  h(MainMenu.Separator, { key: 'sep' }),
  ...['Preferences', 'ToggleTheme', 'ChangeCanvasBackground']
    .filter((k) => MainMenu.DefaultItems[k]).map((k) => h(MainMenu.DefaultItems[k], { key: k })));

// Switching never waits for a save: the session being left keeps its unsent work in `docs` and
// goes up in the background. A session seen before shows at once from memory, then catches up.
let opening = 0;
async function open(id) {
  const turn = ++opening; // also cancels a session still loading when you click back to this one
  if (id === cur) return;
  flush();
  const cached = docs.has(id);
  const s = cached || (await load(id));
  if (turn !== opening) return; // another session was clicked while this one loaded
  snapshot(); // the old editor stayed usable while the new session loaded: keep what was drawn then
  stash();
  const d = docs.get(id) || adopt(id, s);
  cur = id;
  api = null;
  ready = false;
  pullWhenReady = cached;
  // Deleted elements stay in `acked` so the server's copy of them isn't resent, but the editor
  // only gets what's visible.
  const elements = d.elements.filter((e) => !e.isDeleted);
  seen = version(elements);
  nfiles = Object.keys(d.files).length;
  fit = !views[id];
  store('last', id);
  if (location.hash.slice(1) !== id) location.hash = id;
  root.render(h(Excalidraw, {
    key: id, // a new key remounts the editor, so each session gets its own canvas and undo stack
    onExcalidrawAPI: (a) => {
      if (!a) return; // the editor being replaced reports null as it unmounts
      api = a;
      if (pendingLib) safe(addLibrary)();
    },
    // Once the scene is in. First visit on this device: show the whole drawing, zooming out if
    // needed but never in. After that you come back to wherever you left this session.
    onInitialize: (a) => {
      const all = a.getSceneElements();
      if (fit && all.length) a.setViewport({ target: all, fit: 'scale-down', animation: false, offsets: { ui: true } });
      fit = false;
      ready = true;
      if (pullWhenReady) safe(pull)();
      pullWhenReady = false;
    },
    onChange,
    onLibraryChange: (items) => {
      library = items;
      store('library', JSON.stringify(items));
    },
    initialData: { elements, files: d.files, libraryItems: library, appState: { objectsSnapModeEnabled: true, ...prefs, theme, ...views[id] } },
  }, MENU));
  if (narrow()) document.body.classList.add('shut');
  draw();
}

// Reloads the list; also recovers when the open session was deleted on another device.
const recovered = recover(); // outboxes from earlier tabs go up before anything is read back
let firstList = recovered.then(() => call('GET', '/api/sessions')); // started at once, not after the event stream connects
firstList.catch(() => {});
async function refresh() {
  const first = firstList;
  firstList = null;
  sessions = await (first ? first.catch(() => call('GET', '/api/sessions')) : call('GET', '/api/sessions'));
  if (!sessions.length) sessions = [await call('POST', '/api/sessions', { name: 'My first session' })];
  // A session deleted elsewhere is forgotten here too, unless this device still has unsent work
  // for it: flush() then moves that work to a new session.
  snapshot();
  for (const [id, d] of docs) if (!sessions.some((s) => s.id === id) && !owes(d)) docs.delete(id);
  if (!sessions.some((s) => s.id === cur)) {
    cur = api = null;
    ready = false;
    const wanted = [location.hash.slice(1), store('last')];
    await open((wanted.map((w) => sessions.find((s) => s.id === w)).find(Boolean) || sessions[0]).id);
  }
  draw();
}

async function create() {
  const s = await call('POST', '/api/sessions', { name: 'Untitled' });
  sessions.unshift(s);
  adopt(s.id, { elements: [], files: {}, updated: s.updated });
  await open(s.id);
  document.body.classList.remove('shut');
  rename(s);
}

async function remove(s) {
  if (!confirm(`Delete “${s.name}”? This can't be undone.`)) return;
  await call('DELETE', `/api/sessions/${s.id}?client=${client}`);
  if (s.id === cur) ready = false; // deleted on purpose here: nothing of it is unsent work to keep
  docs.delete(s.id);
  keep(boxKey(s.id), null);
  await refresh();
}

/* ---------- libraries ---------- */

// "Browse libraries" opens libraries.excalidraw.com, which sends you back to this page with
// #addLibrary=<url>. That hash isn't a session id, so take it out before routing sees it.
// ponytail: the library lives in this device's localStorage (about 5 MB), so it doesn't sync.
// To sync it, store it on the server beside the sessions and broadcast a 'library' event.
function takeLibrary() {
  const url = new URLSearchParams(location.hash.slice(1)).get('addLibrary');
  if (!url) return false;
  history.replaceState(null, '', cur ? '#' + cur : location.pathname + location.search);
  pendingLib = url;
  if (api) safe(addLibrary)();
  return true;
}

// Only Excalidraw's own library site and its GitHub repository, the same hosts Excalidraw allows.
async function addLibrary() {
  const url = new URL(pendingLib);
  pendingLib = '';
  const ok = url.protocol === 'https:' && (/(^|\.)excalidraw\.com$/.test(url.hostname) ||
    (url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/excalidraw/excalidraw-libraries/')));
  if (!ok) return;
  await api.updateLibrary({
    libraryItems: fetch(url).then((r) => r.blob()),
    prompt: true, // asks before adding, since anyone can send a link with this hash
    merge: true,
    defaultStatus: 'published',
    openLibraryMenu: true,
  });
}

/* ---------- sidebar ---------- */

const PENCIL = '<svg viewBox="0 0 16 16"><path d="M3 13l.6-2.8L10.9 3l2.1 2.1-7.2 7.3z"/></svg>';
const CROSS = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

function draw() {
  $('list').replaceChildren(...sessions.map((s) => {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (s.id === cur) li.className = 'on';
    const name = Object.assign(document.createElement('button'), { className: 'name', textContent: s.name });
    const edit = Object.assign(document.createElement('button'), { className: 'icon act', innerHTML: PENCIL, title: 'Rename' });
    const del = Object.assign(document.createElement('button'), { className: 'icon act', innerHTML: CROSS, title: 'Delete' });
    edit.dataset.do = 'rename';
    del.dataset.do = 'remove';
    li.append(name, edit, del);
    return li;
  }));
}

function rename(s) {
  const li = $('list').querySelector(`[data-id="${s.id}"]`);
  const input = Object.assign(document.createElement('input'), { className: 'name', value: s.name, maxLength: 80, ariaLabel: 'Session name' });
  li.querySelector('.name').replaceWith(input);
  input.select();
  let done = false;
  const finish = safe(async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    try {
      if (commit && name && name !== s.name) {
        await call('PUT', '/api/sessions/' + s.id, { name });
        s.name = name;
      }
    } finally {
      draw();
    }
  });
  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    e.stopPropagation(); // keep the editor's single-key shortcuts out of the name
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
}

// localStorage that shrugs in private mode: the value just won't stick.
function store(k, v) {
  try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch { return null; }
}

function setTheme(t) {
  theme = t;
  document.documentElement.dataset.theme = t;
  store('theme', t);
}

/* ---------- events ---------- */

$('list').onclick = safe((e) => {
  const s = sessions.find((x) => x.id === e.target.closest('li')?.dataset.id);
  if (!s || e.target.matches('input')) return;
  const act = e.target.closest('[data-do]')?.dataset.do;
  return act === 'rename' ? rename(s) : act === 'remove' ? remove(s) : open(s.id);
});
$('list').ondblclick = (e) => {
  const s = sessions.find((x) => x.id === e.target.closest('li')?.dataset.id);
  if (s && e.target.matches('button.name')) rename(s);
};
$('new').onclick = safe(create);
$('toggle').onclick = () => document.body.classList.toggle('shut');
addEventListener('hashchange', safe(() => {
  if (takeLibrary()) return;
  const id = location.hash.slice(1);
  if (sessions.some((s) => s.id === id)) return open(id);
}));
// Browsers freeze, discard and close background tabs without warning. So the moment the page is
// hidden, write unsent work to this device's storage (that part is synchronous, so it always
// completes) and try to send it. Coming back to the front runs the full check.
function park() {
  snapshot();
  stash();
  flush();
}
document.addEventListener('visibilitychange', () => (document.hidden ? park() : check()));
addEventListener('pagehide', () => { leaving = true; park(); });
addEventListener('focus', check);
addEventListener('online', check);
setInterval(check, 60000);
setInterval(show, 5000); // keeps the banner's minutes current
// Closing the tab with work still unsent: the browser asks first. The work is in the outbox
// either way, but it would not reach your other devices until this one opens Looseleaf again.
addEventListener('beforeunload', (e) => {
  leaving = true;
  park();
  if (pending()) e.preventDefault();
  else leaving = false;
});

const saved = (k) => { try { return JSON.parse(store(k)) || {}; } catch { return {}; } };
views = saved('views');
prefs = saved('prefs');
// Start downloading the session you'll land on now, alongside the list, instead of after it.
const land = location.hash.slice(1) || store('last');
if (/^[\w-]+$/.test(land || '')) recovered.then(() => load(land)).catch(() => {});
try { library = JSON.parse(store('library')) || []; } catch {}
takeLibrary();
setTheme(store('theme') || 'dark'); // ink is the house look; the editor's menu switches to paper
if (narrow()) document.body.classList.add('shut');

/* ---------- sign-in ---------- */

$('out').hidden = !store('signedIn');
$('login').oncancel = (e) => e.preventDefault(); // Esc must not dismiss it
$('login').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: $('pw').value }),
  }).catch(() => null);
  if (!res?.ok) {
    $('err').textContent = res ? (await res.json().catch(() => ({}))).error || 'Could not sign in' : 'Can\u2019t reach the server';
    return $('pw').select();
  }
  $('pw').value = $('err').textContent = '';
  store('signedIn', '1');
  $('out').hidden = false;
  $('login').close();
  connect();
  checked = 0;
  check(); // loads the list, delivers anything unsent and catches up
};
$('out').onclick = safe(async () => {
  if (!(await flush())) return; // don't sign out over unsaved work
  await fetch('/api/login', { method: 'DELETE' });
  store('signedIn', '');
  location.reload();
});

/* ---------- live connection ---------- */

// The event stream brings other devices' changes in live. Loading the app does not wait for it,
// and check() above covers for it when it is down, so a blocked stream costs only liveness.
let events = null;
let live = false; // true once the stream has connected
function connect() {
  events?.close();
  const es = (events = new EventSource('/api/events'));
  es.onopen = safe(async () => {
    show();
    const reconnected = live;
    live = true;
    if (reconnected) checked = 0, await check(); // catch up on what changed while it was down
  });
  es.onmessage = safe((e) => {
    const m = JSON.parse(e.data);
    if (m.client === client) return;
    if (m.type === 'list') return refresh();
    if (m.id === cur) return pull();
  });
  es.onerror = () => {
    status('offline');
    if (es.readyState !== EventSource.CLOSED) return; // the browser retries a dropped connection itself
    // Closed for good means the server refused the stream: either this device isn't signed in
    // (the call below then opens the sign-in form) or the server is restarting.
    call('GET', '/api/sessions').catch(() => {}).then(() => {
      if (!$('login').open) setTimeout(connect, 3000);
    });
  };
}
safe(refresh)(); // the list and the landing session, without waiting for the stream
connect();
