use std::path::PathBuf;
use std::collections::HashSet;
use std::time::Duration;

use rusqlite::{params, Connection};
use tracing::info;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
    pub nodes_json: String,
    pub edges_json: String,
    pub viewport_json: String,
    pub history_json: String,
    // 项目参数
    pub aspect_ratio: String,
    pub style: String,
    pub tone: String,
    pub director_ref: String,
    pub video_type: String,
    pub emphasis_dimensions: String,  // JSON array
    pub ai_analysis: String,
    pub ai_params: String,            // JSON object
    pub global_params_md_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeRecord {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub number: i64,
    pub nodes_json: String,
    pub edges_json: String,
    pub viewport_json: String,
    pub history_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::sync::get_user_dir(app).map(|dir| dir.join("projects.db"))
}

fn ensure_projects_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          node_count INTEGER NOT NULL DEFAULT 0,
          nodes_json TEXT NOT NULL,
          edges_json TEXT NOT NULL,
          viewport_json TEXT NOT NULL,
          history_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
        CREATE TABLE IF NOT EXISTS project_image_refs (
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY(project_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_image_refs_path ON project_image_refs(path);
        CREATE TABLE IF NOT EXISTS episodes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          number INTEGER NOT NULL,
          nodes_json TEXT NOT NULL DEFAULT '[]',
          edges_json TEXT NOT NULL DEFAULT '[]',
          viewport_json TEXT NOT NULL DEFAULT '{}',
          history_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_episodes_project_id ON episodes(project_id);
        "#,
    )
    .map_err(|e| format!("Failed to initialize tables: {}", e))?;

    // Self-healing: add missing columns to projects table
    let existing_columns = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(projects)")
            .map_err(|e| format!("Failed to inspect projects schema: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("Failed to inspect projects columns: {}", e))?;
        let mut cols = Vec::new();
        for name_result in rows {
            cols.push(
                name_result.map_err(|e| format!("Failed to read projects column name: {}", e))?,
            );
        }
        cols
    };

    let columns_to_add: Vec<(&str, &str)> = vec![
        ("node_count", "INTEGER NOT NULL DEFAULT 0"),
        ("aspect_ratio", "TEXT NOT NULL DEFAULT ''"),
        ("style", "TEXT NOT NULL DEFAULT ''"),
        ("tone", "TEXT NOT NULL DEFAULT ''"),
        ("director_ref", "TEXT NOT NULL DEFAULT ''"),
        ("emphasis_dimensions", "TEXT NOT NULL DEFAULT '[]'"),
        ("ai_analysis", "TEXT NOT NULL DEFAULT ''"),
        ("ai_params", "TEXT NOT NULL DEFAULT '{}'"),
        ("global_params_md_path", "TEXT NOT NULL DEFAULT ''"),
    ("video_type", "TEXT NOT NULL DEFAULT ''"),
    ];

    for (col_name, col_def) in columns_to_add {
        if !existing_columns.contains(&col_name.to_string()) {
            let sql = format!("ALTER TABLE projects ADD COLUMN {} {}", col_name, col_def);
            conn.execute(&sql, [])
                .map_err(|e| format!("Failed to add column {}: {}", col_name, e))?;
        }
    }

    Ok(())
}

fn parse_image_pool(history_json: &str) -> Vec<String> {
    let parsed: serde_json::Value = match serde_json::from_str(history_json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    parsed
        .get("imagePool")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|value| value.as_str().map(|item| item.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_image_ref(value: &str, image_pool: &[String]) -> Option<String> {
    const IMAGE_REF_PREFIX: &str = "__img_ref__:";

    if let Some(index_text) = value.strip_prefix(IMAGE_REF_PREFIX) {
        let index = index_text.parse::<usize>().ok()?;
        if index >= image_pool.len() {
            tracing::warn!(
                "[project_state] Image ref index {} out of bounds (pool size={})",
                index, image_pool.len()
            );
            return None;
        }
        return Some(image_pool[index].clone());
    }

    if value.trim().is_empty() {
        return None;
    }

    Some(value.to_string())
}

fn collect_image_paths_from_nodes(
    nodes: &[serde_json::Value],
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    for node in nodes {
        let data = match node.get("data").and_then(|value| value.as_object()) {
            Some(value) => value,
            None => continue,
        };

        for key in ["imageUrl", "previewImageUrl"] {
            if let Some(raw_value) = data.get(key).and_then(|value| value.as_str()) {
                if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                    paths.insert(path);
                }
            }
        }

        // gridCellImageUrls: string array of image URLs (used by video generation)
        if let Some(grid_urls) = data.get("gridCellImageUrls").and_then(|v| v.as_array()) {
            for url_val in grid_urls {
                if let Some(raw_value) = url_val.as_str() {
                    if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                        paths.insert(path);
                    }
                }
            }
        }

        if let Some(frames) = data.get("frames").and_then(|value| value.as_array()) {
            for frame in frames {
                let frame_obj = match frame.as_object() {
                    Some(value) => value,
                    None => continue,
                };
                for key in ["imageUrl", "previewImageUrl"] {
                    if let Some(raw_value) = frame_obj.get(key).and_then(|value| value.as_str()) {
                        if let Some(path) = resolve_image_ref(raw_value, image_pool) {
                            paths.insert(path);
                        }
                    }
                }
            }
        }
    }
}

fn extract_project_image_paths(nodes_json: &str, history_json: &str) -> HashSet<String> {
    let image_pool = parse_image_pool(history_json);
    let mut paths = HashSet::new();

    if let Ok(parsed_nodes) = serde_json::from_str::<serde_json::Value>(nodes_json) {
        if let Some(nodes) = parsed_nodes.as_array() {
            collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
        }
    }

    if let Ok(parsed_history) = serde_json::from_str::<serde_json::Value>(history_json) {
        for timeline_key in ["past", "future"] {
            let Some(timeline) = parsed_history.get(timeline_key).and_then(|value| value.as_array()) else {
                continue;
            };

            for snapshot in timeline {
                let Some(nodes) = snapshot.get("nodes").and_then(|value| value.as_array()) else {
                    continue;
                };
                collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
            }
        }
    }

    paths
}

fn resolve_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let images_dir = crate::sync::get_user_dir(app)?.join("images");
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images dir: {}", e))?;
    Ok(images_dir)
}

fn extract_episode_image_paths(app: &AppHandle) -> HashSet<String> {
    let conn = match open_db(app) {
        Ok(c) => c,
        Err(_) => return HashSet::new(),
    };

    let mut stmt = match conn.prepare("SELECT nodes_json, history_json FROM episodes") {
        Ok(s) => s,
        Err(_) => return HashSet::new(),
    };

    let rows = match stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(r) => r,
        Err(_) => return HashSet::new(),
    };

    let mut paths = HashSet::new();
    for row_result in rows {
        let (nodes_json, history_json) = match row_result {
            Ok(r) => r,
            Err(_) => continue,
        };
        let episode_paths = extract_project_image_paths(&nodes_json, &history_json);
        paths.extend(episode_paths);
    }
    paths
}

