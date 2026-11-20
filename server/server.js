'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { attach } = require('./ws');
const ST = require('./stations');
const { Recorder } = require('./recorder');

const ROOT = __dirname, SOUND_DIR = path.join(ROOT, 'sounds');
// インストール版(TrainRadioServer.exe)は Program Files に書き込めないため、設定は ProgramData、録音はドキュメントに置く
const PACKED = (() => { try { return require('node:sea').isSea(); } catch (e) { return false; } })();
const tray = PACKED ? require('./tray') : null;
const DATA = PACKED ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'TrainRadio') : ROOT;
if (PACKED) fs.mkdirSync(DATA, { recursive: true });
const CFG_PATH = process.env.RADIO_CONFIG || path.join(DATA, 'config.json');
const DISPATCH_NO = '12306', LISTEN_NO = '9999';   // 9999 = 傍受専用(全通話を聞くだけ・操作不可)
const CHANNELS = [2, 80, 81];
const VEHICLES = { shimoden: 'しもでん', chikatetsu: 'ちかてつ' };

// ---------------------------------------------------------------- 設定
const DEFAULTS = {
  port: 8080, tlsCert: '', tlsKey: '',
  dispatcherPassword: 'changeme',
  jsonUrls: { 80: 'http://city.hakata-gov.com:50421/php/hakata_nanboku_i.json', 81: 'http://city.hakata-gov.com:50421/php/hakata_tozai_i.json' },
  pollIntervalSec: 7, staleSec: 600, ringTimeoutSec: 30, reconnectGraceSec: 300,
  guardRange: 1.5, borderMin: 7.0, borderMax: 8.5, testDurationMs: 3000,
  recordEnabled: true, recordDir: PACKED ? path.join(tray.documentsDir(), 'TrainRadio', 'recordings') : 'recordings', recordKeepDays: 0, recordGapSec: 3,
};
function loadConfig() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) {}
  const m = { ...DEFAULTS, ...c, jsonUrls: { ...DEFAULTS.jsonUrls, ...(c.jsonUrls || {}) } };
  if (process.env.RADIO_PORT) m.port = Number(process.env.RADIO_PORT);
  if (!fs.existsSync(CFG_PATH)) fs.writeFileSync(CFG_PATH, JSON.stringify(m, null, 2));
  return m;
}
const cfg = loadConfig();
const saveConfig = () => fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));

// ---------------------------------------------------------------- 状態
let nextId = 1, nextCallId = 1;
const parties = new Map();   // id -> party (列車 / 指令)
const sessions = new Map();  // 再接続キー -> 列車party
const usedNos = new Set();   // 使用中の無線機番号(しもでん/ちかてつ合算・サーバー全体)
const chans = {};
for (const ch of CHANNELS) chans[ch] = { ch, bc: new Set(), calls: new Map(), pos: new Map(), jsonNow: 0, lastOk: 0, lastErr: '', testUntil: 0 };

const recorders = {};
const recSync = () => { for (const ch of CHANNELS) recorders[ch].sync(busy(ch)); };
const online = (p) => !!(p.conn && !p.conn.closed);
const inCh = (ch) => [...parties.values()].filter((p) => p.ch === ch);
const trainsIn = (ch) => inCh(ch).filter((p) => p.role === 'train' && !p.listen);
const listenersIn = (ch) => inCh(ch).filter((p) => p.listen);
const dispsIn = (ch) => inCh(ch).filter((p) => p.role === 'dispatcher');
const labelOf = (p) => (VEHICLES[p.vehicle] || '') + p.radioNo;
const send = (p, o) => { if (online(p)) p.conn.send(JSON.stringify(o)); };
const toast = (p, msg, level = 'info') => send(p, { t: 'toast', msg, level });
const callOf = (p) => { for (const c of chans[p.ch].calls.values()) if (c.members.has(p.id)) return c; return null; };
for (const ch of CHANNELS) recorders[ch] = new Recorder(ch, () => cfg, DATA);
const busy = (ch) => chans[ch].bc.size > 0 || [...chans[ch].calls.values()].some((c) => c.state === 'active');

