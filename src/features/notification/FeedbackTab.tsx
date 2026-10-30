import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { UiButton, UiInput, UiSelect, UiTextArea } from '../../components/ui/primitives';
import { submitFeedback } from '../../commands/notifications';
import { useNotificationStore, collectUnreadReplyThreadIds } from './notificationStore';
import { refreshFeedbackThreads } from './useNotificationPolling';
import { formatNotificationTime } from './format';

const CATEGORIES = ['bug', 'experience', 'feature', 'other'] as const;
const MIN_CONTENT_LENGTH = 2;

const STATUS_CHIP: Record<string, string> = {
  pending: 'border-amber-400/40 bg-amber-400/15 text-amber-300',
  answered: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300',
  closed: 'border-[rgba(255,255,255,0.16)] bg-bg-dark/60 text-text-muted',
};

export function FeedbackTab() {
  const { t, i18n } = useTranslation();
  const threads = useNotificationStore((state) => state.threads);
  const seenReplyIds = useNotificationStore((state) => state.seenReplyIds);
  // 未读工单标记：直接由 threads + seenReplyIds 推导，不额外存一份状态
  const unreadThreadIds = useMemo(
    () => collectUnreadReplyThreadIds(threads, seenReplyIds),
    [threads, seenReplyIds]
  );

  const [category, setCategory] = useState<string>('bug');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = content.trim();
    if (trimmed.length < MIN_CONTENT_LENGTH) {
      setErrorText(t('notification.feedback.error.tooShort'));
      return;
    }

    setSubmitting(true);
    setErrorText(null);
    try {
      await submitFeedback({ category, content: trimmed, contact: contact.trim() || undefined });
      setContent('');
      setSubmitted(true);
      await refreshFeedbackThreads();
    } catch (error) {
      setErrorText(typeof error === 'string' ? error : t('notification.feedback.error.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [category, contact, content, t]);

  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        <div>
          <label className="mb-1 block text-[11px] text-text-muted">{t('notification.feedback.categoryLabel')}</label>
          <UiSelect
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label={t('notification.feedback.categoryLabel')}
          >
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {t(`notification.feedback.category.${item}`)}
              </option>
            ))}
          </UiSelect>
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-text-muted">{t('notification.feedback.contentLabel')}</label>
          <UiTextArea
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setSubmitted(false);
            }}
            rows={4}
            maxLength={5000}
            placeholder={t('notification.feedback.contentPlaceholder')}
            className="rounded-lg"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-text-muted">{t('notification.feedback.contactLabel')}</label>
          <UiInput
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            maxLength={200}
            placeholder={t('notification.feedback.contactPlaceholder')}
            className="rounded-lg"
          />
        </div>

        {errorText && <p className="text-[11px] text-red-400">{errorText}</p>}
        {submitted && !errorText && (
          <p className="text-[11px] text-emerald-400">{t('notification.feedback.success')}</p>
        )}

        <UiButton
          type="button"
          variant="primary"
          size="sm"
          className="w-full"
          disabled={submitting || content.trim().length < MIN_CONTENT_LENGTH}
          onClick={handleSubmit}
        >
          {submitting ? t('notification.feedback.submitting') : t('notification.feedback.submit')}
        </UiButton>
      </div>

      <div className="border-t border-[rgba(255,255,255,0.08)] pt-3">
        <p className="mb-2 text-[11px] font-medium text-text-muted">{t('notification.feedback.myThreads')}</p>

        {threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-6 text-text-muted">
            <MessageSquare className="h-5 w-5 opacity-60" />
            <p className="text-[11px]">{t('notification.empty.feedback')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {threads.map((thread) => {
              const status = thread.status ?? 'pending';
              const hasUnreadReply = unreadThreadIds.has(thread.id);
              return (
                <div
                  key={thread.id}
                  className={`rounded-lg border px-3 py-2.5 ${
                    hasUnreadReply
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-[rgba(255,255,255,0.08)] bg-bg-dark/30'
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[10px] text-text-muted/70">
                      {formatNotificationTime(thread.created_at, i18n.language)}
                      {hasUnreadReply && <span className="h-1.5 w-1.5 rounded-full bg-red-500" />}
                    </span>
                    <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${STATUS_CHIP[status] ?? STATUS_CHIP.pending}`}>
                      {t(`notification.feedback.status.${status in STATUS_CHIP ? status : 'pending'}`)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-dark/85">
                    {thread.content}
                  </p>

                  {(thread.replies ?? []).map((reply) => (
                    <div
                      key={reply.id}
                      className="mt-2 rounded-md border-l-2 border-accent/50 bg-accent/5 px-2 py-1.5"
                    >
                      <p className="mb-0.5 text-[10px] text-accent/90">
                        {t('notification.feedback.replyFrom')}
                        {reply.admin_name ? ` · ${reply.admin_name}` : ''}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-dark/85">
                        {reply.body}
                      </p>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
