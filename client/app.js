'use strict';
(() => {
const $ = (s, r = document) => r.querySelector(s);
const D = window.desktop || null;                         // PC版(Tauri / pc-client)のときのみ存在
const UH = window.updateHost || null;                     // アップデート可能な版(Tauri / Android)のときのみ存在
const CH_NAME = { 2: '2ch(下電)', 80: '80ch(南北線)', 81: '81ch(東西線)', 85: '85ch(非常用)' };
const OPEN = (ch) => ch === 2 || ch === 85; // 個別通話・受話器・試験のないチャンネル
const DEF = { ch: 80, trainNo: '', vehicle: 'shimoden', server: '', pttKey: 'F6', volDisp: 7, volTrain: 7, drive: 5, inDev: '', outDev: '', scale: 1, onTop: false };
const cfg = Object.assign({}, DEF, (() => { try { return JSON.parse(localStorage.getItem('trainradio.cfg') || '{}'); } catch (e) { return {}; } })());
const saveCfg = () => localStorage.setItem('trainradio.cfg', JSON.stringify(cfg));
let key = localStorage.getItem('trainradio.key');
if (!key) { key = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now()); localStorage.setItem('trainradio.key', key); }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------ 状態
let ws = null, wantConn = false, welcome = null, S = null, DS = null, pw = '', retry = null, hb = null, lastPong = 0;
let ptt = false, testUntil = 0, dsAt = 0, wakeLock = null;
const holdSet = new Set();
const audio = new RadioAudio({ send: (u) => { if (ws && ws.readyState === 1) ws.send(u); }, base: () => httpBase() });
const connected = () => !!(ws && ws.readyState === 1 && welcome);

function httpBase() {
  let s = (cfg.server || '').trim().replace(/\/+$/, ''); if (!/^https?:\/\//.test(s)) s = 'http://' + s; return s;
}
const wsUrl = () => httpBase().replace(/^http/, 'ws');
const sendJson = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function toast(msg, level = 'info') {
  const el = document.createElement('cds-inline-notification');
  el.setAttribute('kind', { warn: 'warning', ok: 'success', error: 'error' }[level] || 'info'); el.setAttribute('title', msg);
  el.setAttribute('low-contrast', ''); el.setAttribute('hide-close-button', '');
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 4500);
}
function show(id) {
  for (const v of ['login', 'train', 'disp']) $('#' + v).hidden = v !== id; $('#conn').hidden = true;
  if (id === 'train') fit(); else if (D) D.resize(id === 'disp' ? 1280 : 380, id === 'disp' ? 760 : 560);
}

// ------------------------------------------------------------ 効果音ループ
const loops = {};
function loop(name, on, bus) {
  if (on && !loops[name]) {
    const mine = { h: null }; loops[name] = mine;
    audio.play(name, { loop: true, bus }).then((h) => { if (loops[name] === mine) mine.h = h; else h.stop(); });
  } else if (!on && loops[name]) { const l = loops[name]; delete loops[name]; if (l.h) l.h.stop(); }
}
function syncLoops() {
  const ok = connected();
  loop('ringback', ok && S && S.handset === 'ringing', 'master');                       // 発信音
  loop('guard', ok && ((S && (S.guardRecv || S.guardSend)) || (DS && DS.guards.length > 0)), 'master'); // 防護発報の警報音(発報した列車・受信した列車・指令卓)
  loop('bell', ok && DS && DS.calls.some((c) => c.state === 'ringing'), 'master');      // 指令の呼出ベル
  loop('hold', ok && holdSet.size > 0, 'disp');                                         // 保留音
}

// ------------------------------------------------------------ 接続
function open() {
  clearTimeout(retry); if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
  let sock; try { sock = new WebSocket(wsUrl()); } catch (e) { return loginMsg('サーバーのアドレスが不正です'); }
  ws = sock; ws.binaryType = 'arraybuffer';
  ws.onopen = () => { lastPong = Date.now(); sendJson({ t: 'hello', key, ch: cfg.ch, trainNo: cfg.trainNo, vehicle: cfg.vehicle, password: pw }); };
  ws.onmessage = (e) => { if (typeof e.data === 'string') onMsg(JSON.parse(e.data)); else audio.onAudio(e.data); };
  ws.onclose = () => {
    welcome = null; S = null; holdSet.clear(); pttSet(false); audio.setTx(false); renderTrain(); syncLoops();
    if (wantConn) { $('#conn').hidden = false; retry = setTimeout(open, 2000); }
  };
}
function onMsg(m) {
  switch (m.t) {
    case 'welcome':
      welcome = m; audio.bootId = m.bootId; $('#conn').hidden = true; S = null; DS = null;
      if (m.role === 'train') { document.title = `${m.label} - 列車無線`; show('train'); renderTrain(); }
      else { document.title = `指令卓 ${CH_NAME[m.ch]}`; show('disp'); }
      requestWake(); break;
    case 'st': S = m; if (m.testRemain > 0 && Date.now() >= testUntil) testUntil = Date.now() + m.testRemain; renderTrain(); syncLoops(); break;
    case 'ds': DS = m; dsAt = Date.now(); renderDisp(); syncLoops(); break;
    case 'ev': onEvent(m); break;
    case 'toast': toast(m.msg, m.level); break;
    case 'pong': lastPong = Date.now(); break;
    case 'err': wantConn = false; teardown(); showLogin(m.msg); break;
  }
}
function onEvent(m) {
  if (m.e === 'chime') audio.play('chime' + m.ch, { bus: 'disp' });
  else if (m.e === 'hold') { if (m.on) holdSet.add(m.src); else holdSet.delete(m.src); syncLoops(); }
  else if (m.e === 'testOK') {
    testUntil = Date.now() + m.dur; renderTrain(); renderDispPills(); setTimeout(() => { renderTrain(); renderDispPills(); }, m.dur + 30);
    if (m.audible) audio.play('test_return', { bus: 'disp' });
  }
}
function teardown() { wantConn = false; clearTimeout(retry); if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} } ws = null; welcome = null; S = null; DS = null; holdSet.clear(); pttSet(false); audio.setTx(false); syncLoops(); }
async function requestWake() { try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } } catch (e) {} }
setInterval(() => { if (ws && ws.readyState === 1) { sendJson({ t: 'ping', ts: Date.now() }); if (Date.now() - lastPong > 30000) ws.close(); } }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) requestWake(); });

