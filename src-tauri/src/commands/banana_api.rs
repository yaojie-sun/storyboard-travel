use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tracing::{info, warn};
use reqwest;

/// 已退费的任务 ID 集合，防止同一任务重复退费
static REFUNDED_TASK_IDS: std::sync::LazyLock<Arc<Mutex<HashSet<String>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashSet::new())));

/// 视频轮询连续错误计数（task_id → 连续错误次数），>= 5 触发退费
static VIDEO_POLL_ERROR_COUNT: std::sync::LazyLock<Arc<Mutex<HashMap<String, u32>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

// 设备令牌存储
static DEVICE_TOKEN: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();

// 服务端下发的第三方 API 密钥（不在 provider 体系内）
static DEEPSEEK_CHAT_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static QINIU_ACCESS_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static QINIU_SECRET_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static QINIU_BUCKET: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static QINIU_DOMAIN: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static ACTIVE_VIDEO_MODEL: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static BAIDU_VIDEO_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static BAIDU_ACCESS_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static BAIDU_SECRET_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static KIE_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();
static QIANFAN_VL_KEY: std::sync::OnceLock<Arc<Mutex<Option<String>>>> = std::sync::OnceLock::new();

macro_rules! secret_getter {
    ($name:ident, $static_ref:ident) => {
        pub fn $name() -> Option<String> {
            $static_ref
                .get()
                .and_then(|lock| lock.try_lock().ok())
                .and_then(|guard| guard.clone())
        }
    };
}

secret_getter!(get_deepseek_chat_key, DEEPSEEK_CHAT_KEY);
secret_getter!(get_qiniu_access_key, QINIU_ACCESS_KEY);
secret_getter!(get_qiniu_secret_key, QINIU_SECRET_KEY);
secret_getter!(get_qiniu_bucket, QINIU_BUCKET);
secret_getter!(get_qiniu_domain, QINIU_DOMAIN);
secret_getter!(get_active_video_model, ACTIVE_VIDEO_MODEL);
secret_getter!(get_kie_key, KIE_KEY);
secret_getter!(get_baidu_access_key, BAIDU_ACCESS_KEY);
secret_getter!(get_baidu_secret_key, BAIDU_SECRET_KEY);

macro_rules! secret_setter {
    ($name:ident, $static_ref:ident) => {
        async fn $name(value: String) {
            let lock = $static_ref.get_or_init(|| Arc::new(Mutex::new(None)));
            let mut guard = lock.lock().await;
            *guard = Some(value);
        }
    };
}

secret_setter!(set_deepseek_chat_key, DEEPSEEK_CHAT_KEY);
secret_setter!(set_qiniu_access_key, QINIU_ACCESS_KEY);
secret_setter!(set_qiniu_secret_key, QINIU_SECRET_KEY);
secret_setter!(set_qiniu_bucket, QINIU_BUCKET);
secret_setter!(set_qiniu_domain, QINIU_DOMAIN);
secret_setter!(set_active_video_model, ACTIVE_VIDEO_MODEL);
secret_setter!(set_kie_key, KIE_KEY);
secret_setter!(set_baidu_video_key, BAIDU_VIDEO_KEY);
secret_setter!(set_baidu_access_key, BAIDU_ACCESS_KEY);
secret_setter!(set_baidu_secret_key, BAIDU_SECRET_KEY);
secret_getter!(get_baidu_video_key, BAIDU_VIDEO_KEY);
secret_setter!(set_qianfan_vl_key, QIANFAN_VL_KEY);
secret_getter!(get_qianfan_vl_key, QIANFAN_VL_KEY);

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: Option<String>,
    pub email: Option<String>,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}

// 服务器响应结构体 - 实际登录/注册响应格式
#[derive(Debug, Serialize, Deserialize)]
pub struct ServerUser {
    pub id: String, // UUID字符串
    pub username: String,
    pub email: String,
    #[serde(rename = "planType")]
    pub plan_type: Option<String>,
    #[serde(rename = "monthlyCredits")]
    pub monthly_credits: Option<i32>,
    #[serde(rename = "remainingCredits")]
    pub remaining_credits: Option<i32>,
    #[serde(rename = "welcomeBonus")]
    pub welcome_bonus: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ServerLoginResponse {
    pub token: String,
    pub user: ServerUser,
}

// 实际API登录响应格式
#[derive(Debug, Serialize, Deserialize)]
pub struct ActualLoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub device_token: String,
    pub user_id: i32,
    pub username: String,
    pub email: String,
    pub credits: i32,
    #[serde(default)]
    pub needs_activation: bool,
}

// 实际API用户信息响应格式
#[derive(Debug, Serialize, Deserialize)]
pub struct ActualUserInfoResponse {
    pub user_id: i32,
    pub username: String,
    pub email: String,
    pub is_active: bool,
    pub is_account_active: bool,
    pub credits: i32,
}

// 服务器用户信息响应

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub device_token: String,
    pub user_id: i32,
    pub email: String,
    pub username: String,
    pub credits: i32,
    /// 新用户注册后 API 配置尚未就绪，需要前端引导用户激活
    #[serde(default)]
    pub needs_activation: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfoResponse {
    pub user_id: i32,
    pub username: String,
    pub email: String,
    pub is_active: bool,
    pub is_account_active: bool,
    pub credits: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub message: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreditsInfo {
    pub credits: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiKeyResponse {
    pub success: bool,
    pub api_key: String,
    pub user_id: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiConfig {
    pub id: i32,
    pub api_name: String,
    pub api_type: String,
    pub api_url: String,
    pub api_key: String,
    pub curl_template: Option<String>,
    pub is_active: bool,
    pub supports_image_generation: bool,
    pub supports_reference_image: bool,
    pub default_image_width: i32,
    pub default_image_height: i32,
    pub max_image_size: i32,
    pub image_quality: String,
    pub additional_params: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaymentOrder {
    pub order_id: String,
    pub payment_url: String,
    pub qr_code: Option<String>,
    pub amount: f64,
    pub credits: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaymentStatus {
    pub order_id: String,
    pub status: String,
    pub paid: bool,
    pub paid_at: Option<String>,
}

// Banana API 配置
const BANANA_API_BASE_URL: &str = "https://aixiaoxi.top";

// 获取设备令牌存储
pub fn get_device_token_store() -> &'static Arc<Mutex<Option<String>>> {
    DEVICE_TOKEN.get_or_init(|| Arc::new(Mutex::new(None)))
}

// 从本地存储加载设备令牌
async fn load_device_token_from_storage(app: &AppHandle) -> Option<String> {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            warn!("Failed to get app data dir: {}", e);
            return None;
        }
    };

    let token_file = app_data_dir.join("banana_device_token.txt");
    match tokio::fs::read_to_string(&token_file).await {
        Ok(token) => {
            let token = token.trim().to_string();
            if token.is_empty() {
                None
            } else {
                info!("Loaded device token from storage");
                Some(token)
            }
        }
        Err(_) => None,
    }
}

// 保存设备令牌到本地存储
async fn save_device_token_to_storage(app: &AppHandle, token: &str) -> Result<(), String> {
    eprintln!("[DEBUG] save_device_token_to_storage开始，token长度: {}", token.len());
    info!("开始获取应用数据目录");
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            let err_msg = format!("Failed to get app data dir: {}", e);
            eprintln!("[ERROR] {}", err_msg);
            err_msg
        })?;
    eprintln!("[DEBUG] 应用数据目录: {:?}", app_data_dir);
    info!("应用数据目录: {:?}", app_data_dir);

    info!("开始创建目录");
    tokio::fs::create_dir_all(&app_data_dir)
        .await
        .map_err(|e| {
            let err_msg = format!("Failed to create app data dir: {}", e);
            eprintln!("[ERROR] {}", err_msg);
            err_msg
        })?;
    eprintln!("[DEBUG] 目录创建完成");
    info!("目录创建完成");

    let token_file = app_data_dir.join("banana_device_token.txt");
    eprintln!("[DEBUG] 令牌文件路径: {:?}", token_file);
    info!("开始写入令牌文件: {:?}", token_file);
    tokio::fs::write(&token_file, token)
        .await
        .map_err(|e| {
            let err_msg = format!("Failed to write token file: {}", e);
            eprintln!("[ERROR] {}", err_msg);
            err_msg
        })?;
    eprintln!("[DEBUG] 令牌文件写入完成");
    info!("令牌文件写入完成");

    eprintln!("[DEBUG] 设备令牌已保存到本地存储");
    info!("设备令牌已保存到本地存储");
    Ok(())
}

// 删除设备令牌
async fn delete_device_token_from_storage(app: &AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let token_file = app_data_dir.join("banana_device_token.txt");
    match tokio::fs::metadata(&token_file).await {
        Ok(_) => {
            tokio::fs::remove_file(&token_file)
                .await
                .map_err(|e| format!("Failed to remove token file: {}", e))?;
            info!("Deleted device token from storage");
        }
        Err(_) => {
            info!("令牌文件不存在，无需删除");
        }
    }
    Ok(())
}

// 发送HTTP请求到Banana API
async fn send_banana_api_request<T: for<'de> Deserialize<'de>>(
    method: &str,
    endpoint: &str,
    body: Option<serde_json::Value>,
    requires_auth: bool,
    app: Option<AppHandle>,
) -> Result<T, String> {
    info!("send_banana_api_request开始: {} {}, requires_auth: {}", method, endpoint, requires_auth);

    // 尝试创建客户端，如果有问题则延迟重试
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build() {
            Ok(c) => c,
            Err(e) => {
                info!("第一次创建客户端失败，等待后重试: {}", e);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                reqwest::Client::builder()
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .timeout(std::time::Duration::from_secs(60))
                    .build()
                    .map_err(|e2| format!("创建HTTP客户端失败: {}", e2))?
            }
        };

    let url = format!("{}{}", BANANA_API_BASE_URL, endpoint);
    info!("发送Banana API请求: {} {}", method, url);

    // 根据HTTP方法构建请求
    let mut request_builder = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    // 添加设备令牌头（如果可用且需要认证）
    if requires_auth {
        let token_store = get_device_token_store();
        let token = {
            let token_guard = token_store.lock().await;
            token_guard.as_ref().map(|t| t.clone())
        };

        if let Some(token) = token {
            info!("使用设备令牌: {}...", &token[0..16]);
            request_builder = request_builder.header("X-Device-Token", token);
        } else {
            return Err("设备令牌未找到，请先登录".to_string());
        }
    }

    // 添加User-Agent头
    request_builder = request_builder.header("User-Agent", "Storyboard-Travel/1.0");

    // 添加JSON body
    if let Some(body_data) = &body {
        info!("请求体: {}", serde_json::to_string(body_data).unwrap_or_else(|_| "无法序列化".to_string()));
        request_builder = request_builder.json(body_data);
    }

    // 发送请求 - 避免使用可能导致builder error的额外设置
    let response = match request_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            info!("第一次请求失败，等待后重试: {}", e);
            // 等待片刻后重试
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

            // 重新创建客户端并重试
            let retry_client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|e2| format!("重试创建HTTP客户端失败: {}", e2))?;
            let mut retry_request_builder = match method {
                "GET" => retry_client.get(&url),
                "POST" => retry_client.post(&url),
                "PUT" => retry_client.put(&url),
                "DELETE" => retry_client.delete(&url),
                _ => return Err(format!("Unsupported HTTP method: {}", method)),
            };

            // 重新添加认证和头部
            if requires_auth {
                let token_store = get_device_token_store();
                let token = {
                    let token_guard = token_store.lock().await;
                    token_guard.as_ref().map(|t| t.clone())
                };

                if let Some(token) = token {
                    retry_request_builder = retry_request_builder.header("X-Device-Token", token);
                } else {
                    return Err("设备令牌未找到，请先登录".to_string());
                }
            }

            retry_request_builder = retry_request_builder.header("User-Agent", "Storyboard-Travel/1.0");

            if let Some(body_data) = &body {
                retry_request_builder = retry_request_builder.json(body_data);
            }

            retry_request_builder.send().await.map_err(|e| format!("请求失败: {}", e))?
        }
    };

    // 保存状态码
    let status = response.status();
    info!("Banana API响应状态: {}", status);

    // 获取响应文本
    let response_text = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    info!("Banana API响应文本 (前500字符): {}...", if response_text.len() > 500 { &response_text[..500] } else { &response_text });

    // 检查响应状态
    if !status.is_success() {
        // 如果状态码是401未授权，发射登录要求事件
        if status.as_u16() == 401 {
            if let Some(app_handle) = &app {
                // 异步发射事件，不阻塞错误返回
                let app_clone = app_handle.clone();
                tokio::spawn(async move {
                    let _ = app_clone.emit("login-required", ());
                    info!("已发射login-required事件（401未授权）");
                });
            }
        }

        // 尝试解析错误JSON
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&response_text) {
            if let Some(detail) = json_value.get("detail").and_then(|v| v.as_str()) {
                return Err(detail.to_string());
            } else if let Some(message) = json_value.get("message").and_then(|v| v.as_str()) {
                return Err(message.to_string());
            } else if let Some(error_msg) = json_value.get("error").and_then(|v| v.as_str()) {
                return Err(error_msg.to_string());
            }
        }
        return Err(format!("API错误 {}: {}", status, response_text));
    }

    // 尝试解析为JSON值
    let json_value: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("解析JSON失败: {}", e))?;
    info!("解析的JSON值: {}", serde_json::to_string(&json_value).unwrap_or_else(|_| "无法序列化".to_string()));

    // 首先检查是否是错误格式
    if let Some(detail) = json_value.get("detail").and_then(|v| v.as_str()) {
        // 这是FastAPI错误格式 {"detail": "..."}
        return Err(detail.to_string());
    } else if let Some(message) = json_value.get("message").and_then(|v| v.as_str()) {
        // 这是其他错误格式 {"message": "..."}
        return Err(message.to_string());
    }

    // 尝试直接解析为目标类型T（例如登录成功返回的直接LoginResponse）
    info!("尝试直接解析为类型T");
    match serde_json::from_value::<T>(json_value.clone()) {
        Ok(data) => {
            info!("直接解析为类型T成功");
            info!("send_banana_api_request成功完成");
            Ok(data)
        },
        Err(e) => {
            info!("直接解析为类型T失败: {}, 尝试ApiResponse格式", e);
            // 如果无法直接解析，检查是否为ApiResponse格式（有success字段）
            if let Some(success) = json_value.get("success").and_then(|v| v.as_bool()) {
                info!("检测到ApiResponse格式，success={}", success);
                // 这是ApiResponse格式
                let api_response: ApiResponse<T> = serde_json::from_value(json_value)
                    .map_err(|e| format!("解析ApiResponse失败: {}", e))?;

                if api_response.success {
                    api_response.data.ok_or_else(|| "响应数据为空".to_string())
                } else {
                    let error_msg = api_response.message.unwrap_or_else(|| "未知错误".to_string());
                    let error_code = api_response.error_code.unwrap_or_else(|| "UNKNOWN".to_string());

                    // 特殊处理余额不足错误
                    if error_code == "INSUFFICIENT_CREDITS" {
                        return Err(format!("INSUFFICIENT_CREDITS: {}", error_msg));
                    }

                    info!("ApiResponse格式返回错误: {}: {}", error_code, error_msg);
                    Err(format!("{}: {}", error_code, error_msg))
                }
            } else {
                // 尝试作为data字段提取（某些API可能返回{"data": ...}但没有success字段）
                info!("尝试检查data字段");
                if let Some(data_value) = json_value.get("data") {
                    info!("找到data字段，尝试解析");
                    match serde_json::from_value(data_value.clone()) {
                        Ok(data) => {
                            info!("从data字段解析成功");
                            Ok(data)
                        }
                        Err(e) => {
                            info!("从data字段解析失败: {}", e);
                            Err(format!("解析data字段失败: {}", e))
                        }
                    }
                } else {
                    info!("未找到success或data字段，响应格式未知");
                    Err(format!("未知的响应格式: {}", response_text))
                }
            }
        }
    }
}

