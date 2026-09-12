/**
 * wsServer.js
 * -----------
 * A minimal, dependency-free implementation of the WebSocket protocol
 * (RFC 6455) on top of Node's raw TCP sockets.
 *
 * WHY WRITE THIS BY HAND instead of using `ws` or `socket.io`?
 * The assignment brief explicitly probes "raw skills" on the frontend side
 * (no canvas libraries, no frameworks). We extend that same philosophy to
 * the transport layer: implementing the handshake + frame format ourselves
 * demonstrates an understanding of what those libraries do under the hood,
 * and it also means the project has ZERO npm dependencies, so `npm install`
 * is instant and there's nothing to go wrong on a fresh deploy target.
 *
 * This implementation supports exactly what the app needs:
 *   - The opening HTTP Upgrade handshake (Sec-WebSocket-Accept)
 *   - Text frames (JSON messages), with masking/unmasking per spec
 *   - Fragmented messages (continuation frames)
 *   - Ping / Pong / Close control frames
 *   - Extended payload lengths (16-bit and 64-bit)
 *
 * It intentionally does NOT implement permessage-deflate or binary frame
 * subtleties beyond what's needed here — keeping the surface area small and
 * auditable was more valuable than full spec coverage for this use case.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

// Fixed GUID from the WebSocket spec, concatenated with the client's key
// and SHA-1 hashed to prove the server "understood" the handshake.
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/**
 * Wraps a raw net.Socket (obtained from an HTTP upgrade) and speaks the
 * WebSocket framing protocol over it. Emits 'message', 'close', 'error'.
 */
export class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => {
      this.alive = false;
      this.emit('close');
    });
    socket.on('error', (err) => this.emit('error', err));
  }

  /** Feed newly-arrived bytes into the parser and drain as many full frames as possible. */
  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    // A single TCP chunk may contain several frames, and a frame may span
    // several chunks — keep trying until we can't parse a complete frame.
    while (this._tryParseOneFrame()) {
      /* loop */
    }
  }

  /** Attempt to parse exactly one frame from the front of the buffer. Returns true if it did. */
  _tryParseOneFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return false;

    const byte1 = buf[0];
    const byte2 = buf[1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return false;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return false;
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      payloadLen = high * 2 ** 32 + low; // safe: messages here are far smaller than 2^53
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return false; // wait for more bytes

    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    // Consume this frame from the buffer before handling it.
    this._buffer = buf.subarray(offset + payloadLen);
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OPCODE.CLOSE) {
      this.close();
      return;
    }
    if (opcode === OPCODE.PING) {
      this._sendFrame(OPCODE.PONG, payload);
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.emit('pong');
      return;
    }

    if (opcode === OPCODE.CONTINUATION) {
      this._fragments.push(payload);
    } else {
      // Start of a new (possibly fragmented) message.
      this._fragments = [payload];
      this._fragmentOpcode = opcode;
    }

    if (fin) {
      const full = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
      this._fragments = [];
      if (this._fragmentOpcode === OPCODE.TEXT) {
        this.emit('message', full.toString('utf8'));
      } else if (this._fragmentOpcode === OPCODE.BINARY) {
        this.emit('message', full);
      }
    }
  }

  /** Send a JSON-serializable value or a raw string as a text frame. */
  send(data) {
    if (!this.alive) return;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    this._sendFrame(OPCODE.TEXT, Buffer.from(str, 'utf8'));
  }

  ping() {
    if (this.alive) this._sendFrame(OPCODE.PING, Buffer.alloc(0));
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    // Server->client frames are never masked (masking is client-to-server only).
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len % 2 ** 32, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this.emit('error', err);
    }
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try {
      this._sendFrame(OPCODE.CLOSE, Buffer.alloc(0));
    } catch {
      /* socket may already be gone */
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.emit('close');
  }
}

/** True if this HTTP request is asking to be upgraded to a WebSocket. */
export function isWebSocketUpgrade(req) {
  const upgrade = req.headers.upgrade || '';
  return req.headers.connection?.toLowerCase().includes('upgrade') && upgrade.toLowerCase() === 'websocket';
}

/**
 * Complete the WebSocket handshake on an upgraded HTTP request and hand the
 * resulting connection to `onConnection(conn, req)`.
 */
export function acceptWebSocket(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = crypto.createHash('sha1').update(key + WS_MAGIC_GUID).digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n',
  ].join('\r\n');

  socket.write(responseHeaders);
  socket.setNoDelay(true);

  const conn = new WSConnection(socket);
  onConnection(conn, req);

  // If any bytes from the client arrived attached to the upgrade request
  // itself (rare, but allowed by the spec), feed them into the parser.
  if (head && head.length) {
    conn._onData(head);
  }
}
