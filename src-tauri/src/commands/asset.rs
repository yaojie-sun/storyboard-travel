use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

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
    let dest_file_name = format!("{}-{}.{}", id, &file_name, ext);
    let dest_path = assets_dir.join(&dest_file_name);
    let dest_path_str = dest_path.to_string_lossy().to_string();

    std::fs::copy(&source_path, &dest_path)
        .map_err(|e| format!("Failed to copy asset file: {}", e))?;

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

    // Delete file
    if let Some(path) = file_path {
        let _ = std::fs::remove_file(&path);
    }

    Ok(())
}
