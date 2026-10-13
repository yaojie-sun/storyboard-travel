/**
 * 小窗（`VideoGenDock`）副标题的**内容摘要**提取。纯函数：无 React、无 store、无副作用。
 *
 * ── 为什么需要它 ──
 * 多个视频生成小窗并存时，节点标题默认全是同一个类型名（「分镜生成」/「直出视频」，
 * 见 `canvas/domain/nodeDisplay.ts` 的 `DEFAULT_NODE_DISPLAY_NAME`，而视频节点没有改名入口），
 * **单靠它分不出哪窗是哪窗**。逐格描述、正文这类内容才是逐节点不同的那一份。
 *
 * 本模块只做一件事：**把一段长文本压成一行可读的短标题**。
 * 「取哪一份文本」（优先逐格描述、回落正文）由调用方决定 —— 见 `VideoGenDialog.tsx`
 * 内层的 `dockSubtitle`。
 *
 * ⚠️ 这是**显示层**的降级逻辑：摘不出来就返回 `null`，调用方据此**整行不渲染**，
 * 不要在界面上留一行「（无标题）」之类的占位。
 */

/** 独占一行的段名（`summary:` / `detailed_description:`）—— 是结构标记，不是内容。 */
const SEGMENT_HEADER_LINE = /^[A-Za-z_][A-Za-z0-9_]*:[ \t]*$/;

/** 行首的段名前缀（`summary: 女主…`）—— 剥掉它，留下内容。 */
const SEGMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*:[ \t]*/;

/** 句读。中英文都要断，否则英文正文会整段塞进来。 */
const SENTENCE_BREAK = /[，。！？；、,.!?;：:]/;

/** 硬截断长度。小窗卡片宽 280px，副标题那一行减掉左右内边距约容得下 20 个汉字。 */
export const DOCK_SUBTITLE_MAX_CHARS = 20;

/**
 * 断句点太靠前就不值得断（例如「全景，…」只留两个字），宁可按长度硬截。
 * 4 是「短到没有信息量」与「够用」之间随手取的界，不是测出来的。
 */
const MIN_BREAK_INDEX = 4;

/**
 * 从一串候选文本里取**第一个**能摘出摘要的，返回那一行短标题；全都摘不出则 `null`。
 *
 * 候选取源由调用方按优先级传进来（本仓的调用点：`initialGridFrames[0]` → `prompt`）。
 */
export function deriveDockSubtitle(
  candidates: Array<string | null | undefined>,
  maxChars: number = DOCK_SUBTITLE_MAX_CHARS,
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    for (const rawLine of candidate.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (SEGMENT_HEADER_LINE.test(line)) continue;
      const body = line.replace(SEGMENT_PREFIX, '').trim();
      if (!body) continue;
      return truncateAtBreak(body, maxChars);
    }
  }
  return null;
}

/** 先按句读断（读起来完整），断点太靠前或断不了就按长度硬截。 */
function truncateAtBreak(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;

  const head = flat.slice(0, maxChars);
  const cut = head.search(SENTENCE_BREAK);
  if (cut >= MIN_BREAK_INDEX) return head.slice(0, cut);

  return `${head}…`;
}
