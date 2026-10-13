/**
 * 宫格「6 个时间窗」注入工具。
 *
 * 背景：宫格那一轮历史上发出去的就是一个光秃秃的 `A`，6 格怎么分、每格取哪一刻，
 * 全凭模型自由裁量。实测在 3 镜时会输出 3 段描述再平铺填 6 格，
 * 导致第 4/5/6 格逐字复述第 1/2/3 格。
 *
 * 本模块把「本段总时长」从出片提示词里解析出来，均分成 6 个时间窗随锚点一起下发，
 * 让模型只负责往每个窗里填画面 —— 6 格不再依赖模型数对。
 *
 * 纯函数，无副作用、无 store 依赖，便于单测。
 */

/**
 * 匹配视频提示词里的镜头时间码，两种写法都吃：
 *   `Begin with Shot 1 [0-10s]:` / `Cut to Shot 3 [15-24s]:`  （历史格式，仍兼容）
 *   `第2个镜头[10-15s]`                                        （早期映射表口径）
 * 分隔符兼容半角连字符与全角/波浪号。
 *
 * ⚠️ 正文改成**一段连续运镜**之后，正文里已经没有镜头时间码了；
 * 分段时的时间码是 `[Shot N] At MM:SS.mmm`，那是**镜头的起始时刻**、不是总时长，
 * 所以本正则同样不吃它 —— 新格式的总时长一律取自段1 末尾的「N秒」（见下）。
 * 保留本正则只为兼容历史项目里存下来的旧格式。
 */
const SHOT_RANGE_RE =
  /(?:Shot\s*\d+|第\s*\d+\s*个?\s*镜头)\s*[\[【]\s*(\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)\s*s\s*[\]】]/gi;

/**
 * 总时长的来源：**段1 的末尾**（如 `…写实真人质感，8秒。`）。
 *
 * 🔴 标记行（`【视频提示词】`）是纯标记、不含秒数。历史实现直接取「第一个非空行」，
 * 于是永远命中标记行、秒数分支形同虚设（6 个时间窗退化成不带秒数的通用文案）。
 * 故这里先剔掉纯标记行。
 *
 * 🔴 **不能只扫前 3 行**：六段式成形后那三行恒为 `summary:` /
 * `<Subject …>` 绑定行 / `detailed_description:`，而要求写的那句「段1 末尾 N 秒」
 * 落在**第 4 行** ⇒ 只扫前 3 行会对新格式**恒返回 null**。
 * 改法：**扫到第一个 `[Shot` 行为止** —— 既覆盖新格式，也仍然把段3 的动作时长
 * （如「举到眼前停顿 2 秒」）挡在外面 —— 那正是原 3 行上限想防的东西。
 */
const DURATION_RE = /(\d+(?:\.\d+)?)\s*秒/;
const MARKER_ONLY_RE = /^\*{0,2}【[^】]*】\*{0,2}$/;
/** 没有 `[Shot` 标记时（不该发生）的兜底上限，别让整篇正文都进扫描范围。 */
const DURATION_SCAN_LINES = 12;
/** 段3 的边界：第一个镜头标记行。 */
const SHOT_LINE_RE = /^\[Shot\b/;

/**
 * 从出片提示词原文里求本段总时长（秒）。
 *
 * 旧格式：取所有镜头区间的**最大结束时间**，而不是累加 —— 模型偶尔会写出重叠区间，
 * 累加会得到荒谬的总长。
 * 新格式（一镜到底 / `[Shot N] At MM:SS.mmm` 分段）：一律回退到段1 末尾的「N秒」——
 * 分段的时间码只是各镜的**起始时刻**，取最大值会得到「最后一镜何时开始」而非总长。
 * 解析不到返回 null（调用方退化为通用文案，不阻断流程）。
 */
export function parseSegmentDuration(videoPrompt: string): number | null {
  if (!videoPrompt) return null;
  let maxEnd = 0;
  for (const m of videoPrompt.matchAll(SHOT_RANGE_RE)) {
    const end = parseFloat(m[2]);
    if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
  }
  if (maxEnd > 0) return Number(maxEnd.toFixed(2));

  // 新格式回退：段1 的末尾时长句。**先剔纯标记行，再扫到第一个 `[Shot` 行为止** ——
  // 剔标记行是因为标记行恒是第一行；停在第一个镜头标记行是避免误取段3 的动作时长
  // （如「举到眼前停顿 2 秒」），把 8 秒的片子算成 2 秒、6 个时间窗全错。
  const lines = videoPrompt
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !MARKER_ONLY_RE.test(l));
  const stop = lines.findIndex((l) => SHOT_LINE_RE.test(l));
  const head = lines.slice(0, stop >= 0 ? stop : DURATION_SCAN_LINES);
  // 取**最后一个**匹配：段1 的收尾就在紧邻第一个切点之前，与 Rust 侧同一口径
  // （它也是取最后一个）。这样 summary 里偶然出现的「3 秒后」不会把真正的总时长顶掉。
  let found: number | null = null;
  for (const line of head) {
    for (const m of line.matchAll(new RegExp(DURATION_RE, 'g'))) {
      const secs = parseFloat(m[1]);
      if (Number.isFinite(secs) && secs > 0) found = Number(secs.toFixed(2));
    }
  }
  return found;
}

