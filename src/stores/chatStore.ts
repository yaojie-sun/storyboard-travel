import { create } from 'zustand';
import {
  chatSendMessage,
  saveChatConversations,
  loadChatConversations,
  migrateChatStorage,
  recoverStrandedChat,
  backupCorruptChatFile,
  type ChatMessageDto,
  type ChatResponse,
} from '@/commands/chat';
import { useEpisodeStore } from '@/stores/episodeStore';
import { splitGridPromptIntoFrames } from '@/utils/gridPromptParser';
import { enrichGridRequest } from '@/utils/gridWindowHint';
import { buildProjectChatContext } from '@/features/chat/projectContext';
import {
  parseStageAnchor,
  autoNextAnchor,
  isInspirationTrigger,
  resolveUnitPlan,
  type StageId,
  type ChainMode,
} from '@/features/chat/stageCards';
import { parseShotTable, toSceneContext, toShotFrameMap } from '@/features/chat/shotTable';

export interface PromptBlockFrame {
  description: string;
}

export interface ShotFrameMapping {
  shot: number;
  time: string;
  frames: number[];
  camera: string;
  sound?: string;
  bgm?: string;
}

export interface ShotFrameMap {
  shots: ShotFrameMapping[];
}

export interface PromptBlock {
  id: string;
  type: 'video' | 'grid';
  content: string;
  frames?: PromptBlockFrame[];
  /** 分镜→宫格帧映射（从 AI 输出的【分镜映射】JSON 解析），仅 grid 类型可能有值 */
  shotFrameMap?: Record<string, unknown>;
  /** AI 选出的参考图编号（【选图】@图N 解析，1-based），用于宫格节点自动连线 */
  selectedRefImages?: number[];
  /** AI 输出的【故事梗概】（2-3句纯净叙事），随宫格生成注入【全局故事背景】规则块，前端不展示 */
  storySynopsis?: string;
  /** 【人物设定】（全片一段的外观锚点），注入逐格提示词的共享块前部，前端不展示 */
  characterContext?: string;
  /** 【场景描述】按 1-based 区间**展开成逐格一份**，前端不展示 */
  sceneContext?: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  promptBlocks?: PromptBlock[];
  /** L3 继续确认文本（从 AI 回复中解析的【继续确认】段），多段视频每段宫格后出现 */
  continuationPrompt?: string;
  /** 分镜→宫格帧映射（从 AI 输出的【分镜映射】JSON 解析） */
  shotFrameMap?: ShotFrameMap;
  /**
   * 🔴 **前端持有的光标**（新协议）—— 产生这条回复时，我们问的是哪一步。
   *
   * **不是**写手末尾那行 `【阶段】STEP<m>` 的建议值：光标在前端，写手只一问一答
   * （见 `@/features/chat/stageCards` 顶部说明）。`ChatPanel` 用它在气泡下渲染选项卡。
   *
   * ⚠️ **optional**：老会话没有这个字段 ⇒ 不渲染任何卡片，显示行为逐字退回改动前（§12.4）。
   */
  stage?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** 所属项目 ID —— 数据结构层面确保项目隔离，不依赖 UI 过滤逻辑 */
  projectId?: string;
  /** 所属子项目 ID */
  episodeId?: string;
}

const CHAT_STORAGE_KEY = 'storyboard-chat-conversations';
const CHAT_STORAGE_MAX_CONVERSATIONS = 100;

/** 宫格固定 6 格（2×3）—— 镜表按格展开、分镜映射兜底都用它。 */
const GRID_FRAME_COUNT = 6;

/**
 * 剥掉写手末尾那行**机器锚点** `【阶段】STEP<m>`。
 *
 * 它是「前端持有光标」那条协议的读数口（见 `@/features/chat/stageCards`）：
 * 写手写在末行、独占一行，前端读了就丢 —— **不显示、不进正文、不进节点**。
 * 与 `【分镜映射】` 同一待遇（那条是给人对账的，这条是给机器对账的，都不该出现在产物里）。
 *
 * 认不出（老会话、普通问答）就原样返回。
 */
function stripStageAnchorLine(text: string): string {
  return text
    .replace(/\n?[ \t]*【阶段】[ \t]*STEP[0-9]+(?:\.[0-9]+)?[ \t]*\n?[ \t]*$/, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * 把 STEP 2 / STEP 3 / STEP 5 的产物挂到宫格块上 —— 「**换源不换字段**」的另一半。
 *
 * 官方件不输出 `【故事梗概】` / `【人物设定】` / `【场景描述】` 三个私有块，而
 * `StoryboardGenNodeData` 与 `VideoGenDialog` **仍然要求**这四个字段
 * （`sceneContext` / `storySynopsis` / `characterContext` / `shotFrameMap`）——
 * 那是 §12.4 的核心链路（Chat → 宫格节点 → 视频节点），断不得。
 *
 * 新源就是**前端自己持有的那几轮产物**（`ChatMessage.stage` 是它们的门牌号）：
 *
 * | 字段 | 新源 |
 * |---|---|
 * | `storySynopsis`   | `stage === 'STEP2'`（故事大纲）那一条 assistant 消息 |
 * | `characterContext`| `stage === 'STEP3'`（角色清单）那一条 |
 * | `sceneContext[]`  | `stage === 'STEP5'` 的**六列镜表** → `Reference Anchors` 列，按格展开 |
 * | `shotFrameMap`    | 同上（**兜底**：写手仍出 `【分镜映射】`，那条优先，`b.shotFrameMap` 已就位） |
 *
 * 🔴 **一律 fail open**：某一轮读不到就**留空**，绝不猜、绝不抛。产物的表现是
 *    「这一轮的宫格少了场景锚点」，不是崩溃；且老会话（没有 `stage`）整条路径不命中，
 *    行为逐字退回改动前。
 */
function attachStageContext(blocks: PromptBlock[], history: ChatMessage[]): PromptBlock[] {
  if (!blocks.some((block) => block.type === 'grid')) return blocks;

  const lastAssistantOfStage = (stage: string): string => {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === 'assistant' && msg.stage === stage) return msg.content;
    }
    return '';
  };

  const storySynopsis = lastAssistantOfStage('STEP2').trim() || undefined;
  const characterContext = lastAssistantOfStage('STEP3').trim() || undefined;
  // ⚠️ 镜表要的是**剥掉锚点行之后**的原文；`lastAssistantOfStage` 返回的
  //    已经是落盘时剥好的那一份。
  const shotRows = parseShotTable(lastAssistantOfStage('STEP5'));
  const sceneContext = shotRows ? toSceneContext(shotRows, GRID_FRAME_COUNT) : undefined;
  const shotFrameMapFromTable = shotRows
    ? (toShotFrameMap(shotRows, GRID_FRAME_COUNT) as unknown as Record<string, unknown>)
    : undefined;

  return blocks.map((block) => {
    if (block.type !== 'grid') return block;
    return {
      ...block,
      storySynopsis: block.storySynopsis ?? storySynopsis,
      characterContext: block.characterContext ?? characterContext,
      sceneContext: block.sceneContext ?? sceneContext,
      // 🔴 `【分镜映射】` 优先 —— 它是产品契约（写手直接出的真划分），
      //    镜表推出来的是**兜底**（均分），只在写手漏了那一段时才顶上。
      shotFrameMap: block.shotFrameMap ?? shotFrameMapFromTable,
    };
  });
}

