package local.trainradio;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

/** 列車側の画面(assets/www)をWebViewで表示するだけのアプリ。
 *  画面は https://appassets.androidplatform.net/ として端末内から配信する(file:// だとオリジンが null になり、
 *  AudioWorklet の blob:null を読み込めず通話できない)。https扱いなのでマイクも使え、http/wsのサーバーへは混在コンテンツ許可で接続する。 */
public class MainActivity extends Activity {
    private static final String UPDATE_PREFIX = "https://github.com/thesilver0913/train-radio/releases/download/";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private WebView web;
    private long updateId = -1;

    /** 画面(update.js)から呼ぶ: バージョン取得と、新しいAPKのダウンロード→インストール画面 */
    private class AppBridge {
        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "0.0.0"; }
        }
        @JavascriptInterface public void installUpdate(String url) { runOnUiThread(() -> downloadUpdate(url)); }
    }

    private void downloadUpdate(String url) {
        if (url == null || !url.startsWith(UPDATE_PREFIX) || !url.endsWith(".apk")) { updateFailed("更新ファイルのURLが不正です"); return; }
        java.io.File old = new java.io.File(getExternalFilesDir(null), "update.apk");
        if (old.exists()) old.delete();
        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        updateId = dm.enqueue(new DownloadManager.Request(Uri.parse(url))
                .setTitle("列車無線の更新").setMimeType(APK_MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationInExternalFilesDir(this, null, "update.apk"));
    }

    private final BroadcastReceiver onDownloaded = new BroadcastReceiver() {
        @Override public void onReceive(Context ctx, Intent i) {
            long id = i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id != updateId) return;
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            boolean ok = false;
            try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
                ok = c.moveToFirst() && c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL;
            }
            Uri apk = ok ? dm.getUriForDownloadedFile(id) : null;
            if (apk == null) { updateFailed("ダウンロードに失敗しました"); return; }
            // 初回はOSが「この提供元のアプリを許可」の確認を出す
            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(apk, APK_MIME)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    };

    private void updateFailed(String msg) {
        web.evaluateJavascript("dispatchEvent(new CustomEvent('updatefail',{detail:" + org.json.JSONObject.quote(msg) + "}))", null);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
        }
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // 設定の保存(localStorage)
        s.setMediaPlaybackRequiresUserGesture(false);       // 警報・チャイムなどの自動再生
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.addJavascriptInterface(new AppBridge(), "TrainRadioApp");
        IntentFilter done = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(onDownloaded, done, Context.RECEIVER_EXPORTED); else registerReceiver(onDownloaded, done);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));   // マイク
            }
        });
        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }
        });
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
    }

    @Override
    public void onBackPressed() { /* 通話中の誤操作防止のため戻るボタンは無効 */ }

    @Override
    protected void onDestroy() {
        unregisterReceiver(onDownloaded);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