#[tauri::command]
pub async fn banana_register(
    app: AppHandle,
    username: String,
    email: String,
    password: String,
    referral_code: Option<String>,
) -> Result<LoginResponse, String> {
    info!("尝试注册Banana API用户: {}, referral_code: {:?}", username, referral_code);

    let register_req = RegisterRequest {
        username: username.clone(),
        email: email.clone(),
        password: password.clone(),
    };
    let body = serde_json::to_value(register_req).map_err(|e| e.to_string())?;

    // 拼接 referral_code 查询参数
    let endpoint = if let Some(ref code) = referral_code {
        if code.is_empty() {
            "/jy/api/v1/auth/register".to_string()
        } else if code.chars().all(|c| c.is_ascii_alphanumeric()) {
            format!("/jy/api/v1/auth/register?referral_code={}", code)
        } else {
            return Err("referral_code 包含非法字符".to_string());
        }
    } else {
        "/jy/api/v1/auth/register".to_string()
    };

    // 调用注册API
    let _register_response: serde_json::Value = send_banana_api_request(
        "POST",
        &endpoint,
        Some(body),
        false,
        Some(app.clone()),
    ).await?;

    info!("注册成功，尝试自动登录");

    // 注册成功后自动登录 - 使用邮箱而不是用户名
    banana_login(app, email, password).await
}

#[tauri::command]
pub async fn banana_login(
    app: AppHandle,
    username: String,
    password: String,
) -> Result<LoginResponse, String> {
    eprintln!("[DEBUG] banana_login开始，用户名: {}", username);
    info!("尝试登录Banana API: {}", username);

    // 判断输入是邮箱还是用户名
    let login_req = if username.contains('@') {
        info!("检测到邮箱格式登录: {}", username);
        LoginRequest {
            username: None,
            email: Some(username.clone()),
            password: password.clone(),
        }
    } else {
        info!("检测到用户名格式登录: {}", username);
        LoginRequest {
            username: Some(username.clone()),
            email: None,
            password: password.clone(),
        }
    };
    info!("登录请求参数: 输入={}, password_length={}", username, password.len());
    let body = serde_json::to_value(&login_req).map_err(|e| e.to_string())?;
    info!("登录请求体JSON: {}", serde_json::to_string(&body).unwrap_or_else(|_| "无法序列化".to_string()));

    // 调用登录API - 使用自定义解析处理服务器响应格式
    info!("发送登录请求到: {}{}", BANANA_API_BASE_URL, "/jy/api/v1/auth/login");
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    let url = format!("{}{}", BANANA_API_BASE_URL, "/jy/api/v1/auth/login");
    info!("完整登录URL: {}", url);
    let start_time = std::time::Instant::now();
    let response = client
        .post(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败 (URL: {}): {:#?}", url, e))?;

    let status = response.status();
    let response_text = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let elapsed_ms = start_time.elapsed().as_millis();
    info!("登录请求耗时: {}ms", elapsed_ms);
    info!("登录响应状态: {}, 文本: {}", status, response_text);

    if !status.is_success() {
        eprintln!("[ERROR] 登录API返回错误状态: {}, 响应文本: {}", status, response_text);
        // 尝试解析错误消息
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&response_text) {
            if let Some(error_msg) = json_value.get("error").and_then(|v| v.as_str()) {
                eprintln!("[ERROR] 解析到错误消息: {}", error_msg);
                return Err(error_msg.to_string());
            } else if let Some(detail) = json_value.get("detail").and_then(|v| v.as_str()) {
                eprintln!("[ERROR] 解析到detail错误: {}", detail);
                return Err(detail.to_string());
            } else if let Some(message) = json_value.get("message").and_then(|v| v.as_str()) {
                eprintln!("[ERROR] 解析到message错误: {}", message);
                return Err(message.to_string());
            }
        }
        let err_msg = format!("API错误 {}: {}", status, response_text);
        eprintln!("[ERROR] {}", err_msg);
        return Err(err_msg);
    }

    // 尝试解析为实际API响应格式
    let actual_response: Result<ActualLoginResponse, _> = serde_json::from_str(&response_text);
    let (actual_response, token) = match actual_response {
        Ok(resp) => {
            info!("使用新格式解析登录响应成功");
            let token = resp.access_token.clone();
            (resp, token)
        }
        Err(e) => {
            // 如果解析失败，尝试旧格式作为后备
            info!("尝试解析为ActualLoginResponse失败: {}, 尝试旧格式", e);
            // 尝试解析为旧格式
            let server_response: ServerLoginResponse = serde_json::from_str(&response_text)
                .map_err(|e2| format!("解析登录响应失败 (新格式: {}, 旧格式: {})", e, e2))?;

            // 映射旧格式到ActualLoginResponse
            let user = server_response.user;
            let user_id_hash = user.id.chars().fold(0i32, |acc, c| acc.wrapping_add(c as i32));
            let token = server_response.token.clone();
            let resp = ActualLoginResponse {
                access_token: server_response.token.clone(),
                token_type: "Bearer".to_string(),
                device_token: server_response.token,
                user_id: user_id_hash,
                email: user.email,
                username: user.username,
                credits: user.remaining_credits.unwrap_or(0),
                needs_activation: false,
            };
            (resp, token)
        }
    };

    eprintln!("[DEBUG] 登录响应解析成功，使用新格式，user_id: {}, credits: {}", actual_response.user_id, actual_response.credits);
    eprintln!("[DEBUG] 登录响应详细信息: access_token前4位={}, device_token前4位={}, email={}, username={}",
              &actual_response.access_token[0..std::cmp::min(4, actual_response.access_token.len())],
              &actual_response.device_token[0..std::cmp::min(4, actual_response.device_token.len())],
              actual_response.email, actual_response.username);

    // 使用实际API响应构建LoginResponse
    let mut login_response = LoginResponse {
        access_token: token.clone(),
        token_type: actual_response.token_type,
        device_token: actual_response.device_token,
        user_id: actual_response.user_id,
        email: actual_response.email,
        username: actual_response.username,
        credits: actual_response.credits, // 使用实际credits字段
        needs_activation: actual_response.needs_activation,
    };

    info!("登录响应构建完成，user_id: {}, username: {}, email: {}, credits: {}, needs_activation: {}",
          login_response.user_id, login_response.username, login_response.email, login_response.credits, login_response.needs_activation);
    info!("构建的LoginResponse: user_id={}, username={}, email={}, credits={}",
          login_response.user_id, login_response.username, login_response.email, login_response.credits);

    // 保存设备令牌到内存和本地存储
    eprintln!("[DEBUG] 开始保存设备令牌到内存");
    info!("开始保存设备令牌到内存");
    let token_store = get_device_token_store();
    {
        let mut token_guard = token_store.lock().await;
        *token_guard = Some(login_response.device_token.clone());
        eprintln!("[DEBUG] 设备令牌已保存到内存");
        info!("设备令牌已保存到内存");
    }

    // 保存到本地存储
    eprintln!("[DEBUG] 开始保存设备令牌到本地存储");
    info!("开始保存设备令牌到本地存储");
    match save_device_token_to_storage(&app, &login_response.device_token).await {
        Ok(_) => {
            eprintln!("[DEBUG] 设备令牌已保存到本地存储");
            info!("设备令牌已保存到本地存储");
        }
        Err(e) => {
            eprintln!("[WARN] 保存设备令牌到本地存储失败: {}", e);
            warn!("保存设备令牌到本地存储失败: {}", e);
            // 不返回错误，允许登录继续，但令牌不会持久化
        }
    }

    // 确保用户有API令牌（新用户自动创建），必须先于获取API配置
    // 否则新用户获取API配置时服务器端令牌尚未关联，返回空配置导致AI不可用
    let api_key = match ensure_user_api_token(&login_response.device_token).await {
        Ok(token) => {
            info!("用户API令牌就绪");
            token
        }
        Err(e) => {
            warn!("ensure_user_api_token失败: {}，尝试旧版api-key接口", e);
            // 回退到旧版 get_user_api_key + device_token fallback
            tokio::time::timeout(
                std::time::Duration::from_secs(12),
                get_user_api_key(&login_response.device_token),
            )
            .await
            .unwrap_or_else(|_| {
                warn!("获取用户API密钥超时，回退到设备令牌");
                Err("超时".to_string())
            })
            .unwrap_or_else(|e| {
                warn!("获取用户API密钥失败，回退到设备令牌: {}", e);
                login_response.device_token.clone()
            })
        }
    };

    // 登录成功后，自动同步API配置（必须在 ensure_user_api_token 之后）
    // 使用内部函数，不发射 login-required：新用户 token 可能需要短暂生效时间
    info!("登录成功，开始同步API配置...");
    match fetch_active_api_configs(&login_response.device_token).await {
        Ok(api_configs) if !api_configs.is_empty() => {
            info!("获取到 {} 个活动API配置，开始更新本地API密钥", api_configs.len());

            // 更新本地API密钥
            if let Err(update_err) = banana_update_local_api_keys(api_configs).await {
                warn!("更新本地API密钥失败: {}", update_err);
                login_response.needs_activation = true;
            } else {
                info!("本地API密钥更新成功");
            }
        }
        Ok(_) => {
            // 空配置 — 新用户，需要激活
            warn!("API配置为空，新用户账户需要激活");
            login_response.needs_activation = true;
        }
        Err(fetch_err) => {
            warn!("获取活动API配置失败: {}，新用户账户需要激活", fetch_err);
            login_response.needs_activation = true;
        }
    }
    info!("使用API密钥同步登录后置任务（前4位: {}...）", &api_key[..std::cmp::min(4, api_key.len())]);
    if let Err(sync_err) = sync_post_login_tasks(&api_key).await {
        warn!("同步登录后置任务失败: {}", sync_err);
    }

    // 设置当前用户 ID（用于本地数据目录隔离），必须在 sync 线程之前
    crate::sync::set_current_user_id(&login_response.user_id.to_string());

    // 触发跨设备数据同步（独立线程+独立runtime，不阻塞登录）
    let user_id_str = login_response.user_id.to_string();
    let app_bg = app.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .expect("failed to create sync runtime");
        rt.block_on(async {
            if let Err(e) = crate::sync::SyncManager::init(app_bg.clone(), &user_id_str).await {
                warn!("同步管理器初始化失败: {}", e);
            }
        });
    });

    eprintln!("[DEBUG] 登录成功，用户ID: {}，设备令牌: {}...", login_response.user_id, &login_response.device_token[0..16]);
    info!("登录成功，用户ID: {}，设备令牌: {}...", login_response.user_id, &login_response.device_token[0..16]);
    Ok(login_response)
}

