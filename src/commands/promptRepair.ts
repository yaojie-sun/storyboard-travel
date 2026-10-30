import { invoke, isTauri } from '@tauri-apps/api/core';
import type { PromptIssue } from '@/features/videoGeneration/promptShapeCheck';
import { promptFingerprint } from './translateDisplay';

/**
 * 结构自动校正（**不扣费**）。
 *
 * 写手是模型，六段结构、镜头编号、闭唇句、字数这些硬约束偶尔会漏；用户手改也可能改坏。
 * 所以这里在用户读之前自动修一版，修完还要过同一套结构校验。
 *
 * 🔴 **同一份正文只修一次，跨启动也不重修**（指纹记在 localStorage 里）。
 * 🔴 失败就是失败：返回 null，绝不返回「大概修好了」的半成品。
 */

/** 缺陷描述用英文交给模型 —— 它的指令是英文的，混中文容易让它顺手把正文也译了。 */
function describe(issue: PromptIssue): string {
  const p = issue.params ?? {};
  switch (issue.code) {
    case 'fields':
      return `Missing or out-of-order section field(s): ${p.missing ?? 'one of the six sections'}`;
    case 'shots':
      return `Shot markers are not consecutive: got ${p.got ?? '?'}`;
    case 'dialoguePairs':
      return `Unbalanced <d> tags: ${p.open ?? '?'} open / ${p.close ?? '?'} close`;
    case 'speakerId':
      return `Shot(s) ${p.shots ?? '?'} contain <d> but carry no speaker id attached to the speaker. Official §5.4: write \`<Subject N> (Sx)\` — the id sits directly after the speaker reference, as in \`<Subject 2> (S1) turns toward the woman and says, <d>[English] …</d>\`. When the speaker is not a defined subject, put the (Sx) directly after a stable voice description. Never leave a bare \`(S1)\` on its own after a comma or after the verb.`;
    case 'shotSize':
      return 'Shot sizes must use one of the five official literals — `a medium-wide shot` / `a medium shot` / `a close shot` / `a close-up` / `an extreme close-up` — written in English inside the sentence. The official examples never use any other shot-size wording. Replace the non-official wording (Chinese 全景/中景/近景/特写, or English `a full shot` / `a wide shot` / `a medium close-up`) with the closest of the five; keep every shot, its marker and its dialogue.';
    case 'voiceoverLips':
      return `${p.count ?? 1} voiceover line(s) are missing the closed-lips clause`;
    case 'audioTag':
      return 'The body references <Audio N>, but this task has reference images only. Remove the audio entry and describe the voice inside the body instead.';
    case 'summaryTag':
      return 'The line under summary: does not start with a bracketed task-type tag such as [reference generation]';
    case 'tooLong':
      return `The body is ${p.len ?? '?'} ${p.unit ?? 'characters'} but must be under ${p.limit ?? 6200}. Tighten the wording (merge redundant clauses, drop repeated adjectives) without dropping any shot, tag, retention marker or dialogue. Keep all six sections and the exact field names.`;
    case 'detailedTooLong':
      return `detailed_description is ${p.len ?? '?'} (characters in Chinese / words in English) but must be under ${p.limit ?? 800}. Compress each shot to the official example density: keep every shot marker, every reference label, every retention statement and every dialogue line; only remove redundant adjectives and repeated clauses.`;
    case 'silentMouth':
      return 'The body describes a mouth that keeps opening and closing while producing no sound (e.g. "lips open and close", "mouth opening and closing", 张合/开合/无声地). A shot without <d> must never describe a speaking mouth. Rewrite those sentences as closed-lip actions only (official wording: "She closes her lips and guards the cookie."). Do not add dialogue and do not remove the shot.';
    default:
      return String(issue.code);
  }
}

/**
 * 同一份正文**只自动修一次，永远**；按指纹（正文内容）记，不设过期。
 *
 * 🔴 **必须落盘**：这份记录原来是纯内存的，进程一退就清空 ⇒ 每次启动打开对话，
 *    凡是「修不动的」正文都会再打一次网关、再把「提示词需要自动校正，请稍候…」
 *    闪一遍。用户 2026-10-28 原话：「为什么每次启动，chat 都会出现这个？
 *    校正一次就可以了」「校正一次过了就 OK，为什么要持续校正？」
 *    ⇒ 校正过就是校正过，**不再重试**。正文一改指纹就变，那是一份新内容，才值得再校正一次。
 */
const ATTEMPT_STORAGE_KEY = 'promptRepair.attempted.v1';
/** 上限只做防膨胀，正常用户远用不到。 */
const MAX_ATTEMPTS = 300;

