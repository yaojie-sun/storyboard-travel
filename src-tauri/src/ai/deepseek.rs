use reqwest::Client;
use serde::Serialize;
use tokio::time::Duration;
use tracing::info;

use crate::ai::error::AIError;

const GATEWAY_URL: &str = "https://aixiaoxi.top/jy/api/v1/gateway/v1/messages";
const OPTIMIZE_MODEL: &str = "claude-sonnet-4-6";

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

