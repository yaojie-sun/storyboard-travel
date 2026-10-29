/**
 * 视频提示词**结构自检** —— 纯正则，不调模型、不花钱、毫秒级。
 *
 * 为什么需要它：提示词可以手改（2026-10-28 定调），但手改同样可能把六段结构、
 * 台词标签、闭唇句写坏 —— 那些缺陷只在**花钱出片之后**才暴露。这里把**官方规范里能机械核对的部分**
 * 全部前置到「送视频之前」。
 *
 * 🔴 **这份报告默认给「自动修正」用，不是给用户看的**（2026-10-28 用户定调：
 *   「写手必须符合标准，用户控制不了写手」）。
 *   用户拿不出动作，把缺陷清单摆给他只是关不掉的噪音
 *   ⇒ 每一项都按 `error` 走 `repairPromptShape` 自动修；界面只报「正在校正」/「已校正」。
 * 🔴 2026-10-28 二次定调后**正文是中文**：字数门按语言分开判（中文 2400 字 / 英文 6200 字符）。
 *
 * 判据出处（每条都能指到官方原文，不是自造）：
 * - 六段字段名/次序 —— 官方 §5.1 正文六段结构
 * - `[Shot N]` 连续编号 —— 官方 §5.x 镜头分段
 * - `<d>…</d>` 成对、有台词的镜头必须带 `(Sx)` —— 官方 §5.4
 * - 有画外音必须有 `says in an off-screen voiceover` + 闭唇句 —— 官方 §4.4
 * - 全文不得出现 `<Audio N>` —— 官方 §2.5（普通参考图不产生音频条目）+ 本产品入参只有参考图
 *
 * 🔴 **只提示、不拦截**：扣费在服务器（CLAUDE.md §12.2），客户端不做拦截判断。
 */

import { looksChineseWritten } from '@/commands/translateDisplay';

const FIELDS = [
  'subject_definitions:',
  'summary:',
  'retention_analysis:',
  'detailed_description:',
  'overall_soundscape:',
  'non_diegetic_music:',
];

/**
 * 正文预算。
 *
 * 视频模型硬限是 `[1, 7000]` 字符，客户端安全线 6900（`VideoGenDialog.tsx:45`）。
 * 2026-10-28 起规则头整段删除（正文本身就是官方六段式，头是重复的第二个真相源），
 * 所以 6900 全部留给正文 —— 但这里仍按 6200 判，因为 6200 是**回译**的产物上限：
 * 中文正文 2400 字按实测 2.25~2.69 倍率回译后正好落在 6200 以内（见下）。
 * 超过 6900 才是 **RetCode 220 提交失败**，6200 是留给自己纠错的余量。
 */
const BODY_SOFT_LIMIT = 6200;

/**
 * 中文正文的字数门（2026-10-28 定调「正文用中文写，提交时回译英文」之后新增）。
 *
 * 提交给 H3 的是**回译后的英文**，英文上限 6200 字符。中文→英文的实测倍率是
 * **2.25 ~ 2.69**（四份官方示例走 `translate_prompt_to_english` 实测：1001→2688 /
 * 1266→3187 / 1484→3675 / 1564→3520），按 2.6 折算 ⇒ 中文这一侧控制到 2400 字以内
 * （与 SKILL.md 规则 10、Rust `MAX_BODY_CHARS_ZH` 同一个数）。
 * 超过就说明这份正文回译后必然要压散文，画面细节会被压掉 —— 该在写手这一侧就写紧凑。
 */
const BODY_SOFT_LIMIT_ZH = 2400;

const VOICEOVER_TRIGGERS = ['says in an off-screen voiceover', '-voice-over'];
/**
 * 画外音行的合法收尾（官方 §4.4）：`while his/her/its lips remain completely closed`。
 * 画框里没人（空镜）⇒ 官方闭唇句没有指代对象，**不写**（判据见下方第 5 条）。
 * 后面 "no person …" 一类匹配是**旧口径遗留**，只为兼容老会话保留。
 */
const CLOSED_LIPS =
  /lips? remain completely closed|no person (?:is )?in (?:this )?(?:shot|frame)|no one can open a mouth|no person in frame/i;

export type PromptIssueCode =
  | 'fields'
  | 'shots'
  | 'dialoguePairs'
  | 'speakerId'
  | 'voiceoverLips'
  | 'audioTag'
  | 'summaryTag'
  | 'tooLong';

export interface PromptIssue {
  code: PromptIssueCode;
  level: 'error' | 'warn';
  /**
   * **不给用户看**的缺陷（用户不能改提示词、也拿不出动作）。
   * 目前由界面统一处理：常态下不列缺陷，只在自动校正**失败**时把清单摆出来做诊断。
   */
  hidden?: boolean;
  /** 供 i18n 插值 */
  params?: Record<string, string | number>;
}

export interface PromptShapeReport {
  level: 'ok' | 'warn' | 'error';
  issues: PromptIssue[];
}

/**
 * 取出 `detailed_description:` 那一段。
 *
 * 🔴 镜头编号**只能在这一段里判**：`summary` 和 `retention_analysis` 里会**引用**
 * `[Shot 1]`（如 `appears in [Shot 1], [Shot 2]`），整篇扫出来的序列是 1,2,1,2,1,2 ——
 * 用「逐个递增」去判会把每一份正常提示词都判红。
 */
function detailedSection(text: string): string {
  const start = text.indexOf('detailed_description:');
  if (start < 0) return text;
  const end = text.indexOf('overall_soundscape:', start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

function collectNumbered(text: string, prefix: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`${prefix.replace(/[[\]]/g, '\\$&')}(\\d+)`, 'g');
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    out.push(Number(m[1]));
  }
  return out;
}

