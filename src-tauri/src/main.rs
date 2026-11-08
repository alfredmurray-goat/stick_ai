#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, State, WebviewUrl, WebviewWindow};

#[derive(Default)]
struct Runtime {
    child: Option<Child>,
    input: Option<ChildStdin>,
    status: Value,
    url: Option<String>,
    starting: bool,
    cancelled: bool,
    idle_failures: u32,
    generation: u64,
    model_pid: Option<u32>,
    closing: bool,
}

#[derive(Clone)]
struct Desktop {
    runtime: Arc<Mutex<Runtime>>,
    root: PathBuf,
    logs: PathBuf,
    temporary: PathBuf,
}

fn local(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "unavailable")?;
    if url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")) {
        return Ok(());
    }
    Err("unavailable".into())
}

fn log(state: &Desktop, detail: impl AsRef<str>) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(state.logs.join("desktop.log")) {
        let _ = writeln!(file, "{}", detail.as_ref());
    }
}

fn verify(root: &Path, relative: &str) -> Result<(), Box<dyn std::error::Error>> {
    let manifest: Value = serde_json::from_reader(File::open(root.join("manifest.json"))?)?;
    let files = manifest.get("files").and_then(Value::as_array).ok_or("invalid manifest")?;
    let record = files.iter().find(|value| value.get("path").and_then(Value::as_str) == Some(relative)).ok_or("missing manifest entry")?;
    let path = root.join(relative);
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(root.canonicalize()?) || fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err("unsafe bootstrap path".into());
    }
    let mut file = File::open(path)?;
    if file.metadata()?.len() != record.get("size").and_then(Value::as_u64).ok_or("missing size")? {
        return Err("size mismatch".into());
    }
    let mut hash = Sha256::new();
    let mut bytes = [0_u8; 65536];
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 { break; }
        hash.update(&bytes[..count]);
    }
    if format!("{:x}", hash.finalize()) != record.get("sha256").and_then(Value::as_str).ok_or("missing hash")? {
        return Err("hash mismatch".into());
    }
    Ok(())
}

fn target() -> Result<(&'static str, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok(("macos-arm64", "node")),
        ("macos", "x86_64") => Ok(("macos-x64", "node")),
        ("windows", "x86_64") => Ok(("windows-x64", "node.exe")),
        ("linux", "x86_64") => Ok(("linux-x64", "node")),
        _ => Err("unsupported computer".into())
    }
}

