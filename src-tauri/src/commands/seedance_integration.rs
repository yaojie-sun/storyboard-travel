use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::commands::project_state::ProjectRecord;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridConfig {
    /// 宫格行数
    pub rows: u32,
    /// 宫格列数
    pub cols: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedanceProjectRequest {
    /// 分镜提示词（可以是整体描述或按宫格分隔的描述）
    pub prompt: String,
    /// 宫格配置
    pub grid: GridConfig,
    /// 可选的项目名称，如果为空则自动生成
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedanceProjectResponse {
    /// 创建的项目ID
    pub project_id: String,
    /// 项目名称
    pub project_name: String,
    /// 创建的故事板节点ID
    pub storyboard_node_id: String,
}

/// 将seedance-t生成的提示词分配到各个宫格frame的描述中
/// 假设提示词格式可能是：
/// 1. 整体描述（适用于所有宫格）
/// 2. 已按宫格分隔的描述（用换行、数字或标记分隔）
fn distribute_prompt_to_frames(prompt: &str, total_frames: usize) -> Vec<String> {
    let lines: Vec<&str> = prompt.lines().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();

    // 如果行数与宫格数匹配，且每行看起来像独立的描述
    if lines.len() == total_frames {
        return lines.iter().map(|&s| s.to_string()).collect();
    }

    // 简单尝试按数字标记解析，如 "1.", "2.", "分镜1:", "分镜2:" 等
    let mut frames = vec![String::new(); total_frames];
    let mut found_frames = 0;

    // 按行扫描
    for line in lines {
        // 检查是否以数字开头
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // 尝试匹配模式: 数字后跟点、冒号或中文冒号
        let mut chars = trimmed.chars();
        let mut index_str = String::new();

        // 收集开头的数字
        while let Some(c) = chars.next() {
            if c.is_ascii_digit() {
                index_str.push(c);
            } else {
                break;
            }
        }

        if !index_str.is_empty() {
            // 跳过分隔符（.、:、：等）
            let mut remaining_chars = chars.as_str();
            if remaining_chars.starts_with('.') || remaining_chars.starts_with(':') || remaining_chars.starts_with('：') {
                remaining_chars = &remaining_chars[1..];
            }

            // 跳过可能的中文前缀如"分镜"
            if remaining_chars.starts_with("分镜") {
                remaining_chars = &remaining_chars[2..];
                // 可能还有空格
                remaining_chars = remaining_chars.trim_start();
            }

            if let Ok(index) = index_str.parse::<usize>() {
                if index > 0 && index <= total_frames {
                    frames[index - 1] = remaining_chars.trim().to_string();
                    found_frames += 1;
                    continue;
                }
            }
        }
    }

    if found_frames > 0 {
        return frames;
    }

    // 否则，将整个提示词复制到所有frame
    vec![prompt.trim().to_string(); total_frames]
}

/// 创建包含故事板节点的新项目
#[tauri::command]
pub async fn create_project_from_seedance(
    app: AppHandle,
    request: SeedanceProjectRequest,
) -> Result<SeedanceProjectResponse, String> {
    // 生成项目ID和名称
    let project_id = Uuid::new_v4().to_string();
    let project_name = request.project_name.unwrap_or_else(|| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        format!("Seedance项目-{}", now)
    });

    // 计算宫格总数
    let total_frames = (request.grid.rows * request.grid.cols) as usize;

    // 分配提示词到各个frame
    let frame_descriptions = distribute_prompt_to_frames(&request.prompt, total_frames);

    // 创建frame items
    let frames: Vec<serde_json::Value> = frame_descriptions
        .iter()
        .enumerate()
        .map(|(_index, description)| {
            serde_json::json!({
                "id": Uuid::new_v4().to_string(),
                "description": description,
                "referenceIndex": null,
            })
        })
        .collect();

    // 创建故事板节点
    let storyboard_node_id = Uuid::new_v4().to_string();
    let storyboard_node = serde_json::json!({
        "id": storyboard_node_id,
        "type": "storyboardGenNode",
        "position": { "x": 100, "y": 100 },
        "data": {
            "displayName": "分镜生成",
            "gridRows": request.grid.rows,
            "gridCols": request.grid.cols,
            "frames": frames,
            "ratioControlMode": "cell",
            "model": "default",
            "size": "2K",
            "requestAspectRatio": "auto",
            "extraParams": {},
            "imageUrl": null,
            "previewImageUrl": null,
            "aspectRatio": "1:1",
            "isGenerating": false,
            "generationStartedAt": null,
            "generationDurationMs": 60000,
        },
        "width": 220,
        "height": 220,
    });

    // 创建项目记录
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let project_record = ProjectRecord {
        id: project_id.clone(),
        name: project_name.clone(),
        created_at: now_ms,
        updated_at: now_ms,
        node_count: 1,
        nodes_json: serde_json::to_string(&vec![storyboard_node]).map_err(|e| format!("Failed to serialize nodes: {}", e))?,
        edges_json: "[]".to_string(),
        viewport_json: serde_json::to_string(&serde_json::json!({
            "x": 0,
            "y": 0,
            "zoom": 1,
        })).map_err(|e| format!("Failed to serialize viewport: {}", e))?,
        history_json: "[]".to_string(),
        aspect_ratio: "".to_string(),
        style: "".to_string(),
        tone: "".to_string(),
        director_ref: "".to_string(),
        video_type: "".to_string(),
        emphasis_dimensions: "[]".to_string(),
        ai_analysis: "".to_string(),
        ai_params: "{}".to_string(),
        global_params_md_path: "".to_string(),
    };

    // 保存项目到数据库
    crate::commands::project_state::upsert_project_record(app.clone(), project_record)
        .map_err(|e| format!("Failed to save project: {}", e))?;

    Ok(SeedanceProjectResponse {
        project_id,
        project_name,
        storyboard_node_id,
    })
}