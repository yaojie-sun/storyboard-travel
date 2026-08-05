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

// ── DashScope (Alibaba Bailian direct) ──
const DASHSCOPE_BASE_URL: &str = "https://dashscope.aliyuncs.com";
const CREATE_VIDEO_PATH: &str = "/api/v1/services/aigc/video-generation/video-synthesis";
const DASHSCOPE_TASK_QUERY_PATH: &str = "/api/v1/tasks";

// ── Baidu VOD (transparent passthrough to Alibaba Bailian) ──
const BAIDU_VOD_BASE_URL: &str = "https://vod.bj.baidubce.com/v3/aigc/bailian";
const BAIDU_VOD_TASK_QUERY_URL: &str = "https://vod.bj.baidubce.com/v3/tasks";

const POLL_INTERVAL_MS: u64 = 15000;
const MAX_REFERENCE_IMAGES: usize = 9;

/// Backend to use for HappyHorse API calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Backend {
    /// Direct DashScope (Alibaba Bailian) access
    DashScope,
    /// Baidu VOD transparent passthrough
    BaiduVod,
}

// ── DashScope response types ──

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DashScopeCreateResponse {
    output: Option<DashScopeCreateOutput>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashScopeCreateOutput {
    task_id: String,
    #[serde(rename = "task_status")]
    task_status: String,
}

#[derive(Debug, Deserialize)]
struct DashScopeTaskResponse {
    output: Option<DashScopeTaskOutput>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashScopeTaskOutput {
    task_id: String,
    #[serde(rename = "task_status")]
    task_status: String,
    video_url: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

// ── Baidu VOD response types ──

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct BaiduVodTaskResponse {
    status: Option<String>,
    #[serde(rename = "videoUrl")]
    video_url: Option<String>,
    #[serde(rename = "videoGenerateTaskInfo")]
    video_gen_info: Option<serde_json::Value>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

pub struct HappyHorseProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
    backend: Backend,
    /// Model name to send in API requests (e.g. "happyhorse-1.0-r2v" or "happyhorse-1.1-r2v")
    api_model: String,
}

impl HappyHorseProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(3600))
                .connect_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
            api_key: Arc::new(RwLock::new(None)),
            backend: Backend::DashScope,
            api_model: "happyhorse-1.1-r2v".to_string(),
        }
    }

    /// Create a provider that routes through Baidu VOD (Bearer token auth).
    pub fn new_baidu_vod(model: &str) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(3600))
                .connect_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
            api_key: Arc::new(RwLock::new(None)),
            backend: Backend::BaiduVod,
            api_model: Self::sanitize_model(model),
        }
    }

    fn sanitize_model(model: &str) -> String {
        model
            .split_once('/')
            .map(|(_, bare)| bare.to_string())
            .unwrap_or_else(|| model.to_string())
    }

    fn is_valid_media_url(value: &str) -> bool {
        value.starts_with("http://") || value.starts_with("https://") || value.starts_with("data:")
    }

    /// 检查 base64 图片宽高比，低于 min_ratio 时上下加黑边补齐
    /// 短视频版特有：六宫格竖幅（9:16×3列2行）宽高比可能只有 0.375，需补齐到 0.40
    fn ensure_image_ratio(data_url: &str, min_ratio: f64) -> String {
        let (header, encoded) = match data_url.split_once(',') {
            Some((h, e)) if h.contains("data:image") => (h, e),
            _ => return data_url.to_string(),
        };

        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            return data_url.to_string();
        };

        let Ok(img) = image::load_from_memory(&bytes) else {
            return data_url.to_string();
        };

        let (w, h) = (img.width() as f64, img.height() as f64);
        let ratio = h / w;
        if ratio >= min_ratio {
            return data_url.to_string();
        }

        // 需要加黑边：新高度 = w * min_ratio
        let new_h = (w * min_ratio).ceil() as u32;
        let pad_top = (new_h - h as u32) / 2;
        let mut canvas = image::RgbaImage::new(w as u32, new_h);
        for pixel in canvas.pixels_mut() {
            *pixel = image::Rgba([0, 0, 0, 255]);
        }
        image::imageops::overlay(&mut canvas, &img.to_rgba8(), 0, pad_top as i64);

        let dyn_img = image::DynamicImage::ImageRgba8(canvas);
        let mut buf = Vec::new();
        if dyn_img
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
            .is_err()
        {
            return data_url.to_string();
        }
        let new_encoded = base64::engine::general_purpose::STANDARD.encode(&buf);
        format!("data:image/jpeg;base64,{}", new_encoded)
    }

    fn build_media_array(reference_images: &[String]) -> Vec<Value> {
        // 短视频版：参考图宽高比低于 0.40 时加黑边补齐
        const MIN_ASPECT_RATIO: f64 = 0.40;
        reference_images
            .iter()
            .take(MAX_REFERENCE_IMAGES)
            .filter(|url| Self::is_valid_media_url(url))
            .map(|url| {
                let fixed = if url.starts_with("data:") {
                    let before = url.len();
                    let result = Self::ensure_image_ratio(url, MIN_ASPECT_RATIO);
                    if result.len() != before {
                        info!("[HappyHorse] image padded to meet min aspect ratio {}", MIN_ASPECT_RATIO);
                    }
                    result
                } else {
                    url.clone()
                };
                json!({
                    "type": "reference_image",
                    "url": fixed
                })
            })
            .collect()
    }

    fn extract_baidu_vod_video_url(resp: &BaiduVodTaskResponse) -> Option<String> {
        // Direct videoUrl field
        if let Some(ref url) = resp.video_url {
            if !url.is_empty() {
                return Some(url.clone());
            }
        }
        // Nested VOD format: videoGenerateTaskInfo.videoGenerateTaskOutput.mediaBasicInfos[0].source.sourceUrl
        resp.video_gen_info
            .as_ref()
            .and_then(|info| info.get("videoGenerateTaskOutput"))
            .and_then(|output| output.get("mediaBasicInfos"))
            .and_then(|medias| medias.as_array())
            .and_then(|arr| arr.first())
            .and_then(|media| media.get("source"))
            .and_then(|source| source.get("sourceUrl"))
            .and_then(|url| url.as_str())
            .map(|s| s.to_string())
    }

    async fn create_task(
        &self,
        api_key: &str,
        request: &GenerateRequest,
        reference_images: &[String],
    ) -> Result<String, AIError> {
        let duration = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("duration_seconds"))
            .and_then(|raw| raw.as_u64())
            .unwrap_or(5) as u32;

        let resolution = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("resolution"))
            .and_then(|raw| raw.as_str())
            .unwrap_or("720P")
            .to_string();

        let media = Self::build_media_array(reference_images);

        let body = json!({
            "model": self.api_model,
            "input": {
                "prompt": request.prompt,
                "media": media
            },
            "parameters": {
                "resolution": resolution,
                "ratio": request.aspect_ratio,
                "duration": duration,
                "watermark": false
            }
        });

        let (endpoint, log_tag) = match self.backend {
            Backend::DashScope => (
                format!("{}{}", DASHSCOPE_BASE_URL, CREATE_VIDEO_PATH),
                "HappyHorse-DashScope",
            ),
            Backend::BaiduVod => (
                format!("{}{}", BAIDU_VOD_BASE_URL, CREATE_VIDEO_PATH),
                "HappyHorse-BaiduVOD",
            ),
        };

        info!(
            "[{} createTask] model={}, duration={}, resolution={}, ratio={}, refs={}, promptLen={}",
            log_tag, self.api_model, duration, resolution, request.aspect_ratio,
            reference_images.len(), request.prompt.chars().count()
        );
        info!(
            "[{} createTask] FULL PROMPT:\n{}",
            log_tag, request.prompt
        );

        let mut req = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json");

        // DashScope requires async header; Baidu VOD doesn't need it
        if self.backend == Backend::DashScope {
            req = req.header("X-DashScope-Async", "enable");
        }

        let response = req.json(&body).send().await?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "{} createTask failed {}: {}",
                log_tag, status, raw_response
            )));
        }

        match self.backend {
            Backend::DashScope => {
                let resp: DashScopeCreateResponse =
                    serde_json::from_str(&raw_response).map_err(|err| {
                        AIError::Provider(format!(
                            "{} createTask invalid JSON: {}; raw={}",
                            log_tag, err, raw_response
                        ))
                    })?;
                if let Some(code) = resp.code {
                    let msg = resp.message.unwrap_or_else(|| "unknown error".to_string());
                    return Err(AIError::Provider(format!(
                        "{} createTask API error [{}]: {}",
                        log_tag, code, msg
                    )));
                }
                resp.output
                    .map(|o| o.task_id)
                    .ok_or_else(|| AIError::Provider(format!("{} createTask missing task_id", log_tag)))
            }
            Backend::BaiduVod => {
                // HappyHorse via Baidu VOD is a transparent passthrough of Alibaba Bailian.
                // The create response uses Alibaba format: {"output":{"task_id":"...","task_status":"PENDING"}}
                // Try Alibaba format first, fall back to Baidu VOD format.
                let raw = &raw_response;

                // Try Alibaba/DashScope format first
                if let Ok(resp) = serde_json::from_str::<DashScopeCreateResponse>(raw) {
                    if let Some(code) = resp.code {
                        let msg = resp.message.unwrap_or_else(|| "unknown error".to_string());
                        return Err(AIError::Provider(format!(
                            "{} createTask API error [{}]: {}",
                            log_tag, code, msg
                        )));
                    }
                    if let Some(task_id) = resp.output.and_then(|o| if o.task_id.is_empty() { None } else { Some(o.task_id) }) {
                        return Ok(task_id);
                    }
                }

                // Fall back to Baidu VOD format: {"taskId":"...","code":"0"}
                if let Ok(resp) = serde_json::from_str::<BaiduVodTaskResponse>(raw) {
                    if let Some(code) = &resp.code {
                        let msg = resp.message.as_deref().unwrap_or("unknown");
                        if code != "0" && code != "Success" {
                            return Err(AIError::Provider(format!(
                                "{} createTask API error [{}]: {}",
                                log_tag, code, msg
                            )));
                        }
                    }
                    if let Some(task_id) = resp.task_id {
                        return Ok(task_id);
                    }
                }

                return Err(AIError::Provider(format!(
                    "{} createTask: unable to extract task_id from response: {}",
                    log_tag, raw_response
                )));
            }
        }
    }

    async fn poll_task_once(
        &self,
        api_key: &str,
        task_id: &str,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let (endpoint, log_tag) = match self.backend {
            Backend::DashScope => (
                format!("{}{}/{}", DASHSCOPE_BASE_URL, DASHSCOPE_TASK_QUERY_PATH, task_id),
                "HappyHorse-DashScope",
            ),
            Backend::BaiduVod => (
                format!("{}/{}", BAIDU_VOD_TASK_QUERY_URL, task_id),
                "HappyHorse-BaiduVOD",
            ),
        };

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "{} task query failed {}: {}",
                log_tag, status, raw_response
            )));
        }

        match self.backend {
            Backend::DashScope => {
                let resp: DashScopeTaskResponse =
                    serde_json::from_str(&raw_response).map_err(|err| {
                        AIError::Provider(format!(
                            "{} task query invalid JSON: {}; raw={}",
                            log_tag, err, raw_response
                        ))
                    })?;
                if let Some(code) = resp.code {
                    let msg = resp.message.unwrap_or_else(|| "unknown error".to_string());
                    return Err(AIError::Provider(format!(
                        "{} task query API error [{}]: {}",
                        log_tag, code, msg
                    )));
                }
                let output = resp.output.ok_or_else(|| {
                    AIError::Provider(format!("{} task query missing output", log_tag))
                })?;
                match output.task_status.as_str() {
                    "SUCCEEDED" => {
                        let video_url = output.video_url.ok_or_else(|| {
                            AIError::Provider(format!("{} SUCCEEDED but missing video_url", log_tag))
                        })?;
                        info!("[{}] task {} succeeded: {}", log_tag, task_id, video_url);
                        Ok(ProviderTaskPollResult::Succeeded(video_url))
                    }
                    "FAILED" => {
                        let fail_msg = output.message.unwrap_or_else(|| "task failed".to_string());
                        Ok(ProviderTaskPollResult::Failed(fail_msg))
                    }
                    "PENDING" | "RUNNING" => Ok(ProviderTaskPollResult::Running),
                    other => Err(AIError::Provider(format!(
                        "{} unexpected task status: {}",
                        log_tag, other
                    ))),
                }
            }
            Backend::BaiduVod => {
                info!("[{}] poll raw response: {}", log_tag, raw_response);
                let resp: BaiduVodTaskResponse =
                    serde_json::from_str(&raw_response).map_err(|err| {
                        AIError::Provider(format!(
                            "{} task query invalid JSON: {}; raw={}",
                            log_tag, err, raw_response
                        ))
                    })?;
                if let Some(code) = &resp.code {
                    let msg = resp.message.as_deref().unwrap_or("unknown");
                    if code != "0" && code != "Success" {
                        return Err(AIError::Provider(format!(
                            "{} task query API error [{}]: {}",
                            log_tag, code, msg
                        )));
                    }
                }
                let task_status = resp.status.as_deref().unwrap_or("").to_uppercase();
                match task_status.as_str() {
                    "SUCCEEDED" | "COMPLETED" | "SUCCESS" => {
                        let url = Self::extract_baidu_vod_video_url(&resp)
                            .ok_or_else(|| {
                                AIError::Provider(format!("{} succeeded but no video URL", log_tag))
                            })?;
                        info!("[{}] task {} succeeded: {}", log_tag, task_id, url);
                        Ok(ProviderTaskPollResult::Succeeded(url))
                    }
                    "FAILED" | "ERROR" => {
                        let msg = resp.message.unwrap_or_else(|| "生成失败".to_string());
                        info!("[{}] task {} FAILED: {}", log_tag, task_id, msg);
                        Ok(ProviderTaskPollResult::Failed(msg))
                    }
                    "READY" | "PENDING" | "RUNNING" | "PROCESSING" | _ => {
                        Ok(ProviderTaskPollResult::Running)
                    }
                }
            }
        }
    }
}

