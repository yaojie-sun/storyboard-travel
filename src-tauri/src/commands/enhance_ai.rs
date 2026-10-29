//! 本地 AI 视频超分：抽帧 → Real-ESRGAN 逐帧推理 → 带原音轨重编码。
//!
//! 与 `enhance::enhance_video`（ffmpeg Lanczos 插值放大，只把分辨率数字做大）不同，
//! 这条链路真正还原细节。依赖随包分发的二进制与模型，不新增下载：
//! - `resources/realesrgan/realesrgan-ncnn-vulkan[.exe|-macos]`
//! - `resources/realesrgan/models/realesr-animevideov3-x{2,3,4}.*`
//!
//! 前端的 `enhance_video_ai` 失败时应回退到 `enhance_video`（快路），
//! 因此这里对「机器不支持 Vulkan」等环境问题只返回错误，不做静默降级。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use super::enhance::{
    dims_at_short_edge, encoder_options, even, hidden_command, pick_h264_encoder, resolve_binary,
    DEFAULT_TARGET_SHORT_EDGE,
};

/// 进度事件名（前端 `listen` 同名）
const PROGRESS_EVENT: &str = "enhance-video-progress";

/// 视频专用模型：体积小、逐帧一致性好，适合批量推理
pub(crate) const DEFAULT_MODEL: &str = "realesr-animevideov3";

/// 推理阶段的进度占比（抽帧 0–10%，推理 10–90%，编码 90–100%）
const EXTRACT_END: f32 = 10.0;
const INFER_END: f32 = 90.0;

/// AI 帧占比：保留模型给出的锐利边缘与纹理方向
const AI_BLEND_AI: f64 = 0.60;
/// 原片 Lanczos 占比：保住被模型抹掉的真实细节（发丝、饰品、布料纹理）
const AI_BLEND_BASE: f64 = 0.40;

#[derive(Clone, Serialize)]
struct EnhanceProgress {
    stage: &'static str,
    percent: f32,
    done: u64,
    total: u64,
}

/// `app` 为 `None` 时不发事件（单测直接跑管线时使用）
fn emit_progress(
    app: Option<&AppHandle>,
    stage: &'static str,
    percent: f32,
    done: u64,
    total: u64,
) {
    let Some(app) = app else { return };
    let _ = app.emit(
        PROGRESS_EVENT,
        EnhanceProgress {
            stage,
            percent: percent.clamp(0.0, 100.0),
            done,
            total,
        },
    );
}

#[derive(Debug)]
pub(crate) struct VideoMeta {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// 读取分辨率与帧率。
///
/// 打包内 Windows 侧只有 `ffmpeg.exe`、没有 `ffprobe.exe`（mac 侧有），
/// 所以 ffprobe 用不了时回退到解析 `ffmpeg -i` 的 stderr。
pub(crate) fn probe_video(
    ffmpeg: &Path,
    ffprobe: Option<&Path>,
    input: &Path,
) -> Result<VideoMeta, String> {
    if let Some(fp) = ffprobe {
        if let Ok(meta) = probe_with_ffprobe(fp, input) {
            return Ok(meta);
        }
    }
    probe_with_ffmpeg(ffmpeg, input)
}

fn probe_with_ffprobe(ffprobe: &Path, input: &Path) -> Result<VideoMeta, String> {
    let out = hidden_command(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "csv=p=0",
        ])
        .arg(input)
        .output()
        .map_err(|e| format!("ffprobe 启动失败: {}", e))?;

