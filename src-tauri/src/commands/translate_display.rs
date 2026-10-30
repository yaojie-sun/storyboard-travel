//! 提示词**显示用**中文镜像 —— 英文进视频模型，中文只给用户看。
//!
//! 移植自 `D:\Story-Local\src-tauri\src\commands\translate_display.rs`（同一套判据）。
//!
//! ## 两个方向
//!
//! - **英 → 中** [`translate_prompt_to_zh`]：显示镜像，**永不回流**到提交链路。
//! - **中 → 英** [`translate_prompt_to_english`]：**2026-10-28 用户定调「允许用户修改
//!   生成的提示词」后补齐的回译**。用户改的是中文镜像那一份，改完必须有一条路
//!   把它变回官方英文再提交，否则中文改动无处落地（本文件旧注释正是这句预言）。
//!   回译产物**要过 `prompt_repair::validate_prompt_shape`**（六段结构 + 字数预算），
//!   过不了就修，修不动就返回 `Err` 让前端退回原文，绝不把半成品塞给视频模型。
//!
//! ## 三条铁律
//!
//! 1. 🔴 **英文是真相源。** 送视频模型的永远是英文那一份；本模块的产物**只走显示**，
//!    一个字节都不进提交链路（`PromptBlock.content` / `config.prompt` 恒为英文）。
//! 2. 🔴 **中文是新增 optional 字段。** 老会话没有它 ⇒ 显示英文，行为与改动前一致（§12.4 第 5 条）。
//! 3. 🔴 **判「这份正文是不是中文写的」必须先屏蔽 `<d>` 再说。**
//!    官方英文正文**必然**含 `<d>[Chinese] 台词</d>`，拿「含 CJK」当判据会把每一单都跳过翻译。
//!    判据落在前端 `looksChineseWritten`（结构性判据，见 `src/commands/translateDisplay.ts`），
//!    Rust 侧**不做**前置判断 —— 老的中文正文会白翻一趟，但过不了下面的六段字段名判据，
//!    前端照旧退回原文，不产生错显。
//!
//! ## 边界
//!
//! - 校验**只管结构**，管不了语义（「男主转身」译成「女主转身」抓不住）。
//! - 中文镜像不参与任何计费：走网关但不传 `billing_tag`（与 `analyze_story` 同一条路）。

use reqwest::Client;
use tokio::time::Duration;
use tracing::{info, warn};

use super::chat::{call_gateway_once, ChatMessageDto};
use super::banana_api;
use super::prompt_repair::{self, force_fit_budget, MAX_BODY_CHARS};

const TIMEOUT_SECS: u64 = 120;

/// 用户可见错误的前缀，便于在界面上一眼认出来源。
const PREFIX: &str = "中文对照：";

const SYSTEM_PROMPT: &str = r#"You translate an English MiniMax H3 full-reference (ref2va) video-generation prompt into Chinese. The English original is the source of truth and is what gets submitted to the video model; your Chinese is a DISPLAY mirror that a human reads.

🔴 NEVER TRANSLATE THE SPOKEN DIALOGUE. Everything between `<d>` and `</d>` is usually Chinese already and STAYS exactly as written, character for character — including the `[Chinese]` tag.

🔴 KEEP THE OFFICIAL MOUTH CLAUSE AS IS. A shot in which someone speaks on screen carries, right after `</d>`, the clause `his/her/its mouth movements naturally syncing to the new dialogue`. Translate it into natural Chinese like the rest of the prose (keep its meaning exactly); never delete it and never move it. If an older body still has the legacy Chinese sentence 「他说话时下颌开合、嘴唇随字句张动」, leave it verbatim.

COPY UNCHANGED, byte for byte — never translate, reword, reorder or drop any of these:
- the six field names, in this exact order, each on its own line, still in English:
  subject_definitions: / summary: / retention_analysis: / detailed_description: / overall_soundscape: / non_diegetic_music:
