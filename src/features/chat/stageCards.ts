/**
 * STEP 选项卡目录 —— 「**前端持有光标**」的那一半。
 *
 * 🔴 2026-10-01 协议（用户定调「全盘使用官方的提示词系统，我们上面加一个壳」）：
 *
 * ```
 *   前端持有：光标(STEP n) + 选项卡目录（本文件）
 *   写手职责：(会话历史 + 【阶段】STEPn) → 第 n 步产物
 * ```
 *
 * **为什么光标在前端，而不是「写手出选项、前端照着渲染」**：
 *   官方那套 9 步是给官方 agent 宿主写的（`meta.yaml` 自己写着 `not portable`），
 *   它靠宿主弹选项卡推进。我们没有那个宿主，也不打算让写手兼任状态机 ——
 *   写手只负责**一问一答**，它吐的末尾那行 `【阶段】STEP<m>` 只是**建议**，
 *   采纳与否由本文件决定。
 *
 * ⇒ 因此本模块是**纯函数 + 纯数据**：无 store、无 IO，可单测。
 * ⇒ 因此 `ChatMessage.stage` 是 **optional**（老会话没有它 ⇒ 不渲染任何卡片，
 *   行为逐字退回改动前）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 🔴 **不要在这里写「写手该输出什么」** —— 那是 B 层
 *    （`src-tauri/src/commands/writer_rules/{block_critical,step_shapes}.md`）的活。
 *    本文件的唯一职责是：**把用户的一次点击翻译成一行锚点**。
 * ────────────────────────────────────────────────────────────────────────
 */

/** 步骤号。带 `STEP5.5` 这种小数档 —— 所以是 string 不是 number。 */
export type StageId = string;

export interface StageCardOption {
  /** i18n key（`zh.json` / `en.json` 都要有） */
  labelKey: string;
  /** 兜底文案，与 `zh.json` 逐字一致（本仓既有写法：`t(key, fallback)`） */
  label: string;
  /**
   * `label` 里 `{{…}}` 的插值。**带动态值的选项必须走它** ——
   * `label` 本身只是「key 不存在时的兜底」，中英双语要走 `labelKey` 的资源串，
   * 不给变量的话英文用户看到的是 `Next unit ({{unit}})` 这种半成品。
   */
  labelVars?: Record<string, string>;
  /**
   * 点击后发给写手的**锚点块**（可能多行）。
   * 🔴 首行必须是 `【阶段】…` —— 后端 `chat.rs` 靠首行 `【` 判「这是控制轮」
   *    （不注入「别停」护栏、注入 STEP 门机、`is_grid_turn` 也认它）。
   */
  anchor: string;
  /** 这一屏的推荐项：排第一、用强调色 */
  recommended?: boolean;
}

export interface StageCardDef {
  questionKey: string;
  question: string;
  options: StageCardOption[];
  /** 允不允许用户不点卡片、直接打字（默认 true） */
  allowCustom?: boolean;
}

/** 拼一行锚点块。`extras` 的键直接当 `【键】` 用（`已选` / `修改要求` / `模式` …）。 */
export function buildAnchor(stage: StageId, extras: Record<string, string> = {}): string {
  const lines = [`【阶段】${stage}`];
  for (const [key, value] of Object.entries(extras)) {
    if (value && value.trim()) lines.push(`【${key}】${value.trim()}`);
  }
  return lines.join('\n');
}

/**
 * 主脊的默认下一步。
 *
 * 🔴 写手末尾那行 `【阶段】STEP<m>` 是**建议**；真不知道该去哪时以本表为准。
 *    `''` = 主干到头了（`STEP9` 复查报告之后没有下一步）。
 */
const NEXT_STAGE: Record<StageId, StageId | ''> = {
  STEP0: 'STEP1',
  STEP1: 'STEP2',
  STEP2: 'STEP3',
  STEP3: 'STEP4',
  STEP4: 'STEP5',
  STEP5: 'STEP5.5',
  // 5.5 的自检门过了之后**默认推荐画分镜**（官方 storyboard-guidelines 的第一项），
  // 真正的分叉由卡片给三选项，见 `STAGE_CARDS['STEP5.5']`。
  'STEP5.5': 'STEP6',
  // 6 出完 6 格 + 本单元出片提示词。
  // ⚠️ `STEP6` **没有卡片按钮**（见 `STAGE_CARDS['STEP6']`），
  //    所以这一行的 `STEP7` 只剩「主干默认下一步」的含义，**不再**由用户点击触发；
  //    `autoNextAnchor` 的自动串联也在 `STEP6` 就停（`AUTO_CHAIN_TERMINUS`）。
  STEP6: 'STEP7',
  STEP7: 'STEP9',
  STEP9: '',
};

export function nextStageOf(stage: StageId): StageId | '' {
  return NEXT_STAGE[stage] ?? '';
}

/** 从一段文本里抽出锚点步骤号（认 `【阶段】STEP5.5` 这类写法）。解析不到返回 null。 */
export function parseStageAnchor(content: string): StageId | null {
  // 只在**行首**认 —— 正文里偶然提到「【阶段】STEP6」不算（与后端同口径）。
  const match = content.match(/^[ \t]*【阶段】[ \t]*(STEP[0-9]+(?:\.[0-9]+)?)/m);
  return match ? match[1] : null;
}

/**
 * 一条回复该挂哪张卡。
 *
 * 🔴 **入参是「我们刚才问的是哪一步」，不是写手末尾那行建议** —— 光标在前端。
 *    （写手的建议只用来在卡片上标「推荐」；写手胡写了也不会把光标带跑偏。）
 *
 * `unit` 只有 `STEP6` 用得上：出片是**按单元**出的，链到此为止（`AUTO_CHAIN_TERMINUS`），
 * 于是「下一个单元」必须由用户点出来 —— 见 `resolveUnitPlan` 与 `STEP6` 的卡片。
 */
