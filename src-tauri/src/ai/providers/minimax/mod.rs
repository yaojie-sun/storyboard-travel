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

// ── MiniMax H3 via 百度 VOD 原生透传 ──
// 只走百度 VOD 通道（vod.bj.baidubce.com/v3/aigc/minimax），
// 复用 BAIDU_VIDEO_KEY，不通过 MiniMax 直连 token、不碰阿里云、不碰 wan2.7。
const BASE_URL: &str = "https://vod.bj.baidubce.com/v3/aigc/minimax";
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

    /// 检测 MiniMax/百度 VOD 以 HTTP 200 返回的错误体 {"type":"error",...}，
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
    /// 参考图走 base64 直传（百度 VOD 透传，不经七牛）。
    fn build_content(prompt: &str, reference_images: &[String]) -> Vec<Value> {
        let mut content: Vec<Value> = vec![json!({
            "type": "text",
            "text": prompt,
        })];
        for ref_img in reference_images {
            if ref_img.starts_with("data:") {
                // base64 参考图：H3 单边上限 5760，超限先等比缩放
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
        let duration = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("duration_seconds"))
            .and_then(|raw| raw.as_u64())
            .unwrap_or(5) as u32;

        // H3 只支持 768P / 2K，不支持 720P。banana_api 写入的 key 是 quality（小写 "720p"），
        // 这里统一归一化为 "768P"（H3 最低档），积分档位仍按原 720P 计、不变。
        let resolution = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("quality"))
            .and_then(|raw| raw.as_str())
            .map(|q| {
                if q.eq_ignore_ascii_case("720p") {
                    "768P".to_string()
                } else {
                    q.to_uppercase()
                }
            })
            .unwrap_or_else(|| "768P".to_string());

        let reference_images = request.reference_images.as_deref().unwrap_or(&[]);
        let content = Self::build_content(&request.prompt, reference_images);

        let body = json!({
            "model": API_MODEL,
            "content": content,
            "resolution": resolution,
            "duration": duration,
            "ratio": request.aspect_ratio,
        });

        let endpoint = format!("{}{}", BASE_URL, CREATE_PATH);
        info!(
            "[MiniMax H3 createTask] model={}, duration={}, resolution={}, ratio={}, refs={}, promptLen={}",
            API_MODEL, duration, resolution, request.aspect_ratio,
            reference_images.len(), request.prompt.chars().count()
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
        let key_prefix = if api_key.len() > 20 { &api_key[..20] } else { api_key };
        info!("[MiniMax H3 Poll] url={}, key={}...", endpoint, key_prefix);

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

        // 百度 VOD 可能以 HTTP 200 返回错误体 {"type":"error",...}（如参数非法），
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
                let msg = resp.message.unwrap_or_else(|| "生成失败".to_string());
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

        // 通道固定为百度 VOD，api_key 存入 metadata 用于跨会话续传
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: Some(serde_json::json!({
                "backend": "baidu_vod",
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