- the `[Shot N]` marker, and an "At MM:SS.mmm," timestamp when it shares the line with the marker. Copy the marker and that timestamp EXACTLY as they are (for example "[Shot 2] At 00:04.000,"), but any ACTION TEXT following on that same line is ordinary prose and MUST be translated. Never move a marker, never merge two lines into one or split one line into two, and never leave that action text in English.
- THE STYLE OPENING LINE. If the source has the style / lighting opening sentence(s) on their OWN line(s) BETWEEN "detailed_description:" and the first "[Shot 1]", your Chinese MUST keep them on their own line(s) in the same place. Never fold the opening into the "[Shot 1]" line, and never start that line with "[Shot 1]".
- everything inside <d> ... </d>, including the [Chinese] tag and the spoken words
- the tags <Subject N> <Picture N> <Video N> <Audio N>
- the speaker ids (S1) (S2) (S1,S2)
- the retention markers: fully_preserved / partially_preserved / attribute_transfer / weak_reference / fully_copy / partially_copy / reference
- the retention row skeleton up to and including the dash: "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - ". Only the explanation after that " - " is translated.
- the bracketed task-type tag in summary, e.g. [reference generation]
- the official camera vocabulary, kept in these exact English words: Zoom In, Zoom Out, Push In, Pull Out, Pan Left, Pan Right, Truck Left, Truck Right, Tilt Up, Tilt Down, Pedestal Up, Pedestal Down, Arc Shot, Tracking Shot, Static Shot, Shake Slightly, Shake Strongly, POV, Roll Clockwise, Roll Counterclockwise, with small amplitude, with large amplitude, at slow speed, at fast speed
- the shot-cut verbs: the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to
- N/A, says in an off-screen voiceover, <scenetrans>, <cutoff>
- any English text inside double quotes that is visible on screen (for example a sign reading "OPEN")

TRANSLATE into natural, readable Chinese: every OTHER piece of English prose — the subject definitions, the summary, the retention explanations, shot actions, the style opening, the sound description, the music description.

SHOT SIZES — these five MUST come out as exactly these Chinese words (a checker reads them back):
  an extreme close-up -> 大特写
  a close-up -> 特写
  a close shot -> 近景
  a medium shot -> 中景
  a medium-wide shot -> 中远景

KEEP THE SHAPE: the same number of shots, the same timestamps, the same tags, the same <d> lines in the same order, and the same line layout. Never add or remove a shot, a tag, a timestamp or a line, and never join two lines into one or split one line into two.

Output ONLY the Chinese prompt. No commentary, no explanations, no code fences."#;

/// 英译中（**显示用**）。返回中文镜像；校验不过返回 `Err`（前端据此退回英文原文）。
#[tauri::command]
pub async fn translate_prompt_to_zh(prompt: String) -> Result<String, String> {
    let en = strip_leading_marker(&prompt);
    if en.trim().is_empty() {
        return Err(format!("{PREFIX}提示词为空，没有可翻译的内容。"));
    }

    let device_token = {
        let store = banana_api::get_device_token_store();
        let guard = store.lock().await;
        guard.clone().ok_or("未登录，请先登录".to_string())?
    };
    let api_key = match banana_api::get_user_api_key(&device_token).await {
        Ok(key) if !key.is_empty() => key,
        other => {
            warn!("[中文对照] get_user_api_key 失败({:?})，回退到 ensure_user_api_token", other.as_ref().err());
            banana_api::ensure_user_api_token(&device_token).await?
        }
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("{PREFIX}客户端初始化失败：{e}"))?;

    info!("[中文对照] 请求，输入 {} 字", en.len());

    // 🔴 不传 billing_tag：中文对照是显示层辅助，不进扣费链路（与 analyze_story 同一条路）。
    let messages = vec![ChatMessageDto { role: "user".to_string(), content: en.clone() }];
    let (draft, _) = call_gateway_once(&client, &api_key, SYSTEM_PROMPT, &messages, 8192, None)
        .await
        .map_err(|e| format!("{PREFIX}翻译不可用：{e}"))?;
    let draft = strip_leading_marker(&draft);

    match validate_display_translation(&en, &draft) {
        Ok(()) => {
            info!("[中文对照] 校验通过，输出 {} 字", draft.len());
            Ok(draft)
        }
        Err(first) => {
            // 同一条纪律：让它改自己的稿，不叫它重译一遍 —— 重译会引入新的结构漂移。
            warn!("[中文对照] 首次校验未过：{first} —— 递回原稿要求原地改，重试一次");
            let retry_system = format!(
                "{SYSTEM_PROMPT}\n\nYOUR PREVIOUS ATTEMPT FAILED A STRUCTURAL CHECK:\n{first}\n\
                 Below you are given the English source prompt AND your own previous attempt at \
                 translating it. Fix exactly that problem IN PLACE and output the corrected \
                 complete Chinese translation. Change nothing else: do not start over, do not \
                 re-translate, do not reword a sentence that was already fine."
            );
            let retry_user = format!(
                "{en}\n\n--- YOUR PREVIOUS ATTEMPT (edit this in place, do not start over) ---\n{draft}"
            );
            let messages = vec![ChatMessageDto { role: "user".to_string(), content: retry_user }];
            let (second, _) = call_gateway_once(&client, &api_key, &retry_system, &messages, 8192, None)
                .await
                .map_err(|e| format!("{PREFIX}翻译不可用：{e}"))?;
            let second = strip_leading_marker(&second);
            if let Err(e) = validate_display_translation(&en, &second) {
                warn!("[中文对照] 重试后仍未通过：{e}（首次：{first}）");
                return Err(format!("{PREFIX}未通过保真校验：{e}（首次：{first}）"));
            }
            info!("[中文对照] 重试后校验通过，输出 {} 字", second.len());
            Ok(second)
        }
    }
}

