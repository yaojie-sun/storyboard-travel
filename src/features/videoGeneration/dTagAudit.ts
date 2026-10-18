/**
 * `<d>` 出站审计 —— 提交视频模型前的最后一道闸。
 *
 * 背景：客户长期听到「多出来一段听不懂的人声」。根因是 `<d>` 里混进了非台词内容
 * （标签、说话人编号、时间戳、括号注释……），视频模型会把它们当成台词念出来。
 * 官方 §4.4 逐字：
 *   Inside `<d>`, include only the language tag and the actual user-provided spoken content.
 *
 * 用户脚本格式千变万化，没法拿输入原文逐字比对 —— 所以这里**只看 `<d>` 本身**：
 * 标签内除「语言标签 + 要说出的台词」外，多一个字符都算违规。
 *
 * 处置分两级：
 *   - 确定性垃圾（标签 / `(Sx)` / 时间戳 / `[Shot N]` / 短括号注释）→ 就地修正：
 *     该挪到 `<d>` 外的挪出去，该删的删掉。删除只针对**不可能被念出来**的字符。
 *   - 可疑内容（空 `<d>`、缺语言标签、长括号、角色名前缀、`<d>` 写在声音两段里）→ 只报告不改写。
 *
 * 本模块是纯函数，不读 store、不发请求，便于单测与复用。
 */

export type DTagIssueKind =
  | 'unclosed'
  | 'nested'
  | 'empty'
  | 'no-language-tag'
  | 'brackets'
  | 'parentheses'
  | 'speaker-prefix'
  | 'leaked-instruction'
  | 'outside-detailed-description';

export type DTagFixKind =
  | 'relocate-scenetrans'
  | 'relocate-subject'
  | 'relocate-speaker-id'
  | 'remove-audio'
  | 'remove-shot-marker'
  | 'remove-timestamp'
  | 'remove-annotation';

export interface DTagIssue {
  kind: DTagIssueKind;
  /** 出问题的片段（截断到 60 字），便于对照 */
  excerpt: string;
  detail: string;
}

export interface DTagFix {
  kind: DTagFixKind;
  /** 被挪走 / 删掉的原字符 */
  removed: string;
  excerpt: string;
}

export interface DTagAuditResult {
  /** 修正后的文本；无违规时与输入逐字相同 */
  text: string;
  fixes: DTagFix[];
  issues: DTagIssue[];
  /** 文本里 `<d>` 的个数 */
  dCount: number;
}

const SECTION_NAMES = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const;

