'use strict';
// インストール版(TrainRadioServer.exe・コンソールなし)専用: タスクトレイのアイコンとエラー表示を PowerShell(WinForms)で出す
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execFileSync } = require('child_process');

// BOM付きで書き出す: PowerShell 5.1 が日本語を正しく読むため
const psFile = (script) => {
  const f = path.join(os.tmpdir(), `trainradio-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(f, '﻿' + script); return f;
};
const PS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

// 実際の「ドキュメント」フォルダ(OneDrive等でリダイレクトされていても正しい場所)
function documentsDir() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')"], { windowsHide: true, encoding: 'utf8' }).trim();
    if (out) return out;
  } catch (e) {}
  return path.join(os.homedir(), 'Documents');
}

// OKが押されるまで待つ(呼び出し側はこの後 process.exit する)
function alert(msg) {
  const f = psFile(`param([string]$M)
Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show($M, '列車無線サーバー', 'OK', 'Error')`);
  try { execFileSync('powershell.exe', [...PS, f, msg], { windowsHide: true }); } catch (e) {}
  fs.rmSync(f, { force: true });
}

const TRAY = `param([int]$ParentPid, [string]$Exe, [string]$Status, [string]$CfgPath, [string]$RecDir)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)
$n.Text = '列車無線サーバー'
$m = New-Object System.Windows.Forms.ContextMenuStrip
$s = $m.Items.Add($Status); $s.Enabled = $false
[void]$m.Items.Add('-')
[void]$m.Items.Add('設定ファイルを開く', $null, { Start-Process notepad.exe -ArgumentList ('"' + $CfgPath + '"') })
[void]$m.Items.Add('録音フォルダを開く', $null, { New-Item -ItemType Directory -Force $RecDir | Out-Null; Start-Process explorer.exe ('"' + $RecDir + '"') })
[void]$m.Items.Add('-')
[void]$m.Items.Add('終了', $null, { [Console]::Out.WriteLine('quit'); [Console]::Out.Flush(); $n.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$n.ContextMenuStrip = $m
$n.Visible = $true
$n.ShowBalloonTip(3000, '列車無線サーバー', ('起動しました  ' + $Status), 'Info')
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 2000
$t.add_Tick({ if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $n.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$t.Start()
[System.Windows.Forms.Application]::Run()
`;

function start({ scheme, port, cfgPath, recDir, onQuit }) {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  const status = `稼働中  ${scheme}://${ips[0] || '127.0.0.1'}:${port}`;
  const f = psFile(TRAY);
  const p = spawn('powershell.exe', [...PS, f, String(process.pid), process.execPath, status, cfgPath, recDir], { windowsHide: true });
  p.on('exit', () => fs.rmSync(f, { force: true }));
  p.stdout.on('data', (d) => { if (String(d).includes('quit')) onQuit(); });
  p.on('error', () => {});
}

module.exports = { documentsDir, alert, start };
