import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface NetworkStatusBannerProps {
  /** 服务器暂时不可达（**不等于**登录失效）。 */
  degraded: boolean;
}

/**
 * 服务器暂时不可达时的顶部提示条。
 *
 * 设计口径：网络抖动**不阻断任何操作**，只做一次轻提示；
 * 登录态由 `App.tsx` 保持，后台自行重连，连上后本提示条自动消失。
 */
export function NetworkStatusBanner({ degraded }: NetworkStatusBannerProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  // 恢复联网后重置「已关闭」，下次再抖动时还能提示
  useEffect(() => {
    if (!degraded) {
      setDismissed(false);
    }
  }, [degraded]);

  if (!degraded || dismissed) {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-[150] flex items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-700 backdrop-blur-sm dark:bg-amber-400/10 dark:text-amber-200">
      <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500 dark:bg-amber-400" />
      <span>{t('common.networkDegraded')}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-1 shrink-0 rounded px-1.5 py-0.5 opacity-80 transition-opacity hover:bg-amber-500/20 hover:opacity-100"
      >
        {t('common.dismiss')}
      </button>
    </div>
  );
}

interface ReconnectingPanelProps {
  /** 已经自动重试的次数（用于在连续失败后展示明细）。 */
  attempt?: number;
  /** 最近一次失败原因（截断展示，仅供排查）。 */
  error?: string;
  /** 立即重试（重置退避并重新发起一轮连接）。 */
  onRetry?: () => void;
  /** 放弃自动重连，回到登录框（弱网永远连不上时的出口）。 */
  onRelogin?: () => void;
}

/**
 * 冷启动 / 网络恢复过程中「正在连接服务器…」的占位面板。
 *
 * 🔴 出现它是**故意不要登录框**的：本地令牌还在，只是连不上服务器，
 * 后台会指数退避自动重连，**不该让用户重新输密码**。
 * 连续失败若干次后必须给出「重试 / 重新登录」出口，避免永久卡死。
 */
export function ReconnectingPanel({
  attempt = 0,
  error,
  onRetry,
  onRelogin,
}: ReconnectingPanelProps) {
  const { t } = useTranslation();
  // 前几秒只转圈，避免把「刚抖一下就恢复」的正常情况渲染成报错；
  // 连续失败后必须给出重试/重新登录两条出路，不能让用户永远等。
  const showDetail = attempt >= 3;

  return (
    <div className="relative z-10 flex w-[320px] flex-col items-center gap-3 text-text-muted">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-text-muted/30 border-t-text-muted" />
      <span className="text-sm">{t('common.reconnecting')}</span>
      {showDetail && (
        <>
          <span className="text-center text-xs">
            {t('common.reconnectingAttempt', { count: attempt })}
          </span>
          {error && (
            <span className="max-w-full break-words text-center text-[11px] opacity-70" title={error}>
              {t('common.reconnectError', { message: error })}
            </span>
          )}
          <div className="mt-1 flex items-center gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md border border-text-muted/30 px-3 py-1.5 text-xs text-text transition-colors hover:bg-text-muted/10"
              >
                {t('common.retry')}
              </button>
            )}
            {onRelogin && (
              <button
                type="button"
                onClick={onRelogin}
                className="rounded-md px-3 py-1.5 text-xs opacity-70 transition-opacity hover:opacity-100"
              >
                {t('common.relogin')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
