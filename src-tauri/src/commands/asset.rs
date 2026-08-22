use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tracing::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecord {
    pub id: String,
    pub project_id: String,
    pub category: String,
    pub name: String,
    pub file_path: String,
    pub file_name: String,
    pub created_at: i64,
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = crate::sync::get_user_dir(app)?.join("projects.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open projects.db: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    Ok(conn)
}

fn ensure_assets_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          category TEXT NOT NULL,
          name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
        CREATE INDEX IF NOT EXISTS idx_assets_project_category ON assets(project_id, category);
        "#,
    )
    .map_err(|e| format!("Failed to initialize assets table: {}", e))?;

    // Self-heal: add columns if missing (future-proofing)
    let mut has_project_id = false;
    let mut stmt = conn
        .prepare("PRAGMA table_info(assets)")
        .map_err(|e| format!("Failed to inspect assets schema: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to inspect assets columns: {}", e))?;

    for name_result in rows {
        let column_name =
            name_result.map_err(|e| format!("Failed to read assets column name: {}", e))?;
        if column_name == "project_id" {
            has_project_id = true;
        }
    }

    if !has_project_id {
        conn.execute_batch("ALTER TABLE assets ADD COLUMN project_id TEXT NOT NULL DEFAULT ''")
            .map_err(|e| format!("Failed to add project_id column: {}", e))?;
    }

    Ok(())
}

fn resolve_assets_dir(app: &AppHandle, project_id: &str, category: &str) -> Result<PathBuf, String> {
    let assets_dir = crate::sync::get_user_dir(app)?.join("assets").join(project_id).join(category);
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets directory: {}", e))?;
    Ok(assets_dir)
}

