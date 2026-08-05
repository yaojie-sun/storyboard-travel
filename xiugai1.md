# 2026-05-18 修改记录：修复跨设备数据同步超时问题

## 问题描述

退出时同步推送卡住，60s 超时实际上需要 97s 才触发，七牛云 `xiaoya-ai/` 目录无任何文件。

## 根因分析

两个关键问题叠加导致同步完全不可用：

### 1. 跨 runtime 的 tokio::sync::Mutex 死锁

- `SyncManager::init` 和 `do_push` 分别在**不同的独立 tokio runtime** 中运行
- `tokio::sync::Mutex` 的唤醒机制是 per-runtime 的，跨 runtime 时 `lock().await` 永远无法被唤醒
- `do_push` 第一步 `set_status()` 就尝试获取锁，直接死锁

### 2. std::fs 阻塞 I/O 占用 tokio worker

- `do_push` / `do_pull` 中大量使用 `std::fs::read`、`std::fs::write`、`std::fs::read_dir`
- 这些同步 I/O 直接阻塞 tokio worker 线程，导致 `tokio::time::timeout` 无法正常取消 future

## 修改方案

| 文件 | 改动说明 |
|------|----------|
| `src-tauri/src/sync/mod.rs` | ① `tokio::sync::Mutex` → `std::sync::Mutex`（确保跨 runtime 可用）② 全部 `std::fs::*` 调用封装为 `tokio::task::spawn_blocking` ③ 每个 Qiniu 操作加 30s 独立超时 ④ `init()` 改为直接 await `do_pull` 而非 spawn ⑤ 添加详细的 step1~step5 分步日志 |
| `src-tauri/src/lib.rs` | 关闭处理改用 `std::thread::spawn` + 独立 `tokio::runtime::Builder::new_multi_thread()` |
| `src-tauri/src/commands/banana_api.rs` | 三处 `SyncManager::init` 调用改用 `std::thread::spawn` + 独立 runtime |

## 架构要点

- 同步操作使用独立线程 + 独立 tokio runtime，与 Tauri 主 runtime 完全隔离
- 跨 runtime 共享状态必须用 `std::sync::Mutex`，且 guard 不能在 `.await` 期间持有
- 所有文件 I/O 统一走 `spawn_blocking`

## 验证结果

- 登录后自动 do_pull：正确检测新用户（远程 404），不卡住
- 退出时 do_push：1 秒内完成全部上传（db + chat + settings + globals + manifest）
- 关闭遮罩弹窗：正常显示"正在同步云端..."，同步完成后自动关闭窗口
- 七牛云 `xiaoya-ai/users/{user_id}/` 文件正常

---

# 2026-05-19 修改记录：七牛云 SDK 替换为原始 HTTP + HMAC 签名

## 问题

Qiniu SDK（qiniu-sdk 0.2.4）在 Tauri runtime 下出现间歇性挂起（在 `#[tokio::test]` 中正常），且每次代码改动后 SDK 上传可能卡住，导致应用启动时"正在加载项目数据..."一直卡住。

## 根因

SDK 内部使用 `qiniu-reqwest` 的 async HTTP，在 Tauri runtime 与独立 sync runtime 之间可能存在 tokio 版本不兼容或 reactor 冲突。

## 方案：用原始 reqwest + 手动 HMAC-SHA1 签名替代 SDK

直接在 `src-tauri/src/sync/qiniu.rs` 实现所有七牛云 API 操作，包括：

- 手动实现 HMAC-SHA1（RFC 2104），完全避免 `hmac` crate 兼容性问题
- 使用 `reqwest::Client`（10s timeout + 5s connect timeout）
- 上传 token 生成：`{AK}:{urlsafe_b64(HMAC-SHA1(SK, urlsafe_b64(put_policy)))}:{urlsafe_b64(put_policy)}`
- 下载签名 URL：`{url}?e={deadline}&token={AK}:{urlsafe_b64(HMAC-SHA1(SK, url?e=deadline))}`
- QBox 管理认证：`QBox {AK}:{urlsafe_b64(HMAC-SHA1(SK, path\nbody))}`

## 关键踩坑：Base64 Padding

**这是最隐蔽的 bug。** 七牛云要求 URL-Safe Base64 **带 padding（`=`）**，即 `base64::URL_SAFE`（非 `URL_SAFE_NO_PAD`）。

| 编码方式 | 结果 | 七牛云 |
|----------|------|--------|
| `URL_SAFE_NO_PAD` | `eyJ...ifQ` | BadToken |
| `URL_SAFE`（带 `=`） | `eyJ...ifQ==` | 正常 |

Python `urlsafe_b64encode().rstrip('=')` 也是同样的错误。七牛 SDK 内部使用 `base64::encode_config(data, base64::URL_SAFE)` 是带 padding 的。

## Cargo.toml 变更

- 移除 `qiniu-sdk`（0.2.4）
- 移除 `hmac = "0.12"`（不再需要）
- 保留 `sha1 = "0.10"`（手动 HMAC 实现直接使用）
- 保留 `base64 = "0.22"`、`reqwest = { version = "0.12", features = ["json", "multipart", "stream"] }`

## 验证

- HMAC-SHA1 已知向量测试（RFC 2202）通过
- Token 格式测试通过
- 实际上传 → 下载验证 → 清理删除 全流程测试通过
- `cargo check` 编译通过（仅 3 个预存 warning）

---

# 2026-05-19 修改记录：修复同步后项目状态丢失 + 仪表盘子项目焦点

## 问题

1. 切换用户后项目变 null，卡在"正在加载项目数据..."
2. 新建项目进入仪表盘，没自动选中子项目，用户可进入空画布以为数据丢了
3. 新建的第一个子项目叫"第一集"而非"子项目1"

## 根因

1. `forceRehydrate` 被 sync 事件反复调用，每次设 `isHydrated: false` 和 `currentProjectId: null`，摧毁项目状态
2. 仪表盘没有自动创建首个子项目 + 无焦点时不该允许进入画布

## 修改

| 文件 | 改动 |
|------|------|
| `src/stores/projectStore.ts` | `forceRehydrate` 改为仅刷新项目列表，不动 `isHydrated` 和 `currentProjectId` |
| `src/features/project/ProjectDashboard.tsx` | 新增自动创建逻辑：子项目列表为空时自动创建"子项目1"并聚焦 |
| `src/features/project/ProjectManager.tsx` | `'第一集'` → `t('episode.defaultName', { number: 1 })`（两处） |
| `src/commands/ai.ts` | `triggerPaymentRequired` 透传 `type`/`title`/`description` 到事件 |
| `src/App.tsx` | 两处 PaymentDialog 补传 `type`/`title`/`description` props |