/** 把总时长 6 等分，格式化成 `0-4s / 4-8s / ...`。 */
export function formatSixWindows(totalSeconds: number): string {
  const step = totalSeconds / 6;
  return Array.from({ length: 6 }, (_, i) => {
    const a = Number((step * i).toFixed(2));
    const b = Number((step * (i + 1)).toFixed(2));
    return `${a}-${b}s`;
  }).join(' / ');
}

/**
 * 构造随宫格锚点一起下发的时间窗提示。
 *
 * 拿不到总时长时退化为不带秒数的通用版 —— 依然强调「6 格 = 6 个时刻」，
 * 这是防复述的关键约束，比精确秒数更重要。
 */
export function buildGridWindowHint(totalSeconds: number | null): string {
  if (totalSeconds && totalSeconds > 0) {
    return (
      `\n（本段 ${totalSeconds} 秒：请按 ${formatSixWindows(totalSeconds)} 六个时间点，逐格写第 N 格。\n` +
      `镜头数照原计划不变；一镜到底也照样按这 6 个时刻拆成 6 格。\n` +
      `6 格是 6 个不同瞬间，每格画面必须不同，禁止任何一格复述另一格。）`
    );
  }
  return (
    `\n（请把本段总时长 6 等分，按 6 个时间点逐格写第 N 格。\n` +
    `镜头数照原计划不变；一镜到底也照样拆成 6 格。\n` +
    `6 格是 6 个不同瞬间，每格画面必须不同，禁止任何一格复述另一格。）`
  );
}

/**
 * 是否是「走宫格」的那一轮。
 *
 * 🔴 直出 / 宫格的分叉在 **STEP 5.5 选项卡**上，前端发的是锚点块 ——
 * 🔴 **两条路都进 `STEP6`，差别只在模式行**：宫格发 `【阶段】STEP6` + `【模式】宫格`，
 *   直出发 `【阶段】STEP6` + `【模式】直出`（**本函数只认前者**）。
 *   ⚠️ 直出那条**曾经**发的是 `【阶段】STEP7` —— 那是个 bug，
 *   会把整个 STEP 6（唯一产出出片提示词的一步）跳过去，详见 `stageCards.ts`。
 *
 * 🔴 这条判据与**后端 `chat.rs::is_grid_turn`**、以及
 *   `stageCards.STAGE_CARDS['STEP5.5']` 里那条 `anchor` **必须逐字相同** ——
 *   三处任一改动都要同时改另两处（`chat.rs` 的注释里写着这条纪律）。
 */
export function isGridRequest(content: string): boolean {
  const lines = content
    .split('\n')
    .map((l) => l.replace(/\s+/g, ''))
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines[0] === '【阶段】STEP6' && lines.slice(1).some((l) => l.includes('【模式】宫格'));
}

/**
 * 「按稿出格」锚点的**唯一字面**。
 *
 * 🔴 这两个字面**只许在这里出现一份**：产方是 `FillGridButtons.buildCellsAnchor`，
 *    解方是 `chatStore.lastVideoPrompt`。两边各写一份，就是本仓反复吃亏的
 *    「名字散落各处」——A 层说一个名字、B 层说另一个、解析器只认第三个，三处打架。
 */
export const CELLS_ANCHOR_MARK = '【按稿出格】';
/** 锚点块正文的**界尾**（`buildCellsAnchor` 的最后一行）。 */
export const CELLS_ANCHOR_TAIL = '只输出 6 格描述与【分镜映射】，不要再输出提示词正文。';

