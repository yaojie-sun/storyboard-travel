use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;
use uuid::Uuid;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

// PixVerse C1 via Baidu VOD v3 (Bearer Token auth)
const BASE_URL: &str = "https://vod.bj.baidubce.com/v3/aigc/pv";
const TEXT_GENERATE_PATH: &str = "/video/text/generate";
const FUSION_GENERATE_PATH: &str = "/video/fusion/generate";
const TASKS_BASE_URL: &str = "https://vod.bj.baidubce.com/v3";
const STATUS_PATH: &str = "tasks";
const POLL_INTERVAL_MS: u64 = 10000;

#[derive(Debug, Deserialize)]
struct TaskResponse {
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

pub struct PixVerseProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl PixVerseProvider {
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

    fn extract_video_url(resp: &TaskResponse) -> Option<String> {
        // PixVerse format: videoUrl
        if let Some(ref url) = resp.video_url {
            if !url.is_empty() {
                return Some(url.clone());
            }
        }
        // Standard VOD format: videoGenerateTaskInfo.videoGenerateTaskOutput.mediaBasicInfos[0].source.sourceUrl
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
    ) -> Result<String, AIError> {
        let duration = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("duration_seconds"))
            .and_then(|raw| raw.as_u64())
            .unwrap_or(5) as u32;

        let quality = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("quality"))
            .and_then(|raw| raw.as_str())
            .unwrap_or("720p")
            .to_string();

        let reference_images = request
            .reference_images
            .as_deref()
            .unwrap_or(&[]);

        // Fusion mode: single grid image with @ref syntax
        let has_refs = !reference_images.is_empty();
        let (endpoint, mut body) = if has_refs {
            let ref_img = &reference_images[0];
            let ref_url = if ref_img.starts_with("http://") || ref_img.starts_with("https://") {
                ref_img.clone()
            } else if ref_img.starts_with("data:") {
                ref_img.clone()
            } else {
                ref_img.clone()
            };

            // Fusion mode: single storyboard grid image as background reference.
            // Prompt rules are injected by the frontend from video_gen_rules_pixverse_c1.json.
            let fusion_prompt = if request.prompt.contains('@') {
                request.prompt.clone()
            } else {
                format!("@storyboard {}", request.prompt)
            };

            let b = json!({
                "model": "c1",
                "prompt": fusion_prompt,
                "duration": duration,
                "quality": quality,
                "aspect_ratio": request.aspect_ratio,
                "generate_audio_switch": true,
                "image_references": [
                    {
                        "type": "background",
                        "image_url": ref_url,
                        "ref_name": "storyboard"
                    }
                ]
            });
            (format!("{}{}", BASE_URL, FUSION_GENERATE_PATH), b)
        } else {
            let b = json!({
                "model": "c1",
                "prompt": request.prompt,
                "duration": duration,
                "quality": quality,
                "aspect_ratio": request.aspect_ratio,
                "generate_audio_switch": true,
            });
            (format!("{}{}", BASE_URL, TEXT_GENERATE_PATH), b)
        };

        // Note: negative_prompt is NOT sent — Fusion endpoint returns 400017

        info!(
            "[PixVerse C1] mode={}, duration={}, quality={}, ratio={}, refs={}, prompt_len={}, body={}",
            if has_refs { "fusion" } else { "text" },
            duration,
            quality,
            request.aspect_ratio,
            reference_images.len(),
            request.prompt.len(),
            serde_json::to_string(&body).unwrap_or_default()
        );

        let trace_id = Uuid::new_v4().to_string();
        let key_prefix = if api_key.len() > 20 { &api_key[..20] } else { api_key };
        info!("[PixVerse Create] using key prefix: {}..., endpoint={}", key_prefix, endpoint);
        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("X-Bce-Trace-Id", &trace_id)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let raw = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "PixVerse create failed {}: {}",
                status, raw
            )));
        }

        // Parse response: supports both {"taskId":"..."} and {"code":...,"message":...}
        info!("[PixVerse Create] raw response: {}", raw);
        let task_resp: TaskResponse = serde_json::from_str(&raw).map_err(|err| {
            AIError::Provider(format!("PixVerse create invalid JSON: {}; raw={}", err, raw))
        })?;

        // Check for API error
        if let Some(code) = &task_resp.code {
            let msg = task_resp.message.as_deref().unwrap_or("unknown");
            if code != "0" && code != "Success" {
                return Err(AIError::Provider(format!(
                    "PixVerse API error [{}]: {}", code, msg
                )));
            }
        }

        task_resp.task_id
            .ok_or_else(|| AIError::Provider(format!("PixVerse create missing taskId. raw={}", raw)))
    }

    async fn poll_task_once(
        &self,
        api_key: &str,
        task_id: &str,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let endpoint = format!("{}/{}/{}", TASKS_BASE_URL, STATUS_PATH, task_id);
        let key_prefix = if api_key.len() > 20 { &api_key[..20] } else { api_key };
        info!("[PixVerse Poll] url={}, key={}...", endpoint, key_prefix);

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
                "PixVerse status failed {}: {}",
                status, raw
            )));
        }

        info!("[PixVerse Poll] raw response: {}", raw);

        let task_resp: TaskResponse = serde_json::from_str(&raw).map_err(|err| {
            AIError::Provider(format!("PixVerse status invalid JSON: {}; raw={}", err, raw))
        })?;

        // Check for API error
        if let Some(code) = &task_resp.code {
            let msg = task_resp.message.as_deref().unwrap_or("unknown");
            if code != "0" && code != "Success" {
                return Err(AIError::Provider(format!(
                    "PixVerse status error [{}]: {}", code, msg
                )));
            }
        }

        let task_status = task_resp.status.as_deref().unwrap_or("").to_uppercase();
        match task_status.as_str() {
            "SUCCEEDED" | "COMPLETED" | "SUCCESS" => {
                let url = Self::extract_video_url(&task_resp)
                    .ok_or_else(|| AIError::Provider("PixVerse succeeded but no video URL".to_string()))?;
                Ok(ProviderTaskPollResult::Succeeded(url))
            }
            "FAILED" | "ERROR" => {
                let msg = task_resp.message.unwrap_or_else(|| "生成失败".to_string());
                Ok(ProviderTaskPollResult::Failed(msg))
            }
            "READY" | "PENDING" | "RUNNING" | "PROCESSING" | _ => {
                Ok(ProviderTaskPollResult::Running)
            }
        }
    }
}

impl Default for PixVerseProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for PixVerseProvider {
    fn name(&self) -> &str {
        "pixverse"
    }

    fn supports_model(&self, model: &str) -> bool {
        Self::sanitize_model(model) == "c1"
    }

    fn list_models(&self) -> Vec<String> {
        vec!["pixverse/c1".to_string()]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn generate(&self, _request: GenerateRequest) -> Result<String, AIError> {
        Err(AIError::Provider("PixVerse requires async submission".to_string()))
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
            .ok_or_else(|| AIError::InvalidRequest("PixVerse API key not set".to_string()))?;

        let task_id = self.create_task(&api_key, &request).await?;

        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: Some(serde_json::json!({
                "api_key": api_key,
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
            .unwrap_or_default();

        if api_key.is_empty() {
            return Err(AIError::InvalidRequest("PixVerse handle missing api_key".to_string()));
        }

        self.poll_task_once(&api_key, &handle.task_id).await
    }
}
