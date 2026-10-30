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
 * 🔴 2026-10-28 二次定调后**正文是中文**：字数门按语言分开判（中文 1000 **汉字** / 英文 6200 字符）。
 * 🔴 2026-10-30 新增两条：`detailed_description` 单段 800 字硬顶（官方 350-500 词）、
 *    没有 `<d>` 的镜不许写「张合／无声地动嘴」（官方 §4.4 只给了闭唇一种写法）。
 * 🔴 2026-10-30 收紧两条：
 *    - 有台词的镜必须有**贴住说话人**的 `(Sx)`（官方 §5.4 `<Subject N> (Sx)`）；
 *      旧判据只看「行里有没有 `(S\d`」，自动校正于是把编号塞成 `说，(S1) <d>` —— 结构过了，形式仍不对。
 *    - 景别只许用官方 5 个英文原词；中文景别（「跟拍全景」）回译时没有字面量可映射，
 *      实测会被译丢或译成 `a full shot` 这类官方没有的写法。
 *
 * 判据出处（每条都能指到官方原文，不是自造）：
 * - 六段字段名/次序 —— 官方 §5.1 正文六段结构
 * - `[Shot N]` 连续编号 —— 官方 §5.x 镜头分段
 * - `<d>…</d>` 成对、有台词的镜头必须带 `(Sx)` —— 官方 §5.4
 * - 有画外音必须有 `says in an off-screen voiceover` + 闭唇句 —— 官方 §4.4
 * - 全文不得出现 `<Audio N>` —— 官方 §2.5（普通参考图不产生音频条目）+ 本产品入参只有参考图
 * - 景别只许 5 个官方原词 —— 官方正文范例里的全部写法（`SKILL.md` 景别表）
 * - 每一镜都要交代景别 —— 官方 §5.3 *For each shot, clearly establish the current composition…*
 *   ＋官方全部范例的每一镜都以景别开头（〔推导〕，见 `RULES_LEDGER.md` #12）
 * - 同一镜内同一个说话人不许既画内开口又画外旁白 —— 官方 §4.4 闭唇句与画内口型互斥
 *   （〔推导〕，见 `RULES_LEDGER.md` #13）
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
 * 规则头现在只剩宫格路 211 字的取图说明 ⇒ 正文按 **6500** 判（2026-10-30 由 6200 上调）：
 * 6500 + 211 + 2 < 6900 安全线，离 7000 硬限还留 280。
 * 超过 6900 才是 **RetCode 220 提交失败**，6500 是留给自己纠错的余量。
 */
const BODY_SOFT_LIMIT = 6500;

/**
 * 中文正文的字数门（2026-10-28 定调「正文用中文写，提交时回译英文」之后新增）。
 *
 * 🔴 **单位是汉字数，不是整段字符数**（2026-10-30 实测改口径）。
 *    提交给 H3 的是**回译后的英文**，英文上限 6500 字符。实测三份正文的倍率是
 *    **5.57 ~ 6.13 英文字符 / 汉字**（1157→6449、798→4888、812→4704；正文越短固定开销占比越高）。
 *    按保守的 **6.2** 折算 ⇒ 中文这一侧卡 **1050 汉字**（约 6510 英文字符），目标压到 1000
 *    （约 5700~6100 英文字符，留 400 以上余量）
 *    （与 SKILL.md 规则 10、Rust `MAX_BODY_CJK_ZH` 同一个数）。
 * 🔴 为什么不能用「整段字符数」：写手看的是 SKILL.md 里那张每镜字数表（单位是**字**），
 *    旧口径「2000 字符」≈ 960 汉字，跟表里「六段合计 1200–1600 字」**互相打架** ——
 *    写手照表写完必然越过字数门，每一次生成都白跑一轮自动校正。
 */
const BODY_SOFT_LIMIT_ZH = 1050;

