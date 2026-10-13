/**
 * STEP 5 的**六列镜头表**解析 —— 「换源不换字段」里那个「源」。
 *
 * 🔴 全盘改用官方提示词系统后，写手不再输出我们的
 *    `【场景描述】` / `【人物设定】` / `【故事梗概】` 三个私有块，改出官方的
 *    **`# 标准镜头信息表`**（六列）。而下游（`StoryboardGenNodeData` 与
 *    `VideoGenDialog`）**仍然要求**这四个字段：
 *
 *      `sceneContext` / `storySynopsis` / `characterContext` / `shotFrameMap`
 *
 *    ⇒ 「换源不换字段」：**改的是数据从哪儿来，不是字段本身**。
 *      这条链路是 §12.4 的核心（Chat → 宫格节点 → 视频节点），断不得。
 *
 *       · `sceneContext`   ← 镜表的 `Reference Anchors (Spatial + Identity)` 列，按格落
 *       · `shotFrameMap`   ← 镜表的 `Shot ID & Duration` 列（**兜底**：写手仍会出
 *                            `【分镜映射】`，那条优先，见 `chatStore.parseShotFrameMap`）
 *       · `storySynopsis`  ← STEP 2 故事大纲那一条消息
 *       · `characterContext` ← STEP 3 角色清单那一条消息
 *
 * 🔴 **全部 fail open**：认不出就返回 `null`/`undefined`，调用方回落到旧路径，
 *    **绝不猜、绝不抛**。解析失败的表现是「这一轮少了场景锚点」，不是崩溃。
 */

/** 镜表一行（六列）。 */
export interface ShotTableRow {
  /** `S01` */
  shotId: string;
  /** 该镜时长（秒）。解析不出记 0 —— 排序/分组时按 0 处理，不当成 1。 */
  seconds: number;
  /** 这一列**原样保留**：它是跨单元连续性的主链，前端不改写、不截断。 */
  continuity: string;
  /** `Reference Anchors (Spatial + Identity)` 原文 —— 场景锚点的来源 */
  anchors: string;
  hookType: string;
  description: string;
  audio: string;
}

/** 表头六列的**判定关键词**（用小写包含匹配，不吃空格与全角差异）。 */
const COLUMN_HINTS: Array<[keyof ShotTableRow, string]> = [
  ['shotId', 'shot id & duration'],
  ['continuity', 'continuity handoff'],
  ['anchors', 'reference anchors'],
  ['hookType', 'hook type'],
  ['description', 'shot description'],
  ['audio', 'audio & dialogue'],
];

/** 把一行 markdown 表格拆成单元格（去掉首尾的空竖线）。 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // 不处理单元格内转义竖线 —— 官方表头/示例里没有。
  return trimmed.split('|').map((c) => c.trim());
}

/** `S01 / 3s`、`S03/2.5s`、`S02 / 3 秒` 都要认出来。 */
function parseSeconds(cell: string): number {
  const m = cell.match(/(\d+(?:\.\d+)?)\s*(?:s\b|秒)/i);
  if (m) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * 从一段 markdown 里取出六列镜头表。
 *
 * 认不出（没有表头 / 少于 2 行数据 / 列数对不上）⇒ 返回 `null`。
 */
export function parseShotTable(markdown: string): ShotTableRow[] | null {
  if (!markdown) return null;
  const lines = markdown.split('\n');
  // ① 找表头行：命中 >= 4 个列关键词的那一行
  let headerIdx = -1;
  let columnOf: Partial<Record<keyof ShotTableRow, number>> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) continue;
    const cells = splitRow(line).map((c) => c.toLowerCase());
    const mapping: Partial<Record<keyof ShotTableRow, number>> = {};
    for (const [key, hint] of COLUMN_HINTS) {
      const idx = cells.findIndex((c) => c.includes(hint));
      if (idx >= 0) mapping[key] = idx;
    }
    if (Object.keys(mapping).length >= 4) {
      headerIdx = i;
      columnOf = mapping;
      break;
    }
  }
  if (headerIdx < 0) return null;

  // ② 跳过分隔行（`|---|---|`），逐行取数据
  const rows: ShotTableRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) {
      // 表格结束后还有别的段：一旦已经读到过数据就停，否则继续找（表头与数据间不该有空行）
      if (rows.length > 0) break;
      continue;
    }
    const cells = splitRow(line);
    // 分隔行：全部单元格都是 `-`/`:` 组成
    if (cells.every((c) => /^[-:\s]*$/.test(c))) continue;
    if (cells.length < 4) continue;
    const at = (key: keyof ShotTableRow): string => {
      const idx = columnOf[key];
      return idx === undefined ? '' : (cells[idx] ?? '').trim();
    };
    const shotId = at('shotId');
    if (!shotId) continue;
    rows.push({
      shotId,
      seconds: parseSeconds(shotId),
      continuity: at('continuity'),
      anchors: at('anchors'),
      hookType: at('hookType'),
      description: at('description'),
      audio: at('audio'),
    });
  }
  return rows.length >= 2 ? rows : null;
}

/**
 * 把 1..`total` 分成 `parts` 份的**确定性真划分**（并集 = 1..total，交集 = 空）。
 *
 * 均分而非按时长加权：加权要让余数按小数部分补给谁变成一条隐规则、难复现；
 * 而格数与镜长的关系本来就是「同一段动作线在 6 个时刻上的取样」，均分与
 * 旧写手给的划分表在同一量级。⚠️ 要求 `parts <= total`。
 */
function partitionCounts(total: number, parts: number): number[] | null {
  if (parts <= 0 || parts > total) return null;
  const counts: number[] = [];
  for (let i = 0; i < parts; i++) {
    counts.push(Math.floor(((i + 1) * total) / parts) - Math.floor((i * total) / parts));
  }
  return counts;
}

/**
 * 镜表 → `sceneContext`（**逐格一份**，长度 = `frameCount`）。
 *
 * 每格拿到的是**它所属那一镜**的 `Reference Anchors` 原文（含具名地标与光位基线）。
 * 认不出返回 `undefined`（调用方回落）。
 */
export function toSceneContext(rows: ShotTableRow[], frameCount = 6): string[] | undefined {
  const counts = partitionCounts(frameCount, rows.length);
  if (!counts) return undefined;
  const perFrame: string[] = [];
  rows.forEach((row, i) => {
    for (let n = 0; n < counts[i]; n++) perFrame.push(row.anchors);
  });
  return perFrame.some((s) => s.trim()) ? perFrame : undefined;
}

/**
 * 镜表 → `shotFrameMap`（**兜底**，写手仍会出 `【分镜映射】`，那条优先）。
 *
 * `camera` 取镜表 `Shot Description` 的第一句（景别入画句在那句里），
 * `sound` 取 `Audio & Dialogue Track`。取不到就给空串 —— 下游对空串是安全的。
 */
export function toShotFrameMap(
  rows: ShotTableRow[],
  frameCount = 6,
): { shots: Array<{ shot: number; time: string; frames: number[]; camera: string; sound?: string }> } | undefined {
  const counts = partitionCounts(frameCount, rows.length);
  if (!counts) return undefined;
  let cursor = 1;
  const shots = rows.map((row, i) => {
    const frames = Array.from({ length: counts[i] }, (_, k) => cursor + k);
    cursor += counts[i];
    const camera = row.description.split(/[。.;!?！？]/)[0]?.trim() ?? '';
    return {
      shot: i + 1,
      time: row.seconds > 0 ? `${row.seconds}s` : '',
      frames,
      camera,
      sound: row.audio || undefined,
    };
  });
  return { shots };
}