#[tauri::command]
pub fn add_asset(
    app: AppHandle,
    id: String,
    project_id: String,
    category: String,
    name: String,
    source_path: String,
    file_name: String,
) -> Result<AssetRecord, String> {
    // Copy file to assets directory
    let assets_dir = resolve_assets_dir(&app, &project_id, &category)?;
    let ext = std::path::Path::new(&source_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");

    // 大图（最长边 > 2048 或体积 > 5MB）先压缩再落盘，避免原图过大拖慢宫格/画布加载；
    // 小图原样保留，压缩/解码失败则原样保存兜底，不阻塞上传。
    let src_bytes = std::fs::read(&source_path)
        .map_err(|e| format!("Failed to read asset file: {}", e))?;
    let (out_bytes, out_ext) = match crate::ai::describe::compress_for_upload(&src_bytes) {
        Ok(crate::ai::describe::UploadImage::Original(b)) => (b, ext.to_string()),
        Ok(crate::ai::describe::UploadImage::CompressedJpeg(b)) => {
            info!(
                "asset {} 原图 {} bytes 已压缩为 {} bytes (jpg)",
                id,
                src_bytes.len(),
                b.len()
            );
            (b, "jpg".to_string())
        }
        Err(_) => (src_bytes, ext.to_string()),
    };

    let dest_file_name = format!("{}-{}.{}", id, &file_name, out_ext);
    let dest_path = assets_dir.join(&dest_file_name);
    let dest_path_str = dest_path.to_string_lossy().to_string();

    std::fs::write(&dest_path, &out_bytes)
        .map_err(|e| format!("Failed to write asset file: {}", e))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let record = AssetRecord {
        id,
        project_id,
        category,
        name,
        file_path: dest_path_str,
        file_name,
        created_at: now,
    };

    let conn = open_db(&app)?;
    ensure_assets_table(&conn)?;

    conn.execute(
        r#"
        INSERT INTO assets (id, project_id, category, name, file_path, file_name, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            record.id,
            record.project_id,
            record.category,
            record.name,
            record.file_path,
            record.file_name,
            record.created_at,
        ],
    )
    .map_err(|e| format!("Failed to insert asset: {}", e))?;

    // 读图改为「生成分镜时」触发（见 chatStore.sendMessage 调 buildProjectChatContext(readIfMissing:true)），
    // 上传时不再后台自动读图，避免「传错图/白读」。

    Ok(record)
}

#[tauri::command]
pub fn list_assets(app: AppHandle, project_id: String) -> Result<Vec<AssetRecord>, String> {
    let conn = open_db(&app)?;
    ensure_assets_table(&conn)?;

    let mut stmt = conn
        .prepare("SELECT id, project_id, category, name, file_path, file_name, created_at FROM assets WHERE project_id = ?1 ORDER BY created_at DESC")
        .map_err(|e| format!("Failed to prepare list assets: {}", e))?;

    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(AssetRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                category: row.get(2)?,
                name: row.get(3)?,
                file_path: row.get(4)?,
                file_name: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("Failed to list assets: {}", e))?;

    let mut assets = Vec::new();
    for row in rows {
        assets.push(row.map_err(|e| format!("Failed to read asset row: {}", e))?);
    }

    Ok(assets)
}

#[tauri::command]
pub fn update_asset(
    app: AppHandle,
    id: String,
    name: String,
    category: String,
) -> Result<AssetRecord, String> {
    let conn = open_db(&app)?;

    let record = conn
        .query_row(
            r#"
            UPDATE assets SET name = ?1, category = ?2
            WHERE id = ?3
            RETURNING id, project_id, category, name, file_path, file_name, created_at
            "#,
            params![name, category, id],
            |row| {
                Ok(AssetRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    category: row.get(2)?,
                    name: row.get(3)?,
                    file_path: row.get(4)?,
                    file_name: row.get(5)?,
                    created_at: row.get(6)?,
                })
            },
        )
        .map_err(|e| format!("Failed to update asset: {}", e))?;

    // If category changed, move the asset file to the new directory
    let old_file_path = std::path::Path::new(&record.file_path);
    let assets_base = old_file_path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent());
    // Only move if category actually changed (the path doesn't match new category)
    let expected_dir = std::path::Path::new(&record.file_path)
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str());
    if expected_dir != Some(&category) {
        if let Some(base) = assets_base {
            let new_dir = base.join(&category);
            std::fs::create_dir_all(&new_dir)
                .map_err(|e| format!("Failed to create new category dir: {}", e))?;
            if let Some(file_name) = old_file_path.file_name() {
                let new_path = new_dir.join(file_name);
                let new_path_str = new_path.to_string_lossy().to_string();
                std::fs::rename(&record.file_path, &new_path)
                    .map_err(|e| format!("Failed to move asset file: {}", e))?;
                conn.execute(
                    "UPDATE assets SET file_path = ?1 WHERE id = ?2",
                    params![new_path_str, id],
                )
                .map_err(|e| format!("Failed to update file_path: {}", e))?;
                return Ok(AssetRecord {
                    file_path: new_path_str,
                    ..record
                });
            }
        }
    }

    Ok(record)
}

#[tauri::command]
pub fn delete_asset(app: AppHandle, id: String) -> Result<(), String> {
    // Get file path before deleting
    let conn = open_db(&app)?;
    ensure_assets_table(&conn)?;

    let file_path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM assets WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .ok();

    // Delete DB record
    conn.execute("DELETE FROM assets WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete asset: {}", e))?;

    // Delete description cache (best-effort)
    let _ = ensure_asset_descriptions_table(&conn);
    let _ = conn.execute("DELETE FROM asset_descriptions WHERE asset_id = ?1", params![id]);

    // Delete file
    if let Some(path) = file_path {
        let _ = std::fs::remove_file(&path);
    }

    Ok(())
}

// ============ 读图描述（视觉描述缓存） ============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDescription {
    pub asset_id: String,
    pub description: String,
}

fn ensure_asset_descriptions_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS asset_descriptions (
          asset_id TEXT PRIMARY KEY,
          file_hash TEXT NOT NULL,
          description TEXT NOT NULL,
          model TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("Failed to initialize asset_descriptions table: {}", e))
}

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex as TokioMutex, OnceCell as TokioOnceCell};

