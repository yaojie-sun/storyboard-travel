import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { UiButton, UiInput, UiModal } from '@/components/ui';
import { bananaCreatePaymentOrder, bananaCheckPaymentStatus, bananaGetCurrentUser, bananaGetCreditsPerYuan } from '@/commands/ai';
import type { BananaPaymentOrder, BananaPaymentStatus } from '@/commands/ai';

interface RechargeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onPaid: () => void;
}

type Phase = 'input' | 'qr' | 'success' | 'failed';

export function RechargeDialog({ isOpen, onClose, onPaid }: RechargeDialogProps) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('10');
  const [phase, setPhase] = useState<Phase>('input');
  const [isCreating, setIsCreating] = useState(false);
  const [order, setOrder] = useState<BananaPaymentOrder | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [creditsPerYuan, setCreditsPerYuan] = useState(10);
  const [pollAttempts, setPollAttempts] = useState(0);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setAmount('10');
    setPhase('input');
    setOrder(null);
    setQrDataUrl(null);
    setError(null);
    setStatusMsg(null);
    setShowCloseConfirm(false);
    stopPolling();
  }, [stopPolling]);

  useEffect(() => {
    if (!isOpen) {
      reset();
    } else {
      bananaGetCreditsPerYuan().then(setCreditsPerYuan).catch(() => {});
    }
  }, [isOpen, reset]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const calculatedCredits = Math.floor(parseFloat(amount || '0') * creditsPerYuan);

  const handleCreateOrder = async () => {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 10) {
      setError(t('recharge.minAmount', '充值金额最低10元'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const userInfo = await bananaGetCurrentUser();
      const created = await bananaCreatePaymentOrder(userInfo.user_id, numAmount, calculatedCredits, 'wechatpay');
      setOrder(created);

      const codeUrl = created.qr_code || created.payment_url;
      if (!codeUrl) {
        setError(t('recharge.qrError', '生成支付二维码失败，请稍后重试'));
        return;
      }

      const dataUrl = await QRCode.toDataURL(codeUrl, { width: 220, margin: 2 });
      setQrDataUrl(dataUrl);
      setPhase('qr');

      // Poll payment status every 3 seconds
      let attempts = 0;
      pollTimerRef.current = setInterval(async () => {
        try {
          attempts++;
          setPollAttempts(attempts);
          const status: BananaPaymentStatus = await bananaCheckPaymentStatus(created.order_id);
          if (status.paid) {
            stopPolling();
            setPhase('success');
            setStatusMsg(t('recharge.success', '充值成功！'));
            onPaid();
            setTimeout(() => onClose(), 2000);
          } else if (attempts > 100) {
            stopPolling();
            setPhase('failed');
            setStatusMsg(t('recharge.timeout', '支付超时，如已支付请联系客服'));
          }
        } catch (err) {
          console.error('[Recharge] poll error:', err);
        }
      }, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsCreating(false);
    }
  };

  const title =
    phase === 'success'
      ? t('recharge.successTitle', '充值成功')
      : phase === 'failed'
        ? t('recharge.failedTitle', '支付超时')
        : t('recharge.title', '微信充值');

  return (
    <UiModal
      isOpen={isOpen}
      title={title}
      onClose={() => {
        if (phase === 'qr') {
          setShowCloseConfirm(true);
          return;
        }
        stopPolling();
        onClose();
      }}
      widthClassName="w-[420px]"
      footer={
        phase === 'input' ? (
          <div className="flex items-center justify-end w-full">
            <UiButton
              variant="primary"
              size="sm"
              onClick={handleCreateOrder}
              disabled={isCreating}
            >
              {isCreating
                ? t('recharge.creating', '创建中...')
                : t('recharge.submit', '生成支付二维码')}
            </UiButton>
          </div>
        ) : phase === 'qr' ? (
          showCloseConfirm ? (
            <div className="flex flex-col gap-2 w-full">
              <p className="text-sm text-text-muted text-center">{t('recharge.closeConfirm', '支付尚未完成，确定关闭吗？')}</p>
              <div className="flex items-center justify-center gap-3">
                <UiButton variant="muted" size="sm" onClick={() => setShowCloseConfirm(false)}>
                  {t('recharge.continuePay', '继续支付')}
                </UiButton>
                <UiButton variant="primary" size="sm" onClick={() => {
                  stopPolling();
                  onClose();
                }}>
                  {t('recharge.confirmClose', '确定关闭')}
                </UiButton>
              </div>
            </div>
          ) : (
          <div className="flex items-center justify-between w-full">
            <span className="text-xs text-text-muted">
              {t('recharge.orderId', '订单')}: {order?.order_id.slice(-12)}
            </span>
            <UiButton variant="muted" size="sm" onClick={async () => {
              try {
                const status = await bananaCheckPaymentStatus(order!.order_id);
                if (status.paid) {
                  stopPolling();
                  setPhase('success');
                  setStatusMsg(t('recharge.success', '充值成功！'));
                  onPaid();
                  setTimeout(() => onClose(), 2000);
                } else {
                  setStatusMsg(`${t('recharge.status', '状态')}: ${status.status}`);
                  setTimeout(() => setStatusMsg(null), 3000);
                }
              } catch (err) {
                setStatusMsg(`${err instanceof Error ? err.message : String(err)}`);
              }
            }}>
              {t('recharge.checkNow', '检测支付')}
            </UiButton>
          </div>
          )
        ) : phase === 'success' || phase === 'failed' ? (
          <div className="flex items-center justify-end w-full">
            <UiButton variant="primary" size="sm" onClick={() => { reset(); onClose(); }}>
              {t('common.confirm', '确定')}
            </UiButton>
          </div>
        ) : null
      }
    >
      <div className="space-y-4">
        {phase === 'input' && (
          <>
            <p className="text-sm text-text-muted">
              {t('recharge.desc', '输入充值金额，生成微信支付二维码')}
            </p>
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-dark whitespace-nowrap">¥</span>
              <UiInput
                type="number"
                min={10}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={t('recharge.amountPlaceholder', '最低1元')}
                className="flex-1"
              />
              <span className="text-sm text-text-muted whitespace-nowrap">
                {t('recharge.yuan', '元')}
              </span>
            </div>
            <div className="bg-bg-dark rounded-lg px-4 py-3 space-y-1">
              <p className="text-xs text-text-muted">
                {t('recharge.exchangeRate', '兑换比例')}: 1元 = <span className="font-semibold text-text-dark">{creditsPerYuan}积分</span>
              </p>
              <p className="text-sm text-text-dark">
                {t('recharge.creditsWillAdd', '充值后获得')}:{' '}
                <span className="font-semibold text-accent">{calculatedCredits} {t('recharge.times', '积分')}</span>
              </p>
            </div>
            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}
          </>
        )}

        {phase === 'qr' && (
          <div className="flex flex-col items-center space-y-4">
            <p className="text-sm text-text-muted text-center">
              {t('recharge.scanTip', '请使用微信扫描下方二维码支付')}
            </p>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="微信支付二维码"
                className="rounded-lg border border-border-dark"
                width={220}
                height={220}
              />
            ) : (
              <div className="w-[220px] h-[220px] rounded-lg border border-border-dark bg-bg-dark flex items-center justify-center">
                <p className="text-sm text-text-muted">{t('recharge.creating', '生成中...')}</p>
              </div>
            )}
            <div className="text-sm text-text-dark text-center space-y-1 bg-bg-dark rounded-lg px-4 py-3">
              <p>
                {t('recharge.amount', '金额')}: <span className="font-semibold">¥{order?.amount.toFixed(2)}</span>
              </p>
              <p>
                {t('recharge.creditsWillAdd', '充值后获得')}:{' '}
                <span className="font-semibold text-accent">{order?.credits} {t('recharge.times', '积分')}</span>
              </p>
            </div>
            <p className="text-xs text-text-muted text-center">
              {t('recharge.waiting', '支付完成后自动检测...')}
              {pollAttempts > 0 && ` (${pollAttempts}/${100})`}
            </p>
            {statusMsg && (
              <p className="text-xs text-blue-400 text-center">{statusMsg}</p>
            )}
          </div>
        )}

        {(phase === 'success' || phase === 'failed') && (
          <div className="flex flex-col items-center space-y-3">
            <div className={`text-4xl ${phase === 'success' ? '' : ''}`}>
              {phase === 'success' ? '✅' : '⏰'}
            </div>
            <p className={`text-sm font-medium ${phase === 'success' ? 'text-green-500' : 'text-yellow-500'}`}>
              {statusMsg}
            </p>
            {order && (
              <p className="text-xs text-text-muted">
                {t('recharge.amount', '金额')}: ¥{order.amount.toFixed(2)} | {t('recharge.creditsWillAdd', '获得')}: {order.credits} {t('recharge.times', '积分')}
              </p>
            )}
          </div>
        )}
      </div>
    </UiModal>
  );
}