impl Default for HappyHorseProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for HappyHorseProvider {
    fn name(&self) -> &str {
        "happyhorse"
    }

    fn supports_model(&self, model: &str) -> bool {
        let bare = Self::sanitize_model(model);
        matches!(
            bare.as_str(),
            "happyhorse-1.0-r2v" | "happyhorse-1.1-r2v"
        )
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "happyhorse/happyhorse-1.0-r2v".to_string(),
            "happyhorse/happyhorse-1.1-r2v".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
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
            .ok_or_else(|| AIError::InvalidRequest("欢乐马 API key not set".to_string()))?;

        let refs = request.reference_images.as_deref().unwrap_or(&[]);
        let task_id = self.create_task(&api_key, &request, refs).await?;

        // Store backend type + api_key in metadata for cross-session resume
        let backend_tag = match self.backend {
            Backend::DashScope => "dashscope",
            Backend::BaiduVod => "baidu_vod",
        };
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: Some(serde_json::json!({
                "backend": backend_tag,
                "api_key": api_key,
                "api_model": self.api_model,
            })),
        }))
    }

    async fn poll_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        // Try to read api_key from stored metadata first (for cross-session resume),
        // fall back to provider's own api_key
        let api_key = handle
            .metadata
            .as_ref()
            .and_then(|m| m.get("api_key")?.as_str().map(|s| s.to_string()))
            .or_else(|| {
                // Fallback: try provider's stored key
                self.api_key
                    .try_read()
                    .ok()
                    .and_then(|guard| guard.clone())
            })
            .ok_or_else(|| AIError::InvalidRequest("欢乐马 API key not set (not in metadata or provider)".to_string()))?;

        self.poll_task_once(&api_key, &handle.task_id).await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("欢乐马 API key not set".to_string()))?;

        let refs = request.reference_images.as_deref().unwrap_or(&[]);
        let task_id = self.create_task(&api_key, &request, refs).await?;

        loop {
            match self.poll_task_once(&api_key, &task_id).await? {
                ProviderTaskPollResult::Running => {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await
                }
                ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                ProviderTaskPollResult::Failed(message) => {
                    return Err(AIError::TaskFailed(message))
                }
            }
        }
    }
}
