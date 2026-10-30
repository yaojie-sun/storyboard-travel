import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * 提示词的中英双向翻译（用户看中文，模型吃英文）。
 *
 * - **英 → 中** `getPromptMirror`：老会话（正文是英文）的显示镜像，只给人看，
 *   一个字节都不回流到提交链路。
 * - **中 → 英** `translatePromptForSubmit`：写手现在出的是中文正文（2026-10-28 定调），
 *   用户在对话页/视频生成页改的也是中文，所以在点「生成视频」那一刻按官方规范
 *   回译成英文再交给视频模型。翻译规则是独立文件
 *   `src-tauri/src/commands/translate_rules/prompt_to_english.md`。
 *
 * 🔴 **中 → 英失败会挡住提交**（**不是**退回原文）：`VideoGenDialog` 拿到 `null` 就
 *    `setError` 后 return —— 提交流程在**扣费之前**就结束了。原因：视频模型只吃英文，
 *    把中文正文原样送去等于白扣一次费、出一支听不懂的片子。
 *    想改这条行为，先想清楚「中文原文能喂给视频模型吗」。
 * 🔴 **英 → 中失败只是没镜像**：`getPromptMirror` 拿不到中文就显示英文原文，不挡任何事。
 * 🔴 **不扣费**：两条都走不带 `billing_tag` 的网关调用。
 */

const FIELD_NAMES = [
  'subject_definitions:',
  'summary:',
  'retention_analysis:',
  'detailed_description:',
  'overall_soundscape:',
  'non_diegetic_music:',
];

/** 把 `open…close` 之间的内容（含定界符）抹成空格，避免跨段误判。 */
function maskSpans(text: string, open: string, close: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const i = rest.indexOf(open);
    if (i < 0) break;
    out += rest.slice(0, i);
    const after = rest.slice(i + open.length);
    const j = after.indexOf(close);
    if (j < 0) {
      out += rest.slice(i);
      return out;
    }
    const end = i + open.length + j + close.length;
    out += ' '.repeat(end - i);
    rest = rest.slice(end);
  }
  return out + rest;
}

function maskQuoted(text: string, quote: string): string {
  let out = '';
  let inside = false;
  for (const ch of text) {
    if (ch === quote) {
      inside = !inside;
      out += ' ';
      continue;
    }
    out += inside ? ' ' : ch;
  }
  return out;
}

const CJK = /[㐀-䶿一-鿿]/;

/**
 * 跳过空白、`<…>` `[…]` 这类前置标记与零星标点，取第一个「实义字符」。
 *
 * 例：`<Subject 1> 是本段的构图基准` ⇒ `是`（中文）；
 *     `<Picture 1> is the composition baseline` ⇒ `i`（英文）。
 */
function firstMeaningfulChar(s: string): string | null {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '<' || c === '[') {
      const j = s.indexOf(c === '<' ? '>' : ']', i);
      // 标记没闭合就当作正文（残缺正文交给结构校验去报）
      if (j < 0) return c;
      i = j + 1;
      continue;
    }
    if ('():,;-，。：'.includes(c)) {
      i += 1;
      continue;
    }
    return c;
  }
  return null;
}

/**
 * 判「这份正文本身是不是中文写的」。
 *
 * 🔴 必须先屏蔽 `<d>…</d>`：官方英文正文**必然**含 `<d>[Chinese] 台词</d>`，
 * 直接问「含不含中文」会把每一单都判成中文、于是永远不翻译。
 * 也不能只靠「中文占比」—— 英文正文里那句中文口型句会把它抬高，所以先用结构性判据：
 * 六段字段名后面**第一个实义字符**是不是中文。判不出来再退回占比。
 *
 * 🔴 「第一个实义字符」要**先跳过前置标记**：中文正文的真实形态是
 * `<Subject 1> 是……` / `[reference generation] 目标……`，头一个字永远是 `<` 或 `[`，
 * 不跳过就一个字段都判不中、中文正文被当成英文（2026-10-28 实测踩过）。
 */
