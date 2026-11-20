// 列車無線サーバー 管理アプリ(TrainRadioServer.exe)
//  - 同じフォルダの TrainRadioServerCore.exe(Node.js のサーバー本体)を画面なしで起動・停止し、ログを受け取る
//  - 管理画面(../ui)とタスクトレイを出す。ウィンドウを閉じてもトレイに残り、サーバーは動き続ける
//  - 起動引数 --minimized: ウィンドウを出さずにトレイだけで起動(サインイン時の自動起動用)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

const MAX_LOG: usize = 2000;

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    ready: Option<serde_json::Value>,
    exit_code: Option<i32>,
    last_error: String,
    logs: VecDeque<String>,
    generation: u64,
}

struct Srv {
    inner: Arc<Mutex<Inner>>,
    token: String,
    data_dir: PathBuf,
    docs_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    running: bool,
    ready: Option<serde_json::Value>,
    token: String,
    exit_code: Option<i32>,
    last_error: String,
}

/// 管理APIの鍵(この起動中だけ有効)。RandomState は OS の乱数で初期化される
fn new_token() -> String {
    (0..2).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

fn push_log(app: &AppHandle, inner: &Arc<Mutex<Inner>>, line: String) {
    {
        let mut g = inner.lock().unwrap();
        g.logs.push_back(line.clone());
        while g.logs.len() > MAX_LOG { g.logs.pop_front(); }
    }
    let _ = app.emit("log", line);
}

fn start(app: &AppHandle) -> Result<(), String> {
    let srv = app.state::<Srv>();
    let inner = srv.inner.clone();
    let mut g = inner.lock().unwrap();
    if g.child.is_some() { return Ok(()); }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("TrainRadioServerCore.exe");
    let mut cmd = Command::new(&exe);
    cmd.env("RADIO_DATA", &srv.data_dir)
        .env("RADIO_DOCS", &srv.docs_dir)
        .env("RADIO_ADMIN_TOKEN", &srv.token)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("サーバーを起動できません({}): {}", exe.display(), e);
            g.exit_code = Some(-1); g.last_error = msg.clone(); drop(g);
            push_log(app, &inner, msg.clone());
            return Err(msg);
        }
    };
    g.generation += 1;
    let generation = g.generation;
    g.stdin = child.stdin.take();
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    g.child = Some(child);
    g.ready = None; g.exit_code = None; g.last_error.clear();
    drop(g);

    // 標準出力: "@@ready {...}" は起動完了の通知、それ以外はログ
    let (a, i) = (app.clone(), inner.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(js) = line.strip_prefix("@@ready ") {
                if let Ok(v) = serde_json::from_str(js) { i.lock().unwrap().ready = Some(v); }
            } else {
                push_log(&a, &i, line);
            }
        }
    });
    let (a, i) = (app.clone(), inner.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            i.lock().unwrap().last_error = line.clone();
            push_log(&a, &i, line);
        }
    });
    // 終了の監視
    let (a, i) = (app.clone(), inner.clone());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let mut g = i.lock().unwrap();
        if g.generation != generation { return; }
        let Some(c) = g.child.as_mut() else { return };
        if let Ok(Some(status)) = c.try_wait() {
            let code = status.code().unwrap_or(-1);
            g.child = None; g.stdin = None; g.ready = None; g.exit_code = Some(code);
            drop(g);
            push_log(&a, &i, format!("サーバーが終了しました(終了コード {})", code));
            return;
        }
    });
    Ok(())
}

/// quit を送って録音を閉じさせ、3秒待っても終わらなければ強制終了する
fn stop(app: &AppHandle) {
    let inner = app.state::<Srv>().inner.clone();
    let mut g = inner.lock().unwrap();
    let Some(mut child) = g.child.take() else { return };
    g.generation += 1; // 終了の監視スレッドを止める
    if let Some(mut stdin) = g.stdin.take() { let _ = stdin.write_all(b"quit\n"); }
    drop(g);
    let until = Instant::now() + Duration::from_secs(3);
    let code = loop {
        if let Ok(Some(s)) = child.try_wait() { break s.code().unwrap_or(0); }
        if Instant::now() > until { let _ = child.kill(); let _ = child.wait(); break 0; }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut g = inner.lock().unwrap();
    g.ready = None; g.exit_code = Some(code);
    drop(g);
    push_log(app, &inner, "サーバーを停止しました".into());
}

#[tauri::command]
fn status(srv: tauri::State<Srv>) -> Status {
    let g = srv.inner.lock().unwrap();
    Status { running: g.child.is_some(), ready: g.ready.clone(), token: srv.token.clone(), exit_code: g.exit_code, last_error: g.last_error.clone() }
}
#[tauri::command]
fn logs(srv: tauri::State<Srv>) -> Vec<String> { srv.inner.lock().unwrap().logs.iter().cloned().collect() }
#[tauri::command]
fn start_server(app: AppHandle) -> Result<(), String> { start(&app) }
#[tauri::command]
fn stop_server(app: AppHandle) { stop(&app) }
#[tauri::command]
fn restart_server(app: AppHandle) -> Result<(), String> { stop(&app); start(&app) }
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let _ = std::fs::create_dir_all(&path);
    Command::new("explorer.exe").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
}

#[path = "../../../build/update.rs"]
mod update;

/// 新しい版のインストーラーをダウンロードして起動する(更新後はこのアプリを起動し直す)
#[tauri::command]
async fn install_update(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update::download_and_run(&url, "server")).await.map_err(|e| e.to_string())?
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app))) // 二重起動時は既存の画面を出す
        .invoke_handler(tauri::generate_handler![status, logs, start_server, stop_server, restart_server, open_path, install_update])
        .setup(|app| {
            let data_dir = PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into())).join("TrainRadio");
            let docs_dir = app.path().document_dir().unwrap_or_else(|_| data_dir.clone());
            app.manage(Srv { inner: Arc::new(Mutex::new(Inner::default())), token: new_token(), data_dir, docs_dir });

            let open = MenuItem::with_id(app, "open", "管理画面を開く", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("列車無線サーバー")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => { stop(app); app.exit(0); }
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e { show_main(tray.app_handle()); }
                });
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;

            let _ = start(app.handle());
            if !std::env::args().any(|a| a == "--minimized") { show_main(app.handle()); }
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e { api.prevent_close(); let _ = w.hide(); } // 閉じてもトレイに残す
        })
        .build(tauri::generate_context!())
        .expect("起動に失敗しました");
    app.run(|app, e| { if let RunEvent::Exit = e { stop(app); } });
}
