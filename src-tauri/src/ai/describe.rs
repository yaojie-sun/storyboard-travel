use std::io::Cursor;

use base64::Engine;
use reqwest::Client;
use tokio::time::Duration;
use tracing::{info, warn};

use crate::ai::error::AIError;

/// DeepSeek 多模态视觉模型读图（deepseek-v4-flash-vision-exp）。
/// 端点与鉴权采用 OpenAI 兼容模式：Bearer <API Key>。
/// 一次性完成「读图」——产出可直接供分镜提示词生成的图片信息；参考图只读一次（file_hash 缓存），
/// 后续进入画布复用缓存文本，不再重复读图。
const DEEPSEEK_VL_URL: &str = "https://api.deepseek.com/chat/completions";
/// 读图模型标识。需与服务器 /api-configs/active 下发时一致；
/// 复刻到服饰版/美妆版/科普版等衍生版本时无需改动（行业无关）。
const DEEPSEEK_VL_MODEL: &str = "deepseek-v4-flash-vision-exp";

/// 读图前统一下采样：最长边压到 MAX_EDGE 内并重编码 JPEG。
/// 大图（如 4MB）直接 base64 会导致请求体过大、处理慢甚至超时，压到 ~100-200KB 秒回。
const MAX_EDGE: u32 = 1024;
const JPEG_QUALITY: u8 = 85;

/// 通用视觉描述引导词：结构化、客观、可复现，不绑定任何行业。
const DESCRIBE_PROMPT: &str = r#"你是一名专业的图像描述助手。请仔细观察这张参考图，用简洁、客观、结构化的中文描述图片内容，供后续分镜提示词生成使用。

严格按以下维度输出（每项一行，无内容则写"无"）：
- 主体：画面主要人物/物体的外观特征（年龄、性别、发型发色、服装、动作姿态）
- 配色：主色调与色彩搭配
- 构图：景别（特写/近景/中景/全景/远景）与画面布局
- 风格：艺术风格（写实/国风/赛博朋克/日系等）
- 光线：光照方向与氛围（自然光/影棚光/夜景/黄金时刻等）
- 关键元素：服装道具/品牌标识/文字等细节
- 背景：背景环境与氛围

要求：描述客观、可复现，不添加主观评价或故事性延伸，控制在 150 字以内。"#;

/// 调用 DeepSeek 视觉模型读图，返回中文视觉描述。
///
/// 与 [`super::deepseek::optimize_prompt`] 同构：由调用方传入 api_key，
/// 本模块不直接依赖 commands 层，便于复刻到其他行业版本。
/// 读图前统一下采样（最长边 ≤ 1024、JPEG q85），再 base64 直传 DeepSeek 视觉接口。
/// 支持任意输入格式（JPEG/PNG/WebP/GIF/BMP…），统一按真实内容解码后重编码。
fn normalize_for_vl(image_bytes: &[u8]) -> Result<(Vec<u8>, &'static str), AIError> {
    let img = image::load_from_memory(image_bytes)
        .map_err(|e| AIError::Provider(format!("读图图片解码失败: {}", e)))?;

    let (w, h) = (img.width(), img.height());
    let long_edge = w.max(h);
    let (nw, nh) = if long_edge > MAX_EDGE {
        let scale = MAX_EDGE as f64 / long_edge as f64;
        (
            ((w as f64) * scale).round().max(1.0) as u32,
            ((h as f64) * scale).round().max(1.0) as u32,
        )
    } else {
        (w, h)
    };

    let resized = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
    let rgb = resized.to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
    enc.encode_image(&rgb)
        .map_err(|e| AIError::Provider(format!("读图图片编码失败: {}", e)))?;

    Ok((buf.into_inner(), "image/jpeg"))
}

/// 上传压缩结果：原样保留 或 已压缩为 JPEG。
pub enum UploadImage {
    Original(Vec<u8>),
    CompressedJpeg(Vec<u8>),
}

