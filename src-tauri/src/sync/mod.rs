pub mod manifest;
pub mod qiniu;
pub mod qiniu_config;

use crate::sync::manifest::{diff_is_empty, FileEntry, SyncDirection, SyncManifest};
use crate::commands::project_state::EpisodeRecord;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use std::sync::Mutex;

/// 迁移完成后，更新 DB 中所有图片路径，从旧 root/images 前缀替换为新 users/{id}/images 前缀
fn update_image_paths_in_db(user_dir: &Path, root: &Path) {
    let db_path = user_dir.join("projects.db");
    if !db_path.exists() {
        return;
    }

    let Ok(conn) = rusqlite::Connection::open(&db_path) else {
        return;
    };

    let old_images_dir = root.join("images");
    let new_images_dir = user_dir.join("images");
    let old_prefix = old_images_dir.to_string_lossy().to_string();
    let new_prefix = new_images_dir.to_string_lossy().to_string();

    if old_prefix == new_prefix {
        return;
    }

    // 更新 projects 表中的 nodes_json、history_json
    if let Err(e) = conn.execute(
        "UPDATE projects SET nodes_json = REPLACE(nodes_json, ?1, ?2), history_json = REPLACE(history_json, ?1, ?2)",
        rusqlite::params![old_prefix, new_prefix],
    ) {
        tracing::warn!("[migrate] 更新 projects 图片路径失败: {e}");
    }

    // 更新 episodes 表
    if let Err(e) = conn.execute(
        "UPDATE episodes SET nodes_json = REPLACE(nodes_json, ?1, ?2), history_json = REPLACE(history_json, ?1, ?2)",
        rusqlite::params![old_prefix, new_prefix],
    ) {
        tracing::warn!("[migrate] 更新 episodes 图片路径失败: {e}");
    }

    // 更新 image refs 表
    if let Err(e) = conn.execute(
        "UPDATE project_image_refs SET path = REPLACE(path, ?1, ?2)",
        rusqlite::params![old_prefix, new_prefix],
    ) {
        tracing::warn!("[migrate] 更新 image refs 路径失败: {e}");
    }

    tracing::info!("[migrate] 图片路径已更新: {} → {}", old_prefix, new_prefix);
}

/// Merge two chat conversation JSON arrays, keeping the version with more messages per ID.
/// Local data takes priority when message counts are equal.
fn merge_chat_json(local_path: &std::path::Path, remote_bytes: &[u8]) -> Result<Vec<u8>, String> {
    // Parse remote
    let remote: Vec<serde_json::Value> = serde_json::from_slice(remote_bytes)
        .map_err(|e| format!("parse remote chat: {e}"))?;

    // Read local
    let local: Vec<serde_json::Value> = if local_path.exists() {
        match std::fs::read_to_string(local_path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => vec![],
        }
    } else {
        vec![]
    };

    if local.is_empty() {
        return Ok(remote_bytes.to_vec());
    }

    // Merge by id: keep entry with more messages; use updatedAt as tiebreaker
    let mut map: HashMap<String, serde_json::Value> = HashMap::new();
    for conv in local.into_iter().chain(remote) {
        if let Some(id) = conv.get("id").and_then(|v| v.as_str()) {
            let key = id.to_string();
            if let Some(existing) = map.get(&key) {
                let existing_msgs = existing.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0);
                let new_msgs = conv.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0);
                if new_msgs > existing_msgs {
                    map.insert(key, conv);
                } else if new_msgs == existing_msgs {
                    // 消息数相同，选 updatedAt 更晚的（与前端逻辑一致）
                    let existing_ts = existing.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
                    let new_ts = conv.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
                    if new_ts > existing_ts {
                        map.insert(key, conv);
                    }
                }
            } else {
                map.insert(key, conv);
            }
        }
    }

    let merged: Vec<serde_json::Value> = map.into_values().collect();
    serde_json::to_vec(&merged).map_err(|e| format!("serialize merged chat: {e}"))
}

/// 同步状态（通过 Tauri 事件发送给前端）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncStatus {
    pub state: String, // "idle" | "syncing" | "synced" | "error"
    pub message: String,
    pub last_sync_time: Option<u64>,
}

// ─── 当前用户 ID（用于路径隔离） ───

static CURRENT_USER_ID: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

pub fn set_current_user_id(user_id: &str) {
    *CURRENT_USER_ID.write().unwrap() = Some(user_id.to_string());
}

pub fn clear_current_user_id() {
    *CURRENT_USER_ID.write().unwrap() = None;
}

pub fn get_current_user_id() -> Option<String> {
    CURRENT_USER_ID.read().unwrap().clone()
}

/// 获取当前用户的本地数据目录: app_data_dir/users/{user_id}/
/// 首次调用时自动从旧版本（根目录平铺）迁移数据到新用户目录。
pub fn get_user_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let user_id = CURRENT_USER_ID.read().unwrap().clone().unwrap_or_default();
    if user_id.is_empty() {
        return Err("用户尚未登录，无法确定数据目录".into());
    }
    let dir = app_data_dir.join("users").join(&user_id);
    std::fs::create_dir_all(&dir).ok();

    // 从旧版本（< v6.0.38）迁移数据：旧数据在 app_data_dir 根目录平铺，新数据在 users/{id}/ 下
    migrate_old_user_data(&app_data_dir, &dir);

    // 旅游版是独立产品线，不从其他 App 迁移数据

    Ok(dir)
}