function newParty(role) {
  let id; do { id = (nextId++ % 65000) + 1; } while (parties.has(id));
  const p = { id, role, ch: 0, trainNo: '', vehicle: '', radioNo: '', conn: null, guard: false, testUntil: 0, mode: null, muted: true, hold: false, key: '', offlineTimer: null, lastState: '' };
  parties.set(id, p); return p;
}

// 無線機番号: 3桁(40〜979)ランダム。埋まったら4桁(1000〜9999)。
function allocRadioNo() {
  const fmt = (n) => String(n).padStart(3, '0'); // 3桁表示(40→"040")。4桁(1000〜)はそのまま
  const pick = (lo, hi) => {
    for (let i = 0; i < 300; i++) { const n = fmt(lo + Math.floor(Math.random() * (hi - lo + 1))); if (!usedNos.has(n)) return n; }
    const free = []; for (let n = lo; n <= hi; n++) if (!usedNos.has(fmt(n))) free.push(fmt(n));
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  };
  const n = pick(40, 979) || pick(1000, 9999); if (n) usedNos.add(n); return n;
}

// ---------------------------------------------------------------- 位置情報
function getPos(p) { // JSONのnowが現在時刻と staleSec(既定10分)以上ずれていれば位置不明
  const c = chans[p.ch]; if (p.ch === 2 || !c.jsonNow) return null;
  if (Math.abs(Date.now() / 1000 - c.jsonNow) > cfg.staleSec) return null;
  return c.pos.has(p.trainNo) ? c.pos.get(p.trainNo) : null;
}
const sectionOf = (p) => ST.section(p.ch, p.trainNo, getPos(p));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8'); res.on('data', (x) => { d += x; if (d.length > 2e6) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  Promise.all([80, 81].map(async (ch) => {
    try {
      const j = await fetchJson(cfg.jsonUrls[ch]); const m = new Map();
      for (const [no, v] of Object.entries(j.train || {})) if (v && Number.isFinite(Number(v.pos))) m.set(String(no), Number(v.pos));
      chans[ch].pos = m; chans[ch].jsonNow = Number(j.now) || 0; chans[ch].lastOk = Date.now(); chans[ch].lastErr = '';
    } catch (e) { chans[ch].lastErr = String(e.message || e); }
  })).finally(() => { dirty(); pollTimer = setTimeout(poll, Math.max(1, cfg.pollIntervalSec) * 1000); });
}

// ---------------------------------------------------------------- 防護発報
function guardHits(g, t) { // g(発報列車)の発報が t に届くか
  if (g === t) return false;
  if (g.ch === 2) return t.ch === 2;                                  // 2chは全線1ゾーン
  if (t.ch === g.ch) {
    const gp = getPos(g), tp = getPos(t);
    if (gp == null || tp == null) return true;                        // 位置不明は同一チャンネル全列車が対象
    return Math.abs(gp - tp) <= cfg.guardRange + 1e-9;
  }
  if (g.ch === 80 && t.ch === 2) { const gp = getPos(g); return gp != null && gp >= cfg.borderMin && gp <= cfg.borderMax; } // 越境は80ch→2chのみ
  return false;
}
const activeGuards = () => [...parties.values()].filter((p) => p.role === 'train' && p.guard && online(p));
const guardRecv = (t) => activeGuards().filter((g) => guardHits(g, t));
function guardsFor(d) { // 指令卓に表示する発報(自チャンネル+80chから2chへの越境分)
  return activeGuards().filter((g) => g.ch === d.ch || (d.ch === 2 && guardHits(g, { ch: 2, id: -1 })))
    .map((g) => ({ trainNo: g.trainNo, label: labelOf(g), section: sectionOf(g), ch: g.ch }));
}