export function cardForStage(stage: StageId, unit?: UnitPlan | null): StageCardDef {
  if (stage === 'STEP6') return step6Card(unit);

  const explicit = STAGE_CARDS[stage];
  if (explicit) return explicit;

  const next = nextStageOf(stage);
  if (!next) {
    return {
      questionKey: 'chat.stage.done',
      question: '这一段已经走完了。可以继续修，或者把提示词落到节点上。',
      options: [],
      allowCustom: true,
    };
  }
  return {
    questionKey: 'chat.stage.continue',
    question: '继续下一步吗？',
    options: [
      {
        labelKey: 'chat.stage.next',
        label: '下一步',
        anchor: buildAnchor(next),
        recommended: true,
      },
    ],
    allowCustom: true,
  };
}

/**
 * 需要**真选择**的那几屏。没列到的步骤一律走 `cardForStage` 的默认「下一步」。
 *
 * 🔴 `STEP5.5` 是直出 / 宫格的**唯一分叉点**；
 *    它也是后端 `is_grid_turn` 认的那一行（`【阶段】STEP6` + `【模式】宫格`）——
 *    两处的字符串**必须逐字相同**，改一处就要改三处（后端 + `chatStore` + 本文件）。
 */
export const STAGE_CARDS: Record<StageId, StageCardDef> = {
  STEP0: {
    questionKey: 'chat.stage.step0',
    question: '需求和画幅时长对得上吗？（画幅与时长取自项目仪表板，这里不用再填）',
    options: [
      { labelKey: 'chat.stage.confirm', label: '对，写项目简报', anchor: buildAnchor('STEP1'), recommended: true },
    ],
    allowCustom: true,
  },
  'STEP5.5': {
    questionKey: 'chat.stage.step55',
    question: '自检过了。接下来怎么走？',
    options: [
      {
        labelKey: 'chat.stage.grid',
        label: '确认自检并画分镜（推荐）',
        // 单元号恒从 U1 起 —— 用户点这张卡时，永远是「刚贴完脚本的第一个单元」。
        anchor: buildAnchor('STEP6', { 模式: '宫格', 单元: 'U1' }),
        recommended: true,
      },
      {
        labelKey: 'chat.stage.direct',
        label: '直接出片（跳过分镜）',
        // 🔴 **两条路都进 STEP6，差别只在 `【模式】`**。
        //
        // 这里**曾经**写的是 `buildAnchor('STEP7', …)`，那是个 bug：原意是「跳过 6 格分镜」，
        // 但 STEP7 是「视频模型选项卡」那一步，而出片提示词是 **STEP6** 的产物
        // ⇒ 直出路会**整个跳过唯一产出提示词的那一步**，跑完一个字都没有。
        // 正确形状见 `step_shapes.md` STEP 6：「含『直出』⇒ 跳过格子，直接出下面的出片提示词。」
        anchor: buildAnchor('STEP6', { 模式: '直出', 单元: 'U1' }),
      },
      {
        labelKey: 'chat.stage.rerun',
        label: '重跑自检',
        anchor: buildAnchor('STEP5.5'),
      },
    ],
    allowCustom: true,
  },
  STEP6: {
    questionKey: 'chat.stage.step6',
    question: '这一单元的出片提示词在上面了。',
    // 实际选项由 `step6Card(unit)` 动态给（要看会话里已经出到第几个单元）——
    // 这里留空数组只是为了「没有会话上下文时」也有个底。
    //
    // ⚠️ 用户定调过「**先去掉按钮，不是去功能**」：原「收参数、跑复查」（`【阶段】STEP7`）
    //   那条已摘掉入口，但 `STEP7` 的锚点后端照旧认（`chat.rs` 的裸锚点分支未动），
    //   用户手打 `【阶段】STEP7` 仍可跑。
    options: [],
    allowCustom: true,
  },
};

