use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};
use tracing::info;

/// 创建隐藏窗口的 Command（Windows 上禁止弹出 CMD 窗口）
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Maximum file size for enhanced images before auto-compression kicks in (40MB).
/// Baidu VOD rejects base64 payloads over ~50MB, so we keep well under that.
const MAX_ENHANCED_FILE_SIZE: u64 = 40 * 1024 * 1024;

/// 规范化图片路径：处理 asset:// localhost 和 file:// 前缀
fn normalize_image_path(raw: &str) -> String {
    let decoded = raw.trim_start_matches("file://");
    if decoded.starts_with("http://asset.localhost/") {
        let encoded = decoded
            .strip_prefix("http://asset.localhost/")
            .unwrap_or(decoded);
        return urlencoding::decode(encoded)
            .unwrap_or_else(|_| encoded.to_string().into())
            .to_string();
    }
    // Windows: asset protocol 可能传 C:/path 或 C:\path，统一处理
    let normalized = if cfg!(target_os = "windows") {
        decoded.replace('/', "\\")
    } else {
        decoded.to_string()
    };
    normalized
}

/// 统一查找打包二进制（resource_dir 优先，CARGO_MANIFEST_DIR 开发回退）
fn resolve_binary(resource_dir: &PathBuf, dir: &str, exe: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = vec![resource_dir.join(dir).join(exe)];
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(
            PathBuf::from(&manifest_dir)
                .join("resources")
                .join(dir)
                .join(exe),
        );
    }
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| {
            format!(
                "{} 未找到\n已搜索:\n{}",
                exe,
                candidates
                    .iter()
                    .map(|p| format!("  - {}", p.display()))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })
}

/// Compress an image file to JPEG if it exceeds `max_size`.
/// Returns the path to use (original if small enough, compressed JPEG otherwise).
/// Tries quality levels 85→70→55→40 until the file fits under the limit.
fn ensure_enhanced_file_size(path: PathBuf, max_size: u64) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("无法读取文件信息: {}", e))?;

    if metadata.len() <= max_size {
        return Ok(path);
    }

    let original_size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
    info!(
        "[Enhance] 输出文件 {:.1}MB 超过限制 {}MB，自动压缩...",
        original_size_mb,
        max_size / 1024 / 1024
    );

    let img = image::open(&path)
        .map_err(|e| format!("无法打开图片进行压缩: {}", e))?;

    let compressed_path = path.with_file_name(format!(
        "{}_compressed.jpg",
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
    ));

    for quality in [85u8, 70, 55, 40] {
        let file = std::fs::File::create(&compressed_path)
            .map_err(|e| format!("无法创建压缩文件: {}", e))?;
        let mut writer = std::io::BufWriter::new(file);

        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality);
        encoder
            .encode_image(&img)
            .map_err(|e| format!("JPEG 编码失败: {}", e))?;

        let compressed_size = std::fs::metadata(&compressed_path)
            .map_err(|e| format!("无法读取压缩文件: {}", e))?
            .len();
        let size_mb = compressed_size as f64 / (1024.0 * 1024.0);

        if compressed_size <= max_size {
            info!(
                "[Enhance] 压缩完成: {:.1}MB (quality={}) → {}",
                original_size_mb,
                quality,
                compressed_path.display()
            );
            return Ok(compressed_path);
        }
        info!(
            "[Enhance] quality={} → {:.1}MB 仍超标，降低质量重试...",
            quality, size_mb
        );
    }

    Err(format!(
        "图片压缩后仍超过{}MB限制，请降低超分倍数",
        max_size / 1024 / 1024
    ))
}

