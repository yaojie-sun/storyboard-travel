use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::RwLock;
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use crate::ai::deepseek;
use crate::ai::error::AIError;
use crate::ai::providers::build_default_providers;
use crate::ai::{
    GenerateRequest, ProviderRegistry, ProviderTaskHandle, ProviderTaskPollResult,
    ProviderTaskSubmission,
};

static REGISTRY: std::sync::OnceLock<ProviderRegistry> = std::sync::OnceLock::new();
static ACTIVE_NON_RESUMABLE_JOB_IDS: std::sync::OnceLock<Arc<RwLock<HashSet<String>>>> =
    std::sync::OnceLock::new();

/// 图像轮询连续错误计数（job_id → 连续错误次数），>= 5 触发退费
static IMAGE_POLL_ERROR_COUNT: std::sync::LazyLock<Arc<Mutex<HashMap<String, u32>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 已退费的图像任务 job_id 集合，防止同一任务重复退费
static IMAGE_REFUNDED_JOB_IDS: std::sync::LazyLock<Arc<Mutex<HashSet<String>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashSet::new())));

pub fn get_registry() -> &'static ProviderRegistry {
    REGISTRY.get_or_init(|| {
        let mut registry = ProviderRegistry::new();
        for provider in build_default_providers() {
            registry.register_provider(provider);
        }
        registry
    })
}

fn active_non_resumable_job_ids() -> &'static Arc<RwLock<HashSet<String>>> {
    ACTIVE_NON_RESUMABLE_JOB_IDS.get_or_init(|| Arc::new(RwLock::new(HashSet::new())))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRequestDto {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, Value>>,
    pub enable_optimization: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobStatusDto {
    pub job_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug)]
struct GenerationJobRecord {
    job_id: String,
    provider_id: String,
    status: String,
    resumable: bool,
    external_task_id: Option<String>,
    external_task_meta_json: Option<String>,
    result: Option<String>,
    error: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::sync::get_user_dir(app)?.join("projects.db"))
}

fn ensure_generation_jobs_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_generation_jobs (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          status TEXT NOT NULL,
          resumable INTEGER NOT NULL DEFAULT 0,
          external_task_id TEXT,
          external_task_meta_json TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_status ON ai_generation_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_updated_at ON ai_generation_jobs(updated_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_generation_jobs table: {}", e))?;

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

    ensure_generation_jobs_table(&conn)?;
    Ok(conn)
}

fn insert_generation_job(
    app: &AppHandle,
    job_id: &str,
    provider_id: &str,
    status: &str,
    resumable: bool,
    external_task_id: Option<&str>,
    external_task_meta_json: Option<&str>,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO ai_generation_jobs (
          job_id,
          provider_id,
          status,
          resumable,
          external_task_id,
          external_task_meta_json,
          result,
          error,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            job_id,
            provider_id,
            status,
            if resumable { 1_i64 } else { 0_i64 },
            external_task_id,
            external_task_meta_json,
            result,
            error,
            now,
            now
        ],
    )
    .map_err(|e| format!("Failed to insert generation job: {}", e))?;
    Ok(())
}

fn update_generation_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          error = ?3,
          updated_at = ?4
        WHERE job_id = ?5
        "#,
        params![status, result, error, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job: {}", e))?;
    Ok(())
}