#[tauri::command]
pub async fn banana_logout(app: AppHandle) -> Result<(), String> {
    info!("登出Banana API");

    // 清除内存中的令牌
    let token_store = get_device_token_store();
    {
        let mut token_guard = token_store.lock().await;
        *token_guard = None;
    }

    // 删除本地存储的令牌
    delete_device_token_from_storage(&app).await?;

    // 清除当前用户 ID（每个用户有独立子目录，无需清空数据）
    crate::sync::clear_current_user_id();

    // 清除同步管理器状态
    {
        let mut lock = crate::sync::lock_sync_manager();
        *lock = None;
    }

    Ok(())
}

/// 获取 xiaoya-ai-cinema-travel auth_cache.json 路径
fn get_auth_cache_path() -> Result<PathBuf, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .map_err(|_| "无法获取 USERPROFILE 环境变量".to_string())?
    } else {
        std::env::var("HOME")
            .map_err(|_| "无法获取 HOME 环境变量".to_string())?
    };
    Ok(PathBuf::from(home)
        .join(".claude")
        .join("skills")
        .join("xiaoya-ai-cinema-travel")
        .join("auth_cache.json"))
}

/// 下载并解压 xiaoya-ai-cinema-travel skill zip 到 ~/.claude/skills/（仅当目录不存在时）
pub(crate) async fn sync_xiaoya_skill_public(skills_dir: &std::path::Path) {
    sync_xiaoya_skill(skills_dir).await;
}

async fn sync_xiaoya_skill(skills_dir: &std::path::Path) {
    let target_dir = skills_dir.join("xiaoya-ai-cinema-travel");
    let local_version_path = target_dir.join("version.txt");
    let version_url = format!("{}/jy/uploads/install_guide/files/version_travel.txt", BANANA_API_BASE_URL);

    // 版本检查：本地已存在时，对比服务器版本决定是否更新
    if target_dir.exists() && local_version_path.exists() {
        match reqwest::get(&version_url).await {
            Ok(resp) => {
                if let Ok(remote_version) = resp.text().await {
                    if let Ok(local_version) = std::fs::read_to_string(&local_version_path) {
                        if remote_version.trim() == local_version.trim() {
                            return; // 版本一致，跳过
                        }
                        info!("[Skill] 版本更新: 本地={}, 远端={}", local_version.trim(), remote_version.trim());
                    }
                }
            }
            Err(e) => {
                warn!("[Skill] 版本检查失败，沿用缓存: {}", e);
                return;
            }
        }
        // 版本不一致或无法解析，删除旧目录重新下载
        let _ = std::fs::remove_dir_all(&target_dir);
    } else if target_dir.exists() {
        return; // 目录存在但没有 version.txt，保留兼容
    }

    let zip_url = format!("{}/jy/uploads/install_guide/files/xiaoya-ai-cinema-travel.zip", BANANA_API_BASE_URL);

    // 下载 zip
    let response = match reqwest::get(&zip_url).await {
        Ok(r) => r,
        Err(e) => {
            warn!("下载 xiaoya-ai-cinema-travel.zip 失败: {}", e);
            return;
        }
    };
    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            warn!("读取 xiaoya-ai-cinema-travel.zip 失败: {}", e);
            return;
        }
    };

    // 解压到目标目录
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = match zip::ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(e) => {
            warn!("打开 xiaoya-ai-cinema-travel.zip 失败: {}", e);
            return;
        }
    };

    // 检测 zip 内是否有公共根目录前缀（避免嵌套）
    let first_entry = archive.by_index(0).ok().map(|e| e.name().to_string());
    let strip_prefix = first_entry.as_ref().and_then(|name| {
        let slash_pos = name.find('/');
        slash_pos.map(|pos| format!("{}/", &name[..pos]))
    });

    if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
        warn!("创建 xiaoya-ai-cinema-travel 目录失败: {}", e);
        return;
    }

    // 先收集所有条目数据（不能跨 await 持有 ZipFile 引用，它不是 Send）
    let mut entries: Vec<(String, bool, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let entry_name = entry.name().to_string();
        let is_dir = entry.is_dir();

        let data = if is_dir {
            Vec::new()
        } else {
            let mut d = Vec::new();
            if std::io::copy(&mut entry, &mut d).is_err() {
                continue;
            }
            d
        };
        entries.push((entry_name, is_dir, data));
    }
    drop(archive);

    for (entry_name, is_dir, data) in &entries {
        // 去掉公共前缀（避免嵌套目录）
        let relative = match &strip_prefix {
            Some(prefix) if entry_name.starts_with(prefix) => &entry_name[prefix.len()..],
            _ => entry_name,
        };

        if relative.is_empty() {
            continue;
        }

        let out_path = target_dir.join(relative);

        if *is_dir {
            let _ = tokio::fs::create_dir_all(&out_path).await;
        } else {
            if let Some(parent) = out_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(&out_path, data).await;
        }
    }

    info!("已同步 xiaoya-ai-cinema-travel skill 到 {:?}", target_dir);
}

