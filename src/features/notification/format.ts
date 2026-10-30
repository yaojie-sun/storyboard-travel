/**
 * 服务端返回的是北京时间字符串（naive，无时区后缀），
 * 与 `credits.py` 的口径一致。浏览器按本地时区解析无后缀时间串，
 * 国内用户的本地时区就是 +8，直接用即可；带 Z/偏移量的串也能正常解析。
 */
export function formatNotificationTime(
  value: string | null | undefined,
  locale: string,
): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** 通知等级归一化：服务端只会有 info/warning/important，异常值一律当 info */
export function normalizeAnnouncementLevel(level: string | null | undefined): 'info' | 'warning' | 'important' {
  return level === 'warning' || level === 'important' ? level : 'info';
}