    if !out.status.success() {
        return Err(format!(
            "ffprobe 读取视频信息失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let raw = String::from_utf8_lossy(&out.stdout);
    let line = raw.lines().next().unwrap_or("").trim();
    let mut parts = line.split(',');
    let width: u32 = parts
        .next()
        .and_then(|v| v.trim().parse().ok())
        .ok_or_else(|| format!("无法解析视频宽度: {}", line))?;
    let height: u32 = parts
        .next()
        .and_then(|v| v.trim().parse().ok())
        .ok_or_else(|| format!("无法解析视频高度: {}", line))?;
    let fps = parts
        .next()
        .map(|v| v.trim())
        .and_then(parse_ratio)
        .ok_or_else(|| format!("无法解析视频帧率: {}", line))?;

    if width == 0 || height == 0 || !fps.is_finite() || fps <= 0.0 {
        return Err(format!("视频信息无效: {}", line));
    }

    Ok(VideoMeta { width, height, fps })
}

/// 从 `ffmpeg -i` 的 stderr 里抠 `1280x720` 与 `23.98 fps`
fn probe_with_ffmpeg(ffmpeg: &Path, input: &Path) -> Result<VideoMeta, String> {
    let out = hidden_command(ffmpeg)
        .arg("-i")
        .arg(input)
        .output()
        .map_err(|e| format!("ffmpeg 启动失败: {}", e))?;
    let stderr = String::from_utf8_lossy(&out.stderr);

    let line = stderr
        .lines()
        .find(|l| l.contains("Video:"))
        .ok_or_else(|| "未在视频中找到画面流".to_string())?;

    let tokens: Vec<&str> = line.split_whitespace().collect();

    // 分辨率：形如 640x480，排除 0x31637661 这类十六进制编码 id
    let (mut width, mut height) = (0u32, 0u32);
    for tok in &tokens {
        if tok.chars().filter(|c| *c == 'x').count() != 1 {
            continue;
        }
        let cleaned = tok.trim_matches(',');
        if let Some((w, h)) = cleaned.split_once('x') {
            match (w.parse::<u32>(), h.parse::<u32>()) {
                (Ok(w), Ok(h)) if h < 10_000_000 && w > 0 && h > 0 => {
                    width = w;
                    height = h;
                    break;
                }
                _ => continue,
            }
        }
    }

    // 帧率：`23.98 fps,` 取 "fps" 前一个 token
    let mut fps = 0.0f64;
    for (i, tok) in tokens.iter().enumerate() {
        if tok.trim_matches(',') == "fps" && i > 0 {
            if let Ok(v) = tokens[i - 1].trim_matches(',').parse::<f64>() {
                fps = v;
                break;
            }
        }
    }

    if width == 0 || height == 0 {
        return Err("无法从 ffmpeg 输出解析分辨率".to_string());
    }
    if !fps.is_finite() || fps <= 0.0 {
        return Err("无法从 ffmpeg 输出解析帧率".to_string());
    }

    Ok(VideoMeta { width, height, fps })
}

/// `30000/1001` → 29.97
fn parse_ratio(raw: &str) -> Option<f64> {
    let (num, den) = raw.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den == 0.0 {
        return None;
    }
    Some(num / den)
}

/// 选最小的整数放大倍数，使放大后短边不小于目标短边。
///
/// Real-ESRGAN 只支持 2/3/4 倍，`None` 表示源已达到目标、无需放大。
fn choose_ai_scale(width: u32, height: u32, target_short_edge: u32) -> Option<u32> {
    let short = width.min(height);
    if short == 0 || short >= target_short_edge {
        return None;
    }
    let need = target_short_edge as f64 / short as f64;
    Some(if need <= 2.0 {
        2
    } else if need <= 3.0 {
        3
    } else {
        4
    })
}

/// 推理产物的短边不超过这个值时，直接按模型原生尺寸出片，不再收回到目标短边。
///
/// 1344×768 的源走 2 倍档，原生就是 2688×1536 —— 正好是 2K 档。
/// 再缩一次等于把刚算出来的细节又扔一遍，所以这里保原尺寸；
/// 只有源本身很高（如 1920×1080 走 2 倍 = 2160 短边）才收到 1536 档。
const NATIVE_KEEP_SHORT_EDGE: u32 = 1600;

/// 出片尺寸：原生够用就保原生，否则收敛到目标短边
fn plan_dims(width: u32, height: u32, scale: u32, target_short_edge: u32) -> (u32, u32) {
    let native = (even(width * scale), even(height * scale));
    if native.0.min(native.1) <= NATIVE_KEEP_SHORT_EDGE {
        native
    } else {
        dims_at_short_edge(native.0, native.1, target_short_edge)
    }
}

fn count_files(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().count() as u64)
        .unwrap_or(0)
}

/// 抽帧：`-qscale:v 1` 保留最高质量，`-vsync 0` 不补帧不丢帧。
///
/// 同一趟解码同时吐两路：
/// - `ai_dir`：源分辨率原片，喂给 Real-ESRGAN 推理；
/// - `lanczos_dir`：直接放大到出片尺寸的 Lanczos 版，编码时与 AI 结果按比例混合。
///
/// 两路来自同一次解码，帧号严格一一对应，不需要额外对帧。
fn extract_frames(
    ffmpeg: &Path,
    input: &Path,
    ai_dir: &Path,
    lanczos_dir: &Path,
    lanczos_dims: (u32, u32),
) -> Result<u64, String> {
    let ai_pattern = ai_dir.join("frame%08d.jpg");
    let lz_pattern = lanczos_dir.join("frame%08d.jpg");
    let lz_filter = format!(
        "scale={}:{}:flags=lanczos",
        lanczos_dims.0, lanczos_dims.1
    );

    let out = hidden_command(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .args(["-map", "0:v:0"])
        .args([
            "-qscale:v", "1", "-qmin", "1", "-qmax", "1", "-vsync", "0",
        ])
        .arg(&ai_pattern)
        .args(["-map", "0:v:0", "-vf", &lz_filter])
        .args(["-qscale:v", "2", "-vsync", "0"])
        .arg(&lz_pattern)
        .output()
        .map_err(|e| format!("启动 ffmpeg 抽帧失败: {}", e))?;

    if !out.status.success() {
        return Err(format!(
            "抽帧失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let total = count_files(ai_dir);
    if total == 0 {
        return Err("抽帧结果为空，视频可能没有可解码的画面".to_string());
    }
    let lz_total = count_files(lanczos_dir);
    if lz_total != total {
        return Err(format!(
            "抽帧两路不一致: 原片 {} 帧 / Lanczos {} 帧",
            total, lz_total
        ));
    }
    Ok(total)
}

/// 逐帧推理，边跑边按输出目录的帧数上报进度
async fn upscale_frames(
    app: Option<&AppHandle>,
    binary: &Path,
    model_dir: &Path,
    model: &str,
    scale: u32,
    in_dir: &Path,
    out_dir: &Path,
    total: u64,
    log_path: &Path,
) -> Result<(), String> {
    let log_file =
        std::fs::File::create(log_path).map_err(|e| format!("创建推理日志失败: {}", e))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("创建推理日志失败: {}", e))?;

    let mut child = hidden_command(binary)
        .arg("-i")
        .arg(in_dir)
        .arg("-o")
        .arg(out_dir)
        .arg("-n")
        .arg(model)
        .arg("-s")
        .arg(scale.to_string())
        .args(["-f", "jpg"])
        // 不要传 -m 绝对路径：ncnn 会把它拼到 exe 目录后面，生成非法路径直接崩溃。
        // 默认就按 exe 同级的 models/ 找模型。
        .current_dir(binary.parent().unwrap_or(model_dir))
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("启动超分推理失败: {}", e))?;

    let mut last_percent = -1.0f32;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let tail = std::fs::read_to_string(log_path)
                        .unwrap_or_default()
                        .lines()
                        .rev()
                        .take(20)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("\n");
                    return Err(format!(
                        "超分推理失败 (exit={:?}): {}",
                        status.code(),
                        tail.trim()
                    ));
                }
                break;
            }
            Ok(None) => {}
            Err(e) => return Err(format!("读取超分进程状态失败: {}", e)),
        }

        let done = count_files(out_dir);
        let ratio = (done as f32 / total as f32).min(1.0);
        let percent = EXTRACT_END + (INFER_END - EXTRACT_END) * ratio;
        if percent - last_percent >= 1.0 {
            emit_progress(app, "infer", percent, done, total);
            last_percent = percent;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    let produced = count_files(out_dir);
    if produced < total {
        return Err(format!(
            "超分推理不完整: 期望 {} 帧，实际 {} 帧",
            total, produced
        ));
    }
    Ok(())
}

/// 用增强后的帧 + 原始视频的音轨重新编码
///
/// 画面不是纯 AI 结果：`realesr -animevideov3` 是动画向模型，实拍素材上的
/// 细发丝、耳饰这类高频信息会被「抹平成皮肤」（观感即磨皮）。所以这里把
/// AI 帧与同帧的 Lanczos 原片纹理按 `AI_BLEND_AI` / `AI_BLEND_BASE` 混合，
/// 再用轻锐化和时域颗粒补回质感 —— AI 负责边缘锐度，原片负责真实纹理。
fn encode_video(
    ffmpeg: &Path,
    ai_dir: &Path,
    lanczos_dir: &Path,
    source: &Path,
    fps: f64,
    ai_dims: (u32, u32),
    out_dims: (u32, u32),
    output: &Path,
) -> Result<(), String> {
    let ai_pattern = ai_dir.join("frame%08d.jpg");
    let lz_pattern = lanczos_dir.join("frame%08d.jpg");
    let fps_arg = format!("{:.6}", fps);

    let mut cmd = hidden_command(ffmpeg);
    cmd.arg("-y")
        .arg("-framerate")
        .arg(&fps_arg)
        .arg("-i")
        .arg(&ai_pattern)
        .arg("-framerate")
        .arg(&fps_arg)
        .arg("-i")
        .arg(&lz_pattern)
        .arg("-i")
        .arg(source)
        .args(["-map", "[out]", "-map", "2:a?"])
        .args(["-c:a", "copy"]);

    // 色彩标准对齐：推理帧是 JPEG（BT.601 矩阵 / full range），成品是 HD，
    // 必须按 BT.709 / TV range 输出。ffmpeg 默认会按 BT.601 标记，部分播放器
    // 按 SD 矩阵渲染就会出现偏色，这里显式指定行业标准。
    let color_conv = "in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv";
    // AI 帧在原生尺寸上，出片尺寸不同时先缩到出片尺寸再混合
    let ai_scale = if ai_dims == out_dims {
        format!("scale={}", color_conv)
    } else {
        format!(
            "scale={}:{}:flags=lanczos:{}",
            out_dims.0, out_dims.1, color_conv
        )
    };
    let filter = format!(
        "[0:v]{ai}[ai];[1:v]scale={cc},format=yuv420p[lz];\
         [ai][lz]blend=all_expr='A*{wa}+B*{wb}',\
         unsharp=5:5:0.25:5:5:0,noise=c0s=3:allf=t,format=yuv420p[out]",
        ai = ai_scale,
        cc = color_conv,
        wa = AI_BLEND_AI,
        wb = AI_BLEND_BASE,
    );
    cmd.args(["-filter_complex", &filter]);

    // 编码器：硬件可用就硬件（1080P 能省八成以上时间），否则 libx264。
    // 软件编码保持 crf 18 的画质口径不变，硬件编码按同码率给。
    let encoder = pick_h264_encoder(ffmpeg);
    if encoder == "libx264" {
        cmd.args(["-c:v", "libx264", "-crf", "18", "-preset", "medium"]);
    } else {
        cmd.args(encoder_options(encoder));
    }

    let out = cmd
        .args([
            "-pix_fmt", "yuv420p",
            "-color_range", "tv", "-colorspace", "bt709",
            "-color_primaries", "bt709", "-color_trc", "bt709",
            "-movflags", "+faststart",
        ])
        .arg(output)
        .output()
        .map_err(|e| format!("启动 ffmpeg 编码失败: {}", e))?;

    if !out.status.success() {
        return Err(format!(
            "重编码失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    if !output.exists() {
        return Err("重编码完成但未生成输出文件".to_string());
    }
    Ok(())
}

/// 构造不覆盖既有文件的输出路径
fn output_path(input: &Path, stem: &str) -> PathBuf {
    let parent = input.parent().unwrap_or(Path::new("."));
    let mut output = parent.join(format!("{}_enhanced.mp4", stem));
    let mut counter = 1u32;
    while output.exists() {
        output = parent.join(format!("{}_enhanced_{}.mp4", stem, counter));
        counter += 1;
    }
    output
}

/// 抽帧 → 推理 → 重编码的完整管线（不含路径与二进制定位）
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_pipeline(
    app: Option<&AppHandle>,
    ffmpeg: &Path,
    ffprobe: Option<&Path>,
    sr_binary: &Path,
    model_dir: &Path,
    model: &str,
    scale: u32,
    target_dims: Option<(u32, u32)>,
    input: &Path,
    output: &Path,
) -> Result<(), String> {
    let meta = probe_video(ffmpeg, ffprobe, input)?;

    let tmp_root = std::env::temp_dir().join(format!("storyboard-sr-{}", uuid::Uuid::new_v4()));
    let in_dir = tmp_root.join("in");
    let out_dir = tmp_root.join("out");
    let lz_dir = tmp_root.join("lz");
    std::fs::create_dir_all(&in_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    std::fs::create_dir_all(&lz_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let ai_dims = (even(meta.width * scale), even(meta.height * scale));
    let out_dims = target_dims.unwrap_or(ai_dims);

    info!(
        "[EnhanceAI] 开始: {} ({}x{} @ {:.3}fps) scale={} ai={:?} out={:?} model={}",
        input.display(),
        meta.width,
        meta.height,
        meta.fps,
        scale,
        ai_dims,
        out_dims,
        model
    );
    emit_progress(app, "extract", 0.0, 0, 0);

    let result = async {
        let total = extract_frames(ffmpeg, input, &in_dir, &lz_dir, out_dims)?;
        emit_progress(app, "extract", EXTRACT_END, total, total);
        info!("[EnhanceAI] 抽帧完成: {} 帧", total);

        let log_path = tmp_root.join("infer.log");
        upscale_frames(
            app, sr_binary, model_dir, model, scale, &in_dir, &out_dir, total, &log_path,
        )
        .await?;

        emit_progress(app, "encode", INFER_END, total, total);
        encode_video(ffmpeg, &out_dir, &lz_dir, input, meta.fps, ai_dims, out_dims, output)?;

        emit_progress(app, "done", 100.0, total, total);
        Ok::<(), String>(())
    }
    .await;

    if let Err(e) = &result {
        warn!("[EnhanceAI] 失败: {}", e);
    }

    // 无论成败都清理：逐帧 PNG 体积大，失败时留在临时目录会撑爆磁盘
    if let Err(e) = std::fs::remove_dir_all(&tmp_root) {
        warn!(
            "[EnhanceAI] 清理临时目录失败 ({}): {}",
            tmp_root.display(),
            e
        );
    }

    result
}

/// 使用 Real-ESRGAN 对视频做本地 AI 超分
///
/// - `video_path`: 本地视频路径（远程 URL 请走 `enhance_video` 那条链路）
/// - `target_short_edge`: 目标短边，默认 1536（2K 档，横版约 2688x1536 / 竖版约 1536x2688）
/// - `model`: 模型名，默认 `realesr-animevideov3`
///
/// 推理倍数按目标短边自动选最小整数档位（2/3/4），多出来的部分在编码时收回去。
/// 源分辨率已达到目标时直接返回原路径（不做无意义放大）。
#[tauri::command]
pub async fn enhance_video_ai(
    app: AppHandle,
    video_path: String,
    target_short_edge: Option<u32>,
    model: Option<String>,
) -> Result<String, String> {
    let target_short_edge = target_short_edge.unwrap_or(DEFAULT_TARGET_SHORT_EDGE);
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());

    if target_short_edge < 240 {
        return Err(format!(
            "目标分辨率过低: {}，短边至少 240",
            target_short_edge
        ));
    }

    if video_path.starts_with("http://") || video_path.starts_with("https://") {
        return Err("AI 超分只支持本地视频文件".to_string());
    }

    let input = PathBuf::from(&video_path);
    if !input.exists() {
        return Err(format!("视频文件不存在: {}", input.display()));
    }

    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_string();
    if stem.contains("_enhanced") {
        return Err("该视频已经过超分处理，不支持再次超分".to_string());
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {}", e))?;

    let ffmpeg_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let ffprobe_name = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let sr_name = if cfg!(target_os = "windows") {
        "realesrgan-ncnn-vulkan.exe"
    } else if cfg!(target_os = "macos") {
        "realesrgan-ncnn-vulkan-macos"
    } else {
        "realesrgan-ncnn-vulkan"
    };

    let ffmpeg = resolve_binary(&resource_dir, "ffmpeg", ffmpeg_name)?;
    // Windows 分包里没有 ffprobe.exe，缺失属正常情况（自动回退到 ffmpeg -i 解析）
    let ffprobe = resolve_binary(&resource_dir, "ffmpeg", ffprobe_name).ok();
    let sr_binary = resolve_binary(&resource_dir, "realesrgan", sr_name)?;

    let meta = probe_video(&ffmpeg, ffprobe.as_deref(), &input)?;
    let Some(scale) = choose_ai_scale(meta.width, meta.height, target_short_edge) else {
        info!(
            "[EnhanceAI] 源 {}x{} 短边已达目标 {}，无需超分",
            meta.width, meta.height, target_short_edge
        );
        return Ok(video_path);
    };
    // AI 放大是整数档位：原生结果已经是 2K 级（768×2=1536）就保原尺寸，
    // 只有原生明显超出目标档（如 1080×2=2160）才收回到目标短边
    let target_dims = plan_dims(meta.width, meta.height, scale, target_short_edge);

    let model_dir = sr_binary.parent().unwrap_or(&resource_dir).join("models");
    let model_file = model_dir.join(format!("{}-x{}.bin", model, scale));
    if !model_file.exists() {
        return Err(format!(
            "超分模型文件缺失: {}\n请确认 resources/realesrgan/models 完整",
            model_file.display()
        ));
    }

    let output = output_path(&input, &stem);

    run_pipeline(
        Some(&app),
        &ffmpeg,
        ffprobe.as_deref(),
        &sr_binary,
        &model_dir,
        &model,
        scale,
        Some(target_dims),
        &input,
        &output,
    )
    .await?;

    let output_str = output.to_string_lossy().to_string();
    info!("[EnhanceAI] 完成: {}", output_str);
    Ok(output_str)
}

// ── 本机能力探测 ─────────────────────────────────────────────────────────

/// 本机 AI 超分能力。前端据此决定是否展示「AI 高清增强」入口。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrCapability {
    /// 能不能跑 AI 超分：二进制/模型齐全 + 有真 GPU + 实测速度过线
    pub ai_available: bool,
    /// Vulkan 设备名，如 `AMD Radeon RX 5700 XT`
    pub gpu: Option<String>,
    /// 只有软件光栅化设备（llvmpipe / Basic Render Driver 等）时为真
    pub software_renderer: bool,
    /// 实测每百万输出像素的推理耗时（毫秒，含模型加载）
    pub ms_per_megapixel: Option<f64>,
    /// 实际会使用的 H.264 编码器
    pub encoder: String,
    pub hardware_encoder: bool,
}

/// 微基准取 8 帧 640x360 → 1280x720。超过这个耗时说明这台机器带不动逐帧推理。
///
/// 参照：本机独显（RX 5700 XT）约 0.8 秒 → 一条 12 秒视频约 74 秒。
/// 阈值卡在 3 秒（≈4 倍慢）——再慢的话一条片段要等 5 分钟以上，而用户看不到
/// 任何可选项，只会觉得「卡住了」，所以宁可退回快速档。
const BENCH_MAX_MS: f64 = 3000.0;

const SOFTWARE_GPU_HINTS: &[&str] = &[
    "llvmpipe",
    "swiftshader",
    "microsoft basic render driver",
    "gdi generic",
    "software rasterizer",
];

fn is_software_gpu(name: &str) -> bool {
    let lower = name.to_lowercase();
    SOFTWARE_GPU_HINTS.iter().any(|hint| lower.contains(hint))
}

/// 从 `realesrgan -v` 的输出里抠 Vulkan 设备名
/// （形如 `[0 AMD Radeon RX 5700 XT]  queueC=1[4] ...`）
pub(crate) fn parse_vulkan_devices(raw: &str) -> Vec<String> {
    let mut devices: Vec<String> = Vec::new();
    for line in raw.lines() {
        let Some(rest) = line.trim().strip_prefix('[') else {
            continue;
        };
        let Some((index, tail)) = rest.split_once(' ') else {
            continue;
        };
        if index.parse::<u32>().is_err() {
            continue;
        }
        let Some((name, _)) = tail.split_once(']') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || devices.iter().any(|d| d == name) {
            continue;
        }
        devices.push(name.to_string());
    }
    devices
}

/// 跑一次 8 帧推理测速，返回 (总耗时毫秒, 输出百万像素)
fn benchmark_inference(ffmpeg: &Path, sr: &Path, model_dir: &Path) -> Result<(f64, f64), String> {
    let tmp_root = std::env::temp_dir().join(format!("storyboard-sr-bench-{}", uuid::Uuid::new_v4()));
    let in_dir = tmp_root.join("in");
    let out_dir = tmp_root.join("out");
    std::fs::create_dir_all(&in_dir).map_err(|e| format!("创建基准目录失败: {}", e))?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建基准目录失败: {}", e))?;

    let result = (|| -> Result<(f64, f64), String> {
        let gen = hidden_command(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=8:d=1"])
            .args(["-frames:v", "8"])
            .arg(in_dir.join("f%03d.png"))
            .output()
            .map_err(|e| format!("生成基准帧失败: {}", e))?;
        if !gen.status.success() {
            return Err(format!(
                "生成基准帧失败: {}",
                String::from_utf8_lossy(&gen.stderr).trim()
            ));
        }

        let started = std::time::Instant::now();
        let status = hidden_command(sr)
            .arg("-i")
            .arg(&in_dir)
            .arg("-o")
            .arg(&out_dir)
            .arg("-n")
            .arg(DEFAULT_MODEL)
            .args(["-s", "2"])
            .current_dir(sr.parent().unwrap_or(model_dir))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("启动基准推理失败: {}", e))?;
        if !status.success() {
            return Err("基准推理失败（显卡不可用或显存不足）".to_string());
        }

        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let output_mp = 8.0 * (1280.0 * 720.0) / 1_000_000.0;
        Ok((elapsed_ms, output_mp))
    })();

    let _ = std::fs::remove_dir_all(&tmp_root);
    result
}

/// 探测本机 AI 超分能力（Vulkan 设备 + 实测速度 + 编码器）。
///
/// 没有独显的机器上逐帧推理是「分钟变小时」，所以这里除了看设备在不在，
/// 还跑一次微基准：跑不动就把 `ai_available` 置 false，前端不展示入口。
#[tauri::command]
pub async fn probe_sr_capability(app: AppHandle) -> Result<SrCapability, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {}", e))?;

    let ffmpeg_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let ffmpeg = resolve_binary(&resource_dir, "ffmpeg", ffmpeg_name)?;

    Ok(probe_sr_with(&ffmpeg, &resource_dir))
}

/// 探测主体（不依赖 `AppHandle`，便于直接跑真实环境自检）
pub(crate) fn probe_sr_with(ffmpeg: &Path, resource_dir: &Path) -> SrCapability {
    let encoder = pick_h264_encoder(ffmpeg).to_string();
    let mut cap = SrCapability {
        ai_available: false,
        gpu: None,
        software_renderer: false,
        ms_per_megapixel: None,
        hardware_encoder: encoder != "libx264",
        encoder,
    };

    let sr_name = if cfg!(target_os = "windows") {
        "realesrgan-ncnn-vulkan.exe"
    } else if cfg!(target_os = "macos") {
        "realesrgan-ncnn-vulkan-macos"
    } else {
        "realesrgan-ncnn-vulkan"
    };
    let Ok(sr_binary) = resolve_binary(&resource_dir.to_path_buf(), "realesrgan", sr_name) else {
        info!("[SrProbe] 未找到超分二进制，AI 超分不可用");
        return cap;
    };

    let model_dir = sr_binary.parent().unwrap_or(resource_dir).join("models");
    if !model_dir.join(format!("{}-x2.bin", DEFAULT_MODEL)).exists() {
        info!("[SrProbe] 模型文件缺失，AI 超分不可用");
        return cap;
    }

    // 设备枚举：喂一个不存在的输入，二进制会在加载模型之前先把 Vulkan 设备打出来，
    // 既不推理也不写盘（实测耗时 ~10ms）。
    let probe_out = match hidden_command(&sr_binary)
        .arg("-i")
        .arg("__sr_probe_missing__.png")
        .arg("-o")
        .arg("__sr_probe_out__.png")
        .arg("-v")
        .current_dir(sr_binary.parent().unwrap_or(resource_dir))
        .output()
    {
        Ok(out) => out,
        Err(e) => {
            warn!("[SrProbe] 设备探测启动失败: {}", e);
            return cap;
        }
    };
    let raw = format!(
        "{}\n{}",
        String::from_utf8_lossy(&probe_out.stdout),
        String::from_utf8_lossy(&probe_out.stderr)
    );
    let devices = parse_vulkan_devices(&raw);
    info!("[SrProbe] Vulkan 设备: {:?}", devices);

    let hardware: Vec<&String> = devices
        .iter()
        .filter(|name| !is_software_gpu(name))
        .collect();
    cap.software_renderer = !devices.is_empty() && hardware.is_empty();
    cap.gpu = hardware
        .first()
        .map(|name| (*name).clone())
        .or_else(|| devices.first().cloned());

    if hardware.is_empty() {
        info!("[SrProbe] 无可用 GPU，AI 超分不可用");
        return cap;
    }

    match benchmark_inference(&ffmpeg, &sr_binary, &model_dir) {
        Ok((elapsed_ms, output_mp)) => {
            cap.ms_per_megapixel = Some(elapsed_ms / output_mp);
            cap.ai_available = elapsed_ms <= BENCH_MAX_MS;
            info!(
                "[SrProbe] 基准 {:.0}ms / {:.2}MP = {:.1}ms/MP → ai_available={}",
                elapsed_ms,
                output_mp,
                elapsed_ms / output_mp,
                cap.ai_available
            );
        }
        Err(e) => warn!("[SrProbe] 基准推理失败: {}，AI 超分不可用", e),
    }

    cap
}

#[cfg(test)]
mod tests {
    use super::super::enhance::fit_dims_to_short_edge;
    use super::*;

    fn resources() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    }

    /// 真实跑一遍整条管线（慢，默认跳过）：
    /// `cargo test enhance_ai -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn pipeline_upscales_demo_video() {
        let res = resources();
        let ffmpeg = res.join("ffmpeg").join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        let ffprobe_name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
        let ffprobe_path = res.join("ffmpeg").join(ffprobe_name);
        let ffprobe = ffprobe_path.exists().then_some(ffprobe_path.as_path());

        let sr_name = if cfg!(windows) {
            "realesrgan-ncnn-vulkan.exe"
        } else if cfg!(target_os = "macos") {
            "realesrgan-ncnn-vulkan-macos"
        } else {
            "realesrgan-ncnn-vulkan"
        };
        let sr = res.join("realesrgan").join(sr_name);
        let model_dir = res.join("realesrgan").join("models");
        // 可用 SR_TEST_INPUT 指向任意素材做真机验片
        let input = match std::env::var("SR_TEST_INPUT") {
            Ok(p) => PathBuf::from(p),
            Err(_) => res.join("realesrgan").join("onepiece_demo.mp4"),
        };

        let out_dir = std::env::temp_dir().join("storyboard-sr-test");
        std::fs::create_dir_all(&out_dir).unwrap();
        let output = out_dir.join("demo_enhanced.mp4");
        let _ = std::fs::remove_file(&output);

        run_pipeline(
            None,
            &ffmpeg,
            ffprobe,
            &sr,
            &model_dir,
            DEFAULT_MODEL,
            2,
            None,
            &input,
            &output,
        )
        .await
        .expect("管线应成功");

        assert!(output.exists(), "输出文件不存在");
        let meta = probe_video(&ffmpeg, ffprobe, &output).expect("读取产物信息");
        if std::env::var("SR_TEST_INPUT").is_err() {
            assert_eq!((meta.width, meta.height), (1280, 960), "应为源分辨率的 2 倍");
        }
        println!("产物: {} ({}x{})", output.display(), meta.width, meta.height);
    }

    /// 真机跑一遍能力探测（含微基准，默认跳过）：
    /// `cargo test probe_reports_real_gpu -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_reports_real_gpu() {
        let res = resources();
        let ffmpeg = res.join("ffmpeg").join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        let cap = probe_sr_with(&ffmpeg, &res);
        println!("{:?}", cap);
        assert_eq!(cap.encoder.is_empty(), false);
    }

    /// `realesrgan -v` 的设备行解析：同名设备只留一条，软件光栅要能识别
    #[test]
    fn parses_vulkan_device_lines() {
        let raw = "[0 AMD Radeon RX 5700 XT]  queueC=1[4]  queueG=0[8]  queueT=2[2]\n\
                   [0 AMD Radeon RX 5700 XT]  bugsbn1=0  bugbilz=0\n\
                   [1 Microsoft Basic Render Driver]  queueC=0[0]\n\
                   decode image x.png failed\n";
        let devices = parse_vulkan_devices(raw);
        assert_eq!(
            devices,
            vec!["AMD Radeon RX 5700 XT", "Microsoft Basic Render Driver"]
        );
        assert!(is_software_gpu(&devices[1]));
        assert!(!is_software_gpu(&devices[0]));
    }

    /// 原生结果够 2K 就保原生，只有原生过高才收回到目标短边
    #[test]
    fn keeps_native_dims_up_to_2k() {
        // 1344×768 走 2 倍 → 2688×1536，短边 1536 正好是 2K 档，保原生
        assert_eq!(plan_dims(1344, 768, 2, 1536), (2688, 1536));
        // 竖版同理
        assert_eq!(plan_dims(768, 1344, 2, 1536), (1536, 2688));
        // 1920×1080 走 2 倍 → 2160 短边，超出档位，收到 1536
        assert_eq!(plan_dims(1920, 1080, 2, 1536), (2730, 1536));
        // 320×240 走 4 倍 → 1280×960，短边 960，保原生
        assert_eq!(plan_dims(320, 240, 4, 1536), (1280, 960));
    }

    /// 640x480 源、目标短边 1080 → 选 3 倍（480×3=1440 ≥ 1080），编码收回 1440x1080
    #[test]
    fn scale_and_dims_follow_target_short_edge() {
        assert_eq!(choose_ai_scale(640, 480, 1080), Some(3));
        assert_eq!(choose_ai_scale(1344, 768, 1080), Some(2));
        assert_eq!(choose_ai_scale(1920, 1080, 1080), None);
        assert_eq!(choose_ai_scale(768, 1344, 1080), Some(2));
        assert_eq!(choose_ai_scale(320, 240, 1080), Some(4));

        // AI 输出收敛到目标短边（可降）
        assert_eq!(dims_at_short_edge(2688, 1536, 1080), (1890, 1080));
        assert_eq!(dims_at_short_edge(1536, 2688, 1080), (1080, 1890));
        assert_eq!(dims_at_short_edge(1920, 1080, 1080), (1920, 1080));
        // ffmpeg 快速放大只升不降
        assert_eq!(fit_dims_to_short_edge(1344, 768, 1080), (1890, 1080));
        assert_eq!(fit_dims_to_short_edge(2688, 1536, 1080), (2688, 1536));
    }
}
