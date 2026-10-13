# 服饰版 v1.0.5 修复汇总 → 旅游版同步指南

> 日期：2026-08-08
> 所有修复已在服饰版验证通过，旅游版需按本文档逐一同步。

---

## Bug 1: 视频生成轮询卡死 — Baidu VOD 嵌套状态

**严重程度**: 致命 — 用户付费后永远转圈

**症状**: HappyHorse 1.1 视频生成 20+ 分钟无结果，超时后才退费

**根因**: Baidu VOD 响应有两层 status。代码只读顶层 `status: "RUNNING"`，无视嵌套 `videoGenerateTaskInfo.status: "SUCCEEDED"`。

**涉及文件**: `src-tauri/src/ai/providers/happyhorse/mod.rs` (~L453-504)

**修复策略**: 
1. 先尝试提取 mediaBasicInfos 中的视频 URL（不依赖顶层 status）
2. 检查嵌套 info.status 是否为 FAILED，提前报错
3. RUNNING 时检查 info.status === SUCCEEDED 标注 "(AI done, waiting for media upload)"

**具体改动**:

```rust
// ✅ 替换旧 match 逻辑（旧代码见下方注释）：

// Step 1: 检查嵌套 info.status
let inner_status = resp.video_gen_info
    .as_ref()
    .and_then(|vi| vi.get("status"))
    .and_then(|s| s.as_str())
    .unwrap_or("")
    .to_uppercase();

// Step 2: 先尝试提取视频 URL
if let Some(url) = Self::extract_baidu_vod_video_url(&resp) {
    info!("[{}] task {} succeeded (media ready): {}", log_tag, task_id, url);
    return Ok(ProviderTaskPollResult::Succeeded(url));
}

// Step 3: 嵌套 info 失败 → 提前报错
if inner_status == "FAILED" || inner_status == "ERROR" {
    let msg = resp.video_gen_info
        .as_ref()
        .and_then(|vi| vi.get("message").or_else(|| vi.get("error")))
        .and_then(|m| m.as_str())
        .unwrap_or("生成失败");
    info!("[{}] task {} FAILED (inner): {}", log_tag, task_id, msg);
    return Ok(ProviderTaskPollResult::Failed(msg.to_string()));
}

// Step 4: 正常状态处理
let task_status = resp.status.as_deref().unwrap_or("").to_uppercase();
match task_status.as_str() {
    "SUCCEEDED" | "COMPLETED" | "SUCCESS" => {
        // 已尝试提取 URL，到这里说明还没 URL → 继续等
        info!("[{}] task {} status={} but no media URL yet, keep polling",
            log_tag, task_id, task_status);
        Ok(ProviderTaskPollResult::Running)
    }
    "FAILED" | "ERROR" => {
        Ok(ProviderTaskPollResult::Failed(msg))
    }
    "READY" | "PENDING" | "RUNNING" | "PROCESSING" | _ => {
        let detail = if inner_status == "SUCCEEDED" {
            " (AI done, waiting for media upload)"
        } else { "" };
        info!("[{}] task {} status={}{}", log_tag, task_id, task_status, detail);
        Ok(ProviderTaskPollResult::Running)
    }
}

// ❌ 旧代码（需删除）:
// let task_status = resp.status...;
// match task_status {
//     "SUCCEEDED" => { let url = extract...?; Ok(Succeeded(url)) }
//     "RUNNING" | _ => { Ok(Running) }  // 永远轮询
// }
```

---

## Bug 2: 欢乐马跨会话恢复被误跳过

**症状**: 刷新页面后 HappyHorse 1.1 任务不自动恢复轮询

**根因**: `tsk-` 前缀判断一刀切 — HappyHorse 1.1 经 Baidu VOD 也是 `tsk-` 前缀，被误判为 PixVerse 任务跳过。

**涉及文件**: `src/features/videoGeneration/VideoGenDialog.tsx` (~L501-507)

**修复**:

```tsx
// ❌ 旧：无条件跳过所有 tsk- 任务
if (pid.startsWith('tsk-')) {
    console.log('[VideoGenDialog] skipping PixVerse resume');
    setPendingTaskId(null);
    return;
}

// ✅ 新：只跳过非 HappyHorse 的 tsk- 任务
const isHappyhorseTask = savedConfig?.videoModel?.includes('happyhorse');
if (pid.startsWith('tsk-') && !isHappyhorseTask) {
    console.log('[VideoGenDialog] skipping PixVerse resume (task expires across sessions)');
    setPendingTaskId(null);
    return;
}
```

---

## Bug 3: 轮询异常日志缺失

**症状**: 后端返回 error 但前端静默，排查困难

**涉及文件**: `src/features/videoGeneration/VideoGenDialog.tsx` (~L468)

**修复**: 在 `// running → continue polling` 之后加一行：

```tsx
if (pollResult.error) {
    console.warn('[VideoGenDialog] poll returned running with error:', pollResult.error);
}
```

---

## Bug 4: 本地视频超分比例拉伸（默认 16:9）

**严重程度**: 高 — 所有竖屏视频超分后变横屏

**症状**: 9:16 竖屏视频超分后变成 16:9 横屏，画面压扁

**根因** (两层):

1. **旅游版 else 分支直接硬编码 (1920, 1080)** — 如果 ffprobe 不存在（npm ffmpeg-static 不含 ffprobe），完全没有回退逻辑
2. **ffmpeg -i stderr 解析不能用 `.find(|w| w.contains('x'))`** — `#0:0[0x1](und):` 中的 `0x1` 也是含 'x' 的 token，会被误匹配

**涉及文件**: `src-tauri/src/commands/enhance.rs`

**修复策略**:

1. 在 else 分支加入完整的 `ffmpeg -i` stderr 回退解析
2. 用 `filter_map` + `split('x')` + `parse::<u32>()` 严格校验
3. 过滤 `height >= 10_000_000`（十六进制 token 如 0x31637661）
4. 编码器从 `libopenh264` 改为 `libx264`（npm ffmpeg-static 不含 libopenh264）
5. 所有 ffmpeg 调用用 `hidden_command()` 包装（Windows 禁止弹 CMD 窗口）

**具体改动**:

```rust
// === 文件开头新增 hidden_command 函数 ===
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

// === enhance_video 函数中，替换 else 分支 ===
// ❌ 旧：
} else {
    (1920, 1080)  // 硬编码！旅游版当前代码
};

// ✅ 新（完整替换 else 块）:
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
                    if found.is_some() { break; }
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

// === 编码器切换 ===
// ❌ 旧: .arg("libopenh264")
// ✅ 新: .arg("libx264")

// === 所有 Command::new 改为 hidden_command ===
// 图片超分: Command::new(&binary_path) → hidden_command(&binary_path)
// 视频超分: Command::new(&ffmpeg_binary) → hidden_command(&ffmpeg_binary)
// ffprobe:   Command::new(&ffprobe_path) → hidden_command(&ffprobe_path)

// === ffprobe 分支 plus: 增加日志 ===
info!("[EnhanceVideo] ffprobe_path={} exists={}",
    ffprobe_path.display(), ffprobe_path.exists());
```

---

## 验证步骤

1. `cargo check` + `npx tsc --noEmit` 零错误
2. HappyHorse 1.1 视频生成：观察日志确认嵌套 status 被正确识别
3. 刷新页面后 HappyHorse 任务自动恢复轮询
4. 9:16 竖屏视频本地超分 → 输出保持 9:16（日志显示 `720x1280 -> 1440x2560`）
5. 16:9 横屏视频本地超分 → 输出保持 16:9

## 涉及文件总览

| 文件 | Bug |
|------|-----|
| `src-tauri/src/ai/providers/happyhorse/mod.rs` | Bug 1 |
| `src/features/videoGeneration/VideoGenDialog.tsx` | Bug 2, Bug 3 |
| `src-tauri/src/commands/enhance.rs` | Bug 4 |