// ------------------------------------------------------------ ログイン
function loginMsg(t) { $('#loginMsg').textContent = t || ''; }
function showLogin(msg) { show('login'); document.title = '列車無線'; $('#loginMsg').textContent = msg || ''; $('#fGo').disabled = false; }
function syncLoginRows() { const no = $('#fNo').value.trim(); $('#fVeh').hidden = no === '12306'; $('#fPw').hidden = no !== '12306'; }
$('#fNo').addEventListener('input', syncLoginRows);
$('#loginForm').addEventListener('submit', (e) => e.preventDefault());
$('#loginForm').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); login(); } });
$('#fGo').addEventListener('click', () => login());
async function login() {
  if ($('#fGo').disabled) return;
  const no = $('#fNo').value.trim().toUpperCase(), srv = $('#fSrv').value.trim();
  if (!/^[0-9A-Z]{1,6}$/.test(no)) return loginMsg('列車番号は半角英数字(6文字まで)で入力してください');
  if (no === '12306' && !D) return loginMsg('指令側はPC版でのみ使用できます');
  if (no === '12306' && !$('#fPw').value) return loginMsg('指令パスワードを入力してください');
  if (!srv) return loginMsg('サーバーのアドレスを入力してください');
  Object.assign(cfg, { ch: +$('#fCh').value, trainNo: no, vehicle: $('#fVeh').value, server: srv }); pw = $('#fPw').value; saveCfg();
  $('#fGo').disabled = true; loginMsg('接続中…');
  try { await audio.init(); } catch (err) { $('#fGo').disabled = false; return loginMsg('音声を初期化できません: ' + err.message); }
  try { await audio.startMic(cfg.inDev); } catch (err) { toast('マイクを利用できません。受信のみ可能です', 'warn'); }
  audio.setOutput(cfg.outDev); applyAudioCfg();
  if (D) { D.setPttKey(cfg.pttKey); D.setAlwaysOnTop(cfg.onTop); }
  wantConn = true; open();
}
function applyAudioCfg() { audio.setVolumes({ disp: cfg.volDisp / 10, train: cfg.volTrain / 10 }); audio.setFx({ drive: cfg.drive }); }

