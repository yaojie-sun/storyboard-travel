use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, GenericImageView, RgbaImage};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::Duration;
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{AIProvider, GenerateRequest};

const BASE_URL: &str = "https://vod.bj.baidubce.com";
const EDITS_PATH: &str = "/v3/aigc/v1/images/edits";
const MAX_REFERENCE_IMAGES: usize = 6;

#[derive(Debug, Deserialize)]
struct BaiduImageResponse {
    data: Vec<BaiduImageData>,
}

#[derive(Debug, Deserialize)]
struct BaiduImageData {
    b64_json: String,
}

pub struct BaiduProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl BaiduProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(1500))
                .connect_timeout(Duration::from_secs(60))
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

    /// Convert aspect ratio to pixel dimensions.
    /// Longest side = 2048px, shorter side calculated proportionally,
    /// both rounded to multiples of 16.
    fn aspect_ratio_to_size(aspect_ratio: &str) -> Result<String, AIError> {
        let parts: Vec<&str> = aspect_ratio.split(':').collect();
        if parts.len() != 2 {
            return Err(AIError::InvalidRequest(format!(
                "Invalid aspect ratio: {}",
                aspect_ratio
            )));
        }
        let w: f64 = parts[0]
            .trim()
            .parse()
            .map_err(|_| AIError::InvalidRequest(format!("Invalid aspect ratio: {}", aspect_ratio)))?;
        let h: f64 = parts[1]
            .trim()
            .parse()
            .map_err(|_| AIError::InvalidRequest(format!("Invalid aspect ratio: {}", aspect_ratio)))?;

        let max_px = 2048.0;
        let (pw, ph) = if w >= h {
            (max_px, (max_px * h / w).round())
        } else {
            ((max_px * w / h).round(), max_px)
        };

        let pw = ((pw / 16.0).round() * 16.0) as u32;
        let ph = ((ph / 16.0).round() * 16.0) as u32;
        Ok(format!("{}x{}", pw, ph))
    }

    /// Composite multiple reference images into a single reference sheet.
    /// 1→1 row×1 col | 2→1×2 | 3→1×3 | 4-6→2 rows×3 cols
    fn composite_reference_images(sources: &[String]) -> Result<(Vec<u8>, Vec<(usize, String)>), AIError> {
        if sources.is_empty() {
            return Err(AIError::InvalidRequest("至少需要一张参考图".to_string()));
        }

        let loaded: Vec<(DynamicImage, String)> = sources
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let (bytes, filename) =
                    Self::source_to_bytes(s).map_err(AIError::InvalidRequest)?;
                let img = image::load_from_memory(&bytes).map_err(|e| {
                    AIError::InvalidRequest(format!("参考图{}解码失败: {}", i + 1, e))
                })?;
                Ok::<(DynamicImage, String), AIError>((img, filename))
            })
            .collect::<Result<Vec<_>, AIError>>()?;

        let n = loaded.len() as u32;
        let (cols, rows): (u32, u32) = match n {
            1 => (1, 1),
            2 => (2, 1),
            3 => (3, 1),
            _ => (3, 2), // 4-6 images in 2×3 grid
        };
        let cell_w = 1024u32;
        let cell_h = 1024u32;
        let canvas_w = cell_w * cols;
        let canvas_h = cell_h * rows;

        let mut canvas =
            RgbaImage::from_pixel(canvas_w, canvas_h, image::Rgba([255u8, 255, 255, 255]));

        let mut layout = Vec::new();

        for i in 0..n as usize {
            let (img, _filename) = &loaded[i];
            let col = i as u32 % cols;
            let row = i as u32 / cols;
            let (iw, ih) = img.dimensions();
            let scale_w = if iw > 0 { cell_w as f64 / iw as f64 } else { 1.0 };
            let scale_h = if ih > 0 { cell_h as f64 / ih as f64 } else { 1.0 };
            let scale = scale_w.min(scale_h);
            let new_w = ((iw as f64 * scale) as u32).max(1);
            let new_h = ((ih as f64 * scale) as u32).max(1);
            let resized =
                image::imageops::resize(img, new_w, new_h, image::imageops::FilterType::Lanczos3);

            let x = (col * cell_w + (cell_w.saturating_sub(new_w)) / 2) as i64;
            let y = (row * cell_h + (cell_h.saturating_sub(new_h)) / 2) as i64;
            image::imageops::overlay(&mut canvas, &resized, x, y);

            let pos_label = if n == 1 {
                "整张参考图".to_string()
            } else if rows == 1 {
                let pos = match i {
                    0 => "左侧",
                    _ if i == n as usize - 1 => "右侧",
                    _ => "中间",
                };
                format!("{}区域", pos)
            } else {
                let row_label = if row == 0 { "上半" } else { "下半" };
                let col_label = match col {
                    0 => "左",
                    1 => "中",
                    _ => "右",
                };
                format!("{}{}区域", row_label, col_label)
            };
            layout.push((i + 1, pos_label));
        }

        let mut buf = Vec::new();
        DynamicImage::ImageRgba8(canvas)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|e| AIError::InvalidRequest(format!("PNG encode failed: {}", e)))?;
        Ok((buf, layout))
    }

    fn source_to_bytes(source: &str) -> Result<(Vec<u8>, String), String> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("source is empty".to_string());
        }

        // data: URL
        if let Some((meta, payload)) = trimmed.split_once(',') {
            if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
                let bytes = STANDARD
                    .decode(payload)
                    .map_err(|err| format!("invalid data-url base64: {}", err))?;
                return Ok((bytes, "image.png".to_string()));
            }
        }

        // Raw base64 — must be tried before treating as a path
        let likely_base64 = trimmed.len() > 256
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
        if likely_base64 {
            let bytes = STANDARD
                .decode(trimmed)
                .map_err(|err| format!("invalid base64: {}", err))?;
            return Ok((bytes, "image.png".to_string()));
        }

        // File path — read from disk
        let path = if trimmed.starts_with("file://") {
            let url_path = trimmed
                .strip_prefix("file://")
                .unwrap_or(trimmed);
            PathBuf::from(url_path)
        } else {
            PathBuf::from(trimmed)
        };
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("failed to read path \"{}\": {}", path.display(), e))?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");
        let filename = format!("ref-image.{}", ext);
        Ok((bytes, filename))
    }
}