// ══════════════════════════════════════════════════════════════════════════
// 单元（`【单元】Uk`）—— 出片是**按单元**出的，这是「续下一个单元」的唯一入口
//
// 🔴 背景（2026-10-13 用户实测上报）：
//   写手的形状块写的是「**为 `【单元】Uk` 出这份正文**」（`step_shapes.md` STEP 6），
//   而自动串联发的锚点恒是 `【阶段】STEP6` + `【模式】直出`，**从来没带过单元号**
//   ⇒ 写手只能按第一个单元出；而 `STEP6` 的卡片当时是**空数组**
//   ⇒ 界面上没有「出下一单元」的入口，多单元脚本**永远只能出到 U1**。
//   用户原话：「要我生成下一段，但是下一段也没提示我生成」。
//
// ⚠️ 旧协议是靠 L3 的「继续-生成下一段」按钮做的，门机把这套按钮整体下线时
//   把这个能力一起带走了 —— 这是**能力缺口**，不是措辞问题。
//
// ──────────────────────────────────────────────────────────────────────────
// 🔴 **判据是「镜头覆盖」，不是「单元号」**（2026-10-13 实测两次回头改过）：
//
//   第一版按「镜头表里的 `U(\d+)` 记号」算单元数。拿用户两条真实会话一验就废了：
//   · conv0（9 个镜头 / 34 秒）——**根本没写〈分段建议〉**（整张表一个 `U` 记号都没有）
//     ⇒ `total` 恒为 0 ⇒ 永远不出按钮，用户看到的还是老样子；
//   · 单元划分本来**不是**镜头表的必产项（`step_shapes.md` STEP 5 没要求它），
//     所以「写手忘了写」是常态，不能当判据。
//
//   ⇒ 改成 **`[Shot N]` 覆盖**：
//     `totalShots` ← 镜头表（`共 N 个镜头` / `[Shot N]` / 表格行首 `S03（3.0s）`）
//     `covered`   ← 所有**真出过的出片正文**（含 `subject_definitions:`）里的 `[Shot N]` 并集
//     下一个单元 = **第一个没覆盖到的镜头**所在的那一组
//
//   这条判据还有两个附带好处：
//   ① **不会重出**：已经出过的镜头不会再被圈进下一单元；
//   ② **写手一次全出完也认**：一份正文覆盖了全部镜头 ⇒ `finished` ⇒ 不给按钮。
//
//   分组的来源按优先级：①镜头表末尾的〈分段建议〉（写手自己划的，最权威）；
//   ②按秒数贪心切单元（`SKILL.md`：单段视频最长 15 秒）——conv0 走的正是这条。
//
// ──────────────────────────────────────────────────────────────────────────
// 🔴 **第三版（2026-10-13 第二次实测后重写）：判据回到「锚点 ↔ 正文」这一对，
//    既不能用「正文里的 `[Shot N]`」，也不能用「锚点里的最大 U 号」。** 两条都翻过车：
//
//   **坑一 · 拿「锚点里见过的最大 U 号」当计数 ⇒ 计数器自己喂自己，每轮 +1、无上限。**
//   第二版算的是 `max(锚点里见过的最大 U 号, 正文条数) + 1`。可是**我们发出去的那条锚点
//   本身就是一条用户消息**，里面的单元号正是上一轮由 `next` 生成的（`step6Card` 的
//   `buildAnchor('STEP6', { 单元: label … })`）：
//
//     explicitUnit_{k+1} = next_k   ⇒   next_{k+1} ≥ next_k + 1
//
//   实测逃逸轨迹 U3 → 发【单元】U3 → 读回 3 → next=4 → 发 U4 → next=5 …
//   用户看到「出下一单元（**U5** · Shot 4 - Shot 5）」，写手被不存在的「U5」问住、
//   回「本片共 3 个生成单元，不存在 U4」，白跑一轮。
//
//   **坑二 · 拿「正文里的 `[Shot N]`」当全局镜号 ⇒ 从第二个单元起永远对不上。**
//   实测同一条会话：写手为 U1 的正文写 `[Shot 1..3]`；为 U2（Shot 4–5）的正文写
//   `[Shot 1] [Shot 2]`；为 U3 的正文写 `[Shot 1..3]` —— **`[Shot N]` 是单元内部的
//   局部编号**：官方六段式里**一个单元 = 一条独立的视频提示词**，镜头从 1 数起、时间戳
//   也从 0 起（`step_shapes.md` 只说「严格递增」，从没说过用全片镜号）。
//   ⇒ 拿它算「已覆盖的全局镜号」，`covered` 永远只有 {1,2,3}，`uncovered[0]` 永远是 4
//   ⇒ **范围卡死在 `Shot 4 - Shot 5`**，点几次都是同一个范围（这正是上面那条「U5 ·
//   Shot 4 - Shot 5」里范围那一半的来历），而且**永远不会 finished**。
//
//   ⇒ 第三版的判据 = **「我们请了第 k 个单元」+「真的收到了一份出片正文」这一对**：
//     · 逐条扫，遇到 `【阶段】STEP6` 的锚点记下它要的单元号（老锚点不带 `【单元】` ⇒ 1）；
//     · 下一条含 `subject_definitions:` 的 STEP6 正文兑换它（空响应 / `⚠️ 回复中断` 不兑换）；
//     ⇒ 已产出的单元 = 兑换成功的那些号。
//   `next` = **第一个还没产出的单元号**（不是最大号 +1 ⇒ 逃逸消失）；
//   `nextShots` = 该单元在**分组**里的镜头（与 `next` 同源 ⇒ 编号与范围永远自洽）。
// ══════════════════════════════════════════════════════════════════════════

/** 会话里攒出来的单元进度。 */
export interface UnitPlan {
  /** 镜头总数（从镜头表读出来的） */
  totalShots: number;
  /** 已经**兑现**（请过 + 收到过正文）的单元数；🔴 绝不看我们自己发过的锚点，见文件头「第三版」 */
  done: number;
  /** 下一个单元的单元号 = **第一个还没兑现的号**（不是「见过的最大号 + 1」） */
  next: number;
  /** 下一个单元要出的镜头，如 `Shot 4 - Shot 6`（`finished` 时为空串）。与 `next` **同源**：分组的第 `next-1` 项 */
  nextShots: string;
  /** 所有单元都兑现过 ⇒ 不给按钮 */
  finished: boolean;
}

/** `stageCards` 是纯数据模块，**不 import store** —— 这里用结构类型接会话消息。 */
export interface StageTurnLike {
  role: string;
  content: string;
  stage?: string | null;
}

/** 行内第一个秒数：`S01（3.0s）` / `**[Shot 6]** 12.0s<br>34.0–46.0s` / `｜4s`。 */
const SHOT_SECONDS_RE = /(\d+(?:\.\d+)?)\s*s/i;
/** 括号里的显式时长：`（3.5s）` / `(3.5s)` —— 写手最常写、最不会误读的一种。 */
const SHOT_DURATION_PAREN_RE = /[（(]\s*(\d+(?:\.\d+)?)\s*s\s*[）)]/i;
/** 起止时刻区间：`3.5–6.5s`（时长 = 后者 − 前者）。 */
const SHOT_DURATION_RANGE_RE = /(\d+(?:\.\d+)?)\s*s?\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*s/i;

/**
 * 一行首格里的**本镜时长（秒）**。
 *
 * 🔴 **不能直接取行内第一个 `Ns`** —— 写手的时长列有三种写法，其中
 *    `Shot 1 · 0.0–3.5s（3.5s）` 这种「起–止s（时长s）」里，第一个命中的是
 *    **结束时刻**（第二镜 `3.5–6.5s（3.0s）` 会被读成 6.5）。实测后果：15 秒的镜头表
 *    被读成 48 秒 ⇒ 贪心切单元把「写手自己划的 1 个单元」切成 4 个
 *    （U1 Shot 1-2 / U2 Shot 3 / U3 Shot 4 / U4 Shot 5），15 秒广告变成 4 次生成、4 个片段。
 *    所以按 **括号时长 → 起止之差 → 行内第一个 `Ns`** 三级取。
 */
