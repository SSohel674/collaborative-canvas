/**
 * persistence.js
 * --------------
 * Bonus feature: "Drawing persistence (save/load sessions)".
 *
 * Deliberately simple — one JSON file per room under data/, written with a
 * short debounce so a burst of strokes doesn't hammer the disk. This is
 * in-process, file-based persistence (fine for a single server instance /
 * assignment demo); a production version would swap this module for a real
 * datastore without touching any calling code, since the interface is just
 * `save(roomId, state)` / `load(roomId)`.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEBOUNCE_MS = 1500;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const pendingTimers = new Map(); // roomId -> Timeout

function filePathFor(roomId) {
  const safe = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

/** Load a previously-saved room state, or null if none exists / it's corrupt. */
export function load(roomId) {
  try {
    const raw = fs.readFileSync(filePathFor(roomId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Debounced save — safe to call on every stroke commit. */
export function saveDebounced(roomId, stateJSON) {
  if (pendingTimers.has(roomId)) {
    clearTimeout(pendingTimers.get(roomId));
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(roomId);
    try {
      fs.writeFileSync(filePathFor(roomId), JSON.stringify(stateJSON));
    } catch (err) {
      console.error(`[persistence] failed to save room "${roomId}":`, err.message);
    }
  }, DEBOUNCE_MS);
  pendingTimers.set(roomId, timer);
}
