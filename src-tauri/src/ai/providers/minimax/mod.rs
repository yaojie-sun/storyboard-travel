use base64::Engine;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

// ── MiniMax H3 via 优云智算 compshare 直连 ──
// 走 compshare（UCloud，境内）原生通道 cp.compshare.cn/minimax，
// 复用 COMPSHARE_VIDEO_KEY（经自有服务器配置下发），不经百度 VOD、不碰阿里云。
const BASE_URL: &str = "https://cp.compshare.cn/minimax";
const CREATE_PATH: &str = "/v2/video_generation";
const QUERY_PATH: &str = "/v2/query/video_generation";
const POLL_INTERVAL_MS: u64 = 10000;
/// H3 是 v2 唯一模型，API 请求体里的 model 固定为此字符串。
const API_MODEL: &str = "MiniMax-H3";

// ── 创建响应：{"task_id": "tsk-xxxx"}（snake_case）──
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxCreateResponse {
    task_id: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

// ── 查询响应：可能被包在 task 对象里，也可能平铺 ──
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxQueryResponse {
    task: Option<MinimaxTask>,
    status: Option<String>,
    content: Option<MinimaxContent>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxTask {
    status: Option<String>,
    content: Option<MinimaxContent>,
    #[serde(rename = "videoUrl")]
    video_url: Option<String>,
    /// 失败时 compshare 在 task.error 里给出 {code, message}
    error: Option<MinimaxError>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxError {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxContent {
    url: Option<String>,
    #[serde(rename = "videoUrl")]
    video_url: Option<String>,
}

pub struct MiniMaxProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl MiniMaxProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(2000))
                .connect_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
            api_key: Arc::new(RwLock::new(None)),
        }
    }

    fn sanitize_model(model: &str) -> String {
        model
            .split_once('/')
            .map(|(_, bare)| bare.to_string())
            .unwrap_or_else(|| model.to_string())
    }

    /// compshare H3 只接受 480P/768P/1080P/2K/4K（区分大小写，无 720P）。
    /// 上游 banana_api 写入的 key 是 quality（小写 "720p"），
    /// 这里统一归一化：720P/720p → 768P（H3 最低档，积分档位仍按原 720P 计、不变），
    /// 其余不受支持的值一律回落 768P。
    fn normalize_resolution(raw: Option<&str>) -> String {
        const ALLOWED: [&str; 5] = ["480P", "768P", "1080P", "2K", "4K"];
        let q = raw.unwrap_or("").trim();
        if q.eq_ignore_ascii_case("720p") {
            return "768P".to_string();
        }
        let up = q.to_uppercase();
        if ALLOWED.contains(&up.as_str()) {
            up
        } else {
            "768P".to_string()
        }
    }

    /// compshare H3 画幅白名单。
    fn normalize_ratio(raw: Option<&str>) -> String {
        const ALLOWED: [&str; 7] = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
        let r = raw.unwrap_or("").trim();
        if ALLOWED.contains(&r) {
            r.to_string()
        } else {
            "adaptive".to_string()
        }
    }

    /// compshare H3 duration 区间 4–30 秒。
    fn normalize_duration(raw: Option<u64>) -> u32 {
        raw.unwrap_or(5).clamp(4, 30) as u32
    }

    fn query_status(resp: &MinimaxQueryResponse) -> String {
        resp.task
            .as_ref()
            .and_then(|t| t.status.as_deref())
            .or(resp.status.as_deref())
            .unwrap_or("")
            .to_uppercase()
    }

    fn extract_video_url(resp: &MinimaxQueryResponse) -> Option<String> {
        let task = resp.task.as_ref();
        // 1. task.content.url
        if let Some(u) = task
            .and_then(|t| t.content.as_ref())
            .and_then(|c| c.url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 2. task.content.videoUrl
        if let Some(u) = task
            .and_then(|t| t.content.as_ref())
            .and_then(|c| c.video_url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 3. task.videoUrl
        if let Some(u) = task
            .and_then(|t| t.video_url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 4. 平铺 content.url
        if let Some(u) = resp
            .content
            .as_ref()
            .and_then(|c| c.url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 5. 平铺 content.videoUrl
        resp.content
            .as_ref()
            .and_then(|c| c.video_url.as_ref())
            .filter(|u| !u.is_empty())
            .map(|u| u.clone())
    }

    /// 检测 MiniMax/compshare 以 HTTP 200 返回的错误体 {"type":"error",...}，
    /// 提取最内层 error.message（可能是嵌套 JSON 字符串）。
    fn extract_error_body(raw: &str) -> Option<String> {
        let val: Value = serde_json::from_str(raw).ok()?;
        if val.get("type").and_then(|t| t.as_str()) != Some("error") {
            return None;
        }
        let msg: String = val
            .pointer("/error/message")
            .and_then(|m| m.as_str())
            .map(|s| {
                // message 可能是嵌套 JSON 字符串，再剥一层取真正的错误信息
                match serde_json::from_str::<Value>(s) {
                    Ok(nested) => nested
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or(s)
                        .to_string(),
                    Err(_) => s.to_string(),
                }
            })
            .unwrap_or_else(|| "MiniMax H3 未知错误".to_string());
        Some(msg)
    }

    /// H3 参考图单边上限 5760。6 宫格故事板合成图常为 6912x8192，超限会被拒。
    /// 这里把 base64 参考图等比缩放到长边 <= max_side（JPEG q85 重编码，控制体积）。
    fn downscale_base64_image(data_url: &str, max_side: u32) -> Option<String> {
        let b64 = data_url.strip_prefix("data:")?.split_once(";base64,")?.1;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
        let img = image::load_from_memory(&bytes).ok()?;
        let (w, h) = (img.width(), img.height());
        if w <= max_side && h <= max_side {
            return Some(data_url.to_string());
        }
        let scale = (max_side as f64) / (w.max(h) as f64);
        let nw = ((w as f64) * scale).round().max(1.0) as u32;
        let nh = ((h as f64) * scale).round().max(1.0) as u32;
        let resized = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
        let rgb = resized.to_rgb8();
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
        enc.encode_image(&rgb).ok()?;
        let new_b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
        Some(format!("data:image/jpeg;base64,{}", new_b64))
    }

    /// H3 用 content[] 结构：text + image_url（role=reference_image）。
    /// 参考图走 base64 直传（compshare 直连，经自有服务器下发 key，图片不落第三方）。
    /// compshare 限制参考图 ≤9 张，超出直接截断，避免整单被拒。
    fn build_content(prompt: &str, reference_images: &[String]) -> Vec<Value> {
        const MAX_REF_IMAGES: usize = 9;
        let mut content: Vec<Value> = vec![json!({
            "type": "text",
            "text": prompt,
        })];
        for ref_img in reference_images.iter().take(MAX_REF_IMAGES) {
            if ref_img.starts_with("data:") {
                // base64 参考图：单边上限 5760，超限先等比缩放
                let url = Self::downscale_base64_image(ref_img, 5760)
                    .unwrap_or_else(|| ref_img.clone());
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": url },
                    "role": "reference_image",
                }));
            } else if ref_img.starts_with("http://") || ref_img.starts_with("https://") {
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": ref_img },
                    "role": "reference_image",
                }));
            }
            // 非法 url 直接丢弃
        }
        content
    }

    async fn create_task(
        &self,
        api_key: &str,
        request: &GenerateRequest,
    ) -> Result<String, AIError> {
        let duration = Self::normalize_duration(
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("duration_seconds"))
                .and_then(|raw| raw.as_u64()),
        );

        let resolution = Self::normalize_resolution(
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("quality"))
                .and_then(|raw| raw.as_str()),
        );

        let ratio = Self::normalize_ratio(Some(request.aspect_ratio.as_str()));

        let content = Self::build_content(&request.prompt, request.reference_images.as_deref().unwrap_or(&[]));
        let refs = content.iter().filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("image_url")).count();

        let body = json!({
            "model": API_MODEL,
            "content": content,
            "resolution": resolution,
            "duration": duration,
            "ratio": ratio,
            "use_context_ir": false,
            "aigc_watermark": false,
        });

        let endpoint = format!("{}{}", BASE_URL, CREATE_PATH);

        // compshare 请求体上限 72MiB（参考图 base64 占比最大），超限直接给出可读错误，
        // 避免把整包发出去换来一个语焉不详的 4xx。
        const MAX_BODY_BYTES: usize = 72 * 1024 * 1024;
        let body_bytes = serde_json::to_vec(&body).map(|v| v.len()).unwrap_or(0);
        if body_bytes > MAX_BODY_BYTES {
            return Err(AIError::InvalidRequest(format!(
                "参考图体积过大（{} MiB，上限 {} MiB），请减少参考图数量或尺寸",
                body_bytes / (1024 * 1024),
                MAX_BODY_BYTES / (1024 * 1024)
            )));
        }

        info!(
            "[MiniMax H3 createTask] url={}, model={}, duration={}, resolution={}, ratio={}, refs={}, promptLen={}, bodyMiB={}",
            endpoint, API_MODEL, duration, resolution, ratio,
            refs, request.prompt.chars().count(),
            body_bytes / (1024 * 1024)
        );
        info!("[MiniMax H3 createTask] FULL PROMPT:\n{}", request.prompt);

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let raw = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "MiniMax H3 createTask failed {}: {}",
                status, raw
            )));
        }

        info!("[MiniMax H3 createTask] raw response: {}", raw);
        let resp: MinimaxCreateResponse = serde_json::from_str(&raw).map_err(|err| {
            AIError::Provider(format!("MiniMax H3 create invalid JSON: {}; raw={}", err, raw))
        })?;

        if let Some(code) = &resp.code {
            let msg = resp.message.as_deref().unwrap_or("unknown");
            if code != "0" && code != "Success" {
                return Err(AIError::Provider(format!(
                    "MiniMax H3 create API error [{}]: {}",
                    code, msg
                )));
            }
        }

        resp.task_id
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AIError::Provider(format!("MiniMax H3 create missing task_id. raw={}", raw)))
    }

    async fn poll_task_once(
        &self,
        api_key: &str,
        task_id: &str,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let endpoint = format!("{}{}/{}", BASE_URL, QUERY_PATH, task_id);
        // ⚠️ 绝不打密钥本身（多 KEY 池之后每 3 秒一次轮询会把密钥写满日志）。
        // 只打「用哪个 KEY」的指纹前缀，够定位、不可逆。
        info!(
            "[MiniMax H3 Poll] url={}, key_fp={}",
            endpoint,
            &crate::commands::video_key_pool::fingerprint(api_key)[..8]
        );

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?;

        let status = response.status();
        let raw = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "MiniMax H3 query failed {}: {}",
                status, raw
            )));
        }

        info!("[MiniMax H3 Poll] raw response: {}", raw);

        // compshare 可能以 HTTP 200 返回错误体 {"type":"error",...}（如参数非法），
        // 视为任务失败（终态），避免前端无限轮询卡死。
        if let Some(err_msg) = Self::extract_error_body(&raw) {
            info!("[MiniMax H3] task {} FAILED (error body): {}", task_id, err_msg);
            return Ok(ProviderTaskPollResult::Failed(err_msg));
        }

        let resp: MinimaxQueryResponse = serde_json::from_str(&raw).map_err(|err| {
            AIError::Provider(format!("MiniMax H3 query invalid JSON: {}; raw={}", err, raw))
        })?;

        if let Some(code) = &resp.code {
            let msg = resp.message.as_deref().unwrap_or("unknown");
            if code != "0" && code != "Success" {
                return Err(AIError::Provider(format!(
                    "MiniMax H3 query API error [{}]: {}",
                    code, msg
                )));
            }
        }

        // 只要拿到视频 URL 就视为成功（可能早于 status 翻转为 succeeded）
        if let Some(url) = Self::extract_video_url(&resp) {
            info!("[MiniMax H3] task {} succeeded: {}", task_id, url);
            return Ok(ProviderTaskPollResult::Succeeded(url));
        }

        let task_status = Self::query_status(&resp);
        match task_status.as_str() {
            "SUCCEEDED" | "COMPLETED" | "SUCCESS" => {
                // status 已成功但还没 URL，继续轮询
                info!("[MiniMax H3] task {} status={} but no URL yet, keep polling", task_id, task_status);
                Ok(ProviderTaskPollResult::Running)
            }
            "FAILED" | "ERROR" | "CANCELLED" => {
                // compshare 把失败原因放在 task.error.message，取不到再退顶层 message
                let msg = resp
                    .task
                    .as_ref()
                    .and_then(|t| t.error.as_ref())
                    .and_then(|e| e.message.as_deref())
                    .filter(|m| !m.is_empty())
                    .map(|m| m.to_string())
                    .or_else(|| resp.message.clone().filter(|m| !m.is_empty()))
                    .unwrap_or_else(|| "生成失败".to_string());
                info!("[MiniMax H3] task {} FAILED: {}", task_id, msg);
                Ok(ProviderTaskPollResult::Failed(msg))
            }
            // queued / pending / waiting → 排队中，前端展示「排队中」提示
            "QUEUED" | "PENDING" | "WAITING" => {
                Ok(ProviderTaskPollResult::Queued)
            }
            // processing / running 等 → 生成中
            _ => Ok(ProviderTaskPollResult::Running),
        }
    }
}