/**
 * `detailed_description` 单段的字数上限（中文按汉字；英文按词数）。
 *
 * 官方 §5.2：*detailed_description is normally 350-500 English words*。
 * 实测英文词数 ≈ 0.97 × 汉字数 ⇒ 600 汉字 ≈ 580 词，落在官方区间里，
 * 也给其余五段留下 400 汉字的余量（六段合计 1050 汉字，目标 1000）。
 * 英文 800 词是官方上限再留一档（与 SKILL.md 规则 10 的表一致）。
 * 实测有稿子把这一段写到 779 词 / 约 1250 汉字，六段预算被这一段一个人吃光。
 */
const DETAILED_SOFT_LIMIT_ZH = 600;
const DETAILED_SOFT_LIMIT_WORDS = 800;

/**
 * 「正在说话但没有声音」——官方 §4.4 只给了闭唇一种不说话的写法
 * （*She closes her lips and guards the cookie.*）。
 * 写成「嘴唇张合」「无声地动嘴」这类描述，正文里又没有 `<d>`，
 * 模型只会自己配一段听不懂的人声（客户实测反馈的「听不懂的旁白」）。
 *
 * 🔴 2026-10-30 实测漏网：写手写「双唇随一次呼吸轻轻分开又合上」，回译成
 *    *her lips parting and closing lightly with a breath* —— 旧正则一条都没抓到，
 *    两份稿子（直出 / 宫格）都这么写，说明是**系统性**写法 ⇒ 凡是「开→合」的唇部循环都算。
 *    只要求出现**循环**（分开／张开 … 合上／闭上），单写「张开嘴笑」这种不判。
 *
 * 🔴 2026-10-30 修正误报：「双唇闭合，没有出声」是**闭唇动作**（本仓规则原文：
 *    没有发声事件的镜头「嘴部只写不发声的动作」），旧正则的「…没有声音」分支只看
 *    唇部词 + 否定，把闭唇句一起判红 ⇒ 每份写上这句的稿子都白跑一轮自动修复
 *    （实测把「双唇闭合，没有出声」硬改成「双唇紧闭」）。现在该分支要求中间**真的**
 *    出现开口／动唇动词；「嘴巴张开却没有声音」「嘴一张一合，没有声音」照样命中。
 */
const SILENT_MOUTH_ZH =
  /张合|开合|无声地|(?:嘴|双唇|嘴唇|唇角?)[^。；\n]{0,12}(?:张开|微张|半张|分开|翕动|张动|一张一合|开合)[^。；\n]{0,12}(?:没有|未)(?:发出)?(?:任何)?(?:声音|出声)|(?:嘴|双唇|嘴唇|唇角?)[^。；\n]{0,10}(?:分开|张开|开启)[^。；\n]{0,10}(?:合上|合拢|合起来|闭上|抿住)/;
const SILENT_MOUTH_EN =
  /lips? open(?:s|ing)? and clos(?:e|es|ing)|mouth (?:continuing to |still )?open(?:s|ing)? (?:and clos(?:e|ing)|wider)|(?:lips?|mouth)[^.;]{0,30}\b(?:part|open)(?:s|ing|ed)?\b[^.;]{0,20}no sound comes out|(?:lips?|mouth)[^.;]{0,30}\b(?:part|open)(?:s|ing|ed)?\b[^.;]{0,20}\b(?:and|then)\b[^.;]{0,20}\b(?:clos|shut)/i;

/**
 * 汉字数 —— 中文正文的预算单位。
 *
 * 🔴 与 Rust `prompt_repair.rs::cjk_count`（`is_cjk`：U+3400–U+4DBF / U+4E00–U+9FFF）同口径：
 *    前端是最终裁判，两边量法差一点，就会出现「Rust 说压进了、前端说还超」的死循环。
 */
function countCjk(text: string): number {
  return (text.match(/[㐀-䶿一-鿿]/g) ?? []).length;
}

/**
 * 只在**没有 `<d>` 的行**上判「无声的嘴」。
 *
 * 有台词的行本来就要写口型（官方 `his mouth movements naturally syncing to the new dialogue`），
 * 对整篇无差别扫会把正常台词镜判红。
 */
function lineHasSilentMouth(text: string, re: RegExp): boolean {
  return text.split('\n').some((line) => {
    if (line.includes('<d>')) return false;
    if (/syncing to the new dialogue/i.test(line)) return false;
    return re.test(line);
  });
}