impl Default for BaiduProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for BaiduProvider {
    fn name(&self) -> &str {
        "baidu"
    }

    fn supports_model(&self, model: &str) -> bool {
        Self::sanitize_model(model) == "gpt-image-2"
    }

    fn list_models(&self) -> Vec<String> {
        vec!["baidu/gpt-image-2".to_string()]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        false
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key 未设置".to_string()))?;

        let pixel_size = Self::aspect_ratio_to_size(&request.aspect_ratio)?;

        let reference_images = request
            .reference_images
            .as_ref()
            .map(|v| v.as_slice())
            .unwrap_or(&[]);

        if reference_images.len() > MAX_REFERENCE_IMAGES {
            return Err(AIError::InvalidRequest(format!(
                "GPT Image 2 最多支持 {} 张参考图，收到 {} 张",
                MAX_REFERENCE_IMAGES,
                reference_images.len()
            )));
        }

        let ref_count = reference_images.len();

        let ref_prefix = if ref_count > 0 {
            "\n[参考图] 附图中的参考图是你唯一的视觉来源。你必须严格复制参考图中所有视觉元素（角色外貌/服装/场景/风格/色彩），不可修改或添加。"
        } else {
            ""
        };
        let full_prompt = format!("{}{}", ref_prefix, request.prompt);
        let prompt_head: String = full_prompt.chars().take(600).collect();

        let mut form = Form::new()
            .text("model", "gpt-image-2".to_string())
            .text("prompt", full_prompt.clone())
            .text("size", pixel_size.clone())
            .text("quality", "medium".to_string())
            .text("n", "1".to_string());

        if ref_count > 0 {
            let (image_bytes, _layout) = Self::composite_reference_images(reference_images)?;
            let filename = "composite.png".to_string();
            let img_mime = if filename.ends_with(".png") || filename == "image.png" {
                "image/png"
            } else if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
                "image/jpeg"
            } else {
                "image/png"
            };
            let part = Part::bytes(image_bytes)
                .file_name(filename)
                .mime_str(img_mime)
            .map_err(|err| AIError::InvalidRequest(format!("Failed to set mime type: {}", err)))?;
            form = form.part("image", part);
        }