/// 使用 realesrgan-ncnn-vulkan 对图片进行本地超分
///
/// - `image_path`: 本地文件路径（支持 asset:///file:// 协议自动转换）
/// - `scale`: 超分倍数，默认 4（可选 2/3/4）
/// - `model`: 模型名，默认 realesrgan-x4plus
///
/// 返回增强后的图片文件路径
#[tauri::command]
pub async fn enhance_image(
    app: AppHandle,
    image_path: String,
    scale: Option<u32>,
    model: Option<String>,
) -> Result<String, String> {
    let scale = scale.unwrap_or(4);
    let model = model.unwrap_or_else(|| "realesrgan-x4plus".to_string());

    if !matches!(scale, 2 | 3 | 4) {
        return Err(format!("不支持的缩放倍数: {}，仅支持 2/3/4", scale));
    }

    // 1. 规范化路径
    let normalized_path = normalize_image_path(&image_path);
    let input = PathBuf::from(&normalized_path);

    if !input.exists() {
        return Err(format!("图片文件不存在: {}", input.display()));
    }

    // 2. 定位 realesrgan 二进制
    let binary_name = if cfg!(target_os = "windows") {
        "realesrgan-ncnn-vulkan.exe"
    } else {
        "realesrgan-ncnn-vulkan"
    };

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {}", e))?;

    let binary_path = resolve_binary(&resource_dir, "realesrgan", binary_name)?;

    // 模型目录：binary 所在目录下的 models/
    let model_dir = binary_path
        .parent()
        .unwrap_or(&resource_dir)
        .join("models");

    if !model_dir.exists() || !model_dir.join("realesrgan-x4plus.bin").exists() {
        return Err(format!(
            "超分模型文件缺失，请确保 {} 目录下存在 realesrgan-x4plus.bin 和 realesrgan-x4plus.param",
            model_dir.display()
        ));
    }

    // 3. 构造输出路径（同目录，_enhanced 后缀，避免覆盖）
    let parent = input.parent().unwrap_or(std::path::Path::new("."));
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("enhanced");
    let ext = input
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png");

    // 如果 _enhanced 文件已存在，加序号避免覆盖
    let mut output = parent.join(format!("{}_enhanced.{}", stem, ext));
    let mut counter = 1u32;
    while output.exists() {
        output = parent.join(format!("{}_enhanced_{}.{}", stem, counter, ext));
        counter += 1;
    }

    // 4. 调用 realesrgan-ncnn-vulkan
    info!(
        "[Enhance] 开始超分: {} -> {} (scale={}, model={})",
        input.display(),
        output.display(),
        scale,
        model
    );

    let result = hidden_command(&binary_path)
        .arg("-i")
        .arg(normalized_path)
        .arg("-o")
        .arg(output.to_string_lossy().as_ref())
        .arg("-s")
        .arg(scale.to_string())
        .arg("-n")
        .arg(&model)
        .arg("-f")
        .arg(ext)
        .arg("-g")
        .arg("0") // 静默模式，不弹 GUI 窗口
        .current_dir(binary_path.parent().unwrap_or(&resource_dir))
        .output()
        .map_err(|e| format!("启动超分进程失败: {}", e))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let stdout = String::from_utf8_lossy(&result.stdout);
        let hint = if stderr.is_empty() { &stdout } else { &stderr };
        return Err(format!("超分处理失败: {}", hint));
    }

    if !output.exists() {
        return Err("超分完成但未生成输出文件".to_string());
    }

    // 自动压缩：4K PNG 可能超过 50MB（Baidu VOD 限制），
    // 如果超标则降级为 JPEG 并调整质量直到达标
    let final_path = ensure_enhanced_file_size(output, MAX_ENHANCED_FILE_SIZE)?;
    let output_str = final_path.to_string_lossy().to_string();
    info!("[Enhance] 超分完成: {}", output_str);

    Ok(output_str)
}

