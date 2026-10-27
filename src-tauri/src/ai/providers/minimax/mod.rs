use base64::Engine;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

// ── MiniMax H3 via 优云智算 compshare 直连 ──
// 走 compshare（UCloud，境内）原生通道 cp.compshare.cn/minimax，
// 复用 COMPSHARE_VIDEO_KEY（经自有服务器配置下发），不经百度 VOD、不碰阿里云。
const BASE_URL: &str = "https://cp.compshare.cn/minimax";
const CREATE_PATH: &str = "/v2/video_generation";
const QUERY_PATH: &str = "/v2/query/video_generation";
const POLL_INTERVAL_MS: u64 = 10000;
/// H3 是 v2 唯一模型，API 请求体里的 model 固定为此字符串。
const API_MODEL: &str = "MiniMax-H3";

/// 官方正文的固定段名（六段）。
const PROMPT_SECTIONS: &[&str] = &[
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
];

/// 规则头里那句「只有参考图这一种入参」。带了参考音频时它就不再成立，
/// 留着会让模型收到一个「不该存在」的音频资产 —— 只用中文原句做定位，替换成如实说法。
const RULE_IMAGE_ONLY_CLAUSE: &str = "本任务只有参考图这一种入参，声音全部来自正文描述";
const RULE_WITH_AUDIO_CLAUSE: &str =
    "本任务入参包含参考图与参考音频（参考音频只作声线参照，不复现其原声），声线由参考音频提供、台词与其余声音仍写在正文里";

/// 一段参考音频：DataURL + 可选的角色名（这段声音属于谁）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReferenceAudio {
    url: String,
    character: Option<String>,
}

/// 旁白 / 画外音不是画面里的某个角色，这些写法统一按官方 §4.4 的 `off-screen voiceover` 措辞处理。
const NARRATOR_ALIASES: &[&str] = &[
    "旁白",
    "画外音",
    "旁白（画外音）",
    "旁白(画外音)",
    "narrator",
    "narrator (voiceover)",
    "narration",
    "voiceover",
    "voice-over",
    "off-screen narrator",
    "off-screen voiceover",
];

/// 把前端填的「这段声音属于谁」转成提示词里的说法：
/// - 角色名 → 原名
/// - 旁白 / 画外音 → `off-screen voiceover`（官方用词）
fn character_phrase(character: Option<&str>) -> Option<String> {
    let name = character?.trim();
    if name.is_empty() {
        return None;
    }
    let lower = name.to_lowercase();
    if NARRATOR_ALIASES.iter().any(|alias| lower == alias.to_lowercase()) {
        return Some("off-screen voiceover".to_string());
    }
    Some(name.to_string())
}

/// 生成 `Voice timbre follows reference audio N.` / `… N. (角色名)`。
/// ⚠️ 已不再使用：官方正文结构要求以 `<Audio N>` 声明 + `reference` 标记，见 `apply_audio_reference`。
#[allow(dead_code)]
fn audio_prompt_hint(index: usize, character: Option<&str>) -> String {
    match character_phrase(character) {
        Some(name) => format!("{} {}. ({})", "Voice timbre follows reference audio", index + 1, name),
        None => format!("{} {}.", "Voice timbre follows reference audio", index + 1),
    }
}

// ── 参考音频在正文里的官方写法（§2.4 / §4.2 / §5.4）──────────────────────────
//
// 官方 §2.4：`<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.`
// 官方 §4.2：`<Audio 2>: reference - the target speaker follows <Audio 2>'s voice timbre … without copying the original signal.`
// 官方 §5.4：`When only timbre … is referenced, do not carry the original dialogue from the reference audio into the target video.`
// 官方 §5.4 示例：`using the clear youthful voice timbre referenced from <Audio 1>, exclaims …`
//
// 三处缺一不可：只把音频塞进 content[] 而不标 `reference`，模型会把参考音频当成要复现的信号，
// 成片前段就会冒出原声里听不懂的人声。

fn is_section_header(line: &str) -> bool {
    PROMPT_SECTIONS.contains(&line.trim())
}

/// 目标视频里唯一的说话人编号（`(S1)`）。官方要求 `<Audio N>` 声明复用该编号；
/// 出现多个编号时无法确定归属，按官方「stable voice description」写法省略编号。
fn detect_single_speaker_id(prompt: &str) -> Option<String> {
    let bytes = prompt.as_bytes();
    let mut ids: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i] == b'(' && bytes[i + 1] == b'S' && bytes[i + 2].is_ascii_digit() {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b')' {
                if let Ok(id) = std::str::from_utf8(&bytes[i..=j]) {
                    if !ids.iter().any(|existing| existing == id) {
                        ids.push(id.to_string());
                    }
                }
                i = j;
            }
        }
        i += 1;
    }
    if ids.len() == 1 {
        ids.pop()
    } else {
        None
    }
}

