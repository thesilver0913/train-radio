// ../client の画面ファイルを app/src/main/assets/www にコピーする(画面を更新したときに実行: node sync-assets.js)
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'client'), dst = path.join(__dirname, 'app', 'src', 'main', 'assets', 'www');
fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); console.log('copied to', dst);