/// 获取用户的真实API密钥（从服务器/api-key端点获取xiaoya_local令牌）
pub(crate) async fn get_user_api_key(device_token: &str) -> Result<String, String> {
    let url = format!("{}{}", BANANA_API_BASE_URL, "/jy/api/v1/auth/api-key");
    info!("获取用户API密钥");

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    let response = client
        .get(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("X-Device-Token", device_token)
        .send()
        .await
        .map_err(|e| format!("获取API密钥请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("获取API密钥失败 ({}): {}", status, text));
    }

    let text = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let api_key_resp: ApiKeyResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析API密钥响应失败: {}", e))?;

    Ok(api_key_resp.api_key)
}

/// 获取 ~/.claude 目录路径
fn get_claude_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let user_profile =
            std::env::var("USERPROFILE").map_err(|_| "无法获取 USERPROFILE 环境变量".to_string())?;
        Ok(PathBuf::from(user_profile).join(".claude"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| "无法获取 HOME 环境变量".to_string())?;
        Ok(PathBuf::from(home).join(".claude"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("不支持的操作系统".to_string())
    }
}

pub(crate) async fn ensure_user_api_token(device_token: &str) -> Result<String, String> {
    info!("检查用户API令牌");

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    // 先检查是否已有令牌
    let list_url = format!("{}/jy/api/v1/api-tokens/", BANANA_API_BASE_URL);
    let resp = client
        .get(&list_url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("X-Device-Token", device_token)
        .send()
        .await
        .map_err(|e| format!("查询API令牌失败: {}", e))?;

    if resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(tokens) = json.get("data").and_then(|v| v.as_array()) {
                if let Some(first) = tokens.first() {
                    if let Some(token) = first.get("token").and_then(|v| v.as_str()) {
                        if !token.is_empty() {
                            info!("找到已有API令牌");
                            return Ok(token.to_string());
                        }
                    }
                }
            }
        }
    }

    // 没有令牌，自动创建
    info!("未找到API令牌，自动创建...");
    let create_body = serde_json::json!({
        "token_type": "api_key",
        "rate_limit_per_minute": 10,
        "rate_limit_per_hour": 100,
        "rate_limit_per_day": 1000
    });
    let create_url = format!("{}/jy/api/v1/api-tokens/", BANANA_API_BASE_URL);
    let create_resp = client
        .post(&create_url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("X-Device-Token", device_token)
        .json(&create_body)
        .send()
        .await
        .map_err(|e| format!("创建API令牌失败: {}", e))?;

    if !create_resp.status().is_success() {
        let status = create_resp.status();
        let text = create_resp.text().await.unwrap_or_default();
        return Err(format!("创建API令牌失败 ({}): {}", status, text));
    }

    let text = create_resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析创建令牌响应失败: {}", e))?;

    if let Some(data) = json.get("data") {
        if let Some(token) = data.get("token").and_then(|v| v.as_str()) {
            if !token.is_empty() {
                info!("API令牌自动创建成功");
                return Ok(token.to_string());
            }
        }
    }

    Err("创建API令牌后未获取到令牌值".to_string())
}

async fn sync_post_login_tasks(api_key: &str) -> Result<(), String> {
    info!("同步登录后置任务");

    // 同步 xiaoya-ai-cinema-travel skill（下载并解压 zip 到 ~/.claude/skills/）
    if let Ok(claude_dir) = get_claude_dir() {
        let skills_dir = claude_dir.join("skills");
        sync_xiaoya_skill(&skills_dir).await;
    }

    // 同步 xiaoya-ai-cinema-travel 的 auth_cache.json
    if let Ok(auth_cache_path) = get_auth_cache_path() {
        if let Ok(auth_content) = tokio::fs::read_to_string(&auth_cache_path).await {
            if let Ok(mut auth_json) = serde_json::from_str::<serde_json::Value>(&auth_content) {
                let encoded = base64::engine::general_purpose::STANDARD.encode(api_key.as_bytes());
                if let Some(obj) = auth_json.as_object_mut() {
                    obj.insert("device_token".to_string(), serde_json::Value::String(encoded));
                    obj.insert("last_sync".to_string(), serde_json::Value::Number(
                        serde_json::Number::from(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs()
                        )
                    ));
                    if let Ok(updated_auth) = serde_json::to_string_pretty(&auth_json) {
                        if let Some(parent) = auth_cache_path.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        let _ = tokio::fs::write(&auth_cache_path, updated_auth).await;
                        info!("已同步 xiaoya-ai-cinema-travel auth_cache.json");
                    }
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn banana_get_current_user(app: AppHandle) -> Result<UserInfoResponse, String> {
    info!("获取当前用户信息");

    // 获取设备令牌
    let token_store = get_device_token_store();
    let token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    // 使用简单的方式构建请求，避免复杂的超时设置导致builder error
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    let url = format!("{}{}", BANANA_API_BASE_URL, "/jy/api/v1/auth/me");
    info!("发送请求到: {}", url);

    let response = client
        .get(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("X-Device-Token", token)
        .send()
        .await
        .map_err(|e| format!("获取用户信息请求失败: {}", e))?;

    let status = response.status();
    let response_text = response.text().await.map_err(|e| format!("读取用户信息响应失败: {}", e))?;
    info!("获取用户信息响应状态: {}, 文本: {}", status, response_text);
    eprintln!("[DEBUG] 用户信息响应原始文本: {}", response_text);

    if !status.is_success() {
        // 如果状态码是401未授权，发射登录要求事件
        if status.as_u16() == 401 {
            // 异步发射事件，不阻塞错误返回
            let app_clone = app.clone();
            tokio::spawn(async move {
                let _ = app_clone.emit("login-required", ());
                info!("已发射login-required事件（401未授权）");
            });
        }

        // 尝试解析错误消息
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&response_text) {
            if let Some(error_msg) = json_value.get("error").and_then(|v| v.as_str()) {
                return Err(error_msg.to_string());
            } else if let Some(detail) = json_value.get("detail").and_then(|v| v.as_str()) {
                return Err(detail.to_string());
            } else if let Some(message) = json_value.get("message").and_then(|v| v.as_str()) {
                return Err(message.to_string());
            }
        }
        return Err(format!("API错误 {}: {}", status, response_text));
    }

    // 尝试解析为实际API响应格式
    let actual_user_info: Result<ActualUserInfoResponse, _> = serde_json::from_str(&response_text);
    let actual_user_info = match actual_user_info {
        Ok(info) => {
            info!("使用新格式解析用户信息成功");
            info
        }
        Err(e) => {
            // 如果解析失败，尝试旧格式作为后备
            info!("尝试解析为ActualUserInfoResponse失败: {}, 尝试旧格式", e);
            // 尝试解析为旧格式
            let server_user: ServerUser = serde_json::from_str(&response_text)
                .map_err(|e2| format!("解析用户信息响应失败 (新格式: {}, 旧格式: {})", e, e2))?;

            // 映射旧格式到ActualUserInfoResponse
            let user_id_hash = server_user.id.chars().fold(0i32, |acc, c| acc.wrapping_add(c as i32));
            ActualUserInfoResponse {
                user_id: user_id_hash,
                username: server_user.username,
                email: server_user.email,
                is_active: true,
                is_account_active: true,
                credits: server_user.remaining_credits.unwrap_or(0),
            }
        }
    };

    eprintln!("[DEBUG] 解析后的用户信息: user_id={}, username={}, credits={}",
              actual_user_info.user_id, actual_user_info.username, actual_user_info.credits);

    // 使用实际API响应构建UserInfoResponse
    let user_response = UserInfoResponse {
        user_id: actual_user_info.user_id,
        username: actual_user_info.username,
        email: actual_user_info.email,
        is_active: actual_user_info.is_active,
        is_account_active: actual_user_info.is_account_active,
        credits: actual_user_info.credits,
    };

    Ok(user_response)
}

#[tauri::command]
pub async fn banana_check_credits(app: AppHandle) -> Result<CreditsInfo, String> {
    info!("检查用户剩余次数");

    // 通过获取用户信息来获取信用数据
    // macOS 上 native-tls 可能不遵守 reqwest 超时，加 tokio 超时兜底
    let user_info = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        banana_get_current_user(app.clone()),
    )
    .await
    .map_err(|_| "积分检查超时".to_string())??;

    let credits_response = CreditsInfo {
        credits: user_info.credits,
    };

    Ok(credits_response)
}

#[tauri::command]
pub async fn banana_create_payment_order(
    app: AppHandle,
    user_id: i32,
    amount: f64,
    credits: i32,
    payment_method: String,
) -> Result<PaymentOrder, String> {
    info!("创建支付订单: user_id={}, {}元 -> {}积分", user_id, amount, credits);

    // Server endpoint expects query params: user_id, amount, credits, payment_method
    let endpoint = format!(
        "/jy/api/v1/payments/create-order?user_id={}&amount={}&credits={}&payment_method={}",
        user_id, amount, credits, payment_method
    );

    #[derive(Debug, serde::Deserialize)]
    struct ServerOrderResponse {
        order_id: String,
        amount: f64,
        credits: i32,
        status: String,
        #[serde(default)]
        payment_id: Option<String>,
        #[serde(default)]
        payment_metadata: Option<serde_json::Value>,
    }

    let order_response: ServerOrderResponse = send_banana_api_request(
        "POST",
        &endpoint,
        None::<serde_json::Value>,
        true,
        Some(app),
    ).await?;

    // Extract payment_url / qr_code from nested payment_metadata
    let (payment_url, qr_code) = if let Some(ref meta) = order_response.payment_metadata {
        let url = meta.get("payment_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let qr = meta.get("qr_code").and_then(|v| v.as_str()).map(|s| s.to_string());
        (url, qr)
    } else {
        (String::new(), None)
    };

    Ok(PaymentOrder {
        order_id: order_response.order_id,
        payment_url,
        qr_code,
        amount: order_response.amount,
        credits: order_response.credits,
    })
}

#[tauri::command]
pub async fn banana_check_payment_status(app: AppHandle, order_id: String) -> Result<PaymentStatus, String> {
    info!("检查支付状态: {}", order_id);

    #[derive(Debug, serde::Deserialize)]
    struct ServerPaymentStatus {
        order_id: String,
        status: String,
        #[serde(default)]
        paid_at: Option<String>,
    }

    let server_status: ServerPaymentStatus = send_banana_api_request(
        "GET",
        &format!("/jy/api/v1/payments/order/{}/status", order_id),
        None::<serde_json::Value>,
        true,
        Some(app),
    ).await?;

    let paid = server_status.status == "paid";
    Ok(PaymentStatus {
        order_id: server_status.order_id,
        status: server_status.status,
        paid,
        paid_at: server_status.paid_at,
    })
}

#[tauri::command]
pub async fn banana_get_credits_per_yuan(app: AppHandle) -> Result<i32, String> {
    info!("获取兑换比例");

    #[derive(Debug, serde::Deserialize)]
    struct SystemConfigResponse {
        success: bool,
        data: Option<SystemConfigData>,
    }
    #[derive(Debug, serde::Deserialize)]
    struct SystemConfigData {
        config_value: String,
    }

    let resp: SystemConfigResponse = send_banana_api_request(
        "GET",
        "/jy/api/v1/system-configs/credits_per_yuan",
        None::<serde_json::Value>,
        true,
        Some(app),
    ).await?;

    if resp.success {
        if let Some(data) = resp.data {
            return Ok(data.config_value.parse::<i32>().unwrap_or(10));
        }
    }
    Ok(10) // 默认10积分/元
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ConsumptionRecord {
    pub id: i64,
    pub credits_consumed: i32,
    pub credits_after: i32,
    pub action_type: String,
    pub detail: Option<String>,
    pub created_at: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ConsumptionHistoryResponse {
    pub records: Vec<ConsumptionRecord>,
    pub total: i64,
    pub page: i32,
    pub limit: i32,
}

#[tauri::command]
pub async fn banana_get_consumption_history(
    app: AppHandle,
    page: i32,
    limit: i32,
) -> Result<ConsumptionHistoryResponse, String> {
    info!("获取积分消费记录 page={} limit={}", page, limit);
    let endpoint = format!("/jy/api/v1/credits/consumption?page={}&limit={}", page, limit);
    send_banana_api_request("GET", &endpoint, None::<serde_json::Value>, true, Some(app)).await
}

/// 将 base64 参考图上传到七牛云，返回下载 URL。
/// HTTP URL 保持不变直接透传。
async fn upload_refs_to_qiniu(reference_images: &[String]) -> Vec<String> {
    let user_id = crate::sync::get_current_user_id().unwrap_or_else(|| "unknown".to_string());

    let mut urls = Vec::with_capacity(reference_images.len());
    for img in reference_images {
        if img.starts_with("data:image") {
            match upload_single_ref_to_qiniu(img, &user_id).await {
                Ok(url) => {
                    info!("[Qiniu] uploaded ref → {}", url);
                    urls.push(url);
                }
                Err(e) => {
                    warn!("[Qiniu] upload failed, fallback to original: {}", e);
                    urls.push(img.clone());
                }
            }
        } else {
            urls.push(img.clone());
        }
    }
    urls
}

/// Upload reference images to Qiniu, supporting both data URLs and local file paths.
/// File paths are read from disk, base64-encoded, then uploaded.
/// Returns only successfully uploaded Qiniu download URLs.
pub(crate) async fn upload_ref_files_to_qiniu(reference_images: &[String]) -> Vec<String> {
    let user_id = crate::sync::get_current_user_id().unwrap_or_else(|| "unknown".to_string());
    let mut urls = Vec::with_capacity(reference_images.len());

    for img in reference_images {
        let data_url = if img.starts_with("data:image") {
            img.clone()
        } else {
            match std::fs::read(img) {
                Ok(bytes) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let ext = std::path::Path::new(img)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("png");
                    let mime = match ext.to_lowercase().as_str() {
                        "jpg" | "jpeg" => "image/jpeg",
                        "webp" => "image/webp",
                        _ => "image/png",
                    };
                    format!("data:{};base64,{}", mime, b64)
                }
                Err(e) => {
                    warn!("[Qiniu] failed to read ref file {}: {}", img, e);
                    continue;
                }
            }
        };

        match upload_single_ref_to_qiniu(&data_url, &user_id).await {
            Ok(url) => {
                info!("[Qiniu] uploaded ref → {}", url);
                urls.push(url);
            }
            Err(e) => {
                warn!("[Qiniu] upload ref failed: {}", e);
            }
        }
    }
    urls
}

async fn upload_single_ref_to_qiniu(data_url: &str, user_id: &str) -> Result<String, String> {
    upload_single_ref_to_qiniu_with_ext(data_url, user_id, "jpg").await
}

async fn upload_single_ref_to_qiniu_with_ext(data_url: &str, user_id: &str, ext: &str) -> Result<String, String> {
    let (_header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "无效 data URL 格式".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let key = format!("xiaoya-ai/users/{}/refs/{}.{}", user_id, uuid::Uuid::new_v4(), ext);

    crate::sync::qiniu::upload(&key, &bytes).await?;

    Ok(crate::sync::qiniu::make_download_url(&key))
}

#[tauri::command]
pub async fn banana_call_image_api(
    app: AppHandle,
    prompt: String,
    model: String,
    size: String,
    aspect_ratio: String,
    reference_images: Option<Vec<String>>,
    extra_params: Option<HashMap<String, serde_json::Value>>,
) -> Result<String, String> {
    info!("调用分镜大师短视频版图像生成API: {}", model);

    // 首先获取设备令牌用于认证
    let token_store = get_device_token_store();
    let device_token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    // 将 base64 参考图上传到七牛云，用 URL 替代 base64
    let qiniu_refs: Option<Vec<String>> = match reference_images.as_deref() {
        Some(refs) if !refs.is_empty() => Some(upload_refs_to_qiniu(refs).await),
        _ => reference_images.clone(),
    };

    // 准备请求数据
    let request_data = serde_json::json!({
        "prompt": prompt,
        "model": model,
        "size": size,  // 直接传递原始size值
        "aspect_ratio": aspect_ratio,
        "reference_images": qiniu_refs,
        "extra_params": extra_params,
    });

    // 实现重试机制以处理首次调用超时问题
    let max_retries = 3;
    let mut attempt = 0;

    loop {
        attempt += 1;
        info!("调用小鸭中台AI图像生成端点 (尝试 #{})", attempt);

        // 为每次尝试创建新的客户端，以避免连接复用问题
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30)) // 进一步增加连接超时时间
            .timeout(std::time::Duration::from_secs(3600)) // 增加到60分钟超时时间，给复杂生成任务更多时间
            .build()
            .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

        let url = format!("{}{}", BANANA_API_BASE_URL, "/jy/api/v1/ai/image");
        info!("调用小鸭中台AI图像生成端点: {}", url);

        match client
            .post(&url)
            .header("X-Device-Token", &device_token)
            .header("User-Agent", "Storyboard-Travel/1.0")
            .header("Content-Type", "application/json")
            .json(&request_data)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                let response_text = match response.text().await {
                    Ok(text) => text,
                    Err(e) => {
                        if attempt < max_retries {
                            warn!("读取响应失败 (尝试 {}): {}, 将重试", attempt, e);
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            continue;
                        } else {
                            return Err(format!("读取响应失败: {}", e));
                        }
                    }
                };

                info!("小鸭中台AI响应: {} - {}", status, response_text);

                if !status.is_success() {
                    // 检查是否是超时错误，如果是则重试
                    if status.as_u16() == 408 && attempt < max_retries {
                        warn!("收到408超时错误 (尝试 {}), 将重试", attempt);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await; // 等待5秒后重试
                        continue;
                    } else if status.as_u16() == 401 {
                        // 如果是401未授权错误，触发登录事件
                        let app_clone = app.clone();
                        tokio::spawn(async move {
                            let _ = app_clone.emit("login-required", ());
                            info!("已发射login-required事件（401未授权）");
                        });
                        return Err(format!("AI图像生成失败 {}: {}", status, response_text));
                    } else {
                        return Err(format!("AI图像生成失败 {}: {}", status, response_text));
                    }
                }

                // 解析响应以获取图像URL
                let response_json: serde_json::Value = match serde_json::from_str(&response_text) {
                    Ok(json) => json,
                    Err(e) => {
                        if attempt < max_retries {
                            warn!("解析AI响应失败 (尝试 {}): {}, 将重试", attempt, e);
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            continue;
                        } else {
                            return Err(format!("解析AI响应失败: {}", e));
                        }
                    }
                };

                // 检查success字段
                if let Some(success) = response_json.get("success").and_then(|v| v.as_bool()) {
                    if !success {
                        // 获取错误信息
                        if let Some(error_msg) = response_json.get("error").and_then(|v| v.as_str()) {
                            // 检查是否是超时相关的错误信息
                            if error_msg.to_lowercase().contains("timeout") && attempt < max_retries {
                                warn!("收到超时相关错误 (尝试 {}): {}, 将重试", attempt, error_msg);
                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                continue;
                            }
                            return Err(format!("AI图像生成失败: {}", error_msg));
                        } else {
                            // 检查detail字段，这也是常见的错误信息字段
                            if let Some(detail_msg) = response_json.get("detail").and_then(|v| v.as_str()) {
                                if detail_msg.to_lowercase().contains("timeout") && attempt < max_retries {
                                    warn!("收到超时相关错误 (尝试 {}): {}, 将重试", attempt, detail_msg);
                                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                    continue;
                                }
                                return Err(format!("AI图像生成失败: {}", detail_msg));
                            } else {
                                return Err("AI图像生成失败".to_string());
                            }
                        }
                    }
                } else {
                    return Err("AI响应格式错误，缺少success字段".to_string());
                }

                // 提取图像数据
                let result = if let Some(image_url) = response_json.get("image_url").and_then(|v| v.as_str()) {
                    Ok(image_url.to_string())
                } else if let Some(image_data) = response_json.get("image_data").and_then(|v| v.as_str()) {
                    Ok(image_data.to_string())
                } else {
                    if attempt < max_retries {
                        warn!("AI响应中未找到图像数据 (尝试 {}), 将重试", attempt);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        continue;
                    } else {
                        Err("AI响应中未找到图像数据".to_string())
                    }
                };

                // 如果成功生成图像，则触发前端刷新用户信息
                if result.is_ok() {
                    info!("图像生成成功，触发次数显示更新");

                    // 发送credits-refresh事件，让前端刷新次数显示
                    let app_clone = app.clone();
                    tokio::spawn(async move {
                        let _ = app_clone.emit("credits-refresh", ());
                        info!("已发射credits-refresh事件以更新次数显示");
                    });
                }

                return result;
            }
            Err(e) => {
                if attempt < max_retries {
                    warn!("API调用失败 (尝试 {}): {}, 将重试", attempt, e);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await; // 等待5秒后重试
                    continue;
                } else {
                    return Err(format!("API调用失败: {}", e));
                }
            }
        }
    }
}

/// Save a device token provided by the user (from the API portal) and load it into memory.
/// Returns true if the token was saved and validated.
#[tauri::command]
pub async fn banana_save_device_token(app: AppHandle, token: String) -> Result<bool, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("令牌不能为空".to_string());
    }
    info!("保存用户提供的设备令牌，长度: {}", token.len());

    // Save to disk
    save_device_token_to_storage(&app, &token).await?;

    // Load into memory
    {
        let token_store = get_device_token_store();
        let mut guard = token_store.lock().await;
        *guard = Some(token.clone());
    }

    // Verify the token is valid
    let verify_result = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        banana_get_current_user(app.clone()),
    )
    .await
    .unwrap_or_else(|_| Err("验证令牌超时".to_string()));

    match verify_result {
        Ok(user) => {
            info!("用户提供的令牌有效，用户: {} (剩余次数: {})", user.email, user.credits);

            // 令牌激活后同步后置任务（skill 下载、auth_cache 同步）
            // 确保用户有API令牌（新用户自动创建）
            let api_key = match ensure_user_api_token(&token).await {
                Ok(key) => key,
                Err(e) => {
                    warn!("ensure_user_api_token失败: {}，回退到设备令牌", e);
                    token.clone()
                }
            };
            if let Err(sync_err) = sync_post_login_tasks(&api_key).await {
                warn!("令牌激活后同步后置任务失败: {}", sync_err);
            }

            // 设置当前用户 ID，必须在 sync 线程之前
            crate::sync::set_current_user_id(&user.user_id.to_string());

            // 触发跨设备数据同步（独立线程+独立runtime，不阻塞登录）
            let user_id_str = user.user_id.to_string();
            let app_bg = app.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .worker_threads(2)
                    .build()
                    .expect("failed to create sync runtime");
                rt.block_on(async {
                    if let Err(e) = crate::sync::SyncManager::init(app_bg.clone(), &user_id_str).await {
                        warn!("同步管理器初始化失败: {}", e);
                    }
                });
            });

            Ok(true)
        }
        Err(e) => {
            warn!("用户提供的令牌无效: {}", e);
            // Clear the invalid token from memory, keep on disk for diagnosis
            {
                let token_store = get_device_token_store();
                let mut guard = token_store.lock().await;
                *guard = None;
            }
            Err(format!("令牌验证失败: {}", e))
        }
    }
}

#[tauri::command]
pub async fn banana_initialize(app: AppHandle) -> Result<bool, String> {
    info!("初始化Banana API集成");

    // 尝试从本地存储加载设备令牌
    info!("尝试从本地存储加载设备令牌");
    if let Some(token) = load_device_token_from_storage(&app).await {
        info!("找到设备令牌，长度: {}", token.len());
        let token_store = get_device_token_store();
        info!("获取令牌存储");
        {
            let mut token_guard = token_store.lock().await;
            info!("获取写锁成功");
            *token_guard = Some(token.clone());
            info!("从本地存储加载设备令牌成功");
        }

        // 验证令牌是否有效（macOS 上 reqwest 超时可能不生效，加 tokio 超时兜底）
        let user_result = tokio::time::timeout(
            std::time::Duration::from_secs(12),
            banana_get_current_user(app.clone()),
        )
        .await
        .unwrap_or_else(|_| Err("验证令牌超时".to_string()));
        match user_result {
            Ok(user) => {
                info!("设备令牌有效，用户: {} (剩余次数: {})", user.email, user.credits);

                // 设备令牌有效后，自动同步API配置
                info!("设备令牌验证成功，开始同步API配置...");
                match banana_get_active_api_configs(app.clone()).await {
                    Ok(api_configs) => {
                        info!("获取到 {} 个活动API配置，开始更新本地API密钥", api_configs.len());

                        // 更新本地API密钥
                        if let Err(update_err) = banana_update_local_api_keys(api_configs).await {
                            warn!("更新本地API密钥失败: {}", update_err);
                            // 注意：这里我们不中断初始化过程，只记录警告
                        } else {
                            info!("本地API密钥更新成功");
                        }
                    }
                    Err(fetch_err) => {
                        warn!("获取活动API配置失败: {}", fetch_err);
                        // 注意：这里我们不中断初始化过程，只记录警告
                    }
                }

                // 同步 Xiaoya CLI 配置 - 使用真实API密钥
                // macOS 上 reqwest 超时可能不生效，加 tokio 超时兜底
                let api_key = tokio::time::timeout(
                    std::time::Duration::from_secs(12),
                    get_user_api_key(&token),
                )
                .await
                .unwrap_or_else(|_| {
                    warn!("获取用户API密钥超时，回退到设备令牌");
                    Err("超时".to_string())
                })
                .unwrap_or_else(|e| {
                    warn!("获取用户API密钥失败，回退到设备令牌: {}", e);
                    token.clone()
                });
                info!("使用API密钥同步登录后置任务（前4位: {}...）", &api_key[..std::cmp::min(4, api_key.len())]);
                if let Err(sync_err) = sync_post_login_tasks(&api_key).await {
                    warn!("同步登录后置任务失败: {}", sync_err);
                }

                // 设置当前用户 ID，必须在 sync 线程之前
                crate::sync::set_current_user_id(&user.user_id.to_string());

                // 触发跨设备数据同步（独立线程+独立runtime，不阻塞登录）
                let user_id_str = user.user_id.to_string();
                let app_bg = app.clone();
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_multi_thread()
                        .enable_all()
                        .worker_threads(2)
                        .build()
                        .expect("failed to create sync runtime");
                    rt.block_on(async {
                        if let Err(e) = crate::sync::SyncManager::init(app_bg.clone(), &user_id_str).await {
                            warn!("同步管理器初始化失败: {}", e);
                        }
                    });
                });

                return Ok(true);
            }
            Err(e) => {
                warn!("设备令牌验证失败: {}", e);
                let err_msg = e.to_lowercase();

                // 区分网络故障和真实认证失败
                let is_network = err_msg.contains("timeout")
                    || err_msg.contains("connection")
                    || err_msg.contains("dns")
                    || err_msg.contains("resolve")
                    || err_msg.contains("refused")
                    || err_msg.contains("reset")
                    || err_msg.contains("unreachable");

                {
                    let mut token_guard = token_store.lock().await;
                    *token_guard = None;
                }

                let app_clone = app.clone();
                if is_network {
                    tokio::spawn(async move {
                        let _ = app_clone.emit("network-down", "分镜大师无法连接服务器，已暂时退出登录。请检查网络后重试。");
                        info!("已发射network-down事件（网络故障）");
                    });
                } else {
                    tokio::spawn(async move {
                        let _ = app_clone.emit("login-required", ());
                        info!("已发射login-required事件（认证失败）");
                    });
                }

                // 返回false，但保留本地令牌，下次启动时再尝试验证
                info!("令牌验证失败，但保留本地令牌供下次使用");
            }
        }
    }

    info!("未找到有效的设备令牌，需要用户登录");
    Ok(false)
}

