// Carbon を画面に同梱する: node build/build-ui.js
//  → client/vendor/ と admin/ui/vendor/ に carbon.js(Web Components) / carbon.css(g100テーマ) / IBM Plex Sans を出力
// 画面はオフライン(アプリ内)で動くため CDN は使わない。出力はリポジトリにコミットする
const fs = require('fs'), path = require('path');
const esbuild = require('esbuild'), sass = require('sass');
const ROOT = path.join(__dirname, '..'), NM = path.join(ROOT, 'node_modules');
const OUTS = [path.join(ROOT, 'client', 'vendor'), path.join(ROOT, 'admin', 'ui', 'vendor')];

const js = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'carbon-entry.js')], bundle: true, minify: true, format: 'iife', target: 'chrome100', write: false, legalComments: 'none' }).outputFiles[0].contents;
const css = sass.compile(path.join(__dirname, 'carbon-theme.scss'), { loadPaths: [NM], style: 'compressed', quietDeps: true, silenceDeprecations: ['import', 'global-builtin'] }).css;
const fonts = ['Regular', 'SemiBold'].map((w) => path.join(NM, '@ibm', 'plex-sans', 'fonts', 'complete', 'woff2', `IBMPlexSans-${w}.woff2`));

for (const out of OUTS) {
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'carbon.js'), js); fs.writeFileSync(path.join(out, 'carbon.css'), css);
  for (const f of fonts) fs.copyFileSync(f, path.join(out, path.basename(f)));
  console.log('built', path.relative(ROOT, out), Math.round(js.length / 1024) + 'KB js', Math.round(css.length / 1024) + 'KB css');
}
