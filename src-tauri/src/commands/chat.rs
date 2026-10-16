use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tracing::{info, warn};
use uuid::Uuid;

use crate::commands::banana_api;

const SKILL_VERSION_URL: &str = "https://aixiaoxi.top/jy/uploads/install_guide/files/version_travel.txt";

const GATEWAY_MESSAGES_URL: &str = "https://aixiaoxi.top/jy/api/v1/gateway/v1/messages";
const CHAT_MODEL: &str = "claude-sonnet-4-6";
const CHAT_MAX_TOKENS: u32 = 16384;
/// 分镜分析模型 —— 与读图统一为官方名 `deepseek-flash`。
///
/// ⚠️ 这个名字**走自有网关**（`GATEWAY_MESSAGES_URL`），网关必须认它。
/// 写手的 `CHAT_MODEL` / 提示词优化的 `OPTIMIZE_MODEL` 用的是网关**自有别名**
/// `claude-sonnet-4-6`，不受官方改名约束，**不要一起改**（改了会断链）。
const ANALYSIS_MODEL: &str = "deepseek-flash";
const ANALYSIS_MAX_TOKENS: u32 = 2048;

// ─────────────────────────── 写手规则块（writer_rules/） ───────────────────────────
//
// 🔴 2026-10-13：全盘改用 **STEP 0–9 门机**，旧协议（L1 分段确认 G/X → L2 宫格问
//    A/B → L3 继续确认「继续-生成下一段」）整体下线。旧词表在 `needs_stall_guard`
//    里把 `A` / `B` / `G` / `X` / `1` / `灵感` 当成控制词 —— 新协议下前端**不再发裸词**，
//    改发锚点行 `【阶段】STEPn`（后可跟 `【模式】宫格|直出` / `【修改要求】…` / `【当前版本】…`）。
//
// ⚠️ **块文件开头的空行与结尾的无换行都是有意的**（拼接时的分隔符），别顺手「格式化」。

/// 【通用约束】+ 输出契约 + 内容铁律 —— 正文的唯一存放处。
const BLOCK_CONSTRAINTS: &str = include_str!("writer_rules/block_constraints.md");

/// 【分镜映射】JSON 铁律（宫格链路）—— 正文的唯一存放处。
const BLOCK_MAPPING: &str = include_str!("writer_rules/block_mapping.md");

/// CRITICAL 路由块（产品流程分派）—— 正文的唯一存放处。
const BLOCK_CRITICAL: &str = include_str!("writer_rules/block_critical.md");

/// 「STEP 门机」形状块 —— **只在锚点轮注入**（见调用点说明）。
///
/// 与 [`STALL_GUARD`] 的注入条件**互斥**：护栏给非锚点轮（用户第一次贴脚本），
/// 本块给机器发来的锚点轮。
const STEP_SHAPES: &str = include_str!("writer_rules/step_shapes.md");

/// 「别停」护栏 —— 用户消息**没写时长**时贴在 system 最末。
///
/// 🔴 **只在真的没写时长/控制行时才加**：它是对模型陈述事实的一句话，
/// 写成假话比不写更危险（改词属另一条变更，必须单独重测）。
const STALL_GUARD: &str = include_str!("writer_rules/stall_guard.md");

/// 这一轮用户消息要不要加 [`STALL_GUARD`]。
///
/// 🔴 **2026-10-13：控制轮判据从「词表枚举」换成「结构判据」。**
///
/// 旧协议（词表）必须排除的那些多轮控制消息 —— `A` / `B-不生成` / `继续-生成下一段` /
/// `暂停` / `1` / `💡` / `灵感` —— 在新协议里**整体下线**：前端不再发裸词，改发锚点行。
/// ⇒ 「首行以 `【` 开头」就是「这是机器发来的控制轮」的**结构性等价物**，不会随词表漂移。
///
/// ⚠️ **旧词表必须一并删掉，不能留着当保险**：新协议下 `A` 不再是控制词，
/// 留着它反而会把「用户真的写了一句话脚本以 A 开头」那一轮漏掉护栏。半改比不改更危险。
///
/// ⚠️ **判据只看首行**：锚点行后面还跟着 `【模式】…` 等控制细节，整条消息比对会漏掉它。
/// 不用长度阈值 —— 「一个人在海边跑」这种短创意不能被误判成控制词。
fn needs_stall_guard(user_msg: &str) -> bool {
    if user_msg.is_empty() {
        return false;
    }
    let first_line = user_msg.lines().next().unwrap_or("").trim();
    if first_line.starts_with('【') || first_line.starts_with("暂停") {
        return false;
    }
    true
}

/// 从锚点**首行**解析步骤号：`【阶段】STEP6` → `Some("STEP6")`、`【阶段】STEP5.5` → `Some("STEP5.5")`。
///
/// 🔴 **解析不出来一律返回 `None`，调用方必须按「保守」处理**（= 不瘦身、全量注入）。
/// 锚点由前端 `stageCards.ts` 生成，形状是可控的；但用户手打、老会话、第三方输入都可能
/// 长得不一样 —— 这种情况下「多花点 token」永远优于「把写手的规范依据切掉」。
///
/// ⚠️ 只认首行（与 [`needs_stall_guard`] 同口径）：`【模式】…` / `【单元】Uk` 等控制行在
/// 第 2 行往后，整条消息做匹配会漏掉。
fn parse_anchor_stage(first_line: &str) -> Option<String> {
    let rest = first_line.trim().strip_prefix("【阶段】")?.trim();
    let rest = rest.strip_prefix("STEP")?;
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if token.is_empty() {
        return None;
    }
    // 步骤号后面必须是边界（行尾 / 空格 / `【`），`STEP6X` 这种形状一律不认。
    if let Some(next) = rest[token.len()..].chars().next() {
        if next.is_ascii_alphanumeric() {
            return None;
        }
    }
    Some(format!("STEP{}", token))
}