/// 将旧版本 (< v6.0.38) 根目录的数据迁移到 users/{id}/ 目录。
/// 迁移完成后写入 .migrated 标记文件，后续调用直接跳过。
fn migrate_old_user_data(root: &std::path::Path, user_dir: &std::path::Path) {
    use tracing::info;

    let marker = user_dir.join(".migrated");
    if marker.exists() {
        return;
    }

    // 1) projects.db — 新旧都有则保留更大的（老数据含全部项目）
    let old_db = root.join("projects.db");
    let new_db = user_dir.join("projects.db");
    if old_db.exists() {
        if !new_db.exists() {
            if let Err(e) = std::fs::rename(&old_db, &new_db) {
                tracing::warn!("[migrate] projects.db 迁移失败: {e}");
            } else {
                info!("[migrate] projects.db → users/");
            }
        } else {
            // 新旧都有 → 比较大小，保留更大的
            let old_size = std::fs::metadata(&old_db).map(|m| m.len()).unwrap_or(0);
            let new_size = std::fs::metadata(&new_db).map(|m| m.len()).unwrap_or(0);
            if old_size > new_size {
                let bak = user_dir.join("projects.db.bak");
                let _ = std::fs::rename(&new_db, &bak);
                match std::fs::rename(&old_db, &new_db) {
                    Ok(_) => {
                        let _ = std::fs::remove_file(&bak);
                        info!("[migrate] projects.db 替换为新版 (旧 {} > 新 {})", old_size, new_size);
                    }
                    Err(e) => {
                        // 恢复新文件
                        let _ = std::fs::rename(&bak, &new_db);
                        tracing::warn!("[migrate] projects.db 替换失败: {e}");
                    }
                }
            } else {
                // 新文件 ≥ 旧文件，删掉旧的即可
                let _ = std::fs::remove_file(&old_db);
                info!("[migrate] projects.db 保留新版 (新 {} >= 旧 {})", new_size, old_size);
            }
        }
    }

    // 2) chat_conversations.json — 使用合并逻辑而非简单移动
    let old_chat = root.join("chat_conversations.json");
    let new_chat = user_dir.join("chat_conversations.json");
    if old_chat.exists() {
        if !new_chat.exists() {
            if let Err(e) = std::fs::rename(&old_chat, &new_chat) {
                tracing::warn!("[migrate] chat_conversations.json 迁移失败: {e}");
            } else {
                info!("[migrate] chat_conversations.json → users/");
            }
        } else {
            // 新旧都有 → 合并后写回新位置，旧文件删掉
            match std::fs::read(&old_chat) {
                Ok(old_bytes) => {
                    match merge_chat_json(&new_chat, &old_bytes) {
                        Ok(merged) => {
                            if let Err(e) = std::fs::write(&new_chat, &merged) {
                                tracing::warn!("[migrate] chat 合并写入失败: {e}");
                            } else {
                                let _ = std::fs::remove_file(&old_chat);
                                info!("[migrate] chat_conversations.json 已合并迁移");
                            }
                        }
                        Err(e) => tracing::warn!("[migrate] chat 合并解析失败: {e}"),
                    }
                }
                Err(e) => tracing::warn!("[migrate] 读取旧 chat 失败: {e}"),
            }
        }
    }

    // 3) images/ — 逐文件迁移
    let old_images = root.join("images");
    let new_images = user_dir.join("images");
    if old_images.is_dir() {
        let _ = std::fs::create_dir_all(&new_images);
        if let Ok(entries) = std::fs::read_dir(&old_images) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let target = new_images.join(&name);
                if !target.exists() {
                    std::fs::rename(entry.path(), &target).ok();
                }
            }
        }
        // 旧目录空则删除
        if std::fs::read_dir(&old_images).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(&old_images);
        }
    }

    // 4) assets/ — 逐文件迁移
    let old_assets = root.join("assets");
    let new_assets = user_dir.join("assets");
    if old_assets.is_dir() {
        let _ = std::fs::create_dir_all(&new_assets);
        if let Ok(entries) = std::fs::read_dir(&old_assets) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let target = new_assets.join(&name);
                if !target.exists() {
                    // 递归移动子目录（如 assets/{uuid}/character）
                    rename_recursive(&entry.path(), &target).ok();
                }
            }
        }
        if std::fs::read_dir(&old_assets).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(&old_assets);
        }
    }

    // 5) projects/ — 逐项目目录迁移
    let old_projects = root.join("projects");
    let new_projects = user_dir.join("projects");
    if old_projects.is_dir() {
        let _ = std::fs::create_dir_all(&new_projects);
        if let Ok(entries) = std::fs::read_dir(&old_projects) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let target = new_projects.join(&name);
                if !target.exists() {
                    rename_recursive(&entry.path(), &target).ok();
                }
            }
        }
        if std::fs::read_dir(&old_projects).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(&old_projects);
        }
    }

    // 6) 更新 DB 中的图片路径（images 目录已迁移，路径需同步更新）
    update_image_paths_in_db(user_dir, root);

    // 6) settings.json — 新旧都有则合并（新值优先）
    let old_settings = root.join("settings.json");
    let new_settings = user_dir.join("settings.json");
    if old_settings.exists() {
        if !new_settings.exists() {
            if let Err(e) = std::fs::rename(&old_settings, &new_settings) {
                tracing::warn!("[migrate] settings.json 迁移失败: {e}");
            } else {
                info!("[migrate] settings.json → users/");
            }
        } else {
            // 合并：新 settings 覆盖旧 settings 的同名 key，保留旧 settings 中独有字段
            match (
                std::fs::read_to_string(&old_settings),
                std::fs::read_to_string(&new_settings),
            ) {
                (Ok(old_str), Ok(new_str)) => {
                    let mut merged: serde_json::Value =
                        serde_json::from_str(&old_str).unwrap_or_default();
                    let new_json: serde_json::Value =
                        serde_json::from_str(&new_str).unwrap_or_default();
                    if let (serde_json::Value::Object(ref mut merged_obj), serde_json::Value::Object(new_obj)) = (&mut merged, &new_json) {
                        for (k, v) in new_obj {
                            merged_obj.insert(k.clone(), v.clone());
                        }
                    }
                    if let Ok(out) = serde_json::to_string_pretty(&merged) {
                        let _ = std::fs::write(&new_settings, &out);
                        let _ = std::fs::remove_file(&old_settings);
                        info!("[migrate] settings.json 已合并迁移");
                    }
                }
                _ => tracing::warn!("[migrate] settings.json 读取失败，跳过合并"),
            }
        }
    }

    // 7) videos/ — 全局 → 用户目录
    let old_videos = root.join("videos");
    let new_videos = user_dir.join("videos");
    if old_videos.is_dir() {
        let _ = std::fs::create_dir_all(&new_videos);
        if let Ok(entries) = std::fs::read_dir(&old_videos) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let target = new_videos.join(&name);
                if !target.exists() {
                    std::fs::rename(entry.path(), &target).ok();
                }
            }
        }
        if std::fs::read_dir(&old_videos).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(&old_videos);
        }
    }

    // 8) videogen_store.json — 合并迁移
    let old_vg = root.join("videogen_store.json");
    let new_vg = user_dir.join("videogen_store.json");
    if old_vg.exists() {
        if !new_vg.exists() {
            // 用 copy 而非 rename：全局文件需要保留给其他用户迁移使用
            let _ = std::fs::copy(&old_vg, &new_vg);
        } else {
            // 合并：新 store 中已有的 configs/history key 保留，补入旧 store 中独有的
            if let (Ok(old_str), Ok(new_str)) = (
                std::fs::read_to_string(&old_vg),
                std::fs::read_to_string(&new_vg),
            ) {
                let mut merged: serde_json::Value =
                    serde_json::from_str(&new_str).unwrap_or_default();
                let old_json: serde_json::Value =
                    serde_json::from_str(&old_str).unwrap_or_default();
                if let (serde_json::Value::Object(ref mut m), serde_json::Value::Object(o)) =
                    (&mut merged, &old_json)
                {
                    for (k, v) in o {
                        if !m.contains_key(k.as_str()) {
                            m.insert(k.clone(), v.clone());
                        }
                    }
                }
                if let Ok(out) = serde_json::to_string_pretty(&merged) {
                    let _ = std::fs::write(&new_vg, &out);
                    // 全局文件保留不删，供其他用户迁移使用
                    info!("[migrate] videogen_store.json 已合并迁移");
                }
            }
        }
    }

    // 写入标记，后续启动跳过迁移
    let _ = std::fs::write(&marker, b"1");
    info!("[migrate] 迁移完成，已标记 .migrated");
}

/// 跨 App 标识符迁移：从旧版目录 copy 数据到新版目录
/// 全部使用 copy（不 rename），保留旧目录供专业版继续使用
fn cross_migrate_from(old_app_dir: &std::path::Path, user_dir: &std::path::Path, user_id: &str) {
    use tracing::info;

    let old_user_dir = old_app_dir.join("users").join(user_id);
    let sources: Vec<&std::path::Path> = if old_user_dir.exists() {
        vec![&old_user_dir]
    } else {
        // 旧版可能使用平铺结构（数据直接在 app_data_dir 下）
        vec![old_app_dir]
    };

    for src_root in sources {
        // 逐个文件 copy，跳过已存在的
        let files = [
            "projects.db",
            "videogen_store.json",
            "settings.json",
        ];
        for name in &files {
            let src = src_root.join(name);
            let dst = user_dir.join(name);
            if src.exists() && !dst.exists() {
                if let Err(e) = std::fs::copy(&src, &dst) {
                    tracing::warn!("[cross_migrate] copy {} failed: {}", name, e);
                } else {
                    info!("[cross_migrate] {} → users/", name);
                }
            }
        }

        // chat_conversations.json — 双方都有时 merge，避免覆盖本地独有对话
        let chat_src = src_root.join("chat_conversations.json");
        let chat_dst = user_dir.join("chat_conversations.json");
        if chat_src.exists() {
            if !chat_dst.exists() {
                if let Err(e) = std::fs::copy(&chat_src, &chat_dst) {
                    tracing::warn!("[cross_migrate] copy chat failed: {}", e);
                } else {
                    info!("[cross_migrate] chat_conversations.json → users/");
                }
            } else {
                // 双方都有的情况用 merge_chat_json 合并（local=旧版, remote=新版）
                if let Ok(remote_bytes) = std::fs::read(&chat_src) {
                    match merge_chat_json(&chat_dst, &remote_bytes) {
                        Ok(merged) => {
                            if let Err(e) = std::fs::write(&chat_dst, &merged) {
                                tracing::warn!("[cross_migrate] merge chat write failed: {}", e);
                            } else {
                                info!("[cross_migrate] chat_conversations.json 已合并");
                            }
                        }
                        Err(e) => tracing::warn!("[cross_migrate] merge chat failed: {}", e),
                    }
                }
            }
        }

        // 递归 copy 目录
        let dirs = ["images", "videos", "assets", "projects"];
        for dir_name in &dirs {
            let src_dir = src_root.join(dir_name);
            let dst_dir = user_dir.join(dir_name);
            if src_dir.is_dir() {
                copy_dir_recursive(&src_dir, &dst_dir);
            }
        }
    }
}

/// 递归 copy 目录（逐文件 copy，跳过已存在的文件）
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) {
    use tracing::info;
    if let Ok(entries) = std::fs::read_dir(src) {
        std::fs::create_dir_all(dst).ok();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let src_path = entry.path();
            let dst_path = dst.join(&name);
            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dst_path);
            } else if !dst_path.exists() {
                if let Err(e) = std::fs::copy(&src_path, &dst_path) {
                    tracing::warn!("[cross_migrate] copy {:?} failed: {}", src_path, e);
                } else {
                    info!("[cross_migrate] {:?} copied", name);
                }
            }
        }
    }
}

