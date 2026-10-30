import { invoke, isTauri } from '@tauri-apps/api/core';

export interface Announcement {
  id: number;
  title: string;
  body: string;
  level?: 'info' | 'warning' | 'important' | string | null;
  is_active?: boolean | null;
  published_at?: string | null;
  created_at?: string | null;
}

export interface FeedbackReply {
  id: number;
  body: string;
  is_admin?: boolean | null;
  admin_name?: string | null;
  created_at?: string | null;
}

export interface FeedbackThread {
  id: number;
  content: string;
  category?: string | null;
  contact?: string | null;
  status?: 'pending' | 'answered' | 'closed' | string | null;
  created_at?: string | null;
  updated_at?: string | null;
  replies?: FeedbackReply[];
}

/** 拉广播通知。公开接口，未登录同样可用；失败由调用方静默处理。 */
export async function fetchAnnouncements(): Promise<Announcement[]> {
  if (!isTauri()) {
    return [];
  }
  return await invoke<Announcement[]>('notification_fetch_announcements');
}

export async function submitFeedback(params: {
  category: string;
  content: string;
  contact?: string;
}): Promise<FeedbackThread> {
  return await invoke<FeedbackThread>('notification_submit_feedback', {
    category: params.category,
    content: params.content,
    contact: params.contact ?? null,
  });
}

export async function listMyFeedback(): Promise<FeedbackThread[]> {
  if (!isTauri()) {
    return [];
  }
  return await invoke<FeedbackThread[]>('notification_list_my_feedback');
}