        let endpoint = format!("{}{}", BASE_URL, EDITS_PATH);
        info!(
            "[Request] size={}, quality=medium, ref_total={}, sent=1, prompt_len={}, prompt_head={}",
            pixel_size, ref_count, full_prompt.len(), prompt_head
        );
        // Log full prompt safely on char boundaries
        let prompt_preview: String = full_prompt.chars().take(1000).collect();
        info!("[Prompt 全文] {}", prompt_preview);

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                let msg = if e.is_timeout() {
                    "生成超时，积分已返还，请重新生成".to_string()
                } else if e.is_connect() {
                    "网络连接失败，请检查网络后重试".to_string()
                } else {
                    "网络异常，积分已返还，请重新生成".to_string()
                };
                AIError::Provider(msg)
            })?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            info!("[Baidu API Error] HTTP {}: {}", status.as_u16(), raw_response);
            let user_msg = match status.as_u16() {
                429 => "服务繁忙，积分已返还，请稍后重试".to_string(),
                408 => "生成超时，积分已返还，请重新生成".to_string(),
                500 => "服务异常，积分已返还，请稍后重试".to_string(),
                503 => "服务暂不可用，积分已返还，请稍后重试".to_string(),
                400 => translate_baidu_image_error(&raw_response),
                _ => format!("生成失败(HTTP {})，积分已返还，请重新生成", status.as_u16()),
            };
            return Err(AIError::Provider(user_msg));
        }

        let body: BaiduImageResponse =
            serde_json::from_str(&raw_response).map_err(|err| {
                AIError::Provider(format!(
                    "服务端响应解析失败: {}; raw={}",
                    err, raw_response
                ))
            })?;

        let b64 = body
            .data
            .first()
            .map(|d| d.b64_json.as_str())
            .ok_or_else(|| {
                AIError::Provider(format!(
                    "服务端返回数据为空; raw={}",
                    raw_response
                ))
            })?;

        // Return as data URL so the frontend can display directly
        Ok(format!("data:image/png;base64,{}", b64))
    }
}

/// 把百度图片生成的 400 错误响应翻译成用户可读的中文提示，避免把英文 JSON 直接甩给用户。
fn translate_baidu_image_error(raw_response: &str) -> String {
    let lower = raw_response.to_lowercase();

    if lower.contains("moderation_blocked")
        || lower.contains("safety_violations")
        || lower.contains("rejected by the safety")
        || lower.contains("content_filter")
    {
        return "提示词或参考图可能包含违规或敏感内容，请修改后重试，积分已返还，请重新生成".to_string();
    }

    "生成失败，请检查提示词或参考图后重试，积分已返还，请重新生成".to_string()
}

// ── VOD Super-Resolution ──────────────────────────────────────

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::fs;
use std::io::Read;

type HmacSha256 = Hmac<Sha256>;

