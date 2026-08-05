import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/stores/chatStore';
import { UiModal, UiButton } from '@/components/ui';

export function ChatInput() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [showInspirationConfirm, setShowInspirationConfirm] = useState(false);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelStream = useChatStore((s) => s.cancelStream);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) {
      return;
    }
    setInput('');
    sendMessage(trimmed);
  }, [input, isStreaming, sendMessage]);

  const handleInspiration = useCallback(() => {
    if (isStreaming) return;
    setShowInspirationConfirm(true);
  }, [isStreaming]);

  const confirmInspiration = useCallback(() => {
    setShowInspirationConfirm(false);
    sendMessage('💡爆款灵感：请根据我的项目产品，搜索当前短视频热门趋势，给我 3 个精准的爆款创意方案', 'inspiration');
  }, [sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="p-4 border-t border-[var(--ui-border-soft)] shrink-0">
      {/* 快捷操作栏 */}
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={handleInspiration}
          disabled={isStreaming}
          className="
            inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
            bg-[var(--accent)]/10 text-[var(--accent)]
            hover:bg-[var(--accent)]/20
            disabled:opacity-40 disabled:cursor-not-allowed
            transition-colors
          "
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 2c2.76 0 5 2.24 5 5 0 2.05-1.23 3.81-3 4.58V13l-1.5-1.5L7 13v-1.42A4.99 4.99 0 0 1 3 7c0-2.76 2.24-5 5-5z" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M5.5 7h5M8 4.5v5" strokeLinecap="round"/>
          </svg>
          {t('chat.inspiration', '💡 爆款灵感')}
        </button>
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.inputPlaceholder', '描述你的想法...')}
          disabled={isStreaming}
          rows={8}
          className="
            flex-1 resize-y rounded-xl px-3.5 py-2.5 text-sm
            bg-[var(--ui-surface-field)] text-[var(--text)]
            placeholder:text-[var(--text-muted)]
            border border-[var(--ui-border-soft)]
            focus:outline-none focus:border-[var(--accent)]
            disabled:opacity-50
            min-h-[200px] max-h-[60vh]
          "
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={cancelStream}
            className="
              shrink-0 w-9 h-9 rounded-xl
              bg-red-500/10 text-red-500
              hover:bg-red-500/20
              transition-colors
              flex items-center justify-center
            "
            title="停止生成"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim()}
            className="
              shrink-0 w-9 h-9 rounded-xl
              bg-[var(--accent)] text-white
              hover:opacity-90
              disabled:opacity-30 disabled:cursor-not-allowed
              transition-opacity
              flex items-center justify-center
            "
            title={t('chat.send', '发送')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 8L14 2L10 14L8 10L6 9L2 8Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>

      {/* 爆款灵感确认弹窗 */}
      <UiModal
        isOpen={showInspirationConfirm}
        title={t('chat.inspiration', '💡 爆款灵感')}
        onClose={() => setShowInspirationConfirm(false)}
        widthClassName="w-[400px]"
        footer={
          <div className="flex gap-2 w-full">
            <UiButton
              variant="muted"
              size="sm"
              onClick={() => setShowInspirationConfirm(false)}
              className="flex-1"
            >
              {t('common.cancel', '取消')}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              onClick={confirmInspiration}
              className="flex-1"
            >
              {t('common.confirm', '确认')} (-3 {t('common.credits', '积分')})
            </UiButton>
          </div>
        }
      >
        <div className="text-center py-4 space-y-3">
          <p className="text-sm text-text-dark leading-relaxed">
            {t('chat.inspirationConfirm', 'AI 将根据您的项目产品，搜索近期热门短视频趋势，生成 3 个精准爆款创意方案。')}
          </p>
          <p className="text-sm text-[var(--accent)] font-medium">
            {t('chat.inspirationCost', '每次消耗 3 积分')}
          </p>
        </div>
      </UiModal>
    </div>
  );
}
