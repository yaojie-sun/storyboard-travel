use std::io::Cursor;

use base64::Engine;
use reqwest::Client;
use tokio::time::Duration;
use tracing::info;

use crate::ai::error::AIError;

/// 千帆 OpenAI 兼容接口（ERNIE-VL 多模态读图）。
/// 端点与鉴权采用 OpenAI 兼容模式：Bearer <API Key>。
const QIANFAN_VL_URL: &str = "https://qianfan.baidubce.com/v2/chat/completions";
/// 读图模型标识。需与服务器 /api-configs/active 下发时一致；
/// 复刻到服饰版/美妆版/科普版等衍生版本时无需改动（行业无关）。
const QIANFAN_VL_MODEL: &str = "ernie-4.5-turbo-vl";

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

/// 调用千帆 ERNIE-VL 读图，返回中文视觉描述。
///
/// 与 [`super::deepseek::optimize_prompt`] 同构：由调用方传入 api_key，
/// 本模块不直接依赖 commands 层，便于复刻到其他行业版本。
/// 千帆 VL 的 base64 通道仅支持 JPG/PNG/BMP；WebP/GIF 等需先转 PNG。
/// 按文件头（magic bytes）识别真实格式，不信任扩展名。
fn normalize_for_vl(image_bytes: &[u8]) -> Result<(Vec<u8>, &'static str), AIError> {
    let fmt = image::guess_format(image_bytes).unwrap_or(image::ImageFormat::Png);
    let (bytes, media_type) = match fmt {
        image::ImageFormat::Jpeg => (image_bytes.to_vec(), "image/jpeg"),
        image::ImageFormat::Png => (image_bytes.to_vec(), "image/png"),
        image::ImageFormat::Bmp => (image_bytes.to_vec(), "image/bmp"),
        // WebP / GIF / 其他：解码后重编码为 PNG，保证千帆可读
        _ => {
            let img = image::load_from_memory(image_bytes)
                .map_err(|e| AIError::Provider(format!("读图图片解码失败: {}", e)))?;
            let mut buf = Vec::new();
            img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
                .map_err(|e| AIError::Provider(format!("读图图片转PNG失败: {}", e)))?;
            (buf, "image/png")
        }
    };
    Ok((bytes, media_type))
}

pub async fn describe_image(image_bytes: &[u8], api_key: &str) -> Result<String, AIError> {
    if api_key.is_empty() {
        return Err(AIError::Provider("千帆VL读图API密钥未配置".to_string()));
    }

    let (image_bytes, media_type) = normalize_for_vl(image_bytes)?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    let image_data_url = format!("data:{};base64,{}", media_type, b64);

    let body = serde_json::json!({
        "model": QIANFAN_VL_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": DESCRIBE_PROMPT },
                    { "type": "image_url", "image_url": { "url": image_data_url } }
                ]
            }
        ],
        "max_tokens": 512,
        "temperature": 0.3
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()?;

    info!("[读图] 千帆VL请求, image {} bytes", image_bytes.len());

    let response = client
        .post(QIANFAN_VL_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::Provider(format!(
            "千帆VL API error {}: {}",
            status, error_text
        )));
    }

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AIError::Provider(format!("千帆VL response parse error: {}", e)))?;

    let description = result
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if description.is_empty() {
        return Err(AIError::Provider("千帆VL返回空描述".to_string()));
    }

    info!("[读图] 千帆VL完成, description {} chars", description.len());

    Ok(description)
}