fn stop(state: &Desktop) {
    let (mut child, model_pid) = {
        let mut runtime = state.runtime.lock().unwrap();
        runtime.cancelled = true;
        if let Some(input) = runtime.input.as_mut() { let _ = writeln!(input, "stop"); }
        runtime.input.take();
        (runtime.child.take(), runtime.model_pid.take())
    };
    if let Some(child) = child.as_mut() {
        let started = Instant::now();
        loop {
            if child.try_wait().ok().flatten().is_some() { break; }
            if started.elapsed() >= Duration::from_secs(30) {
                log(state, "Background service did not stop within the cleanup grace period");
                if let Some(pid) = model_pid {
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
                        let mut kill = Command::new(system.join("System32").join("taskkill.exe"));
                        let _ = kill.args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
                    }
                    #[cfg(not(target_os = "windows"))]
                    { let _ = Command::new("/bin/kill").args(["-KILL", "--", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
                }
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[tauri::command]
fn desktop_status(window: WebviewWindow, state: State<'_, Desktop>) -> Result<Value, String> {
    local(&window)?;
    Ok(state.runtime.lock().unwrap().status.clone())
}

#[tauri::command]
async fn cancel_start(window: WebviewWindow, state: State<'_, Desktop>) -> Result<(), String> {
    local(&window)?;
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop(&owned);
        owned.runtime.lock().unwrap().status = json!({"running": false, "error": {"message": "This step was stopped", "action": "OK"}});
    }).await.map_err(|_| "unavailable")?;
    Ok(())
}

#[tauri::command]
async fn start_assistant(window: WebviewWindow, state: State<'_, Desktop>, faster: bool) -> Result<String, String> {
    local(&window)?;
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start(&owned, faster)).await.map_err(|_| "unavailable")?
}

fn start(state: &Desktop, faster: bool) -> Result<String, String> {
    {
        let mut runtime = state.runtime.lock().unwrap();
        if runtime.starting { return Err("unavailable".into()); }
        runtime.starting = true; runtime.generation += 1;
    }
    stop(state);
    {
        let mut runtime = state.runtime.lock().unwrap();
        runtime.cancelled = false;
        runtime.url = None;
        runtime.status = json!({"running": true, "message": "Starting your private assistant..."});
    }
    let result = spawn_service(state, faster);
    if let Err(detail) = &result {
        log(state, detail);
        let mut runtime = state.runtime.lock().unwrap();
        if runtime.status.get("error").is_none() {
            runtime.status = json!({"running": false, "error": {"message": "The assistant could not start. Check that the USB stick is connected.", "action": "Retry"}});
        }
    }
    state.runtime.lock().unwrap().starting = false;
    result
}

fn spawn_service(state: &Desktop, faster: bool) -> Result<String, String> {
    let (platform, executable) = target()?;
    let relative = format!("bin/{platform}/{executable}");
    for file in [relative.as_str(), "app/launcher.cjs"] {
        verify(&state.root, file).map_err(|error| format!("Bootstrap verification: {error}"))?;
    }
    let stderr = OpenOptions::new().create(true).append(true).open(state.logs.join("service.log")).map_err(|error| error.to_string())?;
    let mut command = Command::new(state.root.join(relative));
    command.arg(state.root.join("app/launcher.cjs")).arg("--root").arg(&state.root).arg("--desktop").arg("--log-dir").arg(&state.logs);
    if faster { command.arg("--faster"); }
    command.current_dir(&state.root).env_clear();
    for name in ["PATH", "Path", "SystemRoot", "ComSpec", "STICK_IDLE_TIMEOUT_SECONDS", "STICK_CONTEXT_MAX_BYTES"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    for name in ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] { command.env(name, &state.temporary); }

    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(stderr);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if state.runtime.lock().unwrap().cancelled { return Err("cancelled".into()); }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("missing control stream")?;
    {
        let mut runtime = state.runtime.lock().unwrap();
        if runtime.cancelled { let _ = child.kill(); let _ = child.wait(); return Err("cancelled".into()); }
        runtime.input = child.stdin.take();
        runtime.child = Some(child);
    }
    let shared = state.clone();
    let generation = state.runtime.lock().unwrap().generation;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break; };
            let Ok(event) = serde_json::from_str::<Value>(&line) else { log(&shared, line); continue; };
            let mut runtime = shared.runtime.lock().unwrap();
            if runtime.generation != generation { break; }
            match event.get("kind").and_then(Value::as_str) {
                Some("progress") => { runtime.status["message"] = event["text"].clone(); }
                Some("model_pid") => { runtime.model_pid = event["pid"].as_u64().map(|value| value as u32); }
                Some("ready") => { runtime.url = event["url"].as_str().map(String::from); runtime.idle_failures = 0; }
                Some("error") => {
                    let mut error = event["error"].clone();
                    if error["kind"] == "idle" {
                        runtime.idle_failures += 1;
                        if runtime.idle_failures >= 2 {
                            error["action"] = json!("Switch to a faster setting");
                            error["explanation"] = json!("Use Lite with a shorter memory of the conversation, without switching to the larger coding model.");
                        }
                    }
                    if error["kind"] != "idle" { runtime.idle_failures = 0; }
                    runtime.status = json!({"running": false, "error": error});
                }
                Some("stopped") => { runtime.status["running"] = json!(false); }
                _ => {}
            }
        }
        let mut runtime = shared.runtime.lock().unwrap();
        if runtime.generation == generation { runtime.status["running"] = json!(false); }
    });
    loop {
        {
            let runtime = state.runtime.lock().unwrap();
            if runtime.cancelled { return Err("cancelled".into()); }
            if let Some(url) = runtime.url.clone() {
                let parsed = tauri::Url::parse(&url).map_err(|_| "invalid service address")?;
                if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") || parsed.fragment().map(str::len) != Some(64) {
                    return Err("invalid service address".into());
                }
                return Ok(url);
            }
            if runtime.status.get("error").is_some() || runtime.status["running"] == false { return Err("service stopped".into()); }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn main() {
    if std::env::args().any(|argument| argument == "--dry-run") {
        println!("Show welcome; verify hashes; check RAM; start hidden Lite on loopback; wait for health; show chat; stop owned processes and remove temporary storage on quit.");
        return;
    }
    let data = tempfile::tempdir().expect("Temporary app storage unavailable");
    let data_path = data.path().to_path_buf();
    let app = tauri::Builder::default().setup(move |app| {
        let executable = std::env::current_exe()?;
        let root = executable.ancestors().find(|directory| directory.join("manifest.json").is_file()).unwrap_or(executable.parent().unwrap()).to_path_buf();
        let logs = app.path().app_log_dir()?;
        fs::create_dir_all(&logs)?;
        app.manage(Desktop { runtime: Arc::new(Mutex::new(Runtime::default())), root, logs, temporary: data_path.clone() });
        tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("stick_ai").inner_size(920.0, 740.0).data_directory(data_path).incognito(true)
            .on_navigation({ let runtime = app.state::<Desktop>().runtime.clone(); move |url| {
                if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") { return true; }
                runtime.lock().unwrap().url.as_ref().and_then(|value| tauri::Url::parse(value).ok()).map(|expected| url.origin() == expected.origin()).unwrap_or(false)
            } }).build()?;
        Ok(())
    }).on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let desktop = window.state::<Desktop>().inner().clone();
            {
                let mut runtime = desktop.runtime.lock().unwrap();
                if runtime.closing { return; }
                runtime.closing = true;
            }
            let handle = window.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || { stop(&desktop); handle.exit(0); });
        }
    }).invoke_handler(tauri::generate_handler![start_assistant, desktop_status, cancel_start]).build(tauri::generate_context!()).expect("Desktop app unavailable");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event { stop(&handle.state::<Desktop>()); }
    });
    drop(data);
}
