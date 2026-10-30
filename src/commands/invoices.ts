import { invoke, isTauri } from '@tauri-apps/api/core';

export type InvoiceStatus = 'pending' | 'issued' | 'rejected';
export type InvoiceType = 'normal' | 'special';

export interface InvoiceRequest {
  id: number;
  user_id?: number | null;
  company_name: string;
  tax_id: string;
  email: string;
  phone?: string | null;
  invoice_type?: InvoiceType | string | null;
  amount: number;
  status: InvoiceStatus | string;
  admin_note?: string | null;
  created_at?: string | null;
  handled_at?: string | null;
}

/** 服务端算好的额度三行数字 + 我的申请列表 */
export interface InvoiceSummary {
  total_paid: number;
  used: number;
  available: number;
  requests: InvoiceRequest[];
}

export interface InvoiceSubmitResult {
  request: InvoiceRequest;
  total_paid: number;
  used: number;
  available: number;
}

/**
 * 额度 + 我的申请。**额度一律来自服务端**：客户端只展示，不自己算一套。
 * 未登录/网络失败会抛错，由弹窗统一提示。
 */
export async function getInvoiceSummary(): Promise<InvoiceSummary> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<InvoiceSummary>('invoice_get_summary');
}

export async function submitInvoice(params: {
  companyName: string;
  taxId: string;
  email: string;
  phone: string;
  invoiceType: InvoiceType;
  amount: number;
}): Promise<InvoiceSubmitResult> {
  return await invoke<InvoiceSubmitResult>('invoice_submit', {
    companyName: params.companyName,
    taxId: params.taxId,
    email: params.email,
    phone: params.phone,
    invoiceType: params.invoiceType,
    amount: params.amount,
  });
}

export async function listMyInvoices(): Promise<InvoiceRequest[]> {
  if (!isTauri()) {
    return [];
  }
  return await invoke<InvoiceRequest[]>('invoice_list_mine');
}