const VOICEOVER_TRIGGERS = ['says in an off-screen voiceover', '-voice-over'];

/**
 * 这一行的画外音**需不需要**闭唇句。
 *
 * 🔴 官方 §4.4 原文：「Immediately after every voiceover `<d>` block, state that the
 *    **corresponding on-screen character**'s lips remain closed.」—— 要求只落在
 *    **说话人本人在画框里**的情况（范例：*The man (S1) says in an off-screen voiceover:
 *    … while his lips remain completely closed.*）。说话人不在画框里（画外旁白／空镜），
 *    就没有「对应的画内人物」，不写闭唇句、也不许为此凭空造人。
 *
 * 🔴 2026-10-30 实测（R11）：旧判据 `/<Subject\s*\d/` 把**说话人自己**（写成
 *    `<Subject 1> (S1) off-screen says in an off-screen voiceover`）也算成「画框里有主体」，
 *    于是一份**完全正确**的空镜旁白被判 `voiceoverLips` error；修复链又修不动
 *    ⇒ `repairState='failed'` 静默失败，用户拿到的仍是原稿（它本来就对）。
 *    同族误判还有 `<Subject 3>`（窗户／走廊这类**景物主体**）被当成「画内人物」。
 *
 * ⇒ 判据改成「**触发短语前面那个说话人**有没有被标 `off-screen`」：
 *    - 触发短语前没有 `<Subject N>` —— 纯旁白，无要求；
 *    - 说话人后面到触发短语之间出现 `off-screen` —— 说话人不在画框里，无要求；
 *    - 其余 —— 说话人在画框里，必须有闭唇句。
 */
function voiceoverNeedsClosedLips(line: string): boolean {
  const hits = VOICEOVER_TRIGGERS.map((t) => line.indexOf(t)).filter((i) => i >= 0);
  if (hits.length === 0) return false;
  const prefix = line.slice(0, Math.min(...hits));
  const re = /<Subject\s*\d+>/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefix))) last = m;
  if (!last) return false;
  const between = prefix.slice(last.index + last[0].length);
  // `off-screen` / `off screen` / `offscreen` 都算（写手三种都写过）
  return !/off[-\s]?screen/i.test(between);
}
/**
 * 画外音行的合法收尾（官方 §4.4）：`while his/her/its lips remain completely closed`。
 * 画框里没人（空镜）⇒ 官方闭唇句没有指代对象，**不写**（判据见下方第 5 条）。
 * 后面 "no person …" 一类匹配是**旧口径遗留**，只为兼容老会话保留。
 */
const CLOSED_LIPS =
  /lips? remain completely closed|no person (?:is )?in (?:this )?(?:shot|frame)|no one can open a mouth|no person in frame/i;

/**
 * 官方 §5.4 逐字："When the subject speaks, write `<Subject N> (Sx)`."
 * `(Sx)` 是**说话人描述的一部分**，必须紧贴在说话人后面；
 * 单独挂在逗号后面的 `说，(S1)` 不是官方形式（`(Sx)` 会失去指代对象）。
 * ⇒ 只认「前一个非空字符不是逗号/分号/冒号/顿号」的 `(Sx)`。
 */