/// 在正文里按名字找它对应的 `<Subject N>` 标签（用于把音频绑到某个角色）。
fn find_subject_label(prompt: &str, name: &str) -> Option<String> {
    for line in prompt.lines() {
        if !line.contains(name) {
            continue;
        }
        let start = line.find("<Subject ")?;
        let rest = &line[start..];
        let end = rest.find('>')?;
        return Some(rest[..=end].to_string());
    }
    None
}

/// 「这段声音属于谁」→ 官方口径里的说话人描述。
/// - 旁白 / 画外音 → `the off-screen narrator`
/// - 角色名 → 能对上 `<Subject N>` 就用标签，否则用稳定描述 `the character named X`
/// - 未绑定 → `the target speaker`（官方 §4.2 原文用词）
fn speaker_description(prompt: &str, character: Option<&str>) -> String {
    match character_phrase(character) {
        None => "the target speaker".to_string(),
        Some(phrase) if phrase == "off-screen voiceover" => "the off-screen narrator".to_string(),
        Some(name) => find_subject_label(prompt, &name)
            .unwrap_or_else(|| format!("the character named {}", name)),
    }
}

/// 把若干行插到某个段的最后一条内容之后（段之间以空行分隔）。
fn insert_after_section(lines: &mut Vec<String>, header: &str, new_lines: &[String]) -> bool {
    let Some(start) = lines.iter().position(|line| line.trim() == header) else {
        return false;
    };
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| is_section_header(line))
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    let mut insert_at = start + 1;
    for index in start + 1..end {
        if !lines[index].trim().is_empty() {
            insert_at = index + 1;
        }
    }
    for (offset, line) in new_lines.iter().enumerate() {
        lines.insert(insert_at + offset, line.clone());
    }
    true
}

/// `summary` 的任务类型加 `+ audio reference`（官方 §5.4 示例：`[reference generation + audio reference]`）。
fn add_audio_reference_marker(lines: &mut Vec<String>) -> bool {
    let Some(start) = lines.iter().position(|line| line.trim() == "summary:") else {
        return false;
    };
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| is_section_header(line))
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    for index in start + 1..end {
        let trimmed = lines[index].trim();
        if !trimmed.starts_with('[') {
            continue;
        }
        let Some(close) = trimmed.find(']') else {
            continue;
        };
        let inside = trimmed[1..close].trim();
        if inside.contains("audio reference") {
            return true;
        }
        let rest = &trimmed[close + 1..];
        lines[index] = format!("[{} + audio reference]{}", inside, rest);
        return true;
    }
    false
}

/// 正文人声句内联引用 `<Audio N>`（官方 §7 范例的写法：声线从句放在触发动词**之前**）。
///
/// 官方 §7 逐字：`<Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre
/// referenced from <Audio 1>, exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d>`
/// —— 引用是句中的一个逗号从句，触发动词与语气紧贴 `<d>`。
/// 🔴 引用**不能**塞在触发句后面：`says in an off-screen voiceover, using the …` 会让触发字面量
/// 与 `<d>` 之间多出一截，模型认不出画外音模式，仍会自己配一段人声。
/// 只在「唯一一段参考音频」时做，避免多段时张冠李戴。
fn cite_audio_inline(lines: &mut [String]) {
    const CLAUSE: &str = "using the voice timbre referenced from <Audio 1>";
    let mut in_detailed = false;
    for line in lines.iter_mut() {
        if is_section_header(line) {
            in_detailed = line.trim() == "detailed_description:";
            continue;
        }
        if !in_detailed {
            continue;
        }
        for trigger in [
            "says in an off-screen voiceover",
            "says in an off-screen voice-over",
        ] {
            let Some(pos) = line.find(trigger) else {
                continue;
            };
            // 从句前面已经有逗号/顿号的（如 `and, says …`）先摘掉，统一由这里补一个
            let head = line[..pos].trim_end();
            let head = head.strip_suffix(',').or_else(|| head.strip_suffix('，')).unwrap_or(head);
            let head = head.trim_end();
            *line = format!("{}, {}, {}", head, CLAUSE, &line[pos..]);
        }
    }
}

/// 画内说话那一路没有 `says in an off-screen voiceover` 触发句可用，
/// 但官方 §7 范例的声线从句仍要在正文里落一次（否则整段正文没有任何一处引用 `<Audio 1>`，
/// `subject_definitions` 里的声线声明就悬空）。落点是说话人标签之后：
/// `<Subject 1> (S1), using the voice timbre referenced from <Audio 1>, says, <d>…</d>`
fn cite_audio_inline_on_screen(lines: &mut [String]) {
    const CLAUSE: &str = "using the voice timbre referenced from <Audio 1>";
    let mut in_detailed = false;
    for line in lines.iter_mut() {
        if is_section_header(line) {
            in_detailed = line.trim() == "detailed_description:";
            continue;
        }
        if !in_detailed || !line.contains("<d>") {
            continue;
        }
        // 说话人标签形如 `(S1)` —— 从句跟在它后面，动词与台词仍然紧邻
        let bytes = line.as_bytes();
        let Some(mut i) = line.find("(S") else {
            continue;
        };
        let mut end = i + 2;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end >= bytes.len() || bytes[end] != b')' {
            // 不是编号，往后找一个真正的 `(Sx)`
            let Some(next) = line[end..].find("(S") else {
                continue;
            };
            i = end + next;
            end = i + 2;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end >= bytes.len() || bytes[end] != b')' {
                continue;
            }
        }
        let insert_at = end + 1;
        *line = format!("{}, {},{}", &line[..insert_at], CLAUSE, &line[insert_at..]);
        return;
    }
}