function readShotSeconds(head: string): number | null {
  const paren = head.match(SHOT_DURATION_PAREN_RE);
  if (paren) return Number(paren[1]);
  const range = head.match(SHOT_DURATION_RANGE_RE);
  if (range) {
    const diff = Number(range[2]) - Number(range[1]);
    // 时间戳写法（`00:00.000–00:04.000`）到这里会算出 0 或负数 ⇒ 继续往下取裸 `Ns`
    if (diff > 0) return diff;
  }
  const bare = head.match(SHOT_SECONDS_RE);
  return bare ? Number(bare[1]) : null;
}
/** 〈分段建议〉旧写法（表格外的列表项）：`- **U2**：[Shot 3] + [Shot 4]（19.0 秒）` */
const DECLARED_UNIT_LEGACY_RE = /^\s*[-*]?\s*\*{0,2}U(\d+)\*{0,2}\s*[：:]/;
/**
 * 〈分段建议〉等号写法（写手 2026-10 用的就是这个）：
 * `U1 = Shot 1–Shot 5（0.0–15.0s，共 15 秒）` / 带 `【单元】` 前缀的同上。
 * 🔴 少了这一条，写手自己划好的单元就白划 —— 会落回「按秒数贪心切」的兜底，
 *    15 秒单单元脚本被切成 4 个单元（见 `readShotSeconds` 的注释）。
 * 🔴 只认 `= ` 这一种分隔符：镜头行里的 `（U1·全片 00:00.000–…）` 不带等号，
 *    不会被误当成单元声明。
 */
const DECLARED_UNIT_EQUALS_RE = /^\s*[-*]?\s*\**\s*(?:【单元】\s*)?U(\d+)\s*=/;
/**
 * 〈分段建议〉写手现在的写法：
 * `- **【单元】U2 = Shot 4 – Shot 5**（全片 00:15.000–00:30.000，15 秒）｜第一问、第一答`
 * 🔴 `【单元】` 这个记号必须留在正则里 —— 镜头表自己的行里也写着 `（U1·全片 …）`，
 *   只认 `U(\d+)` 会把**镜头行**误当成单元声明，算出 `U1 = [1]` 这种垃圾分组。
 */
const DECLARED_UNIT_INLINE_RE = /^\s*[-*]?\s*\**\s*【单元】\s*\**\s*U(\d+)\**/;
/** 表格上方那句汇总：`全片共 9 个镜头，累计时长 34.0 秒` */
const SHOT_TOTAL_RE = /共\s*(\d+)\s*个镜头/;

/**
 * 从**表格行首格**里读镜号。写手前后出现过四种行形状：
 * - `| **Shot 1**（U1·全片 00:00.000–00:04.000）｜4s | …` ← 多单元脚本（首格带单元号与全片时间）
 * - `| **[Shot 3]** 12.0s<br>34.0–46.0s | …`
 * - `| S03（3.0s） | …` / 无表格管线的裸行 `S03（3.0s）`
 *
 * 🔴 **只认首格**：第二格起会写「承接 Shot 2 的结尾」这类正文，全文扫会把承接关系
 *   当成镜头行（表头 `| Shot ID & Duration | …` 也靠「Shot 后面必须跟数字」排除）。
 */