const D_BLOCK = /<d>([\s\S]*?)<\/d>/g;
/** 官方语言标签，如 `[Chinese]` / `[English]`（也容忍 `[Chinese Mandarin]`） */
const LANGUAGE_TAG = /^\s*\[[A-Za-z][A-Za-z0-9 ,\-/]*\]\s*/;
/** 任何行内标签：`<scenetrans>` / `<cutoff>` / `<Subject 1>` / `<Picture 2>` / `<Audio 1>` */
const INLINE_TAG = /<([A-Za-z][A-Za-z]*)(?:\s+\d+)?\s*>/g;
const SPEAKER_ID = /[（(]\s*S\d+(?:\s*[,，、]\s*S\d+)*\s*[）)]/g;
const SHOT_MARKER = /\[\s*(?:Shot|Audio|Picture|Image)\s*\d+\s*\]/gi;
const TIMESTAMP = /\b\d{1,2}:\d{2}\.\d{3}\b/g;
/** 短括号注释：`（低声）`、`(pause)` —— 台词里出现括号，按规则一律属于注释 */
const SHORT_ANNOTATION = /[（(][^（）()<>]{1,12}[）)]/g;
const LEAKED_INSTRUCTION = /\b(off-screen|voiceover|lips remain|continues seamlessly|carries over)\b/i;
/** 角色名前缀：`张三：你好` / `旁白: 今天……` */
const SPEAKER_PREFIX = /^[^\s，。！？、,.!?：:]{1,10}[：:]/;
const ONLY_PUNCTUATION = /^[\s，。！？、,.!?…；;:"'“”‘’「」『』\-—~～]+$/;

function clip(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 只在前面 40 字内没有同一样东西时才挪过去，避免重复 */
function appearsJustBefore(text: string, index: number, needle: string): boolean {
  return text.slice(Math.max(0, index - 40), index).includes(needle);
}

/** 找出每个位置所属的六段段名（不在任何段内返回 null） */
function buildSectionIndex(text: string): Array<{ at: number; name: string }> {
  const marks: Array<{ at: number; name: string }> = [];
  const header = new RegExp(`^(${SECTION_NAMES.join('|')})\\s*:`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = header.exec(text))) marks.push({ at: m.index, name: m[1] });
  return marks;
}

function sectionAt(marks: Array<{ at: number; name: string }>, index: number): string | null {
  let name: string | null = null;
  for (const mark of marks) {
    if (mark.at > index) break;
    name = mark.name;
  }
  return name;
}

/**
 * 全文扫描 `<d>…</d>`，修正确定性垃圾，报告可疑内容。
 * 输入里的其它部分逐字不动。
 */
export function auditAndFixDTags(input: string): DTagAuditResult {
  const fixes: DTagFix[] = [];
  const issues: DTagIssue[] = [];
  if (!input || !input.includes('<d>')) {
    return { text: input, fixes, issues, dCount: 0 };
  }

  const openCount = (input.match(/<d>/g) ?? []).length;
  const closeCount = (input.match(/<\/d>/g) ?? []).length;
  if (openCount !== closeCount) {
    issues.push({
      kind: 'unclosed',
      excerpt: '',
      detail: `<d> ${openCount} 个、</d> ${closeCount} 个，标签不成对`,
    });
  }

  const sectionMarks = buildSectionIndex(input);

  const text = input.replace(D_BLOCK, (_whole: string, body: string, offset: number) => {
    const excerpt = clip(body);
    const section = sectionAt(sectionMarks, offset);
    if (section && section !== 'detailed_description') {
      issues.push({
        kind: 'outside-detailed-description',
        excerpt,
        detail: `台词块出现在 ${section} 段（台词只属于 detailed_description）`,
      });
    }
    if (body.includes('<d>')) {
      issues.push({ kind: 'nested', excerpt, detail: '<d> 内又出现 <d>' });
    }

    if (!LANGUAGE_TAG.test(body)) {
      issues.push({ kind: 'no-language-tag', excerpt, detail: '缺少官方语言标签，如 <d>[Chinese] …</d>' });
    }

    let inline = body;
    const relocateBefore: string[] = [];
    const relocateAfter: string[] = [];

    // ① 行内标签
    inline = inline.replace(INLINE_TAG, (tag: string, name: string) => {
      const lower = name.toLowerCase();
      if (lower === 'd') return tag; // 嵌套的 <d> 由上面的 nested 报告接管，不在这里删
      if (lower === 'scenetrans' || lower === 'cutoff') {
        if (!relocateAfter.includes(tag)) relocateAfter.push(tag);
        fixes.push({ kind: 'relocate-scenetrans', removed: tag, excerpt });
        return '';
      }
      if (lower === 'subject' || lower === 'picture') {
        if (!appearsJustBefore(input, offset, tag) && !relocateBefore.includes(tag)) relocateBefore.push(tag);
        fixes.push({ kind: 'relocate-subject', removed: tag, excerpt });
        return '';
      }
      if (lower === 'audio') {
        fixes.push({ kind: 'remove-audio', removed: tag, excerpt });
        return '';
      }
      fixes.push({ kind: 'remove-shot-marker', removed: tag, excerpt });
      return '';
    });

    // ② 说话人编号 (S1) / (S1,S2)
    inline = inline.replace(SPEAKER_ID, (id: string) => {
      if (!appearsJustBefore(input, offset, id) && !relocateBefore.includes(id)) relocateBefore.push(id);
      fixes.push({ kind: 'relocate-speaker-id', removed: id, excerpt });
      return '';
    });

    // ③ 镜头/音频标记与时间戳
    inline = inline.replace(SHOT_MARKER, (m: string) => {
      fixes.push({ kind: 'remove-shot-marker', removed: m, excerpt });
      return '';
    });
    inline = inline.replace(TIMESTAMP, (m: string) => {
      fixes.push({ kind: 'remove-timestamp', removed: m, excerpt });
      return '';
    });

    // ④ 短括号注释
    inline = inline.replace(SHORT_ANNOTATION, (m: string) => {
      fixes.push({ kind: 'remove-annotation', removed: m, excerpt });
      return '';
    });

    // ⑤ 修正后再体检（只报告，不改写）
    const core = inline.replace(LANGUAGE_TAG, '').trim();
    if (!core || ONLY_PUNCTUATION.test(core)) {
      issues.push({ kind: 'empty', excerpt, detail: '<d> 里没有可念的台词' });
    }
    if (/[[\]]/.test(core)) {
      issues.push({ kind: 'brackets', excerpt, detail: '<d> 内还有方括号内容（只允许语言标签与 [unclear]）' });
    }
    if (/[（(]/.test(core)) {
      issues.push({ kind: 'parentheses', excerpt, detail: '<d> 内还有括号注释（应写在 <d> 外）' });
    }
    if (LEAKED_INSTRUCTION.test(core)) {
      issues.push({ kind: 'leaked-instruction', excerpt, detail: '<d> 内出现画外音/镜头指令英文' });
    }
    if (SPEAKER_PREFIX.test(core)) {
      issues.push({ kind: 'speaker-prefix', excerpt, detail: '<d> 内出现「角色名：」前缀（角色名属于 <d> 外）' });
    }

    const before = relocateBefore.length ? `${relocateBefore.join(' ')} ` : '';
    const after = relocateAfter.length ? ` ${relocateAfter.join(' ')}` : '';
    return `${before}<d>${inline.trimStart()}</d>${after}`;
  });

  return { text, fixes, issues, dCount: openCount };
}

/** 日志用的一行摘要 */
export function summarizeDTagAudit(result: DTagAuditResult): string {
  if (!result.fixes.length && !result.issues.length) return `[dTagAudit] ${result.dCount} 个台词块，全部纯净`;
  const f = result.fixes.map((x) => x.kind).join(',') || '-';
  const i = result.issues.map((x) => x.kind).join(',') || '-';
  return `[dTagAudit] ${result.dCount} 个台词块；修正 ${result.fixes.length} 处(${f})；报告 ${result.issues.length} 处(${i})`;
}

const AUDIT_LOG_KEY = 'dTagAudit:log';
const AUDIT_LOG_LIMIT = 20;

/**
 * 把最近一次审计结果留在本机（localStorage 环形缓冲），供事后取证。
 * 只存摘要，不存整段提示词。
 */
export function rememberDTagAudit(result: DTagAuditResult): void {
  if (!result.fixes.length && !result.issues.length) return;
  try {
    const raw = window.localStorage.getItem(AUDIT_LOG_KEY);
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    list.unshift({
      at: new Date().toISOString(),
      dCount: result.dCount,
      fixes: result.fixes.map((x) => ({ kind: x.kind, removed: x.removed, excerpt: x.excerpt })),
      issues: result.issues,
    });
    window.localStorage.setItem(AUDIT_LOG_KEY, JSON.stringify(list.slice(0, AUDIT_LOG_LIMIT)));
  } catch {
    /* 存不进就算了，审计本身不能影响提交 */
  }
}