// ───────────────────────── 回译（中 → 英方向） ─────────────────────────

/// 回译给视频模型的英文提示词。
///
/// 🔴 **只在提交那一刻调**（`VideoGenDialog` 点「生成视频」时）：用户在视频生成页
///    看到/改的那段中文就是最终稿，H3 只认英文，所以临门一脚翻一次。
/// 🔴 **不扣费**：不传 `billing_tag`（与 `analyze_story`、结构校正同一条路）。
/// 🔴 **一律过结构门**：产物要能通过 [`prompt_repair::validate_prompt_shape`]；
///    超预算先让模型压，压不动走代码兜底，兜不住才返回 `Err`（前端退回原文提交）。
///
/// 回译规则本身是**独立规则文件**（`translate_rules/prompt_to_english.md`）：
/// 与写手规则同样「一条规则一个文件」，改规则不用改代码，也方便逐条对回官方原文。
const EN_SYSTEM_PROMPT: &str = include_str!("translate_rules/prompt_to_english.md");

#[tauri::command]
pub async fn translate_prompt_to_english(prompt: String) -> Result<String, String> {
    let zh = strip_leading_marker(&prompt);
    if zh.trim().is_empty() {
        return Err(format!("{PREFIX}提示词为空，没有可翻译的内容。"));
    }

    let device_token = {
        let store = banana_api::get_device_token_store();
        let guard = store.lock().await;
        guard.clone().ok_or("未登录，请先登录".to_string())?
    };
    let api_key = match banana_api::get_user_api_key(&device_token).await {
        Ok(key) if !key.is_empty() => key,
        other => {
            warn!("[回译] get_user_api_key 失败({:?})，回退到 ensure_user_api_token", other.as_ref().err());
            banana_api::ensure_user_api_token(&device_token).await?
        }
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("{PREFIX}客户端初始化失败：{e}"))?;

    info!("[回译] 请求，输入 {} 字", zh.chars().count());

    let mut last_err = String::new();
    let mut draft = String::new();
    // 结构全绿、只差字数的草稿：这份才压得动，留着给代码兜底用。
    let mut best: Option<String> = None;
    for attempt in 0..2 {
        let (system, user) = if attempt == 0 {
            (EN_SYSTEM_PROMPT.to_string(), zh.clone())
        } else {
            (
                format!(
                    "{EN_SYSTEM_PROMPT}\n\nYOUR PREVIOUS ATTEMPT FAILED THESE CHECKS:\n{last_err}\n\
                     Fix exactly that and output the corrected complete English prompt."
                ),
                format!("{zh}\n\n--- YOUR PREVIOUS ATTEMPT (edit this in place, do not start over) ---\n{draft}"),
            )
        };
        let messages = vec![ChatMessageDto { role: "user".to_string(), content: user }];
        let (out, _) = call_gateway_once(&client, &api_key, &system, &messages, 8192, None)
            .await
            .map_err(|e| format!("{PREFIX}翻译不可用：{e}"))?;
        let out = strip_leading_marker(&out);

        match validate_back_translation(&out) {
            Ok(()) => {
                info!("[回译] 第 {} 次通过，输出 {} 字", attempt + 1, out.chars().count());
                return Ok(out);
            }
            Err(e) => {
                warn!("[回译] 第 {} 次校验未过：{e}", attempt + 1);
                // 🔴 结构完好、只是超长的草稿要留下来：模型下一轮可能把它改坏
                //    （2026-10-30 实测第二遍把 `subject_definitions:` 写没了），
                //    兜底若只认最后一份，就等于白丢一版能压缩的稿子。
                if prompt_repair::validate_structure(&out).is_ok() {
                    best = Some(out.clone());
                }
                last_err = e;
                draft = out;
            }
        }
    }

    // 🔴 模型没压进预算 ⇒ 代码兜底（删散文尾巴，不删镜头/台词/标记）。
    //    优先用结构完好的那一版；没有再退回最后一份草稿。
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(b) = best.as_deref() {
        candidates.push(b);
    }
    if !candidates.contains(&draft.as_str()) {
        candidates.push(&draft);
    }
    for candidate in candidates {
        if let Some(fitted) = force_fit_budget(candidate, MAX_BODY_CHARS) {
            if validate_back_translation(&fitted).is_ok() {
                warn!(
                    "[回译] 模型未压进预算，改用代码兜底：{} → {} 字",
                    candidate.chars().count(),
                    fitted.chars().count()
                );
                return Ok(fitted);
            }
        }
    }
    Err(format!("{PREFIX}回译未通过结构校验：{last_err}"))
}

