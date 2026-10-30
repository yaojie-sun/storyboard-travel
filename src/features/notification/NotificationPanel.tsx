import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useDialogTransition } from '../../components/ui/useDialogTransition';
import { UI_DIALOG_TRANSITION_MS } from '../../components/ui/motion';
import { useNotificationStore, selectUnreadCount } from './notificationStore';
import { AnnouncementList } from './AnnouncementList';
import { FeedbackTab } from './FeedbackTab';
import { refreshAnnouncements, refreshFeedbackThreads } from './useNotificationPolling';

/**
 * 消息面板。**全局只渲染一份**（挂在 `BroadcastToastHost` 里），
 * 标题栏铃铛和未登录浮动铃铛都只是开关它，避免两份实例各拉一次接口。
 */
export function NotificationPanel() {
  const { t } = useTranslation();
  const panelOpen = useNotificationStore((state) => state.panelOpen);
  const setPanelOpen = useNotificationStore((state) => state.setPanelOpen);
  const activeTab = useNotificationStore((state) => state.activeTab);
  const setActiveTab = useNotificationStore((state) => state.setActiveTab);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const threads = useNotificationStore((state) => state.threads);
  const markSeenReplies = useNotificationStore((state) => state.markSeenReplies);
  const unreadCount = useNotificationStore(selectUnreadCount);

  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 本次打开期间有没有看过「反馈」页签 */
  const viewedFeedbackRef = useRef(false);
  const { shouldRender, isVisible } = useDialogTransition(panelOpen, UI_DIALOG_TRANSITION_MS);

  const close = () => setPanelOpen(false);

  // 打开时补一次最新数据：用户点开面板就是想知道「有没有新的」
  useEffect(() => {
    if (!panelOpen) return;
    void refreshAnnouncements();
    void refreshFeedbackThreads();
  }, [panelOpen]);

  // 看过「反馈」页签后关面板才算已读：
  // 打开时保留未读标记（工单卡上有高亮），关掉才清红点，用户不至于「还没看清就没了」
  useEffect(() => {
    if (panelOpen) {
      if (activeTab === 'feedback') viewedFeedbackRef.current = true;
      return;
    }
    if (!viewedFeedbackRef.current) return;
    viewedFeedbackRef.current = false;
    const ids = threads.flatMap((thread) => (thread.replies ?? []).map((reply) => reply.id));
    markSeenReplies(ids);
  }, [panelOpen, activeTab, threads, markSeenReplies]);

  // 点外部 / Esc 关闭
  useEffect(() => {
    if (!panelOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-notification-bell="true"]')) return;
      setPanelOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [panelOpen, setPanelOpen]);

  if (!shouldRender) return null;

  const tabButtonClass = (active: boolean) =>
    `relative flex-1 pb-2 text-xs transition-colors ${
      active ? 'text-text-dark' : 'text-text-muted hover:text-text-dark'
    }`;

  return (
    <div
      ref={panelRef}
      className={`fixed right-2 top-11 z-[130] flex max-h-[min(600px,calc(100vh-3.5rem))] w-[380px] flex-col overflow-hidden rounded-xl border border-border-dark bg-surface-dark shadow-2xl transition-opacity duration-200 ${
        isVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-4 pt-3">
        <div className="flex flex-1 items-center gap-4">
          <button type="button" onClick={() => setActiveTab('notifications')} className={tabButtonClass(activeTab === 'notifications')}>
            {t('notification.tab.notifications')}
            {activeTab === 'notifications' && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
          <button type="button" onClick={() => setActiveTab('feedback')} className={tabButtonClass(activeTab === 'feedback')}>
            {t('notification.tab.feedback')}
            {activeTab === 'feedback' && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        </div>
        <div className="flex items-center gap-1 pb-1.5">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="rounded px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            >
              {t('notification.action.markAllRead')}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            title={t('notification.action.close')}
            aria-label={t('notification.action.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {activeTab === 'notifications' ? <AnnouncementList /> : <FeedbackTab />}
      </div>
    </div>
  );
}
