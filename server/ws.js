'use strict';

/**
 * Minimal RFC 6455 WebSocket server built on Node core primitives only.
 *
 * The production system in the brief moves market data over WebSockets. This
 * demo mirrors that transport without pulling in the `ws` package, so the whole
 * project stays dependency-free and runs with a bare `node` binary. In a real
 * deployment this module is the seam where you would drop in `ws`/`uWebSockets`
 * for backpressure handling and permessage-deflate.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Compute the Sec-WebSocket-Accept response value for a client key. */
function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

/** Encode a UTF-8 string as a single unmasked server text frame. */
function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; // FIN + text opcode
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2); // high 32 bits of length (always 0 here)
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

/** Encode a control frame (close/ping/pong) with an optional payload. */
function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length; // control frames are always < 126 bytes
  const header = Buffer.from([0x80 | opcode, len]);
  return Buffer.concat([header, payload]);
}

/**
 * Pull as many complete frames as possible out of an accumulated buffer.
 * Returns the parsed frames and whatever trailing bytes remain unconsumed.
 */
function drainFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      // Ignore the high 32 bits; demo payloads never exceed 4 GiB.
      length = buffer.readUInt32BE(cursor + 4);
      cursor += 8;
    }

    let mask;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.slice(cursor, cursor + 4);
      cursor += 4;
    }

    if (cursor + length > buffer.length) break; // wait for more bytes

    let payload = buffer.slice(cursor, cursor + length);
    if (masked) {
      const unmasked = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i & 3];
      }
      payload = unmasked;
    }

    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.slice(offset) };
}

/**
 * Attaches a WebSocket hub to an existing http.Server. Emits `connection`,
 * `message`, and `close`. `broadcast(obj)` fans a JSON payload out to every
 * open client.
 */
class WebSocketHub extends EventEmitter {
  constructor(httpServer, { path = '/ws' } = {}) {
    super();
    this.path = path;
    this.clients = new Set();
    httpServer.on('upgrade', (req, socket) => this._handleUpgrade(req, socket));
  }

  _handleUpgrade(req, socket) {
    if (req.url.split('?')[0] !== this.path) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ];
    socket.write(responseHeaders.join('\r\n'));

    socket.setNoDelay(true);
    this.clients.add(socket);
    this.emit('connection', socket);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = drainFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        this._handleFrame(socket, frame);
      }
    });

    const cleanup = () => {
      if (this.clients.delete(socket)) {
        this.emit('close', socket);
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  _handleFrame(socket, frame) {
    switch (frame.opcode) {
      case 0x8: // close
        try {
          socket.write(encodeControlFrame(0x8));
        } catch (_) {
          /* socket may already be gone */
        }
        socket.end();
        break;
      case 0x9: // ping -> pong
        try {
          socket.write(encodeControlFrame(0xa, frame.payload));
        } catch (_) {
          /* ignore */
        }
        break;
      case 0x1: // text
        this.emit('message', socket, frame.payload.toString('utf8'));
        break;
      default:
        break; // binary/continuation unused in this demo
    }
  }

  /** Send a JSON object to a single client. */
  sendJSON(socket, obj) {
    if (socket.writable) {
      socket.write(encodeTextFrame(JSON.stringify(obj)));
    }
  }

  /** Fan a JSON object out to every connected client. */
  broadcast(obj) {
    const frame = encodeTextFrame(JSON.stringify(obj));
    for (const socket of this.clients) {
      if (socket.writable) socket.write(frame);
    }
  }

  get size() {
    return this.clients.size;
  }
}

module.exports = { WebSocketHub };
