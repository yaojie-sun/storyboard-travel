import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore, resolveSelectedRefImages, type PromptBlock } from '@/stores/chatStore';
import { getPromptMirror, looksChineseWritten, promptFingerprint } from '@/commands/translateDisplay';
import { hasAttemptedPromptRepair, repairPromptShape } from '@/commands/promptRepair';
import { checkPromptShape } from '@/features/videoGeneration/promptShapeCheck';
import { FillGridButtons } from './FillGridButtons';

interface EditablePromptBlockProps {
  block: PromptBlock;
  messageId: string;
}

/**
 * 提示词气泡 —— **中文可读、可手改**。
 *
 * 🔴 2026-10-28 用户定调（二次）：写手出**中文**六段正文，chat 页与视频生成页**都能改**；
 *    英文只在点「生成视频」那一刻由独立回译规则产出（`translate_rules/prompt_to_english.md`）。
 * 因此这里：
 *   · 正文是中文 ⇒ 直接显示、直接编辑（`onEdit` 改的就是真相源 `block.content`）；
 *   · 正文是英文（老会话）⇒ 中文只作显示镜像，只读；
 *   · 结构自检 —— 出片**之前**把能机械核对的规范项摆出来，别等花了视频钱才发现不对。
 */
export function EditablePromptBlock({ block, messageId }: EditablePromptBlockProps) {
  const { t } = useTranslation();
  const isVideo = block.type === 'video';

  const setPromptBlockMirror = useChatStore((s) => s.setPromptBlockMirror);
  const updatePromptBlock = useChatStore((s) => s.updatePromptBlock);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversations = useChatStore((s) => s.conversations);

  // 从当前消息反向查找所属对话 ID（activeConversationId 可能为空）
  const conversationId = activeConversationId ?? conversations.find((c) =>
    c.messages.some((m) => m.id === messageId)
  )?.id;

  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [mirrorPending, setMirrorPending] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(block.content);

  // 正文是中文 ⇒ 直接编辑（这是真相源）；英文老会话 ⇒ 只看中文镜像，只读
  const promptIsChinese = useMemo(() => looksChineseWritten(block.content), [block.content]);
  const showingMirror = isVideo && !promptIsChinese;
  const canEdit = !isVideo || !showingMirror;

  const handleSave = useCallback(() => {
    updatePromptBlock(messageId, block.id, editValue);
    setIsEditing(false);
  }, [messageId, block.id, editValue, updatePromptBlock]);

  const fingerprint = useMemo(() => promptFingerprint(block.content), [block.content]);
  const mirrorFresh = !!block.contentZh && block.contentZhFrom === fingerprint;
  const needsMirror = showingMirror && !mirrorFresh && block.content.trim().length > 0;

  // 需要镜像就取一次；取不到不阻塞显示，退回英文原文
  useEffect(() => {
    if (!needsMirror) return;
    let cancelled = false;
    setMirrorPending(true);
    setMirrorError(null);
    getPromptMirror(block.content).then((res) => {
      if (cancelled) return;
      setMirrorPending(false);
      if (res.zh) {
        setPromptBlockMirror(messageId, block.id, res.zh, promptFingerprint(block.content));
      } else {
        setMirrorError(res.reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsMirror, block.id, block.content, messageId, setPromptBlockMirror]);

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
  }, [isVideo, shape, block.content, block.id, messageId, updatePromptBlock]);

  const zhText = mirrorFresh ? block.contentZh : null;
  const showingZh = showingMirror && lang === 'zh';
  // 🔴 中文是**默认显示**的那一份。译文还没回来时**不退回英文** ——
  //    用户看到的第一屏就是一大段英文，会以为产品默认就是英文。
  //    等译文到了再填进来；只有**真失败**（`mirrorError`）才退回英文原文，并给出提示。
  const mirrorWaiting = showingZh && !zhText && !mirrorError && block.content.trim().length > 0;
  const bodyText = showingZh ? (zhText ?? (mirrorError ? block.content : '')) : block.content;

  return (
    <div
      className={`
        rounded-xl border overflow-hidden
        ${isVideo ? 'border-purple-500/30' : 'border-emerald-500/30'}
      `}
    >
      {/* Header — 标签 + 语言切换 */}
      <div
        className={`
          flex items-center justify-between gap-2 px-3 py-1.5 text-xs font-medium
          ${isVideo ? 'bg-purple-500/10 text-purple-500' : 'bg-emerald-500/10 text-emerald-500'}
        `}
      >
        <span>
          {isVideo ? t('chat.videoPromptLabel') : t('chat.gridPromptLabel')}
        </span>

        {showingMirror && (
          <div
            className="flex items-center rounded-lg overflow-hidden border border-current/20"
            role="group"
            aria-label={t('chat.prompt.langToggle')}
          >
            {(['zh', 'en'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setLang(key)}
                className={`
                  px-2 py-0.5 text-[11px] transition-colors
                  ${lang === key ? 'bg-current/20 font-semibold' : 'hover:bg-current/10'}
                `}
              >
                {key === 'zh' ? t('chat.prompt.langZh') : t('chat.prompt.langEn')}
              </button>
            ))}
          </div>
        )}
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
        {mirrorWaiting && (
          <div className="text-[11px] text-[var(--text-muted)]">
            {t('chat.prompt.mirrorPending')}
          </div>
        )}
        {/* 只在**真的失败**之后才提示；否则首帧会闪一下琥珀色警告 */}
        {showingZh && !mirrorPending && !zhText && !!mirrorError && (
          <div className="mb-2 text-[11px] text-amber-600 dark:text-amber-400">
            {t('chat.prompt.mirrorFailed')}
            {mirrorError && !mirrorError.startsWith('translation_unavailable') ? (
              <span className="opacity-70"> · {mirrorError}</span>
            ) : null}
          </div>
        )}

        <div className="text-sm text-[var(--text)] whitespace-pre-wrap break-words leading-relaxed">
          {bodyText}
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
