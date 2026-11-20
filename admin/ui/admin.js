'use strict';
// 列車無線サーバー 管理画面
//  サーバー本体(TrainRadioServerCore.exe)の起動・停止・ログは管理アプリ(Rust)に、状態・設定・録音はサーバーの管理API(/admin/*)に問い合わせる
(() => {
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CH_NAME = { 2: '2ch(下電)', 80: '80ch(南北線)', 81: '81ch(東西線)' };
const ROLE = { train: '列車', listen: '傍受', dispatcher: '指令' };

// ------------------------------------------------------------ 管理アプリとの橋渡し
// ブラウザで直接開いた場合(開発用)は ?port=8080&t=鍵 で動いているサーバーに接続する
const T = window.__TAURI__;
const q = new URLSearchParams(location.search);
const bridge = T ? {
  status: () => T.core.invoke('status'),
  start: () => T.core.invoke('start_server'),
  stop: () => T.core.invoke('stop_server'),
  restart: () => T.core.invoke('restart_server'),
  logs: () => T.core.invoke('logs'),
  open: (path) => T.core.invoke('open_path', { path }),
  onLog: (cb) => T.event.listen('log', (e) => cb(e.payload)),
} : {
  status: async () => ({ running: true, ready: { port: +q.get('port') || 8080, scheme: 'http' }, token: q.get('t') || '', exitCode: null, lastError: '' }),
  start: async () => {}, stop: async () => {}, restart: async () => {}, logs: async () => ['(開発用表示: ログは管理アプリでのみ表示されます)'],
  open: async (p) => console.log('open', p), onLog: () => {},
};

let st = { running: false, ready: null, token: '', exitCode: null, lastError: '' };
const apiUrl = (p) => `${st.ready.scheme}://127.0.0.1:${st.ready.port}/admin/${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(st.token)}`;
const online = () => st.running && !!st.ready;
async function api(p, opt) {
  const r = await fetch(apiUrl(p), opt); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}

// ------------------------------------------------------------ 起動状態
function renderRun() {
  const tag = $('#stTag');
  const [type, text] = online() ? ['green', '稼働中'] : st.running ? ['blue', '起動中'] : st.exitCode != null && st.exitCode !== 0 ? ['red', 'エラー'] : ['gray', '停止中'];
  tag.setAttribute('type', type); tag.textContent = text;
  $('#btnStart').hidden = st.running; $('#btnStop').hidden = !st.running; $('#btnRestart').disabled = !st.running;
  $('#cSave').disabled = !online(); $('#cReload').disabled = !online();
  $('#recRefresh').disabled = !online();
  const err = $('#errBox');
  if (!st.running && st.exitCode != null && st.exitCode !== 0) {
    if (err.dataset.msg !== st.lastError) { err.dataset.msg = st.lastError; err.innerHTML = `<cds-inline-notification kind="error" title="サーバーが停止しました" subtitle="${esc(st.lastError || '終了コード ' + st.exitCode)}" hide-close-button></cds-inline-notification>`; }
  } else if (err.dataset.msg) { err.dataset.msg = ''; err.innerHTML = ''; }
  if (!online()) { $('#addrs').innerHTML = '<p class="dim">停止中</p>'; $('#uptime').textContent = '-'; $('#count').textContent = '-'; $('#countSub').textContent = ''; }
}
async function act(fn) {
  for (const b of ['#btnStart', '#btnStop', '#btnRestart']) $(b).disabled = true;
  try { await fn(); } catch (e) { console.warn(e); }
  await tick();
}
$('#btnStart').addEventListener('click', () => act(bridge.start));
$('#btnStop').addEventListener('click', () => act(bridge.stop));
$('#btnRestart').addEventListener('click', () => act(bridge.restart));

// ------------------------------------------------------------ 状態・端末
const uptime = (ms) => { const m = Math.floor(ms / 60000), h = Math.floor(m / 60); return h ? `${h}時間${m % 60}分` : `${m}分`; };
let addrKey = '';
function renderState(s) {
  const key = s.addresses.join(',') + ':' + s.port + s.scheme;
  if (key !== addrKey) {
    addrKey = key;
    const list = (s.addresses.length ? s.addresses : ['127.0.0.1']).map((a) => `${s.scheme}://${a}:${s.port}`);
    $('#addrs').innerHTML = list.map((u) => `<div class="addr"><code>${esc(u)}</code><cds-button kind="ghost" size="sm" data-copy="${esc(u)}">コピー</cds-button></div>`).join('')
      + (s.cfgPort !== s.port ? `<p class="warn">ポート ${s.cfgPort} は再起動後に反映されます</p>` : '');
  }
  $('#uptime').textContent = uptime(Date.now() - s.startedAt);
  const on = s.parties.filter((p) => p.online), n = (r) => on.filter((p) => p.role === r).length;
  $('#count').textContent = on.length; $('#countSub').textContent = `列車 ${n('train')} / 指令 ${n('dispatcher')} / 傍受 ${n('listen')}`;
  $('#chans').innerHTML = s.channels.map((c) => {
    const act = c.calls.filter((x) => x.state === 'active').length, ring = c.calls.filter((x) => x.state === 'ringing').length;
    const v = c.busy ? (c.bc ? '一斉通話中' : `通話中 ${act}件`) : '待機'; return `<span>${esc(CH_NAME[c.ch])}</span><span class="${c.busy ? 'on' : 'dim'}">${v}${ring ? ` / 呼出 ${ring}件` : ''}</span>`;
  }).join('');
  $('#json').innerHTML = [80, 81].map((ch) => {
    const j = s.jsonStatus[ch]; const v = j.ok ? `取得OK ${j.count}列車 / 時差 ${j.ageSec}秒` : `取得失敗 ${esc(j.err || '未取得')}`;
    return `<span>${esc(CH_NAME[ch])}</span><span class="${j.ok ? '' : 'bad'}">${v}</span>`;
  }).join('');
  // 端末一覧
  const rows = [...s.parties].sort((a, b) => a.ch - b.ch || a.role.localeCompare(b.role) || a.trainNo.localeCompare(b.trainNo, 'ja', { numeric: true }));
  $('#clientsEmpty').hidden = rows.length > 0; $('#clients').hidden = rows.length === 0;
  $('#clientRows').innerHTML = rows.map((p) => {
    const tags = [!p.online && '<cds-tag type="gray" size="sm">切断中</cds-tag>', p.guard && '<cds-tag type="red" size="sm">防護発報</cds-tag>', p.inCall && `<cds-tag type="blue" size="sm">${p.role === 'dispatcher' ? '通話操作中' : '通話中'}</cds-tag>`].filter(Boolean).join('');
    return `<cds-table-row><cds-table-cell>${p.ch}</cds-table-cell><cds-table-cell>${ROLE[p.role]}</cds-table-cell><cds-table-cell><code>${esc(p.trainNo)}</code></cds-table-cell>`
      + `<cds-table-cell>${esc(p.label || '-')}</cds-table-cell><cds-table-cell>${esc(p.section || '-')}</cds-table-cell><cds-table-cell>${tags || '<span class="dim">待機</span>'}</cds-table-cell></cds-table-row>`;
  }).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = 'コピー済み'; setTimeout(() => { b.textContent = 'コピー'; }, 1500); }).catch(() => {});
});