/** 智能裁剪：优先保留有生成内容（promptBlocks）的对话，防止付费内容被静默删除 */
function trimConversations(conversations: Conversation[], max: number): Conversation[] {
  if (conversations.length <= max) return conversations;
  // 分组：有 promptBlocks 的优先保留
  const valuable: Conversation[] = [];
  const textOnly: Conversation[] = [];
  for (const c of conversations) {
    const hasBlocks = c.messages.some((m) => m.promptBlocks && m.promptBlocks.length > 0);
    if (hasBlocks) {
      valuable.push(c);
    } else {
      textOnly.push(c);
    }
  }
  // 有价值的对话全部保留（除非超过 max）
  if (valuable.length >= max) {
    return valuable.slice(0, max);
  }
  // 剩余名额由纯文本对话按时间排序填充
  const remaining = max - valuable.length;
  return [...valuable, ...textOnly.slice(0, remaining)];
}

let filePersistTimer: ReturnType<typeof setTimeout> | null = null;
let filePending: Conversation[] | null = null;

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 🔴 写盘封锁开关。
 *
 * `safeParseConversations` 解析失败会静默回退成空列表，而 5 秒定时器保证「一定会写一次盘」
 * ⇒ 一次坏读就把那个坏文件**整量覆盖成 `[]`**，可修复变永久空。
 * 所以读坏时：① 先另存 `.corrupt-<ts>` 副本（`backupCorruptChatFile`）；
 * ② 连副本都存不下（磁盘满/无权限）就**停止一切写盘** —— 宁可这段会话不落盘，
 * 也不拿仅存的那份数据去冒险。
 */
let chatFileWriteBlocked = false;

/**
 * 安全解析 JSON。
 *
 * ⚠️ 返回值带 `corrupt` 标记：**解析失败 ≠ 没有数据**。调用方必须区分二者 ——
 * 前者要立刻备份（必要时封锁写盘），后者才是正常的空状态。
 */
function safeParseConversations(
  raw: string,
  source: string,
): { list: Conversation[]; corrupt: boolean } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid: Conversation[] = [];
      for (const c of parsed) {
        if (c && typeof c.id === 'string' && Array.isArray(c.messages)) {
          valid.push(c);
        } else {
          console.warn(`[ChatStore] ${source} 跳过格式异常的对话条目:`, c?.id ?? '(无id)');
        }
      }
      return { list: valid, corrupt: false };
    }
    // 是合法 JSON 但不是数组 ⇒ 同样是坏文件，不能当空处理
    console.error(`[ChatStore] ${source} 不是数组，按损坏处理`);
    return { list: [], corrupt: true };
  } catch (e) {
    console.error(`[ChatStore] ${source} JSON 解析失败:`, e);
    return { list: [], corrupt: true };
  }
}

