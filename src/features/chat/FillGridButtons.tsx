import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/stores/chatStore';
import { CELLS_ANCHOR_MARK, CELLS_ANCHOR_TAIL } from '@/utils/gridWindowHint';

interface FillGridButtonsProps {
  prompt: string;
  frames?: Array<{ description: string }>;
  conversationId?: string;
  shotFrameMap?: Record<string, unknown>;
  selectedRefImages?: number[];
  storySynopsis?: string;
  characterContext?: string;
  sceneContext?: string[];
  /**
   * 置位时**额外**渲染「直接生成视频」，与「生成宫格图」并排。
   *
   * 🔴 这一对按钮就是 `STEP6` 上**唯一的分叉**（用户定调
   *    「下面是按钮，让用户选择宫格还是直出」）：宫格＝出 6 张逐格图再拼，
   *    直出＝跳过格子、把六段式正文直接送视频模型。
   * 值 = 送模型的六段式正文（`video` 块的 `content`，**用户可能刚编辑过**，
   *    所以取的是块里的实时值，不是写手原始的返回值）。
   */
  directPrompt?: string;
  /** 直出路要带的参考图编号 —— 与宫格路用**同一套** `【选图】@图N`（见 Canvas 的 `chat-direct-video`）。 */
  directSelectedRefImages?: number[];
  /**
   * 🔴 **这一轮还没有 6 格**（写手按 `【模式】直出` 只出了六段式）。
   *
   * ⇒ 宫格按钮变成「**再问写手要一次**」：发一条 `【模式】宫格` 的锚点、
   *   **把用户手上这份（可能已编辑过的）提示词一起带过去**，写手据此出 6 格。
   *   这是「用户选择宫格的时候，才出 6 格」的落点。
   *
   * 缺省 / `false` = 6 格已经在手（老会话，或写手一次把两条路的东西都出了）
   * ⇒ 按钮退回**动作**：直接把已有的 6 格落成宫格节点，不惊动写手。
   */
  needsCells?: boolean;
}

/**
 * 拼「按当前提示词出 6 格」的锚点。
 *
 * 🔴 首行必须是 `【阶段】STEP6` —— 后端 `chat.rs` 靠**首行**判「这是控制轮」
 *    （不注入「别停」护栏、注入 STEP 门机），`gridWindowHint.isGridRequest()`
 *    也靠「首行 = `【阶段】STEP6`」+「有一行含 `【模式】宫格`」认这一轮、
 *    并顺带补上 6 个时间窗的提示。**这两处的字符串必须逐字相同。**
 *
 * 🔴 **带正文**：用户可能刚在编辑框里改过提示词，那 6 格必须按**改后**的那份出。
 *    这正是「先生成视频提示词让用户选择，用户选择宫格的时候，才出 6 格」里
 *    「才出」二字的落点 —— 出格的依据是用户**看完、可能改过**的那一份。
 *
 * 🔴 **只要格子**：宫格路本会「先 6 格、再出片提示词」，但那会把同一份提示词
 *    再吐一遍（用户手里已经有一份、还可能改过）。所以这里明写「不要再输出提示词正文」，
 *    只收 6 格 + `【分镜映射】`。
 *
 * 🔴 **标记语与界尾从 `@/utils/gridWindowHint` 取，不在这里再写一份字面**：
 *    那边 `parseCellsAnchor` 是解方（`chatStore` 靠它取回这一份正文）。
 *    产方解方各写一份 = 本仓反复吃亏的「名字散落各处」。
 */
function buildCellsAnchor(prompt: string): string {
  const body = prompt.trim();
  return (
    `【阶段】STEP6\n【模式】宫格\n\n` +
    `${CELLS_ANCHOR_MARK}按下面这份出片提示词出 6 格画面描述：\n\n` +
    `${body}\n\n` +
    CELLS_ANCHOR_TAIL
  );
}

/**
 * `STEP6` 产物的**分叉按钮**。
 *
 * 🔴 **直出按钮**永远是 `CustomEvent`、「落到画布节点」这一条路，**不请写手再写一句**
 *    （它不是锚点）—— 写手那一步已经跑完了，这里只是把已经拿到的正文落成节点。
 *
 * 🔴 **宫格按钮有两种形态**（用户定调「用户选择宫格的时候，才出 6 格」）：
 *    · `needsCells` ⇒ 这一轮**还没有** 6 格 ⇒ 发锚点**请写手出格**（见 `buildCellsAnchor`）；
 *    · 否则 ⇒ 6 格已经在手 ⇒ 与直出按钮同形，直接落成宫格节点。
 *    前一形态的落节点动作，落在**下一轮**那条回复的宫格按钮上。
 *
 * 🔴 **渲染位置：`ChatPanel` 的「气泡外的动作区」**（用户定调
 *    「直接生成视频的按钮跑到气泡里面了，这个是有问题的，**必须在气泡外**」）。
 *    它曾经挂在 `EditablePromptBlock`（提示词卡片内部），用户当场否掉 ——
 *    住在卡片里的按钮读起来像「对这份卡片的操作」，而它实际是**对整轮的下一步**。
 */
export function FillGridButtons({
  prompt,
  frames,
  conversationId,
  shotFrameMap,
  selectedRefImages,
  storySynopsis,
  characterContext,
  sceneContext,
  directPrompt,
  directSelectedRefImages,
  needsCells,
}: FillGridButtonsProps) {
  const { t } = useTranslation();

  const handleFill = () => {
    // 这一轮还没有 6 格 ⇒ 先请写手出格（把用户手上这份提示词一并带过去），
    // 落节点的动作等在下一轮、`grid` 块到手之后再点。
    if (needsCells) {
      useChatStore.getState().sendMessage(buildCellsAnchor(prompt));
      return;
    }
    window.dispatchEvent(
      new CustomEvent('chat-fill-grid', {
        detail: {
          prompt,
          rows: 2,
          cols: 3,
          frames,
          conversationId,
          shotFrameMap,
          selectedRefImages,
          storySynopsis,
          characterContext,
          sceneContext,
        },
      }),
    );
  };

  const handleDirect = () => {
    window.dispatchEvent(
      new CustomEvent('chat-direct-video', {
        detail: {
          prompt: directPrompt,
          conversationId,
          selectedRefImages: directSelectedRefImages,
        },
      }),
    );
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={handleFill}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
      >
        <svg width="16" height="16" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="1.5" y="1.5" width="6" height="6" rx="0.8" />
          <rect x="9" y="1.5" width="6" height="6" rx="0.8" />
          <rect x="16.5" y="1.5" width="6" height="6" rx="0.8" />
          <rect x="1.5" y="9.5" width="6" height="6" rx="0.8" />
          <rect x="9" y="9.5" width="6" height="6" rx="0.8" />
          <rect x="16.5" y="9.5" width="6" height="6" rx="0.8" />
        </svg>
        {needsCells
          ? t('chat.generateStoryboard', '生成宫格分镜')
          : t('chat.generateGrid', '生成宫格图')}
      </button>

      {directPrompt && (
        <button
          type="button"
          onClick={handleDirect}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-[var(--surface)] text-[var(--text)] border border-[var(--ui-border-soft)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 5h16v14H4z" />
            <path d="M10 9.5l5 2.5-5 2.5z" />
          </svg>
          {t('chat.stage.directNow', '直接生成视频')}
        </button>
      )}
    </div>
  );
}
