use reqwest::Client;
use serde::Serialize;
use tokio::time::Duration;
use tracing::{info, warn};

use crate::ai::error::AIError;

const GATEWAY_URL: &str = "https://aixiaoxi.top/jy/api/v1/gateway/v1/messages";
const OPTIMIZE_MODEL: &str = "claude-sonnet-4-6";
const CLEAN_MODEL: &str = "deepseek-v4-flash";

#[derive(Debug, Serialize)]
struct GatewayRequest {
    model: String,
    system: String,
    messages: Vec<GatewayMessage>,
    max_tokens: u32,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct GatewayMessage {
    role: String,
    content: String,
}

/// Extract text from Anthropic-format response: { "content": [ { "type": "text", "text": "..." } ] }
fn extract_anthropic_text(response: &serde_json::Value) -> String {
    response
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    block
                        .get("type")
                        .and_then(|t| t.as_str())
                        .filter(|&t| t == "text")
                        .and_then(|_| block.get("text"))
                        .and_then(|t| t.as_str())
                })
                .collect::<Vec<&str>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Fallback: extract text from OpenAI-format response: { "choices": [ { "message": { "content": "..." } } ] }
fn extract_openai_text(response: &serde_json::Value) -> String {
    response
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn extract_response_text(response: &serde_json::Value) -> String {
    let anthropic_text = extract_anthropic_text(response);
    if !anthropic_text.is_empty() {
        return anthropic_text;
    }
    extract_openai_text(response)
}

const SYSTEM_PROMPT: &str = r#"You are a prompt optimizer for a storyboard image generation model. You receive a multi-panel storyboard prompt and must rewrite it so the image model understands EXACTLY what to generate.

CRITICAL RULES — you MUST follow these:

1. LEFT/RIGHT HAND ANCHORING: For every prop or held item mentioned in any panel, append [LEFT HAND: item] or [RIGHT HAND: item] at the end of that panel's description. If the same prop appears across multiple panels, it MUST stay in the SAME hand in every panel. Be explicit: do not assume the model will remember.

2. SPATIAL POSITIONING: Rewrite ambiguous position descriptions to be impossible to misinterpret:
   - "sitting behind a desk facing camera" → "character sits on the FAR side of the desk, the desk is in the FOREGROUND between the camera and the character, the character's upper body is visible ABOVE and BEHIND the desk, facing the camera"
   - "standing in front of a building" → "character is in the FOREGROUND, a building is visible BEHIND them in the BACKGROUND"
   - "holding a cup" → specify WHICH HAND: "holding a cup in their LEFT hand"

3. CROSS-PANEL CONSISTENCY: Scan ALL panels before rewriting. If panel 1 establishes a prop in the left hand, every subsequent panel MUST state the same hand. If a character's clothing is described in one panel, copy that description to all panels. Add a consistency preamble to each panel: "[CONSISTENCY: same outfit as panel 1, left hand cup, right hand bag]"

4. ACTION CONTINUITY: Between consecutive panels, add brief transition notes explaining how the character moved: "[TRANSITION: character has stepped to the right, now standing next to the table]"

5. PRESERVE ALL ORIGINAL CONSTRAINTS: Do NOT modify the grid layout, aspect ratio, number of panels, "Do NOT render text" instructions, or any HARD CONSTRAINTS section. Only enhance the panel descriptions and character/scene descriptions.

6. OUTPUT FORMAT: Output ONLY the complete optimized prompt. Do NOT add explanations, preambles, or meta-commentary. The output must be the full prompt text ready to send to the image model.

7. LANGUAGE: The output must be in English (same as input prompt language).

8. LENGTH LIMIT: The optimized output MUST NOT exceed 110% of the input character count. Compensate for any added annotations by condensing verbose descriptions. Preserve HARD CONSTRAINTS verbatim."#;

pub async fn optimize_prompt(prompt: &str, api_key: &str) -> Result<String, AIError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()?;

    let request = GatewayRequest {
        model: OPTIMIZE_MODEL.to_string(),
        system: SYSTEM_PROMPT.to_string(),
        messages: vec![GatewayMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
        max_tokens: 4096,
        stream: false,
    };

    if api_key.is_empty() {
        return Err(AIError::Provider("API密钥未配置".to_string()));
    }

    info!(
        "[Prompt优化] gateway request, input: {} chars, model: {}",
        prompt.len(), OPTIMIZE_MODEL
    );

    let response = client
        .post(GATEWAY_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::Provider(format!(
            "Gateway API error {}: {}",
            status, error_text
        )));
    }

    let result: serde_json::Value = response.json().await.map_err(|e| {
        AIError::Provider(format!("Gateway response parse error: {}", e))
    })?;

    let optimized = extract_response_text(&result);

    if optimized.is_empty() {
        return Err(AIError::Provider("Gateway returned empty response".to_string()));
    }

    info!(
        "[Prompt优化] complete, output: {} chars",
        optimized.len()
    );

    Ok(optimized)
}

