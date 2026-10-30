import { useEffect } from 'react';
import { fetchAnnouncements, listMyFeedback } from '../../commands/notifications';
import { useNotificationStore, type ToastItem } from './notificationStore';
import { normalizeAnnouncementLevel } from './format';

/** 轮询间隔。广播不是实时聊天，10 分钟足够；太密只会白耗请求。 */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 拉一次通知并落到 store；新通知进右下角提示队列。
 *
 * **失败一律静默**：通知是旁路功能，断网/服务端抖动都不该打扰用户，
 * 更不能像核心请求那样 emit `login-required` 把未登录用户反复拉回登录框。
 * 面板与角标继续显示上一次成功拉到的内容。
 */
export async function refreshAnnouncements(): Promise<void> {
  try {
    const list = await fetchAnnouncements();
    const { applyAnnouncements, markToasted, pushToasts } = useNotificationStore.getState();
    const fresh = applyAnnouncements(list);
    if (fresh.length > 0) {
      const toasts: ToastItem[] = fresh.map((item) => ({
        key: `ann:${item.id}`,
        kind: 'announcement',
        title: item.title,
        body: item.body,
        level: normalizeAnnouncementLevel(item.level),
        timestamp: item.published_at ?? item.created_at,
        announcementId: item.id,
      }));
      pushToasts(toasts);
      markToasted(fresh.map((item) => item.id));
    }
  } catch {
    // 静默：见上方注释
  }
}

/**
 * 拉「我的反馈 + 管理员答复」。
 * 有新回复时同样弹右下角提示 —— 用户在等回答，这条比广播更需要主动提醒。
 */
export async function refreshFeedbackThreads(): Promise<void> {
  try {
    const threads = await listMyFeedback();
    const { applyThreads, markToastedReplies, pushToasts } = useNotificationStore.getState();
    const freshReplies = applyThreads(threads);
    if (freshReplies.length > 0) {
      const toasts: ToastItem[] = freshReplies.map((reply) => ({
        key: `rep:${reply.id}`,
        kind: 'reply',
        title: '',
        body: reply.body,
        level: 'info',
        timestamp: reply.created_at,
      }));
      pushToasts(toasts);
      // 只记「弹过了」，**不记已读**：用户没点开时铃铛要继续挂小红点
      markToastedReplies(freshReplies.map((reply) => reply.id));
    }
  } catch {
    // 静默
  }
}

/**
 * 全局轮询：启动拉一次 + 每 10 分钟一次 + 窗口重新获得焦点时补一次。
 *
 * 用 `visibilitychange` 而不是每秒计时：用户切回来时立刻能看到新广播/新回复，
 * 后台挂着的时候不发请求。
 */
export function useNotificationPolling(): void {
  useEffect(() => {
    let disposed = false;

    const tick = () => {
      if (disposed || document.visibilityState === 'hidden') return;
      void refreshAnnouncements();
      void refreshFeedbackThreads();
    };

    tick();
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
}