static IN_FLIGHT_DESCRIBES: std::sync::LazyLock<
    TokioMutex<HashMap<String, Arc<TokioOnceCell<String>>>>,
> = std::sync::LazyLock::new(|| TokioMutex::new(HashMap::new()));

/// 读图核心逻辑：先查缓存（file_hash 命中秒回），未命中调 DeepSeek 视觉模型并写缓存。
/// 幂等，可被 add_asset 异步任务和前端 describe_asset 重复调用，不会重复产生读图费用。
async fn describe_asset_inner(app: &AppHandle, asset_id: &str) -> Result<Option<String>, String> {
    let api_key = crate::commands::banana_api::get_deepseek_chat_key()
        .ok_or_else(|| "DeepSeek视觉读图API密钥未配置".to_string())?;

    // 阶段一（同步）：读文件 + 查缓存。conn 必须在 await 前 drop（rusqlite Connection 非 Send）。
    let (file_hash, bytes, cached_desc) = {
        let conn = open_db(app)?;
        ensure_assets_table(&conn)?;
        ensure_asset_descriptions_table(&conn)?;

        let file_path: String = conn
            .query_row(
                "SELECT file_path FROM assets WHERE id = ?1",
                params![asset_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to find asset: {}", e))?;

        let bytes = std::fs::read(&file_path)
            .map_err(|e| format!("Failed to read asset file: {}", e))?;
        let file_hash = format!("{:x}", md5::compute(&bytes));

        let cached: Option<String> = conn
            .query_row(
                "SELECT description FROM asset_descriptions WHERE asset_id = ?1 AND file_hash = ?2",
                params![asset_id, file_hash],
                |row| row.get(0),
            )
            .ok();

        (file_hash, bytes, cached)
    };

    if let Some(desc) = cached_desc {
        return Ok(Some(desc));
    }

    // 阶段二（await）：调读图，带并发合并锁（首个调用者读图，后续 await 复用同一结果）。
    let cell = {
        let mut map = IN_FLIGHT_DESCRIBES.lock().await;
        map.entry(asset_id.to_string())
            .or_insert_with(|| Arc::new(TokioOnceCell::new()))
            .clone()
    };
    let description: String = cell
        .get_or_try_init(|| async {
            crate::ai::describe::describe_image(&bytes, &api_key)
                .await
                .map_err(|e| e.to_string())
        })
        .await?
        .clone();

    // 阶段三（同步）：写缓存
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    {
        let conn = open_db(app)?;
        ensure_asset_descriptions_table(&conn)?;
        conn.execute(
            r#"
            INSERT INTO asset_descriptions (asset_id, file_hash, description, model, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(asset_id) DO UPDATE SET
              file_hash = ?2, description = ?3, model = ?4, updated_at = ?5
            "#,
            params![asset_id, file_hash, description, "deepseek-v4-flash-vision-exp", now],
        )
        .map_err(|e| format!("Failed to save asset description: {}", e))?;
    }

    Ok(Some(description))
}

#[tauri::command]
pub async fn describe_asset(app: AppHandle, asset_id: String) -> Result<Option<String>, String> {
    describe_asset_inner(&app, &asset_id).await
}

#[tauri::command]
pub fn get_asset_descriptions(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<AssetDescription>, String> {
    let conn = open_db(&app)?;
    ensure_assets_table(&conn)?;
    ensure_asset_descriptions_table(&conn)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT d.asset_id, d.description
            FROM asset_descriptions d
            JOIN assets a ON a.id = d.asset_id
            WHERE a.project_id = ?1
            "#,
        )
        .map_err(|e| format!("Failed to prepare get descriptions: {}", e))?;

    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(AssetDescription {
                asset_id: row.get(0)?,
                description: row.get(1)?,
            })
        })
        .map_err(|e| format!("Failed to query descriptions: {}", e))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("Failed to read description row: {}", e))?);
    }
    Ok(out)
}
