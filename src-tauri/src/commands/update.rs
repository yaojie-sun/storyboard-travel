use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::Emitter;

const VERSION_CHECK_URL: &str = "https://aixiaoxi.top/jy/uploads/app/version_travel.json";
const GRID_PROMPT_RULES_URL: &str = "https://aixiaoxi.top/jy/uploads/app/grid_prompt_rules_travel.json";
const RULES_BASE: &str = "https://aixiaoxi.top/jy/uploads/app";

#[tauri::command]
pub async fn fetch_grid_prompt_rules() -> Result<String, String> {
    let response = reqwest::get(GRID_PROMPT_RULES_URL)
        .await
        .map_err(|e| format!("failed to fetch grid prompt rules: {e}"))?;
    response.text().await.map_err(|e| format!("failed to read grid prompt rules: {e}"))
}

fn resolve_video_gen_rules_url(model: Option<String>) -> String {
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| crate::commands::banana_api::get_active_video_model()
            .unwrap_or_default());
    let file = match model.as_str() {
        "happyhorse_r2v" | "happyhorse/happyhorse-1.1-r2v" => "video_gen_rules_travel.json",
        "pixverse_c1" | "pixverse/c1" => "video_gen_rules_pixverse_c1.json",
        _ => "video_gen_rules_travel.json",
    };
    let url = format!("{}/{}", RULES_BASE, file);
    tracing::info!("[Rules] model={}, loading {} -> {}", model, file, url);
    url
}

#[tauri::command]
pub async fn fetch_video_gen_rules(model: Option<String>) -> Result<String, String> {
    let url = resolve_video_gen_rules_url(model);
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("failed to fetch video gen rules: {e}"))?;
    response.text().await.map_err(|e| format!("failed to read video gen rules: {e}"))
}

#[derive(Debug, Deserialize)]
struct VersionInfo {
    version: String,
    #[serde(rename = "releaseDate")]
    release_date: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeCheckResult {
    pub has_update: bool,
    pub latest_version: String,
    pub current_version: String,
    pub download_url: String,
    pub notes: String,
}

fn installer_name(version: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("Storyboard-Travel_{}_x64-setup.exe", version)
    }
    #[cfg(target_os = "macos")]
    {
        format!("Storyboard-Travel_{}_universal.dmg", version)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = version;
        String::new()
    }
}

fn normalize_version(value: &str) -> String {
    value.trim().trim_start_matches(['v', 'V']).to_string()
}

fn parse_version_parts(version: &str) -> Vec<u32> {
    let normalized = normalize_version(version);
    let core = normalized.split('-').next().unwrap_or("");
    core.split('.')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = parse_version_parts(left);
    let right_parts = parse_version_parts(right);
    let max_len = left_parts.len().max(right_parts.len());

    for i in 0..max_len {
        let l = left_parts.get(i).copied().unwrap_or(0);
        let r = right_parts.get(i).copied().unwrap_or(0);
        match l.cmp(&r) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

#[tauri::command]
pub async fn check_for_upgrade(app_version: String) -> Result<UpgradeCheckResult, String> {
    // Prefer Rust compile-time version over frontend-provided version
    let current = if app_version.is_empty() || app_version == "0.0.0" {
        normalize_version(env!("CARGO_PKG_VERSION"))
    } else {
        normalize_version(&app_version)
    };
    tracing::info!("[Upgrade] frontend_app_version={}, effective_current={}", app_version, current);

    let response = reqwest::get(VERSION_CHECK_URL)
        .await
        .map_err(|e| format!("failed to fetch version info: {e}"))?;

    let version_info = response
        .json::<VersionInfo>()
        .await
        .map_err(|e| format!("failed to parse version info: {e}"))?;

    let latest = normalize_version(&version_info.version);

    let base_url = version_info.download_url.trim_end_matches('/').to_string();
    let download_url = format!("{}/{}", base_url, installer_name(&latest));

    let has_update = compare_versions(&latest, &current) == std::cmp::Ordering::Greater;

    Ok(UpgradeCheckResult {
        has_update,
        latest_version: latest,
        current_version: current,
        download_url,
        notes: version_info.notes,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percentage: f64,
}

#[tauri::command]
pub async fn download_upgrade(
    app: tauri::AppHandle,
    download_url: String,
    version: String,
) -> Result<String, String> {
    let tmp_dir = std::env::temp_dir().join("storyboard-upgrade");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;

    let filename = installer_name(&normalize_version(&version));
    let file_path = tmp_dir.join(&filename);
    let path_str = file_path.to_string_lossy().to_string();

    tracing::info!("[Upgrade] 开始下载 {} -> {}", download_url, path_str);

    let response = reqwest::get(&download_url)
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    let total_bytes = response.content_length().unwrap_or(0);
    let mut downloaded_bytes: u64 = 0;
    let mut file = std::fs::File::create(&file_path).map_err(|e| format!("创建文件失败: {e}"))?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载数据失败: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("写入文件失败: {e}"))?;
        downloaded_bytes += chunk.len() as u64;
        if total_bytes > 0 {
            let progress = DownloadProgress {
                downloaded_bytes,
                total_bytes,
                percentage: (downloaded_bytes as f64 / total_bytes as f64) * 100.0,
            };
            let _ = app.emit("download-progress", progress);
        }
    }
    file.sync_all().map_err(|e| format!("刷新文件失败: {e}"))?;

    // Verify downloaded size matches expected
    let actual_size = std::fs::metadata(&file_path).map_err(|e| format!("读取文件信息失败: {e}"))?.len();
    if total_bytes > 0 && actual_size != total_bytes {
        std::fs::remove_file(&file_path).ok();
        return Err(format!("文件校验失败：期望 {} bytes，实际 {} bytes", total_bytes, actual_size));
    }

    tracing::info!("[Upgrade] 下载完成: {} ({} bytes)", path_str, downloaded_bytes);
    Ok(path_str)
}

#[tauri::command]
pub async fn launch_installer(file_path: String) -> Result<(), String> {
    tracing::info!("[Upgrade] 启动安装程序: {}", file_path);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&file_path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {e}"))?;
    }

    // Give the installer a moment to start, then exit the current app
    std::process::exit(0);
}