// ------------------------------------------------------------ 設定
const F = { port: '#cPort', pollIntervalSec: '#cPoll', staleSec: '#cStale', ringTimeoutSec: '#cRing', guardRange: '#cRange', borderMin: '#cBmin', borderMax: '#cBmax', recordGapSec: '#cGap', recordKeepDays: '#cKeep' };
let loadedCfg = null;
function cfgMsg(kind, title, sub, restart) {
  $('#cfgMsg').innerHTML = `<cds-inline-notification kind="${kind}" title="${esc(title)}" subtitle="${esc(sub || '')}" low-contrast>${restart ? '<cds-button slot="action" kind="ghost" size="sm" id="cfgRestart">再起動</cds-button>' : ''}</cds-inline-notification>`;
  const r = $('#cfgRestart'); if (r) r.addEventListener('click', () => { $('#cfgMsg').innerHTML = ''; act(bridge.restart); });
}
async function loadCfg() {
  if (!online()) return;
  try { loadedCfg = await api('config'); } catch (e) { return cfgMsg('error', '設定を読み込めません', e.message); }
  const c = loadedCfg;
  for (const [k, sel] of Object.entries(F)) { $(sel).value = String(c[k]); $(sel).invalid = false; }
  $('#cPw').value = c.dispatcherPassword; $('#cU80').value = c.jsonUrls[80]; $('#cU81').value = c.jsonUrls[81];
  $('#cRec').toggled = !!c.recordEnabled; $('#cRecDir').value = c.recordDir;
  $('#cU80').invalid = $('#cU81').invalid = $('#cRecDir').invalid = $('#cPw').invalid = false;
}
function readCfg() {
  let ok = true; const s = {};
  const bad = (el, text) => { el.invalid = true; el.invalidText = text; ok = false; };
  for (const [k, sel] of Object.entries(F)) {
    const el = $(sel), v = Number(el.value), lo = Number(el.getAttribute('min')), hi = Number(el.getAttribute('max'));
    el.invalid = false;
    if (el.value.trim() === '' || !Number.isFinite(v) || v < lo || v > hi || (k === 'port' && !Number.isInteger(v))) bad(el, `${lo}〜${hi}の${k === 'port' ? '整数' : '数値'}で入力してください`);
    else s[k] = v;
  }
  for (const id of ['#cU80', '#cU81']) { const el = $(id); el.invalid = false; if (!/^https?:\/\/\S+$/.test(el.value.trim())) bad(el, 'http:// または https:// で始まるURLを入力してください'); }
  const pwEl = $('#cPw'); pwEl.invalid = false; if (!pwEl.value) bad(pwEl, 'パスワードを入力してください');
  const dirEl = $('#cRecDir'); dirEl.invalid = false; if (!dirEl.value.trim()) bad(dirEl, '保存先を入力してください');
  if (s.borderMin != null && s.borderMax != null && s.borderMin > s.borderMax) bad($('#cBmax'), '下限以上の値を入力してください');
  if (!ok) return null;
  Object.assign(s, { jsonUrls: { 80: $('#cU80').value.trim(), 81: $('#cU81').value.trim() }, recordEnabled: !!$('#cRec').toggled, recordDir: dirEl.value.trim() });
  if (loadedCfg && pwEl.value !== loadedCfg.dispatcherPassword) s.newPassword = pwEl.value;
  return s;
}
$('#cSave').addEventListener('click', async () => {
  const s = readCfg(); if (!s) return cfgMsg('error', '入力を確認してください');
  try {
    const r = await api('config', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(s) });
    await loadCfg();
    cfgMsg('success', '保存しました', r.restart ? 'ポートの変更は再起動後に反映されます' : '', r.restart);
  } catch (e) { cfgMsg('error', '保存できません', e.message); }
});
$('#cReload').addEventListener('click', () => { $('#cfgMsg').innerHTML = ''; loadCfg(); });
$('#cRecOpen').addEventListener('click', () => { const p = $('#cRecDir').value.trim(); if (p) bridge.open(p); });