/// 递归重命名目录（std::fs::rename 不支持跨文件系统，此处仅同一磁盘用）
fn rename_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let name = entry.file_name();
            rename_recursive(&entry.path(), &dst.join(name))?;
        }
        std::fs::remove_dir(src)?;
    } else {
        std::fs::rename(src, dst)?;
    }
    Ok(())
}

// ─── SyncManager ───

static SYNC_MANAGER: std::sync::OnceLock<Arc<Mutex<Option<SyncManager>>>> = std::sync::OnceLock::new();

pub fn get_sync_manager() -> &'static Arc<Mutex<Option<SyncManager>>> {
    SYNC_MANAGER.get_or_init(|| Arc::new(Mutex::new(None)))
}

pub fn lock_sync_manager() -> std::sync::MutexGuard<'static, Option<SyncManager>> {
    get_sync_manager().lock().unwrap_or_else(|e| {
        tracing::warn!("SyncManager lock was poisoned, recovering");
        e.into_inner()
    })
}

pub struct SyncManager {
    app: AppHandle,
    user_prefix: String,
    user_id: String,
    local_manifest: SyncManifest,
    remote_manifest: Option<SyncManifest>,
    status: SyncStatus,
    pending_remote_db_path: Option<PathBuf>,
}

// ─── spawn_blocking 封装，避免阻塞 tokio worker ───

async fn read_file(path: PathBuf) -> Result<Vec<u8>, String> {
    let p = path.clone();
    tokio::task::spawn_blocking(move || std::fs::read(&p).map_err(|e| format!("read {:?}: {e}", p)))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
}

async fn write_file(path: PathBuf, data: Vec<u8>) -> Result<(), String> {
    let p = path.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&p, &data).map_err(|e| format!("write {:?}: {e}", p))
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

async fn file_exists(path: PathBuf) -> bool {
    tokio::task::spawn_blocking(move || path.exists())
        .await
        .unwrap_or(false)
}

async fn read_dir_entries(dir: PathBuf) -> Result<Vec<(String, PathBuf, bool)>, String> {
    tokio::task::spawn_blocking(move || {
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("read_dir {:?}: {e}", dir))? {
            let entry = entry.map_err(|e| format!("entry: {e}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            entries.push((name, path, is_file));
        }
        Ok(entries)
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

async fn is_dir(path: PathBuf) -> bool {
    tokio::task::spawn_blocking(move || path.is_dir())
        .await
        .unwrap_or(false)
}

async fn qiniu_download_with_timeout(key: &str, label: &str, timeout_secs: u64) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        qiniu::download(key),
    )
    .await
    {
        Ok(Ok(data)) => Ok(data),
        Ok(Err(e)) => Err(format!("{label}: {e}")),
        Err(_) => Err(format!("{label}: timed out after {}s", timeout_secs)),
    }
}

async fn qiniu_upload_with_timeout(key: &str, data: Vec<u8>, label: &str, timeout_secs: u64) -> Result<(), String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        qiniu::upload(key, &data),
    )
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("{label}: {e}")),
        Err(_) => Err(format!("{label}: timed out after {timeout_secs}s")),
    }
}

impl SyncManager {
    /// 初始化同步管理器 — 只做轻量状态设置，用户目录由 get_user_dir() 按 user_id 隔离
    pub async fn init(app: AppHandle, user_id: &str) -> Result<(), String> {
        let user_prefix = format!("xiaoya-ai/users/{}", user_id);

        // 确保用户目录存在
        let _ = get_user_dir(&app)?;

        {
            let mut lock = lock_sync_manager();
            *lock = Some(SyncManager {
                app: app.clone(),
                user_prefix: user_prefix.clone(),
                user_id: user_id.to_string(),
                local_manifest: SyncManifest::default(),
                remote_manifest: None,
                status: SyncStatus {
                    state: "idle".into(),
                    message: String::new(),
                    last_sync_time: None,
                },
                pending_remote_db_path: None,
            });
        }
        Ok(())
    }

    /// 获取同步状态
    pub async fn get_status() -> SyncStatus {
        let lock = lock_sync_manager();
        match lock.as_ref() {
            Some(sm) => sm.status.clone(),
            None => SyncStatus {
                state: "idle".into(),
                message: "未登录".into(),
                last_sync_time: None,
            },
        }
    }