/// 内部版本：获取活动 API 配置，不发射 login-required 事件
/// 用于登录/激活流程中，由调用方决定如何处理 401/空配置
async fn fetch_active_api_configs(token: &str) -> Result<Vec<ApiConfig>, String> {
    let url = "/jy/api/v1/api-configs/active";
    let max_retries = 2;
    let mut attempt = 0;

    loop {
        attempt += 1;
        info!("获取活动API配置 (尝试 #{})", attempt);

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

        let url_full = format!("{}{}", BANANA_API_BASE_URL, url);

        match client
            .get(&url_full)
            .header("User-Agent", "Storyboard-Travel/1.0")
            .header("X-Device-Token", token)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                let response_text = match response.text().await {
                    Ok(text) => text,
                    Err(e) => {
                        if attempt < max_retries {
                            warn!("读取API配置响应失败 (尝试 {}): {}, 将重试", attempt, e);
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            continue;
                        } else {
                            return Err(format!("读取API配置响应失败: {}", e));
                        }
                    }
                };

                info!("API配置响应状态: {} {}", status, response_text);

                if !status.is_success() {
                    if status.as_u16() == 408 && attempt < max_retries {
                        warn!("收到408超时错误 (尝试 {}), 将重试", attempt);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        continue;
                    }
                    return Err(format!("获取API配置失败: {} - {}", status, response_text));
                }

                let api_response: ApiResponse<Vec<ApiConfig>> = match serde_json::from_str(&response_text) {
                    Ok(json) => json,
                    Err(e) => {
                        if attempt < max_retries {
                            warn!("解析API配置响应失败 (尝试 {}): {}, 将重试", attempt, e);
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            continue;
                        } else {
                            return Err(format!("解析API配置响应失败: {}", e));
                        }
                    }
                };

                if !api_response.success {
                    let error_msg = api_response.message.unwrap_or_else(|| "未知错误".to_string());
                    if error_msg.to_lowercase().contains("timeout") && attempt < max_retries {
                        warn!("收到超时相关错误 (尝试 {}): {}, 将重试", attempt, error_msg);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        continue;
                    }
                    return Err(format!("获取API配置失败: {}", error_msg));
                }

                let api_configs = api_response.data.unwrap_or_default();
                info!("获取到 {} 个活动API配置", api_configs.len());
                return Ok(api_configs);
            }
            Err(e) => {
                if attempt < max_retries {
                    warn!("获取API配置请求失败 (尝试 {}): {}, 将重试", attempt, e);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                } else {
                    return Err(format!("获取API配置请求失败: {}", e));
                }
            }
        }
    }
}

#[tauri::command]
pub async fn banana_get_active_api_configs(app: AppHandle) -> Result<Vec<ApiConfig>, String> {
    info!("获取活动API配置");

    let token_store = get_device_token_store();
    let token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    match fetch_active_api_configs(&token).await {
        Ok(configs) => Ok(configs),
        Err(e) => {
            // 仅在 Tauri 命令层发射 login-required（用户主动操作时）
            if e.contains("401") {
                let app_clone = app.clone();
                tokio::spawn(async move {
                    let _ = app_clone.emit("login-required", ());
                    info!("已发射login-required事件（401未授权）");
                });
            }
            Err(e)
        }
    }
}

/// 新用户账户激活：重试获取 API 配置并更新本地密钥
/// 用于注册后服务端尚未完成配置发放的场景
#[tauri::command]
pub async fn banana_activate_account(_app: AppHandle) -> Result<(), String> {
    info!("开始账户激活流程");

    let token_store = get_device_token_store();
    let token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    // 1. 确保 API 令牌存在
    if let Err(e) = ensure_user_api_token(&token).await {
        warn!("激活时 ensure_user_api_token 失败: {}，继续尝试获取配置", e);
    }

    // 2. 重试获取 API 配置（最多 3 次，间隔递增）
    let mut configs = Vec::new();
    for attempt in 1..=3 {
        info!("激活尝试 {}/3", attempt);
        match fetch_active_api_configs(&token).await {
            Ok(c) if !c.is_empty() => {
                configs = c;
                info!("激活成功：获取到 {} 个配置", configs.len());
                break;
            }
            Ok(_) => {
                warn!("激活尝试 {}: 配置为空，等待后重试", attempt);
            }
            Err(ref e) => {
                warn!("激活尝试 {} 失败: {}", attempt, e);
            }
        }
        if attempt < 3 {
            tokio::time::sleep(std::time::Duration::from_secs(attempt * 2)).await;
        }
    }

    if configs.is_empty() {
        return Err("账户激活失败，请重启应用后重试".to_string());
    }

    // 3. 更新本地 API 密钥
    banana_update_local_api_keys(configs).await?;

    // 4. 同步登录后置任务
    let api_key = get_user_api_key(&token).await.unwrap_or_else(|e| {
        warn!("激活时获取API密钥失败: {}，回退到设备令牌", e);
        token.clone()
    });
    if let Err(sync_err) = sync_post_login_tasks(&api_key).await {
        warn!("激活时同步后置任务失败: {}", sync_err);
    }

    info!("账户激活完成");
    Ok(())
}

