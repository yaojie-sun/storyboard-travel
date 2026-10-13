import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { STAGE_NAME_KEY, STAGE_NAME_FALLBACK, type StageId } from './stageCards';

interface StageProcessLineProps {
  /** 这一步的产物正文（就是写手那一轮的整段输出）。 */
  content: string;
  /** 这一步是哪一步（`STEP0` … `STEP5.5`）。缺省时标题只显示「已完成」。 */
  stage?: StageId;
}

/**
 * **过程步**的回执 —— 「已完成：需求复述」+ 一截缩略正文，点一下展开全文。
 *
 * 🔴 用户定调：
 *    「这几步，最好是能显示部分缩略内容，例如可以模仿豆包或者deepseek的功能，
 *      有让用户看到写手在干嘛」。
 *
 * ⇒ 取代原先那一行光秃秃的「已完成：X」：**默认收着、只露两行**，
 *   不抢正文的版面；想看写手这一步到底产出了什么，点标题展开。
 *
 * 🔴 **默认收起是刻意的** —— 上一条用户定调是「前边五步不需要显示给用户内容，
 *    用户能看到的，就是最终的视频提示词」。两条合起来的读法是：
 *    **默认不占版面，但要能看到写手在干嘛** ⇒ 缩略 + 可展开，而不是全展开。
 *
 * ⚠️ 正文里可能有 `【分镜映射】` 这类 JSON 块 —— 用 `whitespace-pre-wrap` 原样排，
 *    不做 markdown 渲染（本仓的 `ChatBubble` 也是这么处理的）。
 */
export function StageProcessLine({ content, stage }: StageProcessLineProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const name = stage
    ? t(STAGE_NAME_KEY[stage], STAGE_NAME_FALLBACK[stage] ?? stage)
    : '';

  const title = t('chat.stageName.stageDone', {
    name,
    defaultValue: '已完成：{{name}}',
  });

  const body = content.trim();
  // 没有正文（老会话 / 写手空回复）⇒ 退回一行纯文字，不给一个点不开的三角。
  if (!body) {
    return (
      <div className="px-4 text-xs text-[var(--text-muted)]">{title}</div>
    );
  }

  return (
    <div className="px-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        aria-expanded={expanded}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M4.5 2.5L8 6L4.5 9.5" />
        </svg>
        <span>{title}</span>
      </button>

      {expanded ? (
        <div
          className="
            mt-1.5 ml-[16px] overflow-y-auto rounded-lg px-3 py-2 text-xs leading-relaxed
            bg-[var(--surface)] text-[var(--text-muted)]
            whitespace-pre-wrap break-words
          "
          style={{ maxHeight: '40vh' }}
        >
          {body}
        </div>
      ) : (
        <div
          className="
            mt-1 ml-[16px] line-clamp-2 text-xs leading-relaxed
            text-[var(--text-muted)] opacity-70
            whitespace-pre-wrap break-words
          "
        >
          {body}
        </div>
      )}
    </div>
  );
}