/** 安全合并：按 ID 去重，同一 ID 保留消息更多的版本 */
function mergeConversations(lists: Conversation[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const conv of lists) {
    const existing = map.get(conv.id);
    if (!existing || conv.messages.length > existing.messages.length) {
      map.set(conv.id, conv);
    } else if (conv.messages.length === existing.messages.length) {
      // 消息数相同 → 保留更新时间更晚的
      if ((conv.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        map.set(conv.id, conv);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Parse grid prompts by extracting numbered frame items.
 *
 * 统一解析：识别所有编号格式（数字+顿号/点/括号/中文数字/第N格/宫格N/场景N），
 * 丢弃前言概括句，处理编号超量。详见 @/utils/gridPromptParser。
 */
function parseGridFrames(gridContent: string): PromptBlockFrame[] {
  return splitGridPromptIntoFrames(gridContent, 6)
    .map((description) => description.trim())
    .filter(Boolean)
    .map((description) => ({ description }));
}

/**
 * 官方 Full-Reference 六段式的**起始行**：`subject_definitions:` 独占一行。
 *
 * 官方把六段固定为 `subject_definitions` / `summary` / `retention_analysis` /
 * `detailed_description` / `overall_soundscape` / `non_diegetic_music`，段名独占一行、
 * 顺序固定。取**第一段**当界桩：它前面是宫格的 6 格画面描述，它及它后面**整体**就是
 * 送进视频生成的正文。
 *
 * ⚠️ 只认行首、只认这一个段名 —— 正文里偶然提到 `summary:` 不算（段名必须独占一行）。
 * 认不出返回 null，调用方回落旧标记路径（fail open）。
 */
const OFFICIAL_BODY_START_RE = /^[ \t]*subject_definitions[ \t]*:[ \t]*$/m;

/** 把官方形状的一段产出切成「宫格部分 / 正文部分」。认不出返回 null。 */
function splitOfficialOutput(content: string): { gridText: string; videoText: string } | null {
  const match = OFFICIAL_BODY_START_RE.exec(content);
  if (!match) return null;
  return {
    gridText: content.slice(0, match.index).trim(),
    videoText: content.slice(match.index).trim(),
  };
}

/** Detect whether text looks like a video prompt (has time-anchored shots). */
function looksLikeVideoPrompt(text: string): boolean {
  // H3 format: [Shot N] At MM:SS.mmm
  if (/\[\s*Shot\s+\d+\s*\]\s*At\s+\d{1,2}:\d{2}\.\d{1,3}/i.test(text)) return true;
  // 官方 Full-Reference 六段式：subject_definitions / detailed_description 同时出现
  if (OFFICIAL_BODY_START_RE.test(text) && /^[ \t]*detailed_description[ \t]*:/m.test(text)) {
    return true;
  }
  // Legacy happyhorse format: Begin with Shot 1 [0-3s], Then Shot 2 [3-8s], Cut to Shot 3 [8-12s]
  return /(?:Begin with|Then|Cut to)\s+Shot\s+\d+\s*\[\s*\d+\s*-\s*\d+\s*s\s*\]/i.test(text);
}

/** Detect whether text looks like a grid prompt (numbered shot descriptions without time anchors). */
function looksLikeGridPrompt(text: string): boolean {
  // Match at least 3 numbered items (1. 2. 3. etc.) with shot content
  const numberedLines = text.match(/^\d+[\.、\)）\s]\s*.+$/gm);
  if (!numberedLines || numberedLines.length < 3) return false;
  // Check that items describe shots: contain camera distance or composition terms
  const shotTerms = /(?:中景|近景|远景|特写|全景|面向镜头|侧身|背对|画面|背景|光线|镜头|shot|camera|frame|scene)/i;
  const shotCount = numberedLines.filter((line) => shotTerms.test(line)).length;
  return shotCount >= 3;
}

function parseShotFrameMap(text: string): ShotFrameMap | undefined {
  const mapPattern = /【分镜映射】\s*(\{[\s\S]*?\})\s*(?:$|(?=【)|(?=\*\*))/;
  const mapMatch = text.match(mapPattern);
  if (mapMatch?.[1]) {
    try {
      const parsed = JSON.parse(mapMatch[1].trim());
      if (parsed && Array.isArray(parsed.shots)) {
        return parsed as ShotFrameMap;
      }
    } catch { /* ignore malformed JSON */ }
  }
  return undefined;
}

/** 解析 AI 输出的【选图】@图N,@图M 行，返回 1-based 编号数组（去重、上限 6）。 */
function parseSelectedRefImages(text: string): number[] | undefined {
  const match = text.match(/【选图】\s*([^\n【]*)/);
  if (!match) return undefined;
  const nums = (match[1].match(/@图(\d+)/g) ?? []).map((s) => parseInt(s.slice(2), 10));
  const unique = [...new Set(nums)].filter((n) => Number.isInteger(n) && n >= 1).slice(0, 6);
  return unique.length > 0 ? unique : undefined;
}

/**
 * 解析提示词正文里的 `<Picture k>` 引用，返回 1-based 编号数组。
 *
 * 为什么需要它：写手在正文里用 `<Picture N>` 指代参考图（官方 Full-Reference 契约），
 * 但【选图】行可能被模型省略。此时正文里的 `<Picture N>` 就是「它到底用了哪几张图」的
 * 唯一证据 —— 没有【选图】时据此推断，与「以写手为准」的规则一致（正文没引用 = 不挂图）。
 *
 * 注意：与 @图N 无关。@图N 是【选图】行的交互语法，不进正文。
 */
function parsePictureNumbers(text: string): number[] | undefined {
  const nums = (text.match(/<\s*Picture[ \t]*(\d+)\s*>/gi) ?? []).map((s) =>
    parseInt(s.replace(/\D/g, ''), 10),
  );
  const unique = [...new Set(nums)]
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b)
    .slice(0, 6);
  return unique.length > 0 ? unique : undefined;
}

/**
 * 从后往前找最近一条「带选图」的 assistant 消息（最多回溯 maxLookback 条）。
 *
 * 用途：多段流程里，后续轮的提示词没写【选图】也没写 `<Picture N>` 时，
 * 继承上一轮写手的选图，避免第二段起全部丢图。
 *
 * @param messages 本轮之前已经发生过的消息（**不含**正在解析的这条）
 */
function findRecentSelectedRefImages(
  messages: ChatMessage[],
  maxLookback = 4,
): number[] | undefined {
  let checked = 0;
  for (let i = messages.length - 1; i >= 0 && checked < maxLookback; i--) {
    const msg = messages[i];
    checked++;
    if (msg.role !== 'assistant') continue;
    const found = parseSelectedRefImages(msg.content) ?? parsePictureNumbers(msg.content);
    if (found) return found;
  }
  return undefined;
}

/**
 * 读取某个块的参考图编号：优先用解析时缓存的字段，缺失则从块正文重算
 * （块正文里的 `<Picture N>`）。兼容本次改动之前持久化的旧对话 —— 那些块没有
 * selectedRefImages 字段，但正文里同样有 `<Picture N>`。
 */
export function resolveSelectedRefImages(
  // 容许 undefined：调用方常常是 `resolveSelectedRefImages(gridBlock) ?? resolveSelectedRefImages(videoBlock)`
  // 那种「两个块不一定都在」的四级链，缺块时应该安静返回 undefined，而不是逼调用方先判空。
  block: PromptBlock | undefined,
): number[] | undefined {
  if (!block) return undefined;
  return block.selectedRefImages ?? parsePictureNumbers(block.content);
}

/** 解析 AI 输出的【故事梗概】行，返回 2-3 句纯净叙事（单行）。 */
function parseStorySynopsis(text: string): string | undefined {
  const match = text.match(/(?:【故事梗概】|\*\*故事梗概\*\*)\s*([^\n【]*)/);
  if (!match || !match[1]?.trim()) return undefined;
  return match[1].trim();
}

/**
 * 解析 AI 回复，切出 video / grid 块。
 *
 * @param content AI 回复原文
 * @param inheritSelectedRefImages 前一轮写手的选图（三级兜底的最后一级）；
 *        本轮既没写【选图】也没在正文引用 `<Picture N>` 时用它。
 *
 * 🔴 参考图编号必须**视频块也带一份**。原先只有 grid 块带它，直出路因此拿不到参考图 ——
 * 直出按钮会发出 undefined，视频生成页打开时一张参考图都没勾。
 * 三级取值：显式【选图】 > 正文 `<Picture N>` > 上一轮继承。
 */
function parsePromptBlocks(
  content: string,
  inheritSelectedRefImages?: number[],
): { blocks: PromptBlock[]; continuationPrompt?: string; shotFrameMap?: ShotFrameMap } {
  const blocks: PromptBlock[] = [];
  let continuationPrompt: string | undefined;
  let shotFrameMap: ShotFrameMap | undefined;

  // ⚠️ 解析并剥离【选图】标记（独立于其他标记顺序）
  // 必须在剥离前取值；正文 `<Picture N>` 也从原文取，剥离不影响它。
  const selectedRefImages =
    parseSelectedRefImages(content) ??
    parsePictureNumbers(content) ??
    inheritSelectedRefImages;
  content = content.replace(/【选图】[^\n【]*\n?/g, '').trim();

  // ⚠️ 解析并剥离【故事梗概】行（前端隐藏，仅供宫格节点注入故事背景）
  const storySynopsis = parseStorySynopsis(content);
  content = content.replace(/(?:【故事梗概】|\*\*故事梗概\*\*)[^\n【]*\n?/g, '').trim();

  // ⚠️ Parse 【分镜映射】 BEFORE stripping 【继续确认】 — order-independent
  // If AI outputs 继续确认 before 分镜映射, parsing it first would strip the JSON.
  shotFrameMap = parseShotFrameMap(content);
  const mapIdx = content.indexOf('【分镜映射】');
  if (mapIdx >= 0) {
    const jsonStart = content.indexOf('{', mapIdx);
    if (jsonStart >= 0) {
      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
      }
      if (jsonEnd > jsonStart) {
        content = (content.slice(0, mapIdx) + content.slice(jsonEnd)).replace(/\n{3,}/g, '\n\n').trim();
      }
    }
  }

  // Strip 【继续确认】 block — it belongs to the message, not the grid
  const contPattern = /(?:【继续确认】|\*\*继续确认\*\*)\s*([\s\S]*)$/;
  const contMatch = content.match(contPattern);
  if (contMatch?.[1]?.trim()) {
    continuationPrompt = contMatch[1].trim();
    content = content.slice(0, contMatch.index).trim();
  }

  // ── 官方六段式形状（Full-Reference）────────────────────────────────────────
  // 我们保持两阶段流程（L2 只出视频提示词、点「A-生成宫格提示词」才出宫格），
  // 因此正常路径下【视频提示词】标记仍在。这里额外认两种形状作为 **fail-open**：
  //   a) 六段式独占一条回复（L2 丢了标记）
  //   b) 六格描述 + 六段式同现（模型照 Local 的习惯一次给全）
  // 认得出就**直接返回**：下面的标记式分支对官方产出一律不命中，继续往下只是白跑。
  const official = splitOfficialOutput(content);
  if (official) {
    let produced = false;
    if (official.videoText) {
      // 🔴 视频块必须也带 selectedRefImages —— 直出按钮靠它拿参考图；
      //    只给 grid 块带的话，直出会发出 undefined、弹窗一张图都不勾。
      blocks.push({
        id: generateId(),
        type: 'video',
        content: official.videoText,
        selectedRefImages,
      });
      produced = true;
    }
    if (official.gridText) {
      const frames = parseGridFrames(official.gridText);
      if (frames.length >= 2) {
        blocks.push({
          id: generateId(),
          type: 'grid',
          content: official.gridText,
          frames,
          shotFrameMap: shotFrameMap as unknown as Record<string, unknown>,
          selectedRefImages,
          storySynopsis,
        });
        produced = true;
      }
    }
    if (produced) {
      return { blocks, continuationPrompt, shotFrameMap };
    }
    // 六段式界桩命中了但两侧都没产出有效块（例如宫格只有 1 格）——继续走标记路径兜底
  }

  const videoPattern = /(?:【视频提示词】|\*\*视频提示词\*\*)\s*([\s\S]*?)(?=(?:【分镜提示词】|\*\*分镜提示词\*\*)|$)/;
  const gridPattern = /(?:【分镜提示词】|\*\*分镜提示词\*\*)\s*([\s\S]*?)$/;

  const videoMatch = content.match(videoPattern);
  const gridMatch = content.match(gridPattern);

  if (videoMatch?.[1]?.trim()) {
    let videoContent = videoMatch[1].trim();
    // Strip trailing grid question injected by AI
    videoContent = videoContent.replace(
      /[\s\n]*需要.*?宫格.*?[\s\S]*$/,
      '',
    );
    blocks.push({
      id: generateId(),
      type: 'video',
      content: videoContent,
      selectedRefImages,
    });
  } else if (!gridMatch && looksLikeVideoPrompt(content)) {
    // Fallback: AI omitted the 【视频提示词】 marker but the content
    // is recognizably a video prompt (time-anchored shot descriptions).
    let videoContent = content.trim();
    videoContent = videoContent.replace(
      /[\s\n]*需要.*?宫格.*?[\s\S]*$/,
      '',
    );
    if (videoContent) {
      blocks.push({
        id: generateId(),
        type: 'video',
        content: videoContent,
        selectedRefImages,
      });
    }
  }

  if (gridMatch?.[1]?.trim()) {
    const gridContent = gridMatch[1].trim();
    const frames = parseGridFrames(gridContent);
    blocks.push({
      id: generateId(),
      type: 'grid',
      content: gridContent,
      frames: frames.length >= 2 ? frames : undefined,
      shotFrameMap: shotFrameMap as unknown as Record<string, unknown>,
      selectedRefImages,
      storySynopsis,
    });
  }

  // Fallback: multi-segment continuation may omit 【分镜提示词】 header,
  // but the numbered shots (1. 2. 3. ...) are still valid grid content
  if (blocks.length === 0 && looksLikeGridPrompt(content)) {
    const frames = parseGridFrames(content);
    blocks.push({
      id: generateId(),
      type: 'grid',
      content: content.trim(),
      frames: frames.length >= 2 ? frames : undefined,
      shotFrameMap: shotFrameMap as unknown as Record<string, unknown>,
      selectedRefImages,
      storySynopsis,
    });
  }

  return { blocks, continuationPrompt, shotFrameMap };
}

function buildMessages(conversation: Conversation): ChatMessageDto[] {
  return conversation.messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

function persistToLocalStorage(conversations: Conversation[], projectId: string, userId?: string): void {
  if (chatFileWriteBlocked) return;
  try {
    const trimmed = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
    const payload = userId
      ? { userId, projectId, conversations: trimmed }
      : { projectId, conversations: trimmed };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error('[ChatStore] localStorage 写入失败:', e);
  }
}

async function flushFileNow(projectId: string): Promise<void> {
  if (filePersistTimer) {
    clearTimeout(filePersistTimer);
    filePersistTimer = null;
  }
  // 写盘封锁：读坏文件且连副本都存不下时，绝不拿原文件冒险（见 `chatFileWriteBlocked`）
  if (chatFileWriteBlocked) {
    filePending = null;
    return;
  }
  if (!filePending) return;
  try {
    await saveChatConversations(projectId, JSON.stringify(filePending));
  } catch (e) {
    console.error('[ChatStore] 文件持久化失败:', e);
  }
  filePending = null;
}

// 暴露到 window 供关闭时 sync_closing_overlay.js 强制 flush
if (typeof window !== 'undefined') {
  (window as any).__flushChatNow__ = () => {
    const { conversations, currentProjectId } = useChatStore.getState();
    if (conversations.length > 0) {
      filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      void flushFileNow(currentProjectId);
    }
  };
  (window as any).__flushChatNowAsync__ = async (): Promise<void> => {
    const { conversations, currentProjectId } = useChatStore.getState();
    if (conversations.length > 0) {
      filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      await flushFileNow(currentProjectId);
    }
  };
}

function schedulePersistConversations(conversations: Conversation[]): void {
  if (chatFileWriteBlocked) return;
  const state = useChatStore.getState();
  persistToLocalStorage(conversations, state.currentProjectId, state.currentUserId);
  filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
  if (filePersistTimer) {
    clearTimeout(filePersistTimer);
    filePersistTimer = null;
  }
  void flushFileNow(state.currentProjectId);
}

// Periodic safety net: flush to file every 5 seconds
if (typeof window !== 'undefined') {
  setInterval(() => {
    const { conversations, currentUserId, currentProjectId } = useChatStore.getState();
    if (conversations.length > 0) {
      persistToLocalStorage(conversations, currentProjectId, currentUserId);
      filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      void flushFileNow(currentProjectId);
    }
  }, 5_000);
}

/**
 * 对话气泡的在途阶段。
 *
 * 写手调用是**非流式**的（`endpoint.rs` 里 `"stream": false`），客户端拿不到
 * token 级信号，所以「推理中 vs 生成中」不可分；这里只报我们**确实知道**的两件事：
 * 读参考图 / 问写手。详见 `ChatBubble.tsx` 的 `PHASE_LABEL_KEY`。
 */
export type ChatPhase = 'reading' | 'thinking';

/**
 * 对话文件损坏时的告警。用**结构化**而非成品文案：
 * 文案要过 i18n，Store 不产出用户可见字符串（见 CLAUDE.md §11）。
 */
export type ChatStorageWarning =
  /** 原文件已另存一份，写盘照常 —— `path` 是副本绝对路径 */
  | { kind: 'backedUp'; path: string }
  /** 连副本都存不下 ⇒ 已停止一切写盘，宁可这段会话不落盘 */
  | { kind: 'writeBlocked' };

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  hydrated: boolean;
  currentUserId: string;
  currentProjectId: string;
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingText: string;
  /** 在途阶段；`isStreaming` 为 false 时恒为 null。 */
  streamPhase: ChatPhase | null;
  /**
   * 在途的那一**步**（`STEP0` … `STEP6`），给「思考中」显示步骤名与 `6/8` 进度。
   *
   * 🔴 存 `StageId` 而**不存文案** —— i18n 在组件层做（§11）。
   * `isStreaming` 为 false 时恒为 null。
   */
  streamingStage: StageId | null;
  /**
   * 自动串联开关。用户点「停止」会把它关掉（见 `cancelStream`），
   * 用户再手打一句话就重新打开（见 `sendMessage`）。
   */
  autoChain: boolean;
  /** 自动串联走哪条路 —— 目前只在 `STEP5.5 → STEP6` 那一行有含义。 */
  autoChainMode: ChainMode;
  error: string | null;
  projectContext: string;
  /**
   * 对话文件损坏时的用户可见警告（null = 无异常）。
   *
   * 读坏文件时**不能静默吞掉**：用户看到"聊天记录没了"却不知道为什么，
   * 而真相是原文件还在、只是我们不敢写。这里把备份路径（或封锁写盘的结论）如实摊开。
   */
  chatStorageWarning: ChatStorageWarning | null;

  hydrate: (projectId?: string) => Promise<void>;
  setChatStorageWarning: (warning: ChatStorageWarning | null) => void;
  markChatFileCorrupt: (projectId: string) => Promise<void>;
  forceRehydrate: () => Promise<void>;
  setCurrentUserId: (userId: string) => void;
  switchToProject: (projectId: string) => Promise<void>;
  createConversation: (episodeId?: string, projectId?: string) => string;
  deleteConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  sendMessage: (
    content: string,
    billingTag?: string,
    /**
     * `auto: true` = 自动串联自己发的下一步锚点，**不是**用户手打的。
     * 唯一的区别：自动轮不去动 `autoChain` 开关（否则「停止」永远停不下来）。
     */
    opts?: { auto?: boolean },
  ) => Promise<void>;
  cancelStream: () => void;
  updateMessage: (messageId: string, newContent: string) => void;
  updatePromptBlock: (
    messageId: string,
    blockId: string,
    newContent: string,
  ) => void;
  renameConversation: (id: string, title: string) => void;
  getActiveConversation: () => Conversation | undefined;
  setProjectContext: (context: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  hydrated: false,
  currentUserId: '',
  currentProjectId: '',
  isStreaming: false,
  streamingMessageId: null,
  streamingText: '',
  streamPhase: null,
  streamingStage: null,
  autoChain: true,
  autoChainMode: 'grid',
  error: null,
  projectContext: '',
  chatStorageWarning: null,

  setChatStorageWarning: (warning) => {
    set({ chatStorageWarning: warning });
  },

  /**
   * 读到损坏的对话文件时的止血动作。
   *
   * ① 先让后端把原文件**复制**一份 `.corrupt-<ts>`（只复制、不改名、不动原文件 ⇒ 不违反 §12.4）；
   * ② 副本到手 ⇒ 只报警告，之后照常写盘（原数据已有退路）；
   * ③ 副本也失败 ⇒ `chatFileWriteBlocked = true` 停掉一切写盘 ——
   *    宁可这段会话不落盘，也不拿仅存的那一份去赌。
   */
  markChatFileCorrupt: async (projectId) => {
    try {
      const path = await backupCorruptChatFile(projectId);
      console.warn('[ChatStore] 对话文件损坏，已另存副本:', path);
      set({ chatStorageWarning: { kind: 'backedUp', path } });
    } catch (e) {
      chatFileWriteBlocked = true;
      console.error('[ChatStore] 损坏对话文件备份失败 ⇒ 已停止写盘以保护原文件:', e);
      set({ chatStorageWarning: { kind: 'writeBlocked' } });
    }
  },

  setCurrentUserId: (userId) => {
    set({ currentUserId: userId });
  },

  hydrate: async (projectId) => {
    if (get().hydrated) return;

    const pid = projectId || get().currentProjectId || '';

    // ⚠️ 没有项目 id 直接返回，**不能**把 `hydrated` 烧成 true。
    // 开机顺序是「App 启动 → hydrate()（此刻还没有项目）」。若这里照旧收尾，
    // 等真正打开项目时开头的 `if (get().hydrated) return;` 会把那次 hydrate 挡在门外
    // ⇒ 已 hydrated、但一份对话都没读 ⇒ **面板永久空白**（Local 2026-09-25 的根因）。
    if (!pid) return;

    // 0) 尝试迁移旧版单文件存储（后端只跑一次）
    //    🔴 必须带上 `pid` 做兜底项目：反查不到归属的对话并入当前项目，
    //    而不是倒进没人读的 `chat/global.json`（2026-10-16 数据事故根因）。
    try {
      const result = await migrateChatStorage(pid);
      if (result !== 'no_old_file') {
        console.log('[ChatStore] 迁移旧聊天数据:', result);
      }
    } catch (e) {
      console.warn('[ChatStore] 迁移旧聊天数据失败（可忽略）:', e);
    }

    // 0.1) 一次性回捞历史事故中被写进 `chat/global.json` 的对话（后端幂等，只跑一次）
    try {
      const recovered = await recoverStrandedChat(pid);
      if (recovered !== 'no_stranded' && recovered !== 'already_recovered') {
        console.log('[ChatStore] 回捞历史对话:', recovered);
      }
    } catch (e) {
      console.warn('[ChatStore] 回捞历史对话失败（可忽略）:', e);
    }

    // 1) 从项目专属文件加载
    const loaded: Conversation[] = [];
    if (pid) {
      try {
        const raw = await loadChatConversations(pid);
        if (raw && raw !== '[]') {
          const parsed = safeParseConversations(raw, 'file');
          loaded.push(...parsed.list);
          // 坏文件必须先留副本再继续 —— 下一段任何一次写盘都会把它覆盖掉
          if (parsed.corrupt) await get().markChatFileCorrupt(pid);
        }
      } catch (e) {
        console.error('[ChatStore] 文件加载失败:', e);
      }
    }

    // 2) localStorage 作为备份
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        const envelope = JSON.parse(raw);
        if (envelope && typeof envelope === 'object' && Array.isArray(envelope.conversations)) {
          const currentUserId = get().currentUserId;
          if (currentUserId && envelope.userId && envelope.userId !== currentUserId) {
            console.warn('[ChatStore] localStorage 属于其他用户，忽略');
          } else if (pid && envelope.projectId === pid) {
            // localStorage 这一份是**内存里已 parse 成功的对象**再 stringify，不可能损坏；
            // 但仍要走同一个解析器（要它的逐条结构校验），只是不必备份。
            loaded.push(...safeParseConversations(JSON.stringify(envelope.conversations), 'localStorage').list);
          }
        }
      }
    } catch (e) {
      console.error('[ChatStore] localStorage 读取失败:', e);
    }

    // 3) 合并去重
    const merged = mergeConversations(loaded);
    // 标记中断的 AI 回复：assistant 消息 content 为空 = 在生成期间 App 关闭
    for (const conv of merged) {
      for (const msg of conv.messages) {
        if (msg.role === 'assistant' && msg.content === '') {
          msg.content = '⚠️ AI 回复中断（App 在生成期间关闭）\n请重新发送消息。';
          msg.timestamp = Date.now();
        }
      }
    }
    const existingConvs = get().conversations;
    if (existingConvs.length > 0) {
      const hasMessages = existingConvs.some((c) => c.messages.length > 0);
      if (hasMessages) {
        const allConvs = mergeConversations([...merged, ...existingConvs]);
        set({ conversations: allConvs, currentProjectId: pid, hydrated: true });
        return;
      }
    }

    const convs = trimConversations(merged, CHAT_STORAGE_MAX_CONVERSATIONS);
    set({ conversations: convs, currentProjectId: pid, hydrated: true });
  },

  forceRehydrate: async () => {
    set({ hydrated: false });
    await get().hydrate();
  },

  switchToProject: async (projectId) => {
    const state = get();
    // 保存当前项目数据
    if (state.currentProjectId && state.conversations.length > 0) {
      filePending = trimConversations(state.conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      await flushFileNow(state.currentProjectId);
      persistToLocalStorage(state.conversations, state.currentProjectId, state.currentUserId);
    }
    // 切换到新项目：重置并从文件加载（告警属于上一个项目，跟着清掉）
    set({
      conversations: [],
      activeConversationId: null,
      hydrated: false,
      currentProjectId: projectId,
      chatStorageWarning: null,
    });
    await get().hydrate(projectId);
    // 加载完成后清除过期的高亮对话
    const loaded = get().conversations;
    if (loaded.length > 0 && !loaded.some((c) => c.id === state.activeConversationId)) {
      set({ activeConversationId: loaded[0].id });
    }
  },

  createConversation: (episodeId, projectId) => {
    const id = generateId();
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
      projectId,
      episodeId,
    };

    set((state) => {
      const next = [conversation, ...state.conversations];
      schedulePersistConversations(next);
      return {
        conversations: next,
        activeConversationId: id,
        error: null,
      };
    });

    return id;
  },

  deleteConversation: (id) => {
    const { isStreaming } = get();
    if (isStreaming) {
      return;
    }

    set((state) => {
      const next = state.conversations.filter((c) => c.id !== id);
      schedulePersistConversations(next);
      return {
        conversations: next,
        activeConversationId:
          state.activeConversationId === id ? null : state.activeConversationId,
      };
    });
  },

  setActiveConversation: (id) => {
    if (get().isStreaming) {
      return;
    }
    set({ activeConversationId: id, error: null });
  },

  renameConversation: (id, title) => {
    set((state) => {
      const next = state.conversations.map((conv) =>
        conv.id === id ? { ...conv, title, updatedAt: Date.now() } : conv,
      );
      schedulePersistConversations(next);
      return { conversations: next };
    });
  },

  sendMessage: async (content, billingTag, opts) => {
    let { activeConversationId, conversations, isStreaming, projectContext } = get();
    // Auto-create conversation on first send if none is active
    if (!activeConversationId) {
      const epStore = useEpisodeStore.getState();
      const epId = epStore.currentEpisodeId ?? undefined;
      // 从 episode 反查 projectId
      let prjId: string | undefined;
      if (epId) {
        for (const [pid, eps] of Object.entries(epStore.episodesByProject)) {
          if (eps.some((e) => e.id === epId)) {
            prjId = pid;
            break;
          }
        }
      }
      activeConversationId = get().createConversation(epId, prjId);
      conversations = get().conversations;
    }
    if (isStreaming) {
      return;
    }

    // 用户**手动**发的消息 = 重新开串联（点了停止之后想接着跑，直接发一句就行）。
    // 自动轮自己发的（`opts.auto`）不动这个开关 —— 否则「停止」永远停不下来。
    if (!opts?.auto && !get().autoChain) {
      set({ autoChain: true });
    }

    const convIndex = conversations.findIndex(
      (c) => c.id === activeConversationId,
    );
    if (convIndex < 0) {
      return;
    }

    const conversation = conversations[convIndex];
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };

    const updatedMessages = [...conversation.messages, userMessage];
    const updatedConversation: Conversation = {
      ...conversation,
      title:
        conversation.messages.length === 0
          ? content.slice(0, 30) + (content.length > 30 ? '...' : '')
          : conversation.title,
      messages: updatedMessages,
      updatedAt: Date.now(),
    };

    const nextConversations = [...conversations];
    nextConversations[convIndex] = updatedConversation;

    const assistantMessageId = generateId();

    // Create a placeholder assistant message BEFORE API call so if the app
    // is killed during streaming, we retain at least an empty assistant marker
    // that hydrate can detect and flag to the user.
    const placeholderAssistant: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    const conversationWithPlaceholder: Conversation = {
      ...updatedConversation,
      messages: [...updatedMessages, placeholderAssistant],
      updatedAt: Date.now(),
    };
    const nextWithPlaceholder = [...conversations];
    nextWithPlaceholder[convIndex] = conversationWithPlaceholder;

    // 「思考中」要显示**这一步叫什么**（用户定调）。锚点从消息首行读；用户直接贴脚本时
    // 读不到锚点 ⇒ 按协议恒落到 STEP 0（`block_critical.md` 的 `[4] 其他任何输入`）。
    // 发「暂停」时不显示步骤名（它不是一步）。
    const pendingStage: StageId | null = content.trim().startsWith('暂停')
      ? null
      : (parseStageAnchor(content) ?? 'STEP0');

    set({
      conversations: nextWithPlaceholder,
      isStreaming: true,
      streamingMessageId: assistantMessageId,
      streamingText: '',
      streamPhase: 'reading',
      streamingStage: pendingStage,
      error: null,
    });

    schedulePersistConversations(nextWithPlaceholder);

    try {
      // 生成时读图：触发分镜生成前，补读缺失参考图描述（缓存复用，只读一次）
      let context = projectContext;
      try {
        const fresh = await buildProjectChatContext(get().currentProjectId, {
          readIfMissing: true,
        });
        if (fresh) context = fresh;
      } catch {
        // 读图失败不阻塞生成
      }

      // 素材读完 ⇒ 进「问写手」这一段。写手调用是这里唯一的长耗时等待，
      // 气泡从「正在读参考图」切到「正在思考」就是这一刻。
      set({ streamPhase: 'thinking' });

      // 宫格那一轮把 6 个时间窗一并下发（见 `@/utils/gridWindowHint`）。
      // 只改这份 **wire** 消息；store 里的会话历史仍记用户发的是原话，
      // 所以回炉时可以把这段原文原样重发给模型，而用户界面不受影响。
      const wireMessages = buildMessages(updatedConversation);
      const lastWire = wireMessages[wireMessages.length - 1];
      if (lastWire?.role === 'user') {
        const prev = conversation.messages[conversation.messages.length - 1];
        lastWire.content = enrichGridRequest(
          lastWire.content,
          prev?.role === 'assistant' ? prev.content : '',
          null,
        );
      }

      const response: ChatResponse = await chatSendMessage(
        wireMessages,
        context || undefined,
        billingTag,
      );

      const state = get();
      const currentConvIndex = state.conversations.findIndex(
        (c) => c.id === activeConversationId,
      );
      if (currentConvIndex < 0) {
        set({
          isStreaming: false,
          streamingMessageId: null,
          streamingText: '',
          streamPhase: null,
          streamingStage: null,
        });
        return;
      }

      const currentConv = state.conversations[currentConvIndex];
      // 本轮之前的写手选图（本轮既没写【选图】也没引用 <Picture N> 时继承）
      const placeholderIdx = currentConv.messages.findIndex(
        (m) => m.id === assistantMessageId,
      );
      const inheritedRefImages = findRecentSelectedRefImages(
        placeholderIdx >= 0 ? currentConv.messages.slice(0, placeholderIdx) : [],
      );

      // 🔴 光标在前端（`stageCards` 顶部说明）：这条回复挂的是**我们刚才问的那一步**，
      //    而不是写手末尾那行 `【阶段】STEP<m>` 的建议值。写手只会一问一答，
      //    它写错了也只是把光标带偏一格，不会把整条链带跑。
      //    首条消息（用户直接贴脚本）没有锚点 ⇒ 路由恒落到 STEP 0。
      const askedStage = content.trim().startsWith('暂停')
        ? undefined
        : (parseStageAnchor(content) ?? 'STEP0');

      // 显示、落节点、送出视频的必须是**同一份**（§12.4）：锚点行在这里就剥掉，
      // 后面所有消费方拿到的都是剥好的那一份，不可能错位。
      const displayedText = stripStageAnchorLine(response.text);

      // Replace placeholder content with actual AI response
      const updatedMessages: ChatMessage[] = currentConv.messages.map((msg) => {
        if (msg.id !== assistantMessageId) return msg;
        const { blocks, continuationPrompt, shotFrameMap } = parsePromptBlocks(
          displayedText,
          inheritedRefImages,
        );
        // 「换源不换字段」：宫格块缺的 sceneContext / storySynopsis / characterContext
        // 由 STEP2 / STEP3 / STEP5 那几轮产物补上（见 `attachStageContext`）。
        const replyBlocks = attachStageContext(blocks, currentConv.messages);
        return {
          ...msg,
          content: displayedText,
          timestamp: Date.now(),
          promptBlocks: replyBlocks.length > 0 ? replyBlocks : undefined,
          continuationPrompt,
          shotFrameMap,
          stage: askedStage,
        };
      });

      const finalConversation: Conversation = {
        ...currentConv,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };

      const finalConversations = [...state.conversations];
      finalConversations[currentConvIndex] = finalConversation;

      schedulePersistConversations(finalConversations);
      set({
        conversations: finalConversations,
        isStreaming: false,
        streamingMessageId: null,
        streamingText: '',
        streamPhase: null,
        streamingStage: null,
      });

      // ── 自动串联 ──────────────────────────────────────────────────────────
      // 用户定调：「我们串联步骤，用户输入脚本后，左下的思考中，就提示每一步的名称就行，
      // 直到第六步，出提示词即可」。⇒ 跑完一步就自动发下一步的锚点，**0 次点击**。
      //
      // 停的条件集中在 `autoNextAnchor`（到 `STEP6` 停 / 不在主链上停）；
      // 这里再补两条运行时的 —— 用户中途点了停止、或已经有人在跑。
      const chained = get();
      // 🔴 `resolveUnitPlan(updatedMessages)` 是承重的，不是顺手多传一个参数：
      //    `STEP5.5 → STEP6` 这一跳要在锚点里带上**第一单元的镜头范围**，
      //    而那个范围只能从**刚落盘**的镜头表（`updatedMessages`，含这一步的产物）算出来。
      //    这里传的是 `updatedMessages` 而**不是** `get().conversations` —— 后者还没包含
      //    刚才这条回复（它在下面那个 `set` 里才写进去）。
      // 🔴 **灵感轮不续链**。用户点 `💡爆款灵感` 发出去的那句没有锚点 ⇒ `askedStage`
      //    落到 `STEP0` ⇒ 照旧会一路串到 `STEP6`：写手会**替用户把方案挑掉**，
      //    刚出的 3 个方案下面直接压着一份出片提示词，而「展开哪个方案」这一步没了。
      //    ⇒ 灵感那轮把选择权交回用户（方案卡，见 `stageCards.inspirationCard`）。
      //
      //    ⚠️ 判据与 `ChatPanel` 的 `chainContinues`（`!isInspirationReply`）**必须同口径**：
      //      一边续一边不续，卡片要么被吞掉、要么闪一帧就被下一轮替换。
      //    ⚠️ 用户点「方案 N」发出的是**锚点**，`isInspirationTrigger` 对它返回 `false`
      //       ⇒ 从这一步起照旧自动串链（与 SKILL 里「选完进入标准工作流程」一致）。
      const nextAnchor =
        chained.autoChain && askedStage && !isInspirationTrigger(content)
          ? autoNextAnchor(
              askedStage,
              chained.autoChainMode,
              resolveUnitPlan(updatedMessages),
            )
          : null;
      if (nextAnchor) {
        // 下一帧再发：让上面这次 `set`（`isStreaming: false` + `streamingStage: null`）
        // 先渲染完，否则「思考中」那一行看不到换文案的中间态。
        window.setTimeout(() => {
          const s = useChatStore.getState();
          if (!s.autoChain || s.isStreaming) return;
          // 自动串链的续步统一带 `prompt_continue`：自有网关按此标记计 0 积分
          // （价目见服务器 `backend/app/api/endpoints/gateway.py` 的 billing_tag 分支）。
          // 一条提示词 = 8 次网关调用（STEP0→STEP6 自动串链），只该按第一步收 1 分。
          void s.sendMessage(nextAnchor, 'prompt_continue', { auto: true });
        }, 0);
      }
    } catch (error) {
      // Tauri 的 `invoke` 在命令返回 `Err(String)` 时，reject 出来的是**字符串**
      // 而不是 Error 实例。原先这里只认 Error，于是真实错因被替换成无信息的兜底文案，
      // 每次排查都得反过来去服务器日志里捞。字符串原样接住，拿不到才兜底。
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string' && error.trim()
            ? error
            : '发送消息失败';
      set({
        isStreaming: false,
        streamingMessageId: null,
        streamingText: '',
        streamPhase: null,
        streamingStage: null,
        error: message,
      });
      // 🔴 出错**不续**下一环：让用户看到错误、决定是重试还是改脚本。
      //    （续下去的话，错误会被下一个自动轮的成功掩盖掉一半。）
    }
  },

  cancelStream: () => {
    set({
      isStreaming: false,
      streamingMessageId: null,
      streamingText: '',
      streamPhase: null,
      streamingStage: null,
      // 🔴 点停止 = 关掉自动串联。「串联」不等于「停不下来」——
      //    不关这一位的话，本轮收尾那个 `setTimeout` 会把下一步照发出去。
      autoChain: false,
      error: '已取消',
    });
  },

  updateMessage: (messageId, newContent) => {
    set((state) => {
      const next = state.conversations.map((conv) => ({
        ...conv,
        messages: conv.messages.map((msg, msgIndex) => {
          if (msg.id !== messageId) return msg;
          // 继承前几轮写手的选图（编辑重解析后同样不能丢图）
          const inheritedRefImages = findRecentSelectedRefImages(
            conv.messages.slice(0, msgIndex),
          );
          // 用户手改正文后重解析 —— 与收尾那一处同源：锚点行同样要剥掉。
          const text = stripStageAnchorLine(newContent);
          const { blocks, continuationPrompt, shotFrameMap } = parsePromptBlocks(
            text,
            inheritedRefImages,
          );
          const replyBlocks = attachStageContext(
            blocks,
            conv.messages.slice(0, msgIndex),
          );
          return {
            ...msg,
            content: text,
            promptBlocks: replyBlocks.length > 0 ? replyBlocks : undefined,
            continuationPrompt,
            shotFrameMap,
          };
        }),
      }));
      schedulePersistConversations(next);
      return { conversations: next };
    });
  },

  updatePromptBlock: (messageId, blockId, newContent) => {
    set((state) => {
      const next = state.conversations.map((conv) => ({
        ...conv,
        messages: conv.messages.map((msg) => {
          if (msg.id !== messageId || !msg.promptBlocks) {
            return msg;
          }
          return {
            ...msg,
            promptBlocks: msg.promptBlocks.map((block) =>
              block.id === blockId
                ? { ...block, content: newContent, frames: block.type === 'grid' ? parseGridFrames(newContent) : block.frames }
                : block,
            ),
          };
        }),
      }));
      schedulePersistConversations(next);
      return { conversations: next };
    });
  },

  getActiveConversation: () => {
    const { activeConversationId, conversations } = get();
    if (!activeConversationId) {
      return undefined;
    }
    return conversations.find((c) => c.id === activeConversationId);
  },

  setProjectContext: (context) => {
    set({ projectContext: context });
  },
}));