#[tauri::command]
pub async fn banana_update_local_api_keys(
    api_configs: Vec<ApiConfig>,
) -> Result<(), String> {
    info!("根据Banana API配置更新本地API密钥");

    let registry = crate::commands::ai::get_registry();

    for config in api_configs {
        if !config.is_active || config.api_key.is_empty() {
            continue;
        }

        // 根据api_type映射到provider名称 - 仅为图像生成API类型映射
        let provider_name = match config.api_type.as_str() {
            "ppio" | "PPIO" | "ppio_image" | "PPIO_IMAGE" => "ppio",
            "grsai" | "GRSAI" | "grsai_image" | "GRSAI_IMAGE" => "grsai",
            "volcengine" | "VOLCENGINE" | "volcengine_image" | "VOLCENGINE_IMAGE" => "volcengine",
            "baidu" | "BAIDU" | "baidu_image" | "BAIDU_IMAGE" => "baidu",
            "pixverse" | "PIXVERSE" => "pixverse",
            "kie" | "KIE" | "kie_image" | "KIE_IMAGE" => "kie",
            "ALIYUN_IMAGE" | "aliyun" | "ALIYUN" => "kie", // KIE 图像生成密钥
            // 特定供应商类型映射
            "DOUBAO_IMAGE" | "doubao" | "DOUBAO" => "grsai", // 小鸭图像生成映射到grsai
            "OPENAI_IMAGE" | "openai_image" => "ppio", // 小鸭图像生成映射到ppio
            "MIDJOURNEY" | "midjourney" => "grsai", // 小鸭图像生成映射到grsai
            // AI提供商类型 — 存入全局变量，供 deepseek.rs 等模块使用
            "DEEPSEEK_CHAT" | "deepseek" => {
                info!("存储DeepSeek Chat密钥: {}", config.id);
                set_deepseek_chat_key(config.api_key.clone()).await;
                continue;
            },
            // 欢乐马视频生成密钥（1.1 走百度 VOD，与 baidu_video 同源）
            "happyhorse_video" => {
                info!("存储欢乐马视频生成密钥（百度 VOD）: {}", config.id);
                set_baidu_video_key(config.api_key.clone()).await;
                continue;
            },
            // 百度视频生成密钥 (拍我AI PixVerse C1)
            "baidu_video" | "BAIDU_VIDEO" => {
                info!("存储百度视频生成密钥 (PixVerse C1): {}", config.id);
                set_baidu_video_key(config.api_key.clone()).await;
                continue;
            },
            // 拍我AI PixVerse C1 视频生成（兼容旧配置）
            "pixverse_c1" | "PIXVERSE_C1" => {
                info!("存储PixVerse C1视频生成密钥: {}", config.id);
                set_baidu_video_key(config.api_key.clone()).await;
                continue;
            },            // 七牛云配置
            "qiniu_ak" | "QINIU_AK" => {
                info!("存储七牛云AccessKey: {}", config.id);
                set_qiniu_access_key(config.api_key.clone()).await;
                continue;
            },
            "qiniu_sk" | "QINIU_SK" => {
                info!("存储七牛云SecretKey: {}", config.id);
                set_qiniu_secret_key(config.api_key.clone()).await;
                continue;
            },
            "qiniu_bucket" | "QINIU_BUCKET" => {
                info!("存储七牛云Bucket: {}", config.id);
                set_qiniu_bucket(config.api_key.clone()).await;
                continue;
            },
            "qiniu_domain" | "QINIU_DOMAIN" => {
                info!("存储七牛云Domain: {}", config.id);
                set_qiniu_domain(config.api_key.clone()).await;
                continue;
            },
            "active_video_model" => {
                info!("存储当前视频模型: {} -> {}", config.id, config.api_key);
                set_active_video_model(config.api_key.clone()).await;
                continue;
            },
            "ALIYUN_QWEN" | "qwen" => {
                info!("跳过推理模型API类型（不应用于图像生成）: {}", config.api_type);
                continue;
            },
            "OPENAI_GPT" | "gpt" => {
                info!("跳过推理模型API类型（不应用于图像生成）: {}", config.api_type);
                continue;
            },
            "CLAUDE_API" | "claude" => {
                info!("跳过推理模型API类型（不应用于图像生成）: {}", config.api_type);
                continue;
            },
            "OTHER_LLM" => {
                info!("跳过推理模型API类型（不应用于图像生成）: {}", config.api_type);
                continue;
            },
            "baidu_ak" | "BAIDU_AK" => {
                info!("存储百度云AccessKey: {}", config.id);
                set_baidu_access_key(config.api_key.clone()).await;
                continue;
            },
            "baidu_sk" | "BAIDU_SK" => {
                info!("存储百度云SecretKey: {}", config.id);
                set_baidu_secret_key(config.api_key.clone()).await;
                continue;
            },
            // 千帆 ERNIE-VL 多模态读图密钥（独立于百度 VOD，千帆大模型平台单独授权）
            "qianfan_vl" | "QIANFAN_VL" | "ernie_vl" | "ERNIE_VL" => {
                info!("存储千帆VL读图密钥: {}", config.id);
                set_qianfan_vl_key(config.api_key.clone()).await;
                continue;
            },
            _ => {
                info!("跳过未知或不支持的API类型: {}", config.api_type);
                continue;
            }
        };

        if let Some(provider) = registry.get_provider(provider_name) {
            info!("找到provider: {}，准备设置API密钥（前4位）: {}", provider_name,
                if config.api_key.len() >= 4 { &config.api_key[0..4] } else { "太短" });

            if let Err(e) = provider.set_api_key(config.api_key.clone()).await {
                info!("设置{}的API密钥失败: {}", provider_name, e);
            } else {
                info!("已更新{}的API密钥，密钥ID: {}", provider_name, config.id);
            }
        } else {
            info!("未找到对应的provider: {}", provider_name);
        }
    }

    Ok(())
}

// 扣减用户信用次数的函数
#[allow(dead_code)]
async fn consume_user_credit(app: &AppHandle) -> Result<(), String> {
    info!("扣减用户信用次数");

    // 通过服务器端API扣减用户信用
    // 使用订阅扣费端点或用户扣费端点
    let endpoints_to_try = [
        "/jy/api/v1/subscriptions/consume",
        "/jy/api/v1/subscription/consume",
        "/jy/api/v1/users/consume-credit",
        "/jy/api/v1/credits/consume",
        "/jy/api/v1/subscriptions/usage",
        "/api/v1/subscriptions/consume",
        "/api/v1/subscription/consume",
        "/api/v1/credits/consume"
    ];

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    // 获取设备令牌
    let token_store = get_device_token_store();
    let token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    let consume_body = serde_json::json!({
        "consume_amount": 1,  // 扣减1次
        "service_type": "image_generation"
    });

    // 尝试多个可能的端点
    for endpoint in &endpoints_to_try {
        let url = format!("{}{}", BANANA_API_BASE_URL, endpoint);
        info!("尝试发送扣费请求到: {}", url);

        match client
            .post(&url)
            .header("User-Agent", "Storyboard-Travel/1.0")
            .header("X-Device-Token", token.as_str())
            .header("Content-Type", "application/json")
            .json(&consume_body)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                let response_text = response.text().await.map_err(|e| format!("读取扣费响应失败: {}", e))?;

                info!("扣费响应状态: {}, 文本: {}", status, response_text);

                if status.is_success() {
                    // 尝试解析响应
                    if let Ok(parsed_response) = serde_json::from_str::<serde_json::Value>(&response_text) {
                        if let Some(success) = parsed_response.get("success").and_then(|v| v.as_bool()) {
                            if success {
                                info!("用户信用次数扣减成功，使用端点: {}", endpoint);
                                return Ok(());
                            } else {
                                let error_msg = parsed_response.get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("未知错误");
                                info!("端点 {} 扣费失败: {}", endpoint, error_msg);
                                continue; // 尝试下一个端点
                            }
                        } else {
                            // 没有success字段，可能是成功的响应，检查是否有其他成功标识
                            if response_text.contains("success") || response_text.contains("ok") || response_text.contains("OK") {
                                info!("用户信用次数扣减成功，使用端点: {}", endpoint);
                                return Ok(());
                            } else {
                                info!("端点 {} 返回成功状态但格式未知: {}", endpoint, response_text);
                            }
                        }
                    } else {
                        // 无法解析JSON，但状态是成功的，可能也是扣费成功了
                        info!("用户信用次数扣减可能成功，使用端点: {} (无法解析响应JSON，但状态成功)", endpoint);
                        return Ok(());
                    }
                } else if status.as_u16() == 401 {
                    // 401错误，更新全局状态
                    let app_clone = app.clone();
                    tokio::spawn(async move {
                        let _ = app_clone.emit("login-required", ());
                        info!("已发射login-required事件（401未授权）");
                    });
                    return Err("未授权，需要重新登录".to_string());
                } else if status.as_u16() == 404 {
                    info!("端点 {} 不存在，尝试下一个端点", endpoint);
                    continue; // 尝试下一个端点
                } else {
                    info!("端点 {} 返回错误状态 {}: {}", endpoint, status, response_text);
                    continue; // 尝试下一个端点
                }
            }
            Err(e) => {
                info!("端点 {} 请求失败: {}", endpoint, e);
                continue; // 尝试下一个端点
            }
        }
    }

    // 如果所有端点都失败，尝试直接更新用户信息
    info!("所有扣费端点都失败，用户次数可能已在服务器端自动扣减或扣减失败");
    Ok(())
}

#[tauri::command]
pub async fn banana_consume_credit(app: AppHandle, count: Option<u32>, action_type: Option<String>, credits_override: Option<u32>) -> Result<String, String> {
    let total_credits = credits_override.unwrap_or_else(|| count.unwrap_or(1).max(1));
    let action_type = action_type.unwrap_or_else(|| "image_generation".to_string());
    info!("扣减用户信用积分 total_credits={} action_type={}", total_credits, action_type);

    let token_store = get_device_token_store();
    let token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {e}"))?;

    let url = format!("{BANANA_API_BASE_URL}/jy/api/v1/ai/image");
    let body = serde_json::json!({
        "prompt": "",
        "model": "ppio/nano-banana-2",
        "size": "1K",
        "aspect_ratio": "1:1",
        "reference_images": null,
        "extra_params": null,
        "credits": total_credits,
        "action_type": action_type
    });

    info!("发送扣费请求到: {url}");
    let response = client
        .post(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("X-Device-Token", token.as_str())
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("扣费请求失败: {e}"))?;

    let status = response.status();
    let response_text = response.text().await.map_err(|e| format!("读取扣费响应失败: {e}"))?;
    info!("扣费响应状态: {status}, 文本: {response_text}");

    if status.as_u16() == 401 {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let _ = app_clone.emit("login-required", ());
        });
        return Err("未授权，需要重新登录".to_string());
    }

    if !status.is_success() {
        return Err(format!("扣费失败: {status} - {response_text}"));
    }

    info!("扣费成功 total_credits={}", total_credits);
    let app_clone = app.clone();
    tokio::spawn(async move {
        let _ = app_clone.emit("credits-refresh", ());
    });
    Ok(format!("扣费成功 {}积分", total_credits))
}

