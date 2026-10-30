import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { useNotificationStore, selectUnreadCount } from './notificationStore';
import { refreshAnnouncements } from './useNotificationPolling';

interface NotificationBellProps {
  /**
   * `titlebar`：标题栏右侧那排小工具里的一个（与语言/主题按钮同款）；
   * `floating`：未登录界面没有标题栏，用浮动按钮兜底。
   */
  variant?: 'titlebar' | 'floating';
  className?: string;
}

export function NotificationBell({ variant = 'titlebar', className = '' }: NotificationBellProps) {
  const { t } = useTranslation();
  const unreadCount = useNotificationStore(selectUnreadCount);
  const panelOpen = useNotificationStore((state) => state.panelOpen);
  const setPanelOpen = useNotificationStore((state) => state.setPanelOpen);

  const handleClick = () => {
    const next = !panelOpen;
    setPanelOpen(next);
    if (next) {
      void refreshAnnouncements();
    }
  };

  const badge = unreadCount > 0 && (
    <span className="pointer-events-none absolute right-1.5 top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white">
      {unreadCount > 99 ? '99+' : unreadCount}
    </span>
  );

  if (variant === 'floating') {
    return (
      <button
        type="button"
        data-notification-bell="true"
        onClick={handleClick}
        className={`fixed right-3 top-2 z-[120] flex h-8 w-8 items-center justify-center rounded-full border border-border-dark bg-surface-dark/90 shadow-lg backdrop-blur transition-colors hover:bg-bg-dark ${className}`}
        title={t('notification.bell.title')}
        aria-label={t('notification.bell.title')}
      >
        <Bell className="h-4 w-4 text-text-muted" />
        {badge}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-notification-bell="true"
      onClick={handleClick}
      className={`relative h-full px-3 transition-colors hover:bg-bg-dark ${className}`}
      title={t('notification.bell.title')}
      aria-label={t('notification.bell.title')}
    >
      <Bell className={`h-4 w-4 ${unreadCount > 0 ? 'text-accent' : 'text-text-muted'}`} />
      {badge}
    </button>
  );
}
