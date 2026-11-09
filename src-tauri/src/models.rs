use super::{local, target, verify, Desktop};
use serde_json::Value;
use std::process::{Command, Stdio};
use tauri::{State, WebviewWindow};

fn available(state: &Desktop) -> Result<(), String> {
    let runtime = state.runtime.lock().unwrap();
    if runtime.starting || runtime.updating || runtime.child.is_some() || runtime.closing { return Err("Choose your model before starting the assistant".into()); }
    Ok(())
}
fn run(state: &Desktop, action: &str, path: Option<String>) -> Result<Value, String> {
    let (platform, executable) = target()?;
    let node = format!("bin/{platform}/{executable}");
    for file in [node.as_str(), "app/stick-models.cjs"] { verify(&state.root, file).map_err(|_| "This copy needs an app update to manage Max models")?; }
    let mut command = Command::new(state.root.join(node));
    command.arg(state.root.join("app/stick-models.cjs")).arg("--root").arg(&state.root).arg(action);
    if let Some(path) = path { command.arg(path); }
    command.current_dir(&state.root).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    for name in ["PATH", "Path", "SystemRoot", "ComSpec", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let output = command.output().map_err(|_| "The model selection could not be read")?;
    if output.stdout.len() > 20000 { return Err("Invalid model selection result".into()); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "The model selection could not be read")?;
    if !output.status.success() { return Err(value["error"].as_str().unwrap_or("The Max model could not be linked").into()); }
    Ok(value)
}
#[tauri::command]
pub async fn local_model_status(window: WebviewWindow, state: State<'_, Desktop>) -> Result<Value, String> {
    local(&window)?; let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run(&owned, "--status", None)).await.map_err(|_| "Model selection unavailable")?
}
#[tauri::command]
pub async fn link_max_model(window: WebviewWindow, state: State<'_, Desktop>, path: String) -> Result<Value, String> {
    local(&window)?; available(&state)?; let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run(&owned, "--link", Some(path))).await.map_err(|_| "Model selection unavailable")?
}
#[tauri::command]
pub async fn unlink_max_model(window: WebviewWindow, state: State<'_, Desktop>) -> Result<Value, String> {
    local(&window)?; available(&state)?; let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run(&owned, "--unlink", None)).await.map_err(|_| "Model selection unavailable")?
}
#[tauri::command]
pub async fn choose_max_model(window: WebviewWindow, state: State<'_, Desktop>) -> Result<Option<String>, String> {
    local(&window)?; available(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = { let mut value = Command::new("/usr/bin/osascript"); value.args(["-e", "POSIX path of (choose file with prompt \"Choose your Stellan-1 Max GGUF\")"]); value };
        #[cfg(target_os = "windows")]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let system = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into());
            let mut value = Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
            value.args(["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='GGUF models (*.gguf)|*.gguf'; $d.Multiselect=$false; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.FileName)}"]); value.creation_flags(0x08000000); value
        };
        #[cfg(target_os = "linux")]
        let mut command = { let mut value = Command::new("zenity"); value.args(["--file-selection", "--title=Choose your Stellan-1 Max GGUF", "--file-filter=GGUF models | *.gguf"]); value };
        let output = command.stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|_| "The file chooser is unavailable. Paste the full GGUF path below instead.")?;
        if !output.status.success() || output.stdout.is_empty() { return Ok(None); }
        let path = String::from_utf8(output.stdout).map_err(|_| "The file path could not be read")?;
        Ok(Some(path.trim_end_matches(['\r', '\n']).trim_start_matches('\u{feff}').to_string()))
    }).await.map_err(|_| "The file chooser is unavailable")?
}
