import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal } from '@/components/ui';
import { bananaActivateAccount } from '@/commands/ai';

interface AccountActivationDialogProps {
  isOpen: boolean;
  onActivated: () => void;
}

export function AccountActivationDialog({ isOpen, onActivated }: AccountActivationDialogProps) {
  const { t } = useTranslation();
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState('');

  const handleActivate = async () => {
    setActivating(true);
    setError('');
    try {
      await bananaActivateAccount();
      await onActivated();
    } catch (e: any) {
      setError(e?.toString() || t('accountActivation.failed', '激活失败，请重试'));
    } finally {
      setActivating(false);
    }
  };

  return (
    <UiModal
      isOpen={isOpen}
      onClose={() => {}} // 不允许关闭，必须激活
      title={t('accountActivation.title', '账户激活')}
      widthClassName="w-[420px]"
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <UiButton variant="primary" onClick={handleActivate} disabled={activating}>
            {activating
              ? t('accountActivation.activating', '激活中...')
              : t('accountActivation.activate', '确认激活')}
          </UiButton>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-text-muted leading-6">
        <p>{t('accountActivation.description', '您的账户已注册成功，正在进行最后的激活步骤。')}</p>
        <p>{t('accountActivation.instruction', '请点击下方「确认激活」按钮完成账户设置，激活后即可正常使用所有功能。')}</p>
        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}
      </div>
    </UiModal>
  );
}
