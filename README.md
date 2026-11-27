# Looseleaf

A whiteboard like Excalidraw, with two additions: **sessions** (a separate canvas per design or
train of thought, instead of one huge board) and **sync** (open the same session on your laptop,
phone and tablet; edits appear on the others within about half a second).

The drawing surface is the open-source [Excalidraw](https://github.com/excalidraw/excalidraw)
editor (MIT), so every drawing tool, shortcut, export and theme it has works here.

Drag sessions in the sidebar to reorder them (or focus one and press Alt+↑/↓); the order is kept
on the server, so every device shows the same list. The search box above the list filters sessions
by name; Enter opens the first match, Esc clears it.

Pick a theme from the palette button at the foot of the sidebar or from the editor's menu: Graphite,
Midnight or Ember (dark), Paper, Mist or Sepia (light). Each is remembered per device, and the
editor's light/dark shortcut (Alt+Shift+D) swaps between paired themes. A theme is one block of
colour tokens in `index.html`; to add one, add a block and a button in the `#themes` picker.

## Run on this computer

```bash
npm install
npm start
```

Needs Node 22.9 or newer. Open http://localhost:4322. Only this computer can reach it, and it
asks for no password.

`npm start` reads settings from `.env.local` if that file exists. With a `DATABASE_URL` there,
drawings are stored in that Postgres database; without one, in a local SQLite file.

This project is linked to a Neon project (`neon.ts`, and the git-ignored `.neon`). On a new
machine, `neon link` then `neon env pull` writes `.env.local` with the database address.

## Use it from anywhere

Host the server somewhere public, give it a Postgres database and a password, and sign in from
any device.

| Setting | What it does |
|---|---|
| `DATABASE_URL` | A Postgres connection string. When set, drawings are stored there instead of SQLite. The table is created on first start. Required when `HOST` is not local: a host's disk is wiped on restart, so the server refuses to start there without it. |
| `PASSWORD` | Turns sign-in on. Must be at least 12 characters when the server is reachable from other machines. |
| `HOST` | `0.0.0.0` to accept connections from other machines (default `127.0.0.1`). |
| `PORT` | Default 4322. Most hosts set this for you. |

For example, on any Node host (Render, Railway, Fly):

1. Create a web service from this repository. Build command `npm install`, start command `npm start`.
2. In the service's environment settings, set `DATABASE_URL` (copy the value from `.env.local`),
   `PASSWORD` and `HOST=0.0.0.0`.
3. Open the service's `https://` address and sign in. A device stays signed in for 30 days.

Use the host's HTTPS address, never plain HTTP: the password is sent when you sign in.
Changing `PASSWORD` signs every device out. Ten wrong passwords lock sign-in for 15 minutes.

## Files

| File | Role |
|---|---|
| `index.html` | Shell and styles: the sessions sidebar, the sign-in form, and the import map that loads Excalidraw and React from esm.sh. |
| `app.js` | Client: sessions list, saving, folding in changes from other devices, sign-in. |
| `server.js` | Static files, sign-in, the sessions API, the event stream, storage (Postgres or SQLite). Node built-ins plus `pg`. |
| `server.test.js` | `npm test`. Set `DATABASE_URL` to run the same checks against Postgres. |
| `neon.ts` | Neon's project config, used by the `neon` CLI. The server doesn't read it. |

## How sync works

Looseleaf is local-first: drawing and switching sessions never wait for the network, and work
that has not reached the server yet is never held in memory alone.

- Each session is one database row holding its Excalidraw elements and images.
- A device keeps every session it has opened in memory, and remembers which version of each
  element the server has confirmed. Anything else is unsent work; that is recomputed from the
  editor every time, never tracked by a flag.
- **The outbox.** Unsent work is written to the device's own storage whenever drawing pauses and
  the moment the tab is hidden or closed. If the tab is reloaded, discarded or crashes, the next
  start on that device sends it before loading anything.
- When you pause drawing, the device sends only the elements that changed. Every request has a
  45-second deadline, so one stranded request cannot hold up the saves behind it; failures retry
  every few seconds.
- The server merges what arrives element by element: the higher `version` of each element wins,
  the rule Excalidraw's own collaboration uses. Two devices drawing in the same session both
  keep their work.
- Other devices hear about a change over a server-sent event stream. Because that stream can die
  silently, each device also checks on its own: when the tab comes to the front, when the network
  returns, and once a minute, it retries unsent work, reloads the list, and fetches the open
  session if the server's copy has moved on.
- If nothing has reached the server for 15 seconds while work is waiting, a small cloud-off icon
  appears over the canvas; tap it for details.
- Unsent work for a session that was deleted on another device goes into a new session named
  "Recovered …" instead of being dropped.
- Each device remembers, per session, where you were looking and your tool settings (in
  localStorage). The first time a device opens a session it zooms out to fit the whole drawing.

## Known limits

Search the code for `ponytail:` to find each one and its upgrade path.

- The editor loads from a CDN, so the first load needs the internet, and there is no offline mode.
- One password and one owner: no user accounts, no sharing, no live cursors.
- Excalidraw's shape library, the view (zoom, scroll position) and tool settings are kept per
  device, not synced.
- The outbox lives in localStorage (about 5 MB). A large image that has not synced yet may not
  fit; the banner then says the work exists only in that tab.
- Unsent work reaches other devices only once the device that made it is online with Looseleaf
  open.
- The editor is a pinned canary build of Excalidraw, not a stable release.
