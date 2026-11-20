// アップデートのダウンロードと実行(PC版クライアント・サーバー管理アプリで共通。各 main.rs から #[path] で読み込む)
use std::process::Command;

const PREFIX: &str = "https://github.com/thesilver0913/train-radio/releases/download/";

/// インストーラーを一時フォルダへダウンロードし、サイレントで起動する。
/// インストーラーは起動中のアプリを終了させてから上書きし、終わると launch("client" / "server")のアプリを起動し直す。
pub fn download_and_run(url: &str, launch: &str) -> Result<(), String> {
    if !url.starts_with(PREFIX) || !url.ends_with(".exe") || url.contains(['"', '\'', ' ']) {
        return Err("更新ファイルのURLが不正です".into());
    }
    let path = std::env::temp_dir().join("TrainRadio-Setup.exe");
    let _ = std::fs::remove_file(&path);
    let st = hidden("curl.exe").args(["-L", "-f", "-s", "--retry", "2", "-o"]).arg(&path).arg(url)
        .status().map_err(|e| format!("ダウンロードできません: {e}"))?;
    if !st.success() { return Err(format!("ダウンロードに失敗しました(curl {})", st.code().unwrap_or(-1))); }
    // 管理者権限への昇格(UAC)が必要なため、ShellExecute 相当の Start-Process で起動する
    let ps = format!(
        "Start-Process -FilePath '{}' -ArgumentList '/SILENT','/SUPPRESSMSGBOXES','/NORESTART','/LAUNCH={launch}'",
        path.display().to_string().replace('\'', "''")
    );
    let st = hidden("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .status().map_err(|e| format!("インストーラーを起動できません: {e}"))?;
    if !st.success() { return Err("インストーラーを起動できませんでした(管理者の許可が取り消された可能性があります)".into()); }
    Ok(())
}

fn hidden(exe: &str) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}
