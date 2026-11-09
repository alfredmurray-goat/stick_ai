use super::{local, stop, target, verify, Desktop};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{State, WebviewWindow};

fn enabled() -> bool { true }
#[derive(Serialize, Deserialize)]
struct Preferences {
    #[serde(default = "enabled")]
    enabled: bool,
    #[serde(default)]
    token: String,
}
fn preferences(state: &Desktop) -> Result<Preferences, String> {
    if !state.settings.exists() { return Ok(Preferences { enabled: true, token: String::new() }); }
    let metadata = fs::symlink_metadata(&state.settings).map_err(|_| "Update settings unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 20000 { return Err("Update settings unavailable".into()); }
    serde_json::from_reader(File::open(&state.settings).map_err(|_| "Update settings unavailable")?).map_err(|_| "Update settings unavailable".into())
}
#[tauri::command]
pub fn app_update_settings(window: WebviewWindow, state: State<'_, Desktop>) -> Result<Value, String> {
    local(&window)?;
    let settings = preferences(&state)?;
    Ok(json!({"enabled": settings.enabled, "hasToken": !settings.token.is_empty(), "lastUpdateFailed": std::env::args().any(|argument| argument == "--update-failed")}))
}
#[tauri::command]
pub fn save_app_update_settings(window: WebviewWindow, state: State<'_, Desktop>, enabled: bool, token: Option<String>, clear_token: bool) -> Result<Value, String> {
    local(&window)?;
    let mut settings = preferences(&state)?; settings.enabled = enabled;
    if clear_token { settings.token.clear(); }
    if let Some(token) = token {
        if token.len() > 10000 || token.contains('\n') || token.contains('\r') { return Err("Invalid GitHub token".into()); }
        if !token.is_empty() { settings.token = token; }
    }
    let parent = state.settings.parent().ok_or("Update settings unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot save update settings")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot save update settings")?;
    serde_json::to_writer(&mut temporary, &settings).map_err(|_| "Cannot save update settings")?;
    temporary.as_file().sync_all().map_err(|_| "Cannot save update settings")?;
    temporary.persist(&state.settings).map_err(|_| "Cannot save update settings")?;
    Ok(json!({"enabled": settings.enabled, "hasToken": !settings.token.is_empty()}))
}
fn command(state: &Desktop, action: &str) -> Result<Value, String> {
    let (platform, executable) = target()?;
    let relative = format!("bin/{platform}/{executable}");
    for path in [relative.as_str(), "app/stick-update.cjs", "app/update-config.json"] {
        verify(&state.root, path).map_err(|_| "This copy needs a new download once to enable updates")?;
    }
    let settings = preferences(state)?;
    let token = std::env::var("STICK_UPDATE_TOKEN").unwrap_or(settings.token);
    let mut command = Command::new(state.root.join(relative));
    command.arg(state.root.join("app/stick-update.cjs")).arg("--root").arg(&state.root).arg(action).arg("--parent").arg(std::process::id().to_string());
    command.current_dir(&state.root).env_clear();
    for name in ["PATH", "Path", "SystemRoot", "ComSpec", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    command.env("NODE_USE_ENV_PROXY", "1");
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|_| "The updater could not start")?;
    let mut input = child.stdin.take().ok_or("The updater could not start")?;
    serde_json::to_writer(&mut input, &json!({"token": token})).map_err(|_| "The updater could not start")?;
    writeln!(input).map_err(|_| "The updater could not start")?; drop(input);
    let output = child.wait_with_output().map_err(|_| "The updater could not finish")?;
    if output.stdout.len() > 20000 { return Err("The updater returned an invalid result".into()); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "The updater could not finish")?;
    if !output.status.success() { return Err(value["message"].as_str().unwrap_or("The app update could not finish").into()); }
    Ok(value)
}
#[tauri::command]
pub async fn check_app_updates(window: WebviewWindow, state: State<'_, Desktop>) -> Result<Value, String> {
    local(&window)?;
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || command(&owned, "--check")).await.map_err(|_| "Update check unavailable")?
}
#[tauri::command]
pub async fn install_app_update(window: WebviewWindow, state: State<'_, Desktop>, app: tauri::AppHandle) -> Result<(), String> {
    local(&window)?;
    let owned = state.inner().clone();
    {
        let mut runtime = owned.runtime.lock().unwrap();
        if runtime.starting || runtime.updating || runtime.child.is_some() || runtime.closing { return Err("Reopen the app before installing an update".into()); }
        runtime.updating = true;
    }
    let reset = owned.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let value = command(&owned, "--prepare")?;
        let work = value["work"].as_str().map(PathBuf::from).ok_or("The update was not prepared")?;
        let root = owned.root.canonicalize().map_err(|_| "The app folder is unavailable")?;
        let work = work.canonicalize().map_err(|_| "The update was not prepared")?;
        let prefix = format!(".{}.update-", root.file_name().ok_or("The app folder is unavailable")?.to_string_lossy());
        if work.parent() != root.parent() || !work.file_name().ok_or("The update was not prepared")?.to_string_lossy().starts_with(&prefix) { return Err("The update folder is invalid".into()); }
        if owned.runtime.lock().unwrap().closing { return Err("Update cancelled".into()); }
        stop(&owned);
        let (platform, executable) = target()?;
        let temporary = tempfile::Builder::new().prefix("stick-ai-updater-").tempdir().map_err(|_| "Cannot prepare the update installer")?;
        let node = temporary.path().join(executable); let helper = temporary.path().join("stick-update.cjs");
        fs::copy(root.join(format!("bin/{platform}/{executable}")), &node).map_err(|_| "Cannot prepare the update installer")?;
        fs::copy(root.join("app/stick-update.cjs"), &helper).map_err(|_| "Cannot prepare the update installer")?;
        let mut install = Command::new(node);
        install.arg(helper).arg("--apply").arg("--root").arg(&root).arg("--work").arg(&work).arg("--parent").arg(std::process::id().to_string()).arg("--temporary").arg(temporary.path());
        install.current_dir(temporary.path()).env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        for name in ["PATH", "Path", "SystemRoot", "ComSpec", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) { install.env(name, value); }
        }
        #[cfg(target_os = "windows")]
        { use std::os::windows::process::CommandExt; install.creation_flags(0x08000200); }
        #[cfg(unix)]
        { use std::os::unix::process::CommandExt; install.process_group(0); }
        install.spawn().map_err(|_| "The update installer could not start")?;
        let _ = temporary.keep();
        app.exit(0);
        Ok(())
    }).await.map_err(|_| "The app update could not finish")?;
    if result.is_err() { reset.runtime.lock().unwrap().updating = false; }
    result
}
pub fn cleanup_runtime() {
    let args: Vec<_> = std::env::args_os().collect();
    let Some(at) = args.iter().position(|value| value == "--cleanup-update") else { return; };
    let Some(path) = args.get(at + 1) else { return; };
    let Ok(path) = Path::new(path).canonicalize() else { return; };
    let Ok(parent) = std::env::temp_dir().canonicalize() else { return; };
    if path.parent() != Some(parent.as_path()) || !path.file_name().map(|value| value.to_string_lossy().starts_with("stick-ai-updater-")).unwrap_or(false) { return; }
    std::thread::spawn(move || {
        for _ in 0..100 {
            for file in ["node", "node.exe", "stick-update.cjs"] { let _ = fs::remove_file(path.join(file)); }
            if fs::remove_dir(&path).is_ok() { break; }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}
