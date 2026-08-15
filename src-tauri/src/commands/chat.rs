use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tracing::{info, warn};
use uuid::Uuid;

use crate::ai::deepseek;
use crate::commands::banana_api;

const SKILL_VERSION_URL: &str = "https://aixiaoxi.top/jy/uploads/install_guide/files/version_travel.txt";

const GATEWAY_MESSAGES_URL: &str = "https://aixiaoxi.top/jy/api/v1/gateway/v1/messages";
const CHAT_MODEL: &str = "claude-sonnet-4-6";
const CHAT_MAX_TOKENS: u32 = 8192;
const ANALYSIS_MODEL: &str = "deepseek-v4-flash";
const ANALYSIS_MAX_TOKENS: u32 = 2048;

const STORY_ANALYSIS_SYSTEM_PROMPT: &str = r#"你是一位资深的影视项目策划专家，擅长分析故事大纲并提取结构化参数。请分析用户提供的项目信息，输出以下 JSON 格式（仅 JSON，不要其他文字）：

{
  "logline": "用一句话概括故事核心",
  "genre": "故事类型/风格",
  "themes": ["主题1", "主题2"],
  "characters": [
    { "name": "角色名", "archetype": "角色原型", "arc": "角色弧线" }
  ],
  "visual_style": {
    "color_palette": "色彩倾向",
    "lighting": "光影风格",
    "camera": "运镜风格"
  },
  "pacing": "叙事节奏描述",
  "analysis_summary": "对项目的综合分析，200字以内的连贯段落描述"
}"#;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    system: String,
    messages: Vec<ChatMessageDto>,
    max_tokens: u32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    billing_tag: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChatResponse {
    pub chat_id: String,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct StoryAnalysisResult {
    pub logline: String,
    pub genre: String,
    pub themes: Vec<String>,
    pub characters: Vec<AnalysisCharacter>,
    pub visual_style: AnalysisVisualStyle,
    pub pacing: String,
    pub analysis_summary: String,
    pub raw_json: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AnalysisCharacter {
    pub name: String,
    pub archetype: String,
    pub arc: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AnalysisVisualStyle {
    pub color_palette: String,
    pub lighting: String,
    pub camera: String,
}

fn get_skill_dir() -> Result<std::path::PathBuf, String> {
    let home = directories::UserDirs::new()
        .ok_or("无法解析用户主目录")?
        .home_dir()
        .to_path_buf();
    Ok(home.join(".claude/skills/xiaoya-ai-cinema-travel"))
}

/// Ensure SKILL.md exists. If not, try to download the skill package on the fly.
async fn ensure_skill_md() -> Result<String, String> {
    let skill_dir = get_skill_dir()?;
    let skill_path = skill_dir.join("SKILL.md");

    if !skill_path.exists() {
        // Skill not yet downloaded — try to fetch it now
        info!("[Chat] SKILL.md 不存在，尝试自动下载...");
        let skills_parent = skill_dir
            .parent()
            .ok_or("无法解析 skills 目录")?;
        crate::commands::banana_api::sync_xiaoya_skill_public(skills_parent).await;
    }

    std::fs::read_to_string(&skill_path)
        .map_err(|_| "技能文件下载失败，请检查网络后重新打开对话面板".to_string())
}

/// Extract text from an LLM-format response.
/// Response format: { "content": [ { "type": "text", "text": "..." } ] }
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

/// Fallback: try to extract text from choices[0].message.content (LLM format)
fn extract_openai_text(response: &serde_json::Value) -> String {
    response
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

#[tauri::command]
pub(crate) async fn chat_send_message(
    messages: Vec<ChatMessageDto>,
    project_context: String,
    billing_tag: Option<String>,
) -> Result<ChatResponse, String> {
    let chat_id = Uuid::new_v4().to_string();
    info!("[Chat] 新对话请求 chat_id={}", chat_id);

    let mut system_prompt = ensure_skill_md().await?;
    info!("[Chat] SKILL.md 已加载 ({} 字符)", system_prompt.len());

    // 注入项目全局上下文（如果有）
    if !project_context.is_empty() {
        system_prompt.push_str("\n\n【项目全局上下文】\n");
        system_prompt.push_str(&project_context);
        info!("[Chat] 项目上下文已注入 ({} 字符)", project_context.len());
    }

    // 通用约束 — 不绑定任何特定模型，所有模型共用的基本规则
    // 模型专属规则（格式、运镜、示例）全部在 SKILL.md 中定义，升级技能文件即可生效
    system_prompt.push_str(
        "\n\n【通用约束 — 所有模型共享，不可协商】\n\
        1. 宫格分镜图永远是 2×3 六宫格。绝对禁止 3×3 九宫格。\n\
        2. 禁止向用户显示或提及任何 AI 模型名称。\n\
        3. 严格按照 SKILL.md 中定义的提示词格式和运镜规则输出。\n\
        4. 物体持久：所有物体在视频全程逐帧存在，数量与宫格一致。禁止消失或新增。\n\
        5. 故事板=唯一视觉真相：画面内容全看参考图，文字只提供运镜和动作指令。\n\
        6. 遵守180度轴线规则，摄像机不越轴。\n\
        7. 禁止使用\"电影感\"\"大片质感\"\"高清摄影\"\"顶级CG\"\"史诗级\"等抽象模板词。\n\
        8. 绝对禁止 @图N / Image N 语法指代参考图。参考图由宫格故事板锁定。\n\
        9. 禁止在提示词中写分辨率（4K/1080P/720P）和画幅比例（16:9/9:16 等）。",
    );

    // 【分镜映射】铁律 — 放在最前面，AI 第一眼看到
    system_prompt.push_str(
        "\n\n🔴 【分镜映射】铁律 — 最高优先级，先于所有规则：\n\
        每次生成宫格提示词后，必须紧接着输出【分镜映射】JSON块。\n\
        {\"shots\":[{\"shot\":1,\"time\":\"0-Xs\",\"frames\":[1,2],\"camera\":\"...\",\"sound\":\"...\"},...]}\n\
        shots[].frames=该镜头覆盖的宫格帧编号(1-6)。6帧必须全覆盖[1..6]。\n\
        无论第1段还是第2段、第3段，每次生成宫格提示词都必须输出此JSON。不可省略。\n",
    );

    // Unified instruction — same system prompt for every request so DeepSeek cache hits
    system_prompt.push_str(
        "\n\nCRITICAL — READ THE USER'S LAST MESSAGE (apply the FIRST matching rule):\n\
        [1] If user message contains 💡 or \"爆款灵感\" or \"灵感\" → ignore ALL below. Follow the \"💡 爆款灵感模式\" workflow in SKILL.md. Do NOT output 【视频提示词】.\n\
        [2] If user message is a single digit \"1\" / \"2\" / \"3\" → user selected an inspiration scheme. Duration & segment plan already set. Skip to Step 2. Output the L1 split confirmation: \"📐 您的内容预计需要 {总时长} 秒，需要分 {N} 段来实现。回复 G 开始生成第一段。G — 生成第 1 段    X — 修改分段\". Wait. Do NOT output any prompt header.\n\
        [2X] If user said \"X\" or \"X-修改分段\": user wants to adjust the split plan. Ask what changes they want (fewer/more segments, different duration, etc.). Do NOT output any prompt header.\n\
        [3] If user said \"G\" or \"G-生成\": user confirmed L1 split plan. Generate the CURRENT segment's video prompt now. Output 【视频提示词】+ shots. Then follow step 7 (L2 grid question: \"需要生成2×3六宫格分镜图吗？A-生成 B-不生成\").\n\
        [4] If user described a video idea (not \"A\", not \"B\", not \"灵感\", not \"继续\", not \"暂停\", not \"G\", not \"X\"): output up to step 7.\n\
          If the video needs multiple segments (>15s), output L1 split confirmation first (per SKILL.md Step 2 item 7). Do NOT start with 【视频提示词】 until L1 is confirmed.\n\
          If single segment (≤15s), your response MUST start with 【视频提示词】, then output the prompt with appropriate number of shots (per SKILL.md: ≤5s=1 shot, 6-10s=1-3 shots, 11-15s=2-4 shots). Then STOP with L2 grid question.\n\
        [5] If user said \"A\" or \"A-生成\": output 【分镜提示词】+ grid frames per step 8. Frames start from numbered items (1、2、…6、) — NO style anchor/camera/description headers.\n\
          IMMEDIATELY after the 6 frames, output 【分镜映射】 JSON mapping each video shot to its grid frames: {\"shots\":[{\"shot\":1,\"time\":\"0-Xs\",\"frames\":[1,2,3],\"camera\":\"...\",\"sound\":\"...\"},{\"shot\":2,\"time\":\"X-Ys\",\"frames\":[4,5,6],\"camera\":\"...\",\"sound\":\"...\"}]}\n\
          shots[].shot = shot number. shots[].time = from video prompt \"Begin with Shot N [X-Ys]\" / \"Then Shot N [X-Ys]\" / \"Cut to Shot N [X-Ys]\" time bracket exactly. shots[].frames = grid frame numbers (1-6) this shot covers. shots[].camera/sound/bgm = from video prompt.\n\
          ALL 6 frames [1..6] MUST be covered across all shots. This 【分镜映射】 JSON is MANDATORY for EVERY segment. Both segment 1 AND segment 2 must have it.\n\
          THEN, if multi-segment AND not final segment, output L3: 【继续确认】\\n第N段已完成。是否继续生成第N+1段[标题]？\\n继续-生成下一段 暂停-先处理当前内容\n\
        [6] If user said \"继续\" or \"继续-生成下一段\": generate NEXT segment's video prompt (Step 3 onward). Output 【视频提示词】+ next segment shots. When later user says \"A\" to generate grid for THIS segment, also output 【分镜映射】 JSON — same as rule [5].\n\
        [7] If user said \"B\" or \"B-不生成\": skip grid. If multi-segment, output L3 【继续确认】. Only full-stop on \"暂停\" or \"B-暂停\".\n\
        [8] If user said \"暂停\" or \"B-暂停\": stop. Brief ack. No prompt block headers.\n\
        \n\
        MANDATORY for single-segment: end with \"需要生成2×3六宫格分镜图吗？A-生成 B-不生成\".\n\
        DO NOT output 【分镜提示词】 until user replies \"A\".",
    );

    let device_token = {
        let store = banana_api::get_device_token_store();
        let guard = store.lock().await;
        guard
            .clone()
            .ok_or("未登录，请先登录".to_string())?
    };

    let api_key = match banana_api::get_user_api_key(&device_token).await {
        Ok(key) if !key.is_empty() => key,
        other => {
            warn!("[Chat] get_user_api_key 失败({:?})，回退到 ensure_user_api_token", other.as_ref().err());
            banana_api::ensure_user_api_token(&device_token).await?
        }
    };
    info!("[Chat] API Key 已获取");

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let request_body = ChatRequest {
        model: CHAT_MODEL.to_string(),
        system: system_prompt.clone(),
        messages: messages.clone(),
        max_tokens: CHAT_MAX_TOKENS,
        stream: false,
        billing_tag: billing_tag.clone(),
    };

    let response = client
        .post(GATEWAY_MESSAGES_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("网关请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let err_msg = format!("网关返回错误 ({}): {}", status, body);
        warn!("[Chat] {}", err_msg);
        return Err(err_msg);
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应 JSON 失败: {}", e))?;

    let text = {
        let anthropic_text = extract_anthropic_text(&response_json);
        if !anthropic_text.is_empty() {
            anthropic_text
        } else {
            extract_openai_text(&response_json)
        }
    };

    let text_len = text.len();
    info!("[Chat] 响应完成 chat_id={} len={}", chat_id, text_len);

    if text.is_empty() {
        warn!("[Chat] 响应文本为空 chat_id={}", chat_id);
        return Ok(ChatResponse { chat_id, text });
    }

    // 拦截 <search> 标签：AI 请求搜索 → 执行搜索 → 注入结果 → 再调用 AI
    if let Some(search_text) = intercept_search_and_continue(
        &text, &client, &api_key, &system_prompt, &messages, &billing_tag,
    ).await {
        info!("[Chat] 搜索完成，已注入结果 chat_id={}", chat_id);
        return Ok(ChatResponse { chat_id, text: search_text });
    }

    Ok(ChatResponse { chat_id, text })
}

/// 检测响应中的 <search> 标签，执行搜索，调用 AI 继续生成
async fn intercept_search_and_continue(
    text: &str,
    client: &reqwest::Client,
    api_key: &str,
    system_prompt: &str,
    messages: &[ChatMessageDto],
    billing_tag: &Option<String>,
) -> Option<String> {
    let search_re = regex::Regex::new(r"<search>\s*<query>([\s\S]*?)</query>\s*<source>web</source>\s*</search>").ok()?;

    // Collect all queries from all search blocks (SKILL.md requires ≥2 searches for inspiration)
    let mut all_queries: Vec<String> = Vec::new();
    for caps in search_re.captures_iter(text) {
        if let Some(q) = caps.get(1) {
            let query = q.as_str().trim().to_string();
            if !query.is_empty() {
                all_queries.push(query);
            }
        }
    }
    if all_queries.is_empty() { return None; }

    info!("[Chat] 拦截到 {} 个搜索请求", all_queries.len());

    // Execute all searches and combine results
    let mut search_results = String::new();
    for query in &all_queries {
        match web_search(query).await {
            Ok(r) => {
                search_results.push_str(&format!("\n--- 搜索: {} ---\n{}\n", query, r));
            }
            Err(e) => {
                warn!("[Chat] 搜索失败: {}", e);
                search_results.push_str(&format!("\n--- 搜索: {} ---\n(无结果)\n", query));
            }
        }
    }

    info!("[Chat] 搜索完成, 合并结果长度={}", search_results.len());

    // 构造续写消息
    let continuation_prompt = format!(
        "<search_results>\n{}\n</search_results>\n\n请根据以上搜索结果，继续完成你的回复。严格遵循 SKILL.md 的爆款灵感工作流，输出创意方案（🔥 方案 1/2/3）。",
        &search_results[..search_results.len().min(4000)]
    );

    let mut continued_messages: Vec<ChatMessageDto> = messages.to_vec();
    continued_messages.push(ChatMessageDto {
        role: "assistant".to_string(),
        content: text.to_string(),
    });
    continued_messages.push(ChatMessageDto {
        role: "user".to_string(),
        content: continuation_prompt,
    });

    // 续写标签：灵感首次扣 3 分后，续写不再扣分
    let continue_tag = match billing_tag.as_deref() {
        Some("inspiration") => Some("inspiration_continue".to_string()),
        _ => None,
    };

    let request_body = ChatRequest {
        model: CHAT_MODEL.to_string(),
        system: system_prompt.to_string(),
        messages: continued_messages,
        max_tokens: CHAT_MAX_TOKENS,
        stream: false,
        billing_tag: continue_tag,
    };

    let response = client
        .post(GATEWAY_MESSAGES_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .ok()?;

    let response_json: serde_json::Value = response.json().await.ok()?;
    let continued_text = {
        let t = extract_anthropic_text(&response_json);
        if !t.is_empty() { t } else { extract_openai_text(&response_json) }
    };

    if continued_text.is_empty() { None } else { Some(continued_text) }
}

/// 简易网页搜索（Bing HTML，国内可访问，无需 API Key）
async fn web_search(query: &str) -> Result<String, String> {
    let url = format!(
        "https://cn.bing.com/search?q={}&setlang=zh-cn",
        urlencoding::encode(query)
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("search client: {e}"))?;

    let html = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {e}"))?
        .text()
        .await
        .map_err(|e| format!("搜索读取失败: {e}"))?;

    // 提取 Bing 搜索结果：<li class="b_algo"> 块中的标题和摘要
    let mut results = String::new();
    let mut count = 0;

    // 按 <li class="b_algo"> 分割
    for chunk in html.split("<li class=\"b_algo\"") {
        if count >= 10 {
            break;
        }
        // 提取标题：<h2> 中的 <a> 文本
        if let Some(h2_start) = chunk.find("<h2>") {
            let h2_section = &chunk[h2_start..];
            if let Some(a_start) = h2_section.find("<a ") {
                let a_section = &h2_section[a_start..];
                if let Some(inner_start) = a_section.find('>') {
                    let title_part = &a_section[inner_start+1..];
                    if let Some(inner_end) = title_part.find("</a>") {
                        let title = title_part[..inner_end]
                            .replace("<strong>", "").replace("</strong>", "")
                            .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                            .replace("&quot;", "\"").replace("&#39;", "'")
                            .trim().to_string();
                        if !title.is_empty() {
                            results.push_str(&format!("• {}\n", title));
                            count += 1;
                        }
                    }
                }
            }
        }
        // 提取摘要：class="b_caption" 中的 <p> 文本
        if let Some(cap_start) = chunk.find("class=\"b_caption\"") {
            let cap_section = &chunk[cap_start..];
            if let Some(p_start) = cap_section.find("<p") {
                let p_section = &cap_section[p_start..];
                if let Some(inner_start) = p_section.find('>') {
                    let snippet_part = &p_section[inner_start+1..];
                    if let Some(inner_end) = snippet_part.find("</p>") {
                        let snippet = snippet_part[..inner_end]
                            .replace("<strong>", "").replace("</strong>", "")
                            .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                            .replace("&quot;", "\"").replace("&#39;", "'")
                            .trim().to_string();
                        if !snippet.is_empty() {
                            results.push_str(&format!("  {}\n", snippet));
                        }
                    }
                }
            }
        }
    }

    if results.is_empty() {
        Err("搜索无结果".into())
    } else {
        Ok(results)
    }
}

/// 清洗视频分镜提示词 — DeepSeek 去掉光影/场景/外观，只保留运镜+精简动作+声音
/// 确保文字描述不超出宫格图已锚定的画面内容
#[tauri::command]
pub(crate) async fn integrate_video_prompt(
    storyboard_prompt: String,
    grid_frames: Vec<String>,
    target_model: Option<String>,
    reference_images: Option<Vec<String>>,
) -> Result<String, String> {
    let chat_id = Uuid::new_v4().to_string();
    info!("[Integrate] 视频提示词清洗 chat_id={}, grid_frames={}", chat_id, grid_frames.len());

    let device_token = {
        let store = banana_api::get_device_token_store();
        store.lock().await.clone().unwrap_or_default()
    };
    let api_key = match banana_api::get_user_api_key(&device_token).await {
        Ok(key) => key,
        Err(_) => {
            banana_api::ensure_user_api_token(&device_token).await.unwrap_or_default()
        }
    };

    match deepseek::clean_video_prompt(
        &storyboard_prompt,
        &grid_frames,
        &api_key,
        target_model.as_deref(),
        reference_images.as_deref(),
    ).await {
        Ok(cleaned) => {
            info!("[Integrate] 清洗完成 chat_id={} len={}", chat_id, cleaned.len());
            Ok(cleaned)
        }
        Err(e) => {
            warn!("[Integrate] 清洗失败，降级为原文: {}", e);
            // 降级：清洗失败时返回原文，不阻塞流程
            Ok(storyboard_prompt)
        }
    }
}

/// Analyze story outline via gateway API, reusing same auth/billing flow as chat
#[tauri::command]
pub(crate) async fn analyze_story(
    story_outline: String,
    aspect_ratio: String,
    style: String,
    tone: String,
    director_ref: String,
    emphasis_dimensions: Vec<String>,
) -> Result<StoryAnalysisResult, String> {
    let chat_id = Uuid::new_v4().to_string();
    info!("[Analyze] 故事分析请求 chat_id={}", chat_id);

    // Build user message with story + params
    let mut user_content = format!("【故事大纲】\n{}\n\n", story_outline);
    if !aspect_ratio.is_empty() {
        user_content.push_str(&format!("画幅比例: {}\n", aspect_ratio));
    }
    if !style.is_empty() {
        user_content.push_str(&format!("视觉风格: {}\n", style));
    }
    if !tone.is_empty() {
        user_content.push_str(&format!("项目调性: {}\n", tone));
    }
    if !director_ref.is_empty() {
        user_content.push_str(&format!("旅行视频风格: {}\n", director_ref));
    }
    if !emphasis_dimensions.is_empty() {
        user_content.push_str(&format!("提示词重点维度: {}\n", emphasis_dimensions.join(", ")));
    }

    let device_token = {
        let store = banana_api::get_device_token_store();
        let guard = store.lock().await;
        guard
            .clone()
            .ok_or("未登录，请先登录".to_string())?
    };

    let api_key = match banana_api::get_user_api_key(&device_token).await {
        Ok(key) if !key.is_empty() => key,
        other => {
            warn!("[Analyze] get_user_api_key 失败({:?})，回退到 ensure_user_api_token", other.as_ref().err());
            banana_api::ensure_user_api_token(&device_token).await?
        }
    };
    info!("[Analyze] API Key 已获取");

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let request_body = serde_json::json!({
        "model": ANALYSIS_MODEL,
        "system": STORY_ANALYSIS_SYSTEM_PROMPT,
        "messages": [
            { "role": "user", "content": user_content }
        ],
        "max_tokens": ANALYSIS_MAX_TOKENS,
        "stream": false
    });

    let response = client
        .post(GATEWAY_MESSAGES_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("网关请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("网关返回错误 ({}): {}", status, body));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应 JSON 失败: {}", e))?;

    let text = {
        let anthropic_text = extract_anthropic_text(&response_json);
        if !anthropic_text.is_empty() {
            anthropic_text
        } else {
            extract_openai_text(&response_json)
        }
    };

    info!("[Analyze] 分析完成 chat_id={} len={}", chat_id, text.len());

    if text.is_empty() {
        return Err("AI 返回为空，请重试".to_string());
    }

    // Try to parse JSON from the response
    let json_str = text.trim();
    // Strip markdown code block if present
    let json_str = if json_str.starts_with("```") {
        let start = json_str.find('\n').map(|i| i + 1).unwrap_or(0);
        let end = json_str.rfind("```").unwrap_or(json_str.len());
        json_str[start..end].trim()
    } else {
        json_str
    };

    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("AI 返回的 JSON 解析失败: {}，原文: {}", e, text))?;

    let default_list = || Vec::<String>::new();
    let default_characters = || Vec::<AnalysisCharacter>::new();
    let default_visual = || AnalysisVisualStyle {
        color_palette: String::new(),
        lighting: String::new(),
        camera: String::new(),
    };

    Ok(StoryAnalysisResult {
        logline: parsed.get("logline").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        genre: parsed.get("genre").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        themes: parsed.get("themes").and_then(|v| v.as_array()).map(|a| {
            a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
        }).unwrap_or_else(default_list),
        characters: parsed.get("characters").and_then(|v| v.as_array()).map(|a| {
            a.iter().filter_map(|item| {
                Some(AnalysisCharacter {
                    name: item.get("name")?.as_str()?.to_string(),
                    archetype: item.get("archetype")?.as_str()?.to_string(),
                    arc: item.get("arc")?.as_str()?.to_string(),
                })
            }).collect()
        }).unwrap_or_else(default_characters),
        visual_style: parsed.get("visual_style").map(|v| AnalysisVisualStyle {
            color_palette: v.get("color_palette").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            lighting: v.get("lighting").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            camera: v.get("camera").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        }).unwrap_or_else(default_visual),
        pacing: parsed.get("pacing").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        analysis_summary: parsed.get("analysis_summary").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        raw_json: json_str.to_string(),
    })
}

const CHAT_DIR_NAME: &str = "chat";

fn resolve_chat_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::sync::get_user_dir(app)?.join(CHAT_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 chat dir 失败: {}", e))?;
    Ok(dir)
}

fn resolve_chat_path(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = resolve_chat_dir(app)?;
    // 物理隔离：每个项目一个文件，从存储层面杜绝跨项目数据混淆
    let filename = if project_id.is_empty() {
        "global.json".to_string()
    } else {
        format!("{}.json", project_id)
    };
    Ok(dir.join(filename))
}

#[tauri::command]
pub(crate) fn save_chat_conversations(app: AppHandle, project_id: String, json: String) -> Result<(), String> {
    let path = resolve_chat_path(&app, &project_id)?;
    // 原子写入
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json).map_err(|e| format!("保存对话失败: {}", e))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("保存对话失败: {}", e))?;
    info!("[Chat] 对话已保存到 {} (project={})", path.display(), project_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn load_chat_conversations(app: AppHandle, project_id: String) -> Result<String, String> {
    let path = resolve_chat_path(&app, &project_id)?;
    match std::fs::read_to_string(&path) {
        Ok(json) => {
            Ok(json)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok("[]".to_string())
        }
        Err(e) => {
            Err(format!("加载对话失败: {}", e))
        }
    }
}

/// 迁移旧版单文件 chat_conversations.json → 新版 per-project chat/*.json
/// 安全策略：
///   1. 不改动旧文件（先备份再操作）
///   2. 优先用 conversation.projectId，没有则从 episodeId → episodes 表反查 project_id
///   3. 无法确定归属的放入 global.json
///   4. 迁移完成后旧文件重命名为 .bak，可手动恢复
#[tauri::command]
pub(crate) fn migrate_chat_storage(app: AppHandle) -> Result<String, String> {
    let user_dir = crate::sync::get_user_dir(&app)?;
    let old_path = user_dir.join("chat_conversations.json");

    if !old_path.exists() {
        return Ok("no_old_file".to_string());
    }

    // 先备份旧文件，绝不直接修改/删除
    let bak = old_path.with_extension("json.bak");
    std::fs::copy(&old_path, &bak)
        .map_err(|e| format!("备份旧文件失败: {}", e))?;
    tracing::info!("[Chat migration] 旧文件已备份到 {:?}", bak);

    let content = std::fs::read_to_string(&old_path)
        .map_err(|e| format!("读取旧文件失败: {}", e))?;

    let conversations: Vec<serde_json::Value> = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => {
            // 格式异常，保留备份，不迁移（旧文件不动）
            return Ok("invalid_json_backed_up".to_string());
        }
    };

    if conversations.is_empty() {
        // 空文件，直接标记为已迁移
        std::fs::rename(&old_path, old_path.with_extension("json.bak")).ok();
        return Ok("empty_file_migrated".to_string());
    }

    // 从 SQLite 构建 episodeId → projectId 的映射表
    let ep_to_project: std::collections::HashMap<String, String> = {
        let db_path = user_dir.join("projects.db");
        if db_path.exists() {
            match rusqlite::Connection::open(&db_path) {
                Ok(conn) => {
                    let mut map = std::collections::HashMap::new();
                    if let Ok(mut stmt) = conn.prepare("SELECT id, project_id FROM episodes") {
                        if let Ok(rows) = stmt.query_map([], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                        }) {
                            for row in rows.flatten() {
                                map.insert(row.0, row.1);
                            }
                        }
                    }
                    tracing::info!("[Chat migration] episode→project 映射: {} 条", map.len());
                    map
                }
                Err(e) => {
                    tracing::warn!("[Chat migration] 无法打开数据库查询 episode 映射: {}", e);
                    std::collections::HashMap::new()
                }
            }
        } else {
            std::collections::HashMap::new()
        }
    };

    // 分配 projectId：优先用已有字段，其次从 episodeId 反查，最后归入 global
    let mut by_project: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut global_count = 0u32;
    let mut matched_count = 0u32;

    for mut conv in conversations {
        // 1) 已有 projectId → 直接使用
        let existing_pid = conv
            .get("projectId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        let pid = if let Some(p) = existing_pid {
            p.to_string()
        } else {
            // 2) 没有 projectId → 从 episodeId 反查
            let ep_id = conv
                .get("episodeId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            if let Some(ep) = ep_id {
                if let Some(proj_id) = ep_to_project.get(ep) {
                    // 补全 projectId 字段，写回 conversation
                    if let Some(obj) = conv.as_object_mut() {
                        obj.insert(
                            "projectId".to_string(),
                            serde_json::Value::String(proj_id.clone()),
                        );
                    }
                    matched_count += 1;
                    proj_id.clone()
                } else {
                    global_count += 1;
                    "global".to_string()
                }
            } else {
                global_count += 1;
                "global".to_string()
            }
        };

        by_project.entry(pid).or_default().push(conv);
    }

    let chat_dir = resolve_chat_dir(&app)?;
    let mut written = 0u32;

    for (pid, convs) in &by_project {
        let filename = if pid == "global" {
            "global.json".to_string()
        } else {
            format!("{}.json", pid)
        };
        let path = chat_dir.join(&filename);
        let json = serde_json::to_string_pretty(convs)
            .unwrap_or_else(|_| "[]".to_string());
        std::fs::write(&path, &json)
            .map_err(|e| format!("写入 {} 失败: {}", filename, e))?;
        written += convs.len() as u32;
    }

    // 迁移成功 → 重命名旧文件标记为已迁移
    let migrated_path = old_path.with_extension("json.migrated");
    std::fs::rename(&old_path, &migrated_path).ok();

    let msg = format!(
        "迁移完成：{} 条对话 → {} 个项目文件（{} 条从 episode 反查匹配，{} 条归入 global）。旧文件备份在 {:?}",
        written,
        by_project.len(),
        matched_count,
        global_count,
        bak
    );
    tracing::info!("[Chat migration] {}", msg);
    Ok(msg)
}

// ── Skill upgrade check ──

#[derive(Debug, Serialize, Clone)]
pub struct SkillUpgradeInfo {
    pub upgrade_available: bool,
    pub local_version: String,
    pub server_version: String,
    pub description: String,
}

/// Read local skill version from ~/.claude/skills/xiaoya-ai-cinema-travel/version.txt
fn read_local_skill_version() -> Result<String, String> {
    let home = directories::UserDirs::new()
        .ok_or("无法解析用户主目录")?
        .home_dir()
        .to_path_buf();
    let version_path = home.join(".claude/skills/xiaoya-ai-cinema-travel/version.txt");
    let content = std::fs::read_to_string(&version_path)
        .map_err(|e| format!("读取本地 version.txt 失败: {}", e))?;
    parse_version_field(&content).ok_or("本地 version.txt 中未找到 version 字段".into())
}

/// Extract `version=X.Y.Z` from a key=value file
fn parse_version_field(content: &str) -> Option<String> {
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("version=") {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// Extract `description=` from a key=value file
fn parse_description_field(content: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("description=") {
            return value.trim().to_string();
        }
    }
    String::new()
}

/// Compare two semver strings (X.Y.Z). Returns true if a > b.
fn version_greater(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect()
    };
    let va = parse(a);
    let vb = parse(b);
    if va.is_empty() || vb.is_empty() {
        return false;
    }
    va > vb
}

#[tauri::command]
pub(crate) async fn check_skill_upgrade() -> Result<SkillUpgradeInfo, String> {
    // Read local version
    let local_version = read_local_skill_version().unwrap_or_else(|e| {
        warn!("[SkillUpgrade] {}", e);
        "0.0.0".to_string()
    });
    info!("[SkillUpgrade] 本地技能版本: {}", local_version);

    // Fetch server version
    let server_text = match reqwest::get(SKILL_VERSION_URL).await {
        Ok(r) => match r.text().await {
            Ok(t) => t,
            Err(e) => {
                warn!("[SkillUpgrade] 读取服务器 version.txt 失败: {}", e);
                return Ok(SkillUpgradeInfo {
                    upgrade_available: false,
                    local_version,
                    server_version: "?".to_string(),
                    description: String::new(),
                });
            }
        },
        Err(e) => {
            warn!("[SkillUpgrade] 请求服务器 version.txt 失败: {}", e);
            return Ok(SkillUpgradeInfo {
                upgrade_available: false,
                local_version,
                server_version: "?".to_string(),
                description: String::new(),
            });
        }
    };

    let server_version = parse_version_field(&server_text).unwrap_or_else(|| "0.0.0".to_string());
    let description = parse_description_field(&server_text);
    info!("[SkillUpgrade] 服务器技能版本: {}", server_version);

    let upgrade_available = version_greater(&server_version, &local_version);

    Ok(SkillUpgradeInfo {
        upgrade_available,
        local_version,
        server_version,
        description,
    })
}

#[tauri::command]
pub(crate) async fn perform_skill_upgrade() -> Result<SkillUpgradeInfo, String> {
    // Get server version info first
    let server_text = reqwest::get(SKILL_VERSION_URL)
        .await
        .map_err(|e| format!("请求服务器 version.txt 失败: {}", e))?
        .text()
        .await
        .map_err(|e| format!("读取服务器 version.txt 失败: {}", e))?;

    let server_version = parse_version_field(&server_text).unwrap_or_else(|| "?".to_string());
    let description = parse_description_field(&server_text);
    let local_version = read_local_skill_version().unwrap_or_else(|_| "0.0.0".to_string());

    info!("[SkillUpgrade] 开始升级技能: {} -> {}", local_version, server_version);

    // Download and extract the skill zip
    let skill_dir = {
        let home = directories::UserDirs::new()
            .ok_or("无法解析用户主目录")?
            .home_dir()
            .to_path_buf();
        home.join(".claude").join("skills")
    };
    let target_dir = skill_dir.join("xiaoya-ai-cinema-travel");

    let zip_url = format!(
        "https://aixiaoxi.top/jy/uploads/install_guide/files/xiaoya-ai-cinema-travel.zip"
    );

    let response = reqwest::get(&zip_url)
        .await
        .map_err(|e| format!("下载 skill zip 失败: {}", e))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取 skill zip 失败: {}", e))?;

    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("打开 zip 失败: {}", e))?;

    // Detect strip prefix (same logic as sync_xiaoya_skill)
    let first_entry = archive.by_index(0).ok().map(|e| e.name().to_string());
    let strip_prefix = first_entry.as_ref().and_then(|name| {
        let slash_pos = name.find('/');
        slash_pos.map(|pos| format!("{}/", &name[..pos]))
    });

    // Collect entries first (ZipFile is not Send, can't hold across await)
    let mut entries: Vec<(String, bool, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let entry_name = entry.name().to_string();
        let is_dir = entry.is_dir();
        let data = if is_dir {
            Vec::new()
        } else {
            let mut d = Vec::new();
            if std::io::copy(&mut entry, &mut d).is_err() {
                continue;
            }
            d
        };
        entries.push((entry_name, is_dir, data));
    }
    drop(archive);

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("创建目标目录失败: {}", e))?;

    for (entry_name, is_dir, data) in &entries {
        let relative = match &strip_prefix {
            Some(prefix) if entry_name.starts_with(prefix) => &entry_name[prefix.len()..],
            _ => entry_name,
        };
        if relative.is_empty() {
            continue;
        }
        let out_path = target_dir.join(relative);
        if *is_dir {
            let _ = tokio::fs::create_dir_all(&out_path).await;
        } else {
            if let Some(parent) = out_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(&out_path, data).await;
        }
    }

    info!("[SkillUpgrade] 升级完成: {} -> {}", local_version, server_version);

    // 同步 SKILL.md 安全标记，确保小鸭自报版本与 version.txt 一致
    let skill_md_path = target_dir.join("SKILL.md");
    if let Ok(content) = tokio::fs::read_to_string(&skill_md_path).await {
        let marker_prefix = "<!-- SECURITY_MARKER: xiaoya-ai-cinema-travel-protected-skill-v";
        if let Some(start) = content.find(marker_prefix) {
            if let Some(end) = content[start..].find(" -->") {
                let new_marker = format!(
                    "<!-- SECURITY_MARKER: xiaoya-ai-cinema-travel-protected-skill-v{} -->",
                    server_version
                );
                let updated = format!(
                    "{}{}{}",
                    &content[..start],
                    new_marker,
                    &content[start + end + 4..]
                );
                if updated != content {
                    let _ = tokio::fs::write(&skill_md_path, &updated).await;
                    info!("[SkillUpgrade] 安全标记已更新为 v{}", server_version);
                }
            }
        }
    }

    Ok(SkillUpgradeInfo {
        upgrade_available: true, // true because we just upgraded
        local_version,
        server_version,
        description,
    })
}

// ── Video Gen Store persistence ─────────────────────────────────

const VIDEOGEN_STORE_FILENAME: &str = "videogen_store.json";

fn videogen_store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // 仅使用用户隔离目录，未登录时直接报错，不 fallback 全局路径
    crate::sync::get_user_dir(app).map(|dir| dir.join(VIDEOGEN_STORE_FILENAME))
}

#[tauri::command]
pub async fn load_videogen_store(
    app: tauri::AppHandle,
) -> Result<String, String> {
    let path = videogen_store_path(&app)?;
    let bak_path = path.with_extension("json.bak");

    match tokio::fs::read_to_string(&path).await {
        Ok(content) => {
            Ok(content)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match tokio::fs::read_to_string(&bak_path).await {
                Ok(content) => {
                    tracing::info!("[videogen_store] .bak 恢复成功, {} 字节", content.len());
                    // 恢复主文件
                    let _ = tokio::fs::write(&path, &content).await;
                    Ok(content)
                }
                Err(_) => {
                    tracing::debug!("[videogen_store] .bak 也不存在，返回空");
                    Ok("{}".into())
                }
            }
        }
        Err(e) => {
            // 主文件读取失败（可能损坏），尝试 .bak 恢复
            tracing::error!("[videogen_store] 主文件读取失败: {}，尝试 .bak", e);
            match tokio::fs::read_to_string(&bak_path).await {
                Ok(content) => {
                    tracing::info!("[videogen_store] 主文件损坏，.bak 恢复成功, {} 字节", content.len());
                    let _ = tokio::fs::write(&path, &content).await;
                    Ok(content)
                }
                Err(e2) => {
                    tracing::error!("[videogen_store] .bak 也读取失败: {}", e2);
                    Err(format!("读取 videogen_store 失败，备份也无效: {}", e))
                }
            }
        }
    }
}

#[tauri::command]
pub async fn persist_videogen_store(
    app: tauri::AppHandle,
    json: String,
) -> Result<(), String> {
    let path = videogen_store_path(&app)?;
    let tmp_path = path.with_extension("json.tmp");
    let bak_path = path.with_extension("json.bak");

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }

    // 保护旧数据：如果旧文件存在且有真实数据（> 1KB），
    // 新数据为空壳（< 100 字节），拒绝写入防止覆盖
    let new_len = json.len();
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        let old_len = meta.len();
        if old_len > 1024 && new_len < 100 {
            tracing::error!(
                "[videogen_store] 拒绝写入：旧文件 {} 字节（有数据），新数据仅 {} 字节（空壳），跳过！",
                old_len, new_len
            );
            return Ok(());
        }
    }

    // 原子写入：先写 .tmp，再替换旧文件为 .bak，最后 .tmp → 正式文件
    tokio::fs::write(&tmp_path, &json)
        .await
        .map_err(|e| format!("写入临时文件失败: {}", e))?;

    // 将现有正式文件重命名为 .bak（如果存在）
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        if meta.len() > 0 {
            let _ = tokio::fs::rename(&path, &bak_path).await;
        }
    }

    // .tmp → 正式文件
    tokio::fs::rename(&tmp_path, &path)
        .await
        .map_err(|e| format!("重命名临时文件失败: {}", e))?;

    tracing::debug!("[videogen_store] 原子写入完成, {} 字节", new_len);
    Ok(())
}