export function looksChineseWritten(text: string): boolean {
  const body = maskQuoted(maskSpans(text, '<d>', '</d>'), '"');

  let hits = 0;
  let seen = 0;
  for (const field of FIELD_NAMES) {
    const idx = body.indexOf(field);
    if (idx < 0) continue;
    seen += 1;
    const first = firstMeaningfulChar(body.slice(idx + field.length));
    if (first && CJK.test(first)) hits += 1;
  }
  if (seen >= 3) return hits >= Math.ceil(seen * 0.6);

  let cjk = 0;
  let latin = 0;
  for (const ch of body) {
    if (CJK.test(ch)) cjk += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  return cjk + latin > 0 && cjk / (cjk + latin) >= 0.5;
}

/**
 * 内容指纹：同一份英文只翻一次。
 *
 * 同时用于「这份镜像是不是过期了」—— 存进 `PromptBlock.contentZhFrom` 里，
 * 和当前 `content` 一比就知道要不要重翻。
 */
export function promptFingerprint(text: string): string {
  const body = (text || '').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${body.length.toString(36)}-${h1.toString(36)}-${h2.toString(36)}`;
}

/**
 * 失败冷却：翻译失败（网络抖动/网关 5xx）的指纹在 5 分钟内不再自动重试，
 * 否则每次切对话/重渲染都会再打一次网关。
 */
const FAILURE_TTL_MS = 5 * 60 * 1000;
const failures = new Map<string, { at: number; reason: string }>();

/** 🔴 串行队列：同时翻多份提示词会互相抢占网关配额，也让失败重试更难定位。 */
let displayQueue: Promise<unknown> = Promise.resolve();

/** 进程内缓存（不落盘 —— 中文镜像不是用户数据，丢了再翻一次即可）。 */
const displayCache = new Map<string, Promise<string>>();

export interface PromptMirrorResult {
  /** 中文镜像；取不到时为 null（调用方应显示英文原文） */
  zh: string | null;
  /** 取不到时给用户看的原因（为空表示没必要提示，例如正文本来就是中文） */
  reason: string | null;
}

/**
 * 取一份提示词的中文显示镜像。
 *
 * 失败不抛异常：中文对照是锦上添花，绝不能让提示词因此显示不出来。
 */
export function getPromptMirror(content: string): Promise<PromptMirrorResult> {
  const text = content.trim();
  if (!text) return Promise.resolve({ zh: null, reason: null });
  // 正文本来就是中文（老会话）⇒ 不需要镜像，也不该多花一次调用
  if (looksChineseWritten(text)) return Promise.resolve({ zh: text, reason: null });

  const key = promptFingerprint(text);
  const cached = displayCache.get(key);
  if (cached) {
    return cached.then(
      (zh) => ({ zh, reason: null }),
      (err) => ({ zh: null, reason: String(err) }),
    );
  }

  const recent = failures.get(key);
  if (recent && Date.now() - recent.at < FAILURE_TTL_MS) {
    return Promise.resolve({ zh: null, reason: recent.reason });
  }

  if (!isTauri()) {
    return Promise.resolve({ zh: null, reason: 'translation_unavailable' });
  }

  const task = displayQueue
    .catch(() => undefined)
    .then(() => invoke<string>('translate_prompt_to_zh', { prompt: text }));
  displayQueue = task.catch(() => undefined);

  // 失败不留在缓存里（但进失败冷却），否则一次网络抖动会让这份提示词永久没有中文
  const tracked = task.catch((err) => {
    displayCache.delete(key);
    failures.set(key, { at: Date.now(), reason: String(err) });
    throw err;
  });
  displayCache.set(key, tracked);

  return tracked.then(
    (zh) => ({ zh, reason: null }),
    (err) => ({ zh: null, reason: String(err) }),
  );
}

/** 清空缓存（切换账号/退出登录时调用，避免跨账号复用）。 */
export function clearPromptMirrorCache(): void {
  displayCache.clear();
  failures.clear();
  displayQueue = Promise.resolve();
}

/**
 * 提交前的**中 → 英回译**：用户在视频生成页确认的那段提示词是中文，
 * H3 只认英文，所以在点「生成视频」那一刻翻一次。
 *
 * - 正文本来就是英文（老会话 / 手写英文）⇒ 返回 `null`，调用方直接用原文；
 * - 中文 ⇒ 调 `translate_prompt_to_english`，同一份正文**只翻一次**（进程内缓存）；
 * - 翻不出来 ⇒ 返回 `null`，而 `VideoGenDialog` 会把 `null` 当成**提交失败**（拦截、不扣费），
 *   **不会**把中文原文直接送去出片 —— 视频模型只吃英文。
 *
 * 🔴 不扣费：后端不传 `billing_tag`（与结构校正、中文对照同一条路）。
 */
const backCache = new Map<string, Promise<string>>();
let backQueue: Promise<unknown> = Promise.resolve();

export function translatePromptForSubmit(content: string): Promise<string | null> {
  const text = (content || '').trim();
  if (!text) return Promise.resolve(null);
  // 已经是英文 ⇒ 不需要回译，返回 null 让调用方走原文（避免多一次网关调用）
  if (!looksChineseWritten(text)) return Promise.resolve(null);
  if (!isTauri()) return Promise.resolve(null);

  const key = promptFingerprint(text);
  const cached = backCache.get(key);
  if (cached) return cached.catch(() => null);

  const task = backQueue
    .catch(() => undefined)
    .then(() => invoke<string>('translate_prompt_to_english', { prompt: text }));
  backQueue = task.catch(() => undefined);

  // 失败不缓存（下次点生成还能再试一次）
  const tracked = task.catch((err) => {
    backCache.delete(key);
    throw err;
  });
  backCache.set(key, tracked);
  return tracked.catch(() => null);
}

/** 清空回译缓存（切换账号/退出登录时调用）。 */
export function clearPromptBackTranslationCache(): void {
  backCache.clear();
  backQueue = Promise.resolve();
}
