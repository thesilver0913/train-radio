# 列車無線 通話アプリ

サーバーと、PC版・Android版のクライアントで構成します。**サーバーとPC版はNode.jsだけで動きます**(`npm install` もビルドも不要)。

| フォルダ | 内容 |
|---|---|
| `server/` | サーバー(Node.js 18以上・依存パッケージなし) |
| `client/` | 画面と音声処理(PC版・Android版の共通部分) |
| `pc-client/` | PC版の起動プログラム(Node.js)。指令卓はPC版のみ |
| `android/` | Android版(列車側のみ)のプロジェクト。**APKのビルドが必要**(下記) |

## インストール(Windows / Android)
[Releases](https://github.com/thesilver0913/train-radio/releases) から入手します。Node.js のインストールは不要です。
- **Windows**: `TrainRadio-Setup-x.y.z.exe` を実行し、「サーバー」「PC版クライアント」を選んでインストール(管理者権限・Program Files)。
  - サーバー(`TrainRadioServer.exe`)はウィンドウを出さずタスクトレイに常駐します。右クリックで状態(接続先アドレス)・設定ファイル・録音フォルダ・終了。サインイン時の自動起動とファイアウォール許可はインストール時に選べます。
  - 設定は `C:\ProgramData\TrainRadio\config.json`、録音は `ドキュメント\TrainRadio\recordings` に保存します。
  - PC版(`TrainRadio.exe`)は WebView2 で動く独立したアプリです(Windows 11 は標準搭載)。送話キーは他のアプリが前面でも効きます。
- **Android**: `TrainRadio-x.y.z.apk` を端末に入れてインストール(提供元不明アプリの許可が必要)。新しい版は上書きインストールできます。

## ビルドとリリース
`v1.2.3` のようなタグを push すると、GitHub Actions がインストーラーとAPKをビルドして Releases に登録します(Actions 画面から手動実行するとビルドのみ)。
```
git tag v1.0.0
git push origin v1.0.0
```
| 成果物 | 中身 | 手元でのビルド |
|---|---|---|
| `TrainRadioServer.exe` | Node.js 単一実行ファイル(SEA)。同じフォルダの `server/*.js` を読み込む | `npm ci && npm run build:server`(Node.js 25.5以上) |
| `TrainRadio.exe` | Tauri 2(Rust)。画面は `client/` を埋め込み | `cd desktop && npm ci && npx tauri build --no-bundle`(Rust が必要) |
| インストーラー | Inno Setup 6(`installer/TrainRadio.iss`) | 上の2つを `dist/` に置いて `iscc installer\TrainRadio.iss` |
| APK | 署名鍵は GitHub Secrets(`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD`、別名 `trainradio`) | Android Studio(下記) |

以下は Node.js で直接動かす場合の説明です。

Web版(スマホのブラウザから開く方式)は廃止しました。サーバーは音声・制御のWebSocketと効果音の配信だけを行い、画面は各クライアントが持ちます。

## 1. サーバー
```
cd server
node server.js        (Windowsは start-server.bat をダブルクリック)
```
初回起動で `config.json` を作ります(ポート 8080、指令パスワード `changeme`)。通信は http / ws(暗号化なし)で動きます。

## 2. PC版(Windows / Node.jsのみ)
`client` と `pc-client` の2フォルダを同じ場所に置き、`pc-client/start-client.bat` をダブルクリック(または `node pc-client/client.js`)。
- Microsoft Edge または Google Chrome が「アプリ表示」で開きます(Windows 10/11 は標準でEdgeが入っています)。
- ログイン画面の「サーバー」に `http://サーバーのIP:8080` を入力します。初回だけマイクの許可を求められます。
- 送話キー(既定 F6)は**他のアプリが前面でも**効きます(WindowsのPowerShellを使用)。最前面固定・入出力デバイス選択・表示倍率は設定画面から。
- 指令卓(列車番号 12306)はPC版のみです。

## 3. Android版(列車側のみ)
APKは、Android Studio(JDK・Android SDK同梱)で**一度だけビルド**する必要があります。
1. Android Studio で `android/` フォルダを開く(`client/` を更新した場合は先に `node android/sync-assets.js`)。
2. メニュー Build → Build Bundle(s) / APK(s) → Build APK(s)。
3. できた `app-debug.apk` を端末に入れてインストール(提供元不明アプリの許可が必要)。

画面ファイルはアプリ内にあるため、サーバーがhttpでもマイクが使えます。ログイン画面の「サーバー」に `http://サーバーのIP:8080` を入力します。

## 通話の録音
- サーバーが、チャンネルごとに「話中ランプが点灯している間」を **1つのWAVファイル**に保存します(8kHz / 16bit / モノラル)。
- 保存先は `server/recordings/`。ファイル名は `80ch_20261120_143005.wav`(チャンネル番号_年月日_時分秒)。
- 通話が終わってから3秒以内に次の通話が始まった場合は、同じファイルに連結します(間の無音も含めて時間どおり)。
- 複数人が同時に話した音声は、デコードして**ミックス**して1本に保存します。
- チャイム・保留音・試験の折り返し音(各端末で再生される効果音)は録音に含まれません。声と、列車が送る試験トーン(800Hz)は含まれます。
- 設定: `config.json` の `recordEnabled`(録音の有無)、`recordDir`(保存先)、`recordKeepDays`(古いファイルの自動削除日数。0=削除しない)、`recordGapSec`(連結する間隔・3秒)。指令卓の詳細設定からも変更できます。
- MP3での保存には外部ライブラリ(エンコーダ)が必要になるため、WAVにしています。

## 音声方式
サーバーがNode.jsだけで録音用にデコードできるよう、通話音声は **8kHz・4bit IMA-ADPCM**(1パケット20ms・約33kbps)に統一しました。1パケットで完結するため、パケットが欠けても後続に影響しません。帯域は300〜3400Hzに制限し、受信側で歪み・ノイズを加えて無線らしくしています。

## 設定(config.json / 指令卓の「詳細設定」)
指令パスワード(平文)、位置JSONのURL、取得間隔(7秒)、位置不明にする時差(600秒)、呼出の自動切断(30秒)、防護発報の範囲(±1.5)、2ch越境のpos範囲(7.0〜8.5)、録音の設定。

## 差し替え可能な素材
- 音声(`server/sounds/*.wav`): `chime80` `chime81` `hold` `tone800` `test_return` `ringback` `bell` `guard`(防護警報「ピピピピピ」)。現在は仮の合成音です。
- テクスチャ(`client/img/`): `base` `power` `busy` `guard` `test` `seg`。差し替え後、Android版は `node android/sync-assets.js` を実行して再ビルド。

## 実装上の取り決め
- 無線機番号は `040` のように3桁ゼロ埋め。3桁が埋まったら4桁(1000〜9999)。
- ランプの点滅は周期1秒。防護発報の警報は、発報した列車・受信した列車・指令卓で鳴り、復位または強制解除で止まります。
- 話中(一斉・個別とも)の受話器上げは、指令の承認なしで即割込。無通話時は指令の応答待ち。
- 個別通話中は列車側から抜けられず(ログアウトのみ)、指令の終話で全員の受話器が自動復位。
- 防護発報の範囲判定は、駅リスト外のposでも数値のまま使います(区間表示のみ無表示)。
- 試験: 通話が無いときは無音でランプのみ。通話中は聞こえる範囲にトーンが流れます。

## 動作確認の状況
- 自動テスト済み: サーバー(`cd server && node test.js` の43項目。録音のミックス・連結・ファイル名を含む)、ブラウザ(Chromium)での通話・PTT・録音。
- **未確認**: Windows上でのPC版(全体ホットキー・最前面固定のPowerShell部分)、Android版(ビルド・WebView上のマイク)、実機の音質・遅延。
