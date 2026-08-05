import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal } from '@/components/ui';
import { RechargeDialog } from '@/components/RechargeDialog';

interface CreditInsufficientModalProps {
  isOpen: boolean;
  credits: number;
  onClose: () => void;
  onRecharged: () => void;
}

export function CreditInsufficientModal({
  isOpen,
  credits,
  onClose,
  onRecharged,
}: CreditInsufficientModalProps) {
  const { t } = useTranslation();
  const [showRecharge, setShowRecharge] = useState(false);

  return (
    <>
      <UiModal
        isOpen={isOpen && !showRecharge}
        title={t('common.notice', '提示')}
        onClose={onClose}
        widthClassName="w-[400px]"
        footer={
          <div className="flex gap-2 w-full">
            <UiButton
              variant="muted"
              size="sm"
              onClick={onClose}
              className="flex-1"
            >
              {t('common.close', '关闭')}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              onClick={() => setShowRecharge(true)}
              className="flex-1"
            >
              {t('common.recharge', '充值')}
            </UiButton>
          </div>
        }
      >
        <div className="text-center py-4">
          <p className="text-sm text-text-dark leading-relaxed">
            {t('node.imageEdit.insufficientCredits', '您的积分不足，积分剩余：{{credits}}，请充值！', { credits })}
          </p>
        </div>
      </UiModal>

      {showRecharge && (
        <RechargeDialog
          isOpen={showRecharge}
          onClose={() => setShowRecharge(false)}
          onPaid={() => {
            setShowRecharge(false);
            onRecharged();
          }}
        />
      )}
    </>
  );
}
