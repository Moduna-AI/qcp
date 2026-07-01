use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            submit_prompt,
            approve_prompt,
            get_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running qcp desktop app");
}

#[tauri::command]
async fn submit_prompt(
    app: AppHandle,
    prompt: String,
    session_id: Option<String>,
) -> Result<Value, String> {
    run_desktop_command(
        app,
        json!({
            "command": "submitPrompt",
            "request": {
                "prompt": prompt,
                "sessionId": session_id,
            },
        }),
    )
    .await
}

#[tauri::command]
async fn approve_prompt(
    app: AppHandle,
    original_prompt: String,
    approved_sql: String,
    approved_request_id: String,
    session_id: Option<String>,
) -> Result<Value, String> {
    run_desktop_command(
        app,
        json!({
            "command": "approvePrompt",
            "request": {
                "originalPrompt": original_prompt,
                "approvedSql": approved_sql,
                "approvedRequestId": approved_request_id,
                "sessionId": session_id,
            },
        }),
    )
    .await
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Value, String> {
    run_desktop_command(
        app,
        json!({
            "command": "getSettings",
        }),
    )
    .await
}

async fn run_desktop_command(app: AppHandle, request: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_assistant_process(&app, request))
        .await
        .map_err(|err| format!("Assistant bridge task failed: {err}"))?
}

fn run_assistant_process(app: &AppHandle, request: Value) -> Result<Value, String> {
    let request_json = serde_json::to_string(&request)
        .map_err(|err| format!("Failed to serialize assistant request: {err}"))?;

    let process = resolve_assistant_process(app)?;
    let mut command = match process {
        AssistantProcess::Sidecar(path) => {
            let mut command = Command::new(path);
            command.env("QCP_DESKTOP_RUNTIME_MODE", "sidecar");
            command
        }
        AssistantProcess::BunDev { repo_root } => {
            let mut command = Command::new("bun");
            command
                .args(["run", "src/desktop/assistant-runner.ts"])
                .current_dir(repo_root)
                .env("QCP_DESKTOP_RUNTIME_MODE", "bun");
            command
        }
    };

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Failed to start qcp assistant runtime: {err}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open assistant runtime stdin.".to_string())?;
    stdin
        .write_all(request_json.as_bytes())
        .map_err(|err| format!("Failed to write assistant request: {err}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|err| format!("Failed to read assistant response: {err}"))?;
    let stdout = String::from_utf8(output.stdout)
        .map_err(|err| format!("Assistant response was not valid UTF-8: {err}"))?;

    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Assistant runtime returned no response. {}",
            stderr.trim()
        ));
    }

    let response = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "Assistant runtime returned no JSON response.".to_string())?;

    serde_json::from_str(response)
        .map_err(|err| format!("Failed to parse assistant response: {err}"))
}

enum AssistantProcess {
    Sidecar(PathBuf),
    BunDev { repo_root: PathBuf },
}

fn resolve_assistant_process(app: &AppHandle) -> Result<AssistantProcess, String> {
    if let Some(path) = std::env::var_os("QCP_DESKTOP_ASSISTANT_BIN") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Ok(AssistantProcess::Sidecar(candidate));
        }
    }

    for candidate in bundled_sidecar_candidates(app) {
        if candidate.exists() {
            return Ok(AssistantProcess::Sidecar(candidate));
        }
    }

    let repo_root = resolve_repo_root()?;
    if repo_root
        .join("src")
        .join("desktop")
        .join("assistant-runner.ts")
        .exists()
    {
        return Ok(AssistantProcess::BunDev { repo_root });
    }

    Err("Packaged qcp assistant sidecar was not found.".to_string())
}

fn bundled_sidecar_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let names = sidecar_names();

    if let Ok(resource_dir) = app.path().resource_dir() {
        for name in &names {
            candidates.push(resource_dir.join(name));
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            for name in &names {
                candidates.push(exe_dir.join(name));
                candidates.push(exe_dir.join("resources").join(name));
                candidates.push(exe_dir.join("../Resources").join(name));
            }
        }
    }

    candidates
}

fn sidecar_names() -> Vec<String> {
    let executable_suffix = if cfg!(windows) { ".exe" } else { "" };
    vec![
        format!("qcp-assistant{executable_suffix}"),
        format!("qcp-assistant-{}{executable_suffix}", target_triple()),
    ]
}

fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        "unknown"
    }
}

fn resolve_repo_root() -> Result<PathBuf, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "Failed to resolve qcp repository root.".to_string())
}
