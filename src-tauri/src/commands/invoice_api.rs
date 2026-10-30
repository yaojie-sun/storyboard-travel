//! 发票申请（客户端侧）。
//!
//! 口径与产品确认一致：系统只做申请登记 + 额度账本，电子发票由人工开具后
//! 按用户填的邮箱发送。可开票额度 = 全部历史实付 − 已占用（待开票 + 已开票），
//! **额度一律由服务端算**，客户端只负责展示与上限校验，不自己算一套。
//!
//! 失败口径同 `notification_api.rs`：静默，不 emit `login-required`。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::support_http::call_api;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvoiceRequest {
    pub id: i64,
    #[serde(default)]
    pub user_id: Option<i64>,
    pub company_name: String,
    pub tax_id: String,
    pub email: String,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub invoice_type: Option<String>,
    pub amount: f64,
    pub status: String,
    #[serde(default)]
    pub admin_note: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub handled_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvoiceSummary {
    pub total_paid: f64,
    pub used: f64,
    pub available: f64,
    #[serde(default)]
    pub requests: Vec<InvoiceRequest>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvoiceSubmitResult {
    pub request: InvoiceRequest,
    pub total_paid: f64,
    pub used: f64,
    pub available: f64,
}

#[derive(Debug, Serialize)]
pub struct InvoiceSubmitPayload {
    pub company_name: String,
    pub tax_id: String,
    pub email: String,
    pub phone: String,
    pub invoice_type: String,
    pub amount: f64,
}

/// 额度三行数字 + 我的申请列表
#[tauri::command]
pub async fn invoice_get_summary(app: AppHandle) -> Result<InvoiceSummary, String> {
    let data = call_api(&app, "GET", "/jy/api/v1/invoices/summary", None).await?;
    serde_json::from_value::<InvoiceSummary>(data).map_err(|e| format!("解析发票额度失败: {}", e))
}

/// 提交开票申请。金额上限由服务端复核，客户端预校验只为提前提示。
#[tauri::command]
pub async fn invoice_submit(
    app: AppHandle,
    company_name: String,
    tax_id: String,
    email: String,
    phone: String,
    invoice_type: String,
    amount: f64,
) -> Result<InvoiceSubmitResult, String> {
    let payload = InvoiceSubmitPayload {
        company_name,
        tax_id,
        email,
        phone,
        invoice_type,
        amount,
    };
    let body = serde_json::to_value(&payload).map_err(|e| format!("序列化开票申请失败: {}", e))?;
    let data = call_api(&app, "POST", "/jy/api/v1/invoices", Some(body)).await?;
    serde_json::from_value::<InvoiceSubmitResult>(data)
        .map_err(|e| format!("解析开票结果失败: {}", e))
}

/// 我的申请列表（不含额度数字）
#[tauri::command]
pub async fn invoice_list_mine(app: AppHandle) -> Result<Vec<InvoiceRequest>, String> {
    let data = call_api(&app, "GET", "/jy/api/v1/invoices/mine", None).await?;
    serde_json::from_value::<Vec<InvoiceRequest>>(data)
        .map_err(|e| format!("解析发票列表失败: {}", e))
}
