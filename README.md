# Code Yellow

A whiteboard like Excalidraw, with two additions: **sessions** (a separate canvas per design or
train of thought, instead of one huge board) and **sync** (open the same session on your laptop,
phone and tablet; edits appear on the others within about half a second).

The drawing surface is the open-source [Excalidraw](https://github.com/excalidraw/excalidraw)
editor (MIT), so every drawing tool, shortcut, export and theme it has works here.

## Run on this computer

```bash
node server.js
```

Needs Node 22.5 or newer. Open http://localhost:4322. With no settings it stores drawings in a
local SQLite file, asks for no password, and only this computer can reach it.

## Use it from anywhere

Host the server somewhere public, give it a Postgres database and a password, and sign in from
any device.

| Setting | What it does |
|---|---|
| `DATABASE_URL` | A Postgres connection string. When set, drawings are stored there instead of SQLite. The table is created on first start. |
| `PASSWORD` | Turns sign-in on. Must be at least 12 characters when the server is reachable from other machines. |
| `HOST` | `0.0.0.0` to accept connections from other machines (default `127.0.0.1`). |
| `PORT` | Default 4322. Most hosts set this for you. |

For example, with a free Postgres from Neon and any Node host (Render, Railway, Fly):

1. Create a Neon project and copy its connection string.
2. Create a web service from this repository. Build command `npm install`, start command `npm start`.
3. Set `DATABASE_URL`, `PASSWORD` and `HOST=0.0.0.0` in the service's environment settings.
4. Open the service's `https://` address and sign in. A device stays signed in for 30 days.

Use the host's HTTPS address, never plain HTTP: the password is sent when you sign in.
Changing `PASSWORD` signs every device out. Ten wrong passwords lock sign-in for 15 minutes.

## Files

| File | Role |
|---|---|
| `index.html` | Shell and styles: the sessions sidebar, the sign-in form, and the import map that loads Excalidraw and React from esm.sh. |
| `app.js` | Client: sessions list, saving, folding in changes from other devices, sign-in. |
| `server.js` | Static files, sign-in, the sessions API, the event stream, storage (Postgres or SQLite). Node built-ins plus `pg`. |
| `server.test.js` | `npm test`. Set `DATABASE_URL` to run the same checks against Postgres. |

## How sync works

- Each session is one database row holding its Excalidraw elements and images.
- A device saves at most every 0.4 s while you draw. The server merges the save element by
  element: the higher `version` of each element wins, the rule Excalidraw's own collaboration
  uses. Two devices drawing in the same session both keep their work.
- The server then tells every other open device over a server-sent event stream, and they fetch
  and fold in the change. A device that was offline catches up when the stream reconnects.

## Known limits

Search the code for `ponytail:` to find each one and its upgrade path.

- The editor loads from a CDN, so the first load needs the internet, and there is no offline mode.
- One password and one owner: no user accounts, no sharing, no live cursors.
- Drawings made locally in SQLite are not copied to Postgres when you switch.
- Excalidraw's shape library and per-device view (zoom, scroll position) are not synced.