    /// 从七牛拉取更新
    pub async fn do_pull(app: &AppHandle) -> Result<(), String> {
        let (user_prefix, local_manifest) = {
            let lock = lock_sync_manager();
            let sm = lock.as_ref().ok_or("SyncManager not initialized")?;
            (sm.user_prefix.clone(), sm.local_manifest.clone())
        };

        tracing::info!("[sync] do_pull: starting for prefix={}", user_prefix);
        set_status("syncing", "正在下载清单...").await;

        let manifest_key = format!("{}/manifest.json", &user_prefix);
        let remote_manifest: SyncManifest = match qiniu_download_with_timeout(&manifest_key, "pull manifest", 30).await {
            Ok(bytes) => {
                tracing::info!("[sync] do_pull: manifest downloaded ({} bytes)", bytes.len());
                serde_json::from_slice(&bytes).unwrap_or_default()
            }
            Err(e) => {
                tracing::info!("[sync] do_pull: no remote manifest — new user ({e})");
                {
                    let mut lock = lock_sync_manager();
                    if let Some(sm) = lock.as_mut() {
                        sm.remote_manifest = Some(SyncManifest::default());
                    }
                }
                set_status("synced", "新账户，无远端数据").await;
                return Ok(());
            }
        };

        let diff = SyncManifest::compare(&local_manifest, &remote_manifest);

        // 磁盘校验：本地 manifest 认为存在但磁盘上缺失的 → 强制下载
        let user_dir = get_user_dir(app)?;
        let mut diff = diff;
        for name in remote_manifest.videos.keys() {
            let path = user_dir.join("videos").join(name);
            if !path.exists() && !diff.videos_to_download.contains(name) {
                tracing::info!("[sync] do_pull: video {} missing on disk, force download", name);
                diff.videos_to_download.push(name.clone());
            }
        }
        for name in remote_manifest.images.keys() {
            let path = user_dir.join("images").join(name);
            if !path.exists() && !diff.images_to_download.contains(name) {
                tracing::info!("[sync] do_pull: image {} missing on disk, force download", name);
                diff.images_to_download.push(name.clone());
            }
        }

        if diff_is_empty(&diff) {
            tracing::info!("[sync] do_pull: no differences, already in sync");
            let mut lock = lock_sync_manager();
            if let Some(sm) = lock.as_mut() {
                sm.remote_manifest = Some(remote_manifest);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                sm.status = SyncStatus {
                    state: "synced".into(),
                    message: "已是最新".into(),
                    last_sync_time: Some(now),
                };
            }
            return Ok(());
        }

        let total = (if diff.db_needs_sync { 1u32 } else { 0 })
            + diff.images_to_download.len() as u32
            + diff.assets_to_download.len() as u32
            + diff.chat_to_download.len() as u32
            + (if diff.settings_needs_sync && diff.settings_direction != Some(SyncDirection::Upload) { 1 } else { 0 })
            + diff.globals_to_download.len() as u32
            + diff.videos_to_download.len() as u32
            + (if diff.videogen_store_needs_sync && diff.videogen_store_direction != Some(SyncDirection::Upload) { 1 } else { 0 });
        tracing::info!("[sync] do_pull: {} items to download", total);
        set_status("syncing", "正在下载更新...").await;

        let emit_progress = |count: u32, label: &str| {
            let payload = serde_json::json!({
                "current": count,
                "total": total,
                "label": label,
                "direction": "pull",
            });
            let _ = app.emit("sync-progress", &payload);
        };

        let mut downloaded_count = 0u32;
        let user_dir = get_user_dir(app)?;

        // db — 下载远端 DB 到临时文件，做项目级合并
        if diff.db_needs_sync {
            let db_key = format!("{}/projects.db", &user_prefix);
            tracing::info!("[sync] do_pull: downloading remote db for merge...");
            match qiniu_download_with_timeout(&db_key, "pull db", 300).await {
                Ok(bytes) => {
                    let tmp_db = user_dir.join("projects.db.remote");
                    if let Err(e) = std::fs::write(&tmp_db, &bytes) {
                        tracing::warn!("[sync] do_pull: write remote db temp failed: {e}");
                    } else {
                        match crate::commands::project_state::merge_remote_db(app, &tmp_db) {
                            Ok(conflicts) if conflicts.is_empty() => {
                                downloaded_count += 1;
                                emit_progress(downloaded_count, "projects.db");
                                let _ = std::fs::remove_file(&tmp_db);
                                tracing::info!("[sync] do_pull: db merged ok (no conflicts)");
                            }
                            Ok(conflicts) => {
                                // 有冲突 → 保存临时文件路径，通知前端
                                {
                                    let mut lock = lock_sync_manager();
                                    if let Some(sm) = lock.as_mut() {
                                        sm.pending_remote_db_path = Some(tmp_db.clone());
                                    }
                                }
                                let _ = app.emit("sync-project-conflicts", &conflicts);
                                tracing::info!("[sync] do_pull: {} conflicts, waiting for user", conflicts.len());
                                set_status("syncing", "检测到项目名冲突，等待确认...").await;
                                return Ok(());
                            }
                            Err(e) => {
                                let _ = std::fs::remove_file(&tmp_db);
                                tracing::warn!("[sync] do_pull: db merge failed: {e}");
                            }
                        }
                    }
                }
                Err(e) => tracing::warn!("[sync] do_pull: download db failed: {e}"),
            }
        }

        // images
        for md5_name in &diff.images_to_download {
            let img_key = format!("{}/images/{}", &user_prefix, md5_name);
            match qiniu_download_with_timeout(&img_key, "pull image", 30).await {
                Ok(bytes) => {
                    write_file(user_dir.join("images").join(md5_name), bytes).await?;
                    downloaded_count += 1;
                    emit_progress(downloaded_count, &format!("图片 {}", md5_name));
                }
                Err(e) => tracing::warn!("[sync] do_pull: download image {} failed: {e}", md5_name),
            }
        }

        // assets
        for asset_key in &diff.assets_to_download {
            let full_key = format!("{}/assets/{}", &user_prefix, asset_key);
            match qiniu_download_with_timeout(&full_key, "pull asset", 30).await {
                Ok(bytes) => {
                    write_file(user_dir.join("assets").join(asset_key), bytes).await?;
                    downloaded_count += 1;
                    emit_progress(downloaded_count, &format!("资源 {}", asset_key));
                }
                Err(e) => tracing::warn!("[sync] do_pull: download asset {} failed: {e}", asset_key),
            }
        }

        // chat — 按项目逐个下载并合并本地文件（跳过 _legacy 占位，由下方兼容逻辑处理）
        let chat_dir = user_dir.join("chat");
        let _ = std::fs::create_dir_all(&chat_dir);
        let legacy_in_diff = diff.chat_to_download.contains(&"_legacy".to_string());
        for pid in &diff.chat_to_download {
            if pid == "_legacy" { continue; }
            let chat_key = format!("{}/chat/{}.json", &user_prefix, pid);
            let local_path = chat_dir.join(format!("{}.json", pid));
            match qiniu_download_with_timeout(&chat_key, "pull chat", 30).await {
                Ok(bytes) => {
                    let result_bytes = if local_path.exists() {
                        match merge_chat_json(&local_path, &bytes) {
                            Ok(merged) => merged,
                            Err(e) => {
                                tracing::error!("[sync] do_pull: chat merge {} FAILED ({}) — keeping local data", pid, e);
                                continue;
                            }
                        }
                    } else {
                        bytes
                    };
                    write_file(local_path, result_bytes).await?;
                    downloaded_count += 1;
                    emit_progress(downloaded_count, &format!("对话记录 {}", pid));
                }
                Err(e) => tracing::warn!("[sync] do_pull: download chat {} failed: {e}", pid),
            }
        }

        // 兼容旧格式：远端 manifest 含 _legacy → 下载旧 chat/conversations.json 并按 projectId 拆分
        if legacy_in_diff {
            let legacy_key = format!("{}/chat/conversations.json", &user_prefix);
            if let Ok(bytes) = qiniu_download_with_timeout(&legacy_key, "pull legacy chat", 30).await {
                if let Ok(convs) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) {
                    // 用 SQLite 查 episode→project 映射，与 chat.rs migrate_chat_storage 逻辑一致
                    let ep_to_project: HashMap<String, String> = {
                        let db_path = user_dir.join("projects.db");
                        if db_path.exists() {
                            match rusqlite::Connection::open(&db_path) {
                                Ok(conn) => {
                                    let mut map = HashMap::new();
                                    if let Ok(mut stmt) = conn.prepare("SELECT id, project_id FROM episodes") {
                                        if let Ok(rows) = stmt.query_map([], |row| {
                                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                                        }) {
                                            for row in rows.flatten() { map.insert(row.0, row.1); }
                                        }
                                    }
                                    map
                                }
                                Err(e) => { tracing::warn!("[sync] legacy chat: open db failed: {e}"); HashMap::new() }
                            }
                        } else { HashMap::new() }
                    };
                    let mut groups: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
                    for mut conv in convs {
                        let pid = conv.get("projectId").and_then(|v| v.as_str()).map(|s| s.to_string())
                            .or_else(|| {
                                conv.get("episodeId").and_then(|v| v.as_str()).and_then(|eid| ep_to_project.get(eid).cloned())
                            })
                            .unwrap_or_else(|| "global".to_string());
                        if !conv.get("projectId").is_some() {
                            conv["projectId"] = serde_json::Value::String(pid.clone());
                        }
                        groups.entry(pid).or_default().push(conv);
                    }
                    for (pid, convs) in groups {
                        let local_path = chat_dir.join(format!("{}.json", pid));
                        let merged = if local_path.exists() {
                            let remote_json = serde_json::to_vec(&convs).unwrap_or_default();
                            merge_chat_json(&local_path, &remote_json).unwrap_or_else(|_| serde_json::to_vec(&convs).unwrap_or_default())
                        } else {
                            serde_json::to_vec(&convs).unwrap_or_default()
                        };
                        if let Err(e) = std::fs::write(&local_path, &merged) {
                            tracing::warn!("[sync] legacy chat: write {} failed: {e}", pid);
                        } else {
                            tracing::info!("[sync] legacy chat: migrated {} ({} conversations)", pid, convs.len());
                        }
                    }
                    // 旧格式文件已处理，清理 _legacy 标记，下次同步用新格式
                    let _ = std::fs::create_dir_all(&chat_dir);
                }
            }
        }

        // settings — 合并而非覆盖，防止丢失迁移后的本地配置
        if diff.settings_needs_sync && diff.settings_direction != Some(SyncDirection::Upload) {
            let settings_key = format!("{}/settings/settings.json", &user_prefix);
            match qiniu_download_with_timeout(&settings_key, "pull settings", 30).await {
                Ok(bytes) => {
                    let settings_path = user_dir.join("settings.json");
                    if settings_path.exists() {
                        // 合并：云端覆盖本地同名 key，保留本地独有 key
                        if let (Ok(local_str), Ok(remote_json)) = (
                            std::fs::read_to_string(&settings_path),
                            serde_json::from_slice::<serde_json::Value>(&bytes),
                        ) {
                            let mut merged: serde_json::Value =
                                serde_json::from_str(&local_str).unwrap_or_default();
                            if let (serde_json::Value::Object(ref mut m), serde_json::Value::Object(r)) = (&mut merged, &remote_json) {
                                for (k, v) in r { m.insert(k.clone(), v.clone()); }
                            }
                            if let Ok(out) = serde_json::to_string_pretty(&merged) {
                                write_file(settings_path, out.into_bytes()).await?;
                                downloaded_count += 1;
                                emit_progress(downloaded_count, "设置");
                            }
                        }
                    } else {
                        write_file(settings_path, bytes).await?;
                        downloaded_count += 1;
                        emit_progress(downloaded_count, "设置");
                    }
                }
                Err(e) => tracing::warn!("[sync] do_pull: download settings failed: {e}"),
            }
        }

        // globals
        for proj_id in &diff.globals_to_download {
            let g_key = format!("{}/projects/{}/globals.md", &user_prefix, proj_id);
            match qiniu_download_with_timeout(&g_key, "pull globals", 30).await {
                Ok(bytes) => {
                    write_file(
                        user_dir
                            .join("projects")
                            .join(proj_id)
                            .join("project_globals.md"),
                        bytes,
                    )
                    .await?;
                    downloaded_count += 1;
                    emit_progress(downloaded_count, &format!("项目 {}", proj_id));
                }
                Err(e) => tracing::warn!("[sync] do_pull: download global {} failed: {e}", proj_id),
            }
        }

