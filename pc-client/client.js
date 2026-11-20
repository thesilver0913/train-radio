'use strict';
// 列車無線 PC版 起動プログラム(Node.jsのみ・依存パッケージなし)
//  - ../client の画面を 127.0.0.1 で配信し、Edge/Chrome を「アプリ表示」で開く
//    (127.0.0.1 はブラウザが安全な接続として扱うため、サーバーがhttp(ws)でもマイクが使える)
//  - Windowsでは PowerShell で 送話キーの全体ホットキー(他のアプリが前面でも有効)と 最前面固定 を実現する
//  使い方: node client.js [--no-browser]     (ポート変更: 環境変数 RADIO_CLIENT_PORT)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { attach } = require('./ws');

const WWW = path.join(__dirname, '..', 'client');
const PROFILE = path.join(__dirname, 'profile');                 // ブラウザの保存領域(設定・マイク許可がここに残る)
const BASE_PORT = Number(process.env.RADIO_CLIENT_PORT) || 18777;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const WIN = process.platform === 'win32';
let browser = null, watcher = null, ctlConns = new Set();

// ---------------------------------------------------------------- 画面の配信
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(WWW, p));
  if (!file.startsWith(WWW)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(buf);
  });
});
attach(server, (conn, req) => {
  if (req.url !== '/__ctl') return conn.close();
  ctlConns.add(conn); conn.onclose = () => ctlConns.delete(conn);
  conn.onmessage = (d) => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t === 'pttKey') startWatcher(m.code);
    else if (m.t === 'onTop') setTop(!!m.on);
    else if (m.t === '_testPtt' && process.env.RADIO_DEBUG) emitPtt(!!m.on);   // 自動テスト用
  };
});
const emitPtt = (on) => { for (const c of ctlConns) c.send(JSON.stringify({ t: 'ptt', on })); };

// ---------------------------------------------------------------- Windows: 全体ホットキー / 最前面固定
const tmp = (name, text) => { const f = path.join(os.tmpdir(), 'trainradio-' + name); fs.writeFileSync(f, text); return f; };
const PS_KEY = `param([int]$Vk)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v); }
"@
$prev = $false
while ($true) {
  $d = ([K]::GetAsyncKeyState($Vk) -band 0x8000) -ne 0
  if ($d -ne $prev) { $prev = $d; if ($d) { [Console]::Out.WriteLine('D') } else { [Console]::Out.WriteLine('U') }; [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 8
}
`;
const PS_TOP = `param([int]$ProcId, [int]$Top)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }
"@
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 40; $i++) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle; break }
  Start-Sleep -Milliseconds 250
}
if ($h -ne [IntPtr]::Zero) { if ($Top -eq 1) { $a = [IntPtr](-1) } else { $a = [IntPtr](-2) }; [W]::SetWindowPos($h, $a, 0, 0, 0, 0, 0x13) | Out-Null }
`;
function vkOf(code) {
  let m;
  if ((m = /^F(\d+)$/.exec(code)) && +m[1] >= 1 && +m[1] <= 12) return 0x6F + +m[1];
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
  if ((m = /^Digit(\d)$/.exec(code))) return 0x30 + +m[1];
  if (code === 'Space') return 0x20;
  return null;
}
function startWatcher(code) {
  if (watcher) { try { watcher.kill(); } catch (e) {} watcher = null; }
  const vk = vkOf(code);
  if (!WIN || vk == null) { if (!WIN) console.log('全体ホットキーはWindowsのみ対応です(画面がアクティブな間は送話キーが使えます)'); return; }
  const f = tmp('ptt.ps1', PS_KEY);
  const w = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f, String(vk)], { windowsHide: true });
  watcher = w; let buf = '';
  w.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.search(/\r?\n/)) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(buf.indexOf('\n', i) + 1); if (line === 'D') emitPtt(true); else if (line === 'U') emitPtt(false); } });
  w.on('error', (e) => console.warn('PowerShellを起動できません:', e.message)); w.on('exit', () => { if (watcher === w) watcher = null; });
}
function setTop(on) {
  if (!WIN || !browser || !browser.pid) return;
  const f = tmp('top.ps1', PS_TOP);
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f, String(browser.pid), on ? '1' : '0'], { windowsHide: true }).on('error', () => {});
}

// ---------------------------------------------------------------- ブラウザ(Edge/Chrome)をアプリ表示で起動
function findBrowser() {
  const env = process.env, c = [];
  if (env.RADIO_BROWSER) c.push(env.RADIO_BROWSER);
  if (WIN) {
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) {
      c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const d of (env.PATH || '').split(':')) for (const n of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) c.push(path.join(d, n));
  }
  return c.find((x) => { try { return fs.statSync(x).isFile(); } catch (e) { return false; } });
}
function launch(url) {
  const exe = findBrowser();
  if (!exe) { console.log(`Edge / Chrome が見つかりません。お使いのブラウザで ${url} を開いてください。`); return; }
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [`--app=${url}`, `--user-data-dir=${PROFILE}`, '--window-size=380,560', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  browser = spawn(exe, args, { stdio: 'ignore' });
  browser.on('error', (e) => { console.warn('ブラウザを起動できません:', e.message); });
  browser.on('exit', () => { console.log('ウィンドウが閉じられました。終了します。'); shutdown(); });
}
function shutdown() { try { if (watcher) watcher.kill(); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------- 起動
function listen(port, tries) {
  server.once('error', (e) => { if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1); else { console.error('起動できません:', e.message); process.exit(1); } });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`; console.log('列車無線 PC版 起動:', url);
    if (!process.argv.includes('--no-browser')) launch(url);
  });
}
listen(BASE_PORT, 10);
