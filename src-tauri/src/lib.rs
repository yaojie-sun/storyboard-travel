pub mod ai;
pub mod commands;
pub mod sync;

use std::path::PathBuf;
use std::time::Duration;

use commands::ai as ai_commands;
use commands::asset;
use commands::banana_api;
use commands::chat;
use commands::enhance;
use commands::image;
use commands::project_state;
use commands::seedance_integration;
use commands::skill_management;
use commands::sync as sync_commands;
use commands::system;
use commands::update;
use commands::usage_report;
use tauri::{Emitter, Manager, WindowEvent};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const MAIN_WINDOW_LABEL: &str = "main";
const FRONTEND_READY_TIMEOUT_MS: u64 = 3_500;
fn resolve_log_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join("Library/Logs/storyboard-travel"));
    }

    candidates.push(std::env::temp_dir().join("storyboard-travel/logs"));

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("logs"));
    }

    for directory in candidates {
        if std::fs::create_dir_all(&directory).is_ok() {
            return Some(directory);
        }
    }

    None
}

fn setup_logging() {
    eprintln!("[DEBUG] setup_logging函数被调用");
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "debug,storyboard_travel=trace,tauri=debug,reqwest=debug".into());

    // 创建控制台输出层
    let console_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stdout)
        .with_target(true)
        .with_level(true)
        .with_thread_ids(false)
        .with_thread_names(false);

    if let Some(log_dir) = resolve_log_dir() {
        let file_appender = tracing_appender::rolling::daily(log_dir, "storyboard.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
        std::mem::forget(_guard);

        // 文件输出层
        let file_layer = tracing_subscriber::fmt::layer()
            .with_writer(non_blocking)
            .with_target(true)
            .with_level(true)
            .with_thread_ids(false)
            .with_thread_names(false);

        tracing_subscriber::registry()
            .with(env_filter)
            .with(console_layer)
            .with(file_layer)
            .init();
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(console_layer)
            .init();
    }

    info!("Storyboard Travel starting...");
}

#[cfg(not(target_os = "android"))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(err) = main_window.show() {
            warn!("failed to show main window: {err}");
        }
        if let Err(err) = main_window.set_focus() {
            warn!("failed to focus main window: {err}");
        }
    } else {
        warn!("main window not found while trying to reveal UI");
    }
}