// ---------------------------------------------------------------- 通話
function setHold(d, on) {
  if (!!d.hold === !!on) return;
  const aud = holdAudience(d); d.hold = !!on; if (on) d.muted = true;
  for (const q of aud) send(q, { t: 'ev', e: 'hold', src: d.id, on: !!on });
}
function holdAudience(d) {
  const s = new Set(dispsIn(d.ch)); if (!d.mode) return s;
  if (d.mode.type === 'bc') trainsIn(d.ch).forEach((t) => s.add(t));
  else { const c = chans[d.ch].calls.get(d.mode.id); if (c) c.members.forEach((id) => { const t = parties.get(id); if (t) s.add(t); }); }
  return s;
}
function switchMode(d, mode) { if (d.hold) setHold(d, false); d.mode = mode; d.muted = true; }
function endCall(call, reason) {
  const ch = chans[call.ch]; clearTimeout(call.timer); ch.calls.delete(call.id);
  for (const d of dispsIn(call.ch)) if (d.mode && d.mode.type === 'call' && d.mode.id === call.id) { if (d.hold) setHold(d, false); d.mode = null; d.muted = true; }
  for (const id of call.members) { const t = parties.get(id); if (t) send(t, { t: 'ev', e: 'callEnd', reason }); }
  dirty();
}
function endReplyCalls(ch) { for (const c of [...chans[ch].calls.values()]) if (c.kind === 'reply') endCall(c, 'end'); }
function endMode(d) {
  if (!d.mode) return; const ch = chans[d.ch];
  if (d.hold) setHold(d, false);
  if (d.mode.type === 'bc') { ch.bc.delete(d.id); d.mode = null; d.muted = true; if (ch.bc.size === 0) endReplyCalls(d.ch); }
  else { const c = ch.calls.get(d.mode.id); d.mode = null; d.muted = true; if (c) endCall(c, 'end'); }
}
function createPending(p) {
  const c = { id: nextCallId++, ch: p.ch, kind: 'pending', state: 'ringing', origin: 'train', trainNo: p.trainNo, members: new Set([p.id]), startedAt: Date.now(), ringEnd: Date.now() + cfg.ringTimeoutSec * 1000 };
  c.timer = setTimeout(() => endCall(c, 'timeout'), cfg.ringTimeoutSec * 1000);
  chans[p.ch].calls.set(c.id, c);
}
function leaveCalls(p) {
  for (const c of [...chans[p.ch].calls.values()]) if (c.members.has(p.id)) { c.members.delete(p.id); if (c.members.size === 0) endCall(c, 'gone'); }
}

// 音声の宛先
function voiceTargets(p) {
  const ch = chans[p.ch], res = new Set();
  if (p.role === 'dispatcher') {
    if (!p.mode || p.muted || p.hold) return [];
    dispsIn(p.ch).forEach((x) => res.add(x));
    if (p.mode.type === 'bc') trainsIn(p.ch).forEach((x) => res.add(x));
    else { const c = ch.calls.get(p.mode.id); if (c) c.members.forEach((id) => { const t = parties.get(id); if (t) res.add(t); }); }
  } else {
    dispsIn(p.ch).forEach((x) => res.add(x));                    // 指令は全員すべての通話を聞ける
    if (p.ch === 2) { if (ch.bc.size > 0) trainsIn(2).forEach((x) => res.add(x)); } // 2chは指令の通話開始中のみ他列車にも聞こえる
    else {
      const c = callOf(p); if (!c || c.state !== 'active') return [];
      if (c.kind === 'reply') trainsIn(p.ch).forEach((x) => res.add(x)); // 一斉通話中の応答は全員へ
      else c.members.forEach((id) => { const t = parties.get(id); if (t) res.add(t); });
    }
  }
  listenersIn(p.ch).forEach((x) => res.add(x));                  // 傍受専用(9999)は個別通話を含め全部聞こえる
  res.delete(p); return [...res];
}
function activityAudience(chNo) { // 現在行われている通話を聞ける全員(試験音の宛先)
  const ch = chans[chNo], set = new Set(), act = [...ch.calls.values()].filter((c) => c.state === 'active');
  if (ch.bc.size === 0 && !act.length) return set;
  dispsIn(chNo).forEach((x) => set.add(x));
  if (ch.bc.size > 0) trainsIn(chNo).forEach((x) => set.add(x));
  act.forEach((c) => c.members.forEach((id) => { const t = parties.get(id); if (t) set.add(t); }));
  listenersIn(chNo).forEach((x) => set.add(x));
  return set;
}
function onAudio(conn, buf) {
  const p = conn.party;
  if (!p || p.listen || buf.length < 4 || buf.length > 1500 || buf[0] !== 1) return;
  recSync();
  const tone = (buf[2] & 1) === 1;
  let targets;
  if (tone) { if (p.role !== 'train' || p.ch === 2 || Date.now() > p.testUntil + 300) return; targets = [...activityAudience(p.ch)].filter((x) => x !== p); }
  else targets = voiceTargets(p);
  if (!targets.length) return;
  if (buf[1] === 1) recorders[p.ch].frame(p.id, buf.subarray(3));      // 通話の録音(ADPCMをデコードしてミックス)
  const out = Buffer.allocUnsafe(buf.length + 2);
  out[0] = 1; out[1] = buf[1]; out[2] = tone ? 2 : p.role === 'train' ? 1 : 0; out.writeUInt16BE(p.id, 3); buf.copy(out, 5, 3);
  for (const t of targets) if (online(t)) t.conn.sendAudio(out);
}

