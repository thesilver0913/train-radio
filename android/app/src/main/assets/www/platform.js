// PC版(pc-client の起動プログラム経由で開いた場合)だけ window.desktop を用意する。
// 送話キー(全体ホットキー)・最前面固定は、同じPC上の起動プログラムに /__ctl で依頼する。
// Android(アプリ内)では何もしない(window.desktop は未定義のまま)。
(() => {
  const local = location.protocol === 'http:' && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
  if (!local) return;
  let ws = null, pttCb = null; const last = {};
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const open = () => {
    ws = new WebSocket(`ws://${location.host}/__ctl`);
    ws.onopen = () => { if (last.pttKey) send({ t: 'pttKey', code: last.pttKey }); if (last.onTop != null) send({ t: 'onTop', on: last.onTop }); };
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.t === 'ptt' && pttCb) pttCb(!!m.on); } catch (x) {} };
    ws.onclose = () => setTimeout(open, 1000);
  };
  window.desktop = {
    platform: 'pc',
    setPttKey: (code) => { last.pttKey = code; send({ t: 'pttKey', code }); },
    setAlwaysOnTop: (on) => { last.onTop = !!on; send({ t: 'onTop', on: !!on }); },
    resize: (w, h) => { try { window.resizeTo(w + (outerWidth - innerWidth), h + (outerHeight - innerHeight)); } catch (e) {} },
    onPtt: (cb) => { pttCb = cb; },
  };
  open();
})();
