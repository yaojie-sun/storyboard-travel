//! 音色参考音频的本地校验（H3 参考生成 r2va · `role=reference_audio`）。
//!
//! 官方规格（MiniMax H3 · `POST /v2/video_generation` 的 `content[]`）：
//! - 元素形态：`{"type":"audio_url","audio_url":{"url":...},"role":"reference_audio"}`
//! - 格式：WAV / MP3（不支持 FLAC 等）
//! - 单文件 ≤ 15 MB
//! - 单段时长 [2, 15] 秒，总时长 ≤ 15 秒，最多 3 段
//! - 与首帧/尾帧（first_frame / last_frame）互斥；本项目恒走 reference_image 的 r2va，无冲突
//!
//! 🔴 校验必须发生在**扣费之前**：参数不合规的音频在本地就拦下，
//! 否则会变成「钱扣了 → 上游 400 → 再走退费」的坏路径。

use std::path::{Path, PathBuf};

use base64::Engine;
use tauri::{AppHandle, Manager};
use tracing::warn;

/// 官方单文件上限 15 MB。
const MAX_AUDIO_BYTES: usize = 15 * 1024 * 1024;
/// 官方单段时长下限（秒）。
const MIN_DURATION_SECS: f64 = 2.0;
/// 官方单段时长上限（秒）。
const MAX_DURATION_SECS: f64 = 15.0;
/// 官方最多 3 段。
pub const MAX_CLIPS: usize = 3;
/// 官方总时长上限（秒）。
pub const MAX_TOTAL_SECS: f64 = 15.0;

/// 前端传入的一段音色参考（camelCase + `character` 绑定角色名，可为空）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRefInput {
    pub data_url: String,
    #[serde(default)]
    pub character: Option<String>,
}

/// 校验通过的音色参考。
#[derive(Debug, Clone)]
pub struct VoiceReference {
    /// 原样透传的 DataURL（base64）。compshare 直连拉不到七牛 CDN，和参考图一样走 base64。
    pub data_url: String,
    /// 这段声音属于谁（角色名）。空表示不绑定。
    pub character: Option<String>,
    /// 探到的时长（秒）；探不到时为 None（此时不拦截，交给上游）。
    pub duration_secs: Option<f64>,
}

/// DataURL 的 MIME → 落盘扩展名。只认官方允许的 WAV / MP3。
fn mime_to_ext(mime: &str) -> Option<&'static str> {
    match mime {
        "audio/wav" | "audio/wave" | "audio/x-wav" => Some("wav"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        _ => None,
    }
}

/// 用 ffmpeg 读时长：`ffmpeg -i <file>` 的 stderr 里有 `Duration: 00:00:05.00,`。
/// 本仓 resources 里只有 ffmpeg、没有 ffprobe，所以走 stderr 解析（与 enhance.rs 同一套兜底）。
fn probe_duration_secs(ffmpeg: &Path, media_path: &Path) -> Option<f64> {
    let out = crate::commands::enhance::hidden_command(ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(media_path)
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = stderr
        .lines()
        .find(|l| l.trim_start().starts_with("Duration:"))?;
    let stamp = line.split_whitespace().nth(1)?.trim_end_matches(',');
    let mut parts = stamp.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn ffmpeg_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法定位资源目录: {}", e))?;
    let name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    crate::commands::enhance::resolve_binary(&resource_dir, "ffmpeg", name)
}

/// 校验一段音色参考音频，通过则返回可直接塞进 `content[]` 的 DataURL。
/// `slot` 只用于给临时文件起名（同一毫秒内多段不互相踩）。
fn validate_one(app: &AppHandle, raw: &str, slot: usize) -> Result<VoiceReference, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("音色参考音频为空".to_string());
    }

    let rest = raw
        .strip_prefix("data:")
        .ok_or_else(|| "音色参考音频格式不支持，请重新上传 WAV 或 MP3 文件".to_string())?;
    let (meta, b64) = rest
        .split_once(";base64,")
        .ok_or_else(|| "音色参考音频格式不支持，请重新上传 WAV 或 MP3 文件".to_string())?;
    let mime = meta.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let ext = mime_to_ext(&mime).ok_or_else(|| {
        format!(
            "音色参考音频仅支持 WAV / MP3（当前为 {}）",
            if mime.is_empty() { "未知格式" } else { mime.as_str() }
        )
    })?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "音色参考音频解码失败，请重新上传".to_string())?;
    if bytes.is_empty() {
        return Err("音色参考音频为空".to_string());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "音色参考音频不能超过 15 MB（当前 {:.1} MB）",
            bytes.len() as f64 / (1024.0 * 1024.0)
        ));
    }

    // 时长校验：拿不到 ffmpeg 或解析失败时不拦（前端已按同一规格把关，上游也会拒）。
    let duration_secs = match ffmpeg_binary(app) {
        Ok(ffmpeg) => {
            let tmp_path = std::env::temp_dir().join(format!(
                "storyboard_voice_ref_{}_{}_{}.{}",
                std::process::id(),
                slot,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
                ext
            ));
            match std::fs::write(&tmp_path, &bytes) {
                Ok(()) => {
                    let probed = probe_duration_secs(&ffmpeg, &tmp_path);
                    let _ = std::fs::remove_file(&tmp_path);
                    probed
                }
                Err(e) => {
                    warn!("[VoiceRef] 临时文件写入失败，跳过时长校验: {}", e);
                    None
                }
            }
        }
        Err(e) => {
            warn!("[VoiceRef] ffmpeg 不可用，跳过时长校验: {}", e);
            None
        }
    };

    if let Some(secs) = duration_secs {
        if secs + 0.05 < MIN_DURATION_SECS || secs > MAX_DURATION_SECS + 0.05 {
            return Err(format!(
                "音色参考音频时长需在 2–15 秒之间（当前 {:.1} 秒）",
                secs
            ));
        }
    }

    Ok(VoiceReference {
        data_url: raw.to_string(),
        character: None,
        duration_secs,
    })
}

/// 校验全部音色参考：逐段规格 + 段数上限 + 总时长上限（官方 3 段 / 合计 ≤15 秒）。
/// 返回顺序与入参一致 —— 提示词里的 `reference audio N` 序号就按这个顺序。
pub fn validate_all(app: &AppHandle, inputs: &[VoiceRefInput]) -> Result<Vec<VoiceReference>, String> {
    if inputs.len() > MAX_CLIPS {
        return Err(format!("音色参考最多 {} 段（当前 {} 段）", MAX_CLIPS, inputs.len()));
    }

    let mut out = Vec::with_capacity(inputs.len());
    let mut total_known = 0.0_f64;
    let mut all_known = true;
    for (index, input) in inputs.iter().enumerate() {
        let mut voice = validate_one(app, &input.data_url, index)?;
        let character = input
            .character
            .as_deref()
            .map(|c| c.replace(char::is_whitespace, " ").trim().to_string())
            .filter(|c| !c.is_empty());
        voice.character = character;

        match voice.duration_secs {
            Some(secs) => total_known += secs,
            None => all_known = false,
        }
        out.push(voice);
    }

    // 只要有一段时长探不出来，就跳过总时长判定（单段、前端、上游三道已经够用）
    if all_known && total_known > MAX_TOTAL_SECS + 0.05 {
        return Err(format!(
            "音色参考合计时长不能超过 {} 秒（当前 {:.1} 秒）",
            MAX_TOTAL_SECS, total_known
        ));
    }

    Ok(out)
}