/**
 * 从「按稿出格」锚点里取出**那一份出片提示词正文**。
 *
 * ## 为什么需要它
 *
 * 出 6 格发的是这条锚点：首行 `【阶段】STEP6`、`【模式】宫格`，正文夹在
 * `【按稿出格】按下面这份出片提示词出 6 格画面描述：` 与上面那句界尾之间。
 *
 * 而 `chatStore.lastVideoPrompt` **只扫 assistant 消息里的 `【视频提示词】`**——
 * 那是**旧格式**的产物。写手改用六段式正文后，正文改由**用户消息**带进来，
 * assistant 那条回复里不再有那个标记 ⇒ `lastVideoPrompt` 恒返回 `null`
 * ⇒ 逐格第二遍**整段静默跳过**，而 App 不报任何错。
 * 后果是 6 格正文自己打架（格 1/6 男左女右、格 2–5 女偏左男偏右），
 * 而每张图都忠于自己那条文字 —— 缺陷在文字之间，不在出图环节。
 *
 * 🔴 **取用户手上那份，不取写手原始那份**：用户可能刚在编辑框里改过提示词，
 *    出格必须按改后的来（`FillGridButtons` 顶部注释：「出格的依据是用户看完、
 *    可能改过的那一份」）。
 *
 * 取不到（不是这一轮 / 正文为空）返回 `null` ⇒ 调用方跳过第二遍 = **fail-open**，
 * 与改动前行为逐字一致，不会更坏。
 *
 * ⚠️ **界尾之后的 6 个时间窗提示（`buildGridWindowHint`）刻意切掉**：那是
 *    `enrichGridRequest` 后加的说明，不是出片提示词正文本身。
 */
export function parseCellsAnchor(content: string | null | undefined): string | null {
  if (!content) return null;
  const at = content.indexOf(CELLS_ANCHOR_MARK);
  if (at < 0) return null;
  const afterMark = content.slice(at + CELLS_ANCHOR_MARK.length);
  // 标记语的第一全角冒号之后就是正文（`【按稿出格】按下面这份出片提示词出 6 格画面描述：`）。
  const colon = afterMark.indexOf('：');
  if (colon < 0) return null;
  const rest = afterMark.slice(colon + 1);
  const tail = rest.indexOf(CELLS_ANCHOR_TAIL);
  const body = (tail >= 0 ? rest.slice(0, tail) : rest).trim();
  return body || null;
}

/**
 * 把锚点块重写成「锚点块 + 6 个时间窗」。
 *
 * 只有宫格那一轮会被改写，其它消息原样返回 —— 普通描述、`暂停`、
 * 以及直出那条 `【阶段】STEP6\n【模式】直出` 都不受影响
 * （**它与宫格只差模式行**，所以这里的判据必须认「模式行 == 宫格」而不是「阶段 == STEP6」）。
 * 已带括号说明的也跳过，避免叠加（幂等）。
 *
 * `fallbackSeconds`（可选）：上一条回复里读不到总时长时的兜底 ——
 * 走仪表板的 `segmentDurationSeconds`。**读不出就不写秒数**，退化成通用文案。
 */
export function enrichGridRequest(
  content: string,
  lastAssistantText: string,
  fallbackSeconds?: number | null,
): string {
  if (!isGridRequest(content)) return content;
  // 幂等：认**提示语自己的末句**，而不是「含全角左括号」。
  //
  // 🔴 宫格锚点现在**会把用户的出片提示词整篇带进来**
  //    （`FillGridButtons.buildCellsAnchor` —— 用户可能刚改过那份稿，出格要按改后的来）。
  //    提示词正文里出现一个全角 `（` 是常事，旧判据会因此**误判成「已注入」而整条跳过**，
  //    六格时间窗就永远发不出去。改用提示语自身的末句当指纹：两个分支
  //    （带秒数 / 不带秒数）都以它收尾，且它**不可能**出现在用户正文里。
  if (content.includes('禁止任何一格复述另一格。）')) return content;
  const secs = parseSegmentDuration(lastAssistantText) ?? fallbackSeconds ?? null;
  return content.trimEnd() + buildGridWindowHint(secs);
}

/**
 * 构造回炉时的纠正指令（6 格逐字重复时重出）。
 *
 * 🔴 **首行必须是宫格锚点块**（`【阶段】STEP6` + `【模式】宫格`）：
 *    后端 `chat.rs` 只按「用户最后一条消息的首行」分发，且要靠这一对字符串
 *    认出这是宫格轮（`is_grid_turn`）—— 少了 `【模式】宫格` 那一轮就丢一份宫格指南，
 *    少了 `【阶段】STEP6` 更像把这条纠正当成了普通输入。
 */
export function buildDuplicateCorrectionText(
  pairs: Array<{ first: number; second: number }>,
): string {
  const desc = pairs.map((p) => `第${p.first}格=第${p.second}格`).join('、');
  return (
    `【阶段】STEP6\n【模式】宫格\n\n` +
    `【重新生成要求】你上一轮输出的宫格分镜存在逐字重复：${desc}。\n` +
    `请重新输出完整的 6 格：\n` +
    `1. 必须 6 格（2×3 六宫格），不得多、不得少；\n` +
    `2. 6 格是同一段动作序列里 6 个不同的瞬间，两两不得相同或近似相同；\n` +
    `3. 一镜到底也必须拆成 6 个不同瞬间，严禁把同一段描述复制到多格充数；\n` +
    `4. 镜头数保持不变；重出完整 6 格后再输出【分镜映射】（1..6 的真划分）。\n` +
    `只输出 6 格描述与【分镜映射】，不要任何解释。`
  );
}
