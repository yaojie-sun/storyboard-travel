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

const VIDEO_CLEAN_HAPPYHORSE_PROMPT: &str = r#"你是一个视频提示词清洗器。清洗分镜提示词，保留 Begin with Shot / Then Shot / Cut to Shot 分镜结构。

【铁律】
- 保留原有分镜结构（Begin with Shot N [X-Ys] / Then Shot N [X-Ys] / Cut to Shot N [X-Ys]），时间码 [X-Ys] 不变，禁止改写成 S1/S2、"第N个镜头" 等其它格式
- 声音和台词逐字保留原文，一字不改
- 禁止光影/场景/角色外观/道具外观
- 禁止 [Image N] / [Image1] / 图N / 图1 等一切参考图文本引用（参考图由 media 数组提供，无需也不应在提示词里写）
- 禁止分辨率/画幅/模型名
- 禁止在动作内塞秒级量化（如 1.5秒转身、0.5秒插袋、2秒后抬头）——时间只由 [X-Ys] 括号统一控制，欢乐马1.1 对秒级量化执行过于字面化
- 【平滑运镜·禁止硬切】同一目的地/同一空间连续递进（外部全景→门头→大厅→核心体验→高潮→收尾）时镜头之间禁止硬切、跳切、幻灯片式切换，必须用连续平滑运镜自然衔接（推近/拉远/摇移/环绕/跟拍/升降/无人机一气呵成），让六格丝滑连成一镜到底的完整短片。Cut to Shot 仅用于空间根本性变化（换目的地/换时间段），同一空间递进内一律用 Then Shot 平滑过渡，禁止逐格用 static 定点硬切

【输出格式】每个Shot一行，保持原有分镜结构。同一空间的连续镜头优先用 Then Shot 平滑衔接，禁止每格都 Cut to 硬切：
Begin with Shot 1 [0-3s]: {运镜}。{动作≤15字}。{声音}
Then Shot 2 [3-8s]: {运镜}。{动作≤15字}。{声音}
Then Shot 3 [8-12s]: {运镜}。{动作≤15字}。{声音}

【旅游写实·真人质感】画面必须实景拍摄质感，动作/表情用自然真人语序英文，禁止塑料感：静止镜头也有呼吸起伏、重心微移、自然眨眼、发丝微动；户外场景光影时段由参考图锁定，自然材质纹理、大气透视、真实不完全完美。禁止用：CG look | plastic texture | 3D render | video game graphics | doll-like | wax figure | dead eyes | frozen expression | robotic movement | uncanny | over-smooth | oversaturated colors。

【旅游术语标准译法 — 中文→英文时必须使用以下精确译法，禁止自由发挥】
- 无人机拉升/航拍拉升 → drone pull-up
- 无人机环绕/航拍环绕 → drone orbit
- 无人机穿越/航拍穿越 → drone fly-through
- POV步行/第一人称步行/探店 → POV walkthrough
- 慢推招牌/酒店门头/店面招牌 → slow push-in signage
- 微距特写/美食特写/材质特写 → macro close-up
- 延时摄影/日出日落/云海/车流 → time-lapse

【运镜仅限】优先连续平滑运镜（跨格衔接禁止用 static 硬切）：drone pull-up | drone orbit | drone fly-through | POV walkthrough | slow push-in signage | macro close-up | time-lapse | slow push-in | slow pull-out | smooth pan L->R | smooth pan R->L | smooth tracking | orbit L | orbit R | tilt up | tilt down | crane up | crane down | slight handheld shake | static（仅用于起始/收尾定格，不用于跨格衔接）

【约束】动作≤15字。全部英文。纯文本输出。末尾加一句：No text overlays, no watermarks, no subtitles, no dialogue boxes, no captions."#;

/// Split prompt into creative context header (before first shot) + shot bodies.
/// Returns (header, shots_text). Header is preserved verbatim; only shots_text is cleaned.
fn split_header_and_shots(prompt: &str) -> (String, String) {
    // Match the first "Begin with Shot" marker（欢乐马1.1 官方分镜格式）
    let marker_re = regex::Regex::new(r"(?i)Begin with Shot").unwrap();
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
    let system_prompt = VIDEO_CLEAN_HAPPYHORSE_PROMPT;

    // Split header (creative context) from shot bodies BEFORE cleaning.
    // The header establishes lighting, style, narrative intent — it must be preserved.
    // Only per-shot descriptions (visual details anchored by grid images) get cleaned.
    let (header, shots_text) = split_header_and_shots(storyboard_prompt);

    info!(
        "[提示词清洗] target={}, split result — header: {} chars, shots: {} chars",
        target_model.unwrap_or("happyhorse"), header.len(),
        shots_text.len()
    );

    // 欢乐马格式：shots_text 直接作为清洗输入，无需额外术语映射
    let replaced = shots_text;

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
