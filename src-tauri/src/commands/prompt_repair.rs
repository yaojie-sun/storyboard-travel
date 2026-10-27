//! 提示词**结构自动校正** —— 写手出的正文结构不对时，悄悄修一版，用户几乎无感。
//!
//! 为什么要有它：写手是模型，六段结构、镜头编号、闭唇句、字数这些硬约束它偶尔会漏。
//! 2026-10-28 起用户**可以**手改提示词了（正文是中文，提交时回译成英文，见
//! [`super::translate_display::translate_prompt_to_english`]），但结构错误仍然不能让用户吃掉 ——
//! 所以这里在**用户看到之前**把能机械判定的缺陷自动修一遍。
//!
//! 🔴 **不扣费**：本命令**不传 `billing_tag`**（与 `analyze_story` 同一条路），
//!    属于产品内的自动修正，不是一次独立的用户请求。真正的扣费仍全部在服务器上执行。
//! 🔴 **只修被点名的缺陷**：人物、镜头内容、台词一个字都不许动 ——
//!    唯一的例外是**超长**：这时压缩散文本身就是被点名的缺陷（官方 §5.2 的字数区间
//!    + 模型 7000 字硬限），但仍不许删镜头、删台词、删 retention 行。
//!    改完还要过一遍同一套校验（结构与长度都算，见 [`validate_prompt_shape`]）。
//! 🔴 **修不好就如实返回 Err**：前端退回原文 + 亮结构自检红标，绝不假装修好了。

use reqwest::Client;
use tokio::time::Duration;
use tracing::{info, warn};

use super::banana_api;
use super::chat::{call_gateway_once, ChatMessageDto};

const TIMEOUT_SECS: u64 = 120;
const PREFIX: &str = "结构校正：";
/// 最多打三次网关：第一次按缺陷清单改，之后各带着「还差多少」再压一次。
/// 实测两次不够（第二次曾把 `overall_soundscape:` 删掉），但也不该无限重试 ——
/// 三次还不行就走 [`force_fit_budget`] 的代码兜底。
const MAX_ATTEMPTS: usize = 3;

/// 正文字符预算（**英文**），与前端 `promptShapeCheck.ts` 的 `BODY_SOFT_LIMIT` 同一个数。
///
/// 出处：视频模型硬限 `[1, 7000]` 字符（**含规则头**），客户端安全线 6900，
/// 规则头约 700 字 ⇒ 正文真正能用的额度 ≈ 6200。
/// 🔴 低于 6200 才算修好，否则前端 `checkPromptShape` 仍会判 error、把正文退回原文。
pub(crate) const MAX_BODY_CHARS: usize = 6200;
/// 正文字符预算（**中文**），与前端 `BODY_SOFT_LIMIT_ZH` 同一个数。
///
/// 🔴 为什么中文要和英文分开算：2026-10-28 用户定调「写手全程中文，提交时才译英文」，
///    写手出的正文从此是**中文**。官方 §5.1 的英文正文预算直接套到中文上等于白送
///    一倍额度。中文→英文的实测倍率是 **2.25 ~ 2.69**（四份官方示例走
///    [`super::translate_display::translate_prompt_to_english`] 实测量到），
///    按 2.6 折算 ⇒ 中文这一侧卡 2400 字，回译后约 6200 英文字符，正好贴着英文预算。
pub(crate) const MAX_BODY_CHARS_ZH: usize = 2400;
/// 让人（模型）往 6000 压，别压到 6199 这种擦边球 —— 留 200 字余量。
const TARGET_BODY_CHARS: usize = 6000;
/// 中文侧同理留 100 字余量。
const TARGET_BODY_CHARS_ZH: usize = 2300;

/// 字符数用 `chars()` 而不是 `len()`：`len()` 是字节数，`<d>` 里的中文一句就 3 倍暴涨，
/// 会跟前端 `text.length` 的口径对不上（前端才是最终裁判）。
fn char_count(text: &str) -> usize {
    text.chars().count()
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}')
}

