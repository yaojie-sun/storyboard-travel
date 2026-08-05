use serde::Serialize;

#[derive(Debug, Serialize)]
struct UsageReport {
    user_id: u32,
    api_type: String,
    is_success: bool,
    cost_credits: u32,
    response_time_ms: u64,
    request_data: serde_json::Value,
    response_data: serde_json::Value,
}

async fn do_report_usage(report: UsageReport) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = client
        .post("https://aixiaoxi.top/api/v1/usage/report")
        .json(&report)
        .send()
        .await;
}

/// 上报用量到服务器（fire-and-forget，不阻塞调用方）
#[tauri::command]
pub async fn banana_report_usage(
    user_id: u32,
    api_type: String,
    is_success: bool,
    cost_credits: u32,
    response_time_ms: u64,
    category: String,
    image_size: String,
    duration_seconds: u32,
    prompt_len: u32,
    error_message: String,
) -> Result<(), String> {
    let report = UsageReport {
        user_id,
        api_type,
        is_success,
        cost_credits,
        response_time_ms,
        request_data: serde_json::json!({
            "category": category,
            "image_size": image_size,
            "duration_seconds": duration_seconds,
            "prompt_len": prompt_len,
            "app_version": env!("CARGO_PKG_VERSION"),
        }),
        response_data: serde_json::json!({
            "error_message": error_message,
        }),
    };
    tracing::info!("[UsageReport] user_id={:?} api_type={} is_success={} cost={}", report.user_id, report.api_type, report.is_success, report.cost_credits);
    tokio::spawn(async move { do_report_usage(report).await });
    Ok(())
}
