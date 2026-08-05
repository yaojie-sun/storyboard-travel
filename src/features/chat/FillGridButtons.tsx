import { useTranslation } from 'react-i18next';

interface FillGridButtonsProps {
  prompt: string;
  frames?: Array<{ description: string }>;
  conversationId?: string;
  shotFrameMap?: Record<string, unknown>;
}

export function FillGridButtons({ prompt, frames, conversationId, shotFrameMap }: FillGridButtonsProps) {
  const { t } = useTranslation();

  const handleFill = () => {
    window.dispatchEvent(
      new CustomEvent('chat-fill-grid', {
        detail: { prompt, rows: 2, cols: 3, frames, conversationId, shotFrameMap },
      }),
    );
  };

  return (
    <button
      type="button"
      onClick={handleFill}
      className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
    >
      <svg width="16" height="16" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="1.5" y="1.5" width="6" height="6" rx="0.8" />
        <rect x="9" y="1.5" width="6" height="6" rx="0.8" />
        <rect x="16.5" y="1.5" width="6" height="6" rx="0.8" />
        <rect x="1.5" y="9.5" width="6" height="6" rx="0.8" />
        <rect x="9" y="9.5" width="6" height="6" rx="0.8" />
        <rect x="16.5" y="9.5" width="6" height="6" rx="0.8" />
      </svg>
      {t('chat.generateGrid', '生成宫格图')}
    </button>
  );
}
