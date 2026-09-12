/**
 * main.js
 * -------
 * Wires the DOM, CanvasManager, and WSClient together. This is the only
 * file that touches `document` — canvas.js and ws-client.js are both
 * self-contained and reusable without it.
 */

import { CanvasManager } from './canvas.js';
import { WSClient } from './ws-client.js';

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------
const wrapEl = document.getElementById('canvasWrap');
const mainCanvas = document.getElementById('mainCanvas');
const liveCanvas = document.getElementById('liveCanvas');
const cursorCanvas = document.getElementById('cursorCanvas');

const toolButtons = [...document.querySelectorAll('.tool-btn')];
const colorPicker = document.getElementById('colorPicker');
const widthSlider = document.getElementById('widthSlider');
const widthLabel = document.getElementById('widthLabel');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const clearBtn = document.getElementById('clearBtn');
const saveBtn = document.getElementById('saveBtn');
const loadInput = document.getElementById('loadInput');
const roomInput = document.getElementById('roomInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const connStatusEl = document.getElementById('connStatus');
const fpsEl = document.getElementById('fpsCounter');
const latencyEl = document.getElementById('latencyCounter');
const userListEl = document.getElementById('userList');

// ---------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------
const canvasManager = new CanvasManager(mainCanvas, liveCanvas, cursorCanvas, wrapEl);

let myUserId = null;
let myColor = '#000000';
let currentTool = 'brush';
let currentColor = colorPicker.value;
let currentWidth = Number(widthSlider.value);

/** id -> { color, name } for everyone currently in the room (including us) */
const users = new Map();

let ws = null;

// Local in-progress stroke bookkeeping (for the pointer currently down).
let activeStrokeId = null;
let activeStrokePoints = []; // full history, used to build the final commit object
let outgoingBuffer = []; // points not yet flushed to the server this frame
let pendingCursor = null; // last cursor point not yet flushed this frame

function genId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------
// WebSocket connection (re-created whenever the room changes)
// ---------------------------------------------------------------------
function connect(room) {
  if (ws) ws.close();
  users.clear();
  canvasManager.clearAllLive();
  canvasManager.renderAll([]);
  renderUserList();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/?room=${encodeURIComponent(room)}`;
  ws = new WSClient(url);

  ws.addEventListener('statuschange', (e) => setConnStatus(e.detail));
  ws.addEventListener('message', (e) => handleServerMessage(e.detail));
}

function setConnStatus(status) {
  connStatusEl.className = `status ${status === 'connected' ? 'connected' : status === 'reconnecting' ? 'reconnecting' : 'disconnected'}`;
  const labels = { connected: '● Connected', connecting: '● Connecting…', reconnecting: '● Reconnecting…', disconnected: '● Disconnected' };
  connStatusEl.textContent = labels[status] || status;
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'init': {
      myUserId = msg.userId;
      myColor = msg.color;
      colorPicker.value = colorPicker.value || myColor;
      users.clear();
      for (const u of msg.users) users.set(u.id, { color: u.color, name: u.name });
      users.set(myUserId, { color: myColor, name: 'You' });
      canvasManager.renderAll(msg.strokes);
      renderUserList();
      break;
    }
    case 'user:joined': {
      users.set(msg.user.id, { color: msg.user.color, name: msg.user.name });
      renderUserList();
      break;
    }
    case 'user:left': {
      users.delete(msg.userId);
      canvasManager.removeCursor(msg.userId);
      renderUserList();
      break;
    }
    case 'stroke:start': {
      canvasManager.beginLiveStroke(msg.strokeId, msg.tool, msg.color, msg.width, msg.point);
      break;
    }
    case 'stroke:points': {
      for (const p of msg.points) canvasManager.addLivePoint(msg.strokeId, p);
      break;
    }
    case 'stroke:end': {
      canvasManager.endLiveStroke(msg.strokeId);
      canvasManager.commitStroke(msg.stroke);
      break;
    }
    case 'cursor:move': {
      const u = users.get(msg.userId);
      canvasManager.setCursor(msg.userId, msg.point, u?.color || '#888', u?.name || '');
      break;
    }
    case 'state:sync': {
      canvasManager.renderAll(msg.strokes);
      break;
    }
    case 'error': {
      console.error('[server]', msg.message);
      break;
    }
    default:
      break;
  }
}

function renderUserList() {
  userListEl.innerHTML = '';
  for (const [id, u] of users) {
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = u.color;
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(id === myUserId ? 'You' : u.name));
    userListEl.appendChild(chip);
  }
}

// ---------------------------------------------------------------------
// Drawing input (Pointer Events unify mouse / touch / pen — this alone
// covers the "mobile touch support" bonus with no separate touch handlers)
// ---------------------------------------------------------------------
mainCanvas.addEventListener('pointerdown', onPointerDown);
mainCanvas.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return; // left-click only
  mainCanvas.setPointerCapture(e.pointerId);
  const point = canvasManager.toLocalPoint(e.clientX, e.clientY);

  activeStrokeId = genId();
  activeStrokePoints = [point];

  canvasManager.beginLiveStroke(activeStrokeId, currentTool, currentColor, currentWidth, point);
  ws && ws.send({ type: 'stroke:start', strokeId: activeStrokeId, tool: currentTool, color: currentColor, width: currentWidth, point });
}

function onPointerMove(e) {
  const point = canvasManager.toLocalPoint(e.clientX, e.clientY);
  pendingCursor = point;

  if (!activeStrokeId) return;

  if (currentTool === 'rectangle') {
    // Rectangle preview only ever needs start + current corner, but we still
    // stream the point to the server the same way as freehand tools so its
    // pending copy ends up with the correct final corner too — paintStroke's
    // rectangle branch only looks at points[0] and points[last] regardless
    // of how many points are in between, so this is safe.
    activeStrokePoints = [activeStrokePoints[0], point];
    canvasManager.liveStrokes.set(activeStrokeId, {
      tool: 'rectangle',
      color: currentColor,
      width: currentWidth,
      points: activeStrokePoints,
    });
    canvasManager._dirty = true;
    outgoingBuffer = [point]; // only ever need to send the latest corner
    return;
  }

  activeStrokePoints.push(point);
  canvasManager.addLivePoint(activeStrokeId, point);
  outgoingBuffer.push(point);
}

function onPointerUp() {
  if (!activeStrokeId) return;
  flushOutgoing(); // make sure the last few points aren't lost

  const finalStroke = {
    id: activeStrokeId,
    userId: myUserId,
    tool: currentTool,
    color: currentColor,
    width: currentWidth,
    points: activeStrokePoints,
  };

  canvasManager.endLiveStroke(activeStrokeId);
  canvasManager.commitStroke(finalStroke); // instant local feedback; server will echo the authoritative copy to everyone else
  ws && ws.send({ type: 'stroke:end', strokeId: activeStrokeId });

  activeStrokeId = null;
  activeStrokePoints = [];
}

// Flush buffered outgoing points + cursor position at most once per animation frame.
// This is the client side of the batching strategy documented in server.js.
function flushOutgoing() {
  if (activeStrokeId && outgoingBuffer.length > 0) {
    ws && ws.send({ type: 'stroke:points', strokeId: activeStrokeId, points: outgoingBuffer });
    outgoingBuffer = [];
  }
  if (pendingCursor) {
    ws && ws.send({ type: 'cursor:move', point: pendingCursor });
    pendingCursor = null;
  }
  requestAnimationFrame(flushOutgoing);
}
requestAnimationFrame(flushOutgoing);

// ---------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------
for (const btn of toolButtons) {
  btn.addEventListener('click', () => {
    toolButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
  });
}

colorPicker.addEventListener('input', () => (currentColor = colorPicker.value));

widthSlider.addEventListener('input', () => {
  currentWidth = Number(widthSlider.value);
  widthLabel.textContent = `${currentWidth}px`;
});

undoBtn.addEventListener('click', () => ws && ws.send({ type: 'undo' }));
redoBtn.addEventListener('click', () => ws && ws.send({ type: 'redo' }));
clearBtn.addEventListener('click', () => {
  if (confirm('Clear the canvas for everyone in this room?')) {
    ws && ws.send({ type: 'clear' });
  }
});

// Keyboard shortcuts: Ctrl/Cmd+Z / Shift+Z, matching the desktop convention.
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  ws && ws.send({ type: e.shiftKey ? 'redo' : 'undo' });
});

joinRoomBtn.addEventListener('click', () => {
  const room = roomInput.value.trim() || 'lobby';
  const url = new URL(location.href);
  url.searchParams.set('room', room);
  history.replaceState(null, '', url);
  connect(room);
});

// ---------------------------------------------------------------------
// Save / Load (bonus: drawing persistence as a portable file, independent
// of the server's own auto-save — see server/persistence.js)
// ---------------------------------------------------------------------
saveBtn.addEventListener('click', () => {
  const data = JSON.stringify({ strokes: canvasManager._committedStrokes }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `drawing-${roomInput.value || 'lobby'}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

loadInput.addEventListener('change', async () => {
  const file = loadInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.strokes)) throw new Error('Invalid file: missing strokes array');
    canvasManager.renderAll(data.strokes);
  } catch (err) {
    alert(`Couldn't load that file: ${err.message}`);
  } finally {
    loadInput.value = '';
  }
});

// ---------------------------------------------------------------------
// Stats readout
// ---------------------------------------------------------------------
setInterval(() => {
  fpsEl.textContent = `FPS: ${canvasManager.fps || '--'}`;
  latencyEl.textContent = `Latency: ${ws && ws.latencyMs != null ? `${ws.latencyMs}ms` : '--'}`;
}, 500);

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
const initialRoom = new URL(location.href).searchParams.get('room') || roomInput.value || 'lobby';
roomInput.value = initialRoom;
setConnStatus('connecting');
connect(initialRoom);