fn prune_unreferenced_images(app: &AppHandle) -> Result<(), String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT path FROM project_image_refs")
        .map_err(|e| format!("Failed to prepare image refs query: {}", e))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query image refs: {}", e))?;

    // 用文件名（而非完整路径）做匹配，防止迁移后目录前缀变化导致误删
    let mut referenced_filenames = HashSet::new();
    for path_result in rows {
        let path = path_result.map_err(|e| format!("Failed to decode image ref row: {}", e))?;
        if let Some(name) = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()) {
            referenced_filenames.insert(name.to_string());
        }
    }

    // Also collect image refs from all episode nodes/history so episodes' images are protected
    let episode_paths = extract_episode_image_paths(app);
    for path in episode_paths {
        if let Some(name) = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()) {
            referenced_filenames.insert(name.to_string());
        }
    }

    let images_dir = resolve_images_dir(app)?;
    let entries = std::fs::read_dir(&images_dir)
        .map_err(|e| format!("Failed to read images dir: {}", e))?;

    for entry_result in entries {
        let entry = entry_result.map_err(|e| format!("Failed to iterate images dir: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !referenced_filenames.contains(filename) {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete unreferenced image: {}", e))?;
        }
    }

    Ok(())
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open SQLite DB: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set journal_mode=WAL: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| format!("Failed to set temp_store=MEMORY: {}", e))?;
    conn.busy_timeout(Duration::from_millis(3000))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;

    ensure_projects_table(&conn)?;
    Ok(conn)
}

