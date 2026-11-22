// Looseleaf client: a sessions sidebar around the Excalidraw editor, synced through the server.
// Organised top to bottom: state → server calls → sync (flush / pull) → sessions → sidebar → events.
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
// An element whose version differs from that is unsent work, and its session sits in `dirty`.
// ponytail: unsent work lives in memory, so it survives a dropped connection but not a closed
// tab (the browser warns first). Keep `docs` in IndexedDB to also work fully offline.
const docs = new Map();  // id -> { elements, files, acked: Map<elementId, version>, sentFiles: Set }
const dirty = new Set(); // ids of sessions with unsent work
let seen = 0;            // scene version at the last onChange, to notice an edit cheaply
let nfiles = 0;          // image count at the last onChange
let timer = 0;           // the next check for a pause in drawing
let edited = 0;          // when the scene last changed
let due = 0;             // while drawing without a pause, send by this time anyway
let sending = false;
let fit = false;         // the open session still needs its first zoom-to-fit

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

async function call(method, url, body) {
  const json = body && JSON.stringify({ ...body, client });
  const res = await fetch(url, {
    method,
    headers: body && { 'content-type': 'application/json' },
    body: json,
    keepalive: !!json && json.length < 60000, // lets a small save finish even if the tab closes
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
  const d = { elements: s.elements, files: s.files, acked: new Map(s.elements.map((e) => [e.id, e.version])), sentFiles: new Set(Object.keys(s.files)) };
  docs.set(id, d);
  return d;
}
const unsent = (d) => d.elements.filter((e) => d.acked.get(e.id) !== e.version);
const newFiles = (d) => Object.fromEntries(Object.entries(d.files).filter(([k]) => !d.sentFiles.has(k)));

// Copies the editor's scene, view and settings into this device's memory.
function snapshot() {
  const d = api && docs.get(cur);
  if (!d) return;
  d.elements = api.getSceneElementsIncludingDeleted();
  d.files = api.getFiles();
  const st = api.getAppState();
  if (!fit) views[cur] = { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom };
  prefs = Object.fromEntries(Object.entries(st).filter(([k]) => PREFS.test(k)));
  keep('views', Object.fromEntries(sessions.filter((s) => views[s.id]).map((s) => [s.id, views[s.id]])));
  keep('prefs', prefs);
}
// Writes to localStorage only when the value changed, since this runs every time drawing pauses.
const kept = {};
function keep(k, v) {
  const json = JSON.stringify(v);
  if (kept[k] !== json) store(k, (kept[k] = json));
}

// Sends each session's unsent elements. Only what changed goes up, and the server merges it into
// the stored scene, so this stays small however big the drawing gets. Returns false on failure.
async function flush() {
  clearTimeout(timer);
  timer = due = 0;
  if (sending) return void arm(300);
  snapshot(); // also how a pan or zoom with no edit gets remembered
  if (!dirty.size) return true;
  sending = true;
  let failed = false;
  for (const id of [...dirty]) {
    const d = docs.get(id);
    if (!d) { dirty.delete(id); continue; }
    const elements = unsent(d);
    const files = newFiles(d);
    if (elements.length || Object.keys(files).length) {
      try {
        await call('PUT', '/api/sessions/' + id, { elements, files });
        for (const e of elements) d.acked.set(e.id, e.version);
        for (const k in files) d.sentFiles.add(k);
      } catch (e) {
        if (e.status === 404) docs.delete(id), dirty.delete(id); // deleted on another device
        else failed = true;
        continue;
      }
      if (id === cur) snapshot(); // anything drawn while that was in flight is still unsent
    }
    if (!unsent(d).length && !Object.keys(newFiles(d)).length) dirty.delete(id);
  }
  sending = false;
  status(failed ? 'offline' : dirty.size ? 'saving' : 'synced');
  if (dirty.size) arm(failed ? 3000 : 300);
  return !failed;
}
// Saving waits for a pause: while edits are still arriving it checks again shortly, up to `due`.
function arm(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = 0;
    const now = Date.now();
    if (dirty.size && now - edited < 600 && now < due) arm(300);
    else flush();
  }, ms);
}