// ---------------------------------------------------------------- 状態配信
function trainState(p) {
  const c = callOf(p), handset = !c ? 'down' : c.state === 'ringing' ? 'ringing' : 'up';
  const recv = guardRecv(p);
  return { t: 'st', role: 'train', ch: p.ch, trainNo: p.trainNo, vehicle: p.vehicle, radioNo: p.radioNo, label: labelOf(p),
    busy: busy(p.ch), handset, listen: !!p.listen, canPtt: !p.listen && (p.ch === 2 || handset === 'up'), guardSend: p.guard, guardRecv: recv.length > 0,
    guardFrom: recv.slice(0, 3).map(labelOf), testRemain: Math.max(0, chans[p.ch].testUntil - Date.now()) };
}
function publicSettings() {
  const st = {}; for (const ch of [80, 81]) { const c = chans[ch]; st[ch] = { ok: !c.lastErr && !!c.lastOk, err: c.lastErr, count: c.pos.size, ageSec: c.jsonNow ? Math.round(Date.now() / 1000 - c.jsonNow) : null }; }
  return { jsonUrls: cfg.jsonUrls, pollIntervalSec: cfg.pollIntervalSec, staleSec: cfg.staleSec, ringTimeoutSec: cfg.ringTimeoutSec, guardRange: cfg.guardRange, borderMin: cfg.borderMin, borderMax: cfg.borderMax, recordEnabled: cfg.recordEnabled, recordKeepDays: cfg.recordKeepDays, jsonStatus: st };
}
function dispState(d) {
  const ch = chans[d.ch], now = Date.now();
  const trains = trainsIn(d.ch).map((t) => ({ id: t.id, trainNo: t.trainNo, label: labelOf(t), vehicle: t.vehicle, section: sectionOf(t), online: online(t), guard: t.guard, inCall: !!callOf(t) }))
    .sort((a, b) => a.trainNo.localeCompare(b.trainNo, 'ja', { numeric: true }));
  const calls = [...ch.calls.values()].map((c) => ({ id: c.id, kind: c.kind, state: c.state, origin: c.origin, trainNo: c.trainNo, startedAt: c.startedAt,
    ringLeft: c.state === 'ringing' ? Math.max(0, c.ringEnd - now) : 0,
    trains: [...c.members].map((id) => parties.get(id)).filter(Boolean).map((t) => ({ id: t.id, trainNo: t.trainNo, label: labelOf(t), section: sectionOf(t) })),
    dispatchers: dispsIn(d.ch).filter((x) => x.mode && x.mode.type === 'call' && x.mode.id === c.id).map((x) => ({ id: x.id, muted: x.muted, hold: x.hold })) }));
  return { t: 'ds', ch: d.ch, you: { id: d.id, mode: d.mode, muted: d.muted, hold: d.hold }, bc: { active: ch.bc.size > 0, members: [...ch.bc] },
    busy: busy(d.ch), dispatchers: dispsIn(d.ch).map((x) => x.id), trains, calls, guards: guardsFor(d), settings: publicSettings() };
}
let flushScheduled = false;
function dirty() { if (!flushScheduled) { flushScheduled = true; setImmediate(flush); } }
function flush() {
  flushScheduled = false; recSync();
  for (const p of parties.values()) {
    if (!online(p)) continue;
    const s = JSON.stringify(p.role === 'train' ? trainState(p) : dispState(p));
    if (s !== p.lastState) { p.lastState = s; p.conn.send(s); }
  }
}

