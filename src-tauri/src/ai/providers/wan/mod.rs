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

const DASHSCOPE_BASE_URL: &str = "https://dashscope.aliyuncs.com";
const CREATE_VIDEO_PATH: &str = "/api/v1/services/aigc/video-generation/video-synthesis";
const TASK_QUERY_PATH: &str = "/api/v1/tasks";
const POLL_INTERVAL_MS: u64 = 15000;

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

pub struct WanProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl WanProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(3600))
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

    fn is_valid_media_url(value: &str) -> bool {
        value.starts_with("http://") || value.starts_with("https://") || value.starts_with("data:")
    }

    fn build_media_array(reference_images: &[String]) -> Vec<Value> {
        reference_images
            .iter()
            .filter(|url| Self::is_valid_media_url(url))
            .map(|url| {
                json!({
                    "type": "reference_image",
                    "url": url
                })
            })
            .collect()
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

        let prompt_extend = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("prompt_extend"))
            .and_then(|raw| raw.as_bool())
            .unwrap_or(false); // 默认关闭 — 分镜提示词精心编写，开启会导致 AI 改写偏离宫格图

        let negative_prompt = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("negative_prompt"))
            .and_then(|raw| raw.as_str())
            .map(|s| s.to_string());

        let guidance_scale = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("guidance_scale"))
            .and_then(|raw| raw.as_f64());

        let shot_type = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("shot_type"))
            .and_then(|raw| raw.as_str())
            .map(|s| s.to_string());

        let seed = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("seed"))
            .and_then(|raw| raw.as_u64())
            .map(|s| s as u32);

        let reference_voice = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("reference_voice"))
            .and_then(|raw| raw.as_str())
            .filter(|s| !s.is_empty());

        let mut media = Self::build_media_array(reference_images);
        // Attach reference_voice to each reference_image media entry
        if let Some(voice_url) = reference_voice {
            for m in &mut media {
                if m.get("type").and_then(|v| v.as_str()) == Some("reference_image") {
                    m["reference_voice"] = json!(voice_url);
                }
            }
        }

        info!(
            "[Wan createTask] model=wan2.7-r2v, duration={}, resolution={}, ratio={}, seed={:?}, refs={}, promptExtend={}, negPromptLen={}, guidanceScale={:?}, shotType={:?}, promptLen={}",
            duration, resolution, request.aspect_ratio, seed, reference_images.len(),
            prompt_extend, negative_prompt.as_ref().map(|s| s.len() as i64).unwrap_or(-1),
            guidance_scale, shot_type, request.prompt.chars().count()
        );
        info!(
            "[Wan createTask] FULL PROMPT:\n{}",
            request.prompt
        );

        let mut body = json!({
            "model": "wan2.7-r2v",
            "input": {
                "prompt": request.prompt,
                "media": media
            },
            "parameters": {
                "resolution": resolution,
                "ratio": request.aspect_ratio,
                "duration": duration,
                "prompt_extend": prompt_extend,
                "watermark": false
            }
        });

        if let Some(s) = seed {
            body["parameters"]["seed"] = json!(s);
        }

        if let Some(gs) = guidance_scale {
            body["parameters"]["guidance_scale"] = json!(gs);
        }

        if let Some(ref st) = shot_type {
            if !st.is_empty() {
                body["parameters"]["shot_type"] = json!(st);
            }
        }

        if let Some(ref neg) = negative_prompt {
            if !neg.is_empty() {
                body["input"]["negative_prompt"] = json!(neg);
            }
        }

        let endpoint = format!("{}{}", DASHSCOPE_BASE_URL, CREATE_VIDEO_PATH);

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("X-DashScope-Async", "enable")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            // Extract error code from response body if available
            let code = serde_json::from_str::<serde_json::Value>(&raw_response)
                .ok()
                .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(|s| s.to_string()));
            let prefix = code.as_deref().unwrap_or("HTTP_ERROR");
            return Err(AIError::Provider(format!(
                "[WAN_{}] {}",
                prefix, raw_response
            )));
        }

        let resp: DashScopeCreateResponse =
            serde_json::from_str(&raw_response).map_err(|err| {
                AIError::Provider(format!(
                    "万相 createTask invalid JSON: {}; raw={}",
                    err, raw_response
                ))
            })?;

        if let Some(code) = resp.code {
            let msg = resp.message.unwrap_or_else(|| "unknown error".to_string());
            return Err(AIError::Provider(format!(
                "[WAN_{}] 万相 createTask API error: {}",
                code, msg
            )));
        }

        resp.output
            .map(|o| o.task_id)
            .ok_or_else(|| AIError::Provider("万相 createTask missing task_id".to_string()))
    }

    async fn poll_task_once(
        &self,
        api_key: &str,
        task_id: &str,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let endpoint = format!("{}{}/{}", DASHSCOPE_BASE_URL, TASK_QUERY_PATH, task_id);

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            let code = serde_json::from_str::<serde_json::Value>(&raw_response)
                .ok()
                .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(|s| s.to_string()));
            let prefix = code.as_deref().unwrap_or("HTTP_ERROR");
            return Err(AIError::Provider(format!(
                "[WAN_{}] {}",
                prefix, raw_response
            )));
        }

        let resp: DashScopeTaskResponse =
            serde_json::from_str(&raw_response).map_err(|err| {
                AIError::Provider(format!(
                    "万相 task query invalid JSON: {}; raw={}",
                    err, raw_response
                ))
            })?;

        if let Some(code) = resp.code {
            let msg = resp.message.unwrap_or_else(|| "unknown error".to_string());
            return Err(AIError::Provider(format!(
                "万相 task query API error [{}]: {}",
                code, msg
            )));
        }

        let output = resp.output.ok_or_else(|| {
            AIError::Provider("万相 task query missing output".to_string())
        })?;

        match output.task_status.as_str() {
            "SUCCEEDED" => {
                let video_url = output.video_url.ok_or_else(|| {
                    AIError::Provider("万相 SUCCEEDED but missing video_url".to_string())
                })?;
                info!("[Wan] task {} succeeded: {}", task_id, video_url);
                Ok(ProviderTaskPollResult::Succeeded(video_url))
            }
            "FAILED" => {
                let raw_msg = output
                    .message
                    .unwrap_or_else(|| "万相 task failed".to_string());
                // Prepend error code if available so the frontend can display categorized messages
                let fail_msg = match &output.code {
                    Some(code) => format!("[WAN_{}] {}", code, raw_msg),
                    None => raw_msg,
                };
                Ok(ProviderTaskPollResult::Failed(fail_msg))
            }
            "PENDING" | "RUNNING" => Ok(ProviderTaskPollResult::Running),
            other => Err(AIError::Provider(format!(
                "万相 unexpected task status: {}",
                other
            ))),
        }
    }
}

impl Default for WanProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for WanProvider {
    fn name(&self) -> &str {
        "wan"
    }

    fn supports_model(&self, model: &str) -> bool {
        Self::sanitize_model(model) == "wan2.7-r2v"
    }

    fn list_models(&self) -> Vec<String> {
        vec!["wan/wan2.7-r2v".to_string()]
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
            .ok_or_else(|| AIError::InvalidRequest("万相 API key not set".to_string()))?;

        let refs = request.reference_images.as_deref().unwrap_or(&[]);
        let task_id = self.create_task(&api_key, &request, refs).await?;

        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: None,
        }))
    }

    async fn poll_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("万相 API key not set".to_string()))?;

        self.poll_task_once(&api_key, &handle.task_id).await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("万相 API key not set".to_string()))?;

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
