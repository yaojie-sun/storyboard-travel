import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';
import { useNotificationStore } from './notificationStore';
import { formatNotificationTime, normalizeAnnouncementLevel } from './format';

const LEVEL_DOT: Record<string, string> = {
  info: 'bg-accent',
  warning: 'bg-amber-400',
  important: 'bg-red-500',
};

const LEVEL_CHIP: Record<string, string> = {
  info: 'hidden',
  warning: 'border-amber-400/40 bg-amber-400/15 text-amber-300',
  important: 'border-red-500/40 bg-red-500/15 text-red-300',
};

export function AnnouncementList() {
  const { t, i18n } = useTranslation();
  const announcements = useNotificationStore((state) => state.announcements);
  const readIds = useNotificationStore((state) => state.readIds);
  const markRead = useNotificationStore((state) => state.markRead);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (announcements.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-muted">
        <Inbox className="h-6 w-6 opacity-60" />
        <p className="text-xs">{t('notification.empty.announcements')}</p>
      </div>
    );
  }

  const readSet = new Set(readIds);

  return (
    <div className="space-y-1">
      {announcements.map((item) => {
        const level = normalizeAnnouncementLevel(item.level);
        const isUnread = !readSet.has(item.id);
        const isExpanded = expandedId === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              // 展开即已读：面板里看到的通知不需要额外的「确认」动作
              setExpandedId(isExpanded ? null : item.id);
              markRead(item.id);
            }}
            className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg-dark/60 ${
              isUnread ? 'bg-bg-dark/30' : ''
            }`}
          >
            <div className="flex items-start gap-2">
              <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${isUnread ? LEVEL_DOT[level] : 'bg-transparent'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`min-w-0 flex-1 truncate text-xs ${isUnread ? 'font-semibold text-text-dark' : 'text-text-dark/75'}`}>
                    {item.title}
                  </span>
                  {level !== 'info' && (
                    <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${LEVEL_CHIP[level]}`}>
                      {t(`notification.level.${level}`)}
                    </span>
                  )}
                </div>
                <p className={`mt-1 text-[11px] leading-relaxed text-text-muted ${isExpanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'}`}>
                  {item.body}
                </p>
                <p className="mt-1 text-[10px] text-text-muted/70">
                  {formatNotificationTime(item.published_at ?? item.created_at, i18n.language)}
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
