import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Announcement, FeedbackReply, FeedbackThread } from '../../commands/notifications';

export type NotificationTab = 'notifications' | 'feedback';

/**
 * 右下角提示的一条。广播和「反馈被回复」共用同一个弹窗栈，
 * 靠 `kind` 区分标题来源与点击后跳的页签。
 */
export interface ToastItem {
  /** `ann:<id>` / `rep:<id>` —— 跨类型唯一 */
  key: string;
  kind: 'announcement' | 'reply';
  /** 公告标题；回复类为空，渲染时用 i18n 文案顶上 */
  title: string;
  body: string;
  level: 'info' | 'warning' | 'important';
  timestamp?: string | null;
  announcementId?: number;
  feedbackId?: number;
}

interface NotificationState {
  announcements: Announcement[];
  /** 已读的公告 id（角标按未读算） */
  readIds: number[];
  /** 已经弹过右下角提示的公告 id，避免每次轮询重复弹 */
  toastedIds: number[];
  /** 首次成功同步前不弹提示：新用户不会一次性看到历史广播刷屏 */
  hasSynced: boolean;

  threads: FeedbackThread[];
  /** 已经看过的管理员回复 id（小红点按它算，只有真的打开「反馈」页签才清） */
  seenReplyIds: number[];
  /** 已经弹过右下角提示的回复 id：只防重复弹窗，不当作「已读」 */
  toastedReplyIds: number[];
  /** 反馈同样有「首次同步不弹」的闸门 */
  hasSyncedFeedback: boolean;

  panelOpen: boolean;
  activeTab: NotificationTab;
  lastSyncedAt: number | null;
  /** 右下角正在显示的提示（不持久化，重启即清空） */
  toasts: ToastItem[];

  /** 写入服务端返回的公告列表，返回其中「需要弹提示」的新公告 */
  applyAnnouncements: (list: Announcement[]) => Announcement[];
  /** 写入反馈列表，返回其中「还没看过的」管理员回复 */
  applyThreads: (threads: FeedbackThread[]) => FeedbackReply[];
  markRead: (id: number) => void;
  markAllRead: () => void;
  markSeenReplies: (ids: number[]) => void;
  markToasted: (ids: number[]) => void;
  markToastedReplies: (ids: number[]) => void;
  setPanelOpen: (open: boolean) => void;
  setActiveTab: (tab: NotificationTab) => void;
  pushToasts: (items: ToastItem[]) => void;
  dismissToast: (key: string) => void;
}

/** 右下角同时最多展示几条，超出的直接丢弃（正文留存在面板里，不会丢信息） */
export const MAX_VISIBLE_TOASTS = 3;

/** 已读/已弹记录只保留最近这么多条，避免 localStorage 无限增长 */
const MAX_TRACKED_IDS = 500;

const NOTIFICATION_PERSIST_VERSION = 3;