#[tauri::command]
#[cfg_attr(target_os = "android", allow(unused_variables))]
fn frontend_ready(app: tauri::AppHandle) {
    info!("frontend_ready received, revealing main window");
    #[cfg(not(target_os = "android"))]
    show_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_logging();

    tauri::Builder::default()
        .on_page_load(|window, _payload| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            info!("main page loaded, revealing main window");
            #[cfg(not(target_os = "android"))]
            show_main_window(&window.app_handle());
        })
        .setup(|app| {
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == MAIN_WINDOW_LABEL)
                .cloned()
                .ok_or_else(|| "missing main window config".to_string())?;

            #[cfg(not(target_os = "macos"))]
            let main_window = tauri::WebviewWindowBuilder::from_config(app, &window_config)?.build()?;

            #[cfg(not(any(target_os = "macos", target_os = "android")))]
            {
                if let Err(err) = main_window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }
            }

            #[cfg(target_os = "macos")]
            {
                let mut mac_window_config = window_config;
                // Window effects radius only works for transparent windows on macOS.
                mac_window_config.transparent = true;

                let window = tauri::WebviewWindowBuilder::from_config(app, &mac_window_config)?.build()?;

                #[cfg(not(target_os = "android"))]
                if let Err(err) = window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }

                if let Err(err) = window.set_effects(Some(
                    tauri::window::EffectsBuilder::new()
                        .effect(tauri::window::Effect::Titlebar)
                        .radius(10.0)
                        .build(),
                )) {
                    warn!("failed to apply macOS window effects: {err}");
                }
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(FRONTEND_READY_TIMEOUT_MS)).await;

                let is_main_visible = app_handle
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);

                if !is_main_visible {
                    warn!(
                        "frontend_ready timeout after {}ms, forcing main window reveal",
                        FRONTEND_READY_TIMEOUT_MS
                    );
                    #[cfg(not(target_os = "android"))]
                    show_main_window(&app_handle);
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            image::split_image,
            image::split_image_source,
            image::prepare_node_image_source,
            image::prepare_node_image_binary,
            image::crop_image_source,
            image::merge_storyboard_images,
            image::read_storyboard_image_metadata,
            image::embed_storyboard_image_metadata,
            image::load_image,
            image::persist_image_source,
            image::persist_image_binary,
            image::save_image_source_to_downloads,
            image::save_image_source_to_path,
            image::save_image_source_to_directory,
            image::save_image_source_to_app_debug_dir,
            #[cfg(not(target_os = "android"))]
            image::copy_image_source_to_clipboard,
            enhance::enhance_image,
            enhance::enhance_video,
            ai_commands::set_api_key,
            ai_commands::clear_all_api_keys,
            ai_commands::submit_generate_image_job,
            ai_commands::get_generate_image_job,
            ai_commands::generate_image,
            ai_commands::list_models,
            banana_api::banana_login,
            banana_api::banana_register,
            banana_api::banana_logout,
            banana_api::banana_get_current_user,
            banana_api::banana_check_credits,
            banana_api::banana_create_payment_order,
            banana_api::banana_check_payment_status,
            banana_api::banana_get_credits_per_yuan,
            banana_api::banana_call_image_api,
            banana_api::banana_get_active_api_configs,
            banana_api::banana_update_local_api_keys,
            banana_api::banana_activate_account,
            banana_api::banana_initialize,
            banana_api::banana_save_device_token,
            banana_api::banana_consume_credit,
            banana_api::banana_send_reset_code,
            banana_api::banana_reset_password,
            banana_api::banana_submit_video_job,
            banana_api::banana_poll_video_job,
            banana_api::banana_refund_credits,
            banana_api::banana_get_active_video_model,
            banana_api::baidu_upscale_video,
            banana_api::banana_get_consumption_history,
            banana_api::copy_file_to_path,
            banana_api::download_video_to_local,
            usage_report::banana_report_usage,
            chat::chat_send_message,
            chat::save_chat_conversations,
            chat::load_chat_conversations,
            chat::migrate_chat_storage,
            chat::check_skill_upgrade,
            chat::perform_skill_upgrade,
            chat::integrate_video_prompt,
            chat::analyze_story,

            chat::load_videogen_store,
            chat::persist_videogen_store,
            seedance_integration::create_project_from_seedance,
            skill_management::upload_skill_file,
            skill_management::get_skill_file_info,
            skill_management::get_skill_file_content,
            project_state::list_project_summaries,
            project_state::get_project_record,
            project_state::upsert_project_record,
            project_state::update_project_viewport_record,
            project_state::rename_project_record,
            project_state::delete_project_record,
            project_state::list_episode_records,
            project_state::get_episode_record,
            project_state::upsert_episode_record,
            project_state::delete_episode_record,
            project_state::confirm_close,
            project_state::generate_project_globals_md,
            project_state::read_project_globals_md,
            system::get_runtime_system_info,
            asset::add_asset,
            asset::update_asset,
            asset::list_assets,
            asset::delete_asset,
            update::check_for_upgrade,
            update::fetch_grid_prompt_rules,
            update::fetch_video_gen_rules,
            update::download_upgrade,
            update::launch_installer,
            sync_commands::sync_pull,
            sync_commands::sync_push,
            sync_commands::sync_get_status,
            sync_commands::sync_force_full_push,
            sync_commands::sync_export_settings,
            sync_commands::sync_import_settings,
            sync_commands::sync_test_qiniu,
            sync_commands::sync_resolve_conflicts,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW_LABEL {
                    // 阻止立即关闭，先通知前端 flush 数据
                    api.prevent_close();
                    let _ = window.emit("flush-before-close", ());
                    // 安全兜底：3 秒后强制退出，防止前端无响应导致进程残留
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_secs(3));
                        std::process::exit(0);
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