/// 上传落盘前的压缩：大图（最长边 > 2048 或体积 > 5MB）下采样到最长边 2048 + 重编码 JPEG q88，
/// 避免原图过大拖慢宫格/画布加载；小图原样透传（不动格式与画质）。
/// 解码失败返回 Err，由调用方决定是否原样保存兜底（不阻塞上传）。
pub fn compress_for_upload(image_bytes: &[u8]) -> Result<UploadImage, AIError> {
    const UPLOAD_MAX_EDGE: u32 = 2048;
    const UPLOAD_MAX_BYTES: usize = 5 * 1024 * 1024;
    const UPLOAD_JPEG_QUALITY: u8 = 88;

    let img = image::load_from_memory(image_bytes)
        .map_err(|e| AIError::Provider(format!("上传图片解码失败: {}", e)))?;
    let (w, h) = (img.width(), img.height());

    // 小图（体积 ≤5MB 且最长边 ≤2048）原样保留，不重编码、不损失画质。
    if image_bytes.len() <= UPLOAD_MAX_BYTES && w.max(h) <= UPLOAD_MAX_EDGE {
        return Ok(UploadImage::Original(image_bytes.to_vec()));
    }

    let long_edge = w.max(h);
    let (nw, nh) = if long_edge > UPLOAD_MAX_EDGE {
        let scale = UPLOAD_MAX_EDGE as f64 / long_edge as f64;
        (
            ((w as f64) * scale).round().max(1.0) as u32,
            ((h as f64) * scale).round().max(1.0) as u32,
        )
    } else {
        (w, h)
    };

    let rgb = img
        .resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
        .to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, UPLOAD_JPEG_QUALITY);
    enc.encode_image(&rgb)
        .map_err(|e| AIError::Provider(format!("上传图片压缩失败: {}", e)))?;

    Ok(UploadImage::CompressedJpeg(buf.into_inner()))
}

pub async fn describe_image(image_bytes: &[u8], api_key: &str) -> Result<String, AIError> {
    if api_key.is_empty() {
        return Err(AIError::Provider("DeepSeek视觉读图API密钥未配置".to_string()));
    }

    let (image_bytes, media_type) = normalize_for_vl(image_bytes)?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    let image_data_url = format!("data:{};base64,{}", media_type, b64);

    let body = serde_json::json!({
        "model": DEEPSEEK_VL_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": DESCRIBE_PROMPT },
                    { "type": "image_url", "image_url": { "url": image_data_url } }
                ]
            }
        ],
        "max_tokens": 2048,
        "temperature": 0.3
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()?;

    // 视觉模型偶发返回空描述（推理被 max_tokens 截断 / 服务端抖动），重试一次再报错，
    // 确保读图可靠写入缓存，避免「读图失败 → 缓存为空 → 每次进画布重读」的卡顿。
    let mut last_err: Option<AIError> = None;
    for attempt in 0..2 {
        info!(
            "[读图] DeepSeek视觉请求 (第 {} 次), image {} bytes",
            attempt + 1,
            image_bytes.len()
        );

        let response = match client
            .post(DEEPSEEK_VL_URL)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = Some(AIError::Provider(format!("DeepSeek视觉请求失败: {}", e)));
                continue;
            }
        };

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            last_err = Some(AIError::Provider(format!(
                "DeepSeek视觉 API error {}: {}",
                status, error_text
            )));
            continue;
        }

        let result: serde_json::Value = match response.json().await {
            Ok(v) => v,
            Err(e) => {
                last_err = Some(AIError::Provider(format!(
                    "DeepSeek视觉 response parse error: {}",
                    e
                )));
                continue;
            }
        };

        let description = result
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        if description.is_empty() {
            let raw = serde_json::to_string(&result).unwrap_or_default();
            warn!(
                "[读图] DeepSeek视觉返回空描述, 原始响应(前600字): {}",
                raw.chars().take(600).collect::<String>()
            );
            last_err = Some(AIError::Provider("DeepSeek视觉返回空描述".to_string()));
            continue;
        }

        info!("[读图] DeepSeek视觉完成, description {} chars", description.len());
        return Ok(description);
    }

    Err(last_err.unwrap_or_else(|| AIError::Provider("DeepSeek视觉读图失败".to_string())))
}