function hasAttachedSpeakerId(line: string): boolean {
  const re = /\((S\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const before = line.slice(0, m.index).replace(/\s+$/, '');
    const prev = before.slice(-1);
    if (prev && !/[,;:，；：、（(]/.test(prev)) return true;
  }
  return false;
}

/**
 * 官方原文里出现过的**全部**景别写法（`a medium-wide shot` / `a medium shot` /
 * `a close shot` / `a close-up` / `an extreme close-up`）。
 * 官方原文里没有的景别字面量（`a full shot` / `a wide shot` / `a medium close-up` …）
 * 一律不许写 —— 与 `SKILL.md` 的「官方原文里没有的英文一律不许写」同口径。
 */
const SHOT_SIZE_ZH = /(?:远景|全景|中景|近景|特写)/;
const SHOT_SIZE_EN_OFFICIAL =
  /a medium-wide shot|a medium shot|a close shot|a close-up|an extreme close-up/gi;
/** 官方原文里没有的景别字面量（`SKILL.md` 明确点名的那几个 + 同族写法）。 */
const SHOT_SIZE_EN_OFFICIAL_ONLY =
  /\ba (?:full|wide|long|medium long) shot\b|\ban extreme wide shot\b|\ba medium close-?up\b|\ban extreme close shot\b/gi;

/**
 * 正文里的景别是不是官方写法。
 *
 * - 中文正文：景别必须**直接写官方英文原词**，不许出现中文景别（写手规则已有，
 *   这里做机械校验 —— 中文景别回译时无官方字面量可映射，会被译丢或译成表外词）；
 * - 英文正文：不许出现官方原文里没有的景别字面量。
 */
function hasOffVocabularyShotSize(text: string): boolean {
  if (looksChineseWritten(text)) return SHOT_SIZE_ZH.test(text);
  const stripped = text.replace(SHOT_SIZE_EN_OFFICIAL, ' ');
  SHOT_SIZE_EN_OFFICIAL_ONLY.lastIndex = 0;
  return SHOT_SIZE_EN_OFFICIAL_ONLY.test(stripped);
}

/** 单条景别匹配（不带 `g`，`test()` 无状态；官方 5 个字面量）。 */
const SHOT_SIZE_LITERAL = /a medium-wide shot|a medium shot|a close shot|a close-up|an extreme close-up/i;

/**
 * 把 `detailed_description` 段按 `[Shot N]` 切成**逐镜块**（不含标记本身）。
 */
function shotBlocks(detailed: string): string[] {
  const parts = detailed.split(/\[Shot \d+\]/);
  return parts.length > 1 ? parts.slice(1) : [];
}

/**
 * 同一镜里「画内开口」与「画外旁白」是否落在**同一个说话人**身上。
 *
 * 🔴 出处：官方 §4.4 —— 画外音的说话人「lips remain completely closed」，
 *    而 §5.4 / §4.4 的画内台词要求 *mouth movements naturally syncing to the new dialogue*。
 *    同一个人在同一镜里两条都要 = 自相矛盾的指令，模型只剩「张嘴」一条路 ——
 *    这正是客户反馈「旁白一直有听不懂的旁白」的成因（2026-10-30 R9 实测）。
 *
 * 判据刻意**只认同一个 `(Sx)`**：同一镜里 A 画内说话、B 画外旁白不矛盾，不判。
 * `(Sx)` 缺失的情况交给第 4 条 `speakerId`，这里不重复报。
 */
const DIALOGUE_SPAN = /<d>[\s\S]*?<\/d>/g;
function speakerModesInShot(block: string): { onCamera: Set<string>; voiceover: Set<string> } {
  const onCamera = new Set<string>();
  const voiceover = new Set<string>();
  DIALOGUE_SPAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIALOGUE_SPAN.exec(block))) {
    const before = block.slice(Math.max(0, m.index - 200), m.index);
    const ids = [...before.matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/g)].map((x) => x[1].replace(/\s+/g, ''));
    const id = ids.length > 0 ? ids[ids.length - 1] : '';
    if (!id) continue;
    if (VOICEOVER_TRIGGERS.some((t) => before.includes(t))) voiceover.add(id);
    else onCamera.add(id);
  }
  return { onCamera, voiceover };
}

