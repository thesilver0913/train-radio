// アップデートの確認・インストール(PC版クライアント / サーバー管理アプリ / Android版で共通)
//  build/build-ui.js が client/vendor と admin/ui/vendor にコピーする。編集はこのファイルで行う
//  host = { kind: 'setup'(Windowsインストーラー) | 'apk', version(): Promise<string>, install(url): Promise }
(() => {
  const API = 'https://api.github.com/repos/thesilver0913/train-radio/releases/latest', K = 'trainradio.update';
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch (e) { return {}; } };
  const save = (o) => { try { localStorage.setItem(K, JSON.stringify(Object.assign(load(), o))); } catch (e) {} };
  const num = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  const fmt = (t) => t ? new Date(t).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未確認';

  async function check(host) {
    const [cur, r] = await Promise.all([host.version(), fetch(API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })]);
    if (!r.ok) throw new Error(r.status === 404 ? 'リリースが見つかりません' : 'HTTP ' + r.status);
    const j = await r.json(), latest = String(j.tag_name || '').replace(/^v/, '');
    const re = host.kind === 'apk' ? /\.apk$/i : /^TrainRadio-Setup-.*\.exe$/i, a = (j.assets || []).find((x) => re.test(x.name));
    save({ lastCheck: Date.now() });
    return { current: cur, latest, url: a ? a.browser_download_url : '', available: !!a && newer(latest, cur) };
  }
  const installMsg = (host) => host.kind === 'apk' ? 'ダウンロード中です。完了するとインストール画面が開きます' : 'ダウンロード中です。完了するとインストーラーが起動し、アプリは一度終了します';

  // 設定画面の「アップデート」欄。h は見出しのタグ(画面に合わせる)
  const section = (h) => `<section class="upd"><${h}>アップデート</${h}>
    <div class="updinfo"><span>現在のバージョン</span><span id="uCur">-</span><span>最終確認</span><span id="uLast">${fmt(load().lastCheck)}</span></div>
    <cds-checkbox id="uAuto" ${load().auto !== false ? 'checked' : ''}>起動時に確認する</cds-checkbox>
    <div class="updact"><cds-button id="uCheck" kind="tertiary" size="md" type="button">更新を確認</cds-button><cds-button id="uInstall" kind="primary" size="md" type="button" hidden></cds-button></div>
    <p id="uMsg" class="updmsg" role="status"></p></section>`;

  function bind(root, host) {
    const $ = (s) => root.querySelector(s), msg = (t, bad) => { $('#uMsg').textContent = t; $('#uMsg').classList.toggle('bad', !!bad); };
    let found = null;
    host.version().then((v) => { $('#uCur').textContent = 'v' + v; }, () => {});
    $('#uAuto').addEventListener('cds-checkbox-changed', (e) => save({ auto: e.target.checked }));
    $('#uCheck').addEventListener('click', async (e) => {
      const b = e.currentTarget; if (b.disabled) return; b.disabled = true; msg('確認中です');
      try {
        found = await check(host); $('#uLast').textContent = fmt(load().lastCheck);
        $('#uInstall').hidden = !found.available; $('#uInstall').textContent = `v${found.latest} をインストール`;
        msg(found.available ? `新しいバージョン v${found.latest} があります` : '最新版です');
      } catch (x) { msg('確認できませんでした: ' + (x.message || x), true); }
      b.disabled = false;
    });
    $('#uInstall').addEventListener('click', async (e) => {
      const b = e.currentTarget; if (b.disabled || !found) return; b.disabled = true; msg(installMsg(host));
      try { await host.install(found.url); } catch (x) { msg('更新できませんでした: ' + (x.message || x), true); b.disabled = false; }
    });
    window.addEventListener('updatefail', (e) => { msg('更新できませんでした: ' + e.detail, true); $('#uInstall').disabled = false; });
  }

  // 起動時の確認。新しい版があれば box に「インストール」ボタン付きの通知を出す(閉じれば消える)
  async function startup(host, box) {
    if (load().auto === false) return;
    let f; try { f = await check(host); } catch (e) { return; }
    if (!f.available) return;
    const n = document.createElement('cds-actionable-notification');
    n.setAttribute('kind', 'info'); n.setAttribute('inline', ''); n.setAttribute('low-contrast', '');
    n.setAttribute('title', `新しいバージョン v${f.latest} があります`); n.setAttribute('subtitle', `現在 v${f.current}`);
    const b = document.createElement('cds-actionable-notification-button'); b.setAttribute('slot', 'action'); b.textContent = 'インストール';
    b.addEventListener('click', async () => {
      n.setAttribute('subtitle', installMsg(host));
      try { await host.install(f.url); } catch (x) { n.setAttribute('kind', 'error'); n.setAttribute('subtitle', '更新できませんでした: ' + (x.message || x)); }
    });
    window.addEventListener('updatefail', (e) => { n.setAttribute('kind', 'error'); n.setAttribute('subtitle', '更新できませんでした: ' + e.detail); });
    n.appendChild(b); box.appendChild(n);
  }

  window.Updater = { check, newer, section, bind, startup };
})();
