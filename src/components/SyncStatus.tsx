import { useEffect, useState, useCallback } from 'react';
import { syncGetStatus, syncImportSettings, syncExportSettings, type SyncStatus as SyncStatusType } from '@/commands/ai';
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';

// 后台自动轮询间隔
const POLL_INTERVAL = 30_000;

/** 等待同步完成，然后回灌 settings 到前端 stores */
export async function applySyncSettings() {
  // 轮询等待同步完成（最多等 30 秒）
  for (let i = 0; i < 60; i++) {
    try {
      const status = await syncGetStatus();
      if (status.state === 'synced') break;
    } catch {
      // 未登录或网络错误
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 从 Rust 侧读取同步下来的 settings
  try {
    const json = await syncImportSettings();
    if (!json || json === '{}') return;
    const merged = JSON.parse(json);
    if (merged.settings) {
      useSettingsStore.setState(merged.settings);
    }
    if (merged.theme) {
      useThemeStore.getState().setTheme(merged.theme);
    }
  } catch (err) {
    console.debug('[sync] apply settings:', err);
  }
}

/** 登录时导出本地设置到 Rust 侧，供同步系统使用 */
export function initSyncOnLogin() {
  try {
    const settings = useSettingsStore.getState();
    const theme = useThemeStore.getState().theme;
    const json = JSON.stringify({ settings, theme });
    syncExportSettings(json);
  } catch (err) {
    console.debug('[sync] export settings on login:', err);
  }
}

/** 关闭窗口时显示的"正在同步云端"遮罩 */
export function SyncClosingOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 99999,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.6)',
      backdropFilter: 'blur(4px)',
      color: '#fff',
      fontSize: 16,
      gap: 16,
    }}>
      <div style={{
        width: 36,
        height: 36,
        border: '3px solid rgba(255,255,255,0.3)',
        borderTopColor: '#fff',
        borderRadius: '50%',
        animation: 'sync-spin 0.8s linear infinite',
      }} />
      <span>正在同步云端，请稍候...</span>
      <style>{`@keyframes sync-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/** 轻量同步状态图标 */
export function SyncStatusIcon() {
  const [status, setStatus] = useState<SyncStatusType>({ state: 'idle', message: '', last_sync_time: null });

  const poll = useCallback(async () => {
    try {
      const s = await syncGetStatus();
      setStatus(s);
    } catch {
      // 未登录或网络错误，静默
    }
  }, []);

  useEffect(() => {
    poll();
    const timer = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [poll]);

  const color =
    status.state === 'synced' ? '#22c55e' :
    status.state === 'syncing' ? '#f59e0b' :
    status.state === 'error' ? '#ef4444' : '#6b7280';

  const text =
    status.state === 'syncing' ? '同步中...' :
    status.state === 'error' ? '同步失败' :
    status.state === 'synced' ? '已同步' : '';

  return (
    <span
      title={`同步: ${status.message || '就绪'}${status.last_sync_time ? ` (${new Date(status.last_sync_time * 1000).toLocaleTimeString()})` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: '#9ca3af',
        flexShrink: 0,
      }}
    >
      <span style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
      }} />
      {text}
    </span>
  );
}