const VIDEO_CLEAN_SYSTEM_PROMPT: &str = r#"你是一个视频提示词清洗器。你的任务是将分镜提示词转换为万相 Wan2.7 R2V 可用的分镜脚本。

【核心原理 — 完全对齐阿里官方最佳实践】
万相 Wan2.7 R2V 以宫格故事板为视觉输入，模型自动识别宫格逻辑、自动适配镜头时长、自动处理运镜。文字只需提供分镜叙事——每个镜头里发生什么、听到什么。官方示例中无时间锚定、无运镜指令、无帧引用，模型全部自动处理。

【铁律 0 — 声音和台词绝对不可触碰（最高优先级）】
声音描述和台词/对白逐字保留原文，一个字都不能改、不能删。

【铁律 — 必须删除的内容】
1. 时间锚定 [X-Ys] —— 全部删除（模型自动分配时长）
2. 所有光影描述 —— 全部删除
3. 所有角色外观描述 —— 全部删除
4. 所有道具和物体外观细节 —— 全部删除
5. 图N/宫格N 帧引用 —— 全部删除

【必须保留的内容】
1. 风格锚定头部（影调/风格/画幅/总时长）
2. 分镜序列：编号 + 景别 + 动作描述 + 运镜 + 声音

【输出格式】
分镜脚本：
1. 景别：动作描述。运镜。声音。
2. 景别：动作描述。运镜。声音。

（风格锚定头部由系统自动保留，清洗层不负责输出）

【约束】
- 禁止写时间锚定 [X-Ys]
- 运镜保留原文，规范化为 Wan2.7 标准术语，只写一次不重复
- 禁止写光影/场景/角色外观
- 动作 ≤40字，自然叙事
- 声音逐字复制
- 全部用中文
- 输出纯文本，不要JSON，不要解释"#;

const VIDEO_CLEAN_HAPPYHORSE_PROMPT: &str = r#"你是一个视频提示词清洗器。将分镜提示词转换为极简运镜指令。

【铁律】
- 声音和台词逐字保留原文，一字不改
- 禁止光影/场景/角色外观/道具外观
- 禁止 [Image N] 或 图N（参考图由media数组提供）
- 禁止分辨率/画幅/模型名

【输出格式】每个Shot一行：
S1: {运镜}。{动作≤15字}。for N seconds。{声音}
S2: {运镜}。{动作≤15字}。for N seconds。{声音}

【运镜仅限】static | slow push-in | slow pull-out | smooth pan L->R | smooth pan R->L | smooth tracking | slight handheld shake | orbit L | orbit R | tilt up | tilt down | crane up | crane down

【约束】动作≤15字。全部英文。纯文本输出。末尾加一句：No text overlays, no watermarks, no subtitles, no dialogue boxes, no captions."#;

/// Map our skill's camera terminology to Wan2.7 official terminology
fn hard_replace_camera(prompt: &str) -> String {
    let re_map: Vec<(&str, &str)> = vec![
        // 摇镜 → Wan官方术语（Wan不认识"摇镜"这个词）
        (r"平稳摇镜\(左→右\)", "镜头右移"),
        (r"平稳摇镜\(右→左\)", "镜头左移"),
        (r"平稳摇镜从上至下", "俯仰下摇"),
        (r"平稳摇镜从下至上", "俯仰上摇"),
        (r"匀速摇镜", "镜头平移"),
        (r"慢速摇镜", "镜头平移"),
        (r"快速摇镜", "镜头平移"),
        (r"水平摇镜", "镜头平移"),
        // 旋转角度数值 → 定性描述（Wan不理解数值角度）
        (r"转体90度", "侧身转向"),
        (r"转身90度", "缓缓转身"),
        (r"转身180度", "缓缓转身"),
        (r"旋转90度", "缓缓转体"),
        (r"旋转180度", "缓缓转体"),
        // 非标准相机术语 → Wan2.7 标准术语
        (r"航拍大远景", "大远景"),
        (r"航拍中景", "中景"),
        (r"航拍全景", "全景"),
        (r"航拍近景", "近景"),
        (r"航拍特写", "特写"),
        (r"航拍", "镜头垂直下降"),
        (r"镜头缓慢推近", "缓慢推近"),
        (r"镜头缓慢拉远", "缓慢拉远"),
        (r"镜头平稳环绕", "环绕"),
        (r"平稳环绕左", "环绕左"),
        (r"平稳环绕右", "环绕右"),
        (r"平稳环绕", "环绕"),
        (r"镜头固定机位", "固定机位"),
        (r"镜头平稳跟拍", "平稳跟拍"),
        (r"镜头轻微手持晃动", "轻微手持晃动"),
        (r"缓慢推近。缓慢推近", "缓慢推近"),
        (r"缓慢拉远。缓慢拉远", "缓慢拉远"),
        (r"固定机位。固定机位", "固定机位"),
    ];

    let mut result = prompt.to_string();
    for (pattern, replacement) in &re_map {
        result = regex::Regex::new(pattern).unwrap()
            .replace_all(&result, *replacement)
            .to_string();
    }

    if result != prompt {
        info!(
            "[DeepSeek清洗] terminology mapped for Wan2.7 → {} chars (was {})",
            result.len(), prompt.len()
        );
    }

    result
}