/// 回译产物的门：官方结构 + 字数预算 + 「真的译成英文了」。
fn validate_back_translation(en: &str) -> Result<(), String> {
    prompt_repair::validate_prompt_shape(en)?;
    check_body_is_english(en)
}

/// 英文正文里**不许再剩下中文**（`<d>` 台词、双引号里的画面可见文字、固定口型句除外）。
///
/// 这是回译的「到底翻了没有」判据，与英译中的 [`check_has_cjk`] 互为镜像。
fn check_body_is_english(en: &str) -> Result<(), String> {
    let body = strip_mouth_sentences(&masked_body(en));
    // 官方要求「画面可见文字保留原语言」，中文招牌就会合法地留在英文双引号里 —— 已 mask。
    let leftover: String = body.chars().filter(|c| is_cjk(*c)).collect();
    if leftover.is_empty() {
        return Ok(());
    }
    let sample: String = leftover.chars().take(12).collect();
    Err(format!("英文正文里还剩下中文没译：`{sample}…`"))
}

// ───────────────────────── 保真校验（英 → 中方向） ─────────────────────────

/// 官方六段字段名 —— **永远是英文**（官方形状的硬门）。
const FIELDS: [&str; 6] = [
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
];

/// 景别中文 ↔ 官方英文（官方原文里确实出现过的那 5 档）。
const SHOT_SIZES: [(&str, &str); 5] = [
    ("大特写", "extreme close-up"),
    ("特写", "close-up"),
    ("近景", "close shot"),
    ("中景", "medium shot"),
    ("中远景", "medium-wide shot"),
];

/// 逐字核对英文原文与中文镜像。返回第一条不通过的判据。
///
/// 🔴 **顺序是承重的**：先问「到底翻了没有」，再问「翻得对不对」——
/// 反过来的话，一份原样退回的英文会先在结构判据上全绿，最后才报「没翻」。
pub fn validate_display_translation(en_source: &str, zh_target: &str) -> Result<(), String> {
    let en = strip_leading_marker(en_source);
    let zh = strip_leading_marker(zh_target);
    let (en, zh) = (en.as_str(), zh.as_str());

    check_has_cjk(zh)?;
    check_fields_kept(zh)?;
    check_shot_markers(en, zh)?;
    check_timestamps(en, zh)?;
    check_tags(en, zh)?;
    check_speaker_ids(en, zh)?;
    check_dialogue(en, zh)?;
    check_shot_sizes_reverse(en, zh)?;
    Ok(())
}

/// 剥掉写手在正文前加的一行 `【…】` 标记（如 `【视频提示词】`）。
fn strip_leading_marker(text: &str) -> String {
    let t = text.trim_start();
    let Some(rest) = t.strip_prefix('【') else {
        return t.trim_end().to_string();
    };
    let Some(close) = rest.find('】') else {
        return t.trim_end().to_string();
    };
    let after = &rest[close + '】'.len_utf8()..];
    // 只有「这一行除了标记什么都没有」才算标记行，否则是正文里的 legit 内容
    let first_line_end = after.find('\n').unwrap_or(after.len());
    if after[..first_line_end].trim().is_empty() {
        after.trim_start().trim_end().to_string()
    } else {
        t.trim_end().to_string()
    }
}

