/**
 * ws-client.js
 * ------------
 * Thin wrapper around the browser's native `WebSocket` (no client library
 * needed — every evergreen browser has had this for over a decade).
 *
 * Handles the two things raw WebSocket usage always needs bolted on:
 *   1. Reconnection with exponential backoff + jitter when the connection
 *      drops (flaky Wi-Fi, laptop sleep, server restart, etc.) — this is
 *      the "Handling of network issues" line item in the brief.
 *   2. A tiny ping/pong round trip for the latency readout in the toolbar.
 *
 * Exposes a small EventTarget-based API so main.js doesn't need to know
 * anything about reconnect internals — it just listens for 'message',
 * 'statuschange', etc.
 */

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10000;
const PING_INTERVAL_MS = 5000;

export class WSClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.socket = null;
    this.status = 'disconnected'; // 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
    this._attempt = 0;
    this._manuallyClosed = false;
    this._pingTimer = null;
    this._lastPingSent = 0;
    this.latencyMs = null;

    this._connect();
  }

  _setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('statuschange', { detail: status }));
  }

  _connect() {
    this._setStatus(this._attempt === 0 ? 'connecting' : 'reconnecting');
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('open', () => {
      this._attempt = 0;
      this._setStatus('connected');
      this._startPing();
    });

    this.socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        this.latencyMs = Date.now() - msg.t;
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    });

    this.socket.addEventListener('close', () => {
      this._stopPing();
      if (this._manuallyClosed) {
        this._setStatus('disconnected');
        return;
      }
      this._setStatus('reconnecting');
      this._scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      // 'close' fires right after 'error' for a failed connection attempt;
      // let the close handler own the reconnect logic to avoid double-scheduling.
    });
  }

  _scheduleReconnect() {
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this._attempt) * (0.75 + Math.random() * 0.5);
    this._attempt += 1;
    setTimeout(() => {
      if (!this._manuallyClosed) this._connect();
    }, delay);
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      this.send({ type: 'ping', t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(obj));
      return true;
    }
    return false; // caller decides whether a dropped message matters
  }

  close() {
    this._manuallyClosed = true;
    this._stopPing();
    this.socket && this.socket.close();
  }
}
