// 列車無線 PC版: ../../client の画面を WebView2 で表示する。
// Rust側の役割は「送話キーの全体検知(他のアプリが前面でも押下/離上を取る)」と「マイクの自動許可」だけ。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

static PTT_VK: AtomicI32 = AtomicI32::new(0);

/// KeyboardEvent.code → Windows仮想キーコード(F1〜F12 / 英字 / 数字 / スペース)
fn vk_of(code: &str) -> i32 {
    if let Some(n) = code.strip_prefix('F').and_then(|s| s.parse::<i32>().ok()) {
        if (1..=12).contains(&n) { return 0x6F + n; }
    }
    if let Some(c) = code.strip_prefix("Key").filter(|s| s.len() == 1) { return c.as_bytes()[0] as i32; }
    if let Some(c) = code.strip_prefix("Digit").filter(|s| s.len() == 1) { return c.as_bytes()[0] as i32; }
    if code == "Space" { return 0x20; }
    0
}

#[tauri::command]
fn set_ptt_key(code: String) {
    PTT_VK.store(vk_of(&code), Ordering::Relaxed);
}

#[cfg(windows)]
fn key_down(vk: i32) -> bool {
    #[link(name = "user32")]
    extern "system" { fn GetAsyncKeyState(v: i32) -> i16; }
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}
#[cfg(not(windows))]
fn key_down(_vk: i32) -> bool { false }

#[cfg(windows)]
fn allow_microphone(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::PermissionRequestedEventHandler;
    let _ = window.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

#[path = "../../../build/update.rs"]
mod update;

/// 新しい版のインストーラーをダウンロードして起動する(更新後はこのアプリを起動し直す)
#[tauri::command]
async fn install_update(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update::download_and_run(&url, "client")).await.map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_ptt_key, install_update])
        .setup(|app| {
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") { allow_microphone(&w); }
            // ponytail: 8msポーリング(旧PowerShell版と同じ方式)。遅延が問題ならキーボードフック(SetWindowsHookEx)へ
            let h = app.handle().clone();
            std::thread::spawn(move || {
                let mut prev = false;
                loop {
                    let vk = PTT_VK.load(Ordering::Relaxed);
                    let down = vk != 0 && key_down(vk);
                    if down != prev { prev = down; let _ = h.emit("ptt", down); }
                    std::thread::sleep(Duration::from_millis(8));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("起動に失敗しました");
}