/// 把 `open…close` 之间的内容（含定界符）抹成等长空格，避免跨段误判。
fn mask_spans(text: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(open) {
        out.push_str(&rest[..i]);
        let after = &rest[i + open.len()..];
        match after.find(close) {
            Some(j) => {
                let end = i + open.len() + j + close.len();
                out.extend(rest[i..end].chars().map(|_| ' '));
                rest = &rest[end..];
            }
            None => {
                out.push_str(&rest[i..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 把英文双引号里的内容抹成空格（画面内文字，任何语言都合法）。
fn mask_quoted(text: &str, quote: char) -> String {
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for c in text.chars() {
        if c == quote {
            inside = !inside;
            out.push(' ');
        } else if inside {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// 这份正文是不是**中文写的**？判据与前端 `looksChineseWritten` 逐条对齐。
///
/// 🔴 **必须先屏蔽 `<d>…</d>` 与英文双引号里的内容**：官方英文正文**必然**含
///    `<d>[Chinese] 台词</d>`，拿「正文里有没有汉字」当判据会把每一单都判成中文、
///    于是永远不回译。
/// 🔴 看的是六段字段名后面**第一个实义字符**，而且要**先跳过前置标记**：
///    中文正文里 `<Subject 1> 是……` 的头一个字是 `<`、`[reference generation] 目标……`
///    的头一个字是 `[`，不跳过就一个字段都判不中（2026-10-28 实测踩过这个坑）。
fn body_is_chinese(text: &str) -> bool {
    let body = mask_quoted(&mask_spans(text, "<d>", "</d>"), '"');
    let mut seen = 0usize;
    let mut hits = 0usize;
    for field in FIELDS {
        let Some(idx) = body.find(field) else { continue };
        seen += 1;
        if first_meaningful_char(&body[idx + field.len()..]).is_some_and(is_cjk) {
            hits += 1;
        }
    }
    if seen >= 3 {
        return hits * 10 >= seen * 6;
    }
    // 字段名都对不上（残缺正文）⇒ 退回中英字符占比
    let (mut cjk, mut latin) = (0usize, 0usize);
    for c in body.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else if c.is_ascii_alphabetic() {
            latin += 1;
        }
    }
    cjk + latin > 0 && cjk * 2 >= cjk + latin
}

/// 跳过空白、`<…>` `[…]` 这类前置标记与零星标点后，取第一个「实义字符」。
/// 例：`<Subject 1> 是本段的构图基准` ⇒ `是`（中文）；`<Picture 1> is the composition` ⇒ `i`（英文）。
fn first_meaningful_char(s: &str) -> Option<char> {
    let mut rest = s;
    loop {
        let (i, c) = loop {
            match rest.char_indices().next() {
                Some((i, c)) if c.is_whitespace() => rest = &rest[i + c.len_utf8()..],
                Some(x) => break x,
                None => return None,
            }
        };
        match c {
            '<' | '[' => {
                let close = if c == '<' { '>' } else { ']' };
                // 标记没闭合就当作正文（残缺正文交给结构校验去报）
                match rest[i..].find(close) {
                    Some(j) => rest = &rest[i + j + 1..],
                    None => return Some(c),
                }
            }
            '(' | ')' | ':' | ',' | ';' | '-' | '，' | '。' | '：' => rest = &rest[i + c.len_utf8()..],
            _ => return Some(c),
        }
    }
}

/// 按正文语言取预算：中文 2400 / 英文 6200。
fn body_budget(text: &str) -> usize {
    if body_is_chinese(text) {
        MAX_BODY_CHARS_ZH
    } else {
        MAX_BODY_CHARS
    }
}

/// 按正文语言取「建议压到多少」。
fn target_budget(text: &str) -> usize {
    if body_is_chinese(text) {
        TARGET_BODY_CHARS_ZH
    } else {
        TARGET_BODY_CHARS
    }
}

const SYSTEM_PROMPT: &str = r#"You repair STRUCTURAL defects in a MiniMax H3 full-reference (ref2va) video-generation prompt.

LANGUAGE OF THE BODY
- The prose may be CHINESE or ENGLISH. Keep whatever language the body is already written in.
- NEVER translate the body, and never switch its language. A Chinese body stays Chinese; an English body stays English.
- Keep the official literal tokens exactly as they are, in English, no matter what language the prose is in:
  field names, `[Shot N]`, `At MM:SS.mmm`, `<scenetrans>` / `<cutoff>` / `[unclear]`, `<Subject N>` / `<Picture N>`,
  `(S1)` speaker ids, the retention markers (fully_preserved / partially_preserved / attribute_transfer / weak_reference),
  `appears in`, and the camera / shot-size / voiceover vocabulary.
- Everything between `<d>` and `</d>` stays byte-for-byte identical, in its original language.

OUTPUT RULES
- Output ONLY the corrected prompt. No commentary, no explanation, no code fences.
- Change NOTHING except what is required to fix the listed defects.
- Do NOT reword prose that is already correct. Do NOT add or remove shots.
- Preserve every `[Shot N]`, every `<d>…</d>` line byte-for-byte, every retention line, and all six field names.
- LENGTH: when the defect is "too long", compressing the prose IS the required fix — shorten adjectives,
  merge clauses, state each visual fact once, and keep every shot, tag, retention line and dialogue line.
  Output must fit the stated character budget; that is the only situation where the wording may change.

STRUCTURE THAT MUST HOLD
- The six section field names, in this order, each on its own line, in English:
  subject_definitions: / summary: / retention_analysis: / detailed_description: / overall_soundscape: / non_diegetic_music:
- `[Shot N]` markers run consecutively from [Shot 1], exactly one per shot, never duplicated, never dropped, never renumbered out of order.
- Every `<d>` has a matching `</d>`, and the dialogue inside stays byte-for-byte identical (including the `[Chinese]` tag).
- Every line containing `<d>` carries a speaker id such as (S1) before the dialogue.
- NEVER write `<Audio N>` and never write "+ audio reference": this task is given reference images only, with no audio asset.
- Every line with `says in an off-screen voiceover` also states that the lips stay completely closed.
- The line under `summary:` starts with a bracketed task-type tag, e.g. [reference generation]."#;

/// 结构校验（**只判 error 级**，与前端 `promptShapeCheck.ts` 的 error 口径**逐条对齐**）。
///
/// 这里判的每一条都能指到官方原文：
/// 六段字段名/次序 §5.1、`[Shot N]` 连续 §5.x、`<d>` 成对与 `(Sx)` §5.4、
/// 画外音闭唇句 §4.4、无 `<Audio N>` §2.5 + 本产品入参、summary 任务类型标签，
/// 正文长度预算见 [`body_budget`]（中文 2400 / 英文 6200，按正文语言二选一）。
///
/// 🔴 **口径必须与前端一致**：前端 `checkPromptShape` 是最终裁判，它判 error 就会
///    把这里返回的正文丢掉、界面照样报「自动校正未成功」—— 少判一条等于白修一轮。
///
/// 🔴 **长度必须算进来**：只判结构的话，一份「结构全对、只是 6400 字」的正文会在
///    [`repair_prompt_shape`] 开头被判成「已经合规」直接原样返回，前端拿到「没变」
///    就把状态记成失败、把超长清单摆给用户 —— 2026-10-28 冒烟自测就是这么卡住的。
pub fn validate_prompt_shape(text: &str) -> Result<(), String> {
    check_fields(text)?;
    check_shots(&detailed_section(text))?;
    check_d_pairs(text)?;
    check_no_audio(text)?;
    check_speaker_ids(&detailed_section(text))?;
    check_voiceover_lips(text)?;
    check_summary_tag(text)?;
    check_length(text)?;
    Ok(())
}

/// 有画外音的句子必须带官方的闭唇句（§4.4）。
///
/// 🔴 这条**必须和前端 `promptShapeCheck.ts` 逐条一致**：前端是最终裁判，
///    它判 error 就会把这里返回的正文丢掉、界面上照样报「自动校正未成功」。
///    2026-10-28 实测：压缩时模型顺手删了闭唇句，这里放过了、前端拦下，白修一轮。
fn check_voiceover_lips(text: &str) -> Result<(), String> {
    let mut bad = 0usize;
    for line in text.lines() {
        let trigger = line.contains("says in an off-screen voiceover") || line.contains("-voice-over");
        if trigger && !has_closed_lips(line) {
            bad += 1;
        }
    }
    if bad > 0 {
        return Err(format!("{bad} 条画外音句缺闭唇句"));
    }
    Ok(())
}

/// 与前端 `CLOSED_LIPS` 同一组写法：画框里有人 ⇒ 闭唇；空镜 ⇒ 明说镜里没人。
fn has_closed_lips(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    if l.contains("lips remain completely closed") || l.contains("lip remain completely closed") {
        return true;
    }
    if l.contains("no person in this shot")
        || l.contains("no person in frame")
        || l.contains("no person is in this shot")
        || l.contains("no person is in frame")
        || l.contains("no one can open a mouth")
    {
        return true;
    }
    // `lips remain completely closed` 的宽松写法（his/her/its 已由包含判断覆盖）
    l.contains("remain completely closed")
}

/// 一句话里出现这些就**不许删**：删了六段结构、台词或官方闭集字面量就没了。
const PROTECTED: &[&str] = &[
    "<d>",
    "</d>",
    "[Shot ",
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
    "appears in",
    "off-screen voiceover",
    "remain completely closed",
    "no person in this shot",
    "no person in frame",
    "no one can open a mouth",
];

fn is_protected(sentence: &str) -> bool {
    PROTECTED.iter().any(|p| sentence.contains(p))
}

/// 一行按句切开（**`<d>…</d>` 里不切**：台词里的句号不是句子边界）。
///
/// 只用 `char_indices()` 取位置 —— 中文是多字节，按字节下标切片会 panic。
fn split_sentences(line: &str) -> Vec<String> {
    // 先把 `<d>…</d>` 的字节区间圈出来
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut pos = 0usize;
    while let Some(a) = line[pos..].find("<d>") {
        let start = pos + a;
        let Some(b) = line[start..].find("</d>") else { break };
        let end = start + b + 4;
        spans.push((start, end));
        pos = end;
    }
    let inside = |i: usize| spans.iter().any(|(s, e)| i >= *s && i < *e);

    let mut out: Vec<String> = Vec::new();
    let mut start = 0usize;
    for (i, c) in line.char_indices() {
        if inside(i) || !matches!(c, '.' | '。' | '!' | '?') {
            continue;
        }
        // 句号后面还有非空内容 ⇒ 在这里断
        let mut j = i + c.len_utf8();
        while j < line.len() {
            let ch = line[j..].chars().next().unwrap();
            if ch == ' ' || ch == '\t' {
                j += ch.len_utf8();
            } else {
                break;
            }
        }
        if j < line.len() {
            out.push(line[start..j].trim_end().to_string());
            start = j;
        }
    }
    if start < line.len() {
        out.push(line[start..].trim_end().to_string());
    }
    out.retain(|s| !s.trim().is_empty());
    out
}

/// **确定性兜底**：模型压不下来时，按句删散文，直到落进预算。
///
/// 🔴 为什么必须有它：模型的「自己改短」不保证 —— 2026-10-28 实测两次都失败
///    （第一次 6866 字仍超，第二次直接把 `overall_soundscape:` 字段名删了）。
///    用户口径是**写手必须符合 H3 字数**，所以最后一米必须由代码保证。
///
/// 删的顺序（越不影响画面越先删）：音乐 → 环境声 → 摘要 → 保留判定 → 主体定义 → 镜头描述。
/// **每行至少留第一句**（`[Shot N]` 标记、retention 标记、`appears in` 都在第一句里）；
/// 带 `<d>`／闭唇句／官方标记的句子一律不删。
pub(crate) fn force_fit_budget(text: &str, budget: usize) -> Option<String> {
    if char_count(text) <= budget {
        return Some(text.to_string());
    }
    struct Line {
        section: String,
        indent: String,
        sentences: Vec<String>,
    }
    let mut order: Vec<String> = Vec::new();
    let mut lines: Vec<Line> = Vec::new();
    let mut section = String::new();
    for raw in text.lines() {
        let trimmed = raw.trim();
        let is_field = FIELDS.iter().any(|f| trimmed.starts_with(f));
        if is_field {
            section = trimmed.split(':').next().unwrap_or("").to_string() + ":";
            if !order.contains(&section) {
                order.push(section.clone());
            }
        }
        if trimmed.is_empty() || is_field {
            lines.push(Line { section: String::new(), indent: String::new(), sentences: vec![raw.to_string()] });
            continue;
        }
        let indent: String = raw.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        lines.push(Line { section: section.clone(), indent, sentences: split_sentences(trimmed) });
    }

    let rebuild = |lines: &[Line]| -> String {
        let mut out: Vec<String> = Vec::with_capacity(lines.len());
        for l in lines {
            // 整行原样保留的（字段名行 / 空行）只有一句且无缩进
            if l.section.is_empty() {
                out.push(l.sentences.join(""));
            } else {
                out.push(format!("{}{}", l.indent, l.sentences.join(" ")));
            }
        }
        out.join("\n")
    };
    // 🔴 必须拿**拼起来的真实长度**判，不能各句字数相加 —— 句子之间还有空格，
    //    按相加算会低估几百字，压完仍然超（2026-10-28 单测实测 6329 > 6200）。
    let total = |lines: &[Line]| -> usize { char_count(&rebuild(lines)) };

    // 删的顺序：最后出现的最先删（音乐段在最后）
    let mut cut_order: Vec<String> = order.clone();
    cut_order.reverse();
    for sec in cut_order {
        // 同一段里从后往前删
        let idxs: Vec<usize> = (0..lines.len()).filter(|i| lines[*i].section == sec).collect();
        for li in idxs.into_iter().rev() {
            loop {
                if total(&lines) <= budget {
                    return Some(rebuild(&lines));
                }
                if lines[li].sentences.len() <= 1 {
                    break;
                }
                // 从尾部找第一句「可删」的（受保护的跳过）
                let pos = (0..lines[li].sentences.len())
                    .rev()
                    .find(|k| *k > 0 && !is_protected(&lines[li].sentences[*k]));
                let Some(pos) = pos else { break };
                lines[li].sentences.remove(pos);
            }
        }
        if total(&lines) <= budget {
            return Some(rebuild(&lines));
        }
    }
    None
}

fn check_speaker_ids(detailed: &str) -> Result<(), String> {
    let mut shot = 0usize;
    let mut missing: Vec<usize> = Vec::new();
    for line in detailed.lines() {
        if let Some(n) = shot_number(line) {
            shot = n;
        }
        if line.contains("<d>") && !has_speaker_id(line) {
            if !missing.contains(&shot) {
                missing.push(shot);
            }
        }
    }
    if !missing.is_empty() {
        let list: Vec<String> = missing.iter().map(|n| n.to_string()).collect();
        return Err(format!("镜头 {} 的台词缺说话人编号 (S1)", list.join(",")));
    }
    Ok(())
}

fn has_speaker_id(line: &str) -> bool {
    // (S1) (S12) 都算；前端判据是 /\(S\d/
    line.as_bytes()
        .windows(3)
        .any(|w| w[0] == b'(' && w[1] == b'S' && w[2].is_ascii_digit())
}

fn check_summary_tag(text: &str) -> Result<(), String> {
    let Some(start) = text.find("summary:") else {
        return Ok(());
    };
    let first = text[start + "summary:".len()..]
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    if first.trim().is_empty() || !first.trim_start().starts_with('[') {
        return Err("summary 首项不是方括号任务类型（如 [reference generation]）".to_string());
    }
    Ok(())
}

/// 给模型的英文指令 —— 只说「还是不合规」模型会乱改，必须点到具体规则。
fn repair_hint(text: &str) -> String {
    let mut hints: Vec<String> = Vec::new();
    let detailed = detailed_section(text);
    if let Err(e) = check_voiceover_lips(text) {
        hints.push(format!(
            "- {e}: every line with `says in an off-screen voiceover` must also end with the closed-lips \
             clause, e.g. `while his lips remain completely closed.`"
        ));
    }
    if let Err(e) = check_speaker_ids(detailed) {
        hints.push(format!("- {e}: every line containing <d> needs a speaker id such as (S1) before it."));
    }
    if let Err(e) = check_summary_tag(text) {
        hints.push(format!("- {e}: the first line under summary: must start with a bracketed tag."));
    }
    if let Err(e) = check_no_audio(text) {
        hints.push(format!("- {e}: remove every <Audio N> entry."));
    }
    if char_count(text) > body_budget(text) {
        hints.push(length_advice(text).trim_start_matches('\n').to_string());
    }
    if hints.is_empty() {
        String::new()
    } else {
        format!("\nWHAT IS STILL WRONG:\n{}", hints.join("\n"))
    }
}

fn check_length(text: &str) -> Result<(), String> {
    let n = char_count(text);
    let budget = body_budget(text);
    if n > budget {
        return Err(format!("正文 {n} 字，超出 {budget} 字预算"));
    }
    Ok(())
}

/// 给模型的「还差多少、砍哪儿」——只对超长有用，其它缺陷返回空串。
fn length_advice(text: &str) -> String {
    let n = char_count(text);
    let budget = body_budget(text);
    if n <= budget {
        return String::new();
    }
    let target = target_budget(text);
    let cut = n - target;
    format!(
        "\nLENGTH: the body is {n} characters but the hard budget is {budget}. \
         Cut at least {cut} characters of prose (target {target} or less) by shortening \
         adjectives, merging clauses and stating each visual fact once. Do not drop any [Shot N], \
         any <d>…</d> line, any retention line, or any of the six field names."
    )
}

/// 取出 `detailed_description:` 那一段。
///
/// 🔴 镜头编号**只能在这一段里判**：`summary` 和 `retention_analysis` 里会**引用**
/// `[Shot 1]`（`appears in [Shot 1], [Shot 2]` 之类），整篇扫出来的序列是 1,2,1,2,1,2，
/// 用「逐个递增」去判会把每一份正常提示词都判成不连续。
fn detailed_section(text: &str) -> &str {
    let Some(start) = text.find("detailed_description:") else {
        return text;
    };
    match text[start..].find("overall_soundscape:") {
        Some(len) => &text[start..start + len],
        None => &text[start..],
    }
}

const FIELDS: [&str; 6] = [
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
];

fn check_fields(text: &str) -> Result<(), String> {
    let mut cursor = 0usize;
    for field in FIELDS {
        match text[cursor..].find(field) {
            Some(i) => cursor += i + field.len(),
            None => return Err(format!("缺少或打乱了六段字段名 `{field}`")),
        }
    }
    Ok(())
}

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

/// 一行开头的 `[Shot N]`（用于把台词行归到所属镜头）。
fn shot_number(line: &str) -> Option<usize> {
    let i = line.find("[Shot ")?;
    let digits: String = line[i + "[Shot ".len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<usize>().ok()
}

/// 只对 `detailed_description` 段调用（见 [`detailed_section`]）。
fn check_shots(text: &str) -> Result<(), String> {
    let shots = collect_numbered(text, "[Shot ");
    if shots.is_empty() {
        return Ok(());
    }
    let broken = shots.iter().enumerate().any(|(i, n)| *n as usize != i + 1);
    if broken {
        let got: Vec<String> = shots.iter().map(|n| n.to_string()).collect();
        return Err(format!("镜头编号不连续或重复：{}", got.join(",")));
    }
    Ok(())
}

fn check_d_pairs(text: &str) -> Result<(), String> {
    let open = text.matches("<d>").count();
    let close = text.matches("</d>").count();
    if open != close {
        return Err(format!("`<d>` 标记未成对：开 {open} 个 / 闭 {close} 个"));
    }
    Ok(())
}

fn check_no_audio(text: &str) -> Result<(), String> {
    // `<Audio 1>` / `<Audio1>` 都算
    let mut rest = text;
    while let Some(i) = rest.find("<Audio") {
        let after = &rest[i + "<Audio".len()..];
        if after.trim_start().starts_with(|c: char| c.is_ascii_digit()) {
            return Err("正文出现了音频条目 `<Audio N>`，但本任务只挂了参考图".to_string());
        }
        rest = after;
    }
    Ok(())
}

/// 结构不对就自动修一版（**不扣费**）。修不好返回 `Err`，由前端退回原文。
#[tauri::command]
pub async fn repair_prompt_shape(prompt: String, issues: String) -> Result<String, String> {
    let en = prompt.trim().to_string();
    if en.is_empty() {
        return Err(format!("{PREFIX}正文为空"));
    }
    // 已经合规 ⇒ 一次模型都不调，直接把原文还回去
    if validate_prompt_shape(&en).is_ok() {
        return Ok(en);
    }

    let device_token = {
        let store = banana_api::get_device_token_store();
        let guard = store.lock().await;
        guard.clone().ok_or("未登录，请先登录".to_string())?
    };
    let api_key = match banana_api::get_user_api_key(&device_token).await {
        Ok(key) if !key.is_empty() => key,
        other => {
            warn!("[结构校正] get_user_api_key 失败({:?})，回退 ensure_user_api_token", other.as_ref().err());
            banana_api::ensure_user_api_token(&device_token).await?
        }
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("{PREFIX}客户端初始化失败：{e}"))?;

    let defect_list = if issues.trim().is_empty() {
        "the structural defects listed in the rules below".to_string()
    } else {
        issues.trim().to_string()
    };

    info!("[结构校正] 请求，输入 {} 字，缺陷：{defect_list}", char_count(&en));

    // 每次失败都带着**具体还差什么**重来：超长要报出「至少再砍 N 字」，
    // 只说「还是超长」模型只会象征性删几个词（2026-10-28 冒烟实测）。
    let mut last_err = String::new();
    let mut draft = en.clone();
    for attempt in 0..MAX_ATTEMPTS {
        let (system, user) = if attempt == 0 {
            (
                SYSTEM_PROMPT.to_string(),
                format!("{en}\n\n--- DEFECTS TO FIX (fix exactly these, change nothing else) ---\n{defect_list}"),
            )
        } else {
            (
                format!(
                    "{SYSTEM_PROMPT}\n\nYOUR PREVIOUS ATTEMPT STILL FAILED: {last_err}\n\
                     Fix exactly that and output the corrected complete prompt.\n\
                     The six field names must each appear exactly once, in this order, unchanged:\n\
                     subject_definitions: / summary: / retention_analysis: / detailed_description: /\n\
                     overall_soundscape: / non_diegetic_music:\n\
                     Output the COMPLETE prompt, never a fragment, and never drop a section."
                ),
                format!("{en}\n\n--- YOUR PREVIOUS ATTEMPT (edit in place) ---\n{draft}"),
            )
        };
        // 🔴 billing_tag 传 None：这是产品内自动修正，不是一次用户请求，不扣费。
        let messages = vec![ChatMessageDto { role: "user".to_string(), content: user }];
        let (out, _) = call_gateway_once(&client, &api_key, &system, &messages, 8192, None)
            .await
            .map_err(|e| format!("{PREFIX}校正不可用：{e}"))?;
        let out = out.trim().to_string();

        match validate_prompt_shape(&out) {
            Ok(()) => {
                info!("[结构校正] 第 {} 次通过，输出 {} 字", attempt + 1, char_count(&out));
                return Ok(out);
            }
            Err(e) => {
                warn!("[结构校正] 第 {} 次校正后仍不合规：{e}", attempt + 1);
                // 把「到底还差什么、至少再砍多少字」写进下一轮
                last_err = format!("{e}{}", repair_hint(&out));
                draft = out;
            }
        }
    }

    // 🔴 模型压不下来（实测两次都失败）⇒ 代码兜底：按句删散文，**不删**六段字段名、
    //    `[Shot N]`、`<d>` 台词、retention 标记与闭唇句。用户口径是「无论脚本多长，
    //    写手都必须符合 H3 字数」——最后一米不能交给模型。
    for candidate in [&draft, &en] {
        if let Some(fitted) = force_fit_budget(candidate, body_budget(candidate)) {
            if validate_prompt_shape(&fitted).is_ok() {
                warn!(
                    "[结构校正] 模型未压进预算，改用代码兜底：{} → {} 字",
                    char_count(candidate),
                    char_count(&fitted)
                );
                return Ok(fitted);
            }
        }
    }

    Err(format!("{PREFIX}未能修复（{last_err}）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ⚠️ 这份样例**故意**在 summary / retention 里引用 `[Shot 1] [Shot 2]` ——
    // 真实提示词就是这样，整篇扫编号会得到 1,2,1,1,2。判据必须只认 detailed_description 段。
    const OK: &str = "subject_definitions:\n<Subject 1> is her.\n\nsummary:\n[reference generation] [Shot 1] follows the water, [Shot 2] cuts to her.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - unchanged.\n\ndetailed_description:\n[Shot 1] A medium shot. <Subject 1> (S1) says in an off-screen voiceover: <d>[Chinese] 回去。</d> while her lips remain completely closed.\n[Shot 2] At 00:04.000, a close-up of her hands.\n\noverall_soundscape:\nWind.\n\nnon_diegetic_music:\nGuqin.";

    // 2026-10-28 起写手出的正文是**中文**（提交时才回译成英文），所以中文侧必须有
    // 自己的预算与判定。这份样例故意让每个字段的内容都以 `<…>` / `[…]` 标记开头 ——
    // 中文正文真实形态就是这样，判据不跳过前置标记就一个字段都判不中。
    const OK_ZH: &str = "subject_definitions:\n<Subject 1> 是她本人。\n\nsummary:\n[reference generation] 目标视频跟随水面，随后切到她的手。\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - 保持不变。\n\ndetailed_description:\n[Shot 1] 一个 a medium shot。<Subject 1> (S1) 以画外音说：<d>[Chinese] 回去。</d> 她说话时嘴唇保持完全闭合。\n[Shot 2] At 00:04.000, the shot cuts to a close-up，拍她的手。\n\noverall_soundscape:\n风声。\n\nnon_diegetic_music:\n古琴。";

    #[test]
    fn accepts_well_formed_prompt() {
        assert!(validate_prompt_shape(OK).is_ok());
    }

    #[test]
    fn accepts_well_formed_chinese_prompt() {
        assert!(validate_prompt_shape(OK_ZH).is_ok(), "{:?}", validate_prompt_shape(OK_ZH));
    }

    #[test]
    fn detects_which_language_the_body_is_written_in() {
        assert!(body_is_chinese(OK_ZH), "中文正文必须判成中文");
        assert!(!body_is_chinese(OK), "英文正文不能被判成中文");
        assert_eq!(body_budget(OK_ZH), MAX_BODY_CHARS_ZH);
        assert_eq!(body_budget(OK), MAX_BODY_CHARS);
    }

    #[test]
    fn chinese_body_uses_the_chinese_budget() {
        // 3400 字中文：结构全对，但回译后约 8800 英文字符 ⇒ 必须在中文这一关就拦下。
        let pad = "远处的车流贴着湿漉漉的沥青低鸣。".repeat(200);
        let long = OK_ZH.replace("风声。", &format!("风声。{pad}"));
        let n = char_count(&long);
        assert!(n > MAX_BODY_CHARS_ZH && n < MAX_BODY_CHARS, "{n}");
        let err = validate_prompt_shape(&long).unwrap_err();
        assert!(err.contains(&MAX_BODY_CHARS_ZH.to_string()), "{err}");

        // 代码兜底也必须按中文预算压（不是 6200）
        let fitted = force_fit_budget(&long, body_budget(&long)).expect("应当能压进中文预算");
        assert!(char_count(&fitted) <= MAX_BODY_CHARS_ZH, "{}", char_count(&fitted));
        assert!(validate_prompt_shape(&fitted).is_ok(), "{:?}", validate_prompt_shape(&fitted));
        assert!(fitted.contains("<d>[Chinese] 回去。</d>"));
    }

    #[test]
    fn catches_missing_field() {
        let bad = OK.replace("overall_soundscape:", "sound:");
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("六段字段名"), "{err}");
    }

    #[test]
    fn catches_out_of_order_fields() {
        // 把 overall_soundscape 与 non_diegetic_music 对调
        let bad = OK
            .replace("overall_soundscape:\nWind.", "@@")
            .replace("non_diegetic_music:\nGuqin.", "overall_soundscape:\nWind.")
            .replace("@@", "non_diegetic_music:\nGuqin.");
        assert_ne!(bad, OK);
        assert!(validate_prompt_shape(&bad).is_err());
    }

    #[test]
    fn catches_broken_shot_numbers() {
        let bad = OK.replace("[Shot 2]", "[Shot 3]");
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("镜头编号"), "{err}");
    }

    #[test]
    fn catches_unbalanced_dialogue() {
        let bad = OK.replace("</d> while", " while");
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("未成对"), "{err}");
    }

    #[test]
    fn force_fit_cuts_soundscape_and_music_first() {
        let pad = "Distant traffic hums over the wet asphalt. ".repeat(200);
        let long = OK.replace("Wind.", &format!("Wind. {pad}"));
        assert!(char_count(&long) > MAX_BODY_CHARS);
        let fitted = force_fit_budget(&long, MAX_BODY_CHARS).expect("应当能压进预算");
        assert!(char_count(&fitted) <= MAX_BODY_CHARS, "{}", char_count(&fitted));
        assert!(validate_prompt_shape(&fitted).is_ok(), "{:?}", validate_prompt_shape(&fitted));
        // 台词、六段字段名一个都不能少
        assert!(fitted.contains("<d>[Chinese] 回去。</d>"));
        assert!(fitted.contains("says in an off-screen voiceover"));
        for f in FIELDS {
            assert!(fitted.contains(f), "丢了字段 {f}");
        }
    }

    #[test]
    fn force_fit_keeps_shot_markers_and_retention() {
        // 只往 detailed_description 里灌水：必须从后往前删句子，但 [Shot N] 与
        // retention 的标记/`appears in` 都留着
        let pad = "The wet concrete reflects a thin orange band of light. ".repeat(160);
        let long = OK.replace("[Shot 2] At 00:04.000,", &format!("[Shot 2] At 00:04.000, {pad}"));
        assert!(char_count(&long) > MAX_BODY_CHARS);
        let fitted = force_fit_budget(&long, MAX_BODY_CHARS);
        // 灌水全在 dd 段 ⇒ 段落顺序里 dd 最后删；删不够就不算兜底成功，但绝不能坏结构
        if let Some(fitted) = fitted {
            assert!(char_count(&fitted) <= MAX_BODY_CHARS);
            assert!(validate_prompt_shape(&fitted).is_ok(), "{:?}", validate_prompt_shape(&fitted));
            assert!(fitted.contains("[Shot 1]") && fitted.contains("[Shot 2]"));
            assert!(fitted.contains("fully_preserved - unchanged."));
        }
    }

    #[test]
    fn split_sentences_never_breaks_inside_dialogue() {
        let s = split_sentences("[Shot 1] She turns. <Subject 1> (S1) says: <d>[Chinese] 走吧。别回头。</d> Her lips close.");
        assert_eq!(s.len(), 2, "{s:?}");
        assert!(s[1].contains("<d>[Chinese] 走吧。别回头。</d>"));
    }

    #[test]
    fn catches_over_long_body() {
        // 结构全对、只是超长 —— 2026-10-28 冒烟就是这么卡住的：
        // 只要长度不算进校验，这里就会被判「已合规」原样返回，前端随之报失败。
        let bad = OK.replace("Wind.", &format!("Wind. {}", "word ".repeat(MAX_BODY_CHARS / 5)));
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("字预算"), "{err}");
        assert!(length_advice(&bad).contains("Cut at least"), "{}", length_advice(&bad));
    }

    #[test]
    fn length_advice_is_silent_within_budget() {
        assert!(length_advice(OK).is_empty());
    }

    #[test]
    fn catches_voiceover_without_closed_lips() {
        // 压缩时最容易掉的正是这句（2026-10-28 实测被前端拦下）
        let bad = OK.replace(" while her lips remain completely closed.", "");
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("闭唇句"), "{err}");
        assert!(repair_hint(&bad).contains("closed-lips clause"), "{}", repair_hint(&bad));
    }

    #[test]
    fn catches_dialogue_without_speaker_id() {
        let bad = OK.replace(" (S1) says", " says");
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("说话人编号"), "{err}");
    }

    #[test]
    fn catches_summary_without_task_tag() {
        let bad = OK.replace("[reference generation] [Shot 1] follows", "[Shot 1] follows")
            .replace("summary:\n[Shot 1]", "summary:\nShot 1");
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("任务类型"), "{err}");
    }

    #[test]
    fn accepts_empty_shot_voiceover_with_no_person() {
        let ok = OK.replace(
            "<Subject 1> (S1) says in an off-screen voiceover: <d>[Chinese] 回去。</d> while her lips remain completely closed.",
            "There is no person in this shot, so no one can open a mouth. <Subject 1> (S1) says in an off-screen voiceover: <d>[Chinese] 回去。</d>",
        );
        assert_ne!(ok, OK);
        assert!(validate_prompt_shape(&ok).is_ok(), "{:?}", validate_prompt_shape(&ok));
    }

    #[test]
    fn catches_audio_tag() {
        let bad = OK.replace("<Subject 1> is her.", "<Audio 1> is the narrator voice.");
        assert_ne!(bad, OK);
        let err = validate_prompt_shape(&bad).unwrap_err();
        assert!(err.contains("音频条目"), "{err}");
    }
}