#[tauri::command]
pub fn list_project_summaries(app: AppHandle) -> Result<Vec<ProjectSummaryRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id,
              name,
              created_at,
              updated_at,
              node_count
            FROM projects
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|e| format!("Failed to prepare list summaries query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectSummaryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                node_count: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query project summaries: {}", e))?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| format!("Failed to decode summary row: {}", e))?);
    }
    Ok(projects)
}

#[tauri::command]
pub fn get_project_record(
    app: AppHandle,
    project_id: String,
) -> Result<Option<ProjectRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id,
              name,
              created_at,
              updated_at,
              node_count,
              nodes_json,
              edges_json,
              viewport_json,
              history_json,
              aspect_ratio,
              style,
              tone,
              director_ref,
              video_type,
              emphasis_dimensions,
              ai_analysis,
              ai_params,
              global_params_md_path
            FROM projects
            WHERE id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare get project query: {}", e))?;

    let result = stmt.query_row(params![project_id], |row| {
        Ok(ProjectRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            node_count: row.get(4)?,
            nodes_json: row.get(5)?,
            edges_json: row.get(6)?,
            viewport_json: row.get(7)?,
            history_json: row.get(8)?,
            aspect_ratio: row.get(9)?,
            style: row.get(10)?,
            tone: row.get(11)?,
            director_ref: row.get(12)?,
            video_type: row.get(13)?,
            emphasis_dimensions: row.get(14)?,
            ai_analysis: row.get(15)?,
            ai_params: row.get(16)?,
            global_params_md_path: row.get(17)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load project: {}", error)),
    }
}

#[tauri::command]
pub fn upsert_project_record(app: AppHandle, record: ProjectRecord) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let image_paths = extract_project_image_paths(&record.nodes_json, &record.history_json);
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    tx.execute(
        r#"
        INSERT INTO projects (
          id, name, created_at, updated_at, node_count,
          nodes_json, edges_json, viewport_json, history_json,
          aspect_ratio, style, tone, director_ref, video_type,
          emphasis_dimensions, ai_analysis, ai_params, global_params_md_path
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          node_count = excluded.node_count,
          nodes_json = excluded.nodes_json,
          edges_json = excluded.edges_json,
          viewport_json = excluded.viewport_json,
          history_json = excluded.history_json,
          aspect_ratio = excluded.aspect_ratio,
          style = excluded.style,
          tone = excluded.tone,
          director_ref = excluded.director_ref,
          video_type = excluded.video_type,
          emphasis_dimensions = excluded.emphasis_dimensions,
          ai_analysis = excluded.ai_analysis,
          ai_params = excluded.ai_params,
          global_params_md_path = excluded.global_params_md_path
        "#,
        params![
            record.id,
            record.name,
            record.created_at,
            record.updated_at,
            record.node_count,
            record.nodes_json,
            record.edges_json,
            record.viewport_json,
            record.history_json,
            record.aspect_ratio,
            record.style,
            record.tone,
            record.director_ref,
            record.video_type,
            record.emphasis_dimensions,
            record.ai_analysis,
            record.ai_params,
            record.global_params_md_path,
        ],
    )
    .map_err(|e| format!("Failed to upsert project: {}", e))?;

    // 安全检查：先查询已有引用，防止 JSON 解析异常导致全项目图片被误删
    let nodes_json_non_empty = !record.nodes_json.is_empty() && record.nodes_json != "[]";
    let old_refs: Vec<String> = if nodes_json_non_empty {
        let mut stmt = tx
            .prepare("SELECT path FROM project_image_refs WHERE project_id = ?1")
            .map_err(|e| format!("Failed to prepare refs query: {}", e))?;
        let rows = stmt
            .query_map(params![record.id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query existing refs: {}", e))?;
        rows.filter_map(|r| r.ok()).collect()
    } else {
        Vec::new()
    };

    tx.execute(
        "DELETE FROM project_image_refs WHERE project_id = ?1",
        params![record.id],
    )
    .map_err(|e| format!("Failed to clear project image refs: {}", e))?;

    // 如果 nodes_json 非空但未提取到任何图片路径，说明可能是 JSON 解析异常
    // 此时恢复旧引用，防止 prune_unreferenced_images 误删所有图片
    if image_paths.is_empty() && nodes_json_non_empty {
        tracing::warn!(
            "[project_state] 警告：nodes_json 非空但未提取到图片路径，可能是 JSON 异常。恢复旧引用。project={} old_refs={}",
            record.id,
            old_refs.len()
        );
        for path in &old_refs {
            tx.execute(
                "INSERT OR IGNORE INTO project_image_refs (project_id, path) VALUES (?1, ?2)",
                params![record.id, path],
            )
            .map_err(|e| format!("Failed to restore old image ref: {}", e))?;
        }
    } else {
        for path in &image_paths {
            tx.execute(
                "INSERT OR IGNORE INTO project_image_refs (project_id, path) VALUES (?1, ?2)",
                params![record.id, path],
            )
            .map_err(|e| format!("Failed to upsert project image ref: {}", e))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit upsert transaction: {}", e))?;

    prune_unreferenced_images(&app)?;
    Ok(())
}

#[tauri::command]
pub fn update_project_viewport_record(
    app: AppHandle,
    project_id: String,
    viewport_json: String,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE projects SET viewport_json = ?1 WHERE id = ?2",
        params![viewport_json, project_id],
    )
    .map_err(|e| format!("Failed to update project viewport: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn rename_project_record(
    app: AppHandle,
    project_id: String,
    name: String,
    updated_at: i64,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, updated_at, project_id],
    )
    .map_err(|e| format!("Failed to rename project: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn delete_project_record(app: AppHandle, project_id: String) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin delete transaction: {}", e))?;

    tx.execute("DELETE FROM episodes WHERE project_id = ?1", params![project_id])
        .map_err(|e| format!("Failed to delete project episodes: {}", e))?;
    tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|e| format!("Failed to delete project: {}", e))?;
    tx.execute(
        "DELETE FROM project_image_refs WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| format!("Failed to delete project image refs: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit delete transaction: {}", e))?;

    prune_unreferenced_images(&app)?;
    Ok(())
}

// ── Episode CRUD ──

#[tauri::command]
pub fn list_episode_records(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<EpisodeRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id, project_id, name, number,
              nodes_json, edges_json, viewport_json, history_json,
              created_at, updated_at
            FROM episodes
            WHERE project_id = ?1
            ORDER BY number ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare list episodes query: {}", e))?;

    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(EpisodeRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                number: row.get(3)?,
                nodes_json: row.get(4)?,
                edges_json: row.get(5)?,
                viewport_json: row.get(6)?,
                history_json: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| format!("Failed to query episode records: {}", e))?;

    let mut episodes = Vec::new();
    for row in rows {
        episodes.push(row.map_err(|e| format!("Failed to decode episode row: {}", e))?);
    }
    Ok(episodes)
}

#[tauri::command]
pub fn get_episode_record(
    app: AppHandle,
    episode_id: String,
) -> Result<Option<EpisodeRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id, project_id, name, number,
              nodes_json, edges_json, viewport_json, history_json,
              created_at, updated_at
            FROM episodes
            WHERE id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare get episode query: {}", e))?;

    let result = stmt.query_row(params![episode_id], |row| {
        Ok(EpisodeRecord {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            number: row.get(3)?,
            nodes_json: row.get(4)?,
            edges_json: row.get(5)?,
            viewport_json: row.get(6)?,
            history_json: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load episode: {}", error)),
    }
}

#[tauri::command]
pub fn upsert_episode_record(app: AppHandle, record: EpisodeRecord) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        r#"
        INSERT INTO episodes (
          id, project_id, name, number,
          nodes_json, edges_json, viewport_json, history_json,
          created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          number = excluded.number,
          nodes_json = excluded.nodes_json,
          edges_json = excluded.edges_json,
          viewport_json = excluded.viewport_json,
          history_json = excluded.history_json,
          updated_at = excluded.updated_at
        "#,
        params![
            record.id,
            record.project_id,
            record.name,
            record.number,
            record.nodes_json,
            record.edges_json,
            record.viewport_json,
            record.history_json,
            record.created_at,
            record.updated_at,
        ],
    )
    .map_err(|e| format!("Failed to upsert episode: {}", e))?;

    // Sync episode image refs into the project-level image refs table so
    // prune_unreferenced_images has a single source of truth.
    let episode_paths = extract_project_image_paths(&record.nodes_json, &record.history_json);
    for path in &episode_paths {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO project_image_refs (project_id, path) VALUES (?1, ?2)",
            params![record.project_id, path],
        );
    }

    Ok(())
}

#[tauri::command]
pub fn delete_episode_record(app: AppHandle, episode_id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "DELETE FROM episodes WHERE id = ?1",
        params![episode_id],
    )
    .map_err(|e| format!("Failed to delete episode: {}", e))?;
    // Clean up image files that were unique to this episode
    prune_unreferenced_images(&app)?;
    Ok(())
}

/// 前端 flush 完成后回调，安全退出进程
#[tauri::command]
pub fn confirm_close() {
    std::process::exit(0);
}

/// Generate project_globals.md file in app data dir
#[tauri::command]
pub fn generate_project_globals_md(
    app: AppHandle,
    project_id: String,
    project_name: String,
    video_type: String,
    aspect_ratio: String,
    style: String,
    tone: String,
    director_ref: String,
    emphasis_dimensions_json: String,
    analysis_summary: String,
    ai_params_json: String,
) -> Result<String, String> {
    let projects_dir = crate::sync::get_user_dir(&app)?.join("projects").join(&project_id);
    std::fs::create_dir_all(&projects_dir)
        .map_err(|e| format!("Failed to create projects dir: {}", e))?;

    let md_path = projects_dir.join("project_globals.md");

    let mut content = format!("# {}\n\n", project_name);

    if !analysis_summary.is_empty() {
        content.push_str("## AI 分析摘要\n\n");
        content.push_str(&analysis_summary);
        content.push_str("\n\n");
    }

    content.push_str("## 项目全局参数\n\n");
    if !video_type.is_empty() {
        content.push_str(&format!("- 视频类型: {}\n", video_type));
    }
    if !aspect_ratio.is_empty() {
        content.push_str(&format!("- 画幅比例: {}\n", aspect_ratio));
    }
    if !style.is_empty() {
        content.push_str(&format!("- 视觉风格: {}\n", style));
    }
    if !tone.is_empty() {
        content.push_str(&format!("- 项目调性: {}\n", tone));
    }
    if !director_ref.is_empty() {
        content.push_str(&format!("- 旅行视频风格: {}\n", director_ref));
    }

    // Add emphasis dimensions
    if !emphasis_dimensions_json.is_empty() && emphasis_dimensions_json != "[]" {
        if let Ok(dims) = serde_json::from_str::<Vec<String>>(&emphasis_dimensions_json) {
            if !dims.is_empty() {
                content.push_str("- 提示词重点维度: ");
                content.push_str(&dims.join("、"));
                content.push_str("\n");
            }
        }
    }

    // Add AI params if available
    if !ai_params_json.is_empty() && ai_params_json != "{}" {
        content.push_str("\n## AI 参数\n\n");
        if let Ok(params) = serde_json::from_str::<serde_json::Value>(&ai_params_json) {
            if let Some(obj) = params.as_object() {
                for (key, value) in obj {
                    if let Some(val_str) = value.as_str() {
                        content.push_str(&format!("- {}: {}\n", key, val_str));
                    }
                }
            }
        }
    }

    std::fs::write(&md_path, &content)
        .map_err(|e| format!("Failed to write project globals: {}", e))?;

    let path_str = md_path.to_string_lossy().to_string();
    info!("[Project] 项目全局参数文件已生成: {}", path_str);

    Ok(path_str)
}

#[tauri::command]
pub fn read_project_globals_md(app: AppHandle, project_id: String) -> Result<String, String> {
    let md_path = crate::sync::get_user_dir(&app)?
        .join("projects")
        .join(&project_id)
        .join("project_globals.md");

    if !md_path.exists() {
        return Ok(String::new()); // No globals file = empty context
    }

    let content = std::fs::read_to_string(&md_path)
        .map_err(|e| format!("Failed to read project globals: {}", e))?;

    info!("[Project] 项目全局参数文件已读取: {} ({} 字符)", md_path.display(), content.len());
    Ok(content)
}

// ── 云端同步：DB 合并 ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectNameConflict {
    pub name: String,
    pub local_id: String,
    pub cloud_id: String,
    pub local_updated_at: i64,
    pub cloud_updated_at: i64,
    pub local_node_count: i64,
    pub cloud_node_count: i64,
}

#[derive(Debug, Clone)]
struct ProjMeta {
    name: String,
    updated_at: i64,
    node_count: i64,
}

#[derive(Debug, Clone)]
struct RemoteRow {
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    node_count: i64,
    nodes_json: String,
    edges_json: String,
    viewport_json: String,
    history_json: String,
    aspect_ratio: String,
    style: String,
    tone: String,
    director_ref: String,
    video_type: String,
    emphasis_dimensions: String,
    ai_analysis: String,
    ai_params: String,
    global_params_md_path: String,
}

/// 将云端 DB 合并到本地 DB。
/// 铁律：绝不删除本地项目。云端项目只追加或更新同 ID 项目。
/// 同名不同 ID → 返回冲突列表，不做任何写入。
pub fn merge_remote_db(
    app: &AppHandle,
    remote_db_path: &std::path::Path,
) -> Result<Vec<ProjectNameConflict>, String> {
    use std::collections::HashMap;

    let local_path = resolve_db_path(app)?;
    let local = Connection::open(&local_path)
        .map_err(|e| format!("open local db: {e}"))?;
    let remote = Connection::open(remote_db_path)
        .map_err(|e| format!("open remote db: {e}"))?;

    ensure_projects_table(&local)?;

    // 读取本地所有项目的基本信息
    let mut local_map: HashMap<String, ProjMeta> = HashMap::new();
    {
        let mut stmt = local
            .prepare("SELECT id, name, updated_at, node_count FROM projects")
            .map_err(|e| format!("local query: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ProjMeta {
                        name: row.get(1)?,
                        updated_at: row.get(2)?,
                        node_count: row.get(3)?,
                    },
                ))
            })
            .map_err(|e| format!("local rows: {e}"))?;
        for r in rows {
            let (id, meta) = r.map_err(|e| format!("local row: {e}"))?;
            local_map.insert(id, meta);
        }
    }

    // 读取远程所有项目的完整数据
    let mut remote_rows: Vec<RemoteRow> = Vec::new();
    {
        let mut stmt = remote
            .prepare(
                "SELECT id, name, created_at, updated_at, node_count,
                        nodes_json, edges_json, viewport_json, history_json,
                        aspect_ratio, style, tone, director_ref, video_type,
                        emphasis_dimensions, ai_analysis, ai_params, global_params_md_path
                 FROM projects",
            )
            .map_err(|e| format!("remote query: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(RemoteRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    node_count: row.get(4)?,
                    nodes_json: row.get(5)?,
                    edges_json: row.get(6)?,
                    viewport_json: row.get(7)?,
                    history_json: row.get(8)?,
                    aspect_ratio: row.get(9)?,
                    style: row.get(10)?,
                    tone: row.get(11)?,
                    director_ref: row.get(12)?,
                    video_type: row.get(13)?,
                    emphasis_dimensions: row.get(14)?,
                    ai_analysis: row.get(15)?,
                    ai_params: row.get(16)?,
                    global_params_md_path: row.get(17)?,
                })
            })
            .map_err(|e| format!("remote rows: {e}"))?;
        for r in rows {
            remote_rows.push(r.map_err(|e| format!("remote row: {e}"))?);
        }
    }

    if remote_rows.is_empty() {
        info!("[merge_remote_db] 远程 DB 无项目，跳过合并");
        return Ok(vec![]);
    }

    // 检测冲突：同名不同 ID
    let mut conflicts: Vec<ProjectNameConflict> = Vec::new();
    for rr in &remote_rows {
        if let Some(lm) = local_map.get(&rr.id) {
            // 同 ID，同一项目，不算冲突
            continue;
        }
        // 不同 ID，检查名称是否冲突
        for (lid, lm) in &local_map {
            if lm.name == rr.name {
                conflicts.push(ProjectNameConflict {
                    name: rr.name.clone(),
                    local_id: lid.clone(),
                    cloud_id: rr.id.clone(),
                    local_updated_at: lm.updated_at,
                    cloud_updated_at: rr.updated_at,
                    local_node_count: lm.node_count,
                    cloud_node_count: rr.node_count,
                });
                break; // 同名只需记录一次
            }
        }
    }

    if !conflicts.is_empty() {
        info!(
            "[merge_remote_db] 检测到 {} 个项目名冲突，暂停合并等待用户决策",
            conflicts.len()
        );
        return Ok(conflicts);
    }

    // 无冲突 → 执行合并
    merge_remote_into_local(&local, &remote, &remote_rows, &local_map)?;

    info!(
        "[merge_remote_db] 合并完成 (remote {} projects)",
        remote_rows.len()
    );
    Ok(vec![])
}

