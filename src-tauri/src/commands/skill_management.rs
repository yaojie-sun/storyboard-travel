use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::commands::banana_api;

// 重新定义常量，使其公开可用
pub const BANANA_API_BASE_URL: &str = "https://aixiaoxi.top";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SkillFileInfo {
    pub exists: bool,
    pub filename: String,
    pub size: u64,
    pub last_modified: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SkillFileUploadResponse {
    pub filename: String,
    pub size: usize,
    pub message: String,
    pub file_path: String,
}

#[tauri::command]
pub async fn upload_skill_file(
    file_data: Vec<u8>,
    file_name: String,
    _app_handle: tauri::AppHandle,
) -> Result<SkillFileUploadResponse, String> {
    // 验证文件类型
    if !file_name.to_lowercase().ends_with(".md") {
        return Err("只支持上传Markdown文件(.md)".to_string());
    }

    // 验证文件大小（最大5MB）
    if file_data.len() > 5 * 1024 * 1024 {
        return Err("文件大小不能超过5MB".to_string());
    }

    // 获取设备令牌 - 通过banana_api模块获取
    let token_store = banana_api::get_device_token_store();
    let device_token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    // 构造API URL
    let api_url = format!("{}/api/v1/skill/upload-skill", BANANA_API_BASE_URL);

    // 创建multipart表单
    let form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(file_data.clone())
                .file_name(file_name.clone())
                .mime_str("text/markdown")
                .map_err(|e| format!("无法设置MIME类型: {}", e))?,
        );

    // 创建HTTP客户端并发送请求
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120)) // 120秒超时，与之前的图像生成一致
        .build()
        .map_err(|e| format!("无法创建HTTP客户端: {}", e))?;

    let response = client
        .post(&api_url)
        .header("X-Device-Token", &device_token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    // 获取状态码以备后续使用
    let status = response.status();

    if !response.status().is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "无法读取错误响应".to_string());
        return Err(format!("服务器错误 {}: {}", status, error_text));
    }

    let result: SkillFileUploadResponse = response
        .json()
        .await
        .map_err(|e| format!("无法解析服务器响应: {}", e))?;

    Ok(result)
}

#[tauri::command]
pub async fn get_skill_file_info(
    _app_handle: tauri::AppHandle,
) -> Result<SkillFileInfo, String> {
    // 获取设备令牌
    let token_store = banana_api::get_device_token_store();
    let device_token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    // 构造API URL
    let api_url = format!("{}/api/v1/skill/skill-info", BANANA_API_BASE_URL);

    // 创建HTTP客户端并发送请求
    let client = reqwest::Client::new();

    let response = client
        .get(&api_url)
        .header("X-Device-Token", &device_token)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    // 获取状态码以备后续使用
    let status = response.status();

    if !response.status().is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "无法读取错误响应".to_string());
        return Err(format!("服务器错误 {}: {}", status, error_text));
    }

    let result: SkillFileInfo = response
        .json()
        .await
        .map_err(|e| format!("无法解析服务器响应: {}", e))?;

    Ok(result)
}

#[tauri::command]
pub async fn get_skill_file_content(
    _app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // 获取设备令牌
    let token_store = banana_api::get_device_token_store();
    let device_token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    // 构造API URL
    let api_url = format!("{}/api/v1/skill/get-skill-file", BANANA_API_BASE_URL);

    // 创建HTTP客户端并发送请求
    let client = reqwest::Client::new();

    let response = client
        .get(&api_url)
        .header("X-Device-Token", &device_token)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    // 获取状态码以备后续使用
    let status = response.status();

    if !response.status().is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "无法读取错误响应".to_string());
        return Err(format!("服务器错误 {}: {}", status, error_text));
    }

    let content = response
        .text()
        .await
        .map_err(|e| format!("无法读取服务器响应: {}", e))?;

    Ok(content)
}