function appendIds(existing: number[], incoming: number[]): number[] {
  const merged = new Set(existing);
  incoming.forEach((id) => merged.add(id));
  return Array.from(merged).slice(-MAX_TRACKED_IDS);
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      announcements: [],
      readIds: [],
      toastedIds: [],
      hasSynced: false,

      threads: [],
      seenReplyIds: [],
      toastedReplyIds: [],
      hasSyncedFeedback: false,

      panelOpen: false,
      activeTab: 'notifications',
      lastSyncedAt: null,
      toasts: [],

      applyAnnouncements: (list) => {
        const state = get();
        const known = new Set(state.announcements.map((item) => item.id));
        const toasted = new Set(state.toastedIds);

        // 首次同步只记录、不弹窗，否则历史广播会一次性炸出来
        const fresh = state.hasSynced
          ? list.filter((item) => !known.has(item.id) && !toasted.has(item.id) && item.is_active !== false)
          : [];

        set({
          announcements: list,
          hasSynced: true,
          lastSyncedAt: Date.now(),
        });
        return fresh;
      },

      applyThreads: (threads) => {
        const state = get();
        const seen = new Set(state.seenReplyIds);
        const toasted = new Set(state.toastedReplyIds);
        // 只在「还没弹过」时返回：弹过但没读的回复仍算未读（小红点靠 seenReplyIds）
        const freshReplies = state.hasSyncedFeedback
          ? threads
              .flatMap((thread) => thread.replies ?? [])
              .filter((reply) => reply.is_admin !== false && !seen.has(reply.id) && !toasted.has(reply.id))
          : [];

        set({ threads, hasSyncedFeedback: true });
        return freshReplies;
      },

      markRead: (id) => {
        const { readIds } = get();
        if (readIds.includes(id)) return;
        set({ readIds: appendIds(readIds, [id]) });
      },

      markAllRead: () => {
        const { announcements, readIds, threads, seenReplyIds } = get();
        const nextRead = appendIds(readIds, announcements.map((item) => item.id));
        const replyIds = threads.flatMap((thread) => (thread.replies ?? []).map((reply) => reply.id));
        set({
          readIds: nextRead,
          seenReplyIds: appendIds(seenReplyIds, replyIds),
        });
      },

      markSeenReplies: (ids) => {
        if (ids.length === 0) return;
        set({ seenReplyIds: appendIds(get().seenReplyIds, ids) });
      },

      markToasted: (ids) => {
        if (ids.length === 0) return;
        set({ toastedIds: appendIds(get().toastedIds, ids) });
      },

      markToastedReplies: (ids) => {
        if (ids.length === 0) return;
        set({ toastedReplyIds: appendIds(get().toastedReplyIds, ids) });
      },

      setPanelOpen: (open) => set({ panelOpen: open }),
      setActiveTab: (tab) => set({ activeTab: tab }),

      pushToasts: (items) => {
        if (items.length === 0) return;
        const { toasts } = get();
        const existing = new Set(toasts.map((item) => item.key));
        const merged = [...toasts, ...items.filter((item) => !existing.has(item.key))];
        // 只留最新的几条：旧提示挤掉时照样能在面板里看到
        set({ toasts: merged.slice(-MAX_VISIBLE_TOASTS) });
      },

      dismissToast: (key) => {
        set({ toasts: get().toasts.filter((item) => item.key !== key) });
      },
    }),
    {
      name: 'notification-storage',
      version: NOTIFICATION_PERSIST_VERSION,
      partialize: (state) => ({
        announcements: state.announcements,
        readIds: state.readIds,
        toastedIds: state.toastedIds,
        hasSynced: state.hasSynced,
        seenReplyIds: state.seenReplyIds,
        toastedReplyIds: state.toastedReplyIds,
        hasSyncedFeedback: state.hasSyncedFeedback,
      }),
      // 老版本升级上来时补齐新字段，避免读到 undefined
      migrate: (persisted, version) => {
        const prev = (persisted ?? {}) as Partial<NotificationState>;
        if (version < 2) {
          return {
            ...prev,
            seenReplyIds: prev.seenReplyIds ?? [],
            toastedReplyIds: prev.toastedReplyIds ?? [],
            hasSyncedFeedback: prev.hasSyncedFeedback ?? false,
          } as NotificationState;
        }
        if (version < 3) {
          return {
            ...prev,
            toastedReplyIds: prev.toastedReplyIds ?? [],
          } as NotificationState;
        }
        return prev as NotificationState;
      },
    }
  )
);

/** 未读总数 = 未读公告 + 未读回复 */
export function selectUnreadCount(state: NotificationState): number {
  const read = new Set(state.readIds);
  const seen = new Set(state.seenReplyIds);
  let count = 0;
  for (const item of state.announcements) {
    if (!read.has(item.id)) count += 1;
  }
  for (const thread of state.threads) {
    for (const reply of thread.replies ?? []) {
      if (!seen.has(reply.id)) count += 1;
    }
  }
  return count;
}

/** 未读回复所在工单的 id 集合（面板里给对应工单打标记用） */
export function collectUnreadReplyThreadIds(
  threads: FeedbackThread[],
  seenReplyIds: number[],
): Set<number> {
  const seen = new Set(seenReplyIds);
  const result = new Set<number>();
  for (const thread of threads) {
    if ((thread.replies ?? []).some((reply) => !seen.has(reply.id))) {
      result.add(thread.id);
    }
  }
  return result;
}
