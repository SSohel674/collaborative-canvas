# Architecture

## Data flow: how a stroke gets from one user to everyone else

```
User draws (pointerdown/move/up)
        │
        ▼
main.js: local instant render (liveCanvas)     ── zero-latency feedback,
        │                                          never waits on the network
        ▼
main.js: buffer points, flush ≤ once per rAF tick (~60/sec)
        │
        ▼
WebSocket:  stroke:start → stroke:points × N → stroke:end
        │
        ▼
server.js: relay to everyone else in the room (broadcast, sender excluded)
   │                                    │
   ▼                                    ▼
Other clients render the         On stroke:end, server commits the full
stroke live as points arrive     stroke into DrawingState (the room's
(liveCanvas)                     authoritative ordered history) and
                                  broadcasts the committed stroke object
                                  back out so everyone's main canvas
                                  (the "permanent" layer) gets it appended
```

The **server is the single source of truth for commit order.** Two users
drawing "at the same time" simply commit in whatever order their
`stroke:end` messages arrive at the server — there is no client-side
merge logic to get wrong, because the server never lets two clients decide
ordering between themselves.

## WebSocket protocol

All messages are JSON with a `type` field. Full list and payload shapes are
documented as a comment block at the top of `server/server.js` (kept next
to the code that implements them, so the two can't drift out of sync).
Summary:

| Direction | Type | Purpose |
|---|---|---|
| C→S | `stroke:start` | Begin a new stroke (tool/color/width/first point) |
| C→S | `stroke:points` | Batched array of new points for an in-progress stroke |
| C→S | `stroke:end` | Finish a stroke — server commits it |
| C→S | `cursor:move` | Broadcast this user's pointer position |
| C→S | `undo` / `redo` / `clear` | Global history operations |
| C→S | `ping` | Latency probe |
| S→C | `init` | Full room snapshot sent to a newly-joined client |
| S→C | `user:joined` / `user:left` | Presence updates |
| S→C | `stroke:start`/`stroke:points`/`stroke:end` | Relayed drawing events |
| S→C | `cursor:move` | Relayed cursor position |
| S→C | `state:sync` | Full authoritative stroke list (after undo/redo/clear) |
| S→C | `pong` | Latency probe echo |

### Why hand-roll the WebSocket server instead of `ws`/Socket.IO?

Two reasons, one practical and one philosophical:

1. **Zero dependencies** means `npm install` never has anything to fetch —
   nothing to go wrong on a fresh clone or deploy target, and no supply
   chain surface at all for a project this size.
2. The brief already asks for raw Canvas skills over libraries on the
   frontend; `server/wsServer.js` extends that same idea to the transport
   layer — implementing the RFC 6455 handshake (SHA-1 + the magic GUID) and
   frame format (fin/opcode/mask/payload-length parsing, including
   fragmentation and extended lengths) by hand demonstrates understanding
   of what those libraries actually do, not just how to call them.

If asked to justify Socket.IO instead: it adds automatic room support,
fallback transports, and reconnection out of the box — real wins for a
larger production app — at the cost of a heavier client bundle and a
protocol that isn't plain WebSocket frames anymore (so it's harder to talk
to from anything that isn't a Socket.IO client). For an app this size, with
reconnection logic being maybe 30 lines of code (`client/js/ws-client.js`),
the tradeoff didn't seem worth the dependency.

## Event streaming strategy

- **Serialization**: plain JSON. Payloads are tiny (a handful of numbers
  per point); a binary format would save bytes but cost readability and
  debuggability for no measurable win at this scale.
- **Batching vs. individual events**: a mouse can fire `pointermove` far
  faster than is useful to ship individually. Points are buffered locally
  and flushed **at most once per animation frame** (`main.js`,
  `flushOutgoingPoints`) as a single `stroke:points` array — this cuts
  message volume several-fold during a fast stroke with no visible loss of
  smoothness, since rendering itself is also frame-rate-limited.
- **Handling network latency**: the *local* user's own strokes render
  instantly from local input, never waiting on a server round-trip
  (see "Client-side prediction" below). Only *other* users' strokes are
  gated by network latency, which is fundamentally unavoidable.
- **Client-side prediction**: rather than a full prediction/reconciliation
  system, the local client treats its own input as immediately authoritative
  for rendering (draws on `liveCanvas` the instant a pointer event fires,
  commits to `mainCanvas` the instant the pointer lifts) and does not wait
  for the server to echo anything back before considering the stroke
  "done" locally. The server's copy is committed independently and will
  match as long as no messages were dropped — WebSocket delivery over TCP
  makes silent point loss extremely unlikely in practice for a same-session
  connection.

## Undo/redo strategy (the hard part)

**Design: a single global stack per room, not one per user.**

Freehand strokes almost never need genuine merging against each other —
visually, "who drew what, in what order" is all that matters, and the
server already decides that order via commit sequence (see Data Flow
above). Given that, `server/drawingState.js` keeps one ordered array of
committed strokes and one redo stack, **shared by the whole room**:

```js
undo()  → pop the most recent committed stroke → push onto redoStack
redo()  → pop the most recent undone stroke    → push back onto committed
any new stroke commit → clears the redo stack (standard undo/redo semantics)
```

- **Maintaining history across users**: it's just one array on the server;
  every client's undo/redo button sends the same `undo`/`redo` message
  regardless of who drew what, and the server is the only thing that
  mutates the array.
- **Conflict resolution when User A undoes User B's stroke**: there's no
  special case to write, because undo was never scoped to "my strokes" —
  it always operates on "the most recent stroke in the room," full stop.
  This was a deliberate simplification once it became clear that per-user
  undo stacks would require deciding what happens when B's undo needs to
  remove a stroke that isn't at the top of A's stack — a genuinely gnarly
  problem that a global stack sidesteps entirely.
- **Maintaining canvas state consistency**: clients never try to
  surgically "erase just one stroke" from a canvas that has other pixels
  baked into it (hard to do correctly with eraser strokes involved). On
  `undo`/`redo`/`clear`, the server sends the *entire* current stroke list
  and the client does a full replay: clear the canvas, redraw every
  remaining stroke in order via the exact same `paintStroke()` function
  used for normal rendering. This guarantees the undo/redo result always
  matches a fresh replay of history — no drift possible. This full replay
  is deliberately the *only* expensive render path in the app, and it's
  triggered by a rare user action (a button click), not by every stroke.

## Canvas rendering / performance decisions

Three stacked `<canvas>` layers (`client/js/canvas.js`), each with a
different repaint strategy chosen for its access pattern:

| Layer | Contains | Repainted when |
|---|---|---|
| `mainCanvas` | Committed (finished) strokes | Once per commit (append-only); full clear+replay only on undo/redo/clear/init/resize |
| `liveCanvas` | Strokes currently being drawn, by anyone | Every animation frame, but only while "dirty" (something changed) |
| `cursorCanvas` | Other users' live pointer positions | Every animation frame, but only while "dirty" |

Splitting these apart matters because:
- Appending one new committed stroke is **O(1)** relative to history size
  — the app doesn't slow down as a room accumulates thousands of strokes,
  since `mainCanvas` is never fully redrawn during normal drawing.
- Cursor updates (very frequent — every pointer move from every user) never
  touch stroke pixels and can't cause flicker on the drawing layers.
- A `requestAnimationFrame` loop with a `dirty` flag means the render rate
  is capped at the display's refresh rate regardless of how fast network
  messages or pointer events arrive — classic "decouple simulation rate
  from render rate."

**Smoothing**: freehand strokes are rendered as a sequence of quadratic
Bézier curves through the midpoints of consecutive raw points (the
standard "midpoint smoothing" technique) rather than straight `lineTo`
segments between noisy pointer samples — this is what makes fast strokes
look like ink instead of a jagged polyline, and it's applied identically
whether painting a brand-new committed stroke or replaying the entire
history, because both paths go through the same `paintStroke()` function
(see `canvas.js`) — there is exactly one code path that knows how to draw
a stroke, used everywhere a stroke needs to be drawn.

**Eraser**: implemented via `globalCompositeOperation = 'destination-out'`
rather than "paint with the background color," so it correctly punches a
transparent hole regardless of what's underneath (works even if the
background were an image or pattern). Because eraser strokes are stored in
history exactly like brush strokes, full replay after undo/redo reproduces
erasing correctly by re-applying erase operations in their original order.

