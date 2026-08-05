use crate::sync::{SyncManager, SyncStatus};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictResolution {
    pub cloud_id: String,
    pub action: String, // "overwrite" | "keep_local"
}

/// 测试七牛连通性：上传 + 下载验证
#[tauri::command]
pub async fn sync_test_qiniu() -> Result<String, String> {
    let test_key = "test/connectivity_check.json";
    let test_data = serde_json::json!({
        "test": "七牛连通性测试",
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    });
    let test_bytes = serde_json::to_vec(&test_data).map_err(|e| format!("json: {e}"))?;

    // 上传
    crate::sync::qiniu::upload(test_key, &test_bytes).await
        .map_err(|e| format!("上传失败: {e}"))?;

    // 立即下载验证
    let downloaded = crate::sync::qiniu::download(test_key).await
        .map_err(|e| format!("下载失败: {e}"))?;

    if downloaded == test_bytes {
        // 清理测试文件
        crate::sync::qiniu::delete(test_key).await.ok();
        Ok("七牛云连通正常：上传+下载+删除 全部成功".into())
    } else {
        Err(format!(
            "数据不一致！原数据 {} 字节，下载 {} 字节",
            test_bytes.len(),
            downloaded.len()
        ))
    }
}

/// 手动触发拉取同步
#[tauri::command]
pub async fn sync_pull(app: AppHandle) -> Result<SyncStatus, String> {
    SyncManager::do_pull(&app).await?;
    SyncManager::get_status().await;
    Ok(SyncManager::get_status().await)
}

/// 手动触发推送同步
#[tauri::command]
pub async fn sync_push(app: AppHandle) -> Result<SyncStatus, String> {
    SyncManager::do_push(&app).await?;
    Ok(SyncManager::get_status().await)
}

/// 获取当前同步状态
#[tauri::command]
pub async fn sync_get_status() -> Result<SyncStatus, String> {
    Ok(SyncManager::get_status().await)
}

/// 强制全量推送（用户切换设备前）
#[tauri::command]
pub async fn sync_force_full_push(app: AppHandle) -> Result<SyncStatus, String> {
    SyncManager::do_push(&app).await?;
    Ok(SyncManager::get_status().await)
}

/// 导出前端 settings (localStorage) 为文件，加入同步队列
#[tauri::command]
pub async fn sync_export_settings(
    app: AppHandle,
    settings_json: String,
) -> Result<(), String> {
    let path = crate::sync::get_user_dir(&app)?.join("settings.json");
    std::fs::write(&path, &settings_json).map_err(|e| format!("write settings: {e}"))?;
    Ok(())
}

/// 获取本地 settings 文件内容（用于注入到前端）
#[tauri::command]
pub async fn sync_import_settings(app: AppHandle) -> Result<String, String> {
    let path = crate::sync::get_user_dir(&app)?.join("settings.json");
    if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| format!("read settings: {e}"))
    } else {
        Ok(String::new())
    }
}

/// 用户确认冲突解决后，继续完成 DB 合并（只合并非冲突项目 + 用户选择覆盖的冲突项目）
#[tauri::command]
pub async fn sync_resolve_conflicts(
    app: AppHandle,
    resolutions: Vec<ConflictResolution>,
) -> Result<SyncStatus, String> {
    SyncManager::resolve_conflicts(&app, resolutions).await
}