/// 汉字（含扩展 A 区）。
fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}')
}

/// 把 `open … close` 之间的内容（含定界符）替换成等长空格，避免跨段误判。
fn mask_spans(text: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(open) {
        out.push_str(&rest[..i]);
        let after = &rest[i + open.len()..];
        match after.find(close) {
            Some(j) => {
                let end = i + open.len() + j + close.len();
                out.push_str(&" ".repeat(end - i));
                rest = &rest[end..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// 屏蔽掉英文双引号里的内容（画面可见文字，两个方向都不翻）。
fn mask_quoted(text: &str, quote: char) -> String {
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for c in text.chars() {
        if c == quote {
            inside = !inside;
            out.push(' ');
            continue;
        }
        out.push(if inside { ' ' } else { c });
    }
    out
}

/// 屏蔽 `<d>…</d>` 与双引号后的正文 —— 任何「这份正文是什么语言」的判据都必须先过这层。
fn masked_body(text: &str) -> String {
    mask_quoted(&mask_spans(text, "<d>", "</d>"), '"')
}

/// 旧版中文口型句的**词干**（主语 他/她/它 会变）。
/// 2026-10-28 起口型改用官方英文串（`his/her/its mouth movements naturally syncing to the
/// new dialogue`），这里保留剥离逻辑只为兼容旧会话里已经存下的中文正文。
const MOUTH_SENTENCE_CORE: &str = "说话时下颌开合、嘴唇随字句张动";

fn strip_mouth_sentences(text: &str) -> String {
    let mut out = text.to_string();
    for subject in ["他", "她", "它"] {
        out = out.replace(&format!("{subject}{MOUTH_SENTENCE_CORE}"), " ");
    }
    out
}

/// 一份真正的翻译至少有这么多个汉字。
///
/// 阈值只是**防呆**：正常一份六段正文的中文镜像有上千个汉字，30 个只是用来挡住
/// 「把英文原样退回」和「只剩口型句/台词」这两种假翻译。
const MIN_TRANSLATED_CJK: usize = 30;

/// 「到底翻了没有」：屏蔽 `<d>`、双引号与固定口型句之后，中文必须**足够多**。
fn check_has_cjk(zh: &str) -> Result<(), String> {
    let body = strip_mouth_sentences(&masked_body(zh));
    let cjk = body.chars().filter(|c| is_cjk(*c)).count();
    if cjk < MIN_TRANSLATED_CJK {
        return Err(format!(
            "译文里只有 {cjk} 个汉字 —— 判定为「没有真正翻译」（只把英文原样退回了）"
        ));
    }
    Ok(())
}

/// 六段英文字段名必须**原样、按序**留在中文镜像里。
fn check_fields_kept(zh: &str) -> Result<(), String> {
    let mut cursor = 0usize;
    for field in FIELDS {
        match zh[cursor..].find(field) {
            Some(i) => cursor += i + field.len(),
            None => return Err(format!("中文镜像里的六段字段名被改动了：找不到 `{field}`")),
        }
    }
    Ok(())
}

/// 收集 `prefix N` 形式的编号（`[Shot 1]` → 1）。
fn collect_numbered(text: &str, prefix: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(prefix) {
        let after = &rest[i + prefix.len()..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            out.push(n);
        }
        rest = after;
    }
    out
}

fn check_shot_markers(en: &str, zh: &str) -> Result<(), String> {
    let (a, b) = (collect_numbered(en, "[Shot "), collect_numbered(zh, "[Shot "));
    if a != b {
        return Err(format!("镜头序号被改动：原文 {:?}，译文 {:?}", a, b));
    }
    Ok(())
}

/// 收集 `At MM:SS.mmm` 时间码。
fn collect_timestamps(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("At ") {
        let after = &rest[i + 3..];
        let mut chars = after.char_indices();
        let mut end = 0usize;
        let mut ok = true;
        for _ in 0..2 {
            match chars.next() {
                Some((j, c)) if c.is_ascii_digit() => end = j + 1,
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            // 冒号
            match after[end..].starts_with(':') {
                true => {
                    let tail = &after[end + 1..];
                    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
                    if digits.contains('.') {
                        out.push(format!("At {}{}{}", &after[..end], ":", digits));
                    }
                }
                false => {}
            }
        }
        rest = after;
    }
    out
}

fn check_timestamps(en: &str, zh: &str) -> Result<(), String> {
    let (a, b) = (collect_timestamps(en), collect_timestamps(zh));
    if a != b {
        return Err(format!("时间码被改动：原文 {:?}，译文 {:?}", a, b));
    }
    Ok(())
}

/// 收集 `<X N>` 形式的标签（含闭标签 `</d>` 不算）。
fn collect_tags(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        let after = &rest[i..];
        let Some(close) = after.find('>') else { break };
        let tag = &after[..=close];
        let inner = tag.trim_start_matches('<').trim_end_matches('>');
        if !inner.starts_with('/') && inner.contains(' ') {
            out.push(tag.to_string());
        }
        rest = &after[close + 1..];
    }
    out
}

fn check_tags(en: &str, zh: &str) -> Result<(), String> {
    let (a, b) = (collect_tags(en), collect_tags(zh));
    if a != b {
        return Err(format!("参考/主体标签被改动：原文 {:?}，译文 {:?}", a, b));
    }
    Ok(())
}

/// 收集 `(S1)` / `(S1,S2)` 形式的发生编号。
fn collect_speaker_ids(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find('(') {
        let after = &rest[i..];
        let Some(close) = after.find(')') else { break };
        let inner = &after[1..close];
        if !inner.is_empty() && inner.chars().all(|c| c == 'S' || c.is_ascii_digit() || c == ',') && inner.starts_with('S') {
            out.push(after[..=close].to_string());
        }
        rest = &after[close + 1..];
    }
    out
}

fn check_speaker_ids(en: &str, zh: &str) -> Result<(), String> {
    let (a, b) = (collect_speaker_ids(en), collect_speaker_ids(zh));
    if a != b {
        return Err(format!("说话人编号 (Sx) 被改动：原文 {:?}，译文 {:?}", a, b));
    }
    Ok(())
}

/// 收集 `<d>…</d>` 的完整片段（台词两个方向都不许动）。
fn collect_dialogue(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("<d>") {
        let after = &rest[i..];
        match after.find("</d>") {
            Some(j) => {
                out.push(after[..j + 4].to_string());
                rest = &after[j + 4..];
            }
            None => break,
        }
    }
    out
}

fn check_dialogue(en: &str, zh: &str) -> Result<(), String> {
    let (a, b) = (collect_dialogue(en), collect_dialogue(zh));
    if a != b {
        return Err("`<d>` 里的台词被改动了（台词必须逐字保留）".to_string());
    }
    Ok(())
}

fn count_occurrences(hay: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    hay.matches(needle).count()
}

/// 景别**反向**映射：英文有的，中文里必须落成对应词。
///
/// ⚠️ 子串关系：`close-up` ⊂ `extreme close-up` —— 数短的那个时要把长的扣掉，
/// 否则一句 `an extreme close-up` 会被同时算成 `close-up` ⇒ 假红。
fn check_shot_sizes_reverse(en: &str, zh: &str) -> Result<(), String> {
    let lower = en.to_lowercase();
    for (zh_word, en_word) in SHOT_SIZES {
        let mut n = count_occurrences(&lower, en_word);
        for (_, longer) in SHOT_SIZES {
            if longer.len() > en_word.len() && longer.contains(en_word) {
                n = n.saturating_sub(count_occurrences(&lower, longer));
            }
        }
        if n > 0 && !zh.contains(zh_word) {
            return Err(format!("英文 `{en_word}` 在中文镜像里没有对应成「{zh_word}」"));
        }
    }
    Ok(())
}

// ─────────────────────────────── 单测 ───────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const EN: &str = "subject_definitions:\n<Subject 1> is the young woman in <Picture 1>.\n\nsummary:\n[reference generation] <Subject 1> stands at the water's edge.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - her robe stays unchanged.\n\ndetailed_description:\n[Shot 1] A medium shot. <Subject 1> (S1) says, <d>[Chinese] 你先回去。</d>她说话时下颌开合、嘴唇随字句张动。\n[Shot 2] At 00:04.000, a close-up of her hands. She stays still.\n\noverall_soundscape:\nWind moves through the reeds.\n\nnon_diegetic_music:\nA solo guqin at a slow tempo.";

    const ZH: &str = "subject_definitions:\n<Subject 1> 是 <Picture 1> 里的年轻女子。\n\nsummary:\n[reference generation] <Subject 1> 站在水边。\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - 她的长袍保持原样。\n\ndetailed_description:\n[Shot 1] 中景。<Subject 1> (S1) 说道，<d>[Chinese] 你先回去。</d>她说话时下颌开合、嘴唇随字句张动。\n[Shot 2] At 00:04.000, 她双手的特写。她保持不动。\n\noverall_soundscape:\n风穿过芦苇。\n\nnon_diegetic_music:\n一段缓慢的古琴独奏。";

    #[test]
    fn accepts_faithful_mirror() {
        assert!(validate_display_translation(EN, ZH).is_ok());
    }

    /// 把英文原样退回必须被拦下 —— 否则一份纯英文会被当成「镜像成功」。
    #[test]
    fn catches_untranslated_english_passthrough() {
        let err = validate_display_translation(EN, EN).unwrap_err();
        assert!(err.contains("没有真正翻译"), "{err}");
    }

    /// 🔴 官方英文正文**必然**含 `<d>[Chinese] 台词</d>`，加上那句中文口型句。
    /// 若有人把掩码或判据改坏，这一条会红。
    #[test]
    fn chinese_mouth_line_alone_does_not_count_as_translation() {
        let only_dialogue = format!(
            "subject_definitions:\n<d>[Chinese] 你先回去。</d>她说话时下颌开合、嘴唇随字句张动。\n\nsummary:\n\nretention_analysis:\n\ndetailed_description:\n\noverall_soundscape:\n\nnon_diegetic_music:\n"
        );
        let err = validate_display_translation(EN, &only_dialogue).unwrap_err();
        assert!(err.contains("没有真正翻译"), "{err}");
    }

    #[test]
    fn catches_translated_field_names() {
        let zh = ZH.replace("detailed_description:", "详细描述：");
        assert_ne!(zh, ZH);
        let err = validate_display_translation(EN, &zh).unwrap_err();
        assert!(err.contains("六段字段名"), "{err}");
    }

    #[test]
    fn catches_changed_timestamp() {
        let zh = ZH.replace("At 00:04.000", "At 00:06.000");
        assert_ne!(zh, ZH);
        let err = validate_display_translation(EN, &zh).unwrap_err();
        assert!(err.contains("时间码"), "{err}");
    }

    #[test]
    fn catches_dropped_shot_marker() {
        let zh = ZH.replace("[Shot 2] At 00:04.000,", "");
        assert_ne!(zh, ZH);
        let err = validate_display_translation(EN, &zh).unwrap_err();
        assert!(err.contains("镜头序号"), "{err}");
    }

    #[test]
    fn catches_changed_dialogue() {
        let zh = ZH.replace("你先回去。", "你赶紧回去。");
        assert_ne!(zh, ZH);
        let err = validate_display_translation(EN, &zh).unwrap_err();
        assert!(err.contains("台词"), "{err}");
    }

    #[test]
    fn catches_changed_speaker_id() {
        let zh = ZH.replace("(S1) 说道", "(S2) 说道");
        assert_ne!(zh, ZH);
        let err = validate_display_translation(EN, &zh).unwrap_err();
        assert!(err.contains("说话人编号"), "{err}");
    }

    /// 反向景别：`a close-up` 必须在中文里落成「特写」。
    #[test]
    fn catches_missing_shot_size() {
        let zh = ZH.replace("的特写", "的近景");
        assert_ne!(zh, ZH);
        let err = validate_display_translation(EN, &zh).unwrap_err();
        assert!(err.contains("特写"), "{err}");
    }

    /// 子串陷阱：`an extreme close-up` 不许被同时算成 `a close-up`。
    #[test]
    fn extreme_close_up_is_not_double_counted() {
        let en = EN.replace("a close-up of her hands", "an extreme close-up of her hands");
        let zh = ZH.replace("她双手的特写", "她双手的大特写");
        assert!(
            validate_display_translation(&en, &zh).is_ok(),
            "`an extreme close-up` 被误判成了 `a close-up`（子串扣减失效）"
        );
    }

    #[test]
    fn strips_leading_marker_line() {
        assert_eq!(strip_leading_marker("【视频提示词】\nsubject_definitions:"), "subject_definitions:");
        // 正文里本来就有 `【` 的行不当成标记
        assert_eq!(strip_leading_marker("【选图】@图1\nsubject_definitions:").starts_with("【选图】"), true);
    }
}
