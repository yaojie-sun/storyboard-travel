import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { Minus, X, Maximize2, Settings, ArrowLeft, CloudUpload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Languages } from 'lucide-react';
import { useThemeStore } from '@/stores/themeStore';
import { useProjectStore } from '@/stores/projectStore';
import { useEpisodeStore } from '@/stores/episodeStore';
import { syncPush } from '@/commands/ai';

import closeNormalIcon from '@/assets/macos-traffic-lights/1-close-1-normal.svg';
import closeHoverIcon from '@/assets/macos-traffic-lights/2-close-2-hover.svg';
import minimizeNormalIcon from '@/assets/macos-traffic-lights/2-minimize-1-normal.svg';
import minimizeHoverIcon from '@/assets/macos-traffic-lights/2-minimize-2-hover.svg';
import maximizeNormalIcon from '@/assets/macos-traffic-lights/3-maximize-1-normal.svg';
import maximizeHoverIcon from '@/assets/macos-traffic-lights/3-maximize-2-hover.svg';

interface TitleBarProps {
  onSettingsClick: () => void;
  showBackButton?: boolean;
  onBackClick?: () => void;
}

export function TitleBar({ onSettingsClick, showBackButton, onBackClick }: TitleBarProps) {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useThemeStore();
  const currentProjectName = useProjectStore((state) => state.currentProject?.name);
  const view = useProjectStore((state) => state.view);
  const currentEpisodeId = useEpisodeStore((state) => state.currentEpisodeId);
  const episodeName = useEpisodeStore(useCallback(
    (state) => {
      if (!currentEpisodeId) return undefined;
      for (const episodes of Object.values(state.episodesByProject)) {
        const found = episodes.find((ep) => ep.id === currentEpisodeId);
        if (found) return found.name;
      }
      return undefined;
    },
    [currentEpisodeId],
  ));

  const appWindow = getCurrentWindow();
  const isZh = i18n.language.startsWith('zh');
  const isMac =
    typeof navigator !== 'undefined'
    && /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
  const appTitle = t('app.title');

  const titleText = currentProjectName
    ? view === 'canvas' && episodeName
      ? `${currentProjectName} - ${episodeName}`
      : `${currentProjectName} - ${appTitle}`
    : appTitle;

  const handleMinimize = useCallback(async () => {
    await appWindow.minimize();
  }, [appWindow]);

  const handleMaximize = useCallback(async () => {
    const isMaximized = await appWindow.isMaximized();
    if (isMaximized) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  }, [appWindow]);

  const handleClose = useCallback(async () => {
    await appWindow.close();
  }, [appWindow]);

  const handleDragStart = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button') || target?.closest('[data-no-drag="true"]')) {
      return;
    }
    await appWindow.startDragging();
  }, [appWindow]);

  const handleLanguageClick = useCallback(() => {
    const newLang = i18n.language.startsWith('zh') ? 'en' : 'zh';
    i18n.changeLanguage(newLang);
  }, [i18n]);

  const handleThemeClick = useCallback(() => {
    toggleTheme();
  }, [toggleTheme]);

  const [showBackupConfirm, setShowBackupConfirm] = useState(false);
  const [backupStatus, setBackupStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number; label: string; direction: string } | null>(null);

  // 只监听上传进度
  useEffect(() => {
    const unlisten = listen<{ current: number; total: number; label: string; direction: string }>('sync-progress', (event) => {
      if (event.payload.direction === 'push') {
        setSyncProgress(event.payload);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 上传完成或出错时清除进度条
  useEffect(() => {
    if (backupStatus === 'done' || backupStatus === 'error') {
      setSyncProgress(null);
    }
  }, [backupStatus]);

  const handleBackupClick = useCallback(async () => {
    setShowBackupConfirm(true);
  }, []);

  const handleBackupConfirm = useCallback(async () => {
    setShowBackupConfirm(false);
    setBackupStatus('uploading');
    try {
      // 先强制刷 chat 数据到磁盘，再同步到云端
      if ((window as any).__flushChatNowAsync__) {
        await (window as any).__flushChatNowAsync__();
      }
      if ((window as any).__flushProjectPersistsAndWait__) {
        await (window as any).__flushProjectPersistsAndWait__();
      }
      if ((window as any).__forcePersistVideoGenAsync__) {
        await (window as any).__forcePersistVideoGenAsync__();
      }
      await syncPush();
      setBackupStatus('done');
      // done 状态持久保持，不再自动消失
    } catch {
      setBackupStatus('error');
      // error 状态持久保持，不再自动消失
    }
  }, []);

  return (
    <div className="h-10 flex items-center justify-between bg-surface-dark border-b border-border-dark select-none z-50 relative">
      {isMac ? (
        <div className="group flex items-center h-full pl-3 pr-2 gap-2" data-no-drag="true">
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleClose}
            className="relative flex h-3 w-3 items-center justify-center"
            title={t('titleBar.close')}
            aria-label={t('titleBar.close')}
          >
            <img src={closeNormalIcon} alt="" className="h-3 w-3 pointer-events-none opacity-100 transition-opacity group-hover:opacity-0" />
            <img src={closeHoverIcon} alt="" className="absolute h-3 w-3 pointer-events-none opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleMinimize}
            className="relative flex h-3 w-3 items-center justify-center"
            title={t('titleBar.minimize')}
            aria-label={t('titleBar.minimize')}
          >
            <img src={minimizeNormalIcon} alt="" className="h-3 w-3 pointer-events-none opacity-100 transition-opacity group-hover:opacity-0" />
            <img src={minimizeHoverIcon} alt="" className="absolute h-3 w-3 pointer-events-none opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleMaximize}
            className="relative flex h-3 w-3 items-center justify-center"
            title={t('titleBar.maximize')}
            aria-label={t('titleBar.maximize')}
          >
            <img src={maximizeNormalIcon} alt="" className="h-3 w-3 pointer-events-none opacity-100 transition-opacity group-hover:opacity-0" />
            <img src={maximizeHoverIcon} alt="" className="absolute h-3 w-3 pointer-events-none opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </div>
      ) : null}

      <div
        className="flex-1 h-full flex items-center px-4"
        onMouseDown={handleDragStart}
      >
        {showBackButton && onBackClick && (
          <button
            type="button"
            data-no-drag="true"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onBackClick();
            }}
            className="mr-3 p-1 hover:bg-bg-dark rounded transition-colors"
            title={t('titleBar.back')}
          >
            <ArrowLeft className="w-4 h-4 text-text-muted hover:text-text-dark" />
          </button>
        )}
        <span className="text-sm font-semibold text-text-dark">
          {titleText}
        </span>
        {!isZh && !currentProjectName ? (
          <span className="text-xs text-text-muted ml-2">{t('app.subtitle')}</span>
        ) : null}
      </div>

      {/* 右侧按钮区域 */}
      <div className="flex items-center h-full">
        <button
          type="button"
          onClick={handleLanguageClick}
          className="h-full px-3 hover:bg-bg-dark transition-colors"
          title={i18n.language.startsWith('zh') ? t('titleBar.switchToEnglish') : t('titleBar.switchToChinese')}
        >
          <Languages className="w-4 h-4 text-text-muted" />
        </button>

        <button
          type="button"
          onClick={handleThemeClick}
          className="h-full px-3 hover:bg-bg-dark transition-colors"
          title={theme === 'dark' ? t('theme.light') : t('theme.dark')}
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4 text-text-muted" />
          ) : (
            <Moon className="w-4 h-4 text-text-muted" />
          )}
        </button>

        <button
          type="button"
          onClick={handleBackupClick}
          disabled={backupStatus === 'uploading'}
          className={`h-full px-3 hover:bg-bg-dark transition-colors ${backupStatus === 'uploading' ? 'opacity-50' : ''}`}
          title={t('sync.backupToCloud', '备份到云端')}
        >
          <CloudUpload className={`w-4 h-4 ${
            backupStatus === 'error' ? 'text-red-400' :
            backupStatus !== 'idle' ? 'text-green-400' :
            'text-text-muted'
          }`} />
        </button>

        {/* 上传进度条 */}
        {syncProgress && (
          <div className="flex items-center gap-2 px-2">
            <div className="w-20 h-1.5 rounded-full bg-bg-dark overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${syncProgress.total > 0 ? (syncProgress.current / syncProgress.total) * 100 : 0}%` }}
              />
            </div>
            <span className="text-[10px] text-text-muted whitespace-nowrap">
              {syncProgress.current}/{syncProgress.total}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={onSettingsClick}
          className="h-full px-3 hover:bg-bg-dark transition-colors"
          title={t('settings.title')}
        >
          <Settings className="w-4 h-4 text-text-muted" />
        </button>

        {!isMac ? (
          <>
            <div className="w-px h-4 bg-border-dark mx-1" />

            <button
              type="button"
              onClick={handleMinimize}
              className="h-full px-3 hover:bg-bg-dark transition-colors"
              title={t('titleBar.minimize')}
            >
              <Minus className="w-4 h-4 text-text-muted hover:text-text-dark" />
            </button>

            <button
              type="button"
              onClick={handleMaximize}
              className="h-full px-3 hover:bg-bg-dark transition-colors"
              title={t('titleBar.maximize')}
            >
              <Maximize2 className="w-4 h-4 text-text-muted hover:text-text-dark" />
            </button>

            <button
              type="button"
              onClick={handleClose}
              className="h-full px-3 hover:bg-red-500 transition-colors group"
              title={t('titleBar.close')}
            >
              <X className="w-4 h-4 text-text-muted group-hover:text-white" />
            </button>
          </>
        ) : null}
      </div>

      {/* 备份确认对话框 */}
      {showBackupConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-surface-dark border border-border-dark rounded-xl p-6 shadow-2xl max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-text-dark mb-2">
              {t('sync.confirmTitle', '确认备份')}
            </h3>
            <p className="text-sm text-text-muted mb-4">
              {t('sync.confirmMessage', '是否将本地项目数据备份到云端？')}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowBackupConfirm(false)}
                className="px-4 py-2 text-sm rounded-lg hover:bg-bg-dark text-text-muted transition-colors"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={handleBackupConfirm}
                className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:opacity-90 transition-opacity"
              >
                {t('common.confirm', '确认')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
