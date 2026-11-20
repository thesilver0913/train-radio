; 列車無線 インストーラー(Inno Setup 6)
;   iscc /DMyVersion=1.0.0 installer\TrainRadio.iss   → dist\TrainRadio-Setup-1.0.0.exe
; 事前に dist\TrainRadioServer.exe(npm run build:server)と dist\TrainRadio.exe(Tauri)を用意しておく
#ifndef MyVersion
  #define MyVersion "1.0.0"
#endif

[Setup]
AppId={{6B7D2F3A-1C4E-4E8B-9A57-3D2F0C8E1A64}
AppName=列車無線
AppVersion={#MyVersion}
AppPublisher=train-radio
AppPublisherURL=https://github.com/thesilver0913/train-radio
DefaultDirName={autopf}\TrainRadio
DefaultGroupName=列車無線
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=TrainRadio-Setup-{#MyVersion}
SetupIconFile=..\desktop\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\TrainRadio.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "ja"; MessagesFile: "compiler:Languages\Japanese.isl"

[Types]
Name: "full"; Description: "サーバーとPC版クライアント"
Name: "client"; Description: "PC版クライアントのみ"
Name: "server"; Description: "サーバーのみ"
Name: "custom"; Description: "カスタム"; Flags: iscustom

[Components]
Name: "client"; Description: "PC版クライアント(列車・指令卓)"; Types: full client
Name: "server"; Description: "サーバー(タスクトレイに常駐)"; Types: full server

[Tasks]
Name: "desktopicon"; Description: "デスクトップにアイコンを作成"; GroupDescription: "追加のアイコン:"
Name: "autostart"; Description: "Windowsへのサインイン時にサーバーを自動起動"; GroupDescription: "サーバー:"; Components: server
Name: "firewall"; Description: "ファイアウォールでサーバーへの接続を許可"; GroupDescription: "サーバー:"; Components: server

[Files]
Source: "..\dist\TrainRadio.exe"; DestDir: "{app}"; Components: client; Flags: ignoreversion
Source: "..\dist\TrainRadioServer.exe"; DestDir: "{app}"; Components: server; Flags: ignoreversion
Source: "..\server\*.js"; Excludes: "test.js,gen-sounds.js"; DestDir: "{app}\server"; Components: server; Flags: ignoreversion
Source: "..\server\package.json"; DestDir: "{app}\server"; Components: server; Flags: ignoreversion
Source: "..\server\sounds\*.wav"; DestDir: "{app}\server\sounds"; Components: server; Flags: ignoreversion

[Dirs]
; 設定(config.json)の保存先。トレイから編集できるよう一般ユーザーにも書き込みを許可
Name: "{commonappdata}\TrainRadio"; Permissions: users-modify; Components: server

[Icons]
Name: "{group}\列車無線"; Filename: "{app}\TrainRadio.exe"; Components: client
Name: "{group}\列車無線サーバー"; Filename: "{app}\TrainRadioServer.exe"; Components: server
Name: "{autodesktop}\列車無線"; Filename: "{app}\TrainRadio.exe"; Components: client; Tasks: desktopicon
Name: "{autodesktop}\列車無線サーバー"; Filename: "{app}\TrainRadioServer.exe"; Components: server; Tasks: desktopicon
Name: "{commonstartup}\列車無線サーバー"; Filename: "{app}\TrainRadioServer.exe"; Components: server; Tasks: autostart

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""列車無線サーバー"" dir=in action=allow program=""{app}\TrainRadioServer.exe"" enable=yes"; Flags: runhidden; Tasks: firewall
Filename: "{app}\TrainRadioServer.exe"; Description: "サーバーを起動する"; Components: server; Flags: postinstall nowait skipifsilent
Filename: "{app}\TrainRadio.exe"; Description: "列車無線を起動する"; Components: client; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im TrainRadioServer.exe"; Flags: runhidden; RunOnceId: "KillServer"
Filename: "{sys}\taskkill.exe"; Parameters: "/f /im TrainRadio.exe"; Flags: runhidden; RunOnceId: "KillClient"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""列車無線サーバー"""; Flags: runhidden; RunOnceId: "DelFirewall"

[Code]
// PC版クライアントは WebView2 ランタイムが必要(Windows 11 は標準搭載)
function WebView2Installed(): Boolean;
var v: String;
begin
  Result := RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0')
    or RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0');
end;

// 上書き更新時: 起動中のexeを終了させてからファイルを置き換える(トレイ常駐のサーバーは閉じる要求に応答しないため)
function PrepareToInstall(var NeedsRestart: Boolean): String;
var code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im TrainRadioServer.exe', '', SW_HIDE, ewWaitUntilTerminated, code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im TrainRadio.exe', '', SW_HIDE, ewWaitUntilTerminated, code);
  Result := '';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var code: Integer;
begin
  Result := True;
  if (CurPageID = wpSelectComponents) and WizardIsComponentSelected('client') and not WebView2Installed() then
    if MsgBox('PC版クライアントには Microsoft Edge WebView2 ランタイムが必要ですが、見つかりませんでした。' #13#10 '配布ページを開きますか?(インストール後に列車無線を起動してください)', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, code);
end;