/// 请求退款（当 AI provider 失败时调用）
/// 此函数为 best-effort：失败只记日志，不影响主流程
/// credits: 需要退回的积分数量
/// reason: 退款原因标识
pub async fn refund_generation_credit(app: &AppHandle, credits: u32, reason: String) -> Result<(), String> {
    let token = {
        let token_store = get_device_token_store();
        let token_guard = token_store.lock().await;
        token_guard
            .as_ref()
            .ok_or_else(|| "设备令牌未找到，无法退款".to_string())?
            .clone()
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建退款 HTTP 客户端失败: {e}"))?;

    let url = format!("{}/jy/api/v1/ai/refund", BANANA_API_BASE_URL);
    let body = serde_json::json!({
        "credits": credits,
        "reason": reason
    });

    info!("[退款] 请求退款 credits={} reason={}", credits, reason);

    let response = client
        .post(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("X-Device-Token", &token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("退款请求网络错误: {e}"))?;

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();
    info!("[退款] 响应 status={} body={}", status, response_text);

    if status.is_success() {
        info!("[退款] 成功 credits={}", credits);
        let app_clone = app.clone();
        tokio::spawn(async move {
            let _ = app_clone.emit("credits-refresh", ());
        });
        Ok(())
    } else {
        warn!("[退款] 失败 credits={} HTTP {} body={}", credits, status, response_text);
        Err(format!("退款失败: HTTP {} - {}", status, response_text))
    }
}

/// 前端退费接口：生成超时或网络错误时调用
#[tauri::command]
pub async fn banana_refund_credits(app: AppHandle, credits: u32, reason: String) -> Result<String, String> {
    info!("[退费] 前端发起退费: credits={} reason={}", credits, reason);
    match refund_generation_credit_impl(credits, reason).await {
        Ok(msg) => {
            let _ = app.emit("credits-refresh", ());
            Ok(msg)
        }
        Err(e) => Err(e),
    }
}

/// 无 AppHandle 的内部退费实现（供 banana_refund_credits 使用）
async fn refund_generation_credit_impl(credits: u32, reason: String) -> Result<String, String> {
    let token = {
        let token_store = get_device_token_store();
        let token_guard = token_store.lock().await;
        token_guard
            .as_ref()
            .ok_or_else(|| "设备令牌未找到，无法退款".to_string())?
            .clone()
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建退款 HTTP 客户端失败: {e}"))?;

    let url = format!("{}/jy/api/v1/ai/refund", BANANA_API_BASE_URL);
    let body = serde_json::json!({
        "credits": credits,
        "reason": reason
    });

    info!("[退款] 请求退款 credits={} reason={}", credits, reason);

    let response = client
        .post(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("X-Device-Token", &token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("退款请求网络错误: {e}"))?;

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();
    info!("[退款] 响应 status={} body={}", status, response_text);

    if status.is_success() {
        info!("[退款] 成功 credits={}", credits);
        Ok("ok".to_string())
    } else {
        warn!("[退款] 失败 credits={} HTTP {} body={}", credits, status, response_text);
        Err(format!("退款失败: HTTP {} - {}", status, response_text))
    }
}

#[tauri::command]
pub async fn banana_refresh_api_configs(app: AppHandle) -> Result<Vec<ApiConfig>, String> {
    info!("手动刷新API配置");

    // 获取最新API配置
    let api_configs = banana_get_active_api_configs(app).await?;

    // 更新本地API密钥
    banana_update_local_api_keys(api_configs.clone()).await?;

    info!("API配置刷新完成，共更新 {} 个配置", api_configs.len());
    Ok(api_configs)
}

#[tauri::command]
pub async fn banana_send_reset_code(email: String) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", BANANA_API_BASE_URL, "/jy/api/v1/auth/send-reset-code");
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;
    let body = serde_json::json!({ "email": email });
    let response = client
        .post(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if !status.is_success() {
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(detail) = json_value.get("detail").and_then(|v| v.as_str()) {
                return Err(detail.to_string());
            }
        }
        return Err(format!("请求失败 ({}): {}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))
}

#[tauri::command]
pub async fn banana_reset_password(email: String, code: String, new_password: String) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", BANANA_API_BASE_URL, "/jy/api/v1/auth/reset-password");
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;
    let body = serde_json::json!({ "email": email, "code": code, "new_password": new_password });
    let response = client
        .post(&url)
        .header("User-Agent", "Storyboard-Travel/1.0")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if !status.is_success() {
        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(detail) = json_value.get("detail").and_then(|v| v.as_str()) {
                return Err(detail.to_string());
            }
        }
        return Err(format!("请求失败 ({}): {}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))
}

/// 视频生成：复用现有计费基础设施，通过 banana_consume_credit 扣费
#[tauri::command]
pub async fn banana_submit_video_job(
    app: AppHandle,
    prompt: String,
    aspect_ratio: String,
    resolution: Option<String>,
    duration_seconds: u32,
    image_input: Vec<String>,
    video_input: Option<Vec<String>>,
    model: Option<String>,
    voice_url: Option<String>,
    negative_prompt: Option<String>,
    guidance_scale: Option<f64>,
    shot_type: Option<String>,
) -> Result<serde_json::Value, String> {
    let model_name = model.unwrap_or_else(|| "minimax/minimax-h3".to_string());
    info!("提交短视频生成任务: model={}, duration={}s, aspect={}, images={}, video={}",
        model_name, duration_seconds, aspect_ratio, image_input.len(),
        video_input.as_ref().map(|v| v.len()).unwrap_or(0));

    // 1. 验证登录状态
    let token_store = get_device_token_store();
    let _device_token = {
        let token_guard = token_store.lock().await;
        token_guard.as_ref().ok_or("设备令牌未找到，请先登录")?.clone()
    };

    // 2. 计算所需积分（与前端 videoPricing.ts 保持同步）
    let is_1080p = resolution.as_deref() == Some("1080P");
    let base_credits = match (duration_seconds, is_1080p) {
        (4, false) => 35,  (4, true) => 45,
        (6, false) => 45,  (6, true) => 55,
        (8, false) => 55,  (8, true) => 78,
        (10, false) => 65, (10, true) => 93,
        (12, false) => 78, (12, true) => 105,
        (15, false) => 93, (15, true) => 120,
        _ => 100,
    };
    let has_video = video_input.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
    let total_credits = (base_credits as f64 * (if has_video { 1.5 } else { 1.0 })).ceil() as u32;

    info!("视频计费: base={}, has_video={}, total={}", base_credits, has_video, total_credits);

    // 3. 检查余额
    let credits_info = banana_check_credits(app.clone()).await?;
    let current_credits = credits_info.credits as u32;
    if current_credits < total_credits {
        return Ok(serde_json::json!({
            "success": false,
            "error": format!("INSUFFICIENT_CREDITS: 积分不足，需要 {} 积分，当前 {} 积分", total_credits, current_credits),
            "requiredCredits": total_credits,
            "currentCredits": current_credits
        }));
    }

    // 4. 调用现有 banana_consume_credit 扣费（精确积分，不取整）
    match banana_consume_credit(app.clone(), None, Some("video_generation".to_string()), Some(total_credits)).await {
        Ok(msg) => info!("扣费成功: {} (扣除{}积分)", msg, total_credits),
        Err(e) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("扣费失败: {}", e)
            }));
        }
    }

    // 5. 根据模型选择 Provider（仅境内供应商）
    let is_happyhorse = model_name.starts_with("happyhorse/");
    let is_pixverse = model_name.starts_with("pixverse/");
    let is_minimax = model_name.starts_with("minimax/");

    let provider: std::sync::Arc<dyn crate::ai::AIProvider> = if is_happyhorse {
        let key = get_baidu_video_key()
            .ok_or_else(|| "百度视频生成密钥未配置，请联系管理员".to_string())?;
        let p: std::sync::Arc<dyn crate::ai::AIProvider> = std::sync::Arc::new(
            crate::ai::providers::happyhorse::HappyHorseProvider::new_baidu_vod(&model_name),
        );
        p.set_api_key(key.clone()).await.map_err(|e| format!("设置欢乐马百度VOD密钥失败: {}", e))?;
        p
    } else if is_pixverse {
        let api_key = get_baidu_video_key()
            .ok_or_else(|| "百度视频生成密钥未配置，请联系管理员".to_string())?;
        let p: std::sync::Arc<dyn crate::ai::AIProvider> = std::sync::Arc::new(crate::ai::providers::pixverse::PixVerseProvider::new());
        p.set_api_key(api_key).await.map_err(|e| format!("设置百度视频密钥失败: {}", e))?;
        p
    } else if is_minimax {
        let api_key = get_baidu_video_key()
            .ok_or_else(|| "百度视频生成密钥未配置，请联系管理员".to_string())?;
        let p: std::sync::Arc<dyn crate::ai::AIProvider> = std::sync::Arc::new(
            crate::ai::providers::minimax::MiniMaxProvider::new()
        );
        p.set_api_key(api_key).await.map_err(|e| format!("设置MiniMax百度VOD密钥失败: {}", e))?;
        p
    } else {
        return Ok(serde_json::json!({
            "success": false,
            "error": format!("不支持的视频模型: {}，仅支持 happyhorse/ 、 pixverse/ 和 minimax/ 前缀的模型", model_name)
        }));
    };

    let mut extra_params = std::collections::HashMap::new();
    extra_params.insert("duration_seconds".to_string(), serde_json::json!(duration_seconds));
    let quality = resolution.unwrap_or_else(|| "720P".to_string()).to_lowercase();
    extra_params.insert("quality".to_string(), serde_json::json!(quality));
    // 🔴 关闭 prompt_extend：分镜提示词精心编写，开启后 AI 会改写导致视频偏离宫格图
    extra_params.insert("prompt_extend".to_string(), serde_json::json!(false));
    if let Some(ref neg) = negative_prompt {
        if !neg.is_empty() {
            extra_params.insert("negative_prompt".to_string(), serde_json::json!(neg));
        }
    }
    if let Some(gs) = guidance_scale {
        extra_params.insert("guidance_scale".to_string(), serde_json::json!(gs));
    }
    if let Some(ref st) = shot_type {
        if !st.is_empty() {
            extra_params.insert("shot_type".to_string(), serde_json::json!(st));
        }
    }
    if let Some(ref video_urls) = video_input {
        if !video_urls.is_empty() {
            extra_params.insert("video_input".to_string(), serde_json::json!(video_urls));
        }
    }

    // 上传音色参考音频到七牛云
    if let Some(ref voice) = voice_url {
        if !voice.is_empty() {
            let ext = if voice.contains("audio/wav") || voice.contains("audio/wave") { "wav" }
                else if voice.contains("audio/mp3") || voice.contains("audio/mpeg") { "mp3" }
                else if voice.contains("audio/flac") { "flac" }
                else { "mp3" };
            let user_id = crate::sync::get_current_user_id().unwrap_or_else(|| "unknown".to_string());
            match upload_single_ref_to_qiniu_with_ext(voice, &user_id, ext).await {
                Ok(qiniu_url) => {
                    info!("[Qiniu] uploaded voice ref → {}", qiniu_url);
                    extra_params.insert("reference_voice".to_string(), serde_json::json!(qiniu_url));
                }
                Err(e) => {
                    warn!("[Qiniu] voice upload failed, fallback to original: {}", e);
                    extra_params.insert("reference_voice".to_string(), serde_json::json!(voice));
                }
            }
        }
    }

    // 5a. HappyHorse 1.1 / MiniMax H3 via BaiduVod 用 base64 直传（百度 VOD 无法下载 Qiniu CDN URL）
    let is_baidu_vod = is_happyhorse && model_name.contains("happyhorse-1.1") || is_minimax;
    let qiniu_images = if is_baidu_vod {
        info!("[BaiduVod] 跳过七牛云上传，使用 base64 直传");
        image_input
    } else if !image_input.is_empty() {
        upload_refs_to_qiniu(&image_input).await
    } else {
        image_input
    };

    let generate_req = crate::ai::GenerateRequest {
        prompt: prompt.clone(),
        model: model_name.clone(),
        size: "1080P".to_string(),
        aspect_ratio: aspect_ratio.clone(),
        reference_images: Some(qiniu_images),
        extra_params: Some(extra_params),
    };

    // 5b. 提交任务到 Provider（非阻塞，立即返回 task_id 供前端轮询）
    match provider.submit_task(generate_req.clone()).await {
        Ok(crate::ai::ProviderTaskSubmission::Queued(handle)) => {
            info!("视频任务已提交: task_id={}", handle.task_id);
            return Ok(serde_json::json!({
                "success": true,
                "taskId": handle.task_id,
                "creditsDeducted": total_credits
            }));
        }
        Ok(crate::ai::ProviderTaskSubmission::Succeeded(url)) => {
            info!("视频生成同步完成: {}", url);
            return Ok(serde_json::json!({
                "success": true,
                "videoUrl": url,
                "creditsDeducted": total_credits
            }));
        }
        Err(e) => {
            let err_msg = e.to_string();
            warn!("视频任务提交失败: {}", err_msg);
            // 提交失败，退费（退实际扣除的积分）
            let refund_model = model_name.clone();
            let refunded = refund_generation_credit(&app, total_credits, format!("video_submit_fail:{}", refund_model)).await;
            let refund_msg = match &refunded {
                Ok(()) => format!("，已退回{}积分", total_credits),
                Err(e) => format!("，退费失败: {}", e),
            };
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("视频任务提交失败: {}{}", err_msg, refund_msg),
                "creditsRefunded": refunded.is_ok()
            }));
        }
    }
}

