# Real-Time Collaborative Drawing Canvas

A multi-user drawing app: brush, eraser, and rectangle tools, live cursors,
global undo/redo, and automatic reconnection — built with **vanilla
JavaScript + the raw HTML5 Canvas API on the frontend, and a zero-dependency
Node.js WebSocket server on the backend.** No frontend framework, no canvas
library, no npm packages at all (see `ARCHITECTURE.md` for why the
WebSocket protocol itself is hand-rolled rather than using `ws`/Socket.IO).

##Deply
https://collaborative-canvas-2let.onrender.com/

## Setup

```bash
npm install     # no-op — zero dependencies, this just confirms npm works
npm start
```

Then open **http://localhost:3000** in a browser. That's it — no build step,
no bundler, no env vars required.

For development with auto-restart on file changes:
```bash
npm run dev
```

## How to test with multiple users

1. Open `http://localhost:3000` in two (or more) browser tabs/windows, or
   share the deployed URL with someone else.
2. Everyone starts in the `lobby` room. Use the **Room** field in the
   toolbar + **Join** to create/switch to an isolated room — great for
   testing without stepping on someone else's canvas.
3. Draw in one tab and watch it appear in the other in real time, including
   the other user's live cursor position while they're actively drawing.
4. Click **Undo** in one tab — it undoes the *most recent stroke drawn by
   anyone in the room*, not just your own (see `ARCHITECTURE.md` for why
   this is the correct behavior, not a bug).
5. To test reconnection: kill the server (`Ctrl+C`) while a tab is open,
   watch the status indicator go to "Reconnecting…", then restart the
   server (`npm start`) — the tab reconnects on its own within a few
   seconds and stays fully functional, with the room's drawing history
   restored (persistence — see below).

## Features

**Core**
- Brush (adjustable color + width), eraser, rectangle tools
- Real-time sync of strokes as they're drawn (not just on completion)
- Live cursor indicators showing where each other user is drawing, with name/color
- Global undo/redo, consistent across all users
- Automatic reconnection with exponential backoff on network drops
- Room system: `?room=name` isolates separate canvases
- Online user list with per-user assigned colors

**Bonus**
- Touch support (Pointer Events unify mouse/touch/pen — no separate code path)
- Server-side auto-persistence: a room's drawing survives a server restart
  (see `server/persistence.js`) — debounced writes to `data/<room>.json`
- Manual Save/Load: export the current canvas to a portable `.json` file
  and re-import it later (client-side only, see Known Limitations)
- Live FPS counter and round-trip latency display in the toolbar

## Known limitations

- **Manual Save/Load is local-only.** It exports/imports a JSON file from
  your machine and re-renders it in your own browser; it does **not**
  push the loaded drawing back to the server or other connected users.
  The separate auto-persistence feature (server-side, per room) is what
  keeps a room's canvas alive across server restarts / reconnects — the
  Save/Load buttons are for taking a drawing "to go."
- **Clear is immediate and not undoable.** Undo/redo tracks individual
  strokes; "Clear" wipes the whole history outright, by design (a
  confirmation dialog guards against accidental clicks).
- **In-progress strokes aren't persisted.** If a user disconnects mid-stroke
  (before releasing the pointer), that partial stroke is lost — only
  *completed* strokes are ever committed to history. This keeps the
  server's memory/protocol simple and matches how most real drawing tools
  handle interrupted input.
- **Persistence is single-file-per-room, single-server-instance.** Fine for
  this assignment's scope; a production version would swap
  `server/persistence.js` for a real datastore (interface is already
  isolated to `save`/`load` for exactly that reason).
- No authentication — anyone with the room link can join and draw, by
  design (see the assignment's own FAQ on this point).

## Time spent

Roughly one focused day: ~2 hours on the WebSocket protocol design +
hand-rolled server implementation, ~3 hours on canvas rendering (the
layering approach + smoothing took a couple of iterations to get right),
~2 hours on client wiring/UI, ~1.5 hours writing and running the automated
tests described below, plus documentation.

## Testing performed

This was validated with real automated end-to-end tests (Playwright driving
actual browser instances, not just unit tests) covering: two-client stroke
sync, cross-client undo/redo, eraser sync, rectangle tool sync, live cursor
sync, a real server-kill-and-restart reconnection scenario, and a
server-restart persistence scenario. All of it is described in detail in
`ARCHITECTURE.md` under "Testing approach," including the one real bug this
process caught (rectangle tool not syncing its second corner) before it
shipped.

## Deployment note

This app needs a host that supports **long-lived WebSocket connections** —
a plain serverless/static host (e.g. Vercel's default serverless functions)
will NOT work, because serverless functions can't hold a persistent socket
open. Use a host that runs your Node process continuously, such as
**Render, Railway, or Fly.io** (all have simple free tiers for a repo like
this — connect the repo, set the start command to `npm start`, done).
