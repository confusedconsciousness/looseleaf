// Looseleaf client: a sessions sidebar around the Excalidraw editor, synced through the server.
// Organised top to bottom: state → server calls → sync (save / pull) → sessions → sidebar → events.
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
let saved = 0;        // scene version the server already has
let sent = new Set(); // image file ids the server already has
let timer = 0;        // pending save
let theme = 'light';
let library = [];     // Excalidraw library items, shared by every session on this device
let pendingLib = '';  // a library URL waiting for the editor to mount

const STATUS = { synced: 'Synced', saving: 'Saving…', offline: 'Offline. Retrying…' };
function status(s) {
  $('status').dataset.s = s;
  $('status').textContent = STATUS[s];
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body && { 'content-type': 'application/json' },
    body: body && JSON.stringify({ ...body, client }),
  });
  if (res.status === 401 && !$('login').open) $('login').showModal(); // not signed in on this device
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
// Event handlers run through this so a dropped connection shows in the status line, not the console.
const safe = (fn) => (...a) => Promise.resolve(fn(...a)).catch(() => status('offline'));

/* ---------- sync ---------- */

// Sends the whole scene; the server merges it element by element, so two devices drawing in the
// same session both keep their work. Returns false if the server couldn't be reached.
// ponytail: full-scene PUT on every change; send only elements newer than `saved` if scenes get big.
async function save() {
  clearTimeout(timer);
  timer = 0;
  if (!api || !cur) return true;
  const id = cur;
  const elements = api.getSceneElementsIncludingDeleted();
  const v = version(elements);
  const files = Object.fromEntries(Object.entries(api.getFiles()).filter(([k]) => !sent.has(k)));
  if (v === saved && !Object.keys(files).length) return true;
  status('saving');
  try {
    await call('PUT', '/api/sessions/' + id, { elements, files });
    if (id === cur) {
      saved = v;
      for (const k in files) sent.add(k);
    }
    if (!timer) status('synced');
    return true;
  } catch {
    status('offline');
    timer = setTimeout(save, 3000);
    return false;
  }
}

// Another device changed the open session: fetch it and fold it into what's on screen.
async function pull() {
  const id = cur;
  if (!api) return;
  const remote = await call('GET', '/api/sessions/' + id);
  if (id !== cur || !api) return;
  const local = api.getSceneElementsIncludingDeleted();
  const clean = !timer && version(local) === saved;
  const merged = reconcileElements(local, remote.elements, api.getAppState());
  api.addFiles(Object.values(remote.files));
  for (const k in remote.files) sent.add(k);
  api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER }); // stays out of undo
  if (clean) saved = version(merged); // otherwise the next save sends our unsent edits
}

function onChange(elements, appState, files) {
  if (appState.theme !== theme) setTheme(appState.theme);
  if (timer) return;
  if (version(elements) !== saved || Object.keys(files).some((k) => !sent.has(k))) {
    status('saving');
    timer = setTimeout(save, 400);
  }
}

/* ---------- sessions ---------- */

// Excalidraw's default menu minus its "Excalidraw links" group (their GitHub, X and Discord).
const MENU = h(MainMenu, null,
  ...['LoadScene', 'SaveToActiveFile', 'Export', 'SaveAsImage', 'SearchMenu', 'Help', 'ClearCanvas']
    .map((k) => h(MainMenu.DefaultItems[k], { key: k })),
  h(MainMenu.Separator, { key: 'sep' }),
  h(MainMenu.DefaultItems.ToggleTheme, { key: 'theme' }),
  h(MainMenu.DefaultItems.ChangeCanvasBackground, { key: 'bg' }));

async function open(id) {
  if (id === cur || !(await save())) return; // never leave a session with unsaved work
  const s = await call('GET', '/api/sessions/' + id);
  cur = id;
  api = null;
  saved = version(s.elements);
  sent = new Set(Object.keys(s.files));
  if (location.hash.slice(1) !== id) location.hash = id;
  root.render(h(Excalidraw, {
    key: id, // a new key remounts the editor, so each session gets its own canvas and undo stack
    excalidrawAPI: (a) => {
      api = a;
      if (pendingLib) safe(addLibrary)();
    },
    onChange,
    onLibraryChange: (items) => {
      library = items;
      store('library', JSON.stringify(items));
    },
    initialData: { elements: s.elements, files: s.files, libraryItems: library, appState: { theme }, scrollToContent: true },
  }, MENU));
  if (narrow()) document.body.classList.add('shut');
  draw();
}

// Reloads the list; also recovers when the open session was deleted on another device.
async function refresh() {
  sessions = await call('GET', '/api/sessions');
  if (!sessions.length) sessions = [await call('POST', '/api/sessions', { name: 'My first session' })];
  if (!sessions.some((s) => s.id === cur)) {
    cur = api = null;
    const wanted = location.hash.slice(1);
    await open((sessions.find((s) => s.id === wanted) || sessions[0]).id);
  }
  draw();
}

async function create() {
  const s = await call('POST', '/api/sessions', { name: 'Untitled' });
  sessions.unshift(s);
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
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

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
  if (!(await save())) return; // don't sign out over unsaved work
  await fetch('/api/login', { method: 'DELETE' });
  store('signedIn', '');
  location.reload();
});

/* ---------- live connection ---------- */

// The event stream drives everything: its first `open` loads the app, and every reconnect
// catches up on whatever changed while this device was offline.
let events = null;
function connect() {
  events?.close();
  const es = (events = new EventSource('/api/events'));
  es.onopen = safe(async () => {
    if (!timer) status('synced');
    await refresh();
    await pull();
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