// The server's copy of the open session, folded into what's on screen: after another device
// changed it, after reconnecting, and after showing a cached copy.
async function pull() {
  const id = cur;
  if (!id) return;
  const remote = await load(id);
  const d = docs.get(id);
  if (!d) return;
  if (id !== cur || !api) return void (unsent(d).length || adopt(id, remote));
  const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote.elements, api.getAppState());
  api.addFiles(Object.values(remote.files));
  api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER }); // stays out of undo
  for (const e of remote.elements) d.acked.set(e.id, e.version);
  for (const k in remote.files) d.sentFiles.add(k);
  d.elements = merged;
  seen = version(merged);
  nfiles = Object.keys(api.getFiles()).length;
  if (unsent(d).length) dirty.add(id), arm(300); // our own edits the server hasn't got yet
}

// Runs on every editor update, including pointer moves, so it only compares two numbers. The
// save waits for a pause in drawing (or 8 seconds of drawing without one).
function onChange(elements, appState, files) {
  if (appState.theme !== theme) setTheme(appState.theme);
  const v = version(elements);
  const n = Object.keys(files).length;
  if (v !== seen || n !== nfiles) {
    seen = v;
    nfiles = n;
    edited = Date.now();
    due ||= edited + 8000;
    dirty.add(cur);
    status('saving');
  }
  if (!timer) arm(700);
}

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
  if (id === cur) return;
  const turn = ++opening;
  if (api) snapshot(), flush();
  const cached = docs.get(id);
  const d = cached || adopt(id, await load(id));
  if (turn !== opening) return; // another session was clicked while this one loaded
  cur = id;
  api = null;
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
  if (cached) safe(pull)();
}

// Reloads the list; also recovers when the open session was deleted on another device.
let firstList = call('GET', '/api/sessions'); // started at once, not after the event stream connects
firstList.catch(() => {});
async function refresh() {
  const first = firstList;
  firstList = null;
  sessions = await (first ? first.catch(() => call('GET', '/api/sessions')) : call('GET', '/api/sessions'));
  if (!sessions.length) sessions = [await call('POST', '/api/sessions', { name: 'My first session' })];
  for (const id of docs.keys()) if (!sessions.some((s) => s.id === id)) docs.delete(id), dirty.delete(id);
  if (!sessions.some((s) => s.id === cur)) {
    cur = api = null;
    const wanted = [location.hash.slice(1), store('last')];
    await open((wanted.map((w) => sessions.find((s) => s.id === w)).find(Boolean) || sessions[0]).id);
  }
  draw();
}

async function create() {
  const s = await call('POST', '/api/sessions', { name: 'Untitled' });
  sessions.unshift(s);
  adopt(s.id, { elements: [], files: {} });
  await open(s.id);
  document.body.classList.remove('shut');
  rename(s);
}

async function remove(s) {
  if (!confirm(`Delete “${s.name}”? This can't be undone.`)) return;
  await call('DELETE', `/api/sessions/${s.id}?client=${client}`);
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
// Phones freeze background tabs without warning, so save the moment the page is hidden.
document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot(), flush(); });
// Closing the tab: send what's left, and have the browser ask first if some of it may not make it.
addEventListener('beforeunload', (e) => {
  snapshot();
  if (dirty.size) flush(), e.preventDefault();
});

const saved = (k) => { try { return JSON.parse(store(k)) || {}; } catch { return {}; } };
views = saved('views');
prefs = saved('prefs');
// Start downloading the session you'll land on now, alongside the list, instead of after it.
const land = location.hash.slice(1) || store('last');
if (/^[\w-]+$/.test(land || '')) load(land).catch(() => {});
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
  connect(); // loads the list and catches up; a save that was waiting retries by itself
};
$('out').onclick = safe(async () => {
  snapshot();
  if (!(await flush()) || dirty.size) return; // don't sign out over unsaved work
  await fetch('/api/login', { method: 'DELETE' });
  store('signedIn', '');
  location.reload();
});

/* ---------- live connection ---------- */

// The event stream drives everything: its first `open` loads the app, and every reconnect
// catches up on whatever changed while this device was offline.
let events = null;
let live = false; // true once the stream has connected
function connect() {
  events?.close();
  const es = (events = new EventSource('/api/events'));
  es.onopen = safe(async () => {
    if (!dirty.size) status('synced');
    const reconnected = live;
    live = true;
    await refresh();
    if (reconnected) await pull(); // the first connect has only just loaded the session
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
connect();
