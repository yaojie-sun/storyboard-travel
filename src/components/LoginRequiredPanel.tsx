import { useTranslation } from 'react-i18next';

import { UiButton, UiPanel } from '@/components/ui';

interface LoginRequiredPanelProps {
  onLogin: () => void;
}

/**
 * 未登录占位页：登录对话框被用户主动关闭后展示，保证「关闭」有真实反馈，
 * 同时始终保留一个重新打开登录框的入口，避免用户卡在空白页。
 */
export function LoginRequiredPanel({ onLogin }: LoginRequiredPanelProps) {
  const { t } = useTranslation();

  return (
    <UiPanel className="w-[360px] px-6 py-8 text-center">
      <p className="text-sm text-text-dark">{t('loginDialog.required')}</p>
      <UiButton variant="primary" size="sm" className="mt-4" onClick={onLogin}>
        {t('loginDialog.login')}
      </UiButton>
    </UiPanel>
  );
}