function matchShotRowHead(line: string): number | null {
  const trimmed = line.trimStart();
  const head = trimmed.startsWith('|') ? (trimmed.split('|')[1] ?? trimmed) : line;
  const m = head.match(/\[Shot\s*(\d+)\]|Shot\s*(\d+)|S(\d+)\s*[（(]/);
  if (!m) return null;
  const n = Number(m[1] ?? m[2] ?? m[3]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 一行里出现的镜号，**支持范围写法**：
 * `[Shot 3] + [Shot 4]` → `[3,4]`；`Shot 4 – Shot 5` → `[4,5]`；
 * `Shot 1 - Shot 3` → `[1,2,3]`（分隔符 `- – — ~ 至`）。
 * 只给〈分段建议〉用 —— 现在**只此一处**需要读正文里的镜号（出片正文的 `[Shot N]` 是
 * **单元内部局部编号**，从第二个单元起与全片镜号对不上，已不再参与进度判定）。
 */
function collectShotNumbersLoose(text: string): number[] {
  const found: number[] = [];
  const re = /\[?\s*\**Shot\s*(\d+)\**\s*\]?(?:\s*[-–—~至]\s*\[?\s*\**Shot\s*(\d+)\**\s*\]?)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const a = Number(m[1]);
    if (!Number.isFinite(a) || a <= 0) continue;
    const b = m[2] ? Number(m[2]) : a;
    if (!Number.isFinite(b) || b < a) {
      found.push(a);
      continue;
    }
    for (let n = a; n <= b && n - a < 64; n += 1) found.push(n);
  }
  return found;
}

/** 一个单元默认不超过这么多秒（`SKILL.md` 第 7 条：单段视频最长 15 秒）。 */
const UNIT_MAX_SECONDS = 15;
/** 镜头表里读不出秒数时，一个单元按几个镜头切（兜底）。 */
const UNIT_FALLBACK_SHOTS = 3;

interface ShotRow {
  n: number;
  seconds: number | null;
}

/** 按表格顺序读镜头行（去重、保序）。 */
function parseShotRows(shotTable: string): ShotRow[] {
  const rows: ShotRow[] = [];
  for (const line of shotTable.split('\n')) {
    const n = matchShotRowHead(line);
    if (n === null) continue;
    if (rows.some((r) => r.n === n)) continue;
    rows.push({ n, seconds: readShotSeconds(line.slice(0, 120)) });
  }
  return rows;
}

/** 按秒数贪心切单元；镜头表读不出秒数时退化成「每 N 个镜头一组」。 */
function groupShotsByDuration(rows: ShotRow[]): number[][] {
  if (rows.length === 0) return [];
  const hasSeconds = rows.every((r) => r.seconds !== null);
  const groups: number[][] = [];
  let current: number[] = [];
  let currentSeconds = 0;
  for (const row of rows) {
    const sec = row.seconds ?? 0;
    const overflow = hasSeconds
      ? current.length > 0 && currentSeconds + sec > UNIT_MAX_SECONDS
      : current.length >= UNIT_FALLBACK_SHOTS;
    if (overflow) {
      groups.push(current);
      current = [];
      currentSeconds = 0;
    }
    current.push(row.n);
    currentSeconds += sec;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 镜头表末尾的〈分段建议〉——写手自己划的单元，优先于按秒数推算。 */
function parseDeclaredUnits(shotTable: string): number[][] | null {
  const units = new Map<number, number[]>();
  for (const line of shotTable.split('\n')) {
    // 表格行一律跳过（它们是镜头行，不是单元声明）；唯一例外是明写 `【单元】` 的表格式分段建议。
    const isTableRow = line.trimStart().startsWith('|');
    if (isTableRow && !line.includes('【单元】')) continue;
    const head =
      line.match(DECLARED_UNIT_INLINE_RE) ??
      line.match(DECLARED_UNIT_LEGACY_RE) ??
      line.match(DECLARED_UNIT_EQUALS_RE);
    if (!head) continue;
    const k = Number(head[1]);
    const shots = collectShotNumbersLoose(line);
    if (Number.isFinite(k) && k > 0 && shots.length > 0) units.set(k, shots);
  }
  if (units.size === 0) return null;
  // 按**首个镜号**排序（写手的单元号与镜头顺序一致；万一编号跳号，按镜号更稳）。
  return [...units.values()].sort((a, b) => Math.min(...a) - Math.min(...b));
}

/** `[4,5,6]` → `Shot 4 - Shot 6`（单个 → `Shot 4`）。锚点里就用这个写法，写手照抄。 */
function formatShotRange(shots: number[]): string {
  if (shots.length === 0) return '';
  const sorted = [...shots].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? `Shot ${first}` : `Shot ${first} - Shot ${last}`;
}

/**
 * 从一段**出片正文**里认「这是一份真的出片提示词」。
 *
 * 用六段契约的第一段当判据（`subject_definitions:`）—— 空响应、`⚠️ AI 回复中断`
 * 那类占位文案都不含它 ⇒ 不会把「失败的一轮」算成一个已完成的单元。
 */
function looksLikeShotPrompt(content: string): boolean {
  return content.includes('subject_definitions:');
}

/**
 * 算出「下一个该出的单元」。
 *
 * 返回 `null` = **读不出镜头表**（不是锚点轮产物 / 表里没有任何镜头记号）
 * ⇒ `STEP6` 退回「没有按钮」的老样子（fail-open，与改动前逐字一致）。
 */
export function resolveUnitPlan(
  messages: readonly StageTurnLike[] | undefined | null,
): UnitPlan | null {
  if (!messages || messages.length === 0) return null;

  // 🔴 **光标作用域 = 最后一条镜头表之后**。用户重贴一次脚本 = 整条链重跑一遍，
  //    更早那条链的镜头表与单元进度**不能**算进这一次（否则会算出「已出到 U3」而
  //    新脚本的 U2 永远不出）。
  let shotTableIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.stage === 'STEP5') {
      shotTableIndex = i;
      break;
    }
  }
  const scope = shotTableIndex >= 0 ? messages.slice(shotTableIndex) : messages;
  const shotTable = shotTableIndex >= 0 ? messages[shotTableIndex].content : '';

  const rows = parseShotRows(shotTable);

  const declaredTotal = Number((shotTable.match(SHOT_TOTAL_RE) ?? [])[1] ?? 0);
  const declaredUnits = parseDeclaredUnits(shotTable);

  // 🔴 **可信总数只认镜头表里读得出来的三种来源**：表格行、`共 N 个镜头`、〈分段建议〉里的镜号。
  //    绝不拿「已覆盖的最大镜号」当总数 —— 镜头表一旦换形状读不出来，第一段出完
  //    （覆盖了 Shot 1-3）就会算出 `totalShots = 3` ⇒ 判 `finished` ⇒ 弹
  //    「全片单元都出过了」且**不给按钮**；用户只能手打「生成下一段」，而手打消息不是
  //    锚点 ⇒ 整条链从 STEP1 重跑（8 次调用白花）并重出第一单元。
  //    ⇒ 读不出总数时宁可**没有按钮**（fail-open 到改动前的老样子），也不能说「出完了」。
  const trustedTotal = Math.max(
    rows.length > 0 ? Math.max(...rows.map((r) => r.n)) : 0,
    Number.isFinite(declaredTotal) ? declaredTotal : 0,
    declaredUnits ? Math.max(...declaredUnits.flat()) : 0,
  );
  if (trustedTotal <= 0) return null;

  // 单元划分：①镜头表末尾的〈分段建议〉（写手自己划的，最权威） ②按秒数贪心切。
  // 🔴 **单元编号与镜头范围都从这一份推** —— 同源才能保证「U2」与「Shot 4 - Shot 5」永远自洽。
  const groups = declaredUnits ?? groupShotsByDuration(rows);
  if (groups.length === 0) {
    // 退化路径：镜头表只剩汇总句、一行镜头都读不出来（`rows` 为空 ⇒ 分不出组）。
    // 按 `UNIT_FALLBACK_SHOTS` 硬切，只为让下面「分组下标 = 单元号」这条链不为空。
    for (let n = 1; n <= trustedTotal; n += UNIT_FALLBACK_SHOTS) {
      const g: number[] = [];
      for (let k = n; k < n + UNIT_FALLBACK_SHOTS && k <= trustedTotal; k += 1) g.push(k);
      groups.push(g);
    }
  }
  if (groups.length === 0) return null;

  // ── 已产出的单元 = 「我们请了第 k 个单元」×「真收到了一份出片正文」这一对 ──
  // 见文件头「第三版」：既不用正文里的 `[Shot N]`（单元内部局部编号，从第二个单元起对不上），
  // 也不用锚点里出现过的最大 U 号（那是我们自己刚发出去的、还没兑现的请求 ⇒ 计数器失控）。
  const produced = new Set<number>();
  let pendingUnit: number | null = null;
  for (const msg of scope) {
    if (msg.role === 'user') {
      // 每条用户消息都**重设**待兑现的单元号：锚点 = 它要的那个号；非锚点 = 清空
      // （免得一条早先失败的锚点被后面无关的正文兑现）。
      pendingUnit = isStageAnchorMessage(msg.content) ? requestedUnitOf(msg.content) : null;
      continue;
    }
    if (msg.role !== 'assistant' || msg.stage !== 'STEP6') continue;
    // 空响应 / `⚠️ AI 回复中断` 占位都不含 `subject_definitions:` ⇒ 不兑换。
    if (!looksLikeShotPrompt(msg.content)) continue;
    if (pendingUnit !== null) produced.add(pendingUnit);
    pendingUnit = null; // 一个锚点只兑现一条正文
  }

  // 下一个 = **第一个还没产出的单元号**（不是「见过的最大号 + 1」—— 那个会自己喂自己）。
  let next = 1;
  while (produced.has(next)) next += 1;
  const done = Math.min(produced.size, groups.length);

  if (next > groups.length) {
    return { totalShots: trustedTotal, done, next, nextShots: '', finished: true };
  }
  return {
    totalShots: trustedTotal,
    done,
    next,
    // 🔴 与 `next` **同源**：第 k 个单元就是分组的第 k-1 项。
    nextShots: formatShotRange(groups[next - 1]),
    finished: false,
  };
}

/**
 * 一条锚点请求的是第几个单元。
 * - `【单元】U3` / `【单元】3` ⇒ 3（`step6Card` 发的形状）
 * - `【阶段】STEP6 【模式】直出`（**老锚点/自动串联的第一单元**不带单元行）⇒ **1**
 * - 不是 `STEP6` 的锚点（`STEP1` / `STEP7` …）⇒ `null`，不参与「兑现正文」
 */
function requestedUnitOf(content: string): number | null {
  if (parseStageAnchor(content) !== 'STEP6') return null;
  const m = content.match(/【单元】\s*\**\s*U?\s*(\d+)/) ?? content.match(/\bU(\d+)\b/);
  const n = Number(m?.[1] ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * `STEP6` 这一屏的选项 —— 只有一个：「出下一单元（U`next` · `Shot 4 - Shot 6`）」。
 *
 * 🔴 全部单元都出过 ⇒ **不给按钮**（`options: []` ⇒ `ChatPanel` 连问题行都不渲染），
 *   并把问题行换成「全片单元都出过了」。
 *
 * ⚠️ **注意是「单元」不是「镜头」**：进度判据是「请了第 k 个单元 × 收到一份出片正文」这一对
 *   （见文件头「第三版」），所以 `finished` 的含义是**所有分组都兑现过**，不是「每个镜号都被正文引用过」
 *   —— 后者从第二个单元起永远成立不了（正文里的 `[Shot N]` 是单元内部局部编号）。
 *   文案若写回「镜头」，一旦哪天再出现判据偏差，用户看到的就是一句做不到的承诺。
 * ⚠️ `【模式】` 恒发 `直出`，理由与 `autoNextAnchor` 同一套：六段式正文两条路共用，
 *   6 格是用户点「生成宫格分镜」时另发的（见 `FillGridButtons`）。
 * ⚠️ **`【镜头范围】` 必须带上**：写手看得到整张镜头表，但不带这一行它只能猜「下一个单元
 *   是哪些镜头」——`step_shapes.md` 的 STEP 6 形状块认这一行（`block_critical.md` 同）。
 */
function step6Card(unit?: UnitPlan | null): StageCardDef {
  const base = STAGE_CARDS['STEP6'];
  if (!unit) return base;
  if (unit.finished) {
    return {
      ...base,
      questionKey: 'chat.stage.step6Done',
      question: '全片单元都出过了。',
    };
  }

  const label = `U${unit.next}`;
  return {
    ...base,
    options: [
      {
        labelKey: 'chat.stage.nextUnit',
        label: `出下一单元（${label} · ${unit.nextShots}）`,
        labelVars: { unit: label, shots: unit.nextShots },
        anchor: buildAnchor('STEP6', {
          模式: '直出',
          单元: label,
          镜头范围: unit.nextShots,
        }),
        recommended: true,
      },
    ],
    allowCustom: true,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 自动串联
//
// 用户定调：「我们串联步骤，用户输入脚本后，左下的思考中，就提示每一步的名称就行，
// 直到第六步，出提示词即可，顶多加一个复检按钮」。
//
// ⇒ 用户贴一次脚本 → 前端自动把 `STEP0…STEP6` 一路发下去，**0 次点击**；
//   中间不渲染选项卡（那会先闪一帧再被自动跳过），只在**终点**把选择权交回用户。
// ══════════════════════════════════════════════════════════════════════════

/** 两条生成路。`STEP5.5 → STEP6` 那一行 `【模式】` 由它决定。 */
export type ChainMode = 'grid' | 'direct';

/**
 * 主干序列 —— 用户贴一次脚本后，前端自动串下去的那条路。
 *
 * 🔴 **`STEP7` / `STEP9` 不在链上，链路到 `STEP6` 为止**（见 `AUTO_CHAIN_TERMINUS`）：
 *   · `STEP7` 是「视频模型 + 分辨率」那一步，本地版恒走同一条线
 *     ⇒ 写手只吐**一行纯转录**，下游零消费者；
 *   · `STEP9` 是复查报告，同样零消费者。
 *   送模型的**唯一**产物是 `STEP6` 的六段式正文。
 *
 * 🔴 但 **`STEP0…STEP5.5` 一个都不能跳** —— 它们的内容活在 `STEP6` 的正文里：
 *   `subject_definitions` 的外观锚点 ← STEP3；`summary` ← STEP2；
 *   环境光那一句 ← STEP4；`[Shot N]` 的切分 ← STEP5。
 *   「不让人点」和「不做这一步」是两件事。
 */
export const MAIN_CHAIN: StageId[] = [
  'STEP0',
  'STEP1',
  'STEP2',
  'STEP3',
  'STEP4',
  'STEP5',
  'STEP5.5',
  'STEP6',
];

/**
 * 自动串联的终点：跑完它就不再续。
 *
 * **用户定调（原话）**：「应该是生成视频提示词，这个要显示出来给用户看，
 * 用户说不定是要修改这个提示词的，**下面是按钮，让用户选择宫格还是直出**」。
 *
 * ⇒ 分叉**不在 `STEP5.5`**，而在**提示词出来之后**：
 *   链路一路跑到 `STEP6`（提示词落成可编辑的 `video` 块），
 *   两条路的分岔由**提示词块下面那两个按钮**给（`生成宫格分镜` / `直接生成视频`，
 *   见 `FillGridButtons`，渲染在 `ChatPanel` 的**气泡外动作区**）。
 *
 * 🔴 **`【模式】` 恒定发 `直出`，不是 `宫格`。**
 *  用户原话（逐字）：「**这个就不对了，逻辑是，先生成视频提示词让用户选择，
 *  用户选择宫格的时候，才出 6 格，用户选择直出，就直接调用视频生成页面了**」。
 *
 *  ⇒ 顺序反了就是错的：用户要的是 **提示词先出来给用户看/改 → 用户点「宫格」时
 *    写手才出那 6 格**。「省一次写手往返」不是产品要优化的东西，
 *    **「用户先看到提示词」才是**。
 *
 *  ⇒ 于是 `autoNextAnchor` 在这一步固定发 `直出`（只要六段式那份，两条路共用），
 *    那 6 格改由 `FillGridButtons` 的「生成宫格分镜」按钮**按需**发一条
 *    携带**当前提示词**的锚点去要 —— 顺带治好了上一版的粗糙点
 *    （「写手那 6 格在用户改提示词之前出」）：现在是**用户改完之后才出格**。
 */
export const AUTO_CHAIN_TERMINUS: StageId = 'STEP6';

/** 显示在「思考中」那一行的步骤名（i18n key；**动态段不许带点**，见 §11.1 与 i18next 分隔符）。 */
export const STAGE_NAME_KEY: Record<StageId, string> = {
  STEP0: 'chat.stageName.step0',
  STEP1: 'chat.stageName.step1',
  STEP2: 'chat.stageName.step2',
  STEP3: 'chat.stageName.step3',
  STEP4: 'chat.stageName.step4',
  STEP5: 'chat.stageName.step5',
  'STEP5.5': 'chat.stageName.step55',
  STEP6: 'chat.stageName.step6',
  STEP7: 'chat.stageName.step7',
  STEP9: 'chat.stageName.step9',
};

/** 与 `zh.json` 逐字一致的兜底（本仓既有写法 `t(key, fallback)`）。 */
export const STAGE_NAME_FALLBACK: Record<StageId, string> = {
  STEP0: '需求复述',
  STEP1: '项目简报',
  STEP2: '故事大纲',
  STEP3: '角色清单',
  STEP4: '场景清单',
  STEP5: '六列镜头表',
  'STEP5.5': '镜头表自检',
  STEP6: '出片提示词',
  STEP7: '模型与分辨率',
  STEP9: '复查报告',
};

/** 这一步在主干的第几格（给「思考中」显示 `6/8`）。不在链上返回 `null`。 */
export function chainProgress(stage: StageId): { index: number; total: number } | null {
  const idx = MAIN_CHAIN.indexOf(stage);
  if (idx < 0) return null;
  return { index: idx + 1, total: MAIN_CHAIN.length };
}

/**
 * **过程步** —— 这些步的产物**不给用户看**，只留一行步骤名。
 *
 * 🔴 用户原话：「前边五步不需要显示给用户内容，用户能看到的，
 *    就是最终的视频提示词，用户选择是直出还是宫格就行了」。
 *
 * 定义 = `MAIN_CHAIN` 里 `STEP6` **之前**的全部（`STEP0…STEP5.5`）。
 * `STEP6` 是**唯一**产出送模型正文的那一步（其余各步的内容都只是它的素材，
 * 见 `MAIN_CHAIN` 的注释），所以它的产物必须显示。
 *
 * ⚠️ **不在 `MAIN_CHAIN` 上的步（`STEP7` / `STEP9`）返回 `false`** —— 它们照旧显示。
 *    这是**有意**的：用户点的是「前边五步」，这两步不在那条链上。
 */
export function isProcessStage(stage: StageId | undefined | null): boolean {
  if (!stage) return false;
  const idx = MAIN_CHAIN.indexOf(stage);
  const terminal = MAIN_CHAIN.indexOf('STEP6');
  return idx >= 0 && idx < terminal;
}

/**
 * 这条**用户**消息是不是**机器替用户发的**阶段锚点（而不是用户手打的）。
 *
 * 🔴 自动串联每跑完一步就替用户发一条 `【阶段】STEPn`，对用户是纯噪音，整条不渲染。
 *
 * ⚠️ **判据必须精确到 `【阶段】`**：用户贴的脚本首行**常常也是 `【` 开头**
 *    （如 `【场景】雨夜・门外街道 ｜ 室外` —— 这正是 `chat.rs` 那个粗判据
 *    误触发的原因），用「首行是 `【`」会把用户的脚本一起吞掉。
 */
export function isStageAnchorMessage(content: string): boolean {
  return content.trimStart().startsWith('【阶段】');
}

/**
 * 自动串联：这一步跑完之后，下一步该自动发哪一行锚点。
 *
 * 返回 `null` = **停**（已到终点 / 这一步不在链上 / 已到链尾）。
 *
 * 🔴 `STEP5.5 → STEP6` 是两条路**唯一**的分叉，所以它必须带 `【模式】` 行 ——
 *   不带的话写手会按兜底走（`step_shapes.md` 读不到模式行时行为未定义）。
 *
 * 🔴 **恒发 `直出`**（理由见 `AUTO_CHAIN_TERMINUS`）：
 *   `直出` ⇒ 写手**跳过格子**、只出六段式正文 —— 这正是用户要看到的那一份，
 *   也是两条路**共用**的那一份。那 6 格不再是这一轮的产物，而是用户在提示词块下面
 *   点「生成宫格分镜」时由 `FillGridButtons` 另发一条锚点去要（**按需**）。
 */
export function autoNextAnchor(
  stage: StageId,
  _mode: ChainMode,
  unit?: UnitPlan | null,
): string | null {
  if (stage === AUTO_CHAIN_TERMINUS) return null;
  const idx = MAIN_CHAIN.indexOf(stage);
  if (idx < 0) return null;
  const next = MAIN_CHAIN[idx + 1];
  if (!next) return null;
  if (next === 'STEP6') {
    // 🔴 **恒发「直出」**：「先生成视频提示词让用户选择，用户选择宫格的时候，才出 6 格」。
    //    ⇒ 这一步只要**六段式正文**（两条路共用的那一份），**不要**那 6 格；
    //      6 格等用户点「生成宫格分镜」时再请写手出（见 `FillGridButtons`）。
    //    ⚠️ 因此 `mode` 形参**已无实际作用**（登记待议）：唯一消费者就是这里。
    //    ⚠️ `【单元】U1` 不是装饰：写手形状块写的是「为 `【单元】Uk` 出这份正文」，
    //      不带这一行它就只能猜 —— 这正是「多单元脚本只出 U1」的成因。
    //      自动串联的起点恒是新贴的脚本 ⇒ 恒 `U1`；后续单元由 `step6Card` 的按钮续。
    //
    //    ⚠️ **`【镜头范围】` 也要在这一轮就带上**（`unit` 由调用方用刚更新的会话算好）：
    //      第一单元由写手自己划、后面的单元由 `step6Card` 按同一套分组续 —— 两边若不同源，
    //      就会「U1 出了镜头 1-3，而按钮说下一个单元是 Shot 4-6」这种对不上的账。
    //      读不出镜头表（`unit` 为 `null`）时照旧只带 `【单元】U1`，写手按镜头表自取。
    const firstUnitRange = unit && !unit.finished ? unit.nextShots : '';
    return buildAnchor('STEP6', {
      模式: '直出',
      单元: 'U1',
      ...(firstUnitRange ? { 镜头范围: firstUnitRange } : {}),
    });
  }
  return buildAnchor(next);
}

// ══════════════════════════════════════════════════════════════════════════
// 灵感路（`💡爆款灵感`）—— **不是 STEP，但选项卡同样只由界面给**
//
// 背景（2026-10-16 走查）：`ChatInput` 的 `💡爆款灵感` 按钮还在（它把埋进 `SKILL.md`
// 〈爆款灵感模式〉的那段提示发出去），而 SKILL 的〈灵感步骤4：收尾〉要用户
// **「输入 1/2/3」** —— 那是 L 系列按钮时代的裸词，门机把裸词整套下线后就没人接：
// 用户打了 `1`，写手看到的既不是锚点、也不像脚本 ⇒ 落进 `block_critical.md [2]`
// 「其他任何输入 = STEP 0 入料」⇒ **刚出的 3 个方案原地失联**（用户报的「没反应」）。
//
// ⇒ 修法照抄 STEP 那一套：**光标在前端**。三个方案 = 三张选项卡，锚点就用老的
//   `【阶段】STEP0`（用户选的是「贴什么料进去」，不是推进到哪一步）+ 正文一行
//   「我选方案 N。」—— 那行正文正是 SKILL 让用户手打的话，**没有新增任何提示词格式**。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 灵感模式的触发词 —— 与 `SKILL.md`〈💡 爆款灵感模式〉的激活关键词**同源**。
 *
 * 🔴 两侧必须同源：写手按这些词切进灵感模式，前端就得按同一套词决定「这条回复要不要
 *    给方案卡」。SKILL 那份词表里的长词（`爆款灵感` / `给点灵感` / `帮我找灵感`）全是
 *    `灵感` 的子串，故这里只留子串 + 三个不含 `灵感` 的词；`ChatInput` 发的
 *    `💡爆款灵感：…` 命中首项。
 */
const INSPIRATION_TRIGGERS = ['💡', '灵感', '有什么好创意', '今日推荐', '搜索当前短视频热门趋势'];

/**
 * 这条**用户**消息是不是在要灵感。
 *
 * 🔴 锚点轮（选项卡自己发出去的 `【阶段】STEPn`）永远不算：用户点「方案 1」发出的正是
 *    一条锚点，不能再被当成一次新的「找灵感」。
 */
export function isInspirationTrigger(content: string): boolean {
  if (isStageAnchorMessage(content)) return false;
  return INSPIRATION_TRIGGERS.some((kw) => content.includes(kw));
}

/**
 * 这条**写手回复**长得像「3 个创意方案」吗。
 *
 * 🔴 光看用户输入不够：用户贴的脚本里出现「灵感」两个字（写产品文案时很常见）时，
 *    上面那条触发词判据会误命中，而写手这一轮**根本没进灵感模式**（它按门机出的是
 *    STEP 正文）⇒ 界面会在一份 STEP 正文下面挂三张「方案 1/2/3」。
 * ⇒ 判据取**两侧的交集**：用户确实按触发词要了灵感 **且** 这一轮回执里真有
 *    `方案 X` 编号（`SKILL.md`〈爆款灵感模式〉固定输出 `🔥 方案 X：{创意名称}`）。
 *    写手换了措辞的后果只是**退回改动前**（这一轮没有卡，写手照旧出方案、用户照旧能看），
 *    不会错挂。
 */
export function looksLikeInspirationReply(content: string): boolean {
  return /方案\s*[1-9一二三四五六七八九]/.test(content);
}

/**
 * 灵感那一屏的选项卡：「上面 3 个方案，展开哪一个」。
 *
 * 🔴 锚点 = `【阶段】STEP0` + 正文一行 —— 与 SKILL 让用户手打的「输入 1/2/3」**同义**，
 *    只是不再要求用户打字（门机之后没有哪个按钮会读裸数字）。
 * 🔴 **不带 `【模式】`**：这一步离宫格/直出的分叉还远，带上只会让写手提前跑偏。
 * 🔴 **不标「推荐」**：三个方案是并列的创意，谁都不该被强调色顶上去。
 */
export function inspirationCard(): StageCardDef {
  const plan = (n: number): StageCardOption => ({
    labelKey: 'chat.stage.plan',
    label: `方案 ${n}`,
    labelVars: { n: String(n) },
    anchor: `${buildAnchor('STEP0')}\n\n我选方案 ${n}。`,
  });
  return {
    questionKey: 'chat.stage.inspirationPick',
    question: '上面这 3 个方案，展开哪一个？',
    options: [plan(1), plan(2), plan(3)],
  };
}
