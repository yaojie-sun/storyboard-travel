import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import { UiButton, UiInput, UiModal } from '@/components/ui';
import { bananaSaveDeviceToken } from '@/commands/ai';

const PORTAL_URL = 'https://aixiaoxi.top/jy/api-portal/';

interface TokenActivationDialogProps {
  isOpen: boolean;
  onActivated: () => void;
  onSwitchToLogin?: () => void;
}

export function TokenActivationDialog({ isOpen, onActivated, onSwitchToLogin }: TokenActivationDialogProps) {
  const { t } = useTranslation();
  const [token, setToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenPortal = () => {
    openUrl(PORTAL_URL).catch((err) => {
      console.error('打开门户链接失败:', err);
    });
  };

  const handleActivate = async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t('tokenActivation.enterToken', '请输入令牌'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const valid = await bananaSaveDeviceToken(trimmed);
      if (valid) {
        onActivated();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <UiModal
      isOpen={isOpen}
      title={t('tokenActivation.title', '激活分镜大师旅游版')}
      onClose={() => {}} // Cannot close — must activate
      widthClassName="w-[460px]"
      footer={
        <div className="flex items-center justify-between w-full">
          <button
            type="button"
            onClick={handleOpenPortal}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            {t('tokenActivation.goToPortal', '前往 API 门户获取令牌 →')}
          </button>
          <div className="flex items-center gap-2">
            <UiButton variant="primary" size="sm" onClick={handleActivate} disabled={isLoading}>
              {isLoading
                ? t('tokenActivation.activating', '激活中...')
                : t('tokenActivation.activate', '激活')}
            </UiButton>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Step instructions */}
        <div className="rounded-lg bg-[var(--surface)] px-4 py-3 space-y-2">
          <p className="text-sm text-[var(--text)] leading-relaxed">
            {t('tokenActivation.step1', '请先在 API 门户中登录并创建令牌，然后将令牌粘贴到下方输入框中。')}
          </p>
          <ol className="list-decimal list-inside text-sm text-[var(--text-muted)] space-y-1">
            <li>{t('tokenActivation.step1a', '点击上方链接前往 API 门户')}</li>
            <li>{t('tokenActivation.step1b', '登录后点击「创建令牌」')}</li>
            <li>{t('tokenActivation.step1c', '复制生成的令牌，粘贴到下方输入框')}</li>
            <li>{t('tokenActivation.step1d', '点击「激活」按钮完成激活')}</li>
          </ol>
        </div>

        {/* Token input */}
        <div>
          <label className="block text-sm font-medium text-[var(--text)] mb-1.5">
            {t('tokenActivation.tokenLabel', '设备令牌')}
          </label>
          <UiInput
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('tokenActivation.tokenPlaceholder', '粘贴你的设备令牌...')}
            disabled={isLoading}
            autoFocus
          />
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="text-xs text-[var(--text-muted)] border-t border-[var(--ui-border-soft)] pt-3 space-y-1">
          <p>
            {t('tokenActivation.hint', '激活成功后，请关闭分镜大师旅游版并重新启动，即可正常使用。')}
          </p>
          {onSwitchToLogin && (
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="text-[var(--accent)] hover:underline"
            >
              {t('tokenActivation.switchToLogin', '已有账号？使用密码登录')}
            </button>
          )}
        </div>
      </div>
    </UiModal>
  );
}
