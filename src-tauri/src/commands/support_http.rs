//! 旁路功能的共享 HTTP 通道（通知 / 反馈 / 发票）。
//!
//! 与 `banana_api.rs` 的核心请求通道故意分开：
//! 1. 那个文件已远超 1000 行（CLAUDE.md §4.3 强制拆分线）；
//! 2. 失败口径**不同** —— 这里的都是「锦上添花」的旁路功能，失败必须**静默**：
//!    不 emit `login-required`、不清令牌、不打扰用户。核心请求的 401 语义不能复用过来。
//!
//! 未登录也能用：登录用户走 `X-Device-Token` 归属到账号，未登录只看 `X-Device-Id`。

use tauri::{AppHandle, Manager};

pub(crate) const BANANA_API_BASE_URL: &str = "https://aixiaoxi.top";
const DEVICE_ID_FILE: &str = "device_id.txt";

/// 设备标识：首次调用生成 UUID 并存到 `app_data_dir/device_id.txt`。
///
/// ⚠️ 只落在 `app_data_dir` 根目录，**不进 `users/{id}/`** —— 那个目录下的文件禁止删改（§12.4）。
pub(crate) async fn get_device_id(app: &AppHandle) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let path = app_data_dir.join(DEVICE_ID_FILE);

    if let Ok(existing) = tokio::fs::read_to_string(&path).await {
        let trimmed = existing.trim().to_string();
        if trimmed.len() >= 8 {
            return Ok(trimmed);
        }
    }

    tokio::fs::create_dir_all(&app_data_dir)
        .await
        .map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    let id = uuid::Uuid::new_v4().to_string();
    tokio::fs::write(&path, &id)
        .await
        .map_err(|e| format!("写入设备标识失败: {}", e))?;
    Ok(id)
}

pub(crate) fn error_text(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        for key in ["detail", "message", "error"] {
            if let Some(msg) = value.get(key).and_then(|v| v.as_str()) {
                return msg.to_string();
            }
        }
    }
    format!("请求失败 {}: {}", status, body)
}

/// 发一次请求并解出 `data` 字段。**单次尝试、不重试**：轮询本身有周期，
/// 调用里再重试只会放大失败时的等待时间。
pub(crate) async fn call_api(
    app: &AppHandle,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    let url = format!("{}{}", BANANA_API_BASE_URL, path);
    let mut request = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => return Err(format!("不支持的请求方法: {}", method)),
    };

    request = request.header("User-Agent", "Storyboard-ShortVideo/1.0");

    // 设备号始终带；设备令牌有才带（未登录是正常状态，不是错误）
    if let Ok(device_id) = get_device_id(app).await {
        request = request.header("X-Device-Id", device_id);
    }
    let token = {
        let store = crate::commands::banana_api::get_device_token_store();
        let guard = store.lock().await;
        guard.as_ref().map(|t| t.clone())
    };
    if let Some(token) = token {
        request = request.header("X-Device-Token", token);
    }

    if let Some(body_data) = body {
        request = request.json(&body_data);
    }

    let response = request.send().await.map_err(|e| format!("网络请求失败: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(error_text(status, &text));
    }

    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    if value.get("success").and_then(|v| v.as_bool()) == Some(false) {
        let msg = value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("服务端返回失败");
        return Err(msg.to_string());
    }

    Ok(value.get("data").cloned().unwrap_or(serde_json::Value::Null))
}