impl Default for MiniMaxProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for MiniMaxProvider {
    fn name(&self) -> &str {
        "minimax"
    }

    fn supports_model(&self, model: &str) -> bool {
        Self::sanitize_model(model) == "minimax-h3"
    }

    fn list_models(&self) -> Vec<String> {
        vec!["minimax/minimax-h3".to_string()]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("MiniMax H3 API key not set".to_string()))?;

        let task_id = self.create_task(&api_key, &request).await?;

        loop {
            match self.poll_task_once(&api_key, &task_id).await? {
                ProviderTaskPollResult::Queued | ProviderTaskPollResult::Running => {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await
                }
                ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                ProviderTaskPollResult::Failed(message) => {
                    return Err(AIError::TaskFailed(message))
                }
            }
        }
    }

    async fn submit_task(
        &self,
        request: GenerateRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("MiniMax H3 API key not set".to_string()))?;

        let task_id = self.create_task(&api_key, &request).await?;

        // 通道固定为 compshare 直连，api_key 存入 metadata 用于跨会话续传
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: Some(serde_json::json!({
                "backend": "compshare",
                "api_key": api_key,
                "api_model": API_MODEL,
            })),
        }))
    }

    async fn poll_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = handle
            .metadata
            .as_ref()
            .and_then(|m| m.get("api_key")?.as_str().map(|s| s.to_string()))
            .or_else(|| {
                self.api_key
                    .try_read()
                    .ok()
                    .and_then(|guard| guard.clone())
            })
            .ok_or_else(|| {
                AIError::InvalidRequest(
                    "MiniMax H3 API key not set (not in metadata or provider)".to_string(),
                )
            })?;

        self.poll_task_once(&api_key, &handle.task_id).await
    }
}
