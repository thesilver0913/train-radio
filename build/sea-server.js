// TrainRadioServer.exe の入口。exe と同じフォルダの server/server.js を通常の require で読み込む
// (SEA内の require は組み込みモジュール専用のため createRequire を使う)
const path = require('path');
require('module').createRequire(process.execPath)(path.join(path.dirname(process.execPath), 'server', 'server.js'));
