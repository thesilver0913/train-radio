'use strict';
// 依存なしの最小WebSocketサーバー実装(RFC6455: テキスト/バイナリ/ping/pong/close/分割フレーム)
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20;

class Conn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frag = null; this.closed = false;
    this.lastPong = Date.now(); this.onmessage = null; this.onclose = null; this.party = null;
    socket.setNoDelay(true); socket.setKeepAlive(true, 20000);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => {});
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastPong > 50000) return socket.destroy();
      this._write(this._frame(9, Buffer.alloc(0)));
    }, 20000);
  }
  _frame(op, payload) {
    const len = payload.length; let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op; return Buffer.concat([h, payload]);
  }
  _write(b) { if (!this.closed) try { this.socket.write(b); } catch (e) {} }
  send(data) { const s = typeof data === 'string'; this._write(this._frame(s ? 1 : 2, s ? Buffer.from(data) : data)); }
  // 音声は遅延を溜めないため、送信キューが膨らんでいる場合は破棄する
  sendAudio(buf) { if (this.closed || this.socket.writableLength > 48000) return; this._write(this._frame(2, buf)); }
  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this._write(this._frame(8, p)); this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
  _closed() { if (this.closed) return; this.closed = true; clearInterval(this.pinger); if (this.onclose) this.onclose(); }
  _data(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_PAYLOAD) return this.socket.destroy();
      const need = off + (masked ? 4 : 0) + len; if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = b.subarray(off, off + 4); const o = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ m[i & 3]; payload = o; }
      else payload = Buffer.from(payload);
      this.buf = b.subarray(need);
      this._frameIn(op, fin, payload);
    }
  }
  _frameIn(op, fin, payload) {
    if (op === 8) return this.close();
    if (op === 9) return this._write(this._frame(10, payload));
    if (op === 10) { this.lastPong = Date.now(); return; }
    if (op === 1 || op === 2) { this.frag = { op, parts: [payload] }; }
    else if (op === 0 && this.frag) this.frag.parts.push(payload); else return;
    if (!fin) return;
    const data = Buffer.concat(this.frag.parts), isBin = this.frag.op === 2; this.frag = null;
    this.lastPong = Date.now();
    if (this.onmessage) this.onmessage(isBin ? data : data.toString('utf8'), isBin);
  }
}

function attach(server, handler) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const conn = new Conn(socket); handler(conn, req);
    if (head && head.length) conn._data(head);
  });
}
module.exports = { attach };