// ------------------------------------------------------------ 列車側UI
const seg = $('#seg').getContext('2d');
const SEGMAP = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function draw7seg(ch) { // 2chのみ「2」(左桁消灯)、80/81は2桁
  seg.clearRect(0, 0, 254, 605); if (ch == null) return; seg.fillStyle = '#ff9c00';
  const s = String(ch), ds = s.length === 1 ? [null, s] : [s[0], s[1]];
  ds.forEach((d, i) => { if (d == null) return; for (const k of SEGMAP[d]) for (const [x, y] of SEGDATA[i][k]) seg.fillRect(x, y, 1, 1); });
}
const lamp = (id, mode) => { $(id).className = 'layer lamp' + (mode ? ' ' + mode : ''); };
function renderTrain() {
  const on = connected() && !!S;
  lamp('#lPower', on ? 'on' : ''); lamp('#lBusy', on && S.busy ? 'blink' : '');
  lamp('#lGuard', on && (S.guardSend || S.guardRecv) ? 'blink' : ''); lamp('#lTest', on && Date.now() < testUntil ? 'on' : '');
  draw7seg(on ? S.ch : null);
  $('#hsOverlay').className = on && S.handset !== 'down' ? 'up' + (S.handset === 'ringing' ? ' ring' : '') : '';
  $('#radio').classList.toggle('off', !on);
  const pb = $('#ptt'), can = on && S.canPtt;
  pb.disabled = !can; pb.textContent = can ? `送話 (${keyLabel(cfg.pttKey)})` : on && S.listen ? '傍受専用' : (on && !OPEN(S.ch) ? '受話器を上げて呼出' : '送話');
  if (!can && ptt) pttSet(false);
  $('#trainInfo').innerHTML = welcome && welcome.role === 'train'
    ? `<b>${esc(welcome.label)}</b>${esc(CH_NAME[welcome.ch])} 列車 ${esc(cfg.trainNo)}${on ? '' : ' (未接続)'}${on && S.listen ? '<br><span class="flag">傍受専用(操作はできません)</span>' : ''}${on && S.guardRecv ? '<br><span class="flag">防護発報を受信中</span>' : ''}` : '';
}
function fit() {
  const r = $('#radio'); let s;
  if (D) { s = cfg.scale; D.resize(Math.max(Math.ceil(254 * s) + 32, 330), Math.ceil(605 * s) + 120); }
  else s = Math.max(0.5, Math.min((innerHeight - 110) / 605, (innerWidth - 16) / 254, 3));
  r.style.setProperty('--s', s);
}
addEventListener('resize', () => { if (!$('#train').hidden) fit(); });

function pttSet(on) {
  if (on && !(connected() && S && S.canPtt)) return;
  if (ptt === on) return; ptt = on; audio.setTx(on); $('#ptt').classList.toggle('on', on);
}
const pb = $('#ptt');
pb.addEventListener('pointerdown', (e) => { e.preventDefault(); try { pb.setPointerCapture(e.pointerId); } catch (x) {} pttSet(true); });
['pointerup', 'pointercancel'].forEach((ev) => pb.addEventListener(ev, () => pttSet(false)));
pb.addEventListener('contextmenu', (e) => e.preventDefault());
const typing = (e) => { const t = e.composedPath()[0]; return !!t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName); };
addEventListener('keydown', (e) => { if (e.code === cfg.pttKey && !$('#train').hidden && !typing(e) && !captureKey) { e.preventDefault(); if (!e.repeat) pttSet(true); } });
addEventListener('keyup', (e) => { if (e.code === cfg.pttKey) pttSet(false); });
addEventListener('blur', () => { if (!D) pttSet(false); });
if (D) D.onPtt((on) => { if (!$('#train').hidden) pttSet(on); });