fn touch_generation_job(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET updated_at = ?1 WHERE job_id = ?2",
        params![now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to touch generation job: {}", e))?;
    Ok(())
}

fn get_generation_job(app: &AppHandle, job_id: &str) -> Result<Option<GenerationJobRecord>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              job_id,
              provider_id,
              status,
              resumable,
              external_task_id,
              external_task_meta_json,
              result,
              error
            FROM ai_generation_jobs
            WHERE job_id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare generation job query: {}", e))?;

    let result = stmt.query_row(params![job_id], |row| {
        Ok(GenerationJobRecord {
            job_id: row.get(0)?,
            provider_id: row.get(1)?,
            status: row.get(2)?,
            resumable: row.get::<_, i64>(3)? != 0,
            external_task_id: row.get(4)?,
            external_task_meta_json: row.get(5)?,
            result: row.get(6)?,
            error: row.get(7)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load generation job: {}", error)),
    }
}

fn dto_from_record(record: &GenerationJobRecord) -> GenerationJobStatusDto {
    GenerationJobStatusDto {
        job_id: record.job_id.clone(),
        status: record.status.clone(),
        result: record.result.clone(),
        error: record.error.clone(),
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    info!("Setting API key for provider: {}", provider);

    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    resolved_provider
        .set_api_key(api_key)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn clear_all_api_keys() -> Result<(), String> {
    info!("清除所有API密钥");

    let registry = get_registry();
    let providers = registry.list_providers();

    for provider_name in providers {
        if let Some(provider) = registry.get_provider(&provider_name) {
            if let Err(e) = provider.set_api_key("".to_string()).await {
                // 记录错误但继续清除其他provider
                info!("清除{}的API密钥失败: {}", provider_name, e);
            } else {
                info!("已清除{}的API密钥", provider_name);
            }
        }
    }

    Ok(())
}


#[tauri::command]
pub async fn submit_generate_image_job(
    app: AppHandle,
    request: GenerateRequestDto,
) -> Result<String, String> {
    info!("Submitting generation job with model: {}", request.model);

    let enable_optimization = request.enable_optimization.unwrap_or(false);
    let prompt = if enable_optimization {
        let device_token = {
            let store = super::banana_api::get_device_token_store();
            store.lock().await.clone().unwrap_or_default()
        };
        let api_key = match super::banana_api::get_user_api_key(&device_token).await {
            Ok(key) => key,
            Err(e) => {
                warn!("get_user_api_key 失败({:?}), 回退到 ensure_user_api_token", e);
                super::banana_api::ensure_user_api_token(&device_token).await.unwrap_or_default()
            }
        };
        match deepseek::optimize_prompt(&request.prompt, &api_key).await {
            Ok(optimized) => {
                info!(
                    "[小鸭] prompt optimized: {} -> {} chars",
                    request.prompt.len(),
                    optimized.len()
                );
                optimized
            }
            Err(e) => {
                info!("[小鸭] optimization failed, using original prompt: {}", e);
                request.prompt.clone()
            }
        }
    } else {
        request.prompt.clone()
    };

    // Volcengine 模型走服务器网关（认证 + 扣费），不走本地 Provider
    if request.model.starts_with("volcengine/") {
        let image_url = super::banana_api::banana_call_image_api(
            app.clone(),
            prompt,
            request.model.clone(),
            request.size.clone(),
            request.aspect_ratio.clone(),
            request.reference_images.clone(),
            request.extra_params.clone(),
        )
        .await?;

        let job_id = Uuid::new_v4().to_string();
        insert_generation_job(
            &app,
            &job_id,
            "volcengine",
            "succeeded",
            false,
            None,
            None,
            Some(&image_url),
            None,
        )?;
        return Ok(job_id);
    }

    let registry = get_registry();
    let providers = registry.resolve_with_fallback(&request.model);

    if providers.is_empty() {
        return Err("Provider not found".to_string());
    }

    let req = GenerateRequest {
        prompt,
        model: request.model.clone(),
        size: request.size.clone(),
        aspect_ratio: request.aspect_ratio.clone(),
        reference_images: request.reference_images.clone(),
        extra_params: request.extra_params.clone(),
    };

    let job_id = Uuid::new_v4().to_string();

    // Try providers in order (primary → fallback)
    let mut last_error = String::new();
    for provider in &providers {
        let provider_id = provider.name().to_string();

        if provider.supports_task_resume() {
            match provider.submit_task(req.clone()).await {
                Ok(submission) => {
                    match submission {
                        ProviderTaskSubmission::Succeeded(image_source) => {
                            insert_generation_job(
                                &app,
                                job_id.as_str(),
                                provider_id.as_str(),
                                "succeeded",
                                true,
                                None,
                                None,
                                Some(image_source.as_str()),
                                None,
                            )?;
                        }
                        ProviderTaskSubmission::Queued(handle) => {
                            let wrapper = serde_json::json!({
                                "request": req,
                                "tried_providers": [&provider_id]
                            });
                            let meta_json = serde_json::to_string(&wrapper).ok();
                            insert_generation_job(
                                &app,
                                job_id.as_str(),
                                provider_id.as_str(),
                                "running",
                                true,
                                Some(handle.task_id.as_str()),
                                meta_json.as_deref(),
                                None,
                                None,
                            )?;
                        }
                    }
                    return Ok(job_id);
                }
                Err(e) => {
                    warn!(
                        "Provider '{}' submit_task failed for model '{}': {}, trying fallback...",
                        provider_id, request.model, e
                    );
                    last_error = e.to_string();
                }
            }
        } else {
            // Non-resumable provider: deduct credits before spawn
            match super::banana_api::banana_consume_credit(
                app.clone(),
                Some(10),
                Some("image_generation".to_string()),
                None,
            ).await {
                Ok(_) => {}
                Err(e) => {
                    warn!("[计费失败] credit deduction failed: {}", e);
                    return Err(e);
                }
            }

            // Keep reference images intact — Baidu GPT Image 2 edits endpoint
            // receives each reference image as a separate image[] form field.
            info!("[百度参考图] 收到 {} 张参考图, 直接传递给Provider",
                req.reference_images.as_ref().map_or(0, |r| r.len()));
            let spawned_req = GenerateRequest {
                prompt: req.prompt.clone(),
                model: req.model.clone(),
                size: req.size.clone(),
                aspect_ratio: req.aspect_ratio.clone(),
                reference_images: req.reference_images.clone(),
                extra_params: req.extra_params.clone(),
            };

            // Non-resumable provider: spawn async task with fallback
            if let Err(e) = insert_generation_job(
                &app,
                job_id.as_str(),
                provider_id.as_str(),
                "running",
                false,
                None,
                None,
                None,
                None,
            ) {
                // 扣费已完成但创建任务记录失败 → 立即退费，防止积分丢失
                let refund_handle = app.clone();
                let refund_job_id = job_id.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = super::banana_api::refund_generation_credit(
                        &refund_handle,
                        10,
                        format!("image_gen_db_error:{}", refund_job_id),
                    ).await;
                });
                return Err(e);
            }
            {
                let mut active_set = active_non_resumable_job_ids().write().await;
                active_set.insert(job_id.clone());
            }

            let app_handle = app.clone();
            let spawned_job_id = job_id.clone();
            let spawned_provider = provider.clone();
            tauri::async_runtime::spawn(async move {
                let result = spawned_provider.generate(spawned_req).await;
                let update_result = match result {
                    Ok(image_source) => update_generation_job(
                        &app_handle,
                        spawned_job_id.as_str(),
                        "succeeded",
                        Some(image_source.as_str()),
                        None,
                    ),
                    Err(error) => {
                        let message = error.to_string();
                        let _ = super::banana_api::refund_generation_credit(
                            &app_handle,
                            10,
                            format!("image_gen:{}", spawned_job_id),
                        ).await;
                        update_generation_job(
                            &app_handle,
                            spawned_job_id.as_str(),
                            "failed",
                            None,
                            Some(message.as_str()),
                        )
                    }
                };
                if let Err(error) = update_result {
                    info!("Failed to update non-resumable generation job: {}", error);
                }
                let mut active_set = active_non_resumable_job_ids().write().await;
                active_set.remove(spawned_job_id.as_str());
            });

            return Ok(job_id);
        }
    }

    // All providers exhausted at submit time — insert failed record and request refund
    insert_generation_job(
        &app,
        job_id.as_str(),
        "unknown",
        "failed",
        false,
        None,
        None,
        None,
        Some(&last_error),
    ).ok();

    match super::banana_api::refund_generation_credit(&app, 10, format!("image_gen:{}", job_id)).await {
        Ok(()) => last_error = format!("积分已自动返还。\n{}", last_error),
        Err(refund_err) => {
            warn!("[fallback] submit-time refund failed for {}: {}", job_id, refund_err);
        }
    }

    Err(last_error)
}

#[tauri::command]
pub async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(mut record) = maybe_record else {
        return Ok(GenerationJobStatusDto {
            job_id,
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
        });
    };

    if record.status == "succeeded" || record.status == "failed" {
        return Ok(dto_from_record(&record));
    }

    if !record.resumable {
        let is_active = {
            let active_set = active_non_resumable_job_ids().read().await;
            active_set.contains(record.job_id.as_str())
        };
        if is_active {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            return Ok(dto_from_record(&record));
        }

        let interrupted_message = "job interrupted by app restart".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(interrupted_message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(interrupted_message);
        return Ok(dto_from_record(&record));
    }

    let provider = get_registry()
        .get_provider(record.provider_id.as_str())
        .cloned()
        .ok_or_else(|| format!("Provider not found for job: {}", record.provider_id))?;

    let Some(task_id) = record.external_task_id.clone() else {
        let message = "missing external task id".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(message);
        return Ok(dto_from_record(&record));
    };

    let task_meta = record
        .external_task_meta_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());

    match provider
        .poll_task(ProviderTaskHandle {
            task_id,
            metadata: task_meta,
        })
        .await
    {
        Ok(ProviderTaskPollResult::Queued) | Ok(ProviderTaskPollResult::Running) => {
            // 重置连续错误计数
            {
                let mut counts = IMAGE_POLL_ERROR_COUNT.lock().await;
                counts.remove(&record.job_id);
            }
            let _ = touch_generation_job(&app, record.job_id.as_str());
            Ok(dto_from_record(&record))
        }
        Ok(ProviderTaskPollResult::Succeeded(image_source)) => {
            // 重置连续错误计数
            {
                let mut counts = IMAGE_POLL_ERROR_COUNT.lock().await;
                counts.remove(&record.job_id);
            }
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "succeeded".to_string(),
                result: Some(image_source),
                error: None,
            })
        }
        Ok(ProviderTaskPollResult::Failed(failure_message))
        | Err(AIError::TaskFailed(failure_message)) => {
            // 重置连续错误计数
            {
                let mut counts = IMAGE_POLL_ERROR_COUNT.lock().await;
                counts.remove(&record.job_id);
            }
            // Parse stored request + tried providers from metadata
            let meta: serde_json::Value = record
                .external_task_meta_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_default();

            let tried: Vec<String> = meta["tried_providers"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();

            let stored_request: Option<GenerateRequest> = meta
                .get("request")
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            match stored_request {
                Some(req) => {
                    let registry = get_registry();
                    let candidates = registry.resolve_with_fallback(&req.model);
                    let fallback = candidates
                        .iter()
                        .find(|p| !tried.iter().any(|t| t == p.name()));

                    if let Some(fb_provider) = fallback {
                        let fb_name = fb_provider.name().to_string();
                        info!(
                            "[fallback] provider '{}' failed, trying fallback '{}'",
                            record.provider_id, fb_name
                        );
                        match fb_provider.submit_task(req.clone()).await {
                            Ok(ProviderTaskSubmission::Succeeded(image)) => {
                                update_generation_job(
                                    &app,
                                    record.job_id.as_str(),
                                    "succeeded",
                                    Some(image.as_str()),
                                    None,
                                )?;
                                return Ok(GenerationJobStatusDto {
                                    job_id: record.job_id.clone(),
                                    status: "succeeded".to_string(),
                                    result: Some(image),
                                    error: None,
                                });
                            }
                            Ok(ProviderTaskSubmission::Queued(handle)) => {
                                let mut new_tried = tried;
                                new_tried.push(fb_name.clone());
                                let wrapper = serde_json::json!({
                                    "request": req,
                                    "tried_providers": new_tried
                                });
                                let new_meta = serde_json::to_string(&wrapper).ok();
                                let update_sql = "UPDATE ai_generation_jobs SET provider_id=?1, external_task_id=?2, external_task_meta_json=?3, updated_at=?4 WHERE job_id=?5";
                                let conn = open_db(&app)?;
                                conn.execute(
                                    update_sql,
                                    params![
                                        fb_name.as_str(),
                                        handle.task_id.as_str(),
                                        new_meta.as_deref(),
                                        now_ms(),
                                        record.job_id.as_str(),
                                    ],
                                )
                                .map_err(|e| format!("update job for fallback: {}", e))?;
                                record.provider_id = fb_name;
                                record.external_task_id = Some(handle.task_id);
                                record.external_task_meta_json = new_meta;
                                return Ok(dto_from_record(&record));
                            }
                            Err(submit_err) => {
                                warn!(
                                    "[fallback] submit to '{}' also failed: {}",
                                    fb_name, submit_err
                                );
                                // fall through to final failure
                            }
                        }
                    }
                }
                None => {
                    // no stored request, can't fallback
                }
            }

            // All providers exhausted — request refund before marking failed
            info!("[fallback] all providers exhausted, requesting refund for {}", record.job_id);
            let refunded = super::banana_api::refund_generation_credit(&app, 10, format!("image_gen_poll:{}", record.job_id)).await.is_ok();
            if !refunded {
                warn!("[fallback] poll-time refund failed for {}", record.job_id);
            }
            let final_message = if refunded {
                format!("积分已自动返还。\n{}", failure_message)
            } else {
                failure_message
            };
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(&final_message),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(final_message),
            })
        }
        Err(error) => {
            let err_msg = error.to_string();
            warn!("图像任务轮询临时错误: {}", err_msg);

            let mut counts = IMAGE_POLL_ERROR_COUNT.lock().await;
            let count = counts.entry(record.job_id.clone()).and_modify(|c| *c += 1).or_insert(1);
            let current = *count;

            if current >= 5 {
                counts.remove(&record.job_id);
                drop(counts);

                // 防重复退费：同一 job_id 只退一次
                let already_refunded = {
                    let set = IMAGE_REFUNDED_JOB_IDS.lock().await;
                    set.contains(&record.job_id)
                };
                if already_refunded {
                    warn!("图像任务 {} 已退过费，跳过重复退费", record.job_id);
                    let final_message = format!("轮询连续失败{}次: {}（已退过费）", current, err_msg);
                    update_generation_job(
                        &app,
                        record.job_id.as_str(),
                        "failed",
                        None,
                        Some(&final_message),
                    )?;
                    return Ok(GenerationJobStatusDto {
                        job_id: record.job_id,
                        status: "failed".to_string(),
                        result: None,
                        error: Some(final_message),
                    });
                }

                let refunded = super::banana_api::refund_generation_credit(
                    &app, 10, format!("image_gen_poll_error:{}", record.job_id),
                ).await;
                if refunded.is_ok() {
                    let mut set = IMAGE_REFUNDED_JOB_IDS.lock().await;
                    set.insert(record.job_id.clone());
                }
                let refund_msg = match &refunded {
                    Ok(()) => "，已退回10积分".to_string(),
                    Err(e) => format!("，退费失败: {}", e),
                };
                let final_message = format!("轮询连续失败{}次: {}{}", current, err_msg, refund_msg);
                update_generation_job(
                    &app,
                    record.job_id.as_str(),
                    "failed",
                    None,
                    Some(&final_message),
                )?;
                return Ok(GenerationJobStatusDto {
                    job_id: record.job_id,
                    status: "failed".to_string(),
                    result: None,
                    error: Some(final_message),
                });
            }

            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "running".to_string(),
                result: None,
                error: Some(err_msg),
            })
        },
    }
}

#[tauri::command]
pub async fn generate_image(request: GenerateRequestDto) -> Result<String, String> {
    info!("Generating image with model: {}", request.model);

    let registry = get_registry();
    let providers = registry.resolve_with_fallback(&request.model);

    if providers.is_empty() {
        return Err("Provider not found".to_string());
    }

    let req = GenerateRequest {
        prompt: request.prompt.clone(),
        model: request.model.clone(),
        size: request.size.clone(),
        aspect_ratio: request.aspect_ratio.clone(),
        reference_images: request.reference_images.clone(),
        extra_params: request.extra_params.clone(),
    };

    let mut last_error = String::new();
    for provider in &providers {
        match provider.generate(req.clone()).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                warn!(
                    "Provider '{}' failed for model '{}': {}, trying fallback...",
                    provider.name(),
                    request.model,
                    e
                );
                last_error = e.to_string();
            }
        }
    }
    Err(last_error)
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<String>, String> {
    Ok(get_registry().list_models())
}