/// BCE VOD process response
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VodTaskResponse {
    task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VodTaskDetail {
    task_id: String,
    status: String,
    #[serde(default)]
    output: Option<VodTaskOutput>,
    #[serde(default)]
    media_preset_task_info: Option<VodMediaPresetInfo>,
    #[serde(default)]
    error: Option<VodTaskError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VodMediaPresetInfo {
    #[serde(default)]
    transcode_tasks: Vec<VodTranscodeTask>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VodTranscodeTask {
    #[serde(default)]
    transcode_output: Option<VodTaskOutput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VodTaskOutput {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    media_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VodTaskError {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

/// Sign a BCE request (matching Baidu's official Python example)
fn bce_sign(ak: &str, sk: &str, method: &str, path: &str, query: &str,
    headers: &std::collections::BTreeMap<String, String>, timestamp: &str, expire_secs: u32) -> String
{
    let auth_prefix = format!("bce-auth-v1/{}/{}/{}", ak, timestamp, expire_secs);

    // signingKey = HMAC_SHA256(sk, authStringPrefix) as HEX STRING
    let signing_key_bytes = {
        let mut mac = HmacSha256::new_from_slice(sk.as_bytes())
            .expect("HMAC can take key of any size");
        mac.update(auth_prefix.as_bytes());
        mac.finalize().into_bytes()
    };
    let signing_key_hex = hex::encode(&signing_key_bytes);

    // Canonical headers: sorted, normalized keys and values
    let canonical_headers = headers.iter()
        .map(|(k, v)| {
            let kl = k.to_lowercase();
            let nk = urlencoding::encode(&kl);
            let nv = urlencoding::encode(v);
            format!("{}:{}", nk, nv)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let signed_headers = headers.keys()
        .map(|k| k.to_lowercase())
        .collect::<Vec<_>>()
        .join(";");

    // canonical_request: no trailing \n (matching Python example)
    let canonical_req = format!("{}\n{}\n{}\n{}", method, path, query, canonical_headers);

    // Signature = HMAC_SHA256(signingKey.hex(), canonicalRequest) as hex
    let signature_bytes = {
        let mut mac = HmacSha256::new_from_slice(signing_key_hex.as_bytes())
            .expect("HMAC can take key of any size");
        mac.update(canonical_req.as_bytes());
        mac.finalize().into_bytes()
    };
    let signature = hex::encode(&signature_bytes);

    format!("{}/{}/{}", auth_prefix, signed_headers, signature)
}

/// Upload a local video file to Baidu VOD and return mediaId
/// Uses: POST /v2/medias/upload (申请上传) → PUT pre-signed URL → POST complete
pub async fn baidu_vod_upload(
    client: &reqwest::Client,
    ak: &str,
    sk: &str,
    file_path: &str,
) -> Result<String, String> {
    let file_data = fs::read(file_path).map_err(|e| format!("读取视频文件失败: {}", e))?;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = std::path::Path::new(&file_name)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let host = "vod.bj.baidubce.com";
    let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    // Step 1: 申请上传 → get sessionKey + pre-signed URL
    let path = "/v2/medias/upload";
    let method = "POST";
    let mut headers = std::collections::BTreeMap::new();
    headers.insert("host".to_string(), host.to_string());
    headers.insert("x-bce-date".to_string(), timestamp.clone());

    let apply_body = serde_json::json!({
        "name": file_name,
        "container": ext,
    });
    let apply_str = apply_body.to_string();

    let auth = bce_sign(ak, sk, method, path, "", &headers, &timestamp, 1800);

    let apply_resp = client
        .post(format!("https://{}{}", host, path))
        .header("Authorization", &auth)
        .header("x-bce-date", &timestamp)
        .header("Content-Type", "application/json")
        .body(apply_str)
        .send()
        .await
        .map_err(|e| format!("VOD 申请上传失败: {}", e))?;

    let status = apply_resp.status();
    let body = apply_resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("VOD 申请上传失败 ({}): {}", status, body));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("解析响应失败: {} body={}", e, body))?;
    let session_key = parsed["sessionKey"].as_str()
        .ok_or_else(|| format!("响应无sessionKey: {}", body))?;
    let upload_url = parsed["urls"].as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("响应无urls: {}", body))?;

    tracing::info!("[BaiduVOD] 申请上传成功 sessionKey={}", session_key);

    // Step 2: PUT file to pre-signed URL (NO BCE auth needed!)
    let put_resp = client
        .put(upload_url)
        .body(file_data)
        .send()
        .await
        .map_err(|e| format!("VOD 上传文件失败: {}", e))?;

    if !put_resp.status().is_success() {
        return Err(format!("VOD 上传文件失败 ({}): {}", put_resp.status(), put_resp.text().await.unwrap_or_default()));
    }
    tracing::info!("[BaiduVOD] 文件PUT上传成功");

    // Step 3: 完成上传 → get mediaId
    let timestamp3 = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let complete_path = "/v2/medias/complete_upload";
    let mut headers3 = std::collections::BTreeMap::new();
    headers3.insert("host".to_string(), host.to_string());
    headers3.insert("x-bce-date".to_string(), timestamp3.clone());

    let auth3 = bce_sign(ak, sk, "POST", complete_path, "", &headers3, &timestamp3, 1800);
    let complete_body = serde_json::json!({ "sessionKey": session_key }).to_string();

    let complete_resp = client
        .post(format!("https://{}{}", host, complete_path))
        .header("Authorization", &auth3)
        .header("x-bce-date", &timestamp3)
        .header("Content-Type", "application/json")
        .body(complete_body)
        .send()
        .await
        .map_err(|e| format!("VOD 完成上传失败: {}", e))?;

    let comp_status = complete_resp.status();
    let comp_body = complete_resp.text().await.unwrap_or_default();
    if !comp_status.is_success() {
        return Err(format!("VOD 完成上传失败 ({}): {}", comp_status, comp_body));
    }

    let comp_parsed: serde_json::Value = serde_json::from_str(&comp_body)
        .map_err(|e| format!("解析完成上传响应失败: {} body={}", e, comp_body))?;
    let media_id = comp_parsed["mediaId"].as_str()
        .ok_or_else(|| format!("完成上传响应无mediaId: {}", comp_body))?
        .to_string();

    tracing::info!("[BaiduVOD] 上传完成 mediaId={}", media_id);
    Ok(media_id)
}

/// Submit super-resolution processing task
pub async fn baidu_vod_process(
    client: &reqwest::Client,
    ak: &str,
    sk: &str,
    media_id: &str,
    preset_id: &str,
) -> Result<String, String> {
    let host = "vod.bj.baidubce.com";
    let path = "/v2/medias/process";
    let method = "POST";
    let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let body = serde_json::json!({
        "mediaId": media_id,
        "preset": {
            "presetIds": [preset_id]
        }
    });
    let body_str = body.to_string();

    let mut headers = std::collections::BTreeMap::new();
    headers.insert("host".to_string(), host.to_string());
    headers.insert("x-bce-date".to_string(), timestamp.clone());
    headers.insert("content-type".to_string(), "application/json".to_string());

    let auth = bce_sign(ak, sk, method, path, "", &headers, &timestamp, 1800);

    let response = client
        .post(format!("https://{}{}", host, path))
        .header("Authorization", auth)
        .header("x-bce-date", timestamp)
        .header("Content-Type", "application/json")
        .body(body_str.clone())
        .send()
        .await
        .map_err(|e| format!("VOD 处理请求失败: {}", e))?;

    let status = response.status();
    let resp_body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("VOD 处理失败 ({}): {} req={}", status, resp_body, body_str));
    }

    let task: VodTaskResponse = serde_json::from_str(&resp_body)
        .map_err(|e| format!("解析任务响应失败: {} body={}", e, resp_body))?;

    tracing::info!("[BaiduVOD] 处理任务已提交 taskId={}", task.task_id);
    Ok(task.task_id)
}

/// Poll VOD task status, return output video URL when done
pub async fn baidu_vod_poll(
    client: &reqwest::Client,
    ak: &str,
    sk: &str,
    task_id: &str,
    max_retries: u32,
) -> Result<String, String> {
    let host = "vod.bj.baidubce.com";
    let path = format!("/v2/tasks/{}", task_id);
    let method = "GET";

    for i in 0..max_retries {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

        let mut headers = std::collections::BTreeMap::new();
        headers.insert("host".to_string(), host.to_string());
        headers.insert("x-bce-date".to_string(), timestamp.clone());

        let auth = bce_sign(ak, sk, method, &path, "", &headers, &timestamp, 1800);

        let response = client
            .get(format!("https://{}{}", host, path))
            .header("Authorization", auth)
            .header("x-bce-date", timestamp)
            .send()
            .await
            .map_err(|e| format!("VOD 查询任务失败: {}", e))?;

        let resp_body = response.text().await.unwrap_or_default();

        let task: VodTaskDetail = match serde_json::from_str(&resp_body) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("[BaiduVOD] 解析任务详情失败 (尝试{}/{}): {} body={}", i+1, max_retries, e, resp_body);
                continue;
            }
        };

        match task.status.as_str() {
            "SUCCEEDED" | "FINISHED" => {
                // Try transcode output first (PRESET tasks), then direct output
                let url = task.media_preset_task_info.as_ref()
                    .and_then(|info| info.transcode_tasks.first())
                    .and_then(|t| t.transcode_output.as_ref())
                    .and_then(|o| o.url.as_ref())
                    .or_else(|| {
                        task.output.as_ref()
                            .and_then(|o| o.url.as_ref().or(o.media_id.as_ref()))
                    })
                    .cloned()
                    .ok_or_else(|| format!("任务完成但无输出: {}", resp_body))?;
                return Ok(url);
            }
            "FAILED" | "ERROR" => {
                let msg = task.error.as_ref()
                    .and_then(|e| e.message.as_ref())
                    .map(|m| m.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("VOD 处理任务失败: {}", msg));
            }
            _ => {
                tracing::info!("[BaiduVOD] 任务进行中 (尝试{}/{}): status={}", i+1, max_retries, task.status);
            }
        }
    }
    Err(format!("VOD 任务超时（已轮询{}次）", max_retries))
}

/// Full pipeline: upload local video → super-resolution → download to local
pub async fn baidu_vod_upscale(
    client: &reqwest::Client,
    ak: &str,
    sk: &str,
    local_video_path: &str,
    preset_id: &str,
    output_dir: &str,
) -> Result<String, String> {
    // 1. Upload to VOD
    let media_id = baidu_vod_upload(client, ak, sk, local_video_path).await?;

    // 2. Submit super-resolution
    let task_id = baidu_vod_process(client, ak, sk, &media_id, preset_id).await?;

    // 3. Poll for completion
    let output_url = baidu_vod_poll(client, ak, sk, &task_id, 60).await?;

    // 4. Download result to local
    let file_name = format!("upscale_{}_{}.mp4",
        std::path::Path::new(local_video_path)
            .file_stem().unwrap_or_default().to_string_lossy(),
        preset_id);
    let output_path = format!("{}/{}", output_dir, file_name);

    let response = client.get(&output_url).send().await
        .map_err(|e| format!("下载超分视频失败: {}", e))?;
    let bytes = response.bytes().await
        .map_err(|e| format!("读取超分视频失败: {}", e))?;
    fs::write(&output_path, &bytes)
        .map_err(|e| format!("保存超分视频失败: {}", e))?;

    tracing::info!("[BaiduVOD] 超分完成: {} ({} bytes)", output_path, bytes.len());
    Ok(output_path)
}