/// 正文里是否已经有 `<Audio 1>` 的引用（有就不再补画内引用，避免同一段引两次）。
fn detailed_cites_audio(lines: &[String]) -> bool {
    let mut in_detailed = false;
    for line in lines {
        if is_section_header(line) {
            in_detailed = line.trim() == "detailed_description:";
            continue;
        }
        if in_detailed && line.contains("<Audio 1>") {
            return true;
        }
    }
    false
}

/// 把参考音频按官方正文结构写进提示词；没有参考音频时原样返回。
fn apply_audio_reference(prompt: &str, voices: &[ReferenceAudio]) -> String {
    if voices.is_empty() {
        return prompt.to_string();
    }

    // 全部基于**原始**提示词推导（后面的行插改不影响判定）
    let speaker_id = detect_single_speaker_id(prompt);
    let id_suffix = speaker_id.map(|id| format!(" {}", id)).unwrap_or_default();

    let mut definitions: Vec<String> = Vec::new();
    let mut retention: Vec<String> = Vec::new();
    for (index, voice) in voices.iter().enumerate() {
        let n = index + 1;
        let who = speaker_description(prompt, voice.character.as_deref());
        definitions.push(format!(
            "<Audio {}> is the voice-timbre reference for {}{}, containing a spoken vocal layer.",
            n, who, id_suffix
        ));
        retention.push(format!(
            "<Audio {}>: reference - its vocal timbre guides the delivery of {} without copying the original signal.",
            n, who
        ));
    }

    // 规则头那句「只有参考图这一种入参」在有音频时替换成如实说法
    let text = prompt.replace(RULE_IMAGE_ONLY_CLAUSE, RULE_WITH_AUDIO_CLAUSE);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();

    let defs_inserted = insert_after_section(&mut lines, "subject_definitions:", &definitions);
    let retention_inserted = insert_after_section(&mut lines, "retention_analysis:", &retention);
    add_audio_reference_marker(&mut lines);
    if voices.len() == 1 {
        cite_audio_inline(&mut lines);
        // 画内说话（没有画外音触发句）时补一次声线从句，保证正文里真的引用了 `<Audio 1>`
        if !detailed_cites_audio(&lines) {
            cite_audio_inline_on_screen(&mut lines);
        }
    }

    // 段名缺失（非常规脚本）时退化为追加，绝不让音频没有声明
    if !defs_inserted {
        lines.push(String::new());
        lines.extend(definitions.iter().cloned());
    }
    if !retention_inserted {
        lines.extend(retention.iter().cloned());
    }

    lines.join("\n")
}

