/**
 * 宫格路的「参考图号」兜底（纯函数，无副作用、无 store 依赖，便于单测）。
 *
 * ## 为什么需要它
 *
 * 宫格路**只上传一张**图 —— 那张 2×3 六宫格故事板合并图。但写手是自由生成的，
 * 实测会出现两种漂移（同一份 SKILL.md、同样的输入，跑十次能出三种写法）：
 *
 *   1. **凭空多出图片号**：`<Subject 1> 是 <Picture 4> 里的主持人`、
 *      `<Picture 1>、<Picture 2> 锁定舞台形制` —— 正文说「有 4 张图」，
 *      而实际只挂了一张。视频模型于是去找第 2/3/4 张参考图，找不到就自己编，
 *      用户看到的症状是「H3 没读到宫格故事板」。
 *   2. **漏掉官方的故事板声明**：官方 §2.2 要求
 *      *When an image acts as a storyboard or shot-planning reference,
 *      state which shots it maps to and what planning information it provides*，
 *      范例是 `<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2],
 *      defining their viewpoint, subject placement, and shot order.`。
 *      写手偶尔写成自造角色（「空间与构图基准」），或者干脆不写。
 *
 * 本模块把这两件事**确定性**修掉：图号一律收敛到 `<Picture 1>`，
 * 并在 `subject_definitions` 里保证有一条**逐字照官方范例**的故事板声明，
 * 同时保证 `retention_analysis` 里有对应的图片条目（官方 §4.1：
 * *Use one line for each reference label*）。
 *
 * 🔴 **只改宫格路**：调用方（`chatStore.parsePromptBlocks` /
 *    `updatePromptBlock`）只在消息里存在 grid 块时才调用它。
 *    直出路的 `<Picture 1..N>` 是**真的 N 张图**，一个字都不许动。
 *
 * 🔴 **幂等**：已是合规写法（声明逐字、图号全为 1、retention 有图片条目）的正文
 *    跑完本函数**逐字不变** —— 它是兜底，不是第二套改写器。
 */

const FIELD_NAMES = [
  'subject_definitions:',
  'summary:',
  'retention_analysis:',
  'detailed_description:',
  'overall_soundscape:',
  'non_diegetic_music:',
];

const PICTURE_TAG_RE = /<\s*Picture\s*\d+\s*>/g;
const STANDALONE_PICTURE_RE = /^<\s*Picture\s*\d+\s*>/;
const SHOT_TAG_RE = /\[\s*Shot\s*(\d+)\s*\]/g;

/** 官方 §2.2 故事板声明里那句不可改写的英文标记。 */
const STORYBOARD_MARK = 'is a storyboard reference';

/** 把 `[1,2,3]` 写成官方范例的镜号串：`[Shot 1], [Shot 2] and [Shot 3]`。 */
function joinShotList(shots: number[]): string {
  const list = shots.map((n) => `[Shot ${n}]`);
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * 官方 §2.2 的故事板声明句（范例逐字形态，镜号按本段真实镜数填）。
 *
 * 冠词与物主代词**一个字都不许换**：官方范例是 `is a storyboard reference`、
 * `defining their viewpoint` —— 写成 `is the storyboard reference` /
 * `defining the viewpoint` 就是自造写法。
 */
export function buildGridStoryboardLine(shots: number[]): string {
  return (
    `<Picture 1> ${STORYBOARD_MARK} for ${joinShotList(shots)}, ` +
    'defining their viewpoint, subject placement, and shot order.'
  );
}

/** 官方 §4.1 的图片条目模板：`<Picture 2> ([Shot 1] first frame): fully_preserved - ...`。 */
export function buildGridPictureRetentionLine(): string {
  return (
    '<Picture 1> ([Shot 1] storyboard reference): fully_preserved - ' +
    '镜头的视点、主体站位与镜头顺序按故事板执行。'
  );
}

interface SectionRange {
  /** 段名所在行号。 */
  start: number;
  /** 下一段的段名行号（不含）；没有下一段时为 lines.length。 */
  end: number;
}

/** 段名行的归一化：去掉加粗/标题记号，便于比较（正文里可能是 `**summary:**`）。 */
function fieldOf(line: string): string | null {
  const t = line.trim().replace(/^[*#\s]+/, '').toLowerCase();
  const hit = FIELD_NAMES.find((f) => t.startsWith(f));
  return hit ?? null;
}

function findSection(lines: string[], field: string): SectionRange | null {
  const start = lines.findIndex((l) => fieldOf(l) === field);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (fieldOf(lines[i]) && fieldOf(lines[i]) !== field) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 本段真实镜号（升序去重）。先看 `detailed_description`，取不到再全篇扫。 */
function collectShots(text: string, lines: string[]): number[] {
  const dd = findSection(lines, 'detailed_description:');
  const scope = dd ? lines.slice(dd.start + 1, dd.end).join('\n') : '';
  let nums = [...new Set([...scope.matchAll(SHOT_TAG_RE)].map((m) => Number(m[1])))];
  if (nums.length === 0) {
    nums = [...new Set([...text.matchAll(SHOT_TAG_RE)].map((m) => Number(m[1])))];
  }
  return nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

/**
 * 宫格正文兜底：图号收敛到 `<Picture 1>` + 保证官方故事板声明与它的 retention 条目。
 *
 * 取不到 `subject_definitions:` 段（正文不合规，交给形状检查去处理）时**只收敛图号**，
 * 不猜段落位置 —— fail-open，绝不制造第二处不合规。
 */
export function normalizeGridPictureRefs(body: string): string {
  if (!body || !body.includes('subject_definitions:')) {
    return body ? body.replace(PICTURE_TAG_RE, '<Picture 1>') : body;
  }

  // 1) 图号一律收敛到 1 —— 宫格路只有一张图。
  let text = body.replace(PICTURE_TAG_RE, '<Picture 1>');
  const lines = text.split('\n');

  const sd = findSection(lines, 'subject_definitions:');
  if (!sd) return text;

  const shots = collectShots(text, lines);
  const nextLines = lines.slice();
  // 写手回复是 CRLF，扣行时保留原行尾，别在合规正文里留下一处「只差一个 \r」的改写
  const eol = text.includes('\r\n') ? '\r' : '';

  if (shots.length > 0) {
    // 2) 故事板声明：`subject_definitions` 里**只留一条**单列的 `<Picture 1>` 行，
    //    且必须是官方范例逐字形态（写手写成自造角色 / 中文声明 / 漏写都要纠正）。
    const storyLine = buildGridStoryboardLine(shots);
    const picRows: number[] = [];
    for (let i = sd.start + 1; i < sd.end; i++) {
      if (STANDALONE_PICTURE_RE.test(nextLines[i].trim())) picRows.push(i);
    }
    if (picRows.length > 0) {
      nextLines[picRows[0]] = storyLine + eol;
      // 多余的「单列图片行」是幽灵图（宫格路只有一张图），一并去掉
      for (const i of picRows.slice(1).reverse()) nextLines.splice(i, 1);
    } else {
      nextLines.splice(sd.start + 1, 0, storyLine + eol);
    }

    // 3) retention_analysis 必须有这张图的条目（官方 §4.1「每个 reference label 一行」）
    const ra = findSection(nextLines, 'retention_analysis:');
    if (ra) {
      const hasPictureEntry = nextLines
        .slice(ra.start + 1, ra.end)
        .some((l) => STANDALONE_PICTURE_RE.test(l.trim()));
      if (!hasPictureEntry) {
        nextLines.splice(ra.start + 1, 0, buildGridPictureRetentionLine() + eol);
      }
    }
  }

  text = nextLines.join('\n');
  return text;
}
