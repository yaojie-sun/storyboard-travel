import { useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { UiButton, UiModal } from '@/components/ui';
import { bananaActivateAccount } from '@/commands/ai';

interface RestartReminderDialogProps {
  isOpen: boolean;
}

export function RestartReminderDialog({ isOpen }: RestartReminderDialogProps) {
  const appWindow = getCurrentWindow();
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState('');

  const handleActivateAndClose = async () => {
    setActivating(true);
    setError('');
    try {
      await bananaActivateAccount();
      appWindow.close();
    } catch (e: any) {
      setError(e?.toString() || '激活失败，请重试');
      setActivating(false);
    }
  };

  return (
    <UiModal
      isOpen={isOpen}
      onClose={() => {}}
      title="注册成功"
      widthClassName="w-[400px]"
      footer={
        <div className="flex justify-end w-full">
          <UiButton variant="primary" onClick={handleActivateAndClose} disabled={activating}>
            {activating ? '激活中...' : '确定'}
          </UiButton>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-[var(--text-muted)] leading-6">
        <p>请点击确认按钮完成激活，激活成功后需要重启应用。</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </UiModal>
  );
}