        // videos — 下载本地没有的远端视频文件
        let videos_dir = user_dir.join("videos");
        let _ = std::fs::create_dir_all(&videos_dir);
        for name in &diff.videos_to_download {
            let v_key = format!("{}/videos/{}", &user_prefix, name);
            match qiniu_download_with_timeout(&v_key, "pull video", 120).await {
                Ok(bytes) => {
                    write_file(videos_dir.join(name), bytes).await?;
                    downloaded_count += 1;
                    emit_progress(downloaded_count, &format!("视频 {}", name));
                }
                Err(e) => tracing::warn!("[sync] do_pull: download video {} failed: {e}", name),
            }
        }

        // videogen_store — 合并云端与本地
        if diff.videogen_store_needs_sync
            && diff.videogen_store_direction != Some(SyncDirection::Upload)
        {
            let vg_key = format!("{}/videogen_store.json", &user_prefix);
            match qiniu_download_with_timeout(&vg_key, "pull videogen_store", 30).await {
                Ok(bytes) => {
                    let vg_path = user_dir.join("videogen_store.json");
                    if vg_path.exists() {
                        if let (Ok(local_str), Ok(remote_json)) = (
                            std::fs::read_to_string(&vg_path),
                            serde_json::from_slice::<serde_json::Value>(&bytes),
                        ) {
                            let mut merged: serde_json::Value =
                                serde_json::from_str(&local_str).unwrap_or_default();
                            if let (serde_json::Value::Object(ref mut m), serde_json::Value::Object(r)) =
                                (&mut merged, &remote_json)
                            {
                                for (k, v) in r {
                                    if (k == "configs" || k == "history") && m.contains_key(k.as_str()) {
                                        // 深度合并：保留本地独有的 key
                                        if let (Some(serde_json::Value::Object(ref mut mi)), Some(serde_json::Value::Object(ri))) =
                                            (m.get_mut(k.as_str()), r.get(k.as_str()))
                                        {
                                            for (ik, iv) in ri {
                                                mi.entry(ik).or_insert(iv.clone());
                                            }
                                        }
                                    } else {
                                        m.insert(k.clone(), v.clone());
                                    }
                                }
                            }
                            if let Ok(out) = serde_json::to_string_pretty(&merged) {
                                tracing::info!("[sync] do_pull: vg merged ok, path={:?}, bytes={}", vg_path, out.len());
                                write_file(vg_path, out.into_bytes()).await?;
                                downloaded_count += 1;
                                emit_progress(downloaded_count, "视频生成配置");
                            }
                        }
                    } else {
                        tracing::info!("[sync] do_pull: vg write raw, path={:?}, bytes={}", vg_path, bytes.len());
                        write_file(vg_path, bytes).await?;
                        downloaded_count += 1;
                        emit_progress(downloaded_count, "视频生成配置");
                    }
                }
                Err(e) => tracing::warn!("[sync] do_pull: download videogen_store failed: {e}"),
            }
        }

        // 跨文件一致性清理：移除 videogen configs / chat conversations 中
        // 引用 DB 中不存在节点或 episode 的孤立条目
        if downloaded_count > 0 {
            cleanup_cross_file_orphans(&user_dir);
        }

        {
            let mut lock = lock_sync_manager();
            if let Some(sm) = lock.as_mut() {
                sm.local_manifest = remote_manifest.clone();
                sm.remote_manifest = Some(remote_manifest);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                sm.status = SyncStatus {
                    state: "synced".into(),
                    message: format!("下载完成 ({}/{})", downloaded_count, total),
                    last_sync_time: Some(now),
                };
                if downloaded_count > 0 {
                    let _ = sm.app.emit("sync-data-updated", ());
                }
            }
        }
        tracing::info!("[sync] do_pull: complete, downloaded {}/{}", downloaded_count, total);
        Ok(())
    }
}

// ─── 跨文件一致性清理（模块级工具函数） ───

