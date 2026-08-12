/**
 * 统一宫格提示词解析器 —— 彻底解决 Skill 生成的宫格提示词格式不固定问题。
 *
 * 背景：复制 Chat 宫格提示词到画布时，原逻辑用「数字+顿号」判断，但 Skill
 * 输出的编号格式随意，且常在第一句加视频概括描述，导致解析错位：
 *   - 第一格塞入全部提示词，后面五格空白
 *   - 第一格是概括描述，真实分镜被挤掉一格
 *
 * 本模块统一识别所有常见编号格式，丢弃前言概括句，返回每格提示词。
 *
 * 支持的编号格式（行首或行内）：
 *   1、  2、   …       数字 + 顿号
 *   1.   2.    …       数字 + 点
 *   1)   2)   1） 2）   数字 + 半/全角括号
 *   （1）（2）          全角括号包裹数字
 *   一、 二、  …       中文数字 + 顿号/点/括号
 *   第1格： 第1帧：     第N格/帧
 *   宫格1： 场景1：     宫格N/场景N
 *   **1.** **2.**      Markdown 加粗编号（行内或行首 **1、**）
 */

const CN_NUM = '一二三四五六七八九十百';

/** 编号主体：阿拉伯数字或中文数字 */
const NUM_BODY = `[0-9${CN_NUM}]+`;

/**
 * 行首「帧起始标记」统一匹配。
 * 覆盖：数字/中文数字 + 分隔符、全角括号、第N格/宫格N/场景N/帧N + 冒号。
 */
const FRAME_START_RE = new RegExp(
  '^(?:' +
    // 1、 1. 1) 1） 1: 1： 一、 一. 一) 一：  （含 **1、** **1.** 行首加粗）
    `(?:\\*\\*)?\\s*${NUM_BODY}\\s*[、.．·)）:：]\\s*(?:\\*\\*)?\\s*` +
    // （1） （一）
    `|[（(]${NUM_BODY}[）)]\\s*` +
    // 第N格： 第N帧： 第N宫：
    `|第\\s*${NUM_BODY}\\s*[格宫帧]\\s*[：:]\\s*` +
    // 宫格N： 场景N： 格N： 帧N：
    `|(?:宫格|场景|[格帧])\\s*${NUM_BODY}\\s*[：:]\\s*` +
    ')'
);

/** 行内（可能含 Markdown 加粗）编号标记，用于无换行的扁平段落兜底。 */
const INLINE_MARK_RE = new RegExp(
  `(?:\\*\\*)?\\s*${NUM_BODY}\\s*[、.．·)）:：]\\s*(?:\\*\\*)?\\s*`,
  'g'
);

/** 帧正文结束后出现的尾部说明/操作提示，命中即停止收集。 */
const POST_FRAME_RE =
  /^(?:[-—]{3,}|\*\*说明|跨格一致性|一致性检查|动作连贯|（\d+[格帧]|【注|注[：:]|总结[：:]|\d+格[^，。]*[保持严格一致统一]|\d+[帧格]画面)/;
const COPY_INSTRUCTION_RE = /复制\s*以上|打开.*分镜大师|粘贴生成|如需进一步|请告诉我/;

/** 判断一段文本是否更像「视频概括句」而非真实分镜描述（仅编号超量时调用）。 */
function looksLikeSummary(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  if (/(?:景别|运镜|镜头|中景|近景|远景|特写|全景|推近|拉远|摇镜|平移|跟拍|环绕|微距|走位|动作|shot|frame)/i.test(t)) {
    return false;
  }
  return /(?:这是|本视频|本段|整段|整体|概括|展现|展示的是|一段|主题|风格|色调|氛围|描述)/.test(t);
}

/**
 * 把宫格提示词文本解析为最多 maxFrames 帧的描述数组。
 *
 * @param prompt    宫格提示词原文
 * @param maxFrames 目标帧数（通常 6）
 * @returns 长度恒为 maxFrames 的字符串数组，未匹配到的位置为空字符串
 */
export function splitGridPromptIntoFrames(prompt: string, maxFrames: number): string[] {
  const trimmed = prompt.trim();
  if (!trimmed) return emptyResult(maxFrames);

  // 1. 行内逐行解析（处理前言概括、跨行续写、所有编号格式）
  const lineFrames = parseByLines(trimmed);
  if (lineFrames.length >= 2) return fitToMaxFrames(lineFrames, maxFrames);

  // 2. 行内编号兜底（扁平段落 + **1.** **2.** 等）
  const inlineFrames = parseInline(trimmed);
  if (inlineFrames.length >= 2) return fitToMaxFrames(inlineFrames, maxFrames);

  // 3. 空行分段兜底
  const paras = trimmed.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (paras.length >= 2) return fitToMaxFrames(paras, maxFrames);

  // 4. 只有一整块 → 全部放第一帧
  const result = emptyResult(maxFrames);
  result[0] = trimmed;
  return result;
}

/** 逐行解析：跳过前言概括、合并跨行续写、识别所有编号格式。 */
function parseByLines(trimmed: string): string[] {
  const frames: string[] = [];
  let current: string | null = null;
  let sawNumberedFrame = false;

  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // 帧正文结束后遇到尾部说明/操作提示 → 停止
    if (current !== null && (POST_FRAME_RE.test(line) || COPY_INSTRUCTION_RE.test(line))) {
      break;
    }

    const m = line.match(FRAME_START_RE);
    if (m) {
      if (current !== null) frames.push(current);
      current = line.slice(m[0].length).trim();
      sawNumberedFrame = true;
    } else if (current !== null) {
      current = current ? `${current} ${line}` : line;
    }
    // current === null 且非编号行 → 前言/概括句，丢弃
  }
  if (current !== null) frames.push(current);

  if (!sawNumberedFrame) return [];
  return frames.map((f) => f.trim()).filter(Boolean);
}

/** 行内编号兜底：按编号标记切分（处理无换行的扁平段落）。 */
function parseInline(trimmed: string): string[] {
  const parts = trimmed.split(INLINE_MARK_RE);
  if (parts.length < 3) return [];
  // parts[0] = 前言（丢弃），parts[1..n] = 帧
  return parts.slice(1).map((s) => s.trim()).filter(Boolean);
}

/** 编号数量超过 maxFrames 时丢弃疑似概括句的首项，再填充/截断到 maxFrames。 */
function fitToMaxFrames(frames: string[], maxFrames: number): string[] {
  const cleaned = frames.slice();
  if (cleaned.length > maxFrames && looksLikeSummary(cleaned[0])) {
    cleaned.shift();
  }
  const result = emptyResult(maxFrames);
  for (let i = 0; i < Math.min(cleaned.length, maxFrames); i++) {
    result[i] = cleaned[i];
  }
  return result;
}

function emptyResult(maxFrames: number): string[] {
  return Array.from({ length: maxFrames }, () => '');
}