// ---------------------------------------------------------------- 接続管理
function destroyParty(p) {
  if (p.dead) return; p.dead = true; clearTimeout(p.offlineTimer);
  if (p.role === 'dispatcher') {
    if (p.hold) setHold(p, false);
    const ch = chans[p.ch]; ch.bc.delete(p.id); p.mode = null; parties.delete(p.id);
    if (ch.bc.size === 0) endReplyCalls(p.ch);
    if (!dispsIn(p.ch).length) for (const c of [...ch.calls.values()]) endCall(c, 'end');
  } else { leaveCalls(p); usedNos.delete(p.radioNo); sessions.delete(p.key); parties.delete(p.id); }
  if (p.conn) { const c = p.conn; p.conn = null; c.party = null; c.close(); }
  dirty();
}
function onHello(conn, m) {
  const fatal = (msg) => { conn.send(JSON.stringify({ t: 'err', msg, fatal: true })); };
  const ch = Number(m.ch), trainNo = String(m.trainNo || '').trim().toUpperCase(), key = String(m.key || '').slice(0, 64);
  if (!chans[ch]) return fatal('チャンネルが不正です');
  if (!/^[0-9A-Z]{1,6}$/.test(trainNo)) return fatal('列車番号は半角英数字(6文字まで)で入力してください');
  if (!key) return fatal('接続キーがありません');
  if (conn.party && conn.party.role === 'dispatcher') { destroyParty(conn.party); }
  else if (conn.party) { conn.party.conn = null; conn.party = null; }
  if (trainNo === DISPATCH_NO) {
    if (String(m.password || '') !== cfg.dispatcherPassword) return fatal('指令パスワードが違います');
    const d = newParty('dispatcher'); d.ch = ch; d.trainNo = trainNo; d.conn = conn; conn.party = d;
    send(d, { t: 'welcome', role: 'dispatcher', ch, id: d.id, bootId: BOOT_ID }); dirty(); return;
  }
  if (!VEHICLES[m.vehicle]) return fatal('車種を選択してください');
  let p = sessions.get(key);
  if (p) { clearTimeout(p.offlineTimer); if (p.conn && p.conn !== conn) { p.conn.party = null; p.conn.close(); } }
  else {
    const no = allocRadioNo(); if (!no) return fatal('無線機番号が満杯です');
    p = newParty('train'); p.key = key; p.radioNo = no; sessions.set(key, p);
  }
  if (p.ch && (p.ch !== ch || p.trainNo !== trainNo)) { leaveCalls(p); p.guard = false; p.testUntil = 0; } // チャンネル/列車番号の変更
  p.ch = ch; p.trainNo = trainNo; p.vehicle = m.vehicle; p.conn = conn; conn.party = p; p.listen = trainNo === LISTEN_NO;
  if (!p.listen) for (const c of chans[ch].calls.values()) if (c.origin === 'dispatcher' && c.kind === 'individual' && c.trainNo === trainNo) c.members.add(p.id); // 通話中の同一列番に参加
  send(p, { t: 'welcome', role: 'train', ch, id: p.id, radioNo: p.radioNo, label: labelOf(p), bootId: BOOT_ID });
  p.lastState = ''; dirty();
}
function onClose(conn) {
  const p = conn.party; if (!p || p.conn !== conn) return; p.conn = null;
  if (p.role === 'dispatcher') return destroyParty(p);
  p.guard = false; p.testUntil = 0; // 切断時は発報を解除。再接続猶予後に無線機番号を解放
  p.offlineTimer = setTimeout(() => destroyParty(p), cfg.reconnectGraceSec * 1000); dirty();
}