/// 轮询视频生成任务状态（用于断点续接）
#[tauri::command]
pub async fn banana_poll_video_job(
    app: AppHandle,
    task_id: String,
    credits_deducted: u32,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    use crate::ai::AIProvider;
    let model_name = model.unwrap_or_default();
    let is_happyhorse = model_name.starts_with("happyhorse/");
    let is_pixverse = model_name.starts_with("pixverse/");
    let is_minimax = model_name.starts_with("minimax/");

    let provider: Box<dyn AIProvider + Send> = if is_happyhorse {
        let api_key = get_baidu_video_key()
            .ok_or_else(|| "百度视频生成密钥未配置，请联系管理员".to_string())?;
        let p = crate::ai::providers::happyhorse::HappyHorseProvider::new_baidu_vod(&model_name);
        p.set_api_key(api_key).await.map_err(|e| format!("设置欢乐马百度VOD密钥失败: {}", e))?;
        Box::new(p)
    } else if is_pixverse {
        let api_key = get_baidu_video_key()
            .ok_or_else(|| "百度视频生成密钥未配置，请联系管理员".to_string())?;
        let p = crate::ai::providers::pixverse::PixVerseProvider::new();
        p.set_api_key(api_key).await.map_err(|e| format!("设置百度视频密钥失败: {}", e))?;
        Box::new(p)
    } else if is_minimax {
        let api_key = get_baidu_video_key()
            .ok_or_else(|| "百度视频生成密钥未配置，请联系管理员".to_string())?;
        let p = crate::ai::providers::minimax::MiniMaxProvider::new();
        p.set_api_key(api_key).await.map_err(|e| format!("设置MiniMax百度VOD密钥失败: {}", e))?;
        Box::new(p)
    } else {
        return Ok(serde_json::json!({
            "status": "failed",
            "error": format!("不支持的视频模型: {}", model_name)
        }));
    };

    let metadata = if is_pixverse {
        get_baidu_video_key().map(|key| serde_json::json!({ "api_key": key }))
    } else {
        None
    };
    let handle = crate::ai::ProviderTaskHandle {
        task_id: task_id.clone(),
        metadata,
    };

    match provider.poll_task(handle).await {
        Ok(crate::ai::ProviderTaskPollResult::Succeeded(url)) => {
            // 重置连续错误计数
            {
                let mut counts = VIDEO_POLL_ERROR_COUNT.lock().await;
                counts.remove(&task_id);
            }
            info!("视频任务完成: {}", url);
            Ok(serde_json::json!({
                "status": "succeeded",
                "videoUrl": url
            }))
        }
        Ok(crate::ai::ProviderTaskPollResult::Failed(msg)) => {
            // 重置连续错误计数
            {
                let mut counts = VIDEO_POLL_ERROR_COUNT.lock().await;
                counts.remove(&task_id);
            }
            warn!("视频任务失败: {}", msg);
            // 429 限流 → 不退费，通知用户稍后手动重试
            if msg.contains("429") || msg.to_lowercase().contains("rate") {
                return Ok(serde_json::json!({
                    "status": "failed",
                    "error": format!("上游服务限流，请稍后手动重试: {}", msg),
                    "creditsRetained": true
                }));
            }
            // 防重复退费：同一 task_id 只退一次
            let already_refunded = {
                let set = REFUNDED_TASK_IDS.lock().await;
                set.contains(&task_id)
            };
            if already_refunded {
                warn!("任务 {} 已退过费，跳过重复退费", task_id);
                return Ok(serde_json::json!({
                    "status": "failed",
                    "error": format!("{}（已自动退费）", msg),
                    "creditsRefunded": false
                }));
            }
            let credits_to_refund = if credits_deducted > 0 { credits_deducted } else { 30 };
            let refunded = refund_generation_credit(&app, credits_to_refund, format!("video_poll:{}", task_id)).await;
            if refunded.is_ok() {
                let mut set = REFUNDED_TASK_IDS.lock().await;
                set.insert(task_id.clone());
            }
            let refund_msg = match &refunded {
                Ok(()) => format!("，已退回{}积分", credits_to_refund),
                Err(e) => format!("，退费失败: {}", e),
            };
            Ok(serde_json::json!({
                "status": "failed",
                "error": format!("{}{}", msg, refund_msg),
                "creditsRefunded": refunded.is_ok()
            }))
        }
        Ok(crate::ai::ProviderTaskPollResult::Queued) => {
            // 任务排队中：重置连续错误计数，返回 queued
            {
                let mut counts = VIDEO_POLL_ERROR_COUNT.lock().await;
                counts.remove(&task_id);
            }
            Ok(serde_json::json!({ "status": "queued" }))
        }
        Ok(crate::ai::ProviderTaskPollResult::Running) => {
            // 重置连续错误计数（任务仍在正常运行）
            {
                let mut counts = VIDEO_POLL_ERROR_COUNT.lock().await;
                counts.remove(&task_id);
            }
            Ok(serde_json::json!({ "status": "running" }))
        }
        Err(e) => {
            let err_msg = e.to_string();
            warn!("视频任务轮询临时错误: {}", err_msg);

            let mut counts = VIDEO_POLL_ERROR_COUNT.lock().await;
            let count = counts.entry(task_id.clone()).and_modify(|c| *c += 1).or_insert(1);
            let current = *count;

            if current >= 5 {
                counts.remove(&task_id);
                drop(counts);

                let already_refunded = {
                    let set = REFUNDED_TASK_IDS.lock().await;
                    set.contains(&task_id)
                };
                if already_refunded {
                    return Ok(serde_json::json!({
                        "status": "failed",
                        "error": format!("轮询连续失败{}次: {}（已退过费）", current, err_msg),
                        "creditsRefunded": false
                    }));
                }
                let credits_to_refund = if credits_deducted > 0 { credits_deducted } else { 30 };
                let refunded = refund_generation_credit(&app, credits_to_refund, format!("video_poll_err:{}", task_id)).await;
                if refunded.is_ok() {
                    let mut set = REFUNDED_TASK_IDS.lock().await;
                    set.insert(task_id.clone());
                }
                let refund_msg = match &refunded {
                    Ok(()) => format!("，已退回{}积分", credits_to_refund),
                    Err(e) => format!("，退费失败: {}", e),
                };
                return Ok(serde_json::json!({
                    "status": "failed",
                    "error": format!("轮询连续失败{}次: {}{}", current, err_msg, refund_msg),
                    "creditsRefunded": refunded.is_ok()
                }));
            }

            Ok(serde_json::json!({
                "status": "running",
                "error": err_msg
            }))
        }
    }
}

#[tauri::command]
pub async fn banana_get_active_video_model() -> Result<String, String> {
    get_active_video_model().ok_or_else(|| "视频模型未配置".to_string())
}


/// 复制文件到指定路径（供前端 save dialog 使用）
#[tauri::command]
pub async fn copy_file_to_path(src: String, dest: String) -> Result<(), String> {
    if src.starts_with("http://") || src.starts_with("https://") {
        // 远程URL：先下载再复制到目标路径
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;
        let bytes = client.get(&src).send().await
            .map_err(|e| format!("下载视频失败: {}", e))?
            .bytes().await
            .map_err(|e| format!("读取视频数据失败: {}", e))?;
        std::fs::write(&dest, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    } else {
        std::fs::copy(&src, &dest).map_err(|e| format!("复制失败: {}", e))?;
    }
    Ok(())
}

/// 下载视频到本地 app data 目录
#[tauri::command]
pub async fn download_video_to_local(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    use tauri::Manager;

    let videos_dir = crate::sync::get_user_dir(&app)
        .map(|d| d.join("videos"))
        .unwrap_or_else(|_| {
            app.path()
                .app_data_dir()
                .map(|p| p.join("videos"))
                .unwrap_or_else(|_| std::path::PathBuf::from("videos"))
        });
    std::fs::create_dir_all(&videos_dir)
        .map_err(|e| format!("无法创建视频目录: {}", e))?;

    let file_path = videos_dir.join(&filename);
    let file_path_str = file_path.to_string_lossy().to_string();

    info!("下载视频: {} -> {}", url, file_path_str);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载视频失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("视频下载失败 HTTP {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取视频数据失败: {}", e))?;

    std::fs::write(&file_path, &bytes)
        .map_err(|e| format!("保存视频文件失败: {}", e))?;

    info!("视频已保存: {} ({} bytes)", file_path_str, bytes.len());
    Ok(file_path_str)
}

// ── Video Super-Resolution (Baidu VOD) ──

const VOD_2K_PRESET: &str = "gfmpyhkqg0dqpjb6fh9i"; // 自建超分2K模板
const VOD_4K_PRESET: &str = "gfmpipe6666pr3j895vv"; // 自建超分4K模板

#[tauri::command]
pub async fn baidu_upscale_video(
    app: tauri::AppHandle,
    video_path: String,
    resolution: String,
) -> Result<String, String> {
    let ak = get_baidu_access_key()
        .ok_or_else(|| "百度云AccessKey未配置".to_string())?;
    let sk = get_baidu_secret_key()
        .ok_or_else(|| "百度云SecretKey未配置".to_string())?;

    let (preset_id, credit_cost) = match resolution.as_str() {
        "2K" => (VOD_2K_PRESET.to_string(), 20u32),
        "4K" => (VOD_4K_PRESET.to_string(), 35u32),
        _ => return Err(format!("不支持的分辨率: {}", resolution)),
    };

    // Deduct credits
    banana_consume_credit(app.clone(), Some(1), Some("video_upscale".to_string()), Some(credit_cost)).await
        .map_err(|e| format!("积分扣费失败: {}", e))?;
    info!("[BaiduVOD] 扣费成功 {} 积分", credit_cost);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    // Inner logic: if anything fails, refund credits
    let result = baidu_upscale_inner(&client, &ak, &sk, &video_path, &preset_id, &resolution).await;

    match result {
        Ok(output_path) => {
            info!("[BaiduVOD] 超分完成: {}", output_path);
            Ok(output_path)
        }
        Err(e) => {
            warn!("[BaiduVOD] 超分失败，退费 {} 积分: {}", credit_cost, e);
            let _ = refund_generation_credit(&app, credit_cost, format!("upscale_failed:{}", resolution)).await;
            Err(e)
        }
    }
}

async fn baidu_upscale_inner(
    client: &reqwest::Client,
    ak: &str,
    sk: &str,
    video_path: &str,
    preset_id: &str,
    resolution: &str,
) -> Result<String, String> {
    // If input is a URL, download to temp file first
    let local_path = if video_path.starts_with("http") {
        let tmp_dir = std::env::temp_dir().join("storyboard-upscale");
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
        let ext = if video_path.contains(".mp4") { "mp4" } else { "mp4" };
        let tmp_file = tmp_dir.join(format!("input_{}.{}", uuid::Uuid::new_v4(), ext));
        let tmp_str = tmp_file.to_string_lossy().to_string();
        tracing::info!("[BaiduVOD] 下载远程视频: {} -> {}", video_path, tmp_str);
        let response = client.get(video_path).send().await
            .map_err(|e| format!("下载源视频失败: {}", e))?;
        let bytes = response.bytes().await
            .map_err(|e| format!("读取源视频失败: {}", e))?;
        std::fs::write(&tmp_str, &bytes)
            .map_err(|e| format!("保存临时视频失败: {}", e))?;
        tmp_str
    } else {
        video_path.to_string()
    };

    // Upload to VOD
    let media_id = crate::ai::providers::baidu::baidu_vod_upload(
        client, ak, sk, &local_path,
    ).await.map_err(|e| format!("VOD上传: {}", e))?;

    // Submit super-resolution
    let task_id = crate::ai::providers::baidu::baidu_vod_process(
        client, ak, sk, &media_id, preset_id,
    ).await.map_err(|e| format!("VOD处理: {}", e))?;

    // Poll
    let output_url = crate::ai::providers::baidu::baidu_vod_poll(
        client, ak, sk, &task_id, 60,
    ).await.map_err(|e| format!("VOD轮询: {}", e))?;

    // Download result
    let output_dir = std::path::Path::new(&local_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    let file_stem = std::path::Path::new(&local_path)
        .file_stem().unwrap_or_default().to_string_lossy();
    let output_path = format!("{}/upscale_{}_{}.mp4", output_dir, file_stem, resolution);

    let response = client.get(&output_url).send().await
        .map_err(|e| format!("下载超分视频失败: {}", e))?;
    let bytes = response.bytes().await
        .map_err(|e| format!("读取超分视频失败: {}", e))?;
    std::fs::write(&output_path, &bytes)
        .map_err(|e| format!("保存超分视频失败: {}", e))?;
    Ok(output_path)
}