/// Split prompt into creative context header (before first shot) + shot bodies.
/// Returns (header, shots_text). Header is preserved verbatim; only shots_text is cleaned.
fn split_header_and_shots(prompt: &str) -> (String, String) {
    // Match the first "第N个镜头" or "第N个Shot" marker
    let marker_re = regex::Regex::new(r"(第\d+个(?:镜头|Shot|shot))").unwrap();
    if let Some(m) = marker_re.find(prompt) {
        let split_at = m.start();
        let header = prompt[..split_at].trim().to_string();
        let shots = prompt[split_at..].to_string();
        (header, shots)
    } else {
        // No shot markers found — treat the whole thing as shots
        (String::new(), prompt.to_string())
    }
}

pub async fn clean_video_prompt(
    storyboard_prompt: &str,
    grid_frames: &[String],
    api_key: &str,
    target_model: Option<&str>,
    reference_images: Option<&[String]>,
) -> Result<String, AIError> {
    // Pick system prompt based on model
    let is_happyhorse = target_model.map(|m| m.contains("happyhorse")).unwrap_or(false);
    let system_prompt = if is_happyhorse {
        VIDEO_CLEAN_HAPPYHORSE_PROMPT
    } else {
        VIDEO_CLEAN_SYSTEM_PROMPT
    };

    // Split header (creative context) from shot bodies BEFORE cleaning.
    // The header establishes lighting, style, narrative intent — it must be preserved.
    // Only per-shot descriptions (visual details anchored by grid images) get cleaned.
    let (header, shots_text) = split_header_and_shots(storyboard_prompt);

    info!(
        "[提示词清洗] target={}, split result — header: {} chars, shots: {} chars",
        target_model.unwrap_or("wan"), header.len(),
        shots_text.len()
    );

    // Pre-process: local terminology mapping on shots only
    let replaced = hard_replace_camera(&shots_text);

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()?;

    let mut user_content = String::from("=== 分镜提示词（需清洗） ===\n");
    user_content.push_str(&replaced);

    if !grid_frames.is_empty() {
        user_content.push_str("\n\n=== 宫格帧内容（参考依据） ===\n");
        for (i, frame) in grid_frames.iter().enumerate() {
            user_content.push_str(&format!("宫格{}: {}\n", i + 1, frame));
        }
    }

    user_content.push_str("\n请按规则清洗上述分镜提示词，输出清洗后的结果。");

    let request = GatewayRequest {
        model: CLEAN_MODEL.to_string(),
        system: system_prompt.to_string(),
        messages: vec![GatewayMessage {
            role: "user".to_string(),
            content: user_content,
        }],
        max_tokens: 2048,
        stream: false,
    };

    if api_key.is_empty() {
        return Err(AIError::Provider("API密钥未配置".to_string()));
    }

    info!(
        "[提示词清洗] gateway request, input: {} chars, frames: {}",
        storyboard_prompt.len(),
        grid_frames.len()
    );

    let response = client
        .post(GATEWAY_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        warn!(
            "[提示词清洗] gateway error {}: {}",
            status,
            error_text
        );
        // Fallback: return the locally-replaced version on gateway failure
        return Ok(replaced);
    }

    let result: serde_json::Value = response.json().await.map_err(|e| {
        AIError::Provider(format!("Gateway response parse error: {}", e))
    })?;

    let cleaned = extract_response_text(&result);

    if cleaned.is_empty() {
        info!("[提示词清洗] gateway returned empty, using local replacement");
        // Recombine header with locally-replaced shots
        return Ok(if header.is_empty() {
            replaced
        } else {
            format!("{}\n{}", header, replaced)
        });
    }

    let combined_len = header.len() + cleaned.len();
    info!(
        "[提示词清洗] complete, header: {} chars + cleaned: {} chars = combined: {} chars",
        header.len(),
        cleaned.len(),
        combined_len
    );

    Ok(if header.is_empty() {
        cleaned
    } else {
        format!("{}\n{}", header, cleaned)
    })
}
