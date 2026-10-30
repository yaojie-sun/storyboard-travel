export const STORYBOARD_AT_TAG_REGEX = /@\s*图\d+/g;

export function sanitizeStoryboardText(input: string, ignoreAtTag: boolean): string {
  if (!ignoreAtTag) {
    return input.trim();
  }

  return input
    .replace(STORYBOARD_AT_TAG_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 写手在分镜正文里**自纠**留下的草稿痕迹 —— 清掉，只留改后的那句。
 *
 * 🔴 2026-10-30 R1 实测（宫格路，间歇性）：写手把「先写错、再自己改」的过程原样留在格内文本里 ——
 *    「短发被门外的气流带动**？——不写气流，改为：**包带在肩上被压低。」
 *    这段文字会原样进宫格图模型的入参，也显示在节点上。
 *    官方 §5.1 的正文是**可直接投喂模型的成片描述**，不含工作过程文本；
 *    本仓 `SKILL.md` 也没有「允许保留修改痕迹」的条款 ⇒ 属客观污染，不是自造判据。
 *
 * 只认**已观测到的三种形状**，不做泛化清洗（宁可漏，不可误删正文）。
 */
const SELF_CORRECTION_META =
  /[？?]?\s*——\s*(?:不写|不用|不要|不采用)[^，,。；;：:\n]{1,24}[，,]\s*(?:改为|改成|换成)[：:]?\s*/g;
/** `（不写气流，改为：包带在肩上被压低）` ⇒ `（包带在肩上被压低）` */
const SELF_CORRECTION_PAREN =
  /[（(]\s*(?:不写|不用|不要|不采用)[^）)\n]{1,40}?(?:改为|改成|换成)[：:]?\s*([^）)\n]*)[）)]/g;
/** 光秃秃的 `——改为：` */
const SELF_CORRECTION_BARE = /——\s*(?:改为|改成|换成)[：:]?\s*/g;

/**
 * 删掉自纠痕迹，**连同被改掉的那半句**。
 *
 * 例：「…便利店，短发被门外的气流带动？——不写气流，改为：包带在肩上被压低。」
 * ⇒ 「…便利店，包带在肩上被压低。」
 *
 * 往前最多回看 24 个字符找回被否定的半句；找不到子句边界（半句太长）时**只删说明文字**，
 * 宁可留下一句略生硬的话，也不误删正文。
 */
function stripSelfCorrection(text: string, meta: RegExp): string {
  const BACK = 24;
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  meta.lastIndex = 0;
  while ((m = meta.exec(text))) {
    const from = Math.max(0, m.index - BACK);
    const back = text.slice(from, m.index);
    const boundary = Math.max(
      back.lastIndexOf('，'),
      back.lastIndexOf(','),
      back.lastIndexOf('。'),
      back.lastIndexOf('；'),
      back.lastIndexOf(';'),
      back.lastIndexOf('！'),
      back.lastIndexOf('!'),
      back.lastIndexOf('\n'),
    );
    const start = boundary >= 0 ? from + boundary + 1 : m.index;
    out += text.slice(cursor, start);
    cursor = m.index + m[0].length;
  }
  out += text.slice(cursor);
  return out;
}

export function sanitizeStoryboardPromptText(input: string): string {
  let out = input
    // 去掉时间码标记，如 [00:00-00:04] 或 [00:06-00:09]
    .replace(/\[\d{2}:\d{2}-\d{2}:\d{2}\]/g, '')
    // 去掉"镜头N："或"镜头N."前缀，避免模型误解为额外格子
    .replace(/镜头\d+[：:\.\s]+/g, '');
  out = stripSelfCorrection(out, SELF_CORRECTION_META);
  out = stripSelfCorrection(out, SELF_CORRECTION_BARE);
  out = out.replace(SELF_CORRECTION_PAREN, '（$1）');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}
