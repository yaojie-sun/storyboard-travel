import { useState, useEffect } from 'react';
import { UiButton, UiModal } from '@/components/ui';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import { bananaCheckPaymentStatus, bananaGetCurrentUser } from '@/commands/ai';
import { RechargeDialog } from '@/components/RechargeDialog';

type PaymentDialogType = 'payment' | 'recharge_guide';

interface PaymentDialogProps {
  isOpen: boolean;
  orderId: string;
  paymentUrl?: string;
  amount?: number;
  credits?: number;
  qrCode?: string;
  type?: PaymentDialogType;
  title?: string;
  description?: string;
  onPaymentSuccess?: (orderId: string) => void;
  onPaymentFailed?: (orderId: string, error: string) => void;
  onClose: () => void;
  onRecharged?: () => void;
}

export function PaymentDialog({
  isOpen,
  orderId,
  paymentUrl = '',
  amount = 0,
  credits = 0,
  qrCode,
  type = 'payment',
  title: _title = '充值解锁功能',
  description: _description = '',
  onPaymentSuccess,
  onPaymentFailed: _onPaymentFailed,
  onClose,
  onRecharged,
}: PaymentDialogProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'pending' | 'processing' | 'success' | 'failed' | 'recharge_guide'>('pending');
  const [error, setError] = useState<string | null>(null);
  const [pollingInterval, setPollingInterval] = useState<ReturnType<typeof setInterval> | null>(null);
  const [showRecharge, setShowRecharge] = useState(false);
  const [currentCredits, setCurrentCredits] = useState(0);
  const MANAGEMENT_URL = 'http://aixiaoxi.top/jy/api-portal/';

  // 如果是充值引导类型，获取最新积分并设置为充值引导状态
  useEffect(() => {
    if (isOpen && type === 'recharge_guide') {
      setStatus('recharge_guide');
      bananaGetCurrentUser().then(u => setCurrentCredits(u.credits)).catch(() => setCurrentCredits(0));
    } else if (isOpen && type === 'payment') {
      setStatus('pending');
      startPolling();
    }
  }, [isOpen, type]);

  // 开始轮询支付状态
  const startPolling = () => {
    if (type !== 'payment') return; // 只在支付类型时轮询

    if (pollingInterval) {
      clearInterval(pollingInterval);
    }

    const interval = setInterval(async () => {
      try {
        const paymentStatus = await bananaCheckPaymentStatus(orderId);
        console.log('支付状态检查:', paymentStatus);

        if (paymentStatus.paid) {
          setStatus('success');
          clearInterval(interval);
          if (onPaymentSuccess) {
            setTimeout(() => {
              onPaymentSuccess(orderId);
              onClose();
            }, 2000); // 2秒后自动关闭
          }
          return;
        }

        if (paymentStatus.status === 'failed' || paymentStatus.status === 'cancelled') {
          setStatus('failed');
          setError(`支付${paymentStatus.status === 'failed' ? '失败' : '已取消'}`);
          clearInterval(interval);
          return;
        }
      } catch (error) {
        console.error('检查支付状态失败:', error);
      }
    }, 5000); // 每5秒检查一次

    setPollingInterval(interval);
  };

  // 当对话框打开时开始轮询
  useEffect(() => {
    if (isOpen && type === 'payment') {
      setStatus('pending');
      setError(null);
      startPolling();

      // 30分钟后自动停止轮询
      const timeout = setTimeout(() => {
        if (pollingInterval) {
          clearInterval(pollingInterval);
        }
        if (status === 'pending') {
          setStatus('failed');
          setError('支付超时，请重新尝试');
        }
      }, 30 * 60 * 1000); // 30分钟

      return () => {
        if (pollingInterval) {
          clearInterval(pollingInterval);
        }
        clearTimeout(timeout);
      };
    }
  }, [isOpen, type]);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  const handleOpenInBrowser = () => {
    const url = paymentUrl || MANAGEMENT_URL;
    void openUrl(url);
  };

  const handleRetry = () => {
    setStatus('pending');
    setError(null);
    startPolling();
  };

  const handleClose = () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    onClose();
  };

  const renderContent = () => {
    switch (status) {
      case 'success':
        return (
          <div className="py-8 text-center">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-green-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-text-dark mb-2">
              {t('paymentDialog.paymentSuccess', '支付成功!')}
            </h3>
            <p className="text-sm text-text-muted">
              {t('paymentDialog.successMessage', '已为您添加{credits}次使用次数，正在解锁功能...', { credits })}
            </p>
          </div>
        );

      case 'failed':
        return (
          <div className="py-8 text-center">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-red-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-text-dark mb-2">
              {t('paymentDialog.paymentFailed', '支付失败')}
            </h3>
            <p className="text-sm text-text-muted mb-4">{error}</p>
            <div className="flex gap-3 justify-center">
              <UiButton variant="muted" size="sm" onClick={handleClose}>
                {t('common.close', '关闭')}
              </UiButton>
              <UiButton variant="primary" size="sm" onClick={handleRetry}>
                {t('paymentDialog.retry', '重试')}
              </UiButton>
            </div>
          </div>
        );

      case 'recharge_guide':
        return (
          <div className="text-center py-4 space-y-4">
            <p className="text-sm text-text-dark leading-relaxed">
              {t('node.imageEdit.insufficientCredits', '您的积分不足，积分剩余：{{credits}}，请充值！', { credits: currentCredits })}
            </p>
            <div className="flex gap-2 justify-center">
              <UiButton variant="muted" size="sm" onClick={handleClose}>
                {t('common.close', '关闭')}
              </UiButton>
              <UiButton variant="primary" size="sm" onClick={() => setShowRecharge(true)}>
                {t('common.recharge', '充值')}
              </UiButton>
            </div>
          </div>
        );

      default:
        return (
          <div className="space-y-6">
            <div className="bg-bg-dark/60 rounded-lg p-4 border border-border">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm font-medium text-text-dark">
                  {t('paymentDialog.orderInfo', '订单信息')}
                </span>
                <span className="text-xs font-mono bg-bg-darker px-2 py-1 rounded">
                  {orderId}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-text-muted">
                    {t('paymentDialog.amount', '金额')}
                  </span>
                  <span className="text-sm font-medium text-text-dark">¥{amount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-text-muted">
                    {t('paymentDialog.credits', '获得次数')}
                  </span>
                  <span className="text-sm font-medium text-text-dark">{credits} 次</span>
                </div>
              </div>
            </div>

            {qrCode ? (
              <div className="text-center">
                <p className="text-sm text-text-muted mb-3">
                  {t('paymentDialog.scanQRCode', '请使用支付宝或微信扫描二维码支付')}
                </p>
                <div className="inline-block p-4 bg-white rounded-lg">
                  <img src={qrCode} alt="支付二维码" className="w-48 h-48" />
                </div>
                <p className="text-xs text-text-muted mt-3">
                  {t('paymentDialog.qrCodeHint', '扫描后请在手机端完成支付')}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-text-muted">
                  {t('paymentDialog.browserHint', '点击下方按钮在浏览器中打开管理页面')}
                </p>
                <UiButton
                  variant="primary"
                  size="sm"
                  onClick={handleOpenInBrowser}
                  className="w-full"
                >
                  {t('paymentDialog.openInBrowser', '在浏览器中打开管理页面')}
                </UiButton>
              </div>
            )}

            <div className="pt-4 border-t border-border">
              <div className="flex items-center justify-center gap-2">
                <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                <span className="text-sm text-text-muted">
                  {t('paymentDialog.pollingStatus', '正在检测支付状态...')}
                </span>
              </div>
              <p className="text-xs text-text-muted text-center mt-2">
                {t('paymentDialog.pollingHint', '支付成功后会自动解锁功能，请勿关闭此窗口')}
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <>
      <UiModal
        isOpen={isOpen && !showRecharge}
        title={
          status === 'success'
            ? t('paymentDialog.titleSuccess', '支付成功')
            : status === 'failed'
            ? t('paymentDialog.titleFailed', '支付失败')
            : status === 'recharge_guide'
            ? t('common.notice', '提示')
            : t('paymentDialog.title', '充值解锁功能')
        }
        onClose={status === 'pending' ? () => {} : handleClose}
        widthClassName="w-[480px]"
        footer={
          status === 'pending' ? null :
          status === 'recharge_guide' ? null : (
            <UiButton variant="primary" size="sm" onClick={handleClose}>
              {t('common.close', '关闭')}
            </UiButton>
          )
        }
      >
        {renderContent()}
      </UiModal>

      {showRecharge && (
        <RechargeDialog
          isOpen={showRecharge}
          onClose={() => setShowRecharge(false)}
          onPaid={() => {
            setShowRecharge(false);
            onRecharged?.();
            onClose();
          }}
        />
      )}
    </>
  );
}