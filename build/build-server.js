// サーバー本体を TrainRadioServerCore.exe にする: node build/build-server.js  → dist/TrainRadioServerCore.exe
// (管理アプリ TrainRadioServer.exe が画面なしで起動する)
// 1) Node SEA で node.exe に入口スクリプトを埋め込む  2) アイコン・バージョン情報を設定  3) コンソールを出さない(GUIサブシステム)にする
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const rcedit = require('rcedit');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'dist', 'TrainRadioServerCore.exe');
const version = require(path.join(ROOT, 'server', 'package.json')).version;

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const cfg = path.join(os.tmpdir(), 'trainradio-sea.json');
  fs.writeFileSync(cfg, JSON.stringify({ main: path.join(__dirname, 'sea-server.js'), output: OUT, disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ['--build-sea', cfg], { stdio: 'inherit' });

  await rcedit(OUT, {
    icon: path.join(ROOT, 'desktop', 'src-tauri', 'icons', 'icon.ico'),
    'file-version': version, 'product-version': version,
    'version-string': { ProductName: '列車無線サーバー', FileDescription: '列車無線サーバー(本体)', CompanyName: '', LegalCopyright: '', OriginalFilename: 'TrainRadioServerCore.exe', InternalName: 'TrainRadioServerCore' },
  });

  // PEヘッダの Subsystem を 3(CUI) → 2(GUI) に書き換えると、起動時にコンソール窓が出ない
  const b = fs.readFileSync(OUT), pe = b.readUInt32LE(0x3c), at = pe + 4 + 20 + 68;
  if (b.readUInt32LE(pe) !== 0x4550 || b.readUInt16LE(at) !== 3) throw new Error('想定外のPEヘッダ');
  b.writeUInt16LE(2, at); fs.writeFileSync(OUT, b);
  console.log('built', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
