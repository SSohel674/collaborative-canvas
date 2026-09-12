/**
 * server.js
 * ---------
 * Entry point. Two jobs:
 *   1. Serve the static client (plain HTTP file server — no Express, so
 *      `npm install` has nothing to fetch and nothing to break).
 *   2. Handle the WebSocket upgrade and speak the app's message protocol,
 *      documented in full in ARCHITECTURE.md.
 *
 * Message protocol (all messages are JSON with a `type` field):
 *
 *  Client -> Server
 *    join          { room, name? }
 *    stroke:start  { strokeId, tool, color, width, point }
 *    stroke:points { strokeId, points: [point, ...] }   -- batched, see below
 *    stroke:end    { strokeId }
 *    cursor:move   { point }
 *    undo          {}
 *    redo          {}
 *    clear         {}
 *    ping          { t }   (latency probe; server echoes it back)
 *
 *  Server -> Client
 *    init          { userId, color, users[], strokes[] }
 *    user:joined   { user: {id, color, name} }
 *    user:left     { userId }
 *    stroke:start  { userId, strokeId, tool, color, width, point }
 *    stroke:points { strokeId, points: [point, ...] }
 *    stroke:end    { strokeId, stroke }   -- authoritative committed stroke
 *    cursor:move   { userId, point }
 *    state:sync    { strokes[] }          -- full replace, sent after undo/redo/clear
 *    pong          { t }
 *    error         { message }
 *
 *  NOTE on batching ("Event streaming strategy" in the brief): a mouse can
 *  fire pointermove far faster than is useful to ship over the network
 *  individually. The client buffers points and flushes at most once per
 *  animation frame (~60/sec) as a single `stroke:points` array, which cuts
 *  message volume roughly 3-5x during fast strokes without any visible
 *  loss of smoothness (see main.js `flushOutgoingPoints`).
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { isWebSocketUpgrade, acceptWebSocket } from './wsServer.js';
import { RoomManager } from './rooms.js';
import { DrawingState } from './drawingState.js';
import { load as loadPersisted, saveDebounced } from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const rooms = new RoomManager();

// ---------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------
function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';

  // Prevent path traversal outside the client directory.
  const resolved = path.normalize(path.join(CLIENT_DIR, reqPath));
  if (!resolved.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(serveStatic);

// ---------------------------------------------------------------------
// WebSocket upgrade + per-connection protocol handling
// ---------------------------------------------------------------------
server.on('upgrade', (req, socket, head) => {
  if (!isWebSocketUpgrade(req)) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'lobby';
  const name = url.searchParams.get('name') || undefined;

  acceptWebSocket(req, socket, head, (conn) => {
    handleConnection(conn, roomId, name);
  });
});

function handleConnection(conn, roomId, name) {
  const userId = crypto.randomUUID();
  const room = rooms.getOrCreate(roomId);

  // First user into a fresh room: try to restore any previously-saved drawing.
  if (room.state.committed.length === 0) {
    const persisted = loadPersisted(roomId);
    if (persisted) {
      room.state = DrawingState.fromJSON(persisted);
    }
  }

  const user = room.addUser(userId, conn, name);

  // Tell the newcomer everything they need to render current state.
  conn.send({
    type: 'init',
    userId,
    color: user.color,
    users: room.userList(),
    strokes: room.state.getAll(),
  });

  // Tell everyone else someone joined.
  room.broadcast({ type: 'user:joined', user: { id: userId, color: user.color, name: user.name } }, userId);

  conn.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      conn.send({ type: 'error', message: 'Malformed JSON message' });
      return;
    }
    try {
      handleMessage(room, roomId, userId, msg);
    } catch (err) {
      console.error('[ws] handler error:', err);
      conn.send({ type: 'error', message: 'Server error processing your message' });
    }
  });

  conn.on('close', () => {
    room.removeUser(userId);
    room.broadcast({ type: 'user:left', userId });
    rooms.deleteIfEmpty(roomId);
  });

  conn.on('error', () => {
    /* 'close' will also fire; nothing extra to do */
  });

  // Heartbeat: ping periodically so dead connections (e.g. a phone that
  // dropped Wi-Fi without a clean close) get reaped instead of leaking.
  const heartbeat = setInterval(() => {
    if (!conn.alive) {
      clearInterval(heartbeat);
      return;
    }
    conn.ping();
  }, 25000);
  conn.on('close', () => clearInterval(heartbeat));
}

function handleMessage(room, roomId, userId, msg) {
  switch (msg.type) {
    case 'stroke:start': {
      room.broadcast(
        {
          type: 'stroke:start',
          userId,
          strokeId: msg.strokeId,
          tool: msg.tool,
          color: msg.color,
          width: msg.width,
          point: msg.point,
        },
        userId
      );
      // Track the in-progress stroke server-side so we can commit it on stroke:end
      // even though intermediate points aren't stored (keeps memory bounded).
      room._pending = room._pending || new Map();
      room._pending.set(msg.strokeId, {
        id: msg.strokeId,
        userId,
        tool: msg.tool,
        color: msg.color,
        width: msg.width,
        points: [msg.point],
      });
      break;
    }

    case 'stroke:points': {
      if (!Array.isArray(msg.points) || msg.points.length === 0) break;
      room.broadcast({ type: 'stroke:points', strokeId: msg.strokeId, points: msg.points }, userId);
      const pending = room._pending && room._pending.get(msg.strokeId);
      if (pending) pending.points.push(...msg.points);
      break;
    }

    case 'stroke:end': {
      const pending = room._pending && room._pending.get(msg.strokeId);
      room._pending && room._pending.delete(msg.strokeId);
      if (pending && pending.points.length > 0) {
        room.state.commitStroke(pending);
        saveDebounced(roomId, room.state.toJSON());
        room.broadcast({ type: 'stroke:end', strokeId: msg.strokeId, stroke: pending }, userId);
      }
      break;
    }

    case 'cursor:move': {
      room.broadcast({ type: 'cursor:move', userId, point: msg.point }, userId);
      break;
    }

    case 'undo': {
      const stroke = room.state.undo();
      if (stroke) {
        saveDebounced(roomId, room.state.toJSON());
        room.broadcast({ type: 'state:sync', strokes: room.state.getAll(), reason: 'undo' });
      }
      break;
    }

    case 'redo': {
      const stroke = room.state.redo();
      if (stroke) {
        saveDebounced(roomId, room.state.toJSON());
        room.broadcast({ type: 'state:sync', strokes: room.state.getAll(), reason: 'redo' });
      }
      break;
    }

    case 'clear': {
      room.state.clear();
      saveDebounced(roomId, room.state.toJSON());
      room.broadcast({ type: 'state:sync', strokes: [], reason: 'clear' });
      break;
    }

    case 'ping': {
      const conn = room.get(userId)?.conn;
      conn && conn.send({ type: 'pong', t: msg.t });
      break;
    }

    default:
      // Unknown message type: ignore rather than crash the connection.
      break;
  }
}

server.listen(PORT, () => {
  console.log(`Collaborative canvas server listening on http://localhost:${PORT}`);
});