// ─────────────────────────── 技能瘦身（按步注入） ───────────────────────────
//
// 🔴 **背景（2026-10-13 成本实测）**：自动串链出一段提示词 = **8 次网关调用**，
//    每次都要重发整份 system（含 SKILL.md，约 7.1 万字符）。而 SKILL.md 里
//    **官方写作规范原文那一段（约 1.2 万 token）只有 STEP6 真的在用** ——
//    STEP0–5.5 写的是需求复述 / 项目简报 / 故事大纲 / 角色清单 / 场景清单 / 镜头表 / 自检，
//    一个字都不碰提示词格式。
//
// ⇒ 于是把官原文那一段用标记圈起来，**非 STEP6 的锚点轮剥掉它再拼 system**。
//    实测口径见 `docs/skills/SKILL-trim-plan.md`。
//
// ⚠️ 这是**纯注入侧**的裁剪：SKILL.md 本身、写手能力、产物格式都不变。
//    剥掉的那一段在 STEP6（唯一产出送模型正文的一步）照旧**全文注入**。

/// SKILL.md 里圈官方规范原文的两个标记（`<!-- OFFICIAL_SPEC_BEGIN … -->` 起，`…_END -->` 止）。
/// ⚠️ 用前缀匹配即可 —— 标记行后半句是给人看的说明文字，会随时改。
const OFFICIAL_SPEC_BEGIN: &str = "<!-- OFFICIAL_SPEC_BEGIN";
const OFFICIAL_SPEC_END: &str = "<!-- OFFICIAL_SPEC_END";

/// **白名单**：只有这些步骤确定「不写送模型的六段式正文」，才值得剥掉官方规范原文。
///
/// 0 需求复述 → 1 项目简报 → 2 故事大纲 → 3 角色清单 → 4 场景清单 → 5 镜头表 → 5.5 镜头表自检
/// （⚡ 与前端 `src/features/chat/stageCards.ts` 的 `MAIN_CHAIN` 同源；步骤名两侧逐字一致）
///
/// 🔴 **不在这张表里的一律全量注入**，包括 STEP6（唯一出片步）、STEP7/9（模型分辨率 / 复查报告），
///    以及**任何将来新增或写错的步骤名**。理由：白名单漏一个 ⇒ 只是多花点 token；
///    黑名单（「不是 STEP6 就剥」）漏一个 ⇒ 把出片那一轮的规范依据切掉，产出格式会莫名其妙地崩，
///    而日志里只有一行「已省略」看不出来。
const NO_SPEC_STAGES: &[&str] = &["STEP0", "STEP1", "STEP2", "STEP3", "STEP4", "STEP5", "STEP5.5"];

/// 剥掉 SKILL.md 里两个标记之间的官方规范原文。
///
/// 🔴 **fail-open（承重）**：标记缺任一个、或顺序颠倒（`END` 在 `BEGIN` 前面）时
///    **原样返回**。宁可多花点 token，也绝不能把 system 提示词切瘸 ——
///    那会让整条 STEP0–5.5 链失去规范依据，症状是「产出格式莫名其妙地崩了」，
///    而日志里只有一行「技能瘦身」看不出问题。
///
/// ⚠️ 顺带说明一处**故意保留的排版残迹**：原文件在区块前后各有一条 `---` 分隔线，
///    剥掉中间之后会剩一对相邻的 `---`。不去动它 —— 花代码去做正则清理换不来什么，
///    还多一份「清理逻辑本身出错」的风险。
fn strip_official_spec(skill: &str) -> String {
    let Some(begin) = skill.find(OFFICIAL_SPEC_BEGIN) else {
        return skill.to_string();
    };
    let Some(end) = skill[begin..].find(OFFICIAL_SPEC_END).map(|i| begin + i) else {
        return skill.to_string();
    };
    // 保留 BEGIN 标记**所在行之前**、END 标记**所在行之后**（标记行本身一并去掉）。
    let head_end = skill[..begin].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let tail_start = match skill[end..].find('\n') {
        Some(i) => end + i + 1,
        None => skill.len(),
    };
    let mut out = String::with_capacity(skill.len());
    out.push_str(&skill[..head_end]);
    out.push_str(&skill[tail_start..]);
    out
}


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

