import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore, type PromptBlock } from '@/stores/chatStore';
import { FillGridButtons } from './FillGridButtons';

interface EditablePromptBlockProps {
  block: PromptBlock;
  messageId: string;
}

export function EditablePromptBlock({
  block,
  messageId,
}: EditablePromptBlockProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(block.content);

  const updatePromptBlock = useChatStore((s) => s.updatePromptBlock);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversations = useChatStore((s) => s.conversations);

  // 从当前消息反向查找所属对话 ID（activeConversationId 可能为空）
  const conversationId = activeConversationId ?? conversations.find((c) =>
    c.messages.some((m) => m.id === messageId)
  )?.id;

  const isVideo = block.type === 'video';

  const handleSave = useCallback(() => {
    updatePromptBlock(messageId, block.id, editValue);
    setIsEditing(false);
  }, [messageId, block.id, editValue, updatePromptBlock]);

  return (
    <>
      <div
        className={`
          rounded-xl border overflow-hidden
          ${isVideo ? 'border-purple-500/30' : 'border-emerald-500/30'}
        `}
      >
        {/* Header — label only, no buttons */}
        <div
          className={`
            flex items-center px-3 py-1.5 text-xs font-medium
            ${isVideo ? 'bg-purple-500/10 text-purple-500' : 'bg-emerald-500/10 text-emerald-500'}
          `}
        >
          <span>
            {isVideo
              ? t('chat.videoPromptLabel', '分镜提示词')
              : t('chat.gridPromptLabel', '宫格提示词')}
          </span>
        </div>

        {/* Content */}
        <div className="p-3">
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                className="
                  w-full resize-y rounded-lg px-3 py-2 text-sm
                  bg-[var(--ui-surface-field)] text-[var(--text)]
                  border border-[var(--ui-border-soft)]
                  focus:outline-none focus:border-[var(--accent)]
                "
                style={{ height: '40vh', minHeight: '200px' }}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="px-3 py-1 text-xs rounded-lg hover:bg-[var(--surface)] transition-colors"
                >
                  {t('common.cancel', '取消')}
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="px-3 py-1 text-xs rounded-lg bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
                >
                  {t('common.save', '保存')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="text-sm text-[var(--text)] whitespace-pre-wrap break-words leading-relaxed">
                {block.content}
              </div>

              {/* Grid fill button — always 6-grid (2x3) */}
              {!isVideo && (
                <FillGridButtons
                  prompt={block.content}
                  frames={block.frames}
                  conversationId={conversationId}
                  shotFrameMap={block.shotFrameMap}
                  selectedRefImages={block.selectedRefImages}
                  storySynopsis={block.storySynopsis}
                />
              )}

              {/* Edit button — bottom left */}
              <button
                type="button"
                onClick={() => {
                  setEditValue(block.content);
                  setIsEditing(true);
                }}
                className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-[var(--text-muted)] hover:bg-black/5 dark:hover:bg-white/10 hover:text-[var(--text)] transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M11 2L14 5L5 14L2 14L2 11L11 2Z" />
                </svg>
                {t('common.edit', '编辑')}
              </button>
            </>
          )}
        </div>
      </div>

    </>
  );
}