// ------------------------------------------------------------ ログ
const logEl = $('#log'), MAX_LOG = 2000;
function addLog(lines) {
  const atEnd = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  logEl.textContent += lines.map((l) => l + '\n').join('');
  const all = logEl.textContent.split('\n'); if (all.length > MAX_LOG) logEl.textContent = all.slice(-MAX_LOG).join('\n');
  if (atEnd) logEl.scrollTop = logEl.scrollHeight;
}
$('#logClear').addEventListener('click', () => { logEl.textContent = ''; });

// ------------------------------------------------------------ 録音
let lastState = null;
function recInfo(name) {
  const m = /^(\d+)ch_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
  return m ? { ch: m[1], at: `${m[2]}/${m[3]}/${m[4]} ${m[5]}:${m[6]}:${m[7]}` } : { ch: '-', at: '-' };
}
async function loadRecs() {
  if (!online()) return;
  let files; try { files = await api('recordings'); } catch (e) { return; }
  $('#recEmpty').hidden = files.length > 0; $('#recs').hidden = files.length === 0;
  $('#recRows').innerHTML = files.map((f) => {
    const i = recInfo(f.name), sec = Math.max(0, (f.size - 44) / 16000);   // 8kHz・16bit・モノラル
    return `<cds-table-row><cds-table-cell>${i.at}</cds-table-cell><cds-table-cell>${i.ch}</cds-table-cell><cds-table-cell>${sec.toFixed(1)}秒</cds-table-cell>`
      + `<cds-table-cell><code>${esc(f.name)}</code></cds-table-cell><cds-table-cell><cds-button kind="ghost" size="sm" data-play="${esc(f.name)}">再生</cds-button></cds-table-cell></cds-table-row>`;
  }).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]'); if (!b || !online()) return;
  const p = $('#player'); p.src = apiUrl('rec/' + encodeURIComponent(b.dataset.play)); p.play().catch(() => {});
});
$('#recRefresh').addEventListener('click', loadRecs);
$('#recOpen').addEventListener('click', () => { if (lastState) bridge.open(lastState.recDir); else if (loadedCfg) bridge.open(loadedCfg.recordDir); });

// ------------------------------------------------------------ タブ・定期更新
let tab = 'status';
$('#tabs').addEventListener('cds-tabs-selected', (e) => {
  tab = e.detail.item.value;
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== 'p-' + tab; });
  if (tab === 'config' && !loadedCfg) loadCfg();
  if (tab === 'rec') loadRecs();
  if (tab === 'log') logEl.scrollTop = logEl.scrollHeight;
});
let wasOnline = false;
async function tick() {
  try { st = await bridge.status(); } catch (e) { return; }
  renderRun();
  if (online()) {
    if (!wasOnline) { addrKey = ''; loadedCfg = null; if (tab === 'config') loadCfg(); if (tab === 'rec') loadRecs(); }
    try { lastState = await api('state'); renderState(lastState); } catch (e) {}
  }
  wasOnline = online();
}
(async () => {
  try { addLog(await bridge.logs()); } catch (e) {}
  bridge.onLog((line) => addLog([line]));
  await tick(); setInterval(tick, 1000);
})();
})();
