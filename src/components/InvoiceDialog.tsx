import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiModal } from '@/components/ui';
import { getInvoiceSummary, submitInvoice } from '@/commands/invoices';
import type { InvoiceRequest, InvoiceSummary, InvoiceType } from '@/commands/invoices';

interface InvoiceDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatMoney(value: number): string {
  return `¥${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

/**
 * 申请发票。
 *
 * 额度口径：累计充值（全部历史实付）− 已申请/已开票 = 可开票余额，
 * **全部由服务端计算并复核**；这里只做展示与提前提示，不自己算一套。
 * 提交即扣额度，驳回自动退回。
 */
export function InvoiceDialog({ isOpen, onClose }: InvoiceDialogProps) {
  const { t } = useTranslation();

  const [summary, setSummary] = useState<InvoiceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const [companyName, setCompanyName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('normal');
  const [amount, setAmount] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getInvoiceSummary();
      setSummary(data);
      setAmount(data.available > 0 ? data.available.toFixed(2) : '');
    } catch (err) {
      setSummary(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setSubmitted(false);
    void load();
  }, [isOpen, load]);

  const available = summary?.available ?? 0;
  const amountValue = Number(amount);
  const amountValid = Number.isFinite(amountValue) && amountValue > 0 && amountValue <= available + 1e-6;

  const handleSubmit = async () => {
    if (submitting || !summary) return;
    setSubmitted(false);
    if (!companyName.trim()) { setError(t('invoice.error.company', '请填写公司名称')); return; }
    if (taxId.trim().length < 8) { setError(t('invoice.error.taxId', '请填写正确的纳税人识别号')); return; }
    if (!EMAIL_RE.test(email.trim())) { setError(t('invoice.error.email', '请填写正确的邮箱地址')); return; }
    if (phone.trim().length < 6) { setError(t('invoice.error.phone', '请填写正确的联系电话')); return; }
    if (!amountValid) {
      setError(t('invoice.error.amountRange', '开票金额需大于 0 且不超过可开票余额'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await submitInvoice({
        companyName: companyName.trim(),
        taxId: taxId.trim().toUpperCase(),
        email: email.trim(),
        phone: phone.trim(),
        invoiceType,
        amount: Math.round(amountValue * 100) / 100,
      });
      setSummary(prev => ({
        total_paid: result.total_paid,
        used: result.used,
        available: result.available,
        requests: [result.request, ...(prev?.requests ?? [])],
      }));
      setSubmitted(true);
      setAmount(result.available > 0 ? result.available.toFixed(2) : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 额度可能已被别处占用，失败后重新取一次真实数字
      void load();
    } finally {
      setSubmitting(false);
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case 'issued': return t('invoice.status.issued', '已开票');
      case 'rejected': return t('invoice.status.rejected', '已驳回');
      default: return t('invoice.status.pending', '待开票');
    }
  };

  const statusClass = (status: string) =>
    status === 'issued'
      ? 'text-green-400'
      : status === 'rejected'
        ? 'text-red-400'
        : 'text-text-muted';

  const requests: InvoiceRequest[] = summary?.requests ?? [];
  const inputClass =
    'w-full rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark outline-none';
  const labelClass = 'text-xs text-text-muted';

  return (
    <UiModal
      isOpen={isOpen}
      title={t('invoice.title', '申请发票')}
      onClose={onClose}
      widthClassName="w-[460px]"
    >
      <div className="flex flex-col gap-3">
        {/* 额度三行数字 */}
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-border-dark bg-surface-dark px-3 py-2.5 text-center">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-text-muted">{t('invoice.totalPaid', '累计充值')}</span>
            <span className="text-sm font-medium text-text-dark">{formatMoney(summary?.total_paid ?? 0)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-text-muted">{t('invoice.used', '已申请开票')}</span>
            <span className="text-sm font-medium text-text-dark">{formatMoney(summary?.used ?? 0)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-text-muted">{t('invoice.available', '可开票余额')}</span>
            <span className="text-sm font-medium text-accent">{formatMoney(available)}</span>
          </div>
        </div>

        <p className="text-[11px] leading-5 text-text-muted">
          {t('invoice.hint', '电子发票开具后发送到下方填写的邮箱，一般 1–3 个工作日。提交后额度立即扣减，若申请被驳回会自动退回。')}
        </p>

        {loading ? (
          <p className="py-6 text-center text-xs text-text-muted">{t('common.loading', '加载中...')}</p>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('invoice.field.company', '公司名称')}</span>
              <input value={companyName} onChange={e => setCompanyName(e.target.value)} className={inputClass} />
            </label>

            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('invoice.field.taxId', '纳税人识别号')}</span>
              <input value={taxId} onChange={e => setTaxId(e.target.value)} className={inputClass} />
            </label>

            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className={labelClass}>{t('invoice.field.phone', '联系电话')}</span>
                <input value={phone} onChange={e => setPhone(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className={labelClass}>{t('invoice.field.email', '邮箱')}</span>
                <input value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
              </label>
            </div>

            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className={labelClass}>{t('invoice.field.type', '发票类型')}</span>
                <select
                  value={invoiceType}
                  onChange={e => setInvoiceType(e.target.value as InvoiceType)}
                  className={inputClass}
                >
                  <option value="normal">{t('invoice.type.normal', '增值税普通发票')}</option>
                  <option value="special">{t('invoice.type.special', '增值税专用发票')}</option>
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className={labelClass}>{t('invoice.field.amount', '本次开票金额')}</span>
                <input
                  value={amount}
                  onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                  inputMode="decimal"
                  placeholder="0.00"
                  className={inputClass}
                />
              </label>
            </div>

            {available <= 0 && (
              <p className="text-xs text-text-muted">{t('invoice.noQuota', '暂无可开票额度')}</p>
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}
            {submitted && !error && (
              <p className="text-xs text-green-400">
                {t('invoice.submitSuccess', '申请已提交，我们会尽快开具并发送到您的邮箱')}
              </p>
            )}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || loading || available <= 0}
              className="w-full rounded border border-accent/45 bg-accent/20 py-2 text-sm text-text-dark hover:bg-accent/30 disabled:opacity-50"
            >
              {submitting ? t('invoice.submitting', '提交中...') : t('invoice.submit', '提交申请')}
            </button>

            {/* 我的申请 */}
            {requests.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-text-muted">{t('invoice.myRequests', '我的申请')}</span>
                <div className="max-h-36 space-y-0.5 overflow-y-auto ui-scrollbar pr-1">
                  {requests.map(item => (
                    <div key={item.id} className="flex items-start justify-between gap-3 border-b border-border-dark/30 py-1.5 last:border-0">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-xs text-text-dark">
                          {formatMoney(item.amount)} · {item.invoice_type === 'special'
                            ? t('invoice.type.special', '增值税专用发票')
                            : t('invoice.type.normal', '增值税普通发票')}
                        </span>
                        <span className="text-[11px] text-text-muted">
                          {item.created_at ? item.created_at.slice(0, 10).replace(/-/g, '/') : ''}
                          {item.admin_note ? ` · ${item.admin_note}` : ''}
                        </span>
                      </div>
                      <span className={`shrink-0 text-xs ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded border border-border-dark bg-surface-dark py-2 text-sm text-text-dark hover:bg-bg-dark"
        >
          {t('consumption.close', '关闭')}
        </button>
      </div>
    </UiModal>
  );
}