$('#zHandset').addEventListener('click', () => {            // 受話器: 下→指令呼出/割込、発信中→取消、通話中は戻しても通話は継続
  if (!connected() || !S || OPEN(S.ch) || S.listen) return;
  if (S.handset === 'down') sendJson({ t: 'handset', up: true }); else if (S.handset === 'ringing') sendJson({ t: 'handset', up: false });
});
$('#zGuard').addEventListener('click', () => { if (connected() && S && !S.listen) sendJson({ t: 'guard', on: !S.guardSend }); });
$('#zTest').addEventListener('click', () => {
  if (!connected() || !S || OPEN(S.ch) || S.listen || Date.now() < testUntil) return;
  sendJson({ t: 'test' }); audio.sendTone(3000);
});
function stepVol(d) { cfg.volDisp = Math.max(0, Math.min(10, cfg.volDisp + d)); saveCfg(); applyAudioCfg(); toast(`指令の音量 ${cfg.volDisp}`); }
$('#zVup').addEventListener('click', () => stepVol(1));
$('#zVdn').addEventListener('click', () => stepVol(-1));
$('#btnSettings').addEventListener('click', () => openSettings());

// ------------------------------------------------------------ 指令卓
const secTxt = (s) => (s ? esc(s) : '');
function renderDispPills() {
  if (!DS) return; const y = DS.you;
  const talking = !!y.mode && !y.muted && !y.hold;
  const tag = (id, type) => $(id).setAttribute('type', type);
  $('#dMic').textContent = y.hold ? '保留中' : talking ? '送話中' : y.mode ? 'ミュート中' : '待機'; tag('#dMic', talking ? 'green' : y.hold ? 'purple' : 'gray');
  tag('#dBusy', DS.busy ? 'blue' : 'gray'); tag('#dTest', Date.now() < testUntil ? 'blue' : 'gray');
  tag('#dGuardPill', DS.guards.length ? 'red' : 'gray'); $('#dGuardPill').classList.toggle('alert', DS.guards.length > 0);
}
function renderDisp() {
  if (!DS) return; const y = DS.you, inBc = y.mode && y.mode.type === 'bc', inCall = y.mode && y.mode.type === 'call';
  $('#dCh').textContent = CH_NAME[DS.ch];
  $('#dMeta').textContent = `指令員 ${DS.dispatchers.length}名 / 接続列車 ${DS.trains.filter((t) => t.online).length}両`;
  const bc = $('#dBc'); bc.textContent = inBc ? '一斉通話 終話' : '一斉通話 開始'; bc.kind = inBc ? 'danger' : 'primary'; bc.disabled = !!inCall;
  $('#dMute').disabled = !y.mode; $('#dMute').kind = y.mode && y.muted && !y.hold ? 'primary' : 'secondary'; $('#dMute').textContent = y.muted && !y.hold ? 'ミュート解除' : 'ミュート';
  $('#dHold').disabled = !y.mode; $('#dHold').kind = y.hold ? 'primary' : 'secondary'; $('#dHold').textContent = y.hold ? '保留 解除' : '保留音';
  $('#dLeave').disabled = !inCall;
  audio.setTx(!!y.mode && !y.muted && !y.hold);
  renderDispPills();
  // 通話一覧
  $('#dCalls').innerHTML = DS.calls.length ? DS.calls.map((c) => {
    const trains = c.trains.map((t) => `<span class="mono">${esc(t.trainNo)}</span> ${secTxt(t.section)} <span class="mono">${esc(t.label)}</span>`).join(' / ');
    const mine = inCall && y.mode.id === c.id;
    let l2, acts;
    const btn = (kind, act, text) => `<cds-button size="sm" kind="${kind}" data-act="${act}" data-id="${c.id}">${text}</cds-button>`;
    if (c.state === 'ringing') { l2 = `呼出中 残り <span class="rl" data-end="${dsAt + c.ringLeft}"></span>秒`; acts = btn('primary', 'answer', '応答') + btn('secondary', 'endCall', '却下'); }
    else if (c.kind === 'reply') { l2 = '一斉通話への応答中'; acts = btn('secondary', 'endCall', '終話'); }
    else { l2 = `個別通話 指令員${c.dispatchers.length}名` + (mine ? (y.muted ? '(ミュート中)' : '(送話中)') : ''); acts = mine ? btn('danger', 'endCall', '終話') : btn('primary', 'answer', '応答(話す)') + btn('secondary', 'join', '参加(聞く)') + btn('secondary', 'endCall', '終話'); }
    return `<div class="call ${c.state === 'ringing' ? 'ringing' : c.kind === 'reply' ? 'reply' : ''}"><div class="l1">${c.state === 'ringing' ? '呼出列車: ' : ''}${trains}</div><div class="l2">${l2}</div><div class="acts">${acts}</div></div>`;
  }).join('') : '<div class="empty">通話はありません</div>';
  // 列車一覧
  $('#dTrains').innerHTML = DS.trains.length ? DS.trains.map((t) =>
    `<div class="row ${t.online ? '' : 'off'}" data-id="${t.id}"><span class="no">${esc(t.trainNo)}</span><span class="sec">${secTxt(t.section) || '<span class="lab">位置不明</span>'}</span><span class="lab">${esc(t.label)}${t.guard ? ' <span class="flag">防護発報</span>' : ''}${t.online ? '' : ' 切断中'}</span><cds-button size="sm" kind="ghost" data-act="callTrain" data-no="${esc(t.trainNo)}" ${OPEN(DS.ch) || inBc ? 'disabled' : ''}>個別呼出</cds-button></div>`).join('')
    : '<div class="empty">接続中の列車はありません</div>';
  // 防護発報
  $('#dGuards').innerHTML = DS.guards.length ? DS.guards.map((g) =>
    `<div class="guard"><b class="mono">${esc(g.trainNo)}</b> ${secTxt(g.section)} <span class="mono">${esc(g.label)}</span>${g.ch !== DS.ch ? ` <span class="flag">${esc(CH_NAME[g.ch])}から越境</span>` : ''}<div class="acts"><cds-button size="sm" kind="danger--tertiary" data-act="forceGuard" data-no="${esc(g.trainNo)}">強制解除</cds-button></div></div>`).join('')
    : '<div class="empty">発報はありません</div>';
  tickRing();
}
function tickRing() { document.querySelectorAll('.rl').forEach((el) => { el.textContent = Math.max(0, Math.ceil((+el.dataset.end - Date.now()) / 1000)); }); }
setInterval(() => {
  tickRing(); if ($('#disp').hidden) return; const n = performance.now();
  document.querySelectorAll('#dTrains .row').forEach((r) => r.classList.toggle('talk', n - (audio.heard.get(+r.dataset.id) || -1e9) < 400));
}, 200);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !DS || b.disabled) return; const a = b.dataset.act;
  if (a === 'answer' || a === 'join' || a === 'endCall') sendJson({ t: a, id: +b.dataset.id });
  else if (a === 'callTrain') sendJson({ t: 'callTrain', trainNo: b.dataset.no });
  else if (a === 'forceGuard') sendJson({ t: 'forceGuard', trainNo: b.dataset.no });
});
$('#dBc').addEventListener('click', (e) => !e.currentTarget.disabled && sendJson({ t: DS && DS.you.mode && DS.you.mode.type === 'bc' ? 'end' : 'bcStart' }));
$('#dMute').addEventListener('click', (e) => DS && !e.currentTarget.disabled && sendJson({ t: 'mute', on: !(DS.you.muted && !DS.you.hold) }));
$('#dHold').addEventListener('click', (e) => DS && !e.currentTarget.disabled && sendJson({ t: 'hold', on: !DS.you.hold }));
$('#dLeave').addEventListener('click', (e) => !e.currentTarget.disabled && sendJson({ t: 'leave' }));
const callNo = () => { const v = $('#dCallNo').value.trim(); if (v) { sendJson({ t: 'callTrain', trainNo: v }); $('#dCallNo').value = ''; } };
$('#dCallGo').addEventListener('click', callNo);
$('#dCallNo').addEventListener('keydown', (e) => { if (e.key === 'Enter') callNo(); });
$('#dSettings').addEventListener('click', () => openSettings());
$('#dDetail').addEventListener('click', () => openDetail());

