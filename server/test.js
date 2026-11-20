'use strict';
// 統合テスト: node test.js  (サーバーを内部で起動し、モックJSONと疑似クライアントで通話フローを検証)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PORT = 18090, MOCK = 18091;
let posTable = { '9051': 11.5, '7100': 14.5, '6110': 11.5, '9053': 8.5, '9055': 20.0 };
let jsonNowOffset = 0;
const mock = http.createServer((q, r) => {
  const train = {}; for (const [k, v] of Object.entries(posTable)) train[k] = { pos: v, dir: 0 };
  r.end(JSON.stringify({ now: Math.floor(Date.now() / 1000) + jsonNowOffset, train }));
}).listen(MOCK);
const cfgPath = path.join(os.tmpdir(), 'radio-test-' + Date.now() + '.json'), RECDIR = path.join(os.tmpdir(), 'radio-rec-' + Date.now());
fs.writeFileSync(cfgPath, JSON.stringify({ dispatcherPassword: 'pw', jsonUrls: { 80: `http://127.0.0.1:${MOCK}/a`, 81: `http://127.0.0.1:${MOCK}/b` }, pollIntervalSec: 1, ringTimeoutSec: 1, testDurationMs: 300, recordDir: RECDIR, recordGapSec: 1 }));
process.env.RADIO_PORT = PORT; process.env.RADIO_CONFIG = cfgPath;
const { server } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = '') { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(10); } }
class C {
  constructor(name) { this.name = name; this.msgs = []; this.audio = []; this.st = null; }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`); this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => {
      if (typeof e.data === 'string') { const m = JSON.parse(e.data); this.msgs.push(m); if (m.t === 'st' || m.t === 'ds') this.st = m; if (m.t === 'welcome') this.welcome = m; }
      else this.audio.push(new Uint8Array(e.data));
    };
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); return this;
  }
  tx(o) { this.ws.send(JSON.stringify(o)); }
  hello(o) { this.tx({ t: 'hello', key: this.name + '-key', vehicle: 'shimoden', ...o }); return until(() => this.welcome || this.msgs.find((m) => m.t === 'err'), 1500, this.name + ' hello'); }
  frame(flags = 0, n = 10) { const b = new Uint8Array(3 + n); b[0] = 1; b[1] = 0; b[2] = flags; b.fill(7, 3); this.ws.send(b); }
  ev(e) { return this.msgs.filter((m) => m.t === 'ev' && m.e === e); }
  clear() { this.msgs = []; this.audio = []; }
}
const train = async (name, ch, no, extra = {}) => { const c = await new C(name).open(); await c.hello({ ch, trainNo: no, ...extra }); return c; };
const disp = async (name, ch = 80) => { const c = await new C(name).open(); await c.hello({ ch, trainNo: '12306', password: 'pw' }); return c; };
let n = 0; const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

(async () => {
  await sleep(300); // 初回JSON取得待ち
  // --- 認証
  const bad = await new C('bad').open(); await bad.hello({ ch: 80, trainNo: '12306', password: 'x' });
  assert(bad.msgs.find((m) => m.t === 'err' && m.fatal)); ok('指令パスワード不一致は拒否');
  // --- 無線機番号
  const nos = new Set(); const many = [];
  for (let i = 0; i < 60; i++) { const c = await train('m' + i, 80, String(1000 + i), { vehicle: i % 2 ? 'chikatetsu' : 'shimoden' }); many.push(c); nos.add(c.welcome.label.replace(/^\D+/, '')); const v = Number(c.welcome.label.replace(/^\D+/, '')); assert(v >= 40 && v <= 979, 'range ' + v); assert(/^(しもでん|ちかてつ)\d{3}$/.test(c.welcome.label)); }
  assert.strictEqual(nos.size, 60); ok('無線機番号: 60台で重複なし・3桁(40〜979)・形式 しもでんNNN/ちかてつNNN');
  many.forEach((c) => c.tx({ t: 'logout' })); await sleep(100);
  // --- 基本セット
  const D = await disp('D', 80), D2 = await disp('D2', 80);
  let A = await train('A', 80, '9051'); const B = await train('B', 80, '6110', { vehicle: 'chikatetsu' }), E = await train('E', 80, '7100'), U = await train('U', 80, '3001');
  await until(() => D.st && D.st.trains.length === 4 && D.st.trains.find((t) => t.trainNo === '6110').section, 3000, 'section');
  const sec = (no) => D.st.trains.find((t) => t.trainNo === no).section;
  assert.strictEqual(sec('6110'), '[春日道]→[新開地] 間'); assert.strictEqual(sec('9051'), '[新開地]→[春日道] 間'); assert.strictEqual(sec('3001'), null);
  ok('区間表示: 6110(偶数)=[春日道]→[新開地] 間 / 9051(奇数)=[新開地]→[春日道] 間 / JSONに無い列車は無表示');
  // --- 同一列番の2台目
  const A2 = await train('A2', 80, '9051'); assert.notStrictEqual(A2.welcome.label, A.welcome.label); ok('同一列車番号の2台に別の無線機番号');
  // --- 再接続で無線機番号保持
  const labelA = A.welcome.label; A.ws.close(); await sleep(100);
  const A_re = await new C('A').open(); await A_re.hello({ ch: 80, trainNo: '9051' }); assert.strictEqual(A_re.welcome.label, labelA);
  A = A_re; ok('再接続で無線機番号を保持');
  // --- 列車からの指令呼出 → 応答 → 個別通話
  B.tx({ t: 'handset', up: true }); await until(() => D.st.calls.some((c) => c.state === 'ringing' && c.trainNo === '6110'), 1000, 'ringing');
  await until(() => B.st.handset === 'ringing'); assert(!B.st.canPtt); ok('受話器上げ→全指令員に着信表示(発信中)・PTT不可');
  const call = D.st.calls.find((c) => c.trainNo === '6110'); assert(call.trains[0].section === '[春日道]→[新開地] 間' && call.trains[0].label === B.welcome.label); ok('着信に列番・区間・局番が付く');
  D.tx({ t: 'answer', id: call.id }); await until(() => B.st.handset === 'up' && B.st.canPtt && B.st.busy && A.st.busy, 1000, 'active');
  ok('応答で個別通話開始・話中ランプ点灯(他列車も)'); 
  [D, D2, B, A, E].forEach((c) => c.clear());
  D.frame(); await sleep(100); assert(B.audio.length === 1 && D2.audio.length === 1 && A.audio.length === 0 && E.audio.length === 0); ok('指令の声: 通話列車と他指令員に届き、他列車には届かない');
  [D, D2, B, A, E].forEach((c) => c.clear());
  D2.frame(); await sleep(100); assert(B.audio.length === 0); D2.tx({ t: 'join', id: call.id }); await sleep(50); D2.frame(); await sleep(50); assert(B.audio.length === 0); ok('他指令員は参加直後ミュート定位(声は通話に流れない)');
  D2.tx({ t: 'mute', on: false }); await sleep(50); B.clear(); D2.frame(); await sleep(80); assert(B.audio.length === 1); ok('他指令員がミュート解除すると話せる');
  [D, D2, B, A, E].forEach((c) => c.clear());
  B.frame(); await sleep(100); assert(D.audio.length === 1 && D2.audio.length === 1 && A.audio.length === 0 && B.audio.length === 0); ok('列車の声(PTT): 指令全員に届く・自分には返らない・他列車には届かない');
  A.tx({ t: 'handset', up: true }); await until(() => A.st.handset === 'up' && A.st.canPtt, 1000, 'interrupt'); ok('話中ランプ点灯中の受話器上げ=割込(即時に通話参加)');
  [D, D2, B, A, E].forEach((c) => c.clear());
  A.frame(); await sleep(100); assert(B.audio.length === 1 && D.audio.length === 1 && E.audio.length === 0); ok('割込列車の声は 指令・先着列車 に届く(3者通話)');
  [D, D2, B, A, E].forEach((c) => c.clear());
  A.tx({ t: 'handset', up: false }); await sleep(100); assert(A.st.handset === 'up'); ok('通話中に受話器を戻しても通話から抜けられない');
  D.tx({ t: 'hold', on: true }); await until(() => B.ev('hold').length && A.ev('hold').length, 1000, 'hold'); D.clear(); D.frame(); await sleep(60); assert(B.audio.length === 0); ok('保留: 通話列車に保留音イベント・保留中は指令の声を遮断');
  D.tx({ t: 'hold', on: false }); await sleep(50);
  D.tx({ t: 'end' }); await until(() => B.st.handset === 'down' && A.st.handset === 'down' && !B.st.busy, 1000, 'end'); assert(B.ev('callEnd').length && A.ev('callEnd').length); ok('指令の終話で全員の受話器が自動復位・話中ランプ消灯');
  // --- 発信タイムアウト
  E.clear(); E.tx({ t: 'handset', up: true }); await until(() => E.st.handset === 'ringing'); await until(() => E.st.handset === 'down', 2500, 'timeout'); assert(E.ev('callEnd')[0].reason === 'timeout'); ok('呼出が応答されないとタイムアウトで復位');
  // --- 指令からの個別呼出(同一列番は両方)
  D.tx({ t: 'callTrain', trainNo: '9051' }); await until(() => A.st.handset === 'up' && A2.st.handset === 'up', 1000, 'callTrain'); assert(B.st.handset === 'down'); ok('個別呼出: 同一列番の2台が両方呼ばれる(受話器操作不要・呼出音なし)');
  [D, D2, A, A2, B].forEach((c) => c.clear()); A.frame(); await sleep(100); assert(A2.audio.length === 1 && D.audio.length === 1 && B.audio.length === 0); ok('呼ばれた列車はPTTで応答でき、同一列番の列車にも聞こえる');
  D.tx({ t: 'bcStart' }); await sleep(50); assert(D.msgs.some((m) => m.t === 'toast')); ok('個別通話中は一斉に切替不可(先に終話)');
  D.tx({ t: 'end' }); await sleep(100);
  // --- 一斉通話
  [D, D2, A, B, E].forEach((c) => c.clear());
  D.tx({ t: 'bcStart' }); await until(() => A.ev('chime').length && B.ev('chime').length, 1000, 'chime'); D2.tx({ t: 'bcStart' }); await sleep(80); assert(A.ev('chime').length === 1); ok('一斉開始でチャイム1回(複数指令員が同時でも1回)');
  [D, D2, A, B, E].forEach((c) => c.clear()); D.frame(); await sleep(80); assert(A.audio.length === 1 && B.audio.length === 1 && E.audio.length === 1 && D2.audio.length === 1); ok('一斉: 全列車と他指令員に届く');
  B.tx({ t: 'handset', up: true }); await until(() => B.st.handset === 'up' && B.st.canPtt, 1000, 'bc interrupt');
  await until(() => D.st.calls.some((c) => c.kind === 'reply' && c.state === 'active'), 1000, 'reply call'); assert(!D.st.calls.some((c) => c.state === 'ringing'));
  [D, D2, A, B, E].forEach((c) => c.clear()); B.frame(); await sleep(100);
  assert(A.audio.length === 1 && E.audio.length === 1 && D.audio.length === 1 && B.audio.length === 0); ok('一斉通話中に受話器を上げると指令の承認なしで割込でき、声が全員に届き本人には返らない');
  D.tx({ t: 'mute', on: true }); await sleep(30); D.tx({ t: 'end' }); D2.tx({ t: 'end' }); await until(() => !B.st.busy && B.st.handset === 'down', 1000, 'bc end'); ok('一斉終話で応答通話も終了');
  // --- 防護発報
  A.tx({ t: 'guard', on: true }); await until(() => B.st.guardRecv && U.st.guardRecv && A.st.guardSend, 1000, 'guard');
  assert(!E.st.guardRecv); ok('防護発報: pos±1.5以内(6110@11.5)と位置不明(3001)が受信・範囲外(7100@14.5)は不受信');
  assert(D.st.guards.length === 1 && D.st.guards[0].trainNo === '9051'); ok('指令卓に発報列車が表示される');
  D.tx({ t: 'forceGuard', trainNo: '9051' }); await until(() => !A.st.guardSend && !B.st.guardRecv, 1000, 'force'); ok('指令から強制解除できる');
  U.tx({ t: 'guard', on: true }); await until(() => A.st.guardRecv && E.st.guardRecv && B.st.guardRecv, 1000, 'unk'); U.tx({ t: 'guard', on: false }); ok('位置不明列車の発報は同一チャンネル全列車が対象');
  // --- 越境(80ch pos 7.0〜8.5 → 2ch)
  const T2 = await train('T2', 2, '5001'); const X = await train('X', 80, '9053'); const Y = await train('Y', 80, '9055'); await sleep(1300);
  Y.tx({ t: 'guard', on: true }); await sleep(120); assert(!T2.st.guardRecv); Y.tx({ t: 'guard', on: false });
  X.tx({ t: 'guard', on: true }); await until(() => T2.st.guardRecv, 1000, 'border'); ok('80ch pos8.5の発報は2chにも越境 / pos20.0では越境しない');
  X.tx({ t: 'guard', on: false });
  const D81 = await disp('D81', 81); const T81 = await train('T81', 81, '1001'); T2.tx({ t: 'guard', on: true }); await sleep(100); assert(!T81.st.guardRecv && !A.st.guardRecv); T2.tx({ t: 'guard', on: false }); ok('2ch発報は2chのみ・81chは完全に別');
  // --- 試験機能
  [A, B, E, T81].forEach((c) => c.clear()); B.tx({ t: 'test' }); await until(() => A.ev('testOK').length && E.ev('testOK').length, 1000, 'test');
  assert(A.ev('testOK')[0].audible === false && !T81.ev('testOK').length); ok('試験: 同一チャンネル全列車のランプ点灯・通話が無ければ無音(audible=false)');
  D.tx({ t: 'bcStart' }); await sleep(50); [A, B, D].forEach((c) => c.clear()); await sleep(350); B.tx({ t: 'test' }); B.frame(1); await sleep(100);
  assert(A.ev('testOK')[0].audible === true && A.audio.length === 1 && A.audio[0][2] === 2); ok('一斉通話中の試験: 800Hzトーンと折り返し信号が全員に聞こえる(妨害)');
  D.tx({ t: 'end' }); await sleep(50);
  const t2 = await train('t2b', 2, '5002'); T2.clear(); t2.tx({ t: 'test' }); await sleep(100); assert(!T2.ev('testOK').length); ok('2chでは試験は動作しない');
  // --- 2ch
  [T2, t2, D].forEach((c) => c.clear()); const D2ch = await disp('D2ch', 2); T2.tx({ t: 'handset', up: true }); await sleep(60); assert(T2.st.handset === 'down' && T2.st.canPtt); ok('2ch: 受話器を上げても何も起きず、PTTは常に可能');
  T2.frame(); await sleep(100); assert(D2ch.audio.length === 1 && t2.audio.length === 0); ok('2ch: PTTの声は指令だけに届き、他列車には聞こえない');
  D2ch.tx({ t: 'bcStart' }); await sleep(60); assert(!T2.ev('chime').length); t2.clear(); T2.frame(); await sleep(100); assert(t2.audio.length === 1); ok('2ch: 指令の通話開始中は他列車にも聞こえる(チャイムなし)');
  // --- 位置情報の鮮度
  jsonNowOffset = -700; await sleep(1500); assert.strictEqual(D.st.trains.find((t) => t.trainNo === '6110').section, null); ok('JSONのnowが10分以上ずれると位置不明扱い');
  jsonNowOffset = 0; await sleep(1500); assert(D.st.trains.find((t) => t.trainNo === '6110').section); 
  // --- 録音(ch81): 話中の間を1ファイル / 同時発話をミックス / 間隔が空いていなければ連結 / 空けば別ファイル
  const ADPCM = require('./adpcm.js');
  const aframe = (c, f, amp, k) => { const x = new Float32Array(160); for (let i = 0; i < 160; i++) x[i] = amp * Math.sin(2 * Math.PI * f * (k * 160 + i) / 8000); const p = ADPCM.encode(x); const b = new Uint8Array(3 + p.length); b[0] = 1; b[1] = 1; b[2] = 0; b.set(p, 3); c.ws.send(b); };
  const goertzel = (x, f) => { const w = 2 * Math.PI * f / 8000, co = 2 * Math.cos(w); let s1 = 0, s2 = 0; for (const v of x) { const s0 = v + co * s1 - s2; s2 = s1; s1 = s0; } return Math.sqrt(s1 * s1 + s2 * s2 - co * s1 * s2) / x.length * 2; };
  const recFiles = () => fs.existsSync(RECDIR) ? fs.readdirSync(RECDIR).filter((f) => f.startsWith('81ch_')).sort() : [];
  assert.strictEqual(recFiles().length, 0);
  D81.tx({ t: 'bcStart' }); await sleep(120); T81.tx({ t: 'handset', up: true }); await until(() => T81.st.canPtt, 1000, 'rec reply');
  for (let k = 0; k < 50; k++) { aframe(D81, 440, 0.3, k); aframe(T81, 1000, 0.3, k); await sleep(20); }   // 指令(440Hz)と列車(1000Hz)が同時に1秒間話す
  D81.tx({ t: 'end' }); await sleep(400);                                                                   // 終話(1秒未満の間)
  D81.tx({ t: 'bcStart' }); await sleep(100); for (let k = 0; k < 25; k++) { aframe(D81, 440, 0.3, k); await sleep(20); } D81.tx({ t: 'end' });
  await sleep(1800);                                                                                         // 1秒(テスト用の連結猶予)を超えて待つ → ファイル確定
  let files = recFiles(); assert.strictEqual(files.length, 1, '連結されて1ファイルのはず: ' + files); assert(/^81ch_\d{8}_\d{6}(_\d+)?\.wav$/.test(files[0]));
  ok('録音: 話中の間は1ファイル、1秒未満の間隔で再開した通話は同じファイルに連結(ファイル名 ' + files[0] + ')');
  const wav = fs.readFileSync(path.join(RECDIR, files[0])); assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF'); assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.readUInt16LE(22), 1); assert.strictEqual(wav.readUInt32LE(24), 8000); assert.strictEqual(wav.readUInt16LE(34), 16); assert.strictEqual(wav.readUInt32LE(40), wav.length - 44);
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length)), secs = pcm.length / 8000;
  assert(secs > 1.9 && secs < 3.2, '長さ ' + secs); ok(`WAVとして正しい(8kHz/16bit/モノラル、長さ ${secs.toFixed(2)}秒 = 通話1秒+間+通話0.5秒)`);
  const seg1 = Array.from(pcm.slice(4000, 7600), (v) => v / 32768);                                          // 最初の通話の中ほど
  const a440 = goertzel(seg1, 440), a1000 = goertzel(seg1, 1000); assert(a440 > 0.2 && a1000 > 0.2, `mix ${a440} ${a1000}`);
  ok(`同時に話した2人の音声がミックスされて録音される(440Hz=${a440.toFixed(2)} / 1000Hz=${a1000.toFixed(2)})`);
  D81.tx({ t: 'bcStart' }); await sleep(100); for (let k = 0; k < 10; k++) { aframe(D81, 440, 0.3, k); await sleep(20); } D81.tx({ t: 'end' }); await sleep(1600);
  files = recFiles(); assert.strictEqual(files.length, 2); ok('猶予時間を超えてから始まった通話は別ファイルになる');

  // --- 設定変更
  D.tx({ t: 'setSettings', s: { newPassword: 'pw2', pollIntervalSec: 2 } }); await sleep(100);
  const bad2 = await new C('bad2').open(); await bad2.hello({ ch: 80, trainNo: '12306', password: 'pw' }); assert(bad2.msgs.find((m) => m.t === 'err'));
  const good = await new C('good').open(); await good.hello({ ch: 80, trainNo: '12306', password: 'pw2' }); assert(good.welcome); ok('指令卓から指令パスワードを変更でき、設定ファイルに保存される');
  assert(JSON.parse(fs.readFileSync(cfgPath)).dispatcherPassword === 'pw2');
  console.log(`\n全 ${n} 項目 OK`); process.exit(0);
})().catch((e) => { console.error('\n✗ FAIL:', e); process.exit(1); });
setTimeout(() => { console.error('global timeout'); process.exit(2); }, 60000).unref();
