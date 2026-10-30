import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { UiModal } from '@/components/ui';
import { bananaGetConsumptionHistory } from '@/commands/ai';
import type { ConsumptionRecord } from '@/commands/ai';

interface ConsumptionHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 打开「申请发票」弹窗（由设置页统一承载，避免嵌套弹窗各管各的） */
  onOpenInvoice: () => void;
}

const PAGE_SIZE = 100;

export function ConsumptionHistoryDialog({ isOpen, onClose, onOpenInvoice }: ConsumptionHistoryDialogProps) {
  const { t } = useTranslation();

  function getActionLabel(type: string) {
    switch (type) {
      case 'image_generation': return t('settings.meConsumptionImageGen');
      case 'video_generation': return t('settings.meConsumptionVideoGen');
      case 'text_generation': return t('settings.meConsumptionTextGen');
      case 'refund': return t('settings.meConsumptionRefund');
      default: return type;
    }
  }
  const [records, setRecords] = useState<ConsumptionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [selectedMonth, setSelectedMonth] = useState<string>('all');

  /** 请求序号：切筛选条件时丢弃旧请求的返回，避免旧月份覆盖新月份的列表 */
  const requestSeq = useRef(0);

  const load = useCallback(async (pg: number, year: string, month: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await bananaGetConsumptionHistory(
        pg,
        PAGE_SIZE,
        year === 'all' ? null : Number(year),
        month === 'all' ? null : Number(month),
      );
      if (seq !== requestSeq.current) return;
      setRecords(prev => (pg === 1 ? res.records : [...prev, ...res.records]));
      setTotal(res.total);
      setPage(pg);
      setLoadError(false);
    } catch {
      if (seq !== requestSeq.current) return;
      // 0 分流水已由服务端过滤，这里只处理真实失败
      setLoadError(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // 打开或改筛选条件：都从第 1 页重新拉（筛选在服务端做，不能只过滤已加载数据）
  useEffect(() => {
    if (!isOpen) return;
    setRecords([]);
    setTotal(0);
    setPage(1);
    setLoadError(false);
    void load(1, selectedYear, selectedMonth);
  }, [isOpen, selectedYear, selectedMonth, load]);

  // 年份列表：从当前年往前推 3 年
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 4 }, (_, i) => (currentYear - i).toString());
  const months = Array.from({ length: 12 }, (_, i) => (i + 1).toString());

  const hasFilter = selectedYear !== 'all' || selectedMonth !== 'all';
  const hasMore = records.length < total;

  return (
    <UiModal
      isOpen={isOpen}
      title={t('consumption.title', '消费清单')}
      onClose={onClose}
      widthClassName="w-[440px]"
    >
      <div className="flex flex-col gap-3">
        {/* 筛选栏 */}
        <div className="flex gap-3">
          <select
            value={selectedYear}
            onChange={e => { setSelectedYear(e.target.value); }}
            className="flex-1 rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark outline-none"
          >
            <option value="all">{t('consumption.allYears', '全部年份')}</option>
            {years.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <select
            value={selectedMonth}
            onChange={e => { setSelectedMonth(e.target.value); }}
            className="flex-1 rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark outline-none"
          >
            <option value="all">{t('consumption.allMonths', '全部月份')}</option>
            {months.map(m => (
              <option key={m} value={m}>{t('consumption.monthOption', { month: m, defaultValue: '{{month}}月' })}</option>
            ))}
          </select>
        </div>

        {/* 记录列表 */}
        <div className="max-h-80 overflow-y-auto ui-scrollbar pr-2">
          {loading && records.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">{t('common.loading', '加载中...')}</p>
          ) : loadError && records.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">{t('consumption.loadFailed', '加载失败，请稍后重试')}</p>
          ) : records.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">
              {hasFilter
                ? t('consumption.emptyRange', '该时间段暂无消费记录')
                : t('settings.meConsumptionEmpty', '暂无消费记录')}
            </p>
          ) : (
            <div className="space-y-0.5">
              {records.map(r => (
                <div key={r.id} className="flex items-center justify-between py-2 border-b border-border-dark/30 last:border-0 pr-1">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-xs text-text-muted">
                      {r.created_at ? `${r.created_at.slice(0, 10).replace(/-/g, '/')} ${r.created_at.slice(11, 16)}` : ''}
                    </span>
                    <span className="text-xs text-text-dark">
                      {getActionLabel(r.action_type)}
                    </span>
                  </div>
                  {r.action_type === 'refund' ? (
                    <span className="text-sm font-medium text-green-400 shrink-0 ml-3">
                      +{r.credits_consumed}
                    </span>
                  ) : (
                    <span className="text-sm font-medium text-red-400 shrink-0 ml-3">
                      -{r.credits_consumed}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 加载更多 */}
        {hasMore && (
          <button
            type="button"
            onClick={() => load(page + 1, selectedYear, selectedMonth)}
            disabled={loading}
            className="w-full rounded border border-border-dark bg-surface-dark py-2 text-xs text-text-muted hover:bg-bg-dark disabled:opacity-50"
          >
            {loading ? '...' : `${t('settings.meConsumptionLoadMore', '加载更多')} (${records.length}/${total})`}
          </button>
        )}

        {/* 底部操作 */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onOpenInvoice}
            className="flex-1 rounded border border-accent/45 bg-accent/15 py-2 text-sm text-text-dark hover:bg-accent/25"
          >
            {t('invoice.entry', '申请发票')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded border border-border-dark bg-surface-dark py-2 text-sm text-text-dark hover:bg-bg-dark"
          >
            {t('consumption.close', '关闭')}
          </button>
        </div>
      </div>
    </UiModal>
  );
}