export type PromptIssueCode =
  | 'fields'
  | 'shots'
  | 'dialoguePairs'
  | 'speakerId'
  | 'voiceoverLips'
  | 'audioTag'
  | 'summaryTag'
  | 'tooLong'
  | 'detailedTooLong'
  | 'silentMouth'
  | 'shotSize'
  | 'shotSizeMissing'
  | 'sameShotSplit';

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
      if (line.includes('<d>') && !hasAttachedSpeakerId(line)) {
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

  // 5. 画外音必须配闭唇句（官方 §4.4；只在**说话人在画框里**时成立，见 voiceoverNeedsClosedLips）
  {
    let bad = 0;
    for (const line of text.split('\n')) {
      if (voiceoverNeedsClosedLips(line) && !CLOSED_LIPS.test(line)) bad += 1;
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
  // 中文正文按 1000 **汉字**判，英文（老会话 / 回译产物）按 6200 **字符**判。
  // 🔴 预算换单位，量法必须跟着换：中文若还拿 `text.length` 去比 1000，
  //    一条 1000 汉字 / 2100 字符的合规正文会被判超长、白跑一轮校正。
  {
    const isZh = looksChineseWritten(text);
    const bodyLen = isZh ? countCjk(text) : text.length;
    const bodyLimit = isZh ? BODY_SOFT_LIMIT_ZH : BODY_SOFT_LIMIT;
    if (bodyLen > bodyLimit) {
      issues.push({
        code: 'tooLong',
        level: 'error',
        hidden: true,
        params: { len: bodyLen, limit: bodyLimit, unit: isZh ? 'Chinese characters' : 'characters' },
      });
    }
  }

  // 9. `detailed_description` 单段预算（官方 §5.2：normally 350-500 English words）
  {
    const isZh = looksChineseWritten(text);
    const len = isZh
      ? countCjk(detailed)
      : (detailed.match(/[A-Za-z0-9'’-]+/g) ?? []).length;
    const limit = isZh ? DETAILED_SOFT_LIMIT_ZH : DETAILED_SOFT_LIMIT_WORDS;
    if (detailed && len > limit) {
      issues.push({
        code: 'detailedTooLong',
        level: 'error',
        hidden: true,
        params: { len, limit },
      });
    }
  }

  // 10. 没有台词的嘴只许写「闭唇」：禁「张合／无声地动嘴／开合循环」
  {
    const silent = looksChineseWritten(text)
      ? lineHasSilentMouth(text, SILENT_MOUTH_ZH)
      : lineHasSilentMouth(text, SILENT_MOUTH_EN);
    if (silent) {
      issues.push({ code: 'silentMouth', level: 'error', hidden: true });
    }
  }

  // 11. 景别只许用官方 5 个字面量（写手漏了这条：中文「跟拍全景」回译时无字面量可映射，
  //     要么被译丢、要么译成 `a full shot` 这类官方没有的写法）
  if (hasOffVocabularyShotSize(text)) {
    issues.push({ code: 'shotSize', level: 'error', hidden: true });
  }

  // 12. **每一镜都必须交代景别**（官方 §5.3 "For each shot, clearly establish the current
  //     composition…"；官方全部范例的每一镜都以景别开头）。
  //     🔴 与第 11 项互补：第 11 项查「写了但词不对」，这一项查「压根没写」。
  //     2026-10-30 R7 实测：`[Shot 3] At 00:05.000, the shot cuts to <Subject 3> 的绷带表面…`
  //     整镜没有景别，第 11 项判 ok、直接放行。
  {
    const missing = shotBlocks(detailed)
      .map((b, i) => (SHOT_SIZE_LITERAL.test(b) ? 0 : i + 1))
      .filter((n) => n > 0);
    if (missing.length > 0) {
      issues.push({
        code: 'shotSizeMissing',
        level: 'error',
        hidden: true,
        params: { shots: missing.join(',') },
      });
    }
  }

  // 13. 同一镜内，同一个说话人不许既画内开口、又画外旁白（见 speakerModesInShot 的出处说明）
  {
    const mixed: number[] = [];
    shotBlocks(detailed).forEach((block, i) => {
      const { onCamera, voiceover } = speakerModesInShot(block);
      for (const id of voiceover) {
        if (onCamera.has(id)) {
          mixed.push(i + 1);
          break;
        }
      }
    });
    if (mixed.length > 0) {
      issues.push({
        code: 'sameShotSplit',
        level: 'error',
        hidden: true,
        params: { shots: mixed.join(',') },
      });
    }
  }

  const level: PromptShapeReport['level'] = issues.some((i) => i.level === 'error')
    ? 'error'
    : issues.length > 0
      ? 'warn'
      : 'ok';

  return { level, issues };
}
