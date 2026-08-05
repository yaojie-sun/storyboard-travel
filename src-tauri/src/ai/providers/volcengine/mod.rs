use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{AIProvider, GenerateRequest};

const BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";
const GENERATIONS_PATH: &str = "/images/generations";

/// Max reference images supported by Seedream 5.0 / 4.0
const MAX_REFERENCE_IMAGES: usize = 14;

#[derive(Debug, Deserialize)]
struct ImageData {
    url: Option<String>,
    #[serde(rename = "b64_json")]
    #[allow(dead_code)]
    b64_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GenerationResponse {
    data: Option<Vec<ImageData>>,
    error: Option<VolcError>,
}

#[derive(Debug, Deserialize)]
struct VolcError {
    message: Option<String>,
    #[allow(dead_code)]
    code: Option<String>,
}

pub struct VolcengineProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl VolcengineProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(300))
                .connect_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
            api_key: Arc::new(RwLock::new(None)),
        }
    }

    fn api_key_or_err(lock: &RwLock<Option<String>>) -> Result<String, AIError> {
        lock.try_read()
            .map_err(|_| AIError::InvalidRequest("Volcengine API key lock poisoned".to_string()))?
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("Volcengine API key not set".to_string()))
    }

    fn sanitize_model(model: &str) -> String {
        model
            .split_once('/')
            .map(|(_, bare)| bare.to_string())
            .unwrap_or_else(|| model.to_string())
    }

    // ─── source → bytes (shared logic) ───

    fn decode_file_url_path(value: &str) -> String {
        let raw = value.trim_start_matches("file://");
        let decoded = urlencoding::decode(raw)
            .map(|r| r.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        if decoded.starts_with('/') && decoded.len() > 2 && decoded.as_bytes().get(2) == Some(&b':')
        {
            decoded[1..].to_string()
        } else {
            decoded
        }
    }

    fn source_to_bytes(source: &str) -> Result<Vec<u8>, String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("source is empty".to_string());
        }

        if let Some((meta, payload)) = trimmed.split_once(',') {
            if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
                return STANDARD
                    .decode(payload)
                    .map_err(|e| format!("invalid data-url base64: {}", e));
            }
        }

        let likely_base64 = trimmed.len() > 256
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
        if likely_base64 {
            return STANDARD
                .decode(trimmed)
                .map_err(|e| format!("invalid base64: {}", e));
        }

        if trimmed.starts_with("asset://")
            || trimmed.starts_with("tauri://")
            || trimmed.starts_with("app://")
        {
            return Err(format!("unsupported local protocol: {}", trimmed));
        }

        let path = if trimmed.starts_with("file://") {
            PathBuf::from(Self::decode_file_url_path(trimmed))
        } else {
            PathBuf::from(trimmed)
        };
        std::fs::read(&path)
            .map_err(|e| format!("failed to read path \"{}\": {}", path.to_string_lossy(), e))
    }

    fn is_http_url(value: &str) -> bool {
        value.starts_with("http://") || value.starts_with("https://")
    }

    fn is_data_url(value: &str) -> bool {
        value.starts_with("data:image/") && value.contains(";base64,")
    }

    /// Convert source (file path, raw base64, data URL, or HTTP URL) to a format
    /// Seedream accepts: HTTP URL as-is, data URL as-is, everything else → base64 data URL
    fn prepare_reference(&self, source: &str) -> Result<String, AIError> {
        if Self::is_http_url(source) || Self::is_data_url(source) {
            return Ok(source.to_string());
        }

        let bytes = Self::source_to_bytes(source).map_err(|e| {
            AIError::InvalidRequest(format!(
                "Failed to read reference image for Seedream: {}",
                e
            ))
        })?;

        let mime = if source.to_lowercase().ends_with(".png") {
            "image/png"
        } else if source.to_lowercase().ends_with(".webp") {
            "image/webp"
        } else {
            "image/jpeg"
        };

        let b64 = STANDARD.encode(&bytes);
        Ok(format!("data:{};base64,{}", mime, b64))
    }

    fn prepare_reference_images(
        &self,
        reference_images: &[String],
    ) -> Result<Vec<String>, AIError> {
        let capped = reference_images
            .iter()
            .take(MAX_REFERENCE_IMAGES)
            .collect::<Vec<_>>();
        let mut prepared = Vec::with_capacity(capped.len());
        for source in capped {
            prepared.push(self.prepare_reference(source)?);
        }
        Ok(prepared)
    }

    // ─── API call ───

    async fn call_generate(
        &self,
        api_key: &str,
        model: &str,
        prompt: &str,
        size: &str,
        ref_images: Vec<String>,
        extra_params: &Option<std::collections::HashMap<String, serde_json::Value>>,
    ) -> Result<String, AIError> {
        let endpoint = format!("{}{}", BASE_URL, GENERATIONS_PATH);

        let seq_mode = extra_params
            .as_ref()
            .and_then(|p| p.get("sequential_image_generation"))
            .and_then(|v| v.as_str())
            .unwrap_or("disabled");

        let mut body = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "size": size,
            "sequential_image_generation": seq_mode,
            "response_format": "url",
            "stream": false,
            "watermark": false,
        });

        if !ref_images.is_empty() {
            body["image"] = serde_json::json!(ref_images);
        }

        info!(
            "[Seedream] request: model={}, prompt_len={}, size={}, refs={}, seq={}",
            model,
            prompt.len(),
            size,
            ref_images.len(),
            seq_mode
        );

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AIError::Provider(format!("Seedream request failed: {}", e)))?;

        let status = response.status();
        let raw = response.text().await.unwrap_or_default();

        // 始终记录完整响应（成功 + 失败）
        info!("[Seedream] HTTP {} response ({} bytes): {}", status.as_u16(), raw.len(), raw);

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "Seedream HTTP {}: {}",
                status,
                raw
            )));
        }

        let parsed = serde_json::from_str::<GenerationResponse>(&raw).map_err(|e| {
            AIError::Provider(format!(
                "Seedream invalid response JSON: {}; raw={}",
                e, raw
            ))
        })?;

        if let Some(err) = parsed.error {
            return Err(AIError::Provider(format!(
                "Seedream API error: {}",
                err.message.unwrap_or_else(|| "unknown error".to_string())
            )));
        }

        let data_list = parsed
            .data
            .ok_or_else(|| AIError::Provider(format!("Seedream response missing data field; raw={}", raw)))?;

        let first_url = data_list
            .iter()
            .find_map(|d| d.url.as_ref().cloned())
            .ok_or_else(|| AIError::Provider(format!(
                "Seedream response has no result URL; raw={}",
                raw
            )))?;

        info!("[Seedream] generated ({} images total): {}", data_list.len(), first_url);
        Ok(first_url)
    }
}

impl Default for VolcengineProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for VolcengineProvider {
    fn name(&self) -> &str {
        "volcengine"
    }

    fn supports_model(&self, model: &str) -> bool {
        let bare = Self::sanitize_model(model);
        bare.starts_with("doubao-seedream-")
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "volcengine/doubao-seedream-5-0-260128".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        info!("[Seedream] API key set");
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        false
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = Self::api_key_or_err(&self.api_key)?;
        let model = Self::sanitize_model(&request.model);
        let refs = request.reference_images.as_deref().unwrap_or(&[]);

        info!(
            "[Seedream] generate: model={}, size={}, aspect_ratio={}, refs={}",
            model,
            request.size,
            request.aspect_ratio,
            refs.len()
        );

        let prepared = self.prepare_reference_images(refs)?;
        self.call_generate(
            &api_key,
            &model,
            &request.prompt,
            &request.size,
            prepared,
            &request.extra_params,
        )
        .await
    }
}
