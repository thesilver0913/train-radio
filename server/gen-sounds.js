'use strict';
// 仮の効果音を生成します。同名のwavファイルで置き換えてください(例: sounds/chime80.wav)。
const fs = require('fs'), path = require('path');
const SR = 16000, DIR = path.join(__dirname, 'sounds');
fs.mkdirSync(DIR, { recursive: true });
function wav(name, samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.max(-1, Math.min(1, v)) * 32000 | 0, 44 + i * 2));
  fs.writeFileSync(path.join(DIR, name + '.wav'), b);
}
const mk = (sec) => new Float64Array(Math.round(sec * SR));
function tone(buf, t0, dur, f, amp, decay) {
  for (let i = 0; i < dur * SR; i++) {
    const t = i / SR, k = t0 * SR + i | 0; if (k >= buf.length) break;
    const env = Math.min(1, t * 200) * (decay ? Math.exp(-t * decay) : Math.min(1, (dur - t) * 100));
    buf[k] += Math.sin(2 * Math.PI * f * t) * amp * env;
  }
}
let b;
b = mk(1.6); tone(b, 0, 0.8, 880, 0.5, 4); tone(b, 0.5, 1.1, 660, 0.5, 3.5); wav('chime80', b);                       // 80ch用チャイム
b = mk(1.6); [523, 659, 784].forEach((f, i) => tone(b, i * 0.35, 0.7, f, 0.45, 5)); wav('chime81', b);               // 81ch用チャイム
b = mk(8); [523, 659, 784, 659, 587, 698, 880, 698, 659, 784, 1047, 784, 698, 587, 523, 392].forEach((f, i) => tone(b, i * 0.5, 0.5, f, 0.3, 3)); wav('hold', b); // 保留音
b = mk(3); tone(b, 0, 3, 800, 0.5, 0); wav('tone800', b);                                                              // 試験トーン(列車→サーバー)
b = mk(3); tone(b, 0, 3, 1000, 0.5, 0); wav('test_return', b);                                                         // 試験折り返し信号
b = mk(3); for (let i = 0; i < SR; i++) b[i] = Math.sin(2 * Math.PI * 400 * i / SR) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 16 * i / SR)) * 0.4; wav('ringback', b); // 発信音(1秒鳴動/2秒無音)
b = mk(4); for (let r = 0; r < 2; r++) for (let i = 0; i < SR * 0.8; i++) { const t = i / SR; b[(r * 1.0 * SR + i) | 0] = Math.sin(2 * Math.PI * 1300 * t) * (Math.sin(2 * Math.PI * 20 * t) > 0 ? 0.4 : 0.1); } wav('bell', b); // 指令着信ベル
b = mk(1.4); for (let k = 0; k < 5; k++) tone(b, k * 0.16, 0.09, 2000, 0.5, 0); wav('guard', b);                      // 防護発報の警報音「ピピピピピ」(5連ビープ+間、ループ再生)
console.log('sounds generated in', DIR);