function onMessage(conn, data, isBin) {
  if (isBin) return onAudio(conn, data);
  let m; try { m = JSON.parse(data); } catch (e) { return; }
  if (m.t === 'hello') return onHello(conn, m);
  const p = conn.party; if (!p) return;
  if (m.t === 'logout') return destroyParty(p);
  if (m.t === 'ping') return send(p, { t: 'pong', ts: m.ts });
  if (p.role === 'train') { if (!p.listen) trainMsg(p, m); } else dispMsg(p, m);
}
function trainMsg(p, m) {
  const ch = chans[p.ch];
  switch (m.t) {
    case 'handset': {
      if (p.ch === 2) break; const call = callOf(p);
      if (m.up) {
        if (call) break;
        const act = [...ch.calls.values()].filter((c) => c.state === 'active' && c.kind === 'individual');
        if (act.length) act[act.length - 1].members.add(p.id);   // 個別通話中: 承認なしで3者目として割込
        else if (ch.bc.size > 0) {                                // 一斉通話中: 承認なしで割込(声は指令と全列車へ)
          const c = { id: nextCallId++, ch: p.ch, kind: 'reply', state: 'active', origin: 'train', trainNo: p.trainNo, members: new Set([p.id]), startedAt: Date.now() };
          ch.calls.set(c.id, c);
        } else createPending(p);                                  // 無通話時: 通常の指令呼出(指令の応答待ち)
      } else if (call && call.state === 'ringing') { call.members.delete(p.id); endCall(call, 'cancel'); }
      dirty(); break;
    }
    case 'guard': p.guard = !!m.on; dirty(); break;
    case 'test': {
      if (p.ch === 2) break; const now = Date.now(); if (now < p.testUntil) break;
      const dur = cfg.testDurationMs; p.testUntil = now + dur; ch.testUntil = Math.max(ch.testUntil, now + dur);
      const aud = activityAudience(p.ch);                         // 音は通話中のみ。ランプは同一チャンネル全列車
      for (const q of inCh(p.ch)) send(q, { t: 'ev', e: 'testOK', dur, audible: aud.has(q) });
      dirty(); break;
    }
  }
}
function dispMsg(d, m) {
  const ch = chans[d.ch];
  switch (m.t) {
    case 'bcStart': {
      if (d.mode) { if (d.mode.type === 'call') toast(d, '個別通話中です。一斉に切り替えるには先に終話してください', 'warn'); break; }
      const first = ch.bc.size === 0; ch.bc.add(d.id); d.mode = { type: 'bc' }; d.muted = false; d.hold = false;
      if (first && d.ch !== 2) for (const q of inCh(d.ch)) send(q, { t: 'ev', e: 'chime', ch: d.ch }); // チャイムは通話開始時の1回のみ(2chは無し)
      dirty(); break;
    }
    case 'end': endMode(d); dirty(); break;
    case 'leave': if (d.mode) { if (d.hold) setHold(d, false); if (d.mode.type === 'bc') { ch.bc.delete(d.id); if (!ch.bc.size) endReplyCalls(d.ch); } d.mode = null; d.muted = true; } dirty(); break;
    case 'mute': if (d.mode) { d.muted = !!m.on; if (!m.on && d.hold) setHold(d, false); } dirty(); break;
    case 'hold': if (d.mode) setHold(d, !!m.on); dirty(); break;
    case 'callTrain': {
      if (d.ch === 2) return toast(d, '2chでは個別呼出は使用できません', 'warn');
      if (d.mode && d.mode.type === 'bc') return toast(d, '一斉通話中です。先に終話してください', 'warn');
      const no = String(m.trainNo || '').trim().toUpperCase(); if (!/^[0-9A-Z]{1,6}$/.test(no)) return toast(d, '列車番号を入力してください', 'warn');
      const ms = trainsIn(d.ch).filter((t) => t.trainNo === no); if (!ms.length) return toast(d, `列車 ${no} は接続していません`, 'warn');
      let c = [...ch.calls.values()].find((x) => x.kind === 'individual' && x.state === 'active' && x.trainNo === no);
      if (!c) { c = { id: nextCallId++, ch: d.ch, kind: 'individual', state: 'active', origin: 'dispatcher', trainNo: no, members: new Set(ms.map((t) => t.id)), startedAt: Date.now() }; ch.calls.set(c.id, c); }
      switchMode(d, { type: 'call', id: c.id }); d.muted = false; dirty(); break;
    }
    case 'answer': case 'join': {
      const c = ch.calls.get(m.id); if (!c) break;
      if (c.state === 'ringing') { c.state = 'active'; c.startedAt = Date.now(); clearTimeout(c.timer); c.kind = ch.bc.size > 0 ? 'reply' : 'individual'; }
      if (c.kind === 'individual') {
        if (d.mode && d.mode.type === 'bc') return toast(d, '一斉通話中です。個別通話に入るには先に終話してください', 'warn');
        switchMode(d, { type: 'call', id: c.id }); d.muted = m.t === 'join';
      }
      dirty(); break;
    }
    case 'endCall': { const c = ch.calls.get(m.id); if (c) endCall(c, 'end'); break; }
    case 'forceGuard': { for (const g of activeGuards()) if (g.trainNo === String(m.trainNo) && guardsFor(d).some((x) => x.trainNo === g.trainNo)) g.guard = false; dirty(); break; }
    case 'setSettings': applySettings(d, m.s || {}); break;
  }
}
function applySettings(d, s) {
  const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
  let n;
  if (s.jsonUrls) for (const ch of [80, 81]) if (typeof s.jsonUrls[ch] === 'string' && /^https?:\/\//.test(s.jsonUrls[ch])) cfg.jsonUrls[ch] = s.jsonUrls[ch].trim();
  if ((n = num(s.pollIntervalSec, 1, 3600)) != null) cfg.pollIntervalSec = n;
  if ((n = num(s.staleSec, 10, 86400)) != null) cfg.staleSec = n;
  if ((n = num(s.ringTimeoutSec, 5, 600)) != null) cfg.ringTimeoutSec = n;
  if ((n = num(s.guardRange, 0, 50)) != null) cfg.guardRange = n;
  if ((n = num(s.borderMin, 0, 100)) != null) cfg.borderMin = n;
  if ((n = num(s.borderMax, 0, 100)) != null) cfg.borderMax = n;
  if (typeof s.recordEnabled === 'boolean') cfg.recordEnabled = s.recordEnabled;
  if ((n = num(s.recordKeepDays, 0, 3650)) != null) cfg.recordKeepDays = n;
  if (typeof s.newPassword === 'string' && s.newPassword.length >= 1) cfg.dispatcherPassword = s.newPassword;
  saveConfig(); poll(); toast(d, '設定を保存しました', 'ok'); dirty();
}

// ---------------------------------------------------------------- HTTP(効果音の配信のみ。画面はクライアントアプリが持つ)
const BOOT_ID = String(Date.now());
function handler(req, res) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-cache');
  if (!p.startsWith('/sounds/')) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('列車無線サーバー稼働中'); }
  const file = path.normalize(path.join(SOUND_DIR, p.slice(8)));
  if (!file.startsWith(SOUND_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': path.extname(file) === '.wav' ? 'audio/wav' : 'application/octet-stream' }); res.end(buf);
  });
}
let server;
if (cfg.tlsCert && cfg.tlsKey) server = https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) }, handler);
else server = http.createServer(handler);
attach(server, (conn) => { conn.onmessage = (d, b) => onMessage(conn, d, b); conn.onclose = () => onClose(conn); });
function cleanupRecordings() {
  const days = cfg.recordKeepDays; if (!(days > 0)) return; const dir = path.resolve(DATA, cfg.recordDir);
  try { for (const f of fs.readdirSync(dir)) { if (!/^\d+ch_\d{8}_\d{6}(_\d+)?\.wav$/.test(f)) continue; const fp = path.join(dir, f); if (Date.now() - fs.statSync(fp).mtimeMs > days * 86400000) fs.unlinkSync(fp); } } catch (e) {}
}
setInterval(cleanupRecordings, 3600 * 1000).unref(); cleanupRecordings();
const shutdown = () => { for (const ch of CHANNELS) recorders[ch].stop(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.once('error', (e) => {
  if (!tray) throw e;
  tray.alert(e.code === 'EADDRINUSE' ? `ポート ${cfg.port} は使用中です。サーバーが既に起動している可能性があります。` : '起動できません: ' + e.message); process.exit(1);
});
server.listen(cfg.port, () => {
  const scheme = cfg.tlsCert ? 'https' : 'http', recDir = path.resolve(DATA, cfg.recordDir);
  console.log(`列車無線サーバー起動: ${scheme}://0.0.0.0:${cfg.port}  (設定: ${CFG_PATH} / 録音: ${recDir})`); poll();
  if (tray) tray.start({ scheme, port: cfg.port, cfgPath: CFG_PATH, recDir, onQuit: shutdown });
});
module.exports = { server };
