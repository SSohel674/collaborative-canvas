/**
 * rooms.js
 * --------
 * In-memory room + user bookkeeping. A "room" is just an isolated canvas
 * session: everyone who connects with the same ?room= id sees the same
 * drawing and each other's cursors. Rooms are created lazily and dropped
 * once the last user leaves (their strokes are persisted to disk before
 * that happens — see persistence.js).
 */

import { DrawingState } from './drawingState.js';

const USER_COLORS = [
  '#e6194b', '#3cb44b', '#f5c518', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990',
];

export class Room {
  constructor(id) {
    this.id = id;
    this.users = new Map(); // userId -> { conn, color, name }
    this.state = new DrawingState();
    this._colorCursor = 0;
  }

  nextColor() {
    const color = USER_COLORS[this._colorCursor % USER_COLORS.length];
    this._colorCursor += 1;
    return color;
  }

  addUser(userId, conn, name) {
    const user = { conn, color: this.nextColor(), name: name || `Guest-${userId.slice(0, 4)}` };
    this.users.set(userId, user);
    return user;
  }

  removeUser(userId) {
    this.users.delete(userId);
  }

  get(userId) {
    return this.users.get(userId);
  }

  isEmpty() {
    return this.users.size === 0;
  }

  userList() {
    return [...this.users.entries()].map(([id, u]) => ({ id, color: u.color, name: u.name }));
  }

  /** Send `message` (an object; will be JSON-stringified once) to every user except `exceptUserId`. */
  broadcast(message, exceptUserId = null) {
    const payload = JSON.stringify(message);
    for (const [uid, user] of this.users) {
      if (uid === exceptUserId) continue;
      try {
        user.conn.send(payload);
      } catch {
        /* dead connection will be cleaned up by its own close handler */
      }
    }
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreate(roomId) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  get(roomId) {
    return this.rooms.get(roomId);
  }

  deleteIfEmpty(roomId) {
    const room = this.rooms.get(roomId);
    if (room && room.isEmpty()) {
      this.rooms.delete(roomId);
      return true;
    }
    return false;
  }
}