/// 使用 ffmpeg Lanczos 对视频进行本地超分
///
/// 直接 ffmpeg lanczos scale → 编码，一条命令完成。秒级耗时，不依赖 GPU。
///
/// - `video_path`: 本地 mp4 文件路径
/// - `scale`: 超分倍数，默认 2（可选 2/3/4）
/// - `model`: 保留参数（兼容旧接口），当前忽略
///
/// 返回增强后的视频文件路径
#[tauri::command]
pub async fn enhance_video(
    app: AppHandle,
    video_path: String,
    scale: Option<u32>,
    model: Option<String>,
) -> Result<String, String> {
    let scale = scale.unwrap_or(2);
    let _model = model;

    if !matches!(scale, 2 | 3 | 4) {
        return Err(format!("不支持的缩放倍数: {}，仅支持 2/3/4", scale));
    }

    // 1. 处理输入：远程 URL 先下载到本地
    let input_path: PathBuf;
    let _temp_download: Option<PathBuf>;

    if video_path.starts_with("http://") || video_path.starts_with("https://") {
        info!("[EnhanceVideo] 检测到远程 URL，开始下载: {}", video_path);
        let response = reqwest::get(&video_path)
            .await
            .map_err(|e| format!("下载视频失败: {}", e))?;
        if !response.status().is_success() {
            return Err(format!("下载视频失败: HTTP {}", response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("读取视频数据失败: {}", e))?;
        let tmp_dir = std::env::temp_dir().join("storyboard-enhance");
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
        let tmp_path = tmp_dir.join(format!("dl_{}.mp4", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, &bytes)
            .map_err(|e| format!("写入临时文件失败: {}", e))?;
        info!("[EnhanceVideo] 下载完成: {} ({} bytes)", tmp_path.display(), bytes.len());
        _temp_download = Some(tmp_path.clone());
        input_path = tmp_path;
    } else {
        input_path = PathBuf::from(&video_path);
        _temp_download = None;
    }

    if !input_path.exists() {
        return Err(format!("视频文件不存在: {}", input_path.display()));
    }

    // 2. 定位 ffmpeg
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {}", e))?;

    let ffmpeg_binary_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    let ffmpeg_binary = resolve_binary(&resource_dir, "ffmpeg", ffmpeg_binary_name)?;

    // 3. 构造输出路径
    // 远程 URL 时：存到视频目录；本地文件时：存到同目录
    let is_remote = video_path.starts_with("http://") || video_path.starts_with("https://");
    let parent = if is_remote {
        let videos_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join("videos");
        std::fs::create_dir_all(&videos_dir).ok();
        videos_dir
    } else {
        input_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf()
    };

    // 从 URL 或本地路径提取文件名 stem
    let stem = if is_remote {
        video_path
            .rsplit('/')
            .next()
            .unwrap_or("video.mp4")
            .rsplitn(2, '.')
            .last()
            .unwrap_or("video")
            .to_string()
    } else {
        input_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("video")
            .to_string()
    };

    // 防止级联超分：已增强过的视频不允许再次超分
    if stem.contains("_enhanced") {
        return Err("该视频已经过本地超分处理，不支持再次超分".to_string());
    }

    let mut output = parent.join(format!("{}_enhanced.mp4", stem));
    let mut counter = 1u32;
    while output.exists() {
        output = parent.join(format!("{}_enhanced_{}.mp4", stem, counter));
        counter += 1;
    }

    // 4. 从源视频读取分辨率 → 计算目标分辨率
    let ffprobe_binary_name = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let ffprobe_path = ffmpeg_binary
        .parent()
        .unwrap_or(&resource_dir)
        .join(ffprobe_binary_name);

    // 获取源视频分辨率：优先 ffprobe，回退 ffmpeg -i 解析 stderr
    info!(
        "[EnhanceVideo] ffprobe_path={} exists={}",
        ffprobe_path.display(),
        ffprobe_path.exists()
    );
    let (src_w, src_h): (u32, u32) = if ffprobe_path.exists() {
        hidden_command(&ffprobe_path)
            .arg("-v")
            .arg("error")
            .arg("-select_streams")
            .arg("v:0")
            .arg("-show_entries")
            .arg("stream=width,height")
            .arg("-of")
            .arg("csv=p=0")
            .arg(input_path.to_string_lossy().as_ref())
            .output()
            .ok()
            .and_then(|out| {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let mut parts = s.split(',');
                let w: u32 = parts.next()?.trim().parse().ok()?;
                let h: u32 = parts.next()?.trim().parse().ok()?;
                Some((w, h))
            })
            .unwrap_or((1920, 1080))
    } else {
        // ffprobe 不可用时，用 ffmpeg -i 解析视频流信息
        match hidden_command(&ffmpeg_binary)
            .arg("-i")
            .arg(input_path.to_string_lossy().as_ref())
            .output()
        {
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                info!("[EnhanceVideo] ffmpeg -i stderr len={}", stderr.len());
                // 匹配 "Stream #0:0 ... Video: ... 720x1280 ..."
                // 注意：stream id 含 0x1 十六进制，必须 filter_map 只取数字x数字
                let mut found: Option<(u32, u32)> = None;
                for line in stderr.lines() {
                    if line.contains("Video:") {
                        found = line.split_whitespace()
                            .filter_map(|tok| {
                                if tok.chars().filter(|c| *c == 'x').count() != 1 { return None; }
                                let cleaned = tok.trim_matches(',');
                                let mut parts = cleaned.split('x');
                                let w: u32 = parts.next()?.parse().ok()?;
                                let h: u32 = parts.next()?.parse().ok()?;
                                // 十六进制如 0x31637661 → height 会是 8 位数
                                if h >= 10_000_000 { return None; }
                                info!("[EnhanceVideo] ffmpeg fallback parsed: {}x{}", w, h);
                                Some((w, h))
                            })
                            .next();
                        if found.is_some() {
                            break;
                        }
                        info!("[EnhanceVideo] Video line found but no valid resolution token: {}", line);
                    }
                }
                if found.is_none() {
                    info!("[EnhanceVideo] stderr had no Video line with valid resolution, sample: {}",
                        &stderr[..std::cmp::min(500, stderr.len())]);
                }
                found
            }
            Err(e) => {
                info!("[EnhanceVideo] ffmpeg -i failed: {}, fallback to default", e);
                None
            }
        }.unwrap_or((1920, 1080))
    };
    info!("[EnhanceVideo] 源分辨率: {}x{}", src_w, src_h);

    let target_w = src_w * scale;
    let target_h = src_h * scale;

    info!(
        "[EnhanceVideo] Lanczos 超分: {}x{} -> {}x{} @ {}",
        src_w,
        src_h,
        target_w,
        target_h,
        output.display()
    );

    // 5. ffmpeg Lanczos scale + 编码（libx264 通用软件编码，不挑显卡）
    let scale_filter = format!(
        "scale={}:{}:flags=lanczos",
        target_w, target_h
    );

    let merge = hidden_command(&ffmpeg_binary)
        .arg("-i")
        .arg(input_path.to_string_lossy().as_ref())
        .arg("-vf")
        .arg(&scale_filter)
        .arg("-c:v")
        .arg("libx264")
        .arg("-b:v")
        .arg("50M")
        .arg("-c:a")
        .arg("copy")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&output)
        .output()
        .map_err(|e| format!("启动 ffmpeg 超分失败: {}", e))?;

    if !merge.status.success() {
        let stderr = String::from_utf8_lossy(&merge.stderr);
        return Err(format!("视频超分失败: {}", stderr));
    }

    if !output.exists() {
        return Err("超分完成但未生成输出文件".to_string());
    }

    let output_str = output.to_string_lossy().to_string();
    info!("[EnhanceVideo] 超分完成: {}", output_str);
    Ok(output_str)
}
