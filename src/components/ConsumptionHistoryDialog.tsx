import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { UiModal } from '@/components/ui';
import { bananaGetConsumptionHistory } from '@/commands/ai';
import type { ConsumptionRecord } from '@/commands/ai';

interface ConsumptionHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const PAGE_SIZE = 100;

export function ConsumptionHistoryDialog({ isOpen, onClose }: ConsumptionHistoryDialogProps) {
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
  const [allRecords, setAllRecords] = useState<ConsumptionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [selectedMonth, setSelectedMonth] = useState<string>('all');

  const load = useCallback(async (pg: number) => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await bananaGetConsumptionHistory(pg, PAGE_SIZE);
      if (pg === 1) {
        setAllRecords(res.records);
      } else {
        setAllRecords(prev => [...prev, ...res.records]);
      }
      setTotal(res.total);
      setPage(pg);
    } catch {
      // 静默降级
    } finally {
      setLoading(false);
    }
  }, [loading]);

  useEffect(() => {
    if (isOpen) {
      setAllRecords([]);
      setTotal(0);
      setPage(1);
      load(1);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // 客户端按年/月筛选
  const filteredRecords = allRecords.filter(r => {
    if (!r.created_at) return true;
    const d = new Date(r.created_at);
    if (selectedYear !== 'all' && d.getFullYear().toString() !== selectedYear) return false;
    if (selectedMonth !== 'all' && (d.getMonth() + 1).toString() !== selectedMonth) return false;
    return true;
  });

  // 年份列表：从当前年往前推 3 年
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 4 }, (_, i) => (currentYear - i).toString());
  const months = Array.from({ length: 12 }, (_, i) => (i + 1).toString());

  const hasMore = allRecords.length < total;

  return (
    <UiModal
      isOpen={isOpen}
      title={t('consumption.title', '消费清单')}
      onClose={onClose}
      widthClassName="w-[420px]"
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
              <option key={m} value={m}>{m}月</option>
            ))}
          </select>
        </div>

        {/* 记录列表 */}
        <div className="max-h-80 overflow-y-auto ui-scrollbar pr-2">
          {filteredRecords.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">
              {t('settings.meConsumptionEmpty', '暂无消费记录')}
            </p>
          ) : (
            <div className="space-y-0.5">
              {filteredRecords.map(r => (
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
            onClick={() => load(page + 1)}
            disabled={loading}
            className="w-full rounded border border-border-dark bg-surface-dark py-2 text-xs text-text-muted hover:bg-bg-dark disabled:opacity-50"
          >
            {loading ? '...' : `${t('settings.meConsumptionLoadMore', '加载更多')} (${allRecords.length}/${total})`}
          </button>
        )}

        {/* 关闭 */}
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