/// 从 DB 收集所有有效的 node ID 和 episode ID
fn collect_valid_ids_from_db(db_path: &Path) -> Result<(HashSet<String>, HashSet<String>), String> {
        let conn = Connection::open(db_path).map_err(|e| format!("open db: {e}"))?;
        let mut node_ids: HashSet<String> = HashSet::new();
        let mut episode_ids: HashSet<String> = HashSet::new();

        // 从 projects.nodes_json 收集 node ID
        {
            let mut stmt = conn
                .prepare("SELECT nodes_json FROM projects")
                .map_err(|e| format!("prepare projects: {e}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("query projects: {e}"))?;
            for row in rows {
                if let Ok(json_str) = row {
                    if let Ok(nodes) = serde_json::from_str::<Vec<serde_json::Value>>(&json_str) {
                        for n in nodes {
                            if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
                                node_ids.insert(id.to_string());
                            }
                        }
                    }
                }
            }
        }

        // 从 episodes 收集 episode ID 和 node ID
        {
            let mut stmt = conn
                .prepare("SELECT id, nodes_json FROM episodes")
                .map_err(|e| format!("prepare episodes: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("query episodes: {e}"))?;
            for row in rows {
                if let Ok((ep_id, nodes_json)) = row {
                    episode_ids.insert(ep_id);
                    if let Ok(nodes) = serde_json::from_str::<Vec<serde_json::Value>>(&nodes_json) {
                        for n in nodes {
                            if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
                                node_ids.insert(id.to_string());
                            }
                        }
                    }
                }
            }
        }

        tracing::info!(
            "[sync] cleanup: collected {} node IDs, {} episode IDs from DB",
            node_ids.len(),
            episode_ids.len()
        );
        Ok((node_ids, episode_ids))
    }

    /// 清理 videogen_store.json 中引用不存在节点的 configs/history 条目
    /// **保护规则**：有实际生成参数或历史记录的条目永不删除
    fn cleanup_videogen_orphans(vg_path: &Path, valid_node_ids: &HashSet<String>) -> Result<usize, String> {
        let content = std::fs::read_to_string(vg_path).map_err(|e| format!("read vg: {e}"))?;
        let mut vg: serde_json::Value = serde_json::from_str(&content).map_err(|e| format!("parse vg: {e}"))?;

        let mut removed = 0;

        if let Some(configs) = vg.get_mut("configs").and_then(|v| v.as_object_mut()) {
            let before = configs.len();
            configs.retain(|k, v| {
                if valid_node_ids.contains(k) {
                    return true; // 节点存在，保留
                }
                // 节点不存在 → 检查是否有实际的参数值（非空对象）
                let has_content = v.as_object()
                    .map(|obj| !obj.is_empty())
                    .unwrap_or(false);
                has_content // 有内容的配置保留
            });
            let diff = before - configs.len();
            if diff > 0 {
                tracing::info!("[sync] cleanup: removed {} orphan videogen configs (empty ones)", diff);
                removed += diff;
            }
        }

        if let Some(history) = vg.get_mut("history").and_then(|v| v.as_object_mut()) {
            let before = history.len();
            history.retain(|k, v| {
                if valid_node_ids.contains(k) {
                    return true; // 节点存在，保留
                }
                let has_content = v.as_object()
                    .map(|obj| !obj.is_empty())
                    .unwrap_or(false);
                has_content // 有历史记录的保留
            });
            let diff = before - history.len();
            if diff > 0 {
                tracing::info!("[sync] cleanup: removed {} orphan videogen history entries (empty ones)", diff);
                removed += diff;
            }
        }

        if removed > 0 {
            let out = serde_json::to_string_pretty(&vg).map_err(|e| format!("serialize vg: {e}"))?;
            std::fs::write(vg_path, out).map_err(|e| format!("write vg: {e}"))?;
        }

        Ok(removed)
    }

    /// 清理 chat/*.json 中引用不存在 episode 的对话（物理隔离格式，每个项目一个文件）
    /// 保留没有 episodeId 的对话（全局对话）
    /// **保护规则**：有 promptBlocks 的对话永不删除（防止付费内容丢失）
    fn cleanup_chat_orphans(chat_path: &Path, valid_episode_ids: &HashSet<String>) -> Result<usize, String> {
        let content = std::fs::read_to_string(chat_path).map_err(|e| format!("read chat: {e}"))?;
        let mut conversations: Vec<serde_json::Value> =
            serde_json::from_str(&content).map_err(|e| format!("parse chat: {e}"))?;

        let before = conversations.len();
        conversations.retain(|conv| {
            match conv.get("episodeId").and_then(|v| v.as_str()) {
                Some(ep_id) if !ep_id.is_empty() => {
                    if valid_episode_ids.contains(ep_id) {
                        return true; // episode 存在，保留
                    }
                    // episode 不存在 → 检查是否有 promptBlocks（用户生成的内容）
                    let has_prompt_blocks = conv
                        .get("messages")
                        .and_then(|v| v.as_array())
                        .map(|msgs| {
                            msgs.iter().any(|m| {
                                m.get("promptBlocks")
                                    .and_then(|pb| pb.as_array())
                                    .map(|arr| !arr.is_empty())
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false);
                    has_prompt_blocks // 有生成内容的对话保留
                }
                _ => true, // 无 episodeId → 全局对话，保留
            }
        });
        let removed = before - conversations.len();

        if removed > 0 {
            tracing::info!("[sync] cleanup: removed {} orphan chat conversations (kept {})", removed, conversations.len());
            let out = serde_json::to_vec(&conversations).map_err(|e| format!("serialize chat: {e}"))?;
            std::fs::write(chat_path, out).map_err(|e| format!("write chat: {e}"))?;
        }

        Ok(removed)
    }

    /// 跨文件一致性清理：同步完成后移除 videogen / chat 中引用不存在 DB 实体的孤立条目
    fn cleanup_cross_file_orphans(user_dir: &Path) {
        let db_path = user_dir.join("projects.db");
        let vg_path = user_dir.join("videogen_store.json");

        if !db_path.exists() {
            return;
        }

        let (valid_node_ids, valid_episode_ids) = match collect_valid_ids_from_db(&db_path) {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("[sync] cleanup: failed to collect valid IDs from DB: {e}");
                return;
            }
        };

        // 清理 videogen_store.json（先备份）
        if vg_path.exists() {
            let bak = vg_path.with_extension("json.bak");
            if let Err(e) = std::fs::copy(&vg_path, &bak) {
                tracing::warn!("[sync] cleanup: backup vg to {:?} failed: {e}", bak);
            } else {
                match cleanup_videogen_orphans(&vg_path, &valid_node_ids) {
                    Ok(n) if n > 0 => tracing::info!("[sync] cleanup: removed {} orphan videogen entries, backup at {:?}", n, bak),
                    Ok(_) => { let _ = std::fs::remove_file(&bak); }
                    Err(e) => tracing::warn!("[sync] cleanup: videogen cleanup failed: {e}"),
                }
            }
        }

        // 清理 chat/ 目录中每个项目的对话文件（物理隔离新格式）
        let chat_dir = user_dir.join("chat");
        if chat_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&chat_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("json") {
                        let bak = path.with_extension("json.bak");
                        let _ = std::fs::copy(&path, &bak);
                        match cleanup_chat_orphans(&path, &valid_episode_ids) {
                            Ok(n) if n > 0 => tracing::info!("[sync] cleanup: removed {} orphans from chat/{:?}", n, path.file_name()),
                            Ok(_) => { let _ = std::fs::remove_file(&bak); }
                            Err(e) => tracing::warn!("[sync] cleanup: chat/{:?} failed: {e}", path.file_name()),
                        }
                    }
                }
            }
        }

        // 兼容清理旧版单文件 chat_conversations.json
        let old_chat_path = user_dir.join("chat_conversations.json");
        if old_chat_path.exists() {
            let bak = old_chat_path.with_extension("json.bak");
            if let Err(e) = std::fs::copy(&old_chat_path, &bak) {
                tracing::warn!("[sync] cleanup: backup old chat to {:?} failed: {e}", bak);
            } else {
                match cleanup_chat_orphans(&old_chat_path, &valid_episode_ids) {
                    Ok(n) if n > 0 => tracing::info!("[sync] cleanup: removed {} orphans from old chat_conversations.json, backup at {:?}", n, bak),
                    Ok(_) => { let _ = std::fs::remove_file(&bak); }
                    Err(e) => tracing::warn!("[sync] cleanup: old chat_conversations.json failed: {e}"),
                }
            }
        }
    }

impl SyncManager {
    /// 用户确认冲突解决后，继续完成 DB 合并
    pub async fn resolve_conflicts(
        app: &AppHandle,
        resolutions: Vec<crate::commands::sync::ConflictResolution>,
    ) -> Result<SyncStatus, String> {
        use std::collections::{HashMap, HashSet};

        let tmp_path = {
            let lock = lock_sync_manager();
            let sm = lock.as_ref().ok_or("SyncManager not initialized")?;
            sm.pending_remote_db_path.clone()
        };
        let tmp_path = tmp_path.ok_or("没有待处理的冲突".to_string())?;

        let user_dir = get_user_dir(app)?;
        let local_path = user_dir.join("projects.db");
        let local = Connection::open(&local_path)
            .map_err(|e| format!("open local db: {e}"))?;
        let remote = Connection::open(&tmp_path)
            .map_err(|e| format!("open remote db: {e}"))?;

        // 读取本地项目元数据
        let mut local_map: HashMap<String, (String, i64)> = HashMap::new(); // id -> (name, updated_at)
        {
            let mut stmt = local
                .prepare("SELECT id, name, updated_at FROM projects")
                .map_err(|e| format!("local query: {e}"))?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
            }).map_err(|e| format!("local rows: {e}"))?;
            for r in rows {
                let (id, name, ua) = r.map_err(|e| format!("row: {e}"))?;
                local_map.insert(id, (name, ua));
            }
        }

        // 读取远程所有项目完整数据
        struct RRow {
            id: String, name: String, created_at: i64, updated_at: i64, node_count: i64,
            nodes_json: String, edges_json: String, viewport_json: String, history_json: String,
            aspect_ratio: String, style: String, tone: String, director_ref: String,
            emphasis_dimensions: String, ai_analysis: String, ai_params: String, global_params_md_path: String,
        }
        let mut remote_rows: Vec<RRow> = Vec::new();
        {
            let mut stmt = remote.prepare(
                "SELECT id,name,created_at,updated_at,node_count,
                        nodes_json,edges_json,viewport_json,history_json,
                        aspect_ratio,style,tone,director_ref,
                        emphasis_dimensions,ai_analysis,ai_params,global_params_md_path
                 FROM projects"
            ).map_err(|e| format!("remote query: {e}"))?;
            let rows = stmt.query_map([], |row| {
                Ok(RRow {
                    id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?,
                    updated_at: row.get(3)?, node_count: row.get(4)?,
                    nodes_json: row.get(5)?, edges_json: row.get(6)?,
                    viewport_json: row.get(7)?, history_json: row.get(8)?,
                    aspect_ratio: row.get(9)?, style: row.get(10)?, tone: row.get(11)?,
                    director_ref: row.get(12)?, emphasis_dimensions: row.get(13)?,
                    ai_analysis: row.get(14)?, ai_params: row.get(15)?,
                    global_params_md_path: row.get(16)?,
                })
            }).map_err(|e| format!("remote rows: {e}"))?;
            for r in rows { remote_rows.push(r.map_err(|e| format!("row: {e}"))?); }
        }

        let overwrite_ids: HashSet<String> = resolutions.iter()
            .filter(|r| r.action == "overwrite")
            .map(|r| r.cloud_id.clone())
            .collect();

        for rr in &remote_rows {
            if let Some((_name, local_ua)) = local_map.get(&rr.id) {
                // 同 ID → 远程更新才覆盖
                if rr.updated_at > *local_ua {
                    local.execute(
                        "UPDATE projects SET name=?,updated_at=?,node_count=?,
                         nodes_json=?,edges_json=?,viewport_json=?,history_json=?,
                         aspect_ratio=?,style=?,tone=?,director_ref=?,
                         emphasis_dimensions=?,ai_analysis=?,ai_params=?,global_params_md_path=?
                         WHERE id=?",
                        rusqlite::params![
                            rr.name, rr.updated_at, rr.node_count,
                            rr.nodes_json, rr.edges_json, rr.viewport_json, rr.history_json,
                            rr.aspect_ratio, rr.style, rr.tone, rr.director_ref,
                            rr.emphasis_dimensions, rr.ai_analysis, rr.ai_params, rr.global_params_md_path,
                            rr.id,
                        ],
                    ).map_err(|e| format!("update {}: {e}", rr.id))?;
                }
            } else {
                // 新项目 → 检查是否有同名冲突且用户未选择覆盖
                let has_conflict = local_map.values().any(|(n, _)| n == &rr.name);
                if has_conflict && !overwrite_ids.contains(&rr.id) {
                    continue; // 用户选择保留本地
                }
                local.execute(
                    "INSERT INTO projects (id,name,created_at,updated_at,node_count,
                     nodes_json,edges_json,viewport_json,history_json,
                     aspect_ratio,style,tone,director_ref,
                     emphasis_dimensions,ai_analysis,ai_params,global_params_md_path)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                    rusqlite::params![
                        rr.id, rr.name, rr.created_at, rr.updated_at, rr.node_count,
                        rr.nodes_json, rr.edges_json, rr.viewport_json, rr.history_json,
                        rr.aspect_ratio, rr.style, rr.tone, rr.director_ref,
                        rr.emphasis_dimensions, rr.ai_analysis, rr.ai_params, rr.global_params_md_path,
                    ],
                ).map_err(|e| format!("insert {}: {e}", rr.id))?;
                // 同步 episodes
                let mut estmt = remote.prepare(
                    "SELECT id,project_id,name,number,nodes_json,edges_json,viewport_json,history_json,created_at,updated_at
                     FROM episodes WHERE project_id=?"
                ).map_err(|e| format!("ep query: {e}"))?;
                let erows: Vec<EpisodeRecord> = estmt.query_map(rusqlite::params![rr.id], |row| {
                    Ok(EpisodeRecord {
                        id: row.get(0)?, project_id: row.get(1)?, name: row.get(2)?,
                        number: row.get(3)?, nodes_json: row.get(4)?, edges_json: row.get(5)?,
                        viewport_json: row.get(6)?, history_json: row.get(7)?,
                        created_at: row.get(8)?, updated_at: row.get(9)?,
                    })
                }).map_err(|e| format!("ep rows: {e}"))?
                .filter_map(|r| r.ok()).collect();
                for ep in &erows {
                    local.execute(
                        "INSERT OR REPLACE INTO episodes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                        rusqlite::params![
                            ep.id, ep.project_id, ep.name, ep.number,
                            ep.nodes_json, ep.edges_json, ep.viewport_json, ep.history_json,
                            ep.created_at, ep.updated_at,
                        ],
                    ).map_err(|e| format!("insert ep {}: {e}", ep.id))?;
                }
            }
        }

        let _ = std::fs::remove_file(&tmp_path);

        // 冲突解决后也做跨文件一致性清理
        cleanup_cross_file_orphans(&user_dir);

        {
            let mut lock = lock_sync_manager();
            if let Some(sm) = lock.as_mut() {
                sm.pending_remote_db_path = None;
                let _ = sm.app.emit("sync-data-updated", ());
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                sm.status = SyncStatus {
                    state: "synced".into(),
                    message: "冲突已解决，合并完成".into(),
                    last_sync_time: Some(now),
                };
            }
        }
        tracing::info!("[sync] resolve_conflicts: done");
        Ok(SyncManager::get_status().await)
    }

    /// 推送到七牛
    pub async fn do_push(app: &AppHandle) -> Result<(), String> {
        tracing::info!("[sync] do_push: ===== START =====");
        set_status("syncing", "正在收集数据...").await;

        let user_prefix = {
            let lock = lock_sync_manager();
            lock.as_ref()
                .map(|sm| sm.user_prefix.clone())
                .unwrap_or_default()
        };
        if user_prefix.is_empty() {
            tracing::error!("[sync] do_push: SyncManager not initialized");
            return Err("SyncManager not initialized".into());
        }

        let user_dir = get_user_dir(app)?;
        tracing::info!("[sync] do_push: user_dir={:?}", user_dir);

        // 上传前做跨文件一致性清理，确保不会上传引用不存在节点的孤立数据
        cleanup_cross_file_orphans(&user_dir);

        // ─── 1. 生成本地 manifest 快照 ───
        let mut local = SyncManifest::default();

        let db_path = user_dir.join("projects.db");
        tracing::info!("[sync] do_push: step1 - reading db, exists={}", db_path.exists());
        if file_exists(db_path.clone()).await {
            let data = read_file(db_path.clone()).await?;
            local.db = Some(FileEntry {
                hash: SyncManifest::compute_hash(&data),
                size: data.len() as u64,
            });
            tracing::info!("[sync] do_push: db snapshot ({} bytes)", data.len());
        }

        let images_dir = user_dir.join("images");
        tracing::info!("[sync] do_push: step1 - reading images dir");
        for (name, path, is_file) in read_dir_entries(images_dir.clone()).await? {
            if is_file {
                let data = read_file(path).await?;
                local.images.insert(
                    name,
                    FileEntry {
                        hash: SyncManifest::compute_hash(&data),
                        size: data.len() as u64,
                    },
                );
            }
        }
        tracing::info!("[sync] do_push: {} images in snapshot", local.images.len());

        let assets_dir = user_dir.join("assets");
        tracing::info!("[sync] do_push: step1 - reading assets dir");
        collect_asset_entries_spawn(&assets_dir).await?
            .into_iter()
            .for_each(|(k, v)| { local.assets.insert(k, v); });
        tracing::info!("[sync] do_push: {} assets in snapshot", local.assets.len());

        // chat — 扫描 chat/ 目录，每项目文件独立追踪
        let chat_dir_snapshot = user_dir.join("chat");
        if chat_dir_snapshot.exists() {
            if let Ok(entries) = std::fs::read_dir(&chat_dir_snapshot) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("json") {
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            let data = std::fs::read(&path).unwrap_or_default();
                            if !data.is_empty() {
                                local.chat.insert(stem.to_string(), FileEntry {
                                    hash: SyncManifest::compute_hash(&data),
                                    size: data.len() as u64,
                                });
                            }
                        }
                    }
                }
            }
        }
        tracing::info!("[sync] do_push: {} chat files in snapshot", local.chat.len());

        let settings_path = user_dir.join("settings.json");
        if file_exists(settings_path.clone()).await {
            let data = read_file(settings_path.clone()).await?;
            local.settings = Some(FileEntry {
                hash: SyncManifest::compute_hash(&data),
                size: data.len() as u64,
            });
        }

        let projects_dir = user_dir.join("projects");
        for (name, path, _) in read_dir_entries(projects_dir.clone()).await? {
            if is_dir(path.clone()).await {
                let g_path = path.join("project_globals.md");
                if file_exists(g_path.clone()).await {
                    let data = read_file(g_path).await?;
                    local.globals.insert(
                        name,
                        FileEntry {
                            hash: SyncManifest::compute_hash(&data),
                            size: data.len() as u64,
                        },
                    );
                }
            }
        }
        tracing::info!("[sync] do_push: {} globals in snapshot", local.globals.len());

        let videos_dir = user_dir.join("videos");
        for (name, path, is_file) in read_dir_entries(videos_dir.clone()).await? {
            if is_file {
                let data = read_file(path).await?;
                local.videos.insert(
                    name,
                    FileEntry {
                        hash: SyncManifest::compute_hash(&data),
                        size: data.len() as u64,
                    },
                );
            }
        }
        tracing::info!("[sync] do_push: {} videos in snapshot", local.videos.len());

        let vg_path = user_dir.join("videogen_store.json");
        if file_exists(vg_path.clone()).await {
            let data = read_file(vg_path.clone()).await?;
            local.videogen_store = Some(FileEntry {
                hash: SyncManifest::compute_hash(&data),
                size: data.len() as u64,
            });
        }

        // ─── 2. 下载远端 manifest ───
        let manifest_key = format!("{}/manifest.json", &user_prefix);
        tracing::info!("[sync] do_push: step2 - downloading remote manifest key={}", manifest_key);
        let remote: SyncManifest = match qiniu_download_with_timeout(&manifest_key, "push download manifest", 30).await {
            Ok(bytes) => {
                tracing::info!("[sync] do_push: remote manifest downloaded ({} bytes)", bytes.len());
                serde_json::from_slice(&bytes).unwrap_or_default()
            }
            Err(e) => {
                tracing::info!("[sync] do_push: no remote manifest ({})", e);
                SyncManifest::default()
            }
        };

        // ─── 3. 对比 ───
        let diff = SyncManifest::compare(&local, &remote);
        tracing::info!(
            "[sync] do_push: step3 - diff: db={}, img_up={}, img_down={}, asset_up={}, asset_down={}, chat_up={}, chat_down={}, settings={}, globals_up={}, globals_down={}, videos_up={}, videos_down={}, vg={}",
            diff.db_needs_sync,
            diff.images_to_upload.len(),
            diff.images_to_download.len(),
            diff.assets_to_upload.len(),
            diff.assets_to_download.len(),
            diff.chat_to_upload.len(),
            diff.chat_to_download.len(),
            diff.settings_needs_sync,
            diff.globals_to_upload.len(),
            diff.globals_to_download.len(),
            diff.videos_to_upload.len(),
            diff.videos_to_download.len(),
            diff.videogen_store_needs_sync,
        );

        if diff_is_empty(&diff) {
            tracing::info!("[sync] do_push: no changes, skipping upload");
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let mut lock = lock_sync_manager();
            if let Some(sm) = lock.as_mut() {
                sm.local_manifest = local;
                sm.remote_manifest = Some(remote);
                sm.status = SyncStatus {
                    state: "synced".into(),
                    message: "无变更".into(),
                    last_sync_time: Some(now),
                };
            }
            return Ok(());
        }

        // ─── 4. 上传差异 ───
        set_status("syncing", "正在上传...").await;
        let total_items = (if diff.db_needs_sync { 1u32 } else { 0 })
            + diff.images_to_upload.len() as u32
            + diff.assets_to_upload.len() as u32
            + diff.chat_to_upload.len() as u32
            + (if diff.settings_needs_sync && diff.settings_direction != Some(SyncDirection::Download) { 1 } else { 0 })
            + diff.globals_to_upload.len() as u32
            + diff.videos_to_upload.len() as u32
            + (if diff.videogen_store_needs_sync && diff.videogen_store_direction != Some(SyncDirection::Download) { 1 } else { 0 })
            + 1; // manifest
        let mut uploaded_count = 0u32;

        // helper: emit progress event to frontend
        let emit_progress = |count: u32, label: &str| {
            let payload = serde_json::json!({
                "current": count,
                "total": total_items,
                "label": label,
                "direction": "push",
            });
            let _ = app.emit("sync-progress", &payload);
        };

        if diff.db_needs_sync {
            let size_mb = std::fs::metadata(&db_path).map(|m| m.len() / 1024 / 1024).unwrap_or(0);
            let label = format!("projects.db ({} MB)", size_mb);
            tracing::info!("[sync] do_push: step4 - uploading db");
            let data = read_file(db_path.clone()).await?;
            let db_key = format!("{}/projects.db", &user_prefix);
            qiniu_upload_with_timeout(&db_key, data, "push db", 300).await?;
            uploaded_count += 1;
            emit_progress(uploaded_count, &label);
            tracing::info!("[sync] do_push: db uploaded ok");
        }

        for md5_name in &diff.images_to_upload {
            let img_path = images_dir.join(md5_name);
            if file_exists(img_path.clone()).await {
                let label = format!("图片 {}", md5_name);
                tracing::info!("[sync] do_push: step4 - uploading image {}", md5_name);
                let data = read_file(img_path).await?;
                let img_key = format!("{}/images/{}", &user_prefix, md5_name);
                qiniu_upload_with_timeout(&img_key, data, "push image", 30).await?;
                uploaded_count += 1;
                emit_progress(uploaded_count, &label);
            }
        }

        for asset_key in &diff.assets_to_upload {
            let asset_path = assets_dir.join(asset_key);
            if file_exists(asset_path.clone()).await {
                let label = format!("资源 {}", asset_key);
                tracing::info!("[sync] do_push: step4 - uploading asset {}", asset_key);
                let data = read_file(asset_path).await?;
                let full_key = format!("{}/assets/{}", &user_prefix, asset_key);
                qiniu_upload_with_timeout(&full_key, data, "push asset", 30).await?;
                uploaded_count += 1;
                emit_progress(uploaded_count, &label);
            }
        }

        // chat — 逐个上传有变更的项目文件
        let chat_upload_dir = user_dir.join("chat");
        for pid in &diff.chat_to_upload {
            let chat_path = chat_upload_dir.join(format!("{}.json", pid));
            if file_exists(chat_path.clone()).await {
                tracing::info!("[sync] do_push: step4 - uploading chat {}", pid);
                let data = read_file(chat_path).await?;
                let chat_key = format!("{}/chat/{}.json", &user_prefix, pid);
                qiniu_upload_with_timeout(&chat_key, data, "push chat", 30).await?;
                uploaded_count += 1;
                emit_progress(uploaded_count, &format!("对话记录 {}", pid));
            }
        }

        if diff.settings_needs_sync
            && diff.settings_direction != Some(SyncDirection::Download)
            && file_exists(settings_path.clone()).await
        {
            tracing::info!("[sync] do_push: step4 - uploading settings");
            let data = read_file(settings_path).await?;
            let settings_key = format!("{}/settings/settings.json", &user_prefix);
            qiniu_upload_with_timeout(&settings_key, data, "push settings", 30).await?;
            uploaded_count += 1;
            emit_progress(uploaded_count, "设置");
        }

        for proj_id in &diff.globals_to_upload {
            let g_path = projects_dir.join(proj_id).join("project_globals.md");
            if file_exists(g_path.clone()).await {
                let label = format!("项目 {}", proj_id);
                tracing::info!("[sync] do_push: step4 - uploading global {}", proj_id);
                let data = read_file(g_path).await?;
                let g_key = format!("{}/projects/{}/globals.md", &user_prefix, proj_id);
                qiniu_upload_with_timeout(&g_key, data, "push global", 30).await?;
                uploaded_count += 1;
                emit_progress(uploaded_count, &label);
            }
        }

        for video_name in &diff.videos_to_upload {
            let v_path = videos_dir.join(video_name);
            if file_exists(v_path.clone()).await {
                let label = format!("视频 {}", video_name);
                tracing::info!("[sync] do_push: step4 - uploading video {}", video_name);
                let data = read_file(v_path).await?;
                let v_key = format!("{}/videos/{}", &user_prefix, video_name);
                qiniu_upload_with_timeout(&v_key, data, "push video", 120).await?;
                uploaded_count += 1;
                emit_progress(uploaded_count, &label);
            }
        }

        if diff.videogen_store_needs_sync
            && diff.videogen_store_direction != Some(SyncDirection::Download)
            && file_exists(vg_path.clone()).await
        {
            tracing::info!("[sync] do_push: step4 - uploading videogen_store");
            let data = read_file(vg_path).await?;
            let vg_key = format!("{}/videogen_store.json", &user_prefix);
            qiniu_upload_with_timeout(&vg_key, data, "push videogen_store", 30).await?;
            uploaded_count += 1;
            emit_progress(uploaded_count, "视频生成配置");
        }

        // ─── 5. 上传新 manifest ───
        tracing::info!("[sync] do_push: step5 - uploading new manifest");
        let manifest_bytes = serde_json::to_vec(&local).map_err(|e| format!("json manifest: {e}"))?;
        qiniu_upload_with_timeout(&manifest_key, manifest_bytes, "push manifest", 30).await?;
        uploaded_count += 1;
        emit_progress(uploaded_count, "同步清单");
        tracing::info!("[sync] do_push: manifest uploaded ok");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut lock = lock_sync_manager();
        if let Some(sm) = lock.as_mut() {
            sm.local_manifest = local;
            sm.remote_manifest = None;
            sm.status = SyncStatus {
                state: "synced".into(),
                message: format!("上传完成 ({})", uploaded_count),
                last_sync_time: Some(now),
            };
        }
        tracing::info!("[sync] do_push: ===== COMPLETE ({} uploaded) =====", uploaded_count);
        Ok(())
    }
}

