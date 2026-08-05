# 多用户视频生成数据隔离修复 + 新用户激活弹窗修复

## 修复

### 视频生成数据隔离
- **videogen_store 迁移 rename→copy**：`migrate_old_user_data` 中 `std::fs::rename` 会把全局 `videogen_store.json` 移动到第一个登录用户目录，导致后续用户迁移时源文件已不存在。改为 `std::fs::copy`，全局文件保留供所有用户迁移使用。合并分支同样不再删除全局文件。
- **移除 videogen_store_path 全局 fallback**：`CURRENT_USER_ID` 为空时不再回退到全局 `app_data_dir`，直接报错。避免模块初始化时以空用户身份读到错误数据。
- **移除模块级 hydrate 调用**：`hydrateVideoGenStore()` 不再在 `videoGenStore.ts` import 时自动执行（此时 `CURRENT_USER_ID` 为空），改为仅在登录后回调触发（`handleLoginSuccess` / `bananaInitialize` / `sync-data-updated`）。
- **hydrate 空数据时强制清空**：从文件读到空数据时，将 `configs` 和 `history` 显式设为 `{}`，避免旧数据的 `_hydrated: true` 导致 `seededRef` 跳过重新播种。
- **登出时 reset video gen store**：登出时调用 `useVideoGenStore.getState().reset()` 清除内存和 localStorage，防止下一用户看到上一用户的视频记录。
- **关闭窗口前 flush video gen 数据**：`beforeunload` 同步写 localStorage 备份，`flush-before-close` 异步强制落盘（绕过 500ms debounce），防止关闭时丢数据。

### 新用户激活弹窗
- **ActualLoginResponse 缺少 needs_activation 字段**：服务器返回 `needs_activation: true` 但 Rust 结构体没有该字段，导致序列化时被丢弃，前端永远收不到 `needs_activation=true`，弹窗不触发。结构体新增 `#[serde(default)] needs_activation: bool`，自建登录分支固定 `false`。
- **弹窗关闭时序错误**：`handleAccountActivated` 中 `setShowAccountActivation(false)` 在 `await bananaCheckCredits()` 之前执行，导致弹窗关闭后 API 密钥还没同步完成。`setShowAccountActivation(false)` 移到 `finally` 块确保密钥就绪后才关闭。
- **激活回调未 await**：`AccountActivationDialog` 中 `onActivated()` 缺少 `await`，异步流程未完成就重置 loading 状态。

## 改动文件

- `src-tauri/src/sync/mod.rs` — migrate_old_user_data: rename→copy，移除 remove_file
- `src-tauri/src/commands/chat.rs` — videogen_store_path 移除全局 fallback
- `src-tauri/src/commands/banana_api.rs` — ActualLoginResponse 新增 needs_activation 字段
- `src/features/videoGeneration/videoGenStore.ts` — 新增 reset()，移除模块级 hydrate，空数据清空 configs/history
- `src/App.tsx` — beforeunload/close/logout 增加 video gen 数据 flush 和 reset；激活弹窗关闭移到 finally
- `src/components/AccountActivationDialog.tsx` — onActivated 加 await
