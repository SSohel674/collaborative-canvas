/**
 * drawingState.js
 * ---------------
 * The authoritative, per-room record of what's been drawn.
 *
 * DESIGN NOTE — why undo/redo is simple here despite being "the hard part":
 * Freehand strokes almost never need to be merged or reordered against each
 * other — visually, "who drew what, in what order" is all that matters, and
 * two strokes drawn concurrently by different users simply stack on top of
 * each other in whatever order the SERVER received their `stroke:end`
 * events. That gives us a single source of truth for ordering "for free"
 * (the server, not the network, decides commit order).
 *
 * Given that, undo/redo can be a single GLOBAL stack shared by the whole
 * room rather than a per-user stack:
 *   - `undo()` pops the most recently committed stroke (regardless of who
 *     drew it) onto a redo stack.
 *   - `redo()` pops it back.
 *   - Any new stroke clears the redo stack (standard undo/redo semantics —
 *     you can't redo into a future that a new action just overwrote).
 *
 * This directly satisfies the brief's "User A undoes User B's stroke" case:
 * there's no special-casing needed, because undo was never per-user.
 *
 * Because clients redraw by REPLAYING this list from scratch (see
 * canvas.js's `renderAll`), the stack doesn't need to track *where* on the
 * canvas anything is — just the ordered list of stroke objects.
 */

export class DrawingState {
  constructor() {
    /** @type {Array<object>} ordered, committed strokes (oldest first) */
    this.committed = [];
    /** @type {Array<object>} strokes available to redo (most recent undo last) */
    this.redoStack = [];
  }

  /** Commit a finished stroke. Invalidates any pending redo history. */
  commitStroke(stroke) {
    this.committed.push(stroke);
    this.redoStack = [];
  }

  /** Undo the most recent committed stroke. Returns it, or null if nothing to undo. */
  undo() {
    if (this.committed.length === 0) return null;
    const stroke = this.committed.pop();
    this.redoStack.push(stroke);
    return stroke;
  }

  /** Redo the most recently undone stroke. Returns it, or null if nothing to redo. */
  redo() {
    if (this.redoStack.length === 0) return null;
    const stroke = this.redoStack.pop();
    this.committed.push(stroke);
    return stroke;
  }

  /** Wipe the canvas entirely (also a committable "action" for consistency, but we treat clear as immediate + non-undoable and document that tradeoff in the README). */
  clear() {
    this.committed = [];
    this.redoStack = [];
  }

  getAll() {
    return this.committed;
  }

  /** Plain-object snapshot used both for the `init` message and for disk persistence. */
  toJSON() {
    return { committed: this.committed };
  }

  static fromJSON(data) {
    const state = new DrawingState();
    if (data && Array.isArray(data.committed)) {
      state.committed = data.committed;
    }
    return state;
  }
}