/// 单次网关往返（Anthropic Messages 形状）——返回（可见文本, 完整响应 JSON）。
///
/// 🔴 正文为空时**不在这里报错**，由调用方决定要不要重发：
///    `stop_reason=max_tokens` + 空文本是**可重试**的（上游把输出预算烧在思考里），
///    而内容过滤造成的空响应重发也是同一结果、白花一次调用。
///
/// 抽出来只为让「重试一次」这件事只写一遍；请求形状与本函数出现之前**逐字一致**。
async fn call_gateway_once(
    client: &reqwest::Client,
    api_key: &str,
    system_prompt: &str,
    messages: &[ChatMessageDto],
    max_tokens: u32,
    billing_tag: Option<String>,
) -> Result<(String, serde_json::Value), String> {
    let request_body = ChatRequest {
        model: CHAT_MODEL.to_string(),
        system: system_prompt.to_string(),
        messages: messages.to_vec(),
        max_tokens,
        stream: false,
        billing_tag,
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

    Ok((text, response_json))
}

/// 空响应要不要原样重发一次。
///
/// `stop_reason` / `output_tokens` 都取自网关透传的真实响应（`usage.output_tokens`
/// 是上游报的 `completion_tokens`，不是估数）。判据只有一条：**模型到底产没产出 token**。
///
/// - `output_tokens > 0` 而正文为空 ⇒ 输出预算全烧在思考里（`max_tokens` 截断，或
///   `end_turn` 自然收尾），重发一个新样本通常就能收敛 ⇒ **重发**。
/// - `output_tokens == 0` 而正文为空 ⇒ 上游真回了空体 / 内容过滤，重发也是同一结果 ⇒ **不重发**。
///
/// `max_tokens` 单独兜一层：某些响应不带 `usage`，此时 `output_tokens` 读成 0，
/// 但上游已明说预算耗尽，仍然值得重发（这是本函数出现之前的原行为，不能丢）。
///
/// 回归护栏见文末 `empty_response_retry` 测试模块 —— 2026-10-15 前这里只认 `max_tokens`，
/// `end_turn` 一次都不重发，报错文案却写着「已自动重发过 1 次」。
fn empty_response_is_retryable(stop_reason: &str, output_tokens: u64) -> bool {
    stop_reason == "max_tokens" || output_tokens > 0
}

#[tauri::command]
pub(crate) async fn chat_send_message(
    messages: Vec<ChatMessageDto>,
    project_context: String,
    billing_tag: Option<String>,
) -> Result<ChatResponse, String> {
    let chat_id = Uuid::new_v4().to_string();
    info!("[Chat] 新对话请求 chat_id={}", chat_id);

    // 本轮的最后一条用户消息：判「锚点轮」与「这是第几步」都只用它。
    // ⚠️ 原先这两句在下面〈规则块装配〉那一节，**提前到这里**是因为技能瘦身要在拼装之前
    //    先决定给不给官方规范原文 —— 见 [`strip_official_spec`]。语义一字未改。
    let last_user_msg = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .unwrap_or("");

    let anchor_turn = last_user_msg
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .starts_with('【');

    // ───────────────────── 技能瘦身：官方规范原文按步注入 ─────────────────────
    //
    // 🔴 **官方规范原文只在「确定不写六段式正文」的步骤省掉**（见 [`NO_SPEC_STAGES`]）；
    //    STEP6（唯一出片步）与任何未知步骤**照旧全文注入**。
    //
    //    理由（成本）：自动串链出一段提示词要 **8 次**网关调用，每次重发整份 system
    //    （含 SKILL.md，7 万余字，其中官方原文约 4.1 万字）。而 8 步里只有 STEP6 在写
    //    送模型的提示词正文，STEP0–5.5 写的是需求复述 / 项目简报 / 故事大纲 / 角色清单 /
    //    场景清单 / 镜头表 / 自检 —— 它们**不读**这两篇官方文档。
    //
    // 🔴 **fail-open**：`anchor_turn` 为假（非锚点轮）、首行解析不出步骤号
    //    （用户手打 / 老会话 / 形状不合）、或步骤不在白名单里 ⇒ **不瘦身，全量注入**。
    //    宁可多花 token，也绝不能把 system 切瘸 —— 那是「产出格式莫名其妙地崩了」，
    //    而日志里只有一行「已省略」看不出来。锚点形状由前端 `stageCards.ts` 生成，
    //    两侧契约见 CLAUDE.md §12.3。
    let anchor_stage = if anchor_turn {
        parse_anchor_stage(last_user_msg.lines().next().unwrap_or(""))
    } else {
        None
    };
    let strip_official = anchor_stage
        .as_deref()
        .map_or(false, |s| NO_SPEC_STAGES.contains(&s));

    let mut system_prompt = ensure_skill_md().await?;
    if strip_official {
        let before = system_prompt.chars().count();
        system_prompt = strip_official_spec(&system_prompt);
        let after = system_prompt.chars().count();
        // ⚠️ 报**字符数**（不是字节数）：SKILL.md 是中文，字节数会是字符数的 2–3 倍，
        //    与 `docs/skills/` 里按字符统计的口径对不上，看日志的人会以为哪里错了。
        info!(
            "[Chat] 技能瘦身：本轮 stage={} ⇒ 官方规范原文已省略（{} → {} 字符）",
            anchor_stage.as_deref().unwrap_or("?"),
            before,
            after
        );
        if after == before {
            // ⚠️ 长度没变 = 标记没找到（本地缓存的是老 SKILL.md）⇒ 说明此轮**没瘦成**。
            //    不报错（fail-open 是对的），但要留个痕迹，免得以为一直在省却在白花 token。
            warn!("[Chat] 技能瘦身未生效：SKILL.md 里找不到官方规范标记，本轮按全量注入");
        }
    } else if anchor_turn {
        // 出片轮与未知步骤：走全量。留一行，方便对着日志确认「该省的省了、该给的给了」。
        info!(
            "[Chat] 技能瘦身：本轮 stage={} ⇒ 官方规范原文**全量注入**",
            anchor_stage.as_deref().unwrap_or("（无法解析）")
        );
    }
    info!(
        "[Chat] SKILL.md 已加载 ({} 字符)",
        system_prompt.chars().count()
    );

    // 注入项目全局上下文（如果有）
    if !project_context.is_empty() {
        system_prompt.push_str("\n\n【项目全局上下文】\n");
        system_prompt.push_str(&project_context);
        info!("[Chat] 项目上下文已注入 ({} 字符)", project_context.len());
    }

    // ─────────────────────────── 规则块装配 ───────────────────────────
    //
    // 🔴 **拼装次序是承重的，不是排版细节**（2026-09-19 实测，同一输入/同一份 system 前缀、
    //    块体积逐字节相同，只换次序）：路由表③ 排在约束①② **之前** 时退化 0/12；
    //    排在末尾时退化 12/12 —— 它紧贴 user 消息时，模型去做**路由判断**而不是**写提示词**，
    //    于是把启动欢迎语或旧 L1 分段确认原样吐回来。用户看到的「丢脚本元素、自己造动作」，
    //    有相当一部分根本不是写手写坏的，是它**压根没写**。动这几行之前先看这段。
    //
    // ⇒ 次序恒定：CRITICAL（路由）→ 通用约束 → 分镜映射。
    system_prompt.push_str(BLOCK_CRITICAL);
    system_prompt.push_str(BLOCK_CONSTRAINTS);
    system_prompt.push_str(BLOCK_MAPPING);

    // 🔴 「STEP 门机」形状块 —— **只在锚点轮注入**。
    //
    //    锚点轮 = 用户消息**首行以 `【` 开头**（`【阶段】STEPn`，后可跟 `【模式】…` 等控制行）。
    //    非锚点轮（用户第一次贴脚本 / 贴画面描述）走 `BLOCK_CRITICAL` 的 `[2]` 分支，
    //    那条分支**自带** STEP 0 入料的形状，不需要这一块。
    //
    //    ⇒ 与 [`STALL_GUARD`] 的注入条件**互斥**：护栏给非锚点轮，本块给锚点轮。
    //
    //    ⚠️ `last_user_msg` / `anchor_turn` 已在函数开头算好（技能瘦身要先判步骤号），
    //    这里**不再重算** —— 两个来源一旦分叉，就会出现「瘦身按 A 判、注入按 B 判」。
    if anchor_turn {
        system_prompt.push_str(STEP_SHAPES);
        info!("[Chat] 已注入「STEP 门机」形状块（锚点轮）");
    }

    // 🔴 用户消息没写时长时，路由块会让模型判不出该走哪条规则，于是它不写提示词，
    //    退化成欢迎语。同一句话压到 system **最末**（紧贴 user 消息）可解（0/6 vs 6/6 退化）。
    //    与 memory `prompt-rule-position-beats-wording` 同构：**位置是杠杆，措辞不是**。
    //
    //    ⚠️ **只在真的没写时长（即非控制轮）时才加** —— 这是一句对模型陈述事实的话，
    //    写成假话比不写更危险。
    if needs_stall_guard(last_user_msg) {
        system_prompt.push_str(STALL_GUARD);
        info!("[Chat] 已注入「别停」护栏（首行非控制行）");
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

    // 🔴 **空响应原样重发一次**（用户反馈：写手明明能出，却报
    //    「写手这一轮没有返回内容（stop_reason=…）」）。
    //
    //    实测成因：这类空响应**不是上游真没内容**，而是输出预算被思考吃光 ——
    //    正文一个字没落，`output_tokens` 却是实数。两种外壳：
    //      · `stop_reason=max_tokens` —— 2026-10-13 实测 `output_tokens` **正好等于**
    //        `CHAT_MAX_TOKENS`、`content[0].text` 是空串；
    //      · `stop_reason=end_turn` —— 2026-10-15 实测 `output_tokens=2684 / 575` 而
    //        `content=[{text:""}]`（思考完就自然收尾；网关不认上游的思考字段，被透传成空 text）。
    //    两者同一轮重发通常都能收敛。这一轮对用户是**纯亏损**：已计费、产物为空、
    //    链条停在原地，用户只能重贴脚本 ⇒ 整条链从 STEP1 重跑（8 次调用）。
    //    所以这里直接重发，不把这个错推给用户手动重试。判据见
    //    [`empty_response_is_retryable`]。
    //
    //    ⚠️ 重发**不推进链条、不落盘**：只有真拿到正文才会走下面的 `Ok(ChatResponse …)`，
    //       失败的那一轮前端什么也收不到（`Err`）⇒ 不会记 `stage`、不会续下一环。
    const MAX_ATTEMPTS: usize = 2;
    let mut text = String::new();
    let mut response_json: serde_json::Value = serde_json::Value::Null;
    // 实际用掉的调用次数 —— 报错文案只能照着它说，不能再写死「已重发过 N 次」。
    let mut attempts_used = 0usize;
    for attempt in 1..=MAX_ATTEMPTS {
        // 重发（attempt ≥ 2）改带 `prompt_retry`：**同一逻辑步骤的重发不该二次计费**。
        // 首步无标记、走 token 阶梯计费，照原标记重发会被再扣一次（这里就是要修的那次）；
        // 续步本就带 `prompt_continue`（0 分），换成 `prompt_retry` 同样 0 分。
        // 价目见服务器 `backend/app/api/endpoints/gateway.py` 的 billing_tag 分支。
        let attempt_tag = if attempt == 1 {
            billing_tag.clone()
        } else {
            Some("prompt_retry".to_string())
        };
        let (t, rj) = call_gateway_once(
            &client,
            &api_key,
            &system_prompt,
            &messages,
            CHAT_MAX_TOKENS,
            attempt_tag,
        )
        .await?;
        text = t;
        response_json = rj;

        // 真实用量（上游报的 `prompt_tokens` / `completion_tokens`，由服务器
        // `build_anthropic_response` 换算成 Anthropic 形状透传下来）——**不是估数**。
        // 每轮都打：STEP 门机一轮要发 8 次调用，成本口径只能靠这几行实测，不能靠推算。
        let usage = response_json
            .get("usage")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let stop_reason = response_json
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("(未给)");
        // 上游报的真实产出 token（网关把 `completion_tokens` 换算成 `output_tokens` 透传）。
        // 空响应里它是**判类别的唯一依据**，见下面的重发门槛。
        let output_tokens = response_json
            .pointer("/usage/output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        info!(
            "[Chat] 响应完成 chat_id={} attempt={}/{} len={} stop_reason={} usage={}",
            chat_id,
            attempt,
            MAX_ATTEMPTS,
            text.len(),
            stop_reason,
            usage
        );

        if !text.is_empty() {
            break;
        }
        // 🔴 **重发门槛 = 正文为空 且 模型确实产出过 token**（或上游明确报预算耗尽）。
        //
        // 两种空响应其实是**同一件事**：输出预算全烧在思考里，一个字正文都没落。
        //   ① `stop_reason=max_tokens` —— 预算用满被截断。2026-10-13 实测 `output_tokens`
        //      正好等于 `CHAT_MAX_TOKENS`，`content[0].text` 是空串。
        //   ② `stop_reason=end_turn` 但 `output_tokens > 0` —— 思考完就自然收尾。
        //      2026-10-15 实测两例：`output_tokens=2684 / 575` 而 `content=[{text:""}]`。
        //      成因在网关：`gateway.py::build_anthropic_response` 只读 OpenAI 形状的
        //      `choices[0].message.content`，**完全不认 `reasoning_content` 一类字段**，
        //      于是「只出思考、没出正文」的响应被原样透传成空 text 块
        //      （空 content 兜底见 `gateway.py:1171`）。
        //
        //      这一类原先是**被漏掉的**：老门槛是 `stop_reason != "max_tokens"` ⇒ `end_turn`
        //      一次都不重发，而报错文案却写死「已经自动原样重发过 1 次」——**实际一次没发**。
        //      门槛因此改成看 `output_tokens`。
        //
        // 不重发的只剩「真·空体 / 内容过滤」(`output_tokens == 0`)：那类重发也是同一结果，白花一次调用。
        //
        // ⚠️ 重发**不计费**：服务器 `billing_tag=prompt_retry` 是 0 积分
        //    （`gateway.py:908` 字段说明 + `gateway.py:1315` 分支），对用户只多等一次往返。
        let retryable = empty_response_is_retryable(stop_reason, output_tokens);
        if !retryable || attempt == MAX_ATTEMPTS {
            break;
        }
        warn!(
            "[Chat] 空响应（stop_reason={}，思考已耗 {} tokens，attempt={}/{}），原样重发一次 chat_id={}",
            stop_reason, output_tokens, attempt, MAX_ATTEMPTS, chat_id
        );
    }

    if text.is_empty() {
        // 🔴 空响应**不能当成功**返回。
        //
        // 原先这里只 warn 一句然后 `Ok(ChatResponse { text: "" })` 返回，于是：
        //   ① 前端把它当正常回复落盘（`stage` 照记），自动串联在终点停住
        //      ⇒ 用户看到的是「链条莫名断了、一个字都没有」；
        //   ② 日志里没有任何线索 —— 网关 `200` + 空文本至少有三种成因
        //      （上游只回了思考内容、`finish_reason=length` 把 max_tokens 全吃在思考上、
        //       上游内容过滤），三者在客户端长得一模一样。
        // 现在：把 `stop_reason` / `usage` / 原始响应片段打进日志，并返回 `Err`
        // 让前端走错误分支（显示原因、且**不续下一环**，见 chatStore 的 catch）。
        let stop_reason = response_json
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("(未给)");
        let usage = response_json
            .get("usage")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let raw: String = serde_json::to_string(&response_json).unwrap_or_default();
        let raw_head: String = raw.chars().take(1200).collect();
        warn!(
            "[Chat] 响应文本为空 chat_id={} stop_reason={} usage={} raw={}",
            chat_id, stop_reason, usage, raw_head
        );
        // 报错文案只按**实际发生的事**说：
        //   `attempts_used == 1` ⇒ 这一轮没重发（`output_tokens == 0`，重发也是同一结果），
        //   此时绝不能再写「已自动重发过 1 次」（老文案就是这句假话，2026-10-15 现场抓到的
        //   两例 `stop_reason=end_turn` 日志里 `attempt=1/2` 之后直接报错，一次都没重发）。
        // 顺带把 `usage` 带进文案 —— 用户按提示把报错贴回来时，`output_tokens` 是判类别的第一手线索。
        let retried = attempts_used.saturating_sub(1);
        let head = if retried > 0 {
            format!("已经自动原样重发过 {} 次仍是空响应", retried)
        } else {
            "这一轮没有自动重发（模型没产出任何 token，重发也是同一结果）".to_string()
        };
        return Err(format!(
            "写手这一轮没有返回内容（stop_reason={}，本轮共发起 {} 次调用，用量 {}）。{} —— \
             这是网关侧的空响应，不是你的输入问题，手动再发一次通常即可；若反复出现，\
             请把这条报错原样发给我。",
            stop_reason, attempts_used, usage, head
        ));
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

    // 续写这一路仍走同一助手（形状/额度与主路一致）；失败就当没有搜索结果，
    // 不重试 —— 这里本来就用 `.ok()?` 容错，空响应只是丢掉搜索结果，不会伤主链路。
    let (continued_text, _) = call_gateway_once(
        client,
        api_key,
        system_prompt,
        &continued_messages,
        CHAT_MAX_TOKENS,
        continue_tag,
    )
    .await
    .ok()?;

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
        user_content.push_str(&format!("科普风格: {}\n", director_ref));
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

/// 把**解析失败**的对话文件另存一份，返回备份的绝对路径。
///
/// 🔴 存在的理由：前端 `safeParseConversations` 解析失败时会静默回退到空列表，
/// 紧接着任何一次存盘（5 秒定时器保证一定有）就会把那个坏文件**整量覆盖成 `[]`**
/// —— 一次坏读把「可修复」变成「永久空」。所以前端在读坏的那一刻先调本命令留一份副本，
/// 再继续正常工作。
///
/// **只复制、不改名、不动原文件** ⇒ 不违反 §12.4「禁止删除 `users/{id}/` 下的文件」。
#[tauri::command]
pub(crate) fn backup_corrupt_chat_file(app: AppHandle, project_id: String) -> Result<String, String> {
    let path = resolve_chat_path(&app, &project_id)?;
    if !path.exists() {
        return Err("对话文件不存在，无需备份".to_string());
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "chat.json".to_string());
    let bak = path.with_file_name(format!("{}.corrupt-{}", name, ts));
    std::fs::copy(&path, &bak).map_err(|e| format!("备份损坏对话文件失败: {}", e))?;
    info!(
        "[Chat] 损坏的对话文件已备份到 {} (project={}, 原文件未改动)",
        bak.display(),
        project_id
    );
    Ok(bak.to_string_lossy().to_string())
}

/// 读一个 chat 文件 → 对话数组。不存在 / 坏档一律当空，**绝不抛**（fail open）。
fn read_chat_conversations(path: &std::path::Path) -> Vec<serde_json::Value> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 给**没有 `id`** 的旧对话算一个确定性的内容指纹，当临时 id 用。
///
/// 要求「确定性」而不是随机 uuid：迁移与回捞可能各跑一次，同一份内容必须算出同一个
/// 指纹，否则并集合并会把同一条对话复制成两份。同理，两份文件里的同一条对话也会被正确去重。
/// ⚠️ 只用于补 id，不参与业务判断；不同的 Rust 版本可能给出不同结果（同一版本内稳定）。
fn conv_content_fingerprint(conv: &serde_json::Value) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(conv).unwrap_or_default().hash(&mut h);
    format!("legacy-{:016x}", h.finish())
}

/// 按 `id` 做**并集**合并：同一 id 保留消息更多的一份，条数相同取 `updatedAt` 更晚的。
///
/// 🔴 与 Rust `sync::merge_chat_json`、前端 `mergeConversations` **同口径**（三处同一条规则）。
/// 🔴 只做并集、**从不丢弃任一侧独有的对话** —— 这个函数存在的唯一理由，就是
///    「写回项目文件时不能把用户已有对话盖掉」（§12.4）。
fn merge_conversation_lists(
    base: Vec<serde_json::Value>,
    incoming: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();

    for mut conv in base.into_iter().chain(incoming) {
        // 🔴 绝不能因为「没有 id」就跳过 —— 那等于把这条对话丢掉（§12.4）。
        //    旧版数据里存在无 id 的对话；给它补一个**内容指纹**当 id：
        //    确定性 ⇒ 同一份内容重复合并不会产生副本，写回后前端也有了稳定标识。
        let id = match conv
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            Some(s) => s.to_string(),
            None => {
                let generated = conv_content_fingerprint(&conv);
                if let Some(obj) = conv.as_object_mut() {
                    obj.insert("id".to_string(), serde_json::Value::String(generated.clone()));
                }
                generated
            }
        };
        match map.get(&id) {
            None => {
                order.push(id.clone());
                map.insert(id, conv);
            }
            Some(existing) => {
                let n_old = existing
                    .get("messages")
                    .and_then(|m| m.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let n_new = conv
                    .get("messages")
                    .and_then(|m| m.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let ts_old = existing.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
                let ts_new = conv.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
                if n_new > n_old || (n_new == n_old && ts_new > ts_old) {
                    map.insert(id, conv);
                }
            }
        }
    }

    order.into_iter().filter_map(|id| map.remove(&id)).collect()
}

/// **先备份、再并集合并、写回** —— 本次事故修复的核心工具。
///
/// 🔴 备份失败就**放弃写入**：宁可这次没合并成，也不能在没备份的情况下覆盖用户数据（§12.4）。
/// 🔴 旧实现是裸 `std::fs::write`，会把该文件里已经存在的对话**整体盖掉** —— 那是第二条丢失路径。
fn merge_into_chat_file(
    path: &std::path::Path,
    incoming: Vec<serde_json::Value>,
) -> Result<usize, String> {
    if incoming.is_empty() {
        return Ok(0);
    }

    let base = if path.exists() {
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "chat.json".to_string());

        // ① 先备份 —— 备份失败就放弃写入（§12.4）
        let bak = path.with_file_name(format!("{}.bak", name));
        if let Err(e) = std::fs::copy(path, &bak) {
            return Err(format!("备份 {} 失败，已放弃写入: {}", name, e));
        }

        // ② 再读回**做并集的基准**。读不出来 / 解析不了 ⇒ **拒绝写入**，原文件与备份都留着。
        //    这里不能用 fail-open 的 `read_chat_conversations`：那会当空数组处理，
        //    等于把读不动的原文件直接覆盖掉。宁可这次没合并成，也不能冒覆盖的风险。
        match std::fs::read_to_string(path)
            .map_err(|e| format!("读取 {} 失败（已备份到 {:?}），放弃写入: {}", name, bak, e))
            .and_then(|s| {
                serde_json::from_str::<Vec<serde_json::Value>>(&s)
                    .map_err(|e| format!("解析 {} 失败（已备份到 {:?}），放弃写入以保护原文件: {}", name, bak, e))
            }) {
            Ok(v) => v,
            Err(e) => return Err(e),
        }
    } else {
        Vec::new()
    };

    let merged = merge_conversation_lists(base, incoming);
    let json = serde_json::to_string_pretty(&merged).unwrap_or_else(|_| "[]".to_string());
    std::fs::write(path, json).map_err(|e| format!("写入 {} 失败: {}", path.display(), e))?;
    Ok(merged.len())
}

/// 从 `projects.db` 建 `episodeId → projectId` 映射表。打不开 / 没有表 → 空表（fail open）。
fn load_episode_project_map(
    db_path: &std::path::Path,
) -> std::collections::HashMap<String, String> {
    if !db_path.exists() {
        return std::collections::HashMap::new();
    }
    match rusqlite::Connection::open(db_path) {
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
            map
        }
        Err(e) => {
            warn!("[Chat migration] 无法打开数据库查询 episode 映射: {}", e);
            std::collections::HashMap::new()
        }
    }
}

/// 迁移旧版单文件 chat_conversations.json → 新版 per-project chat/*.json
/// 安全策略：
///   1. 不改动旧文件（先备份再操作）
///   2. 优先用 conversation.projectId，没有则从 episodeId → episodes 表反查 project_id
///   3. 无法确定归属的**并入用户当前项目**（`fallback_project_id`），而不是倒进
///      `chat/global.json` —— 见下面 `recover_stranded_chat` 的事故说明
///   4. 迁移完成后旧文件重命名为 `.migrated`，可手动恢复
///   5. 写入项目文件一律**先备份、再并集合并**，绝不覆盖既有对话
///
/// 🔴 2026-10-16 生产事故（本函数旧实现）：反查不到项目的对话被统一写进
///    `chat/global.json`，而**全应用没有任何一处读它** ——
///    `resolve_chat_path` 只在 `project_id` 为空时返回它，而前端 `hydrate` 在 `pid` 为空时
///    直接 return（`chatStore.ts`）⇒ 「迁移成功」= 用户对话永久消失。
///    ⇒ 现在：**映射表为空且没有兜底项目时直接拒绝迁移**（保留源文件，下次再试）。
#[tauri::command]
pub(crate) fn migrate_chat_storage(
    app: AppHandle,
    fallback_project_id: Option<String>,
) -> Result<String, String> {
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
    let ep_to_project = load_episode_project_map(&user_dir.join("projects.db"));
    tracing::info!(
        "[Chat migration] episode→project 映射: {} 条",
        ep_to_project.len()
    );

    // 分配 projectId：优先用已有字段，其次从 episodeId 反查，最后并入**用户当前项目**
    // （`fallback_project_id`）—— 绝不再倒进没人读的 `global.json`。
    let fallback = fallback_project_id.filter(|s| !s.is_empty());
    let total_count = conversations.len();

    let mut by_project: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut fallback_count = 0u32;
    let mut matched_count = 0u32;

    for mut conv in conversations {
        // 1) 已有 projectId → 直接使用
        let existing_pid = conv
            .get("projectId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let pid = if let Some(p) = existing_pid {
            p
        } else {
            // 2) 没有 projectId → 从 episodeId 反查
            let ep_id = conv
                .get("episodeId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            match ep_id.and_then(|ep| ep_to_project.get(ep)) {
                Some(proj_id) => {
                    matched_count += 1;
                    // 补全 projectId 字段，写回 conversation
                    if let Some(obj) = conv.as_object_mut() {
                        obj.insert(
                            "projectId".to_string(),
                            serde_json::Value::String(proj_id.clone()),
                        );
                    }
                    proj_id.clone()
                }
                // 3) 反查不到 → 并入用户当前项目
                None => match &fallback {
                    Some(p) => {
                        fallback_count += 1;
                        if let Some(obj) = conv.as_object_mut() {
                            obj.insert(
                                "projectId".to_string(),
                                serde_json::Value::String(p.clone()),
                            );
                        }
                        p.clone()
                    }
                    // 连当前项目都没有（还没打开任何项目）⇒ **拒绝迁移**，源文件原样保留。
                    // 🔴 历史上这里会把整批对话倒进 `global.json` —— 那个文件全应用没有
                    //    任何一处读它，等于用户对话永久消失。宁可先不迁，下次再试。
                    None => {
                        warn!(
                            "[Chat migration] {} 条对话无法归属且无兜底项目 ⇒ 本次跳过（源文件保留，下次再试）",
                            total_count
                        );
                        return Ok("skipped_no_project_mapping".to_string());
                    }
                },
            }
        };

        by_project.entry(pid).or_default().push(conv);
    }

    let chat_dir = resolve_chat_dir(&app)?;
    let mut written = 0usize;

    for (pid, convs) in &by_project {
        let filename = format!("{}.json", pid);
        let path = chat_dir.join(&filename);
        // 🔴 先备份、再**并集**合并 —— 绝不覆盖该文件里已有的对话（旧实现是裸 `fs::write`）
        written += merge_into_chat_file(&path, convs.clone())?;
    }

    // 迁移成功 → 重命名旧文件标记为已迁移
    let migrated_path = old_path.with_extension("json.migrated");
    std::fs::rename(&old_path, &migrated_path).ok();

    let msg = format!(
        "迁移完成：{} 条对话 → {} 个项目文件（{} 条从 episode 反查匹配，{} 条并入当前项目）。旧文件备份在 {:?}",
        written,
        by_project.len(),
        matched_count,
        fallback_count,
        bak
    );
    tracing::info!("[Chat migration] {}", msg);
    Ok(msg)
}

/// **一次性回捞**：把历史上被错误倒进 `chat/global.json` 的对话重新分发回各自项目文件。
///
/// 🔴 背景（2026-10-16 生产事故）：`migrate_chat_storage` 的旧实现把**反查不到项目**的对话
///    统统一股脑写进 `chat/global.json`，而那个文件**全应用没有任何一处读它**
///    （`resolve_chat_path` 只在 `project_id` 为空时返回它，而前端 `hydrate` 在 `pid` 为空时
///    直接 `return`）⇒ 那批对话永久看不见，源文件同时被改名 `.migrated`。
///    ⇒ 本命令把它们按 `episodeId` 重新归位：**先备份、并集合并、绝不覆盖**。
///
/// 🔴 **不删也不改名 `global.json`** —— 它本身就是那批对话的最后一份备份（§12.4）。
///    靠同目录下的 `.stranded_recovered_v1` 记号保证只回捞一次（合并本身也是幂等的）。
#[tauri::command]
pub(crate) fn recover_stranded_chat(
    app: AppHandle,
    fallback_project_id: Option<String>,
) -> Result<String, String> {
    let user_dir = crate::sync::get_user_dir(&app)?;
    let chat_dir = resolve_chat_dir(&app)?;
    let global_path = chat_dir.join("global.json");

    if !global_path.exists() {
        return Ok("no_stranded".to_string());
    }
    let stranded = read_chat_conversations(&global_path);
    if stranded.is_empty() {
        return Ok("no_stranded".to_string());
    }

    let marker = chat_dir.join(".stranded_recovered_v1");
    if marker.exists() {
        return Ok("already_recovered".to_string());
    }

    let ep_to_project = load_episode_project_map(&user_dir.join("projects.db"));
    let fallback = fallback_project_id.filter(|s| !s.is_empty());
    let total = stranded.len();

    let mut by_project: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut unmatched: Vec<serde_json::Value> = Vec::new();

    for conv in stranded {
        let pid = conv
            .get("projectId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                conv.get("episodeId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .and_then(|ep| ep_to_project.get(ep))
                    .cloned()
            });
        match pid {
            Some(p) => by_project.entry(p).or_default().push(conv),
            None => unmatched.push(conv),
        }
    }

    // 仍归不了位的：并入用户当前项目 —— 比留在没人读的 global.json 里强
    let mut note = String::new();
    if !unmatched.is_empty() {
        match &fallback {
            Some(p) => {
                note = format!("，其中 {} 条无归属、已并入当前项目", unmatched.len());
                let bucket = by_project.entry(p.clone()).or_default();
                for mut conv in unmatched {
                    if let Some(obj) = conv.as_object_mut() {
                        obj.insert("projectId".to_string(), serde_json::Value::String(p.clone()));
                    }
                    bucket.push(conv);
                }
            }
            None => {
                note = format!("，仍有 {} 条无法归位（尚未打开项目），保留在 global.json", unmatched.len());
            }
        }
    }

    let mut written = 0usize;
    for (pid, convs) in &by_project {
        let path = chat_dir.join(format!("{}.json", pid));
        written += merge_into_chat_file(&path, convs.clone())?;
    }

    // 全都没能归位（没有兜底项目）⇒ 不写记号，下次打开项目时再试一遍
    if !by_project.is_empty() {
        let _ = std::fs::write(&marker, written.to_string());
    }

    let msg = format!(
        "回捞完成：global.json 共 {} 条 → {} 个项目文件（写入 {} 条）{}",
        total,
        by_project.len(),
        written,
        note
    );
    tracing::info!("[Chat recovery] {}", msg);
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



#[cfg(test)]
mod empty_response_retry {
    use super::empty_response_is_retryable;

    /// 2026-10-15 线上现场（`storyboard.log.2026-10-15` L9002 / L13640）：
    /// `stop_reason=end_turn` + `content=[{text:""}]` + `output_tokens` 非零 ——
    /// 思考吃光预算、正文一个字没落。**这一类必须重发**（本次修复的就是它）。
    #[test]
    fn end_turn_with_tokens_is_retryable() {
        assert!(empty_response_is_retryable("end_turn", 2684));
        assert!(empty_response_is_retryable("end_turn", 575));
    }

    /// 2026-10-13 现场：`output_tokens` 正好等于 `CHAT_MAX_TOKENS`、正文空串。
    #[test]
    fn max_tokens_is_retryable() {
        assert!(empty_response_is_retryable("max_tokens", 16384));
    }

    /// 不带 `usage` 但上游已明确报预算耗尽 ⇒ 仍要重发（本函数之前的原行为）。
    #[test]
    fn max_tokens_without_usage_is_retryable() {
        assert!(empty_response_is_retryable("max_tokens", 0));
    }

    /// 真·空体 / 内容过滤：一个字都没产出，重发也是同一结果，不该白花一次调用。
    #[test]
    fn truly_empty_body_is_not_retryable() {
        assert!(!empty_response_is_retryable("end_turn", 0));
        assert!(!empty_response_is_retryable("content_filter", 0));
        assert!(!empty_response_is_retryable("(未给)", 0));
    }
}
