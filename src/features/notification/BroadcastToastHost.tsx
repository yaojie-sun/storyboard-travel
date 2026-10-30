import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing, MessageSquare, X } from 'lucide-react';
import { useNotificationStore, type ToastItem } from './notificationStore';
import { NotificationPanel } from './NotificationPanel';
import { formatNotificationTime } from './format';

/** 右下角提示的停留时长：够看清标题和两行正文，又不至于挡住画布。 */
const TOAST_AUTO_DISMISS_MS = 6000;

const LEVEL_ACCENT: Record<string, string> = {
  info: 'border-accent/40',
  warning: 'border-amber-400/40',
  important: 'border-red-500/50',
};

const LEVEL_ICON_COLOR: Record<string, string> = {
  info: 'text-accent',
  warning: 'text-amber-400',
  important: 'text-red-400',
};

function NotificationToast({ item }: { item: ToastItem }) {
  const { t, i18n } = useTranslation();
  const dismissToast = useNotificationStore((state) => state.dismissToast);
  const setPanelOpen = useNotificationStore((state) => state.setPanelOpen);
  const setActiveTab = useNotificationStore((state) => state.setActiveTab);
  const markRead = useNotificationStore((state) => state.markRead);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(item.key), TOAST_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [item.key, dismissToast]);

  const isReply = item.kind === 'reply';
  const title = isReply ? t('notification.toast.replyTitle') : item.title;
  const accent = LEVEL_ACCENT[item.level] ?? LEVEL_ACCENT.info;

  return (
    <div
      className={`w-[300px] overflow-hidden rounded-xl border bg-surface-dark shadow-2xl transition-[opacity,transform] duration-200 ${accent} ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        {isReply ? (
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        ) : (
          <BellRing className={`mt-0.5 h-4 w-4 shrink-0 ${LEVEL_ICON_COLOR[item.level] ?? LEVEL_ICON_COLOR.info}`} />
        )}
        <button
          type="button"
          onClick={() => {
            if (item.announcementId != null) markRead(item.announcementId);
            setActiveTab(isReply ? 'feedback' : 'notifications');
            setPanelOpen(true);
            dismissToast(item.key);
          }}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-xs font-semibold text-text-dark">{title}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-muted">{item.body}</p>
          <p className="mt-1 flex items-center gap-2 text-[10px] text-text-muted/70">
            <span>{formatNotificationTime(item.timestamp, i18n.language)}</span>
            <span className="text-accent">{t('notification.toast.open')}</span>
          </p>
        </button>
        <button
          type="button"
          onClick={() => dismissToast(item.key)}
          className="rounded p-0.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
          title={t('notification.toast.dismiss')}
          aria-label={t('notification.toast.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * 右下角提示栈 + 全局唯一一份消息面板。
 *
 * 挂在 `App` 根节点的每个分支里，保证「未登录也能收到广播」。
 * 提示只是**提醒**，正文在面板里能反复看，所以自动收走不会丢信息。
 */
export function BroadcastToastHost() {
  const toasts = useNotificationStore((state) => state.toasts);

  return (
    <>
      <NotificationPanel />
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-6 right-4 z-[120] flex flex-col items-end gap-2">
          {toasts.map((item) => (
            <div key={item.key} className="pointer-events-auto">
              <NotificationToast item={item} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