/**
 * 判「这份提示词是不是**我们生成的**」（聊天 / 分镜 → 六段式），而不是用户自己打的字。
 *
 * 用途：只锁生成出来的提示词，手工写的照样能改。
 *
 * 🔴 为什么靠内容判而不是存一个来源字段：`saveConfig` 那条持久化链路是 §12.4 冻结区，
 *    不能为了加个标记去动它。而六段段名**从第一版起就是英文**（官方形状的硬门），
 *    所以「含 `subject_definitions:` 且含 `detailed_description:`」对老会话同样成立。
 */
export function looksGeneratedPrompt(text: string): boolean {
  const body = (text || '').trim();
  if (!body) return false;
  return body.includes('subject_definitions:') && body.includes('detailed_description:');
}

/**
 * 核对一份**待提交的英文提示词**。
 *
 * @param content 六段正文（不含规则头）
 * @param opts.allowAudioTag 该任务是否真的挂了参考音频（当前恒为 false）
 */
export function checkPromptShape(
  content: string,
  opts: { allowAudioTag?: boolean } = {},
): PromptShapeReport {
  const text = content || '';
  const issues: PromptIssue[] = [];

  // 1. 六段字段名齐全且按序
  {
    const missing: string[] = [];
    let cursor = 0;
    for (const field of FIELDS) {
      const idx = text.indexOf(field, cursor);
      if (idx < 0) missing.push(field);
      else cursor = idx + field.length;
    }
    if (missing.length > 0) {
      issues.push({ code: 'fields', level: 'error', params: { missing: missing.join(' / ') } });
    }
  }

  // 2. `[Shot N]` 从 1 连续（只看 detailed_description 段）
  const detailed = detailedSection(text);
  const shots = collectNumbered(detailed, '[Shot ');
  if (shots.length > 0) {
    const broken = shots.some((n, i) => n !== i + 1);
    if (broken) {
      issues.push({
        code: 'shots',
        level: 'error',
        params: { got: shots.join(',') },
      });
    }
  }

  // 3. `<d>` 成对
  {
    const open = (text.match(/<d>/g) || []).length;
    const close = (text.match(/<\/d>/g) || []).length;
    if (open !== close) {
      issues.push({ code: 'dialoguePairs', level: 'error', params: { open, close } });
    }
  }

  // 4. 有台词的镜头必须带说话人编号（同样只看 detailed_description 段）
  if (shots.length > 0) {
    const lines = detailed.split('\n');
    let currentShot = 0;
    const missingSpeaker: number[] = [];
    for (const line of lines) {
      const m = line.match(/\[Shot (\d+)\]/);
      if (m) currentShot = Number(m[1]);
      if (line.includes('<d>') && !/\(S\d/.test(line)) {
        missingSpeaker.push(currentShot);
      }
    }
    if (missingSpeaker.length > 0) {
      issues.push({
        code: 'speakerId',
        level: 'error',
        params: { shots: Array.from(new Set(missingSpeaker)).join(',') },
      });
    }
  }

  // 5. 画外音必须配闭唇句（官方 §4.4）
  {
    let bad = 0;
    for (const line of text.split('\n')) {
      const hasTrigger = VOICEOVER_TRIGGERS.some((t) => line.includes(t));
      // 🔴 官方 §4.4 的闭唇句只对「the corresponding on-screen character」成立：
      //    只有点名了画内主体（<Subject N>）的画外音句才要求闭唇句；
      //    纯旁白／空镜不写闭唇句，也不许为此凭空造人。
      const hasOnScreenSubject = /<Subject\s*\d/.test(line);
      if (hasTrigger && hasOnScreenSubject && !CLOSED_LIPS.test(line)) bad += 1;
    }
    if (bad > 0) {
      issues.push({ code: 'voiceoverLips', level: 'error', params: { count: bad } });
    }
  }

  // 6. 本产品入参只有参考图，正文不该出现音频条目
  if (!opts.allowAudioTag && /<Audio\s*\d/.test(text)) {
    issues.push({ code: 'audioTag', level: 'error' });
  }

  // 7. summary 首项任务类型标签
  {
    const idx = text.indexOf('summary:');
    if (idx >= 0) {
      const rest = text.slice(idx + 'summary:'.length);
      const firstLine = rest.split('\n').find((l) => l.trim().length > 0) || '';
      if (firstLine.trim() && !firstLine.trim().startsWith('[')) {
        issues.push({ code: 'summaryTag', level: 'error' });
      }
    }
  }

  // 8. 长度预算
  // 🔴 **用户改不了提示词**（产品口径），所以这条不能当「存疑项」摆给他看 ——
  //    他能做的只有「改脚本重新生成」，而这条缺陷是写手的：标 `error` 触发自动精简，
  //    `hidden` 让它不进用户可见的缺陷列表（用户 2026-10-28 原话：
  //    「用户删不了提示词，应该写手自己调整」）。
  // 中文正文按 2400 字判，英文（老会话 / 回译产物）按 6200 字符判。
  const bodyLimit = looksChineseWritten(text) ? BODY_SOFT_LIMIT_ZH : BODY_SOFT_LIMIT;
  if (text.length > bodyLimit) {
    issues.push({
      code: 'tooLong',
      level: 'error',
      hidden: true,
      params: { len: text.length, limit: bodyLimit },
    });
  }

  const level: PromptShapeReport['level'] = issues.some((i) => i.level === 'error')
    ? 'error'
    : issues.length > 0
      ? 'warn'
      : 'ok';

  return { level, issues };
}
