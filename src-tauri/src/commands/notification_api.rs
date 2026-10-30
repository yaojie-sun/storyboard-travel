//! 广播通知 + 用户反馈的客户端上行命令。
//!
//! 请求通道、设备号、失败口径统一放在 `support_http.rs`（发票模块共用同一套）。
//! 关键约定：这里任何失败都必须**静默** —— 不 emit `login-required`、不清令牌、不打扰用户。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::support_http::call_api;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Announcement {
    pub id: i64,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FeedbackReply {
    pub id: i64,
    pub body: String,
    #[serde(default)]
    pub is_admin: Option<bool>,
    #[serde(default)]
    pub admin_name: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FeedbackThread {
    pub id: i64,
    pub content: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub contact: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub replies: Vec<FeedbackReply>,
}

/// 拉广播通知。**公开接口**，未登录也返回数据。
#[tauri::command]
pub async fn notification_fetch_announcements(
    app: AppHandle,
) -> Result<Vec<Announcement>, String> {
    let data = call_api(&app, "GET", "/jy/api/v1/announcements/feed", None).await?;
    serde_json::from_value::<Vec<Announcement>>(data)
        .map_err(|e| format!("解析通知列表失败: {}", e))
}

/// 提交反馈。登录态可选。
#[tauri::command]
pub async fn notification_submit_feedback(
    app: AppHandle,
    category: String,
    content: String,
    contact: Option<String>,
) -> Result<FeedbackThread, String> {
    let platform = std::env::consts::OS.to_string();
    let app_version = app.package_info().version.to_string();
    let payload = serde_json::json!({
        "category": category,
        "content": content,
        "contact": contact,
        "app_version": app_version,
        "platform": platform,
    });
    let data = call_api(&app, "POST", "/jy/api/v1/feedback/", Some(payload)).await?;
    serde_json::from_value::<FeedbackThread>(data)
        .map_err(|e| format!("解析反馈结果失败: {}", e))
}

/// 我提交过的反馈 + 管理员答复（登录按账号，未登录按设备号）。
#[tauri::command]
pub async fn notification_list_my_feedback(
    app: AppHandle,
) -> Result<Vec<FeedbackThread>, String> {
    let data = call_api(&app, "GET", "/jy/api/v1/feedback/mine", None).await?;
    serde_json::from_value::<Vec<FeedbackThread>>(data)
        .map_err(|e| format!("解析反馈列表失败: {}", e))
}
