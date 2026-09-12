/**
 * canvas.js
 * ---------
 * All raw <canvas> work lives here. No drawing libraries — just the 2D
 * context API.
 *
 * THREE-LAYER ARCHITECTURE (why):
 *   mainCanvas   - committed, "permanent" strokes. Repainted from scratch
 *                  only on init / undo / redo / clear (rare). Otherwise we
 *                  just paint ONE new stroke on top of it when it commits —
 *                  O(1) w.r.t. history size instead of O(n) per stroke.
 *   liveCanvas   - strokes that are still being drawn (by us or by anyone
 *                  else). Repainted every animation frame while dirty, but
 *                  there are only ever a handful of these at once (one per
 *                  actively-drawing user), so a full repaint is cheap.
 *   cursorCanvas - other users' live pointer positions. Same repaint
 *                  strategy as liveCanvas, kept separate so cursor updates
 *                  (very frequent) never touch stroke pixels.
 *
 * Splitting these means: (a) we never have to "erase just one stroke" from
 * a canvas that has other content baked into it — a genuinely hard problem
 * with the plain 2D API — and (b) cursor churn can't cause visible flicker
 * or redraw cost on the stroke layers.
 */

/** Paints one full stroke onto a given 2D context. Used for BOTH the fast
 *  "append one committed stroke" path and full history replay — guaranteeing
 *  they always render identically. */
export function paintStroke(ctx, stroke) {
  const { tool, color, width, points } = stroke;
  if (!points || points.length === 0) return;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = width;

  if (tool === 'eraser') {
    // Punch a transparent hole rather than painting the background color —
    // this keeps erasing correct even if the canvas background changes.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
  }

  if (tool === 'rectangle') {
    const p0 = points[0];
    const p1 = points[points.length - 1];
    ctx.strokeRect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
    ctx.restore();
    return;
  }

  if (points.length === 1) {
    // A tap with no movement: draw a dot so single clicks are visible.
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Smooth freehand path: quadratic curve through consecutive midpoints.
  // This is the standard "midpoint smoothing" technique — using the raw
  // point as the curve's control point and the midpoint between it and the
  // next raw point as the curve's endpoint avoids the "faceted" look of
  // drawing straight lineTo segments between noisy pointer samples.
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();
}

export class CanvasManager {
  constructor(mainCanvas, liveCanvas, cursorCanvas, wrapEl) {
    this.mainCanvas = mainCanvas;
    this.liveCanvas = liveCanvas;
    this.cursorCanvas = cursorCanvas;
    this.wrapEl = wrapEl;

    this.mainCtx = mainCanvas.getContext('2d');
    this.liveCtx = liveCanvas.getContext('2d');
    this.cursorCtx = cursorCanvas.getContext('2d');

    /** @type {Map<string, {tool,color,width,points:Array}>} strokes currently being drawn, by anyone */
    this.liveStrokes = new Map();
    /** @type {Map<string, {x,y,color,name}>} other users' latest cursor position */
    this.cursors = new Map();

    this._dpr = Math.max(1, window.devicePixelRatio || 1);
    this._dirty = false;
    this._committedStrokes = [];

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(wrapEl);
    this.resize();

    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);

    // FPS tracking
    this._frameCount = 0;
    this._lastFpsSample = performance.now();
    this.fps = 0;
  }

  resize() {
    const { width, height } = this.wrapEl.getBoundingClientRect();
    for (const canvas of [this.mainCanvas, this.liveCanvas, this.cursorCanvas]) {
      canvas.width = Math.round(width * this._dpr);
      canvas.height = Math.round(height * this._dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    // Scale all contexts so drawing code can keep working in CSS pixels.
    for (const ctx of [this.mainCtx, this.liveCtx, this.cursorCtx]) {
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    }
    this.renderAll(this._committedStrokes);
  }

  /** Full replay of committed history. Used for init / undo / redo / clear / resize. */
  renderAll(strokes) {
    this._committedStrokes = strokes;
    const { width, height } = this.wrapEl.getBoundingClientRect();
    this.mainCtx.clearRect(0, 0, width, height);
    for (const stroke of strokes) {
      paintStroke(this.mainCtx, stroke);
    }
  }

  /** Fast path: append exactly one newly-committed stroke without touching the rest. */
  commitStroke(stroke) {
    this._committedStrokes.push(stroke);
    paintStroke(this.mainCtx, stroke);
  }

  // --- Live (in-progress) strokes -----------------------------------

  beginLiveStroke(strokeId, tool, color, width, point) {
    this.liveStrokes.set(strokeId, { tool, color, width, points: [point] });
    this._dirty = true;
  }

  addLivePoint(strokeId, point) {
    const s = this.liveStrokes.get(strokeId);
    if (!s) return;
    s.points.push(point);
    this._dirty = true;
  }

  /** Stroke finished: drop it from the live layer (caller is responsible for committing it to main). */
  endLiveStroke(strokeId) {
    this.liveStrokes.delete(strokeId);
    this._dirty = true;
  }

  // --- Cursors --------------------------------------------------------

  setCursor(userId, point, color, name) {
    this.cursors.set(userId, { ...point, color, name });
    this._dirty = true;
  }

  removeCursor(userId) {
    this.cursors.delete(userId);
    this._dirty = true;
  }

  clearAllLive() {
    this.liveStrokes.clear();
    this.cursors.clear();
    this._dirty = true;
  }

  // --- Render loop ------------------------------------------------------

  _tick(now) {
    if (this._dirty) {
      this._redrawLiveLayer();
      this._redrawCursorLayer();
      this._dirty = false;
    }

    this._frameCount++;
    if (now - this._lastFpsSample >= 500) {
      this.fps = Math.round((this._frameCount * 1000) / (now - this._lastFpsSample));
      this._frameCount = 0;
      this._lastFpsSample = now;
    }

    requestAnimationFrame(this._tick);
  }

  _redrawLiveLayer() {
    const { width, height } = this.wrapEl.getBoundingClientRect();
    this.liveCtx.clearRect(0, 0, width, height);
    for (const stroke of this.liveStrokes.values()) {
      paintStroke(this.liveCtx, stroke);
    }
  }

  _redrawCursorLayer() {
    const { width, height } = this.wrapEl.getBoundingClientRect();
    const ctx = this.cursorCtx;
    ctx.clearRect(0, 0, width, height);
    for (const [, cursor] of this.cursors) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = cursor.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      ctx.font = '11px sans-serif';
      ctx.fillStyle = '#fff';
      const label = cursor.name || '';
      const padding = 4;
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = cursor.color;
      ctx.fillRect(cursor.x + 8, cursor.y - 8, textWidth + padding * 2, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, cursor.x + 8 + padding, cursor.y + 4);
      ctx.restore();
    }
  }

  /** Convert a pointer/touch client (page) coordinate into canvas-local CSS-pixel coordinates. */
  toLocalPoint(clientX, clientY) {
    const rect = this.mainCanvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
}