**High-frequency input**: Pointer Events (not separate mouse/touch
listeners) are used throughout, which coalesces mouse, touch, and pen
input into one API and one code path — this is also what gives touch
support "for free" as a bonus rather than a separate implementation.

## Persistence

`server/persistence.js` debounce-saves each room's committed stroke list
to `data/<room>.json` 1.5s after the last change, and a room reloads its
last-saved state the moment its first user (re)joins after being empty.
This is intentionally the simplest thing that works for a single-process
demo; swapping it for a real database later only touches this one file.

## Testing approach

Rather than relying on manual clicking, this was validated with automated
end-to-end tests driving **real Chromium instances via Playwright** (not
mocks) — two actual browser tabs joining the same room and interacting
through the real UI, plus a protocol-level test using Node's native
`WebSocket` client against the real server. Covered:

- Handshake + protocol correctness (join, stroke start/points/end, cursor
  move, ping/pong, disconnect notification) — via direct WebSocket messages
- Two-browser stroke sync, including the actual rendered pixels matching
  on both sides (not just "a message was received")
- Cross-client undo/redo (B undoes A's stroke, A sees it disappear; A
  redoes it, B sees it come back)
- Eraser and rectangle tool sync
- Live cursor sync
- **A real reconnection test**: killing the actual server process
  (`SIGKILL`, not a simulated offline mode) to force a genuine TCP close,
  confirming the client's status indicator updates and it reconnects
  automatically once the server comes back — with no page reload — and is
  still fully functional afterward
- **A real persistence test**: draw, wait for the debounced disk write,
  kill and restart the server process entirely, reconnect, and confirm the
  drawing is still there

This process caught one real bug before it shipped: the rectangle tool's
live preview updated locally but wasn't sending its moving corner to the
server (only brush/eraser points were included in the network batch), so
the server's committed copy only ever had the rectangle's *starting*
corner — meaning other users saw nothing for a synced rectangle. Fixed by
streaming the rectangle's current corner through the same batched
`stroke:points` path as freehand tools.