// ─── 退出时推送 ───

pub async fn push_on_exit(app: &AppHandle) {
    tracing::info!("[sync] push_on_exit: starting (30s timeout)");
    match tokio::time::timeout(std::time::Duration::from_secs(30), SyncManager::do_push(app)).await {
        Ok(Ok(())) => tracing::info!("[sync] push_on_exit: completed successfully"),
        Ok(Err(e)) => tracing::warn!("[sync] push_on_exit: failed: {e}"),
        Err(_) => tracing::warn!("[sync] push_on_exit: timed out after 30s"),
    }
}

// ─── helpers ───

async fn set_status(state: &str, message: &str) {
    let status = SyncStatus {
        state: state.into(),
        message: message.into(),
        last_sync_time: None,
    };
    let mut lock = lock_sync_manager();
    if let Some(sm) = lock.as_mut() {
        sm.status = status;
    }
}

async fn collect_asset_entries_spawn(base: &PathBuf) -> Result<HashMap<String, FileEntry>, String> {
    let b = base.clone();
    tokio::task::spawn_blocking(move || {
        let mut entries = HashMap::new();
        collect_asset_entries_sync(&b, &b, &mut entries)?;
        Ok(entries)
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

fn collect_asset_entries_sync(
    base: &PathBuf,
    current: &PathBuf,
    entries: &mut HashMap<String, FileEntry>,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(current).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_asset_entries_sync(base, &path, entries)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("strip: {e}"))?
                .to_string_lossy()
                .replace('\\', "/");
            let data = std::fs::read(&path).map_err(|e| format!("read: {e}"))?;
            entries.insert(
                rel,
                FileEntry {
                    hash: SyncManifest::compute_hash(&data),
                    size: data.len() as u64,
                },
            );
        }
    }
    Ok(())
}