// ------------------------------------------------------------ モーダル
const modal = $('#modal'); let modalCleanup = null;
function openModal(title, html, onOpen, cleanup) {
  $('#mTitle').textContent = title; $('#mBody').innerHTML = html;
  $('#mBody').querySelectorAll('cds-select[data-value]').forEach((el) => { el.value = el.dataset.value; });
  modal.open = true; modalCleanup = cleanup || null; onOpen && onOpen($('#mBody')); }
function closeModal() { if (modal.open) modal.open = false; if (modalCleanup) { modalCleanup(); modalCleanup = null; } captureKey = false; }
modal.addEventListener('cds-modal-closed', closeModal);   // ×・Esc・背景クリックで閉じたとき
const keyLabel = (c) => c.replace(/^Key/, '').replace(/^Digit/, '');
let captureKey = false;
const KEY_OK = /^(F([1-9]|1[0-2])|Key[A-Z]|Digit[0-9]|Space)$/;

const slider = (id, label, v) => `<cds-slider id="${id}" label-text="${label}" min="0" max="10" step="1" value="${v}" hide-text-input></cds-slider>`;
// 初期値は data-value に入れ、openModal が .value に反映する(cds-select-item の selected 属性だけでは値が入らないため)
const select = (id, label, opts, cur) => `<cds-select id="${id}" label-text="${label}" data-value="${esc(cur)}">${opts.map(([v, t]) => `<cds-select-item value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(t)}</cds-select-item>`).join('')}</cds-select>`;
const keyText = () => keyLabel(cfg.pttKey) + '(クリックして変更)';
function openSettings() {
  const isTrain = welcome && welcome.role === 'train';
  const html = `
  <section><h3>音量</h3>${slider('sVd', '指令の音量', cfg.volDisp)}${slider('sVt', '他列車の音量', cfg.volTrain)}</section>
  <section><h3>無線らしさ</h3>${slider('sDr', '歪み', cfg.drive)}</section>
  ${D ? `<section><h3>音声デバイス</h3>${select('sIn', '入力(マイク)', [['', '既定のデバイス']], '')}${select('sOut', '出力(スピーカー)', [['', '既定のデバイス']], '')}</section>` : ''}
  <section><h3>マイク確認</h3><div class="monrow"><cds-button id="sMon" kind="tertiary" size="md">確認モード 開始</cds-button><div class="meter"><i id="sMeter"></i></div></div>
    <p class="hint">ハウリング防止のためイヤホンを推奨します</p></section>
  ${isTrain ? `<section><h3>送話キー</h3><cds-button id="sKey" kind="tertiary" size="md">${esc(keyText())}</cds-button></section>` : ''}
  ${D ? `<section><h3>ウィンドウ</h3><cds-checkbox id="sTop" ${cfg.onTop ? 'checked' : ''}>無線機を最前面に固定</cds-checkbox>
    ${isTrain ? select('sScale', '表示倍率', [0.75, 1, 1.25, 1.5, 2].map((v) => [String(v), v + '倍']), cfg.scale) : ''}</section>` : ''}
  <section><h3>${isTrain ? '列車情報' : '接続チャンネル'}</h3>
    ${select('sCh', 'チャンネル', [2, 80, 81, 85].map((c) => [String(c), CH_NAME[c]]), cfg.ch)}
    ${isTrain ? `<cds-text-input id="sNo2" label="列車番号" maxlength="6" value="${esc(cfg.trainNo)}" autocomplete="off"></cds-text-input>
    ${select('sVeh', '車種', [['shimoden', '下電車'], ['chikatetsu', '地下鉄車']], cfg.vehicle)}` : ''}
    <div><cds-button id="sApply" kind="primary" size="md">適用</cds-button></div></section>
  ${UH ? Updater.section('h3') : ''}
  <section><div><cds-button id="sLogout" kind="danger" size="md">ログアウト</cds-button></div></section>`;
  openModal('設定', html, async (b) => {
    const slide = (id, k) => b.querySelector(id).addEventListener('cds-slider-changed', (e) => { cfg[k] = Number(e.target.value); saveCfg(); applyAudioCfg(); });
    slide('#sVd', 'volDisp'); slide('#sVt', 'volTrain'); slide('#sDr', 'drive');
    let mon = false; const meter = setInterval(() => { b.querySelector('#sMeter').style.width = (audio.level() * 100) + '%'; }, 60);
    b.querySelector('#sMon').addEventListener('click', (e) => { const btn = e.currentTarget; mon = !mon; audio.setMonitor(mon); btn.textContent = mon ? '確認モード 停止' : '確認モード 開始'; btn.kind = mon ? 'primary' : 'tertiary'; });
    modalCleanup = () => { clearInterval(meter); audio.setMonitor(false); };
    if (D) {
      let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
      const fill = (id, kind, cur, set) => {
        const sel = b.querySelector(id);
        sel.innerHTML = [['', '既定のデバイス'], ...devs.filter((d) => d.kind === kind).map((d) => [d.deviceId, d.label || d.deviceId])]
          .map(([v, t]) => `<cds-select-item value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</cds-select-item>`).join('');
        sel.value = devs.some((d) => d.kind === kind && d.deviceId === cur) ? cur : '';
        sel.addEventListener('cds-select-selected', () => { set(sel.value); saveCfg(); });
      };
      fill('#sIn', 'audioinput', cfg.inDev, async (v) => { cfg.inDev = v; try { await audio.startMic(v); } catch (e) { toast('マイクを切り替えできません', 'warn'); } });
      fill('#sOut', 'audiooutput', cfg.outDev, (v) => { cfg.outDev = v; audio.setOutput(v); });
      b.querySelector('#sTop').addEventListener('cds-checkbox-changed', (e) => { cfg.onTop = e.target.checked; saveCfg(); D.setAlwaysOnTop(cfg.onTop); });
      const sc = b.querySelector('#sScale'); if (sc) sc.addEventListener('cds-select-selected', () => { cfg.scale = Number(sc.value); saveCfg(); fit(); });
    }
    const kb = b.querySelector('#sKey');
    if (kb) kb.addEventListener('click', () => {
      if (captureKey) return;
      captureKey = true; kb.textContent = '割り当てるキーを押してください';
      const h = (e) => { e.preventDefault(); e.stopPropagation(); removeEventListener('keydown', h, true);
        if (e.key === 'Escape') { captureKey = false; kb.textContent = keyText(); return; }
        if (D && !KEY_OK.test(e.code)) { toast('PC版で使えるキーは F1〜F12 / 英字 / 数字 / スペース です', 'warn'); captureKey = false; kb.textContent = keyText(); return; }
        cfg.pttKey = e.code; saveCfg(); captureKey = false; if (D) D.setPttKey(cfg.pttKey); kb.textContent = keyText(); renderTrain(); };
      addEventListener('keydown', h, true);
    });
    b.querySelector('#sApply').addEventListener('click', () => {
      const ch = Number(b.querySelector('#sCh').value); let no = cfg.trainNo, veh = cfg.vehicle;
      if (isTrain) { no = b.querySelector('#sNo2').value.trim().toUpperCase(); veh = b.querySelector('#sVeh').value; if (!/^[0-9A-Z]{1,6}$/.test(no) || no === '12306') return toast('列車番号は半角英数字(6文字まで)で入力してください(12306は指令専用です)', 'warn'); }
      Object.assign(cfg, { ch, trainNo: no, vehicle: veh }); saveCfg(); sendJson({ t: 'hello', key, ch, trainNo: no, vehicle: veh, password: pw }); closeModal();
    });
    if (UH) Updater.bind(b, UH);
    b.querySelector('#sLogout').addEventListener('click', () => { sendJson({ t: 'logout' }); teardown(); closeModal(); showLogin(); });
  });
}
function openDetail() {
  const s = DS && DS.settings; if (!s) return;
  const st = (c) => { const j = s.jsonStatus[c]; return j.ok ? `取得OK(${j.count}列車 / 時差${j.ageSec}秒)` : `取得失敗: ${esc(j.err || '未取得')}`; };
  const f = (id, label, v) => `<cds-text-input id="${id}" label="${label}" value="${esc(v)}" autocomplete="off"></cds-text-input>`;
  openModal('詳細設定(サーバー)', `
  <section><h3>走行位置JSON</h3>
    ${f('dU80', '80ch(南北線)のURL', s.jsonUrls[80])}<p class="hint">${st(80)}</p>
    ${f('dU81', '81ch(東西線)のURL', s.jsonUrls[81])}<p class="hint">${st(81)}</p>
    <div class="two">${f('dPoll', '取得間隔(秒)', s.pollIntervalSec)}${f('dStale', '位置不明にする時差(秒)', s.staleSec)}</div></section>
  <section><h3>通話・防護発報</h3><div class="two">${f('dRing', '呼出の自動切断(秒)', s.ringTimeoutSec)}${f('dRange', '防護発報の範囲(±pos)', s.guardRange)}</div>
    <div class="two">${f('dBmin', '2chへ越境するpos(下限)', s.borderMin)}${f('dBmax', '同(上限・80chのみ)', s.borderMax)}</div></section>
  <section><h3>通話の録音</h3><cds-checkbox id="dRec" ${s.recordEnabled ? 'checked' : ''}>通話を録音する</cds-checkbox>
    ${f('dKeep', '古い録音を自動削除する日数(0=削除しない)', s.recordKeepDays)}</section>
  <section><h3>指令パスワード</h3>${f('dPw', '新しいパスワード(変更時のみ)', '')}</section>
  <section><div><cds-button id="dSave" kind="primary" size="md">保存</cds-button></div></section>`, (b) => {
    b.querySelector('#dSave').addEventListener('click', () => {
      const g = (id) => b.querySelector(id).value.trim(), npw = g('#dPw');
      sendJson({ t: 'setSettings', s: { jsonUrls: { 80: g('#dU80'), 81: g('#dU81') }, pollIntervalSec: g('#dPoll'), staleSec: g('#dStale'), ringTimeoutSec: g('#dRing'), guardRange: g('#dRange'), borderMin: g('#dBmin'), borderMax: g('#dBmax'), recordEnabled: b.querySelector('#dRec').checked, recordKeepDays: g('#dKeep'), newPassword: npw || undefined } });
      if (npw) pw = npw; closeModal();
    });
  });
}

// ------------------------------------------------------------ 起動
$('#fCh').value = String(cfg.ch); $('#fNo').value = cfg.trainNo; $('#fVeh').value = cfg.vehicle; $('#fSrv').value = cfg.server; syncLoginRows();
if (D) { D.setPttKey(cfg.pttKey); D.setAlwaysOnTop(cfg.onTop); }
if (UH) Updater.startup(UH, $('#toasts'));
document.addEventListener('contextmenu', (e) => { if ($('#train').hidden === false) e.preventDefault(); });
window.__radio = { audio, loops, state: () => ({ S, DS, welcome }) };   // デバッグ・自動テスト用
})();