// ── 创建响应：{"task_id": "tsk-xxxx"}（snake_case）──
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxCreateResponse {
    task_id: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

// ── 查询响应：可能被包在 task 对象里，也可能平铺 ──
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxQueryResponse {
    task: Option<MinimaxTask>,
    status: Option<String>,
    content: Option<MinimaxContent>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxTask {
    status: Option<String>,
    content: Option<MinimaxContent>,
    #[serde(rename = "videoUrl")]
    video_url: Option<String>,
    /// 失败时 compshare 在 task.error 里给出 {code, message}
    error: Option<MinimaxError>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxError {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct MinimaxContent {
    url: Option<String>,
    #[serde(rename = "videoUrl")]
    video_url: Option<String>,
}

pub struct MiniMaxProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
}

impl MiniMaxProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(2000))
                .connect_timeout(Duration::from_secs(30))
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

    /// compshare H3 只接受 480P/768P/1080P/2K/4K（区分大小写，无 720P）。
    /// 上游 banana_api 写入的 key 是 quality（小写 "720p"），
    /// 这里统一归一化：720P/720p → 768P（H3 最低档，积分档位仍按原 720P 计、不变），
    /// 其余不受支持的值一律回落 768P。
    fn normalize_resolution(raw: Option<&str>) -> String {
        const ALLOWED: [&str; 5] = ["480P", "768P", "1080P", "2K", "4K"];
        let q = raw.unwrap_or("").trim();
        if q.eq_ignore_ascii_case("720p") {
            return "768P".to_string();
        }
        let up = q.to_uppercase();
        if ALLOWED.contains(&up.as_str()) {
            up
        } else {
            "768P".to_string()
        }
    }

    /// compshare H3 画幅白名单。
    fn normalize_ratio(raw: Option<&str>) -> String {
        const ALLOWED: [&str; 7] = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
        let r = raw.unwrap_or("").trim();
        if ALLOWED.contains(&r) {
            r.to_string()
        } else {
            "adaptive".to_string()
        }
    }

    /// compshare H3 duration 区间 4–30 秒。
    fn normalize_duration(raw: Option<u64>) -> u32 {
        raw.unwrap_or(5).clamp(4, 30) as u32
    }

    fn query_status(resp: &MinimaxQueryResponse) -> String {
        resp.task
            .as_ref()
            .and_then(|t| t.status.as_deref())
            .or(resp.status.as_deref())
            .unwrap_or("")
            .to_uppercase()
    }

    fn extract_video_url(resp: &MinimaxQueryResponse) -> Option<String> {
        let task = resp.task.as_ref();
        // 1. task.content.url
        if let Some(u) = task
            .and_then(|t| t.content.as_ref())
            .and_then(|c| c.url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 2. task.content.videoUrl
        if let Some(u) = task
            .and_then(|t| t.content.as_ref())
            .and_then(|c| c.video_url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 3. task.videoUrl
        if let Some(u) = task
            .and_then(|t| t.video_url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 4. 平铺 content.url
        if let Some(u) = resp
            .content
            .as_ref()
            .and_then(|c| c.url.as_ref())
            .filter(|u| !u.is_empty())
        {
            return Some(u.clone());
        }
        // 5. 平铺 content.videoUrl
        resp.content
            .as_ref()
            .and_then(|c| c.video_url.as_ref())
            .filter(|u| !u.is_empty())
            .map(|u| u.clone())
    }

    /// 检测 MiniMax/compshare 以 HTTP 200 返回的错误体 {"type":"error",...}，
    /// 提取最内层 error.message（可能是嵌套 JSON 字符串）。
    fn extract_error_body(raw: &str) -> Option<String> {
        let val: Value = serde_json::from_str(raw).ok()?;
        if val.get("type").and_then(|t| t.as_str()) != Some("error") {
            return None;
        }
        let msg: String = val
            .pointer("/error/message")
            .and_then(|m| m.as_str())
            .map(|s| {
                // message 可能是嵌套 JSON 字符串，再剥一层取真正的错误信息
                match serde_json::from_str::<Value>(s) {
                    Ok(nested) => nested
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or(s)
                        .to_string(),
                    Err(_) => s.to_string(),
                }
            })
            .unwrap_or_else(|| "MiniMax H3 未知错误".to_string());
        Some(msg)
    }

    /// H3 参考图单边上限 5760。6 宫格故事板合成图常为 6912x8192，超限会被拒。
    /// 这里把 base64 参考图等比缩放到长边 <= max_side（JPEG q85 重编码，控制体积）。
    fn downscale_base64_image(data_url: &str, max_side: u32) -> Option<String> {
        let b64 = data_url.strip_prefix("data:")?.split_once(";base64,")?.1;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
        let img = image::load_from_memory(&bytes).ok()?;
        let (w, h) = (img.width(), img.height());
        if w <= max_side && h <= max_side {
            return Some(data_url.to_string());
        }
        let scale = (max_side as f64) / (w.max(h) as f64);
        let nw = ((w as f64) * scale).round().max(1.0) as u32;
        let nh = ((h as f64) * scale).round().max(1.0) as u32;
        let resized = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
        let rgb = resized.to_rgb8();
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
        enc.encode_image(&rgb).ok()?;
        let new_b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
        Some(format!("data:image/jpeg;base64,{}", new_b64))
    }

    /// H3 用 content[] 结构：text + image_url（role=reference_image）+ audio_url（role=reference_audio）。
    /// 参考图走 base64 直传（compshare 直连，经自有服务器下发 key，图片不落第三方）。
    /// compshare 限制参考图 ≤9 张，超出直接截断，避免整单被拒。
    fn build_content(
        prompt: &str,
        reference_images: &[String],
        reference_audio: &[ReferenceAudio],
    ) -> Vec<Value> {
        const MAX_REF_IMAGES: usize = 9;
        let mut content: Vec<Value> = vec![json!({
            "type": "text",
            "text": prompt,
        })];
        for ref_img in reference_images.iter().take(MAX_REF_IMAGES) {
            if ref_img.starts_with("data:") {
                // base64 参考图：单边上限 5760，超限先等比缩放
                let url = Self::downscale_base64_image(ref_img, 5760)
                    .unwrap_or_else(|| ref_img.clone());
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": url },
                    "role": "reference_image",
                }));
            } else if ref_img.starts_with("http://") || ref_img.starts_with("https://") {
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": ref_img },
                    "role": "reference_image",
                }));
            }
            // 非法 url 直接丢弃
        }
        // 音色参考（官方 r2va）：`{"type":"audio_url","audio_url":{"url":…},"role":"reference_audio"}`。
        // 最多 3 段（官方上限、单段 2–15s、合计 ≤15s、≤15MB），规格已在提交前本地校验过；
        // 顺序即提示词里的 `reference audio N` 序号。
        for audio in reference_audio {
            content.push(json!({
                "type": "audio_url",
                "audio_url": { "url": audio.url },
                "role": "reference_audio",
            }));
        }
        content
    }

    async fn create_task(
        &self,
        api_key: &str,
        request: &GenerateRequest,
    ) -> Result<String, AIError> {
        let duration = Self::normalize_duration(
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("duration_seconds"))
                .and_then(|raw| raw.as_u64()),
        );

        let resolution = Self::normalize_resolution(
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("quality"))
                .and_then(|raw| raw.as_str()),
        );

        let ratio = Self::normalize_ratio(Some(request.aspect_ratio.as_str()));

        // 音色参考：提交侧已按官方规格校验（WAV/MP3、≤15MB、单段 2–15s、≤3 段、合计 ≤15s），
        // 这里只负责放进 content[] + 在正文里点明「第 N 段是谁的声音」。
        let reference_audio: Vec<ReferenceAudio> = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("reference_voices"))
            .and_then(|raw| raw.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let url = item.get("url").and_then(|v| v.as_str())?.to_string();
                        if url.is_empty() {
                            return None;
                        }
                        let character = item
                            .get("character")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|name| !name.is_empty())
                            .map(|name| name.to_string());
                        Some(ReferenceAudio { url, character })
                    })
                    .collect()
            })
            .unwrap_or_default();

        // 参考音频按官方正文结构写进去（`<Audio N>` 声明 + `reference` 标记 + 内联引用）。
        // 🔴 只塞 content[] 而不标 `reference`，模型会把原声当成要复现的信号 —— 成片前段会冒听不懂的人声。
        let prompt = apply_audio_reference(&request.prompt, &reference_audio);

        let audio_count = reference_audio.len();
        let content = Self::build_content(
            &prompt,
            request.reference_images.as_deref().unwrap_or(&[]),
            &reference_audio,
        );
        let refs = content.iter().filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("image_url")).count();

        let body = json!({
            "model": API_MODEL,
            "content": content,
            "resolution": resolution,
            "duration": duration,
            "ratio": ratio,
            "use_context_ir": false,
            "aigc_watermark": false,
        });

        let endpoint = format!("{}{}", BASE_URL, CREATE_PATH);

        // compshare 请求体上限 72MiB（参考图 base64 占比最大），超限直接给出可读错误，
        // 避免把整包发出去换来一个语焉不详的 4xx。
        const MAX_BODY_BYTES: usize = 72 * 1024 * 1024;
        let body_bytes = serde_json::to_vec(&body).map(|v| v.len()).unwrap_or(0);
        if body_bytes > MAX_BODY_BYTES {
            return Err(AIError::InvalidRequest(format!(
                "参考图体积过大（{} MiB，上限 {} MiB），请减少参考图数量或尺寸",
                body_bytes / (1024 * 1024),
                MAX_BODY_BYTES / (1024 * 1024)
            )));
        }

        info!(
            "[MiniMax H3 createTask] url={}, model={}, duration={}, resolution={}, ratio={}, refs={}, audio={}, promptLen={}, bodyMiB={}",
            endpoint, API_MODEL, duration, resolution, ratio,
            refs, audio_count, prompt.chars().count(),
            body_bytes / (1024 * 1024)
        );
        // 参考音频实际进 content[] 的核对行：只打序号 / 字节数 / 角色，不打 base64 内容。
        if audio_count > 0 {
            let detail: Vec<String> = content
                .iter()
                .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("audio_url"))
                .enumerate()
                .map(|(index, item)| {
                    let len = item
                        .get("audio_url")
                        .and_then(|a| a.get("url"))
                        .and_then(|u| u.as_str())
                        .map(|u| u.len())
                        .unwrap_or(0);
                    let character = reference_audio
                        .get(index)
                        .and_then(|v| v.character.as_deref())
                        .unwrap_or("-");
                    format!("#{} {}KB 角色={}", index + 1, len / 1024, character)
                })
                .collect();
            info!("[MiniMax H3 createTask] audio content: {}", detail.join(", "));
        }
        info!("[MiniMax H3 createTask] FULL PROMPT:\n{}", prompt);

        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let raw = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "MiniMax H3 createTask failed {}: {}",
                status, raw
            )));
        }

        info!("[MiniMax H3 createTask] raw response: {}", raw);
        let resp: MinimaxCreateResponse = serde_json::from_str(&raw).map_err(|err| {
            AIError::Provider(format!("MiniMax H3 create invalid JSON: {}; raw={}", err, raw))
        })?;

        if let Some(code) = &resp.code {
            let msg = resp.message.as_deref().unwrap_or("unknown");
            if code != "0" && code != "Success" {
                return Err(AIError::Provider(format!(
                    "MiniMax H3 create API error [{}]: {}",
                    code, msg
                )));
            }
        }

        resp.task_id
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AIError::Provider(format!("MiniMax H3 create missing task_id. raw={}", raw)))
    }

    async fn poll_task_once(
        &self,
        api_key: &str,
        task_id: &str,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let endpoint = format!("{}{}/{}", BASE_URL, QUERY_PATH, task_id);
        // ⚠️ 绝不打密钥本身（多 KEY 池之后每 3 秒一次轮询会把密钥写满日志）。
        // 只打「用哪个 KEY」的指纹前缀，够定位、不可逆。
        info!(
            "[MiniMax H3 Poll] url={}, key_fp={}",
            endpoint,
            &crate::commands::video_key_pool::fingerprint(api_key)[..8]
        );

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?;

        let status = response.status();
        let raw = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(AIError::Provider(format!(
                "MiniMax H3 query failed {}: {}",
                status, raw
            )));
        }

        info!("[MiniMax H3 Poll] raw response: {}", raw);

        // compshare 可能以 HTTP 200 返回错误体 {"type":"error",...}（如参数非法），
        // 视为任务失败（终态），避免前端无限轮询卡死。
        if let Some(err_msg) = Self::extract_error_body(&raw) {
            info!("[MiniMax H3] task {} FAILED (error body): {}", task_id, err_msg);
            return Ok(ProviderTaskPollResult::Failed(err_msg));
        }

        let resp: MinimaxQueryResponse = serde_json::from_str(&raw).map_err(|err| {
            AIError::Provider(format!("MiniMax H3 query invalid JSON: {}; raw={}", err, raw))
        })?;

        if let Some(code) = &resp.code {
            let msg = resp.message.as_deref().unwrap_or("unknown");
            if code != "0" && code != "Success" {
                return Err(AIError::Provider(format!(
                    "MiniMax H3 query API error [{}]: {}",
                    code, msg
                )));
            }
        }

        // 只要拿到视频 URL 就视为成功（可能早于 status 翻转为 succeeded）
        if let Some(url) = Self::extract_video_url(&resp) {
            info!("[MiniMax H3] task {} succeeded: {}", task_id, url);
            return Ok(ProviderTaskPollResult::Succeeded(url));
        }

        let task_status = Self::query_status(&resp);
        match task_status.as_str() {
            "SUCCEEDED" | "COMPLETED" | "SUCCESS" => {
                // status 已成功但还没 URL，继续轮询
                info!("[MiniMax H3] task {} status={} but no URL yet, keep polling", task_id, task_status);
                Ok(ProviderTaskPollResult::Running)
            }
            "FAILED" | "ERROR" | "CANCELLED" => {
                // compshare 把失败原因放在 task.error.message，取不到再退顶层 message
                let msg = resp
                    .task
                    .as_ref()
                    .and_then(|t| t.error.as_ref())
                    .and_then(|e| e.message.as_deref())
                    .filter(|m| !m.is_empty())
                    .map(|m| m.to_string())
                    .or_else(|| resp.message.clone().filter(|m| !m.is_empty()))
                    .unwrap_or_else(|| "生成失败".to_string());
                info!("[MiniMax H3] task {} FAILED: {}", task_id, msg);
                Ok(ProviderTaskPollResult::Failed(msg))
            }
            // queued / pending / waiting → 排队中，前端展示「排队中」提示
            "QUEUED" | "PENDING" | "WAITING" => {
                Ok(ProviderTaskPollResult::Queued)
            }
            // processing / running 等 → 生成中
            _ => Ok(ProviderTaskPollResult::Running),
        }
    }
}

