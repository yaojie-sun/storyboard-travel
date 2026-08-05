import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { UiButton, UiModal } from '@/components/ui';

interface UpdateAvailableDialogProps {
  isOpen: boolean;
  onClose: () => void;
  latestVersion?: string;
  currentVersion?: string;
  downloadUrl?: string;
  notes?: string;
}

interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
}

export function UpdateAvailableDialog({
  isOpen,
  onClose,
  latestVersion,
  currentVersion,
  downloadUrl,
  notes,
}: UpdateAvailableDialogProps) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState('');

  const handleBrowserDownload = useCallback(() => {
    if (downloadUrl) {
      void openUrl(downloadUrl);
    }
    onClose();
  }, [downloadUrl, onClose]);

  const handleInAppUpgrade = useCallback(async () => {
    if (!downloadUrl || !latestVersion) return;
    setDownloading(true);
    setError('');
    setProgress(null);

    try {
      // Listen for progress events
      const unlisten = await listen<DownloadProgress>('download-progress', (event) => {
        setProgress(event.payload);
      });

      // Download the installer
      const filePath: string = await invoke('download_upgrade', {
        downloadUrl,
        version: latestVersion,
      });

      unlisten();

      // Show complete
      setProgress({ downloadedBytes: 1, totalBytes: 1, percentage: 100 });

      // Launch installer
      await invoke('launch_installer', { filePath });
    } catch (e: any) {
      setError(e?.toString() || t('update.downloadFailed'));
      setDownloading(false);
      setProgress(null);
    }
  }, [downloadUrl, latestVersion, t]);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <UiModal
      isOpen={isOpen}
      onClose={downloading ? () => {} : onClose}
      title={t('update.dialogTitle')}
      footer={
        !downloading ? (
          <>
            <UiButton variant="muted" onClick={onClose}>
              {t('common.cancel')}
            </UiButton>
            <UiButton variant="muted" onClick={handleBrowserDownload}>
              {t('update.goToDownload')}
            </UiButton>
            <UiButton variant="primary" onClick={handleInAppUpgrade}>
              {t('update.inAppUpgrade', '直接下载安装')}
            </UiButton>
          </>
        ) : null
      }
    >
      <div className="text-sm text-text-muted leading-6">
        <p>{t('update.dialogDescription')}</p>
        {(latestVersion || currentVersion) && (
          <p className="mt-2 text-xs">
            {t('update.versionLine', {
              currentVersion: currentVersion ?? '-',
              latestVersion: latestVersion ?? '-',
            })}
          </p>
        )}

        {/* Download progress */}
        {downloading && (
          <div className="mt-4">
            <div className="h-3 w-full rounded-full bg-bg-dark border border-border-dark overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${Math.min(progress?.percentage ?? 0, 100)}%` }}
              />
            </div>
            <p className="mt-2 text-center text-xs">
              {progress
                ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)} (${Math.round(progress.percentage)}%)`
                : t('update.downloading')}
            </p>
          </div>
        )}

        {error && (
          <p className="mt-2 text-xs text-red-400">{error}</p>
        )}

        {notes && !downloading && (
          <div className="mt-3 rounded border border-border-dark bg-bg-dark p-3">
            <p className="mb-1 text-xs font-medium text-text-dark">{t('update.releaseNotes')}</p>
            <pre className="whitespace-pre-wrap text-xs text-text-muted leading-5">{notes}</pre>
          </div>
        )}
      </div>
    </UiModal>
  );
}
