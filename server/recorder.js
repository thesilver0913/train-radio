'use strict';
// 通話録音: チャンネルごとに「話中ランプが点灯している間」を1ファイルに保存する。
//  - 受信したADPCM音声をデコードし、時間軸上で全員分をミックスして 8kHz/16bit/モノラルのWAVに書き出す
//  - 通話が終わっても recordGapSec(既定3秒)以内に次の通話が始まれば、同じファイルに連結する(間は無音)
//  - ファイル名: <チャンネル番号>ch_<年月日>_<時分秒>.wav   例: 80ch_20261120_143005.wav
const fs = require('fs'), path = require('path');
const ADPCM = require('./adpcm');
const SR = 8000, FR = 160, HOLD = SR * 0.4;       // 遅れて届く音声のために書き出しを0.4秒遅らせる
const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

function wavHeader(dataBytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataBytes, 40); return b;
}

class Recorder {
  constructor(ch, getCfg, baseDir) { this.ch = ch; this.cfg = getCfg; this.baseDir = baseDir; this.fd = null; this.stopTimer = null; this.flushTimer = null; }
  get active() { return this.fd !== null; }

  // busy: その時点で話中か。サーバーの状態が変わるたび/音声が届くたびに呼ぶ
  sync(busy) {
    const want = busy && this.cfg().recordEnabled;
    if (want) {
      if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
      if (!this.fd) this._start(Date.now());
    } else if (this.fd && !this.stopTimer) {
      this.endAt = Date.now();
      this.stopTimer = setTimeout(() => this._finish(), Math.max(0, this.cfg().recordGapSec) * 1000);
    }
  }
  _start(now) {
    const dir = path.resolve(this.baseDir, this.cfg().recordDir);
    let file;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = `${this.ch}ch_${stamp(new Date(now))}`; file = path.join(dir, name + '.wav');
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${name}_${i}.wav`);
      this.fd = fs.openSync(file, 'w');
    } catch (e) { console.warn('録音ファイルを作成できません:', e.message); this.fd = null; return; }
    this.file = file; this.t0 = now; this.written = 0; this.acc = new Int32Array(SR * 10); this.accLen = 0; this.srcs = new Map(); this.maxEnd = 0; this.endAt = 0;
    fs.writeSync(this.fd, wavHeader(0), 0, 44, 0);
    this.flushTimer = setInterval(() => this._flushTo(Math.floor((Date.now() - this.t0) * SR / 1000 - HOLD)), 250);
    console.log('録音開始:', file);
  }
  // 1フレーム(20ms)のADPCMを受け取り、その話者の時間軸位置に加算する
  frame(srcId, payload, now = Date.now()) {
    if (!this.fd || payload.length < 4) return;
    const pcm = ADPCM.decode(payload, FR);
    const arr = Math.max(0, Math.round((now - this.t0) * SR / 1000));
    let s = this.srcs.get(srcId); if (!s) { s = { next: -1e9 }; this.srcs.set(srcId, s); }
    let pos = arr > s.next + 800 ? arr : s.next;     // 0.1秒以上空いたら新しい発話。連続していれば隙間なく並べる
    pos = Math.max(pos, this.written); s.next = pos + FR; this.maxEnd = Math.max(this.maxEnd, pos + FR);
    const off = pos - this.written, need = off + FR;
    if (this.acc.length < need) { const n = new Int32Array(Math.max(need, this.acc.length * 2)); n.set(this.acc.subarray(0, this.accLen)); this.acc = n; }
    for (let i = 0; i < FR; i++) this.acc[off + i] += Math.round(pcm[i] * 32768);
    if (need > this.accLen) this.accLen = need;
  }
  _flushTo(upto) {
    if (!this.fd) return; const n = upto - this.written; if (n <= 0) return;
    const out = Buffer.allocUnsafe(n * 2);
    for (let i = 0; i < n; i++) { let v = i < this.accLen ? this.acc[i] : 0; v = v > 32767 ? 32767 : v < -32768 ? -32768 : v; out.writeInt16LE(v, i * 2); }
    try {
      fs.writeSync(this.fd, out, 0, out.length, 44 + this.written * 2);      // Windowsでも安全なよう、書き込みは常に位置を明示
      this.written = upto; fs.writeSync(this.fd, wavHeader(this.written * 2), 0, 44, 0);   // 途中終了してもファイルが再生できるよう毎回ヘッダを更新
    } catch (e) { console.warn('録音の書き込みに失敗:', e.message); }
    const rest = Math.max(0, this.accLen - n);
    if (rest) this.acc.copyWithin(0, n, this.accLen);
    this.acc.fill(0, rest, this.accLen); this.accLen = rest;
  }
  _finish() {
    if (!this.fd) return;
    clearInterval(this.flushTimer); clearTimeout(this.stopTimer); this.stopTimer = null;
    const endPos = Math.round(((this.endAt || Date.now()) - this.t0) * SR / 1000);
    this._flushTo(Math.max(endPos, this.maxEnd, this.written));
    try { fs.closeSync(this.fd); } catch (e) {}
    console.log('録音終了:', this.file, (this.written / SR).toFixed(1) + '秒'); this.fd = null;
  }
  stop() { if (this.fd) { if (!this.endAt) this.endAt = Date.now(); this._finish(); } }
}
module.exports = { Recorder };