function loadAttempted(): Map<string, number> {
  try {
    const raw = localStorage.getItem(ATTEMPT_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(obj).filter(([, at]) => typeof at === 'number'));
  } catch {
    return new Map();
  }
}

/** 指纹 → 校正时间（时间只用于超量时决定先丢谁，不参与「要不要重试」的判断）。 */
const attempted: Map<string, number> = loadAttempted();

function saveAttempted(): void {
  try {
    // 超量就按时间丢最旧的
    if (attempted.size > MAX_ATTEMPTS) {
      const keep = Array.from(attempted.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_ATTEMPTS);
      attempted.clear();
      keep.forEach(([k, at]) => attempted.set(k, at));
    }
    localStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(Object.fromEntries(attempted)));
  } catch {
    /* 存不进去就退回内存行为，不影响校正本身 */
  }
}

/** 正在修的那一次。🔴 必须共享：React 严格模式会把 effect 跑两遍，
 *  第一遍发起校正、随即被 cleanup 取消，第二遍若只看 `attempted` 就会直接判失败 ——
 *  结果是**一次都没真修成，界面却每次都说修不了**（2026-10-28 dev 实测）。 */
const inflight = new Map<string, Promise<string | null>>();

/** 全局串行队列：同一时刻只允许一份正文在网关里修。 */
let repairQueue: Promise<unknown> = Promise.resolve();

/**
 * 这份正文是否已经校正过（含跨启动）—— 界面用它决定要不要亮「正在校正」。
 * 不先问一句就 setState('running')，即使随后立刻返回 null，也会闪一帧提示文案。
 */
export function hasAttemptedPromptRepair(content: string): boolean {
  return attempted.has(promptFingerprint(content));
}

export function resetPromptRepairAttempts(): void {
  attempted.clear();
  inflight.clear();
  repairQueue = Promise.resolve();
  try {
    localStorage.removeItem(ATTEMPT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 结构不合规时自动修一版。
 *
 * @returns 修好的正文；不需要修 / 修不了 / 不在 Tauri 里 都返回 null
 */
export async function repairPromptShape(
  content: string,
  issues: PromptIssue[],
): Promise<string | null> {
  if (!isTauri() || !content.trim() || issues.length === 0) return null;

  const key = promptFingerprint(content);
  // 已经在修 ⇒ 复用同一次请求（严格模式的第二遍调用走这里）
  const running = inflight.get(key);
  if (running) return running;
  // 这份正文已经校正过（含跨启动）⇒ 永远不再打网关
  if (attempted.has(key)) return null;

  // 环境类失败（没登录 / 网关 401·404 / 超时）不算「这份正文修不动」
  let environmentFailure = false;

  const task = (async (): Promise<string | null> => {
    try {
      // 🔴 串行排队：启动时可能一次要修好几份，并发打网关会直接 429
      //    （2026-10-28 实测：一个对话里多份旧正文同时校正，网关回「请求频率超限」）。
      await repairQueue.catch(() => undefined);
      const fixed = await invoke<string>('repair_prompt_shape', {
        prompt: content.trim(),
        issues: issues.map(describe).join('\n'),
      });
      const text = (fixed || '').trim();
      if (!text || text === content.trim()) return null;
      return text;
    } catch (err) {
      environmentFailure = isEnvironmentFailure(String(err));
      return null;
    }
  })();

  inflight.set(key, task);
  repairQueue = task.catch(() => undefined);
  try {
    return await task;
  } finally {
    inflight.delete(key);
    // 🔴 环境类失败**不记**：否则一次「启动时还没登录」的竞态就能把这份正文
    //    永久标记为已校正，从此再也修不了（2026-10-28 dev 实测到 get_user_api_key 404）。
    if (!environmentFailure) {
      attempted.set(key, Date.now());
      saveAttempted();
    }
  }
}

/**
 * 失败是不是「环境问题」而不是「正文修不动」。
 *
 * 只有后者才值得记成「已校正」；前者（没登录、网关 401/404、超时、限流）
 * 下次启动还有机会再试一次。
 */
function isEnvironmentFailure(message: string): boolean {
  const m = message.toLowerCase();
  return [
    'api密钥',
    'api key',
    'unauthorized',
    'forbidden',
    '401',
    '403',
    '404',
    '未登录',
    'timeout',
    'timed out',
    '超时',
    'network',
    'connection',
    'rate',
    '限流',
    'too many',
  ].some((k) => m.includes(k));
}
