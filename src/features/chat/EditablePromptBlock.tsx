import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore, resolveSelectedRefImages, type PromptBlock } from '@/stores/chatStore';
import { looksChineseWritten } from '@/commands/translateDisplay';
import { hasAttemptedPromptRepair, isFreshInThisSession, repairPromptShape } from '@/commands/promptRepair';
import { checkPromptShape } from '@/features/videoGeneration/promptShapeCheck';
import { FillGridButtons } from './FillGridButtons';

interface EditablePromptBlockProps {
  block: PromptBlock;
  messageId: string;
  /** 所属消息的生成时刻 —— 用来区分「本次新生成」与「历史会话」（见 `isFreshInThisSession`）。 */
  messageCreatedAt?: number;
}

/**
 * 提示词气泡 —— **中文可读、可手改**。
 *
 * 🔴 2026-10-28 用户定调（二次）：写手出**中文**六段正文，chat 页与视频生成页**都能改**；
 *    英文只在点「生成视频」那一刻由独立回译规则产出（`translate_rules/prompt_to_english.md`）。
 * 因此这里：
 *   · 正文是中文 ⇒ 直接显示、直接编辑（`onEdit` 改的就是真相源 `block.content`）；
 *   · 正文是英文（老项目）⇒ 原样只读显示，不翻译、不打网关；
 *   · 结构自检 —— 出片**之前**把能机械核对的规范项摆出来，别等花了视频钱才发现不对。
 */
export function EditablePromptBlock({ block, messageId, messageCreatedAt }: EditablePromptBlockProps) {
  const { t } = useTranslation();
  const isVideo = block.type === 'video';
  /**
   * 🔴 只有**本次运行里新生成**的正文才自动过一遍 skill / 结构校正（用户 2026-10-31 定调）。
   *    历史会话打开就只是读：不翻译、不校正、不打网关。
   */
  const freshBlock = isFreshInThisSession(messageCreatedAt);

  const updatePromptBlock = useChatStore((s) => s.updatePromptBlock);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversations = useChatStore((s) => s.conversations);

  // 从当前消息反向查找所属对话 ID（activeConversationId 可能为空）
  const conversationId = activeConversationId ?? conversations.find((c) =>
    c.messages.some((m) => m.id === messageId)
  )?.id;

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(block.content);

  // 正文是中文 ⇒ 直接编辑（这是真相源）；英文正文只可能是老项目 ⇒ 原样只读显示（2026-10-31）
  const promptIsChinese = useMemo(() => looksChineseWritten(block.content), [block.content]);
  const canEdit = !isVideo || promptIsChinese;

  const handleSave = useCallback(() => {
    updatePromptBlock(messageId, block.id, editValue);
    setIsEditing(false);
  }, [messageId, block.id, editValue, updatePromptBlock]);

  const shape = useMemo(
    () => (isVideo ? checkPromptShape(block.content) : null),
    [isVideo, block.content],
  );
  // 结构不合规 ⇒ 自动修一版（不扣费）。修好就原地换掉，用户只看到最终那一版。
  const [repairState, setRepairState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  // 🔴 **一个字都不给用户报**（2026-10-28 用户二次定调：用户的脚本本来就短，
  //    「再怎样修改脚本也搞不定写手生成 6000 多字」，所以「建议修改脚本」是空话；
  //    刀在写手手上 ⇒ 超长/结构不合规一律由写手与自动校正自己吃掉）。
  //    `failed` 只是状态，不渲染任何文案。
  useEffect(() => {
    if (!isVideo || !shape || shape.level !== 'error') return;
    // 🔴 历史会话不自动校正（2026-10-31 用户定调）：以前生成的正文就是既成事实，
    //    skill 只服务本次新生成。少了这道闸，打开老项目会把每条历史提示词都送网关
    //    复检一遍，白烧 tokens。用户要修可以自己手改。
    if (!freshBlock) return;
    // 🔴 校正过的正文（含上次启动）不再亮提示、不再打网关：用户原话
    //    「为什么每次启动 chat 都会出现这个？校正一次就可以了」。
    if (hasAttemptedPromptRepair(block.content)) return;
    let cancelled = false;
    setRepairState('running');
    repairPromptShape(block.content, shape.issues).then((fixed) => {
      if (cancelled) return;
      // 🔴 **修完必须真的没有 error 才采纳**。否则（例如超长只压到 6500、仍在预算外）
      //    正文一换、指纹一变，这个 effect 会再修一次、再换一次 —— 变成无限重试。
      if (fixed && checkPromptShape(fixed).issues.every((i) => i.level !== 'error')) {
        updatePromptBlock(messageId, block.id, fixed);
        setRepairState('done');
      } else {
        setRepairState('failed');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isVideo, freshBlock, shape, block.content, block.id, messageId, updatePromptBlock]);

  return (
    <div
      className={`
        rounded-xl border overflow-hidden
        ${isVideo ? 'border-purple-500/30' : 'border-emerald-500/30'}
      `}
    >
      {/* Header — 标签 */}
      <div
        className={`
          flex items-center justify-between gap-2 px-3 py-1.5 text-xs font-medium
          ${isVideo ? 'bg-purple-500/10 text-purple-500' : 'bg-emerald-500/10 text-emerald-500'}
        `}
      >
        <span>
          {isVideo ? t('chat.videoPromptLabel') : t('chat.gridPromptLabel')}
        </span>
      </div>

      {/* Content */}
      <div className="p-3">
        {canEdit && isEditing ? (
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
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="px-3 py-1 text-xs rounded-lg bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
              >
                {t('common.save')}
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
            selectedRefImages={resolveSelectedRefImages(block)}
            storySynopsis={block.storySynopsis}
          />
        )}

        {/* 底部：结构自检 + 只读说明 —— 只属于**分镜提示词**。
            宫格块是中文、仍可手改，套上这些会自相矛盾。 */}
        {isVideo && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {repairState === 'running' && (
            <span className="text-[var(--text-muted)] opacity-70">
              {t('chat.prompt.repairing')}
            </span>
          )}
          {repairState === 'done' && (
            <span className="text-emerald-600 dark:text-emerald-400">
              ✓ {t('chat.prompt.repaired')}
            </span>
          )}
          {shape && shape.level === 'ok' && (
            <span className="text-[var(--text-muted)] opacity-70">
              ✓ {t('chat.prompt.shapeOk')}
            </span>
          )}
        </div>
        )}

        {/* 手改入口：宫格块一直可改；分镜块在**正文是中文**时可改（英文老会话只看镜像） */}
        {canEdit && (
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
            {t('common.edit')}
          </button>
        )}
        </>
        )}
      </div>
    </div>
  );
}