impl Default for MiniMaxProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for MiniMaxProvider {
    fn name(&self) -> &str {
        "minimax"
    }

    fn supports_model(&self, model: &str) -> bool {
        Self::sanitize_model(model) == "minimax-h3"
    }

    fn list_models(&self) -> Vec<String> {
        vec!["minimax/minimax-h3".to_string()]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("MiniMax H3 API key not set".to_string()))?;

        let task_id = self.create_task(&api_key, &request).await?;

        loop {
            match self.poll_task_once(&api_key, &task_id).await? {
                ProviderTaskPollResult::Queued | ProviderTaskPollResult::Running => {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await
                }
                ProviderTaskPollResult::Succeeded(url) => return Ok(url),
                ProviderTaskPollResult::Failed(message) => {
                    return Err(AIError::TaskFailed(message))
                }
            }
        }
    }

    async fn submit_task(
        &self,
        request: GenerateRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("MiniMax H3 API key not set".to_string()))?;

        let task_id = self.create_task(&api_key, &request).await?;

        // 通道固定为 compshare 直连，api_key 存入 metadata 用于跨会话续传
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id,
            metadata: Some(serde_json::json!({
                "backend": "compshare",
                "api_key": api_key,
                "api_model": API_MODEL,
            })),
        }))
    }

    async fn poll_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let api_key = handle
            .metadata
            .as_ref()
            .and_then(|m| m.get("api_key")?.as_str().map(|s| s.to_string()))
            .or_else(|| {
                self.api_key
                    .try_read()
                    .ok()
                    .and_then(|guard| guard.clone())
            })
            .ok_or_else(|| {
                AIError::InvalidRequest(
                    "MiniMax H3 API key not set (not in metadata or provider)".to_string(),
                )
            })?;

        self.poll_task_once(&api_key, &handle.task_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 官方 r2va 形态：text + reference_image + `audio_url/role=reference_audio`。
    #[test]
    fn build_content_appends_reference_audio() {
        let images = vec!["https://example.com/a.png".to_string()];
        let voices = vec![ReferenceAudio {
            url: "data:audio/mpeg;base64,AAA".to_string(),
            character: None,
        }];
        let content = MiniMaxProvider::build_content("prompt", &images, &voices);

        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["role"], "reference_image");

        let audio = content.last().expect("audio item");
        assert_eq!(audio["type"], "audio_url");
        assert_eq!(audio["role"], "reference_audio");
        assert_eq!(audio["audio_url"]["url"], "data:audio/mpeg;base64,AAA");
    }

    /// 多段音色参考：按提交顺序逐段追加，顺序即提示词里的序号。
    #[test]
    fn build_content_keeps_audio_order() {
        let voices = vec![
            ReferenceAudio {
                url: "data:audio/wav;base64,AAA".to_string(),
                character: Some("张小曼".to_string()),
            },
            ReferenceAudio {
                url: "data:audio/wav;base64,BBB".to_string(),
                character: None,
            },
        ];
        let content = MiniMaxProvider::build_content("prompt", &[], &voices);
        let audios: Vec<&Value> = content
            .iter()
            .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("audio_url"))
            .collect();
        assert_eq!(audios.len(), 2);
        assert_eq!(audios[0]["audio_url"]["url"], "data:audio/wav;base64,AAA");
        assert_eq!(audios[1]["audio_url"]["url"], "data:audio/wav;base64,BBB");
        assert!(audios.iter().all(|a| a["role"] == "reference_audio"));
    }

    /// 一份最小的六段正文，用来检查参考音频的官方写法落到哪几处。
    fn sample_prompt() -> String {
        [
            "【声音】本任务只有参考图这一种入参，声音全部来自正文描述。",
            "",
            "subject_definitions:",
            "<Subject 1> 是 <Picture 1> 里的河岸场景。",
            "<Subject 2> 是 <Picture 2> 里的年轻女子。",
            "",
            "summary:",
            "[reference generation] 目标视频是一段两镜片段。",
            "",
            "retention_analysis:",
            "<Subject 1> (appears in [Shot 1]): fully_preserved - 芦苇与水面保持原样。",
            "",
            "detailed_description:",
            "[Shot 1] 中远景。<Subject 2> (S1) says in an off-screen voiceover: <d>[Chinese] 溯洄从之。</d> Her lips remain completely closed.",
            "",
            "overall_soundscape:",
            "风穿过芦苇。",
            "",
            "non_diegetic_music:",
            "古琴与箫。",
        ]
        .join("\n")
    }

    /// 参考音频必须按官方 §2.4 / §4.2 / §5.4 落在四处：
    /// subject_definitions 声明、summary 任务类型、retention_analysis 的 reference 标记、正文内联引用。
    #[test]
    fn audio_reference_injects_official_declarations() {
        let voices = vec![ReferenceAudio {
            url: "data:audio/wav;base64,AAA".to_string(),
            character: Some("旁白（画外音）".to_string()),
        }];
        let out = apply_audio_reference(&sample_prompt(), &voices);

        assert!(
            out.contains("<Audio 1> is the voice-timbre reference for the off-screen narrator (S1), containing a spoken vocal layer."),
            "missing subject_definitions declaration:\n{out}"
        );
        assert!(
            out.contains("[reference generation + audio reference]"),
            "missing summary task-type marker:\n{out}"
        );
        assert!(
            out.contains("<Audio 1>: reference - its vocal timbre guides the delivery of the off-screen narrator without copying the original signal."),
            "missing retention_analysis reference marker:\n{out}"
        );
        // 官方 §7 范例的语序：声线从句在触发动词之前，触发句紧贴 `<d>`
        assert!(
            out.contains("using the voice timbre referenced from <Audio 1>, says in an off-screen voiceover: <d>"),
            "missing inline citation:\n{out}"
        );
        assert!(
            !out.contains("off-screen voiceover, using the voice timbre"),
            "citation must not sit between the trigger and <d>:\n{out}"
        );
        // 规则头里「只有参考图这一种入参」必须被替换掉
        assert!(!out.contains("只有参考图这一种入参"), "stale rule header:\n{out}");
    }

    /// 画内说话（没有画外音触发句）也要在正文里落一次 `<Audio 1>` 声线从句，
    /// 语序照官方 §7：从句跟在说话人标签后，动词与台词仍然紧邻。
    #[test]
    fn audio_reference_cites_on_screen_speaker() {
        let prompt = [
            "subject_definitions:",
            "<Subject 1> is the young woman in <Picture 1>.",
            "",
            "summary:",
            "[reference generation] The target video is a single-shot fragment.",
            "",
            "retention_analysis:",
            "<Subject 1> (appears in [Shot 1]): fully_preserved - appearance unchanged.",
            "",
            "detailed_description:",
            "[Shot 1] A medium shot. <Subject 1> (S1) turns toward the window and says, <d>[Chinese] 你先回去。</d>, her mouth movements naturally syncing to the new dialogue.",
            "",
            "overall_soundscape:",
            "Low air-conditioning hum continues throughout the shot.",
            "",
            "non_diegetic_music:",
            "N/A",
        ]
        .join("\n");
        let voices = vec![ReferenceAudio {
            url: "data:audio/wav;base64,AAA".to_string(),
            character: Some("女主".to_string()),
        }];
        let out = apply_audio_reference(&prompt, &voices);
        assert!(
            out.contains("<Subject 1> (S1), using the voice timbre referenced from <Audio 1>, turns toward the window and says, <d>"),
            "missing on-screen citation:\n{out}"
        );
        // 画内台词的官方口型串必须原样保留（2026-10-28 定调 A：改用官方英文串）
        assert!(
            out.contains("her mouth movements naturally syncing to the new dialogue"),
            "mouth clause lost:\n{out}"
        );
    }

    /// 声明要落在各自段内，而不是全堆到文末。
    #[test]
    fn audio_reference_inserts_inside_sections() {
        let voices = vec![ReferenceAudio {
            url: "data:audio/wav;base64,AAA".to_string(),
            character: None,
        }];
        let out = apply_audio_reference(&sample_prompt(), &voices);
        let lines: Vec<&str> = out.lines().collect();

        let def_index = lines
            .iter()
            .position(|l| l.starts_with("<Audio 1> is the voice-timbre reference"))
            .expect("definition line");
        let summary_index = lines.iter().position(|l| l.trim() == "summary:").expect("summary");
        assert!(def_index < summary_index, "definition must sit in subject_definitions");

        let retention_index = lines
            .iter()
            .position(|l| l.starts_with("<Audio 1>: reference"))
            .expect("retention line");
        let detailed_index = lines
            .iter()
            .position(|l| l.trim() == "detailed_description:")
            .expect("detailed");
        assert!(retention_index < detailed_index, "retention line must sit before detailed_description");
        // 未绑定角色 → 官方 §4.2 用词 `the target speaker`
        assert!(out.contains("the target speaker"), "{out}");
    }

    /// 多个说话人编号时无法确定归属，声明里不硬写 (Sx)。
    #[test]
    fn audio_reference_omits_speaker_id_when_ambiguous() {
        let mut prompt = sample_prompt();
        prompt.push_str("\n[Shot 2] <Subject 1> (S2) 回话。");
        let voices = vec![ReferenceAudio {
            url: "data:audio/wav;base64,AAA".to_string(),
            character: Some("旁白".to_string()),
        }];
        let out = apply_audio_reference(&prompt, &voices);
        assert!(
            out.contains("<Audio 1> is the voice-timbre reference for the off-screen narrator, containing a spoken vocal layer."),
            "{out}"
        );
    }

    /// 角色名能对上 <Subject N> 时用标签，不另造说法。
    #[test]
    fn audio_reference_resolves_character_subject_label() {
        let voices = vec![ReferenceAudio {
            url: "data:audio/wav;base64,AAA".to_string(),
            character: Some("张小曼".to_string()),
        }];
        let mut prompt = sample_prompt();
        prompt = prompt.replace("年轻女子。", "年轻女子张小曼。");
        let out = apply_audio_reference(&prompt, &voices);
        assert!(
            out.contains("<Audio 1> is the voice-timbre reference for <Subject 2> (S1)"),
            "{out}"
        );
    }

    /// 没有参考音频时，提示词一个字都不改。
    #[test]
    fn audio_reference_leaves_prompt_untouched_without_audio() {
        let prompt = sample_prompt();
        assert_eq!(apply_audio_reference(&prompt, &[]), prompt);
    }

    /// 没有音色参考时，content 里不得凭空出现 audio_url。
    #[test]
    fn build_content_without_audio_has_no_audio_item() {
        let content = MiniMaxProvider::build_content("prompt", &[], &[]);
        assert_eq!(content.len(), 1);
        assert!(content
            .iter()
            .all(|c| c.get("type").and_then(|t| t.as_str()) != Some("audio_url")));
    }
}