fn merge_remote_into_local(
    local: &Connection,
    remote: &Connection,
    remote_rows: &[RemoteRow],
    local_map: &std::collections::HashMap<String, ProjMeta>,
) -> Result<(), String> {
    for rr in remote_rows {
        if let Some(_lm) = local_map.get(&rr.id) {
            // 同 ID → 只当远程更新时才覆盖
            if rr.updated_at > _lm.updated_at {
                local
                    .execute(
                        "UPDATE projects SET name=?, updated_at=?, node_count=?,
                         nodes_json=?, edges_json=?, viewport_json=?, history_json=?,
                         aspect_ratio=?, style=?, tone=?, director_ref=?, video_type=?,
                         emphasis_dimensions=?, ai_analysis=?, ai_params=?, global_params_md_path=?
                         WHERE id=?",
                        params![
                            rr.name, rr.updated_at, rr.node_count,
                            rr.nodes_json, rr.edges_json, rr.viewport_json, rr.history_json,
                            rr.aspect_ratio, rr.style, rr.tone, rr.director_ref,
                            rr.video_type, rr.emphasis_dimensions, rr.ai_analysis, rr.ai_params, rr.global_params_md_path,
                            rr.id,
                        ],
                    )
                    .map_err(|e| format!("update project {}: {e}", rr.id))?;
                info!("[merge] 更新项目 {} (updated_at {} > {})", rr.name, rr.updated_at, _lm.updated_at);
            }
        } else {
            // 新项目 → INSERT
            local
                .execute(
                    "INSERT INTO projects (id, name, created_at, updated_at, node_count,
                     nodes_json, edges_json, viewport_json, history_json,
                     aspect_ratio, style, tone, director_ref, video_type,
                     emphasis_dimensions, ai_analysis, ai_params, global_params_md_path)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
                    params![
                        rr.id, rr.name, rr.created_at, rr.updated_at, rr.node_count,
                        rr.nodes_json, rr.edges_json, rr.viewport_json, rr.history_json,
                        rr.aspect_ratio, rr.style, rr.tone, rr.director_ref,
                        rr.video_type, rr.emphasis_dimensions, rr.ai_analysis, rr.ai_params, rr.global_params_md_path,
                    ],
                )
                .map_err(|e| format!("insert project {}: {e}", rr.id))?;
            info!("[merge] 新增项目 {}", rr.name);

            // 同步该项目下的 episodes
            let mut estmt = remote
                .prepare(
                    "SELECT id, project_id, name, number, nodes_json, edges_json,
                            viewport_json, history_json, created_at, updated_at
                     FROM episodes WHERE project_id=?",
                )
                .map_err(|e| format!("episodes query: {e}"))?;
            let erows: Vec<EpisodeRecord> = estmt
                .query_map(params![rr.id], |row| {
                    Ok(EpisodeRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        name: row.get(2)?,
                        number: row.get(3)?,
                        nodes_json: row.get(4)?,
                        edges_json: row.get(5)?,
                        viewport_json: row.get(6)?,
                        history_json: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                })
                .map_err(|e| format!("episodes rows: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            for ep in &erows {
                local
                    .execute(
                        "INSERT OR REPLACE INTO episodes
                         (id, project_id, name, number, nodes_json, edges_json,
                          viewport_json, history_json, created_at, updated_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                        params![
                            ep.id, ep.project_id, ep.name, ep.number,
                            ep.nodes_json, ep.edges_json, ep.viewport_json, ep.history_json,
                            ep.created_at, ep.updated_at,
                        ],
                    )
                    .map_err(|e| format!("insert episode {}: {e}", ep.id))?;
            }
            if !erows.is_empty() {
                info!("[merge] 项目 {} 同步 {} 个 episodes", rr.name, erows.len());
            }
        }
    }
    Ok(())
}
