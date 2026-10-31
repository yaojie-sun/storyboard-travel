import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Film, ImagePlus, Sparkles, X, FolderOpen, Upload, LoaderCircle, Minus } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useAssetStore } from '@/stores/assetStore';
import { resolveImageDisplayUrl, imageUrlToDataUrl } from '@/features/canvas/application/imageData';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { bananaSubmitVideoJob, bananaPollVideoJob, bananaCheckCredits, bananaReportUsage, bananaRefundCredits, bananaVideoQueueStatus, bananaCancelQueuedVideoJob } from '@/commands/ai';
import { enhanceVideo, enhanceVideoAi, probeSrCapability, type SrCapability } from '@/commands/enhance';

/** 本地增强目标：短边 1536（2K 档，1344×768 → 2688×1536）；两条链路共用同一档位 */
const LOCAL_ENHANCE_SHORT_EDGE = 1536;
import { RechargeDialog } from '@/components/RechargeDialog';
import { UiModal, UiChipButton } from '@/components/ui';
import { StoryboardPromptPicker } from './StoryboardPromptPicker';
import { useVideoGenStore } from './videoGenStore';
import { VideoGenDock, VideoGenToast } from './VideoGenDock';
import { deriveDockSubtitle } from './dockTitle';
import { inferRefTypes, REF_TYPE_LABELS } from './refTypes';
import { auditAndFixDTags, rememberDTagAudit, summarizeDTagAudit } from './dTagAudit';
import { fetchVideoGenRules, type VideoGenRuleMode } from './videoGenRules';
import { looksChineseWritten, prepareVideoPromptForSubmit } from '@/commands/translateDisplay';
import { looksGeneratedPrompt } from './promptShapeCheck';
import {
  ASPECT_RATIO_OPTIONS,
  VIDEO_DURATION_OPTIONS,
  MAX_REFERENCE_IMAGES,
  computeVideoCost,
  type VideoDuration,
  type VideoResolution,
} from './videoPricing';

/**
 * 视频模型对 prompt 的硬上限：`Params [Prompt], should be in [1, 7000]`。
 * 超限 = 直接 RetCode 220 提交失败（任务不建），所以拼装后必须兜住。
 * 留 100 字余量。
 */
const VIDEO_PROMPT_MAX_CHARS = 6900;

/**
 * 上游的**绝对硬限**（模型侧 `[1, 7000]`）。
 *
 * 6900 是客户端自己留余量的安全线（超了砍规则头块）；7000 是模型真的不接的那条线 ——
 * 拼装完还超过它，就**不发请求、不扣费**，直接让用户缩减提示词（2026-10-28 用户定调）。
 */
const PROMPT_HARD_LIMIT = 7000;

/**
 * 超限时规则头的**块丢弃顺序**（先丢最不影响的）。
 *
 * 规则头由若干 `【…】` 块组成，`【】` 之前的引子块名字为空串。超限时整块丢弃，
 * **绝不句中腰斩** —— 旧实现是 `slice(0, budget)`，一刀切在中间，丢掉的恰好是排在
 * 后面的块，等于把最需要约束的部分删干净、留下最泛的部分。
 *
 * 🔴 2026-10-28 用户裁定：**规则头整段删除**（线上 version 16 起 `prompt_rule` 为空串）。
 * 理由成立且已核对：正文本身就是按 H3 官方标准产出的六段式 —— `<Picture N>` /
 * `<d>[Language]` / retention 标记 / 画外音官方英文句 / 双引号可见文字，全部写在
 * 正文里；规则头说的每一件事都能在正文里逐字找到，是**同一件事的第二个真相源**。
 * 第二个真相源只会漂移（最近一次：头里写「正文用中文」、正文已经改成英文）。
 * 因此这里保留 `assembleVideoPrompt` 与丢块逻辑，只作为**万一将来又要加一句时的
 * 安全阀**：`rule` 为空串时原样返回正文，不走任何裁剪分支。
 */
const RULE_DROP_ORDER: string[] = [];

/** 按 `【…】` 把规则头切成块；`【】` 之前的引子归为名字为空串的一块 */
function splitRuleBlocks(rule: string): { name: string; text: string }[] {
  return rule
    .split(/(?=【)/)
    .filter((p) => p.length > 0)
    .map((text) => {
      const m = /^【([^】]*)】/.exec(text);
      return { name: m ? m[1] : '', text };
    });
}

/**
 * 规则头 + 正文拼装，保证不越过服务端硬限（`Params [Prompt], should be in [1, 7000]`）。
 * 规则头只是「保险」，六段正文才是正片 —— 超限时只动规则头，**绝不裁用户正文**。
 */
function assembleVideoPrompt(rule: string, body: string, reserve = 0): string {
  if (!rule) return body;

  const budget = VIDEO_PROMPT_MAX_CHARS - body.length - 2 - reserve;
  if (budget <= 0) {
    // 正文本身就把额度吃光了：规则头全长也比截断强不了，直接省掉并留痕
    console.warn(`[VideoGenDialog] 正文 ${body.length} 字已超出视频模型上限，省略规则头`);
    return body;
  }
  if (rule.length <= budget) return `${rule}\n\n${body}`;

  let blocks = splitRuleBlocks(rule);
  const total = () => blocks.reduce((n, b) => n + b.text.length, 0);

  for (const name of RULE_DROP_ORDER) {
    if (total() <= budget) break;
    const before = blocks.length;
    blocks = blocks.filter((b) => b.name !== name);
    if (blocks.length < before) {
      console.warn(`[VideoGenDialog] 规则头超预算 ${budget} 字，已丢弃【${name}】块`);
    }
  }

  let effectiveRule = blocks.map((b) => b.text).join('');
  if (effectiveRule.length > budget) {
    // 丢到没得可丢还超 ⇒ 才硬截断（正常不该走到这里）
    console.warn(
      `[VideoGenDialog] 规则头丢块后仍超预算 ${budget} 字（现 ${effectiveRule.length}），已硬截断`,
    );
    effectiveRule = effectiveRule.slice(0, budget);
  }
  return effectiveRule ? `${effectiveRule}\n\n${body}` : body;
}

interface ReferenceImage {
  id: string;
  url: string;
  rawUrl: string;
}

interface ReferenceVoice {
  id: string;
  url: string;
  rawUrl: string;
  fileName: string;
  /** 这段声音属于谁（项目资产里的「人物」名，或手填）。空表示不绑定角色。 */
  character?: string;
  /** 前端探测到的时长（秒），仅用于「合计 ≤15 秒」的本地拦截；后端会重新探测 */
  durationSecs?: number;
}

/**
 * 音色参考入口开关。
 * 2026-10-28 已接通：H3 官方 r2va 支持参考音频（content[] 里 type=audio_url / role=reference_audio），
 * 前端把音频转成 DataURL 交给后端，后端按官方规格校验后放进 content[]。
 *
 * 官方规格（MiniMax H3 · POST /v2/video_generation）：
 * - 格式 WAV / MP3；单文件 ≤ 15 MB；单段时长 2–15 秒；最多 3 段；总时长 ≤ 15 秒
 * 🔴 持久化：新字段 `referenceVoices`（可选）承载多段；旧的 `referenceVoice` 仍照旧写/读第一段，
 *    回填优先新字段、缺失时回落旧字段 —— 老项目数据不改也能正常回填（§12.4）。
 */
const VOICE_REF_UI_ENABLED = true;

/** 音色参考的官方硬限制（前端先拦一道，后端 video_voice_ref.rs 再校验一次） */
const VOICE_REF_MAX_BYTES = 15 * 1024 * 1024;
const VOICE_REF_MIN_SECS = 2;
const VOICE_REF_MAX_SECS = 15;
const VOICE_REF_MAX_COUNT = 3;
const VOICE_REF_TOTAL_SECS = 15;
const VOICE_REF_ACCEPT = 'audio/wav,audio/mpeg,audio/mp3,.wav,.mp3';
/**
 * 画幅 chip 的 **title 提示**文案 key。
 *
 * chip 里面只画比例数字（五个挤一行，带「横屏/竖屏」后缀会撑破按钮），
 * 悬停时再用这句解释这个比例是横是竖 —— 所以这里仍要走 i18n，英文界面不能出中文。
 */
const ASPECT_LABEL_KEYS: Record<string, string> = {
  '9:16': 'videoGen.aspect.portrait',
  '16:9': 'videoGen.aspect.landscape',
  '1:1': 'videoGen.aspect.square',
  '4:3': 'videoGen.aspect.landscape43',
  '3:4': 'videoGen.aspect.portrait34',
};

/** 换行、空白都清掉，避免角色名把提示词行撑破 */
function sanitizeCharacterName(name: string | undefined): string | undefined {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 24) : undefined;
}

/**
 * 名字比对用的归一化：去掉括注（「孙二娘（孙总）」→「孙二娘」）、空白、常见标点，统一小写。
 * 人物资产名由用户自己起，写手按剧本写人名，两边常常差一个括注或一个空格。
 */
function normalizeVoiceName(text: string): string {
  return text
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·・\-—_：:、，,。.]+/g, '')
    .toLowerCase();
}

/**
 * 角色名 → `<Subject N>`（音频归属按官方 §2.4 的标签写法给后端）。
 *
 * 🔴 必须在**回译之前**解析：正文一旦译成英文，中文角色名往往只剩 `<d>` 台词里的那一次出现，
 *    后端再按名字找标签就会张冠李戴（实测把「孙二娘」的声线绑到了演播厅 `<Subject 3>` 上）。
 *    这里在（中文）正文的 `subject_definitions` 段里按名字找标签；找不到原样返回，
 *    旁白（画外音）由后端按官方措辞识别，实在对不上的由后端退回 `the target speaker`。
 */
function resolveVoiceSubject(content: string, name: string | undefined): string | undefined {
  const clean = sanitizeCharacterName(name);
  if (!clean) return undefined;
  const start = content.indexOf('subject_definitions:');
  if (start < 0) return clean;
  const nexts = ['summary:', 'retention_analysis:', 'detailed_description:']
    .map((header) => content.indexOf(header, start + 1))
    .filter((index) => index > start);
  const end = nexts.length > 0 ? Math.min(...nexts) : content.length;
  const key = normalizeVoiceName(clean);
  if (key.length >= 2) {
    for (const line of content.slice(start, end).split('\n')) {
      const label = /<(Subject\s+\d+)>/.exec(line);
      if (label && normalizeVoiceName(line).includes(key)) return `<${label[1]}>`;
    }
  }
  return clean;
}

/** 只认官方允许的 WAV / MP3 */
function isAllowedVoiceFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith('.wav') || name.endsWith('.mp3')) return true;
  return (
    file.type === 'audio/wav' ||
    file.type === 'audio/wave' ||
    file.type === 'audio/x-wav' ||
    file.type === 'audio/mpeg' ||
    file.type === 'audio/mp3'
  );
}

/** 读本地音频时长（秒）；读不出来返回 null，交给后端 ffmpeg 与上游兜底 */
function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const seconds = audio.duration;
      done(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    };
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

interface ReferenceImage {
  id: string;
  url: string;
  rawUrl: string;
}

interface ReferenceVoice {
  id: string;
  url: string;
  rawUrl: string;
  fileName: string;
}

interface DialogPayload {
  nodeId: string | null;
  initialImages: ReferenceImage[];
  initialGridFrames: string[];
  shotFrameMap?: Record<string, unknown>;
  /**
   * 规则用途。由落点节点类型推导：
   * - `videoGenNode`（chat 页「直接生成视频」建的节点）→ `direct`：参考图是独立资产，无宫格时间线
   * - 其余（宫格/导出节点）→ `grid`：参考图是 1 张 6 宫格故事板
   */
  mode: VideoGenRuleMode;
  /** 小窗标题行第一排：该节点在画布上的标题。**纯显示字段** —— 不落盘、不进 store、
   *  不进 `imagePool`（§12.4 的冻结区一个字节都没碰），只为让外层渲染完成提示条时
   *  知道「是哪一单完成了」（多窗并存时只报「视频生成完成」用户对不上号）。 */
  title?: string;
  /** 小窗标题行第二排：这一单的内容摘要（摘不出来 ⇒ `undefined` ⇒ 整行不渲染）。 */
  subtitle?: string;
}

// ── Outer shell — only event listener, NO store subscriptions ──

/**
 * 解析视频生成错误码，返回用户友好提示。
 * 频率最高：绿网（内容安全审核），需突出显示。
 */
function translateVideoError(errorMsg: string): { title: string; detail: string } {
  const msg = errorMsg || '';
  // 本地操作（超分等）的错误直接透传，不走云端错误翻译
  if (msg.startsWith('[LOCAL]')) {
    return { title: '本地处理失败', detail: msg.slice(7).trim() };
  }
  // —— 本机并发排队（必须排在关键词扫描之前）——
  // 文案里刻意不含 安全/参数/额度/限流/超时/网络 等词，否则会被下面的规则抢走。
  if (msg.startsWith('QUEUE_FULL:')) {
    return { title: '同时生成的任务较多', detail: msg.slice('QUEUE_FULL:'.length).trim() };
  }
  if (msg.startsWith('QUEUE_TIMEOUT:')) {
    return { title: '排队等待结束', detail: msg.slice('QUEUE_TIMEOUT:'.length).trim() };
  }
  // 音色参考不合规（WAV/MP3、≤15MB、2–15 秒），后端在扣费前就拦掉了
  if (msg.startsWith('VOICE_REF:')) {
    return { title: '音色参考不可用', detail: msg.slice('VOICE_REF:'.length).trim() };
  }
  const lower = msg.toLowerCase();

  // —— 内容安全审核（最高频） ——
  const 绿网Keywords = [
    '安全', '策略', '未通过', '审核', '违规', '敏感', '不合规',
    'contentnotpass', 'content_filter', 'safety', 'blocked',
    'green net', 'greennet', '100008', '100009', '100010',
    'moderation', 'rejected',
  ];
  if (绿网Keywords.some(k => lower.includes(k))) {
    return {
      title: '内容安全审核未通过',
      detail: '本次生成的视频画面触发了网络安全审核。请返回Chat修改分镜提示词，调整画面描述后重新生成宫格图，再试一次。\n\n常见触发场景：裸露、血腥暴力、政治敏感、枪支武器、成人用品等。',
    };
  }

  // —— 速率限制 ——
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('限流') || lower.includes('throttl')) {
    return {
      title: '请求过于频繁',
      detail: '服务器限流中，请等待30秒后再试。积分已保留，不会重复扣费。',
    };
  }

  // —— 参数错误 ——
  if (lower.includes('invalidparameter') || lower.includes('参数')) {
    return {
      title: '视频参数有误',
      detail: '视频生成参数不合法。可能是分辨率、时长或参考图格式异常。请检查配置后重试。若持续出现，请联系客服。',
    };
  }

  // —— 额度不足 ——
  if (lower.includes('quota') || lower.includes('insufficient_quota') || lower.includes('额度')) {
    return {
      title: 'API 额度不足',
      detail: '服务端API资源包已用完，请联系管理员充值后重试。',
    };
  }

  // —— 服务端错误 ——
  if (lower.includes('internal') || lower.includes('500')) {
    return {
      title: '服务器繁忙',
      detail: '视频生成服务暂时异常，请稍后重试。积分已返还。',
    };
  }

  // —— 网络/超时 ——
  if (lower.includes('timeout') || lower.includes('超时') || lower.includes('network') || lower.includes('网络')) {
    return {
      title: '网络连接异常',
      detail: '视频生成超时或网络中断，请检查网络后重试。积分已返还。',
    };
  }

  // —— 未知错误（显示原始信息） ——
  return {
    title: '视频生成失败',
    detail: msg.trim() || '未知错误，请稍后重试。',
  };
}

/** 槽位表在 `nodeId` 为空时的兜底 key（见外层槽位表）。不可能与真实节点 id 相撞。 */
const NO_NODE_KEY = '__videogen_no_node__';

/** 槽位表与小窗数组共用的**去重键**。两处必须是同一个函数 ——
 *  不一致会让「同一个节点挂两个内层实例」从缝里漏回来。 */
function slotKeyOf(p: DialogPayload): string {
  return p.nodeId ?? NO_NODE_KEY;
}

/**
 * 数组里替换/移除某个作业（按键匹配），**保持其余项的位置不变**。
 *
 * 🔴 **「命中则原地替换、不搬到队尾」是承重的，别改成 remove+push。**
 * 小窗卡片是 `createPortal` 投进容器的，而 React 对 portal 的处理是
 * **只追加到容器末尾、重排数组不会移动已挂载的 portal** ⇒
 * **DOM 顺序 ≡ 各卡片的挂载顺序，不是数组顺序**。
 * 只有「已存在就不重新挂载」才能让这两者永远一致；一旦改成「先删后加」，
 * 同一张卡会重新挂载（顺带 abort 它的轮询，正是本次要修的缺陷）并跳到末尾，
 * 于是数组说一套、屏幕上摆另一套。
 */
function replaceSlot(list: DialogPayload[], p: DialogPayload): DialogPayload[] {
  const key = slotKeyOf(p);
  const at = list.findIndex((item) => slotKeyOf(item) === key);
  if (at < 0) return [...list, p];
  const next = [...list];
  next[at] = p;
  return next;
}

function removeSlot(list: DialogPayload[], p: DialogPayload): DialogPayload[] {
  const key = slotKeyOf(p);
  return list.filter((item) => slotKeyOf(item) !== key);
}

export function VideoGenDialog() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [payload, setPayload] = useState<DialogPayload>({ nodeId: null, initialImages: [], initialGridFrames: [], mode: 'grid' });
  /**
   * 「缩小」后的**后台作业槽位**。**每个作业一格**（不是单个）。
   *
   * 🔴 它们不是第二个弹窗，而是**同一批内层实例的第二种形态**：内层在 docked 形态下
   * **保持挂载**，所以轮询、`videoUrl`、生成阶段、已用时长全部原地保留，
   * 展开回来与缩小前逐字一致（CLAUDE.md §12.4）。详见 `VideoGenDock.tsx` 文件头。
   *
   * 🔴 **必须是数组，不能是单个槽位**：单槽会让先前那个作业的 key 从表里消失 ⇒
   * React 卸载它的内层 ⇒ 它的清理函数 `abort()` 掉轮询 ⇒ **成片不下载落盘**。
   * 所以数组化是**修缺陷**，不是加功能。
   *
   * **去重键 = `nodeId ?? NO_NODE_KEY`**：一个 nodeId 只能有一个内层实例，
   * 否则同一个 taskId 会被两条轮询各跑一遍、视频下载两遍。
   */
  const [docks, setDocks] = useState<DialogPayload[]>([]);
  /** 完成提示条属于**哪一个作业**（键同 `docks`）。`null` = 不显示提示条。
   *  多窗之下「完成的是哪一个」必须精确，不能是一个布尔值。 */
  const [toastKey, setToastKey] = useState<string | null>(null);
  /** 右侧小窗列的宿主元素。卡片用 `createPortal` 投进这里 ——
   *  **为什么不直接把卡片嵌进这个容器的 React 子树**：那会让元素换父节点 ⇒ 重新挂载
   *  ⇒ 正好复现上面那个「轮询被 abort」的缺陷。portal 只挪 DOM，不挪 React 树。 */
  const [dockCol, setDockCol] = useState<HTMLDivElement | null>(null);

  // `handleOpen` 定义在下面那个 `useEffect(…, [])` 里 —— 它闭包捕获的是**首次渲染**的
  // state。所有需要读「当前值」的地方一律走 ref。
  // ⚠️ 槽位数组**不需要** ref：所有读写都走函数式 `setDocks(prev => …)`。
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  useEffect(() => {
    const unsubscribe = canvasEventBus.subscribe('video-gen-dialog/open', (p) => {
      handleOpen(p);
    });
    return unsubscribe;

    async function handleOpen(p: any) {
      const seen = new Set<string>();
      const images: ReferenceImage[] = [];
      const addImage = (rawUrl: string) => {
        if (!rawUrl || seen.has(rawUrl)) return;
        seen.add(rawUrl);
        images.push({
          id: `ref-${images.length}`,
          rawUrl,
          url: resolveImageDisplayUrl(rawUrl),
        });
      };

      const allNodes = useCanvasStore.getState().nodes;
      const allEdges = useCanvasStore.getState().edges;
      const clickedNode = allNodes.find((n: any) => n.id === p.nodeId);
      let gridFrames: string[] = [];
      let gridImageUrl: string | undefined;
      let shotFrameMap: Record<string, unknown> | undefined;
      let isStoryboardComposite = false;
      if (clickedNode) {
        const d = clickedNode.data as any;
        gridImageUrl = d.imageUrl || d.previewImageUrl;
        shotFrameMap = d.shotFrameMap;
        isStoryboardComposite =
          clickedNode.type === CANVAS_NODE_TYPES.storyboardGen ||
          d.resultKind === 'storyboardGenOutput';

        // Extract per-frame grid prompts from node data (StoryboardGenNodeData.frames)
        if (Array.isArray(d.frames)) {
          gridFrames = d.frames
            .map((f: any) => f.description?.trim())
            .filter((s: string) => s && s.length > 0);
        }

        // If no frames on this node, trace edges back to find the source StoryboardGenNode
        if (gridFrames.length === 0 && clickedNode.type === 'exportImageNode') {
          // Find incoming edge: which node connects TO this export node
          const incomingEdge = allEdges.find((e: any) => e.target === p.nodeId);
          if (incomingEdge) {
            const sourceNode = allNodes.find((n: any) => n.id === incomingEdge.source);
            if (sourceNode && Array.isArray((sourceNode.data as any).frames)) {
              // 老项目里导出节点可能没有 `resultKind`：按入边源节点类型补判一次
              isStoryboardComposite =
                isStoryboardComposite ||
                sourceNode.type === CANVAS_NODE_TYPES.storyboardGen;
              gridFrames = ((sourceNode.data as any).frames as any[])
                .map((f: any) => f.description?.trim())
                .filter((s: string) => s && s.length > 0);
              // Also pull shotFrameMap from the source StoryboardGenNode
              if (!shotFrameMap) {
                shotFrameMap = (sourceNode.data as any).shotFrameMap;
              }
            }
          }
        }

        // 直接调入宫格图作为参考图，不分割
        if (gridImageUrl) {
          addImage(gridImageUrl);
        } else {
          (p.images || []).forEach((url: string) => addImage(url));
          if (d.previewImageUrl) addImage(d.previewImageUrl);
          if (d.imageUrl && d.imageUrl !== d.previewImageUrl) addImage(d.imageUrl);
        }
      } else {
        (p.images || []).forEach((url: string) => addImage(url));
      }

      setPayload({
        nodeId: p.nodeId ?? null,
        initialImages: images.slice(0, 5),
        initialGridFrames: gridFrames,
        shotFrameMap,
        mode:
          clickedNode?.type === CANVAS_NODE_TYPES.videoGen || !isStoryboardComposite
            ? 'direct'
            : 'grid',
      });
      // 用户又点了**同一个**节点的「生成」：弹窗形态会覆盖侧栏形态（见下面的槽位表），
      // 实例本来就不会重挂载，但小窗数组里会残留一份过期 payload ——
      // 不清掉的话，等弹窗一关就会冒出一个陈旧的侧栏。
      // ⚠️ 只清**这一个**节点的那格，其余小窗（别的作业）不能受牵连。
      // 键一律走 `slotKeyOf`（不写 `item.nodeId !== p.nodeId`）：`nodeId` 为 null 时
      // 两种写法碰巧等价，但**五处调用点必须共用一个键函数**，否则漏一处就漏一个实例。
      setDocks((prev) => prev.filter((item) => slotKeyOf(item) !== (p.nodeId ?? NO_NODE_KEY)));
      setIsOpen(true);
    }
  }, []);

  const handleClose = useCallback(() => setIsOpen(false), []);

  /** 弹窗标题栏的「缩小」——把当前 payload 存进小窗数组，弹窗收起。内层**不卸载**。
   *  ⚠️ 命中已存在的那一格时**原地替换、保持位置**（不搬到队尾）：多窗并存时，
   *     用户「展开 A 再缩小 A」不该让 A 的小窗跳到最后 —— 那是没有理由的视觉位移。 */
  const handleMinimize = useCallback((p: DialogPayload) => {
    setDocks((prev) => replaceSlot(prev, p));
    setIsOpen(false);
  }, []);

  /** 小窗的「展开 / 查看」——把**这一格**搬回弹窗。**同一个 nodeId ⇒ 同一个 key ⇒
   *  不重挂载**，所以进度、参考图、参数全部原样。
   *  🔴 **绝不能走 `handleOpen` 重新解析**：`handleOpen` 每次实时读
   *     `data.frames[].description` / `shotFrameMap` / 在边回溯。用户在缩小期间改了逐格描述
   *     或删了连线，复用它会**展开回来的参考图与逐格描述就和生成时不一致** —— 直接踩
   *     §12.4「打开视频生成页看到的必须和生成时一模一样」。⇒ `payload` 是「挂载时那一份」
   *     的存档，这里**原样恢复**；`handleOpen` 只服务「用户点了生成」这一条路径。
   *  ⚠️ 参数是内层当场给的 `currentPayload`（不是从数组里捞的陈旧值），
   *     所以「点哪一格展开哪一格」是精确的。 */
  const handleExpand = useCallback((p: DialogPayload) => {
    setDocks((prev) => removeSlot(prev, p));
    setPayload(p);
    setToastKey(null);
    setIsOpen(true);
  }, []);

  /** 内层报告「作业从进行中变成了已结束且无错」。只在用户没盯着弹窗时才提示。
   *  ⚠️ 参数是 `nodeId`（内层 prop，调用点作用域内已有）—— 不是 `payload`：
   *     那条 effect 的依赖数组在 `currentPayload` 定义**之前**求值，引用它会 TDZ。 */
  const handleJobComplete = useCallback((nodeId: string | null) => {
    if (!isOpenRef.current) setToastKey(nodeId ?? NO_NODE_KEY);
  }, []);

  /** 关掉**某一格**小窗。作业本身仍在 Rust 侧跑，`pendingTaskId` 早已随 `saveConfig` 落盘
   *  ⇒ 重新打开该节点会走既有的续接路径。与今天点 X 的语义完全一致。 */
  const handleDockClose = useCallback((p: DialogPayload) => {
    setDocks((prev) => removeSlot(prev, p));
  }, []);

  /** 关掉提示条。
   *  ⚠️ **必须用 `useCallback` 包住，不能现写一个内联箭头。**
   *     `VideoGenToast` 的 10 秒定时器把 `onDismiss` 放进了依赖数组 ⇒ 内联箭头每次
   *     宿主渲染都换身份 ⇒ 定时器被清掉重排 ⇒ **提示条被无限续命、永远不自动消失**。
   *     多窗之后宿主渲染比单窗时频繁得多（任一格增减都要重渲），这个毛病会被放大。
   *     `setToastKey` 本身是稳定的，所以这个回调的身份也是恒定的。 */
  const handleToastDismiss = useCallback(() => setToastKey(null), []);

  /** 提示条上的「查看」。找不到那一格（用户已经关掉它的小窗）就**不渲染按钮**——
   *  这是 `VideoGenDock.tsx` 里 `VideoGenToast.onExpand` 那段注释的既有约定。 */
  const toastPayload = toastKey === null ? null : docks.find((d) => slotKeyOf(d) === toastKey) ?? null;

  // 槽位表：**每个 nodeId 至多一个内层实例**。
  // ⚠️ 同一个 nodeId 两边都有时，**弹窗形态覆盖侧栏形态** —— 否则同一个节点会挂两个实例，
  //    对同一个 taskId 跑两条轮询、把同一个视频下载两遍。**写序是承重的，别调换。**
  const slots = new Map<string, { payload: DialogPayload; variant: 'dialog' | 'docked' }>();
  for (const d of docks) slots.set(slotKeyOf(d), { payload: d, variant: 'docked' });
  // 兜底 key：`nodeId` 理论上必非空（四个事件源都带 nodeId），但旧代码
  // `if (!isOpen) return null` 在 nodeId 为空时照样能开弹窗 —— 槽位表不能比它更窄。
  if (isOpen) slots.set(slotKeyOf(payload), { payload, variant: 'dialog' });

  return (
    <>
      {/* 🔴 小窗列的宿主：**常驻挂载**，不随 `slots` / `docks` 的有无装卸。
          理由：容器若与第一张小窗在同一帧挂载，portal 目标首帧是 `null` ⇒ 闪一下。
          空着时它高度为 0（`flex-col` 无子项），不遮挡也不吃点击，代价只是一个空 div。
          🔴 **不给它 `pointer-events-none`**：它的盒子恰好等于小窗自己占的那条，
             没有「看不见却吃掉点击」的区域；保持默认 `auto` 才能让鼠标落在卡片之间的
             `gap-3` 上时**滚轮仍能滚动侧栏**。
          ⚠️ `pb-2` + `[scrollbar-gutter:stable]`：前者给 `overflow` 留出阴影 ink 空间，
             后者防止第 4 张卡出现时宽度跳 7px。 */}
      <div
        ref={setDockCol}
        className="ui-scrollbar fixed right-4 top-16 z-40 flex max-h-[calc(100vh-5rem)] w-[280px] flex-col gap-3 overflow-y-auto pb-2 [scrollbar-gutter:stable]"
      />
      {[...slots].map(([nid, slot]) => (
        <VideoGenDialogInner
          // 🔑 `key` 必须是 **nodeId**，两件事同时靠它成立：
          //    ① 「弹窗 ↔ 侧栏」换形态不换实例 ⇒ 轮询/成片/阶段原地保留（§12.4 要的正是这个）；
          //    ② 换节点时**真重挂载** —— 这是必需的：`seededRef` 只跑一次且不随 nodeId 重置，
          //       而 `nodeIdRef` 在渲染期就指向新节点，不重挂载会让 A 的提示词/成片被写进
          //       B 的 `configs[nodeId]`。
          //    这个 key 是**承重结构**，不是给 React 消警告用的，别删。
          key={nid}
          nodeId={slot.payload.nodeId}
          initialImages={slot.payload.initialImages}
          initialGridFrames={slot.payload.initialGridFrames}
          shotFrameMap={slot.payload.shotFrameMap}
          mode={slot.payload.mode}
          variant={slot.variant}
          dockContainer={dockCol}
          onClose={handleClose}
          onMinimize={handleMinimize}
          onExpand={handleExpand}
          onDockClose={handleDockClose}
          onJobComplete={handleJobComplete}
        />
      ))}
      {toastKey !== null && (
        <VideoGenToast
          // 写明是哪一单完成了 —— 多窗并存时只报「视频生成完成」用户对不上号。
          // `title` 由内层算出（已在 payload 里），拿不到就退回不带名字的文案。
          message={
            toastPayload?.title
              ? t('videoGen.completedToastNamed', { title: toastPayload.title })
              : t('videoGen.completedToast')
          }
          onExpand={
            toastPayload
              ? () => {
                  setToastKey(null);
                  handleExpand(toastPayload);
                }
              : undefined
          }
          onDismiss={handleToastDismiss}
        />
      )}
    </>
  );
}

// ── Inner dialog — all store subscriptions, only mounted when open ──

const EMPTY_ASSETS: any[] = [];

function VideoGenDialogInner({
  nodeId,
  initialImages,
  initialGridFrames,
  shotFrameMap: _shotFrameMap, // 保留但不再注入图N引用
  mode,
  variant,
  dockContainer,
  onClose,
  onMinimize,
  onExpand,
  onDockClose,
  onJobComplete,
}: {
  nodeId: string | null;
  initialImages: ReferenceImage[];
  initialGridFrames: string[];
  shotFrameMap?: Record<string, unknown>;
  mode: VideoGenRuleMode;
  /** `dialog` = 完整弹窗；`docked` = 缩小后的右侧侧栏。**同一实例的两种形态**，
   *  由外层用 `key = nodeId` 保住「换形态不换实例」。 */
  variant: 'dialog' | 'docked';
  /** docked 形态下卡片要 portal 进去的宿主（外层常驻的那个右侧列）。见 `VideoGenDock.tsx`。 */
  dockContainer?: HTMLElement | null;
  onClose: () => void;
  onMinimize: (payload: DialogPayload) => void;
  /** 带 payload：多窗并存时「展开哪一格」必须精确，不能再让外层去猜。 */
  onExpand: (payload: DialogPayload) => void;
  /** 关掉**这一格**小窗。与 `onClose` 分开：docked 形态下弹窗本来就是关着的，
   *  用 `onClose` 会落在「把已经关了的弹窗再关一次」上，等于没反应。 */
  onDockClose: (payload: DialogPayload) => void;
  /** 只传 `nodeId`（不传 payload）：调用点那条 effect 的依赖数组在 `currentPayload`
   *  定义之前求值，引用它会 TDZ。见外层 `handleJobComplete`。 */
  onJobComplete: (nodeId: string | null) => void;
}) {
  const { t } = useTranslation();
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const assets = useAssetStore((s) => (currentProjectId ? s.getAssets(currentProjectId) : EMPTY_ASSETS));
  // 音色归属候选：项目资产里「人物」分类的名字 + 「旁白（画外音）」，单选。
  // 短视频一般就一两个人物，逐个列出来让用户点选，不让人手打。
  const voiceOwnerOptions = useMemo(
    () => {
      const names = Array.from(new Set(
        assets
          .filter((a) => a.category === 'character')
          .map((a) => (a.name || '').trim())
          .filter((name) => name.length > 0),
      ));
      return [...names, t('videoGen.voiceOwnerNarrator')];
    },
    // t 随语言切换变化，切换语言后按钮文案要跟着变
    [assets, t],
  );
  const loadAssets = useAssetStore((s) => s.loadAssets);
  const saveConfig = useVideoGenStore((s) => s.saveConfig);
  const addToHistory = useVideoGenStore((s) => s.addToHistory);
  const forcePersistVideoGen = useVideoGenStore((s) => s.forcePersist);

  // Subscribe to store so savedConfig reactively updates after hydration
  const savedConfig = useVideoGenStore((s) => (nodeId ? s.configs[nodeId] : null) ?? null);
  const hydrated = useVideoGenStore((s) => s._hydrated);

  // Sync saved config into local state
  // seededRef 标记"已完成种子化检查"，无论有无已存 config 都要置 true，
  // 这样才能让 auto-save 在新节点（无历史 config）场景下正常启动。
  const seededRef = useRef(false);
  useEffect(() => {
    // DEBUG: 简洁对比
    try {
      const allConfigKeys = Object.keys(useVideoGenStore.getState().configs ?? {});
      console.log('[VideoGenDialog][DEBUG] nodeId:', nodeId, 'savedConfig:', !!savedConfig);
      console.log('[VideoGenDialog][DEBUG] config keys 前5:', allConfigKeys.slice(0, 5));
      console.log('[VideoGenDialog][DEBUG] nodeId在configKeys中?', nodeId ? allConfigKeys.includes(nodeId) : false);
      console.log('[VideoGenDialog][DEBUG] configKeys总数:', allConfigKeys.length);
    } catch {};
    if (!hydrated) return;
    if (seededRef.current) return;
    seededRef.current = true;
    if (!savedConfig) return;
    if (savedConfig.prompt) {
      setPrompt(savedConfig.prompt);
      // 只有**我们生成的**六段式正文才锁；用户自己打的字，第二次打开照样能改。
      setPromptLocked(looksGeneratedPrompt(savedConfig.prompt));
    }
    if (savedConfig.aspectRatio) setAspectRatio(savedConfig.aspectRatio);
    if (savedConfig.duration) setDuration(savedConfig.duration);
    if (savedConfig.videoUrl) setVideoUrl(savedConfig.videoUrl);
    if (savedConfig.pendingTaskId) setPendingTaskId(savedConfig.pendingTaskId);
    if (savedConfig.pendingCreditsDeducted) setCreditsDeducted(savedConfig.pendingCreditsDeducted);
    if (savedConfig.referenceImageUrls?.length && initialImages.length === 0) {
      setReferenceImages(savedConfig.referenceImageUrls);
    }
    // 音色参考回填：优先多段新字段，缺失时回落旧的单段字段（老项目数据不改也能回填）
    if (savedConfig.referenceVoices?.length) {
      setReferenceVoices(savedConfig.referenceVoices);
    } else if (savedConfig.referenceVoice) {
      setReferenceVoices([savedConfig.referenceVoice]);
    }
    if (savedConfig.gridFrames?.length && initialGridFrames.length === 0) {
      setGridFrames(savedConfig.gridFrames);
    }
  }, [hydrated, savedConfig]);

  // 参考图：有宫格图传入时直接覆盖，不合并旧缓存
  const initRefImages = useMemo(() => {
    if (initialImages.length > 0) return initialImages;
    const saved = savedConfig?.referenceImageUrls;
    return saved && saved.length > 0 ? saved : [];
  }, [savedConfig?.referenceImageUrls, initialImages]);

  const [aspectRatio, setAspectRatio] = useState('9:16');
  // 分辨率固定 720P（2026-10-13 下线 1080P，选择器一并移除）。仍会写进配置与提交参数，
  // 因为后端 `quality` 字段要用它；但它已不再参与计价。
  const [resolution] = useState<VideoResolution>('720P');
  const [duration, setDuration] = useState<VideoDuration>(4);
  // 视频模型固定为 MiniMax H3（compshare 直连）。
  // 旧存档里的历史模型名不会在此被改写，仅在用户改动参数触发自动保存时惰性升级。
  const [videoModel] = useState<string>('minimax/minimax-h3');
  const [prompt, setPrompt] = useState('');
  /**
   * `prompt` 是**唯一真相源**：`saveConfig` / 历史 / `finalPrompt` 都取它；
   * 送视频模型的英文只在点「生成视频」那一刻由英文闸门产出（`prepareVideoPromptForSubmit`：
   * 中文回译 / 英文原地整理，两条都过同一套官方 A 档判据）。
   *
   * 🔴 2026-10-31 用户定调：**老的正文一律不管**。写手现在出的正文本来就是中文 ⇒ 正常情况下
   *    这里永远是中文；正文是英文的只可能是 2026-10-28 之前的老项目，那就**原样显示、只读**。
   *    不翻译、不校正、不打任何网关 —— 整条数据流除 H3 提交那一刻外没有翻译。
   *
   * `promptLocked` = 这份提示词由脚本生成（不是用户自己敲的）。
   */
  const [promptLocked, setPromptLocked] = useState(false);
  const promptIsChinese = useMemo(() => (prompt.trim() ? looksChineseWritten(prompt) : false), [prompt]);
  const [gridFrames, setGridFrames] = useState<string[]>(initialGridFrames);

  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>(initRefImages);
  // 音色参考：最多 3 段，每段可绑定一个角色（官方 r2va）。第一段同时写进旧的单段字段。
  const [referenceVoices, setReferenceVoices] = useState<ReferenceVoice[]>([]);
  // 音色参考的本地校验提示（格式/体积/时长），只影响上传入口，不写入任何持久化
  const [voiceError, setVoiceError] = useState<string | null>(null);

  /**
   * 选文件 → 前端按官方规格先拦一道（WAV/MP3、≤15MB、单段 2–15 秒、最多 3 段、合计 ≤15 秒）。
   * 后端 `video_voice_ref.rs` 会再校验一次（含 ffmpeg 探时长），这里只是省掉一次无效提交。
   */
  const handleAddVoice = () => {
    if (referenceVoices.length >= VOICE_REF_MAX_COUNT) {
      setVoiceError(t('videoGen.voiceCountError', { max: VOICE_REF_MAX_COUNT }));
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = VOICE_REF_ACCEPT;
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (!isAllowedVoiceFile(file)) {
        setVoiceError(t('videoGen.voiceFormatError'));
        return;
      }
      if (file.size > VOICE_REF_MAX_BYTES) {
        setVoiceError(t('videoGen.voiceSizeError'));
        return;
      }
      const seconds = await readAudioDuration(file);
      if (seconds !== null && (seconds < VOICE_REF_MIN_SECS || seconds > VOICE_REF_MAX_SECS)) {
        setVoiceError(t('videoGen.voiceDurationError', { seconds: seconds.toFixed(1) }));
        return;
      }
      // 总时长 ≤15 秒（官方上限）。时长读不出来的段不计入，交给后端 ffmpeg 兜底。
      const knownTotal = referenceVoices.reduce((sum, v) => sum + (v.durationSecs ?? 0), 0);
      if (seconds !== null && knownTotal + seconds > VOICE_REF_TOTAL_SECS + 0.05) {
        setVoiceError(t('videoGen.voiceTotalDurationError', { max: VOICE_REF_TOTAL_SECS }));
        return;
      }
      setVoiceError(null);
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setReferenceVoices((prev) => [
          ...prev,
          {
            id: `voice-${Date.now()}-${prev.length}`,
            rawUrl: dataUrl,
            url: dataUrl,
            fileName: file.name,
            durationSecs: seconds ?? undefined,
          },
        ]);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // 本地路径需转为 Tauri asset URL 才能在 webview 中播放
  const displayVideoUrl = useMemo(() => {
    if (!videoUrl) return null;
    if (videoUrl.startsWith('http')) return videoUrl;
    return convertFileSrc(videoUrl);
  }, [videoUrl]);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [creditsDeducted, setCreditsDeducted] = useState<number>(0);

  // 任何参数变化时自动持久化（统一入口，避免多个 effect 互相覆盖）
  // 首次挂载时跳过：等 state 从 savedConfig 种子化完成后再启用，防止空默认值覆盖已有数据
  const autoSaveArmedRef = useRef(false);
  useEffect(() => {
    if (!nodeIdRef.current) return;
    if (!autoSaveArmedRef.current) {
      // 种子化完成后才启用自动保存
      if (hydrated && seededRef.current) {
        autoSaveArmedRef.current = true;
      }
      return;
    }
    const timer = setTimeout(() => {
      // 防止空配置覆盖已有数据：无 prompt、无 videoUrl、无进行中任务时不保存
      if (!prompt.trim() && !videoUrl && !pendingTaskId) return;
      // 合并已有配置，防止本地 null 值覆盖存储中已有数据
      var existingCfg = useVideoGenStore.getState().configs[nodeIdRef.current!];
      saveConfig(nodeIdRef.current!, {
        prompt,
        aspectRatio,
        resolution,
        duration,
        videoModel,
        videoUrl: videoUrl ?? existingCfg?.videoUrl,
        referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
        // 音色参考：新数组是权威源；旧的单段字段继续写第一段（向后兼容老版本读取）
        referenceVoice: referenceVoices[0] ?? undefined,
        referenceVoices: referenceVoices.length > 0 ? referenceVoices : undefined,
        pendingTaskId: pendingTaskId ?? existingCfg?.pendingTaskId,
        pendingCreditsDeducted: creditsDeducted || existingCfg?.pendingCreditsDeducted,
        gridFrames: gridFrames.length > 0 ? gridFrames : existingCfg?.gridFrames,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, aspectRatio, duration, videoModel, videoUrl, referenceImages, referenceVoices, pendingTaskId, creditsDeducted, saveConfig, hydrated]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  // 'localQueue' = 本机 KEY 池排队（与上游的 'queued' 语义不同：这里是**还没扣费**）
  const [generationPhase, setGenerationPhase] = useState<'queued' | 'generating' | 'localQueue' | null>(null);
  /** 本机排队时排在自己前面的数量（仅展示） */
  const [queueAhead, setQueueAhead] = useState(0);
  const [isLocalEnhancing, setIsLocalEnhancing] = useState(false);
  const [localEnhanceProgress, setLocalEnhanceProgress] = useState(0);
  /** 本机 AI 超分能力：null = 还在探测。探不到就只用快速档，用户不需要做任何选择 */
  const [srCap, setSrCap] = useState<SrCapability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const submitParamsRef = useRef<{ aspectRatio: string; duration: number; videoModel: string; refUrls: string[]; negativePrompt?: string } | null>(null);
  const retryCountRef = useRef(0);
  /** 本机排队凭据：非空表示「正在排队、还没拿到槽位、也没扣费」 */
  const queueTokenRef = useRef<string | null>(null);
  const executeGenerateRef = useRef<((queueToken?: string) => Promise<void>) | null>(null);
  const [showPromptPicker, setShowPromptPicker] = useState(false);
  // @图 picker 已移除：分镜提示词不可手动修改
  const showPromptPickerRef = useRef(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  /** 参考图点击放大：存的是已解析好的展示 URL，null = 未打开 */
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // 参考图放大层：Esc 关闭
  useEffect(() => {
    if (!previewImageUrl) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPreviewImageUrl(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [previewImageUrl]);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showInsufficientDialog, setShowInsufficientDialog] = useState(false);
  const [insufficientRequired, setInsufficientRequired] = useState(0);
  const [insufficientCurrent, setInsufficientCurrent] = useState(0);
  const [showRecharge, setShowRecharge] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const [assetPickerSelected, setAssetPickerSelected] = useState<Set<string>>(new Set());
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const nodeIdRef = useRef(nodeId);
  nodeIdRef.current = nodeId;

  showPromptPickerRef.current = showPromptPicker;

  // ── 轮询任务直到完成或失败 ──
  const startPolling = useCallback(async (taskId: string, _isResume: boolean, deducted: number = 0, modelName?: string) => {
    // 先中止已有的轮询，防止并发
    if (pollAbortRef.current) {
      pollAbortRef.current.abort();
    }
    const POLL_INTERVAL = 3000;
    const MAX_POLL_MS = 100 * 60 * 1000; // 100 minutes
    const startTime = Date.now();
    const controller = new AbortController();
    pollAbortRef.current = controller;

    try {
      while (true) {
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        if (controller.signal.aborted) return;

        try {
          const pollResult = await bananaPollVideoJob(taskId, deducted, modelName);
          if (controller.signal.aborted) return;
          if (pollResult.status === 'succeeded' && pollResult.videoUrl) {
            setVideoUrl(pollResult.videoUrl);
            // 自动下载视频到本地，优先使用本地路径
            let localVideoPath = pollResult.videoUrl;
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              localVideoPath = await invoke<string>('download_video_to_local', {
                url: pollResult.videoUrl,
                filename: `video_${Date.now()}.mp4`,
              });
              console.log('[VideoGenDialog] video saved to:', localVideoPath);
            } catch (downloadErr) {
              console.warn('[VideoGenDialog] auto-download failed:', downloadErr);
            }
            // 生成完成后自动本地超分到 2K，失败则回退原视频
            const finalVideoPath = await autoEnhanceTo2K(localVideoPath);
            setVideoUrl(finalVideoPath);
            const config = {
              prompt: prompt.trim() || '',
              aspectRatio,
              duration,
              videoModel,
              videoUrl: finalVideoPath,
              referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
              referenceVoice: referenceVoices[0] ?? undefined,
              referenceVoices: referenceVoices.length > 0 ? referenceVoices : undefined,
              gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
            };
            if (nodeIdRef.current) {
              saveConfig(nodeIdRef.current, config);
              addToHistory(nodeIdRef.current, config, taskId);
              // 视频生成成功，立即持久化到本地文件
              forcePersistVideoGen().catch((e) => console.warn('[VideoGenDialog] force persist failed:', e));
              // 更新画布节点数据，让视频在节点上可见
              try {
                useCanvasStore.getState().updateNodeData(nodeIdRef.current, {
                  generatedVideoUrl: finalVideoPath,
                });
              } catch { /* non-critical */ }
            }
            setIsGenerating(false);
            setIsResuming(false);
            bananaReportUsage({ api_type: 'minimax_h3', is_success: true, cost_credits: deducted, response_time_ms: Date.now() - startTime, category: 'video_generation', image_size: aspectRatio, duration_seconds: duration, prompt_len: prompt.length, error_message: '' }).catch(() => {});
            return;
          }
          if (pollResult.status === 'failed' || pollResult.status === 'retry') {
            setError(pollResult.error || t('videoGen.generationFailed', '视频生成失败，积分已返还，请稍后重试'));
            if (nodeIdRef.current) {
              saveConfig(nodeIdRef.current, {
                prompt: prompt.trim() || '',
                aspectRatio,
                duration,
                videoModel,
                pendingTaskId: undefined,
                pendingCreditsDeducted: undefined,
                referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
                referenceVoice: referenceVoices[0] ?? undefined,
                referenceVoices: referenceVoices.length > 0 ? referenceVoices : undefined,
                gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
              });
            }
            setIsGenerating(false);
            setIsResuming(false);
            return;
          }
          // 区分排队中 vs 生成中，驱动前端提示文案
          if (pollResult.status === 'queued') {
            setGenerationPhase('queued');
          } else {
            setGenerationPhase('generating');
          }
          // running → continue polling
          // 后端可能在 polling 中返回 error 字段（如网络波动），记录日志帮助排查
          if (pollResult.error) {
            console.warn('[VideoGenDialog] poll returned running with error:', pollResult.error);
          }
          if (Date.now() - startTime > MAX_POLL_MS) {
            // 超时退费
            if (deducted > 0) {
              bananaRefundCredits(deducted, `video_timeout:${modelName || 'unknown'}`).catch(() => {});
            }
            setError(t('videoGen.pollTimeout', '视频生成超时，积分已返还，请稍后重试'));
            setIsGenerating(false);
            setIsResuming(false);
            bananaReportUsage({ api_type: 'minimax_h3', is_success: false, cost_credits: deducted, response_time_ms: Date.now() - startTime, category: 'video_generation', image_size: aspectRatio, duration_seconds: duration, prompt_len: prompt.length, error_message: 'timeout' }).catch(() => {});
            return;
          }
        } catch (e) {
          // 网络错误退费
          if (deducted > 0) {
            bananaRefundCredits(deducted, `video_network_error:${modelName || 'unknown'}`).catch(() => {});
          }
          setError(t('videoGen.networkError', '网络异常，积分已返还，请检查网络后重试'));
          setIsGenerating(false);
          setIsResuming(false);
          bananaReportUsage({ api_type: 'minimax_h3', is_success: false, cost_credits: deducted, response_time_ms: Date.now() - startTime, category: 'video_generation', image_size: aspectRatio, duration_seconds: duration, prompt_len: prompt.length, error_message: 'network_error' }).catch(() => {});
          return;
        }
      }
    } finally {
      if (pollAbortRef.current === controller) {
        pollAbortRef.current = null;
      }
    }
  }, [prompt, aspectRatio, duration, referenceImages, saveConfig, addToHistory, t]);

  // ── 本机 KEY 池排队：轮询凭据状态，轮到自己才重发提交 ──
  //
  // 为什么不在后端命令里等着：关掉小窗/关主窗口（进程 exit）时没有任何回调能保证执行，
  // 长 await 排队会变成「钱扣了、任务跑了、前端已经不在了」。所以排队阶段**不扣费**，
  // 由前端主动轮询；一停（关窗、崩溃、进程退出）租约 12 秒到期，什么都没占。
  const startQueueWait = useCallback(async (token: string) => {
    const QUEUE_POLL_INTERVAL = 3000;
    // 排队自带上限（MAX_POLL_MS 只管「已提交后」的轮询，管不到排队阶段）
    const MAX_QUEUE_MS = 30 * 60 * 1000;
    const startTime = Date.now();
    const controller = new AbortController();
    pollAbortRef.current = controller;

    const abandon = (message: string) => {
      queueTokenRef.current = null;
      setGenerationPhase(null);
      setQueueAhead(0);
      setIsGenerating(false);
      setError(message);
    };

    try {
      while (true) {
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, QUEUE_POLL_INTERVAL));
        if (controller.signal.aborted) return;

        let st;
        try {
          st = await bananaVideoQueueStatus(token);
        } catch (e) {
          // 网络抖动：继续轮询（真正放弃由租约过期后的 gone 兜底）
          console.warn('[VideoGenDialog] queue status failed:', e);
          continue;
        }
        if (controller.signal.aborted) return;

        if (st.state === 'ready') {
          // 轮到自己了 → 用同一个凭据重发提交；只有这一次会真正占槽 + 扣费
          setQueueAhead(0);
          setGenerationPhase('generating');
          await executeGenerateRef.current?.(token);
          return;
        }
        if (st.state === 'gone') {
          abandon(t('videoGen.queueTimeout', '排队已失效，请重新点击生成'));
          return;
        }
        setQueueAhead(st.ahead ?? 0);

        if (Date.now() - startTime > MAX_QUEUE_MS) {
          bananaCancelQueuedVideoJob(token).catch(() => {});
          abandon(t('videoGen.queueTimeout', '排队等待超时，请稍后重试'));
          return;
        }
      }
    } finally {
      if (pollAbortRef.current === controller) {
        pollAbortRef.current = null;
      }
    }
  }, [t]);

  // 重进页面时：有 pendingTaskId 但无 videoUrl → 自动续接
  useEffect(() => {
    const pid = savedConfig?.pendingTaskId;
    if (pid && !savedConfig?.videoUrl) {
      console.log('[VideoGenDialog] resuming pending task:', pid);
      const savedModel = savedConfig?.videoModel ?? '';
      // 历史模型名（已下线）：其任务在旧通道上，用当前通道轮询必然 404。
      // 只清任务号，其它字段一律不写 —— 保护历史数据不被改写（§12.4）。
      if (savedModel.includes('happyhorse')) {
        console.log('[VideoGenDialog] legacy model task, clearing pendingTaskId only');
        setPendingTaskId(null);
        return;
      }
      // PixVerse/BP tasks expire across sessions — don't auto-resume
      // 只有非 resumable 模型的 tsk- 任务才会跨会话过期。
      // MiniMax H3 用 tsk- 前缀 — 必须自动续接。
      if (pid.startsWith('tsk-') && !savedModel.includes('minimax')) {
        console.log('[VideoGenDialog] skipping non-resumable task resume (expires across sessions)');
        setPendingTaskId(null);
        return;
      }
      const resumeModel = savedModel.includes('minimax') ? 'minimax/minimax-h3' : undefined;
      setIsResuming(true);
      setIsGenerating(true);
      startPolling(pid, true, savedConfig?.pendingCreditsDeducted ?? 0, resumeModel);
    }
    // 组件卸载时中止轮询，防止旧轮询循环在后台继续运行
    return () => {
      if (pollAbortRef.current) {
        pollAbortRef.current.abort();
        pollAbortRef.current = null;
      }
      // 排队中关小窗：主动交还排队凭据（**未扣费**，纯释放）。
      // 已经有 taskId 时 queueTokenRef 已被清空 ⇒ 绝不会动正在跑的任务，
      // 守住「关小窗不杀作业」的既有契约。
      const qt = queueTokenRef.current;
      if (qt) {
        queueTokenRef.current = null;
        bananaCancelQueuedVideoJob(qt).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectPrompt = useCallback((selectedPrompt: string, frames?: string[]) => {
    // 去除 @图N 引用——C1 Fusion 模式使用宫格图作参考，@图N 语法无效
    const cleaned = selectedPrompt.replace(/@图\d+[的所示中指]*/g, '').replace(/  +/g, ' ').trim();
    setPrompt(cleaned);
    // 从分镜提取来的一律是生成结果 ⇒ 锁；万一提取到的是用户别处贴的散文，则不锁。
    setPromptLocked(looksGeneratedPrompt(cleaned));
    if (frames?.length) setGridFrames(frames);
    setShowPromptPicker(false);
  }, []);

  // handlePromptChange 和 handlePromptKeyDown 已移除：分镜提示词不可手动修改

  // ── 添加参考图菜单 ──

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (addMenuRef.current?.contains(event.target as Node)) return;
      setAddMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [addMenuOpen]);

  const handleLocalUpload = useCallback(async () => {
    setAddMenuOpen(false);
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newImages: ReferenceImage[] = paths.map((path) => ({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        rawUrl: convertFileSrc(path),
        url: convertFileSrc(path),
      }));
      setReferenceImages((prev) => [...prev, ...newImages].slice(0, maxImages));
    } catch (e) {
      console.error('[VideoGenDialog] local upload failed:', e);
    }
  }, []);

  const handleOpenAssetPicker = useCallback(async () => {
    setAddMenuOpen(false);
    if (currentProjectId) {
      await loadAssets(currentProjectId);
    }
    setAssetPickerSelected(new Set());
    setShowAssetPicker(true);
  }, [currentProjectId, loadAssets]);

  const handleConfirmAssetImport = useCallback(() => {
    const seenRawUrls = new Set(referenceImages.map((i) => i.rawUrl));
    const newImages: ReferenceImage[] = [];

    for (const assetId of assetPickerSelected) {
      const asset = assets.find((a: any) => a.id === assetId);
      if (!asset) continue;
      const rawUrl = convertFileSrc(asset.filePath);
      if (seenRawUrls.has(rawUrl)) continue;
      seenRawUrls.add(rawUrl);
      newImages.push({
        id: asset.id,
        rawUrl,
        url: rawUrl,
      });
    }

    if (newImages.length > 0) {
      setReferenceImages((prev) => [...prev, ...newImages].slice(0, maxImages));
    }
    setShowAssetPicker(false);
    setAssetPickerSelected(new Set());
  }, [assetPickerSelected, assets, referenceImages]);

  const toggleAssetSelection = useCallback((id: string) => {
    setAssetPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setReferenceImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  /**
   * 把第 index 张参考图的引用标记插到提示词光标处。
   *
   * 🔴 插的是 `<Picture N>`，不是 `@图N` —— 参考生视频正文只认 `<Picture N>`，
   * `@图N` 是【选图】行的交互语法，出现在正文里属于非法写法（规则头明确禁止）。
   * N 必须等于**实际提交顺序**（referenceImages 的下标 + 1），模型按这个顺序收到图片。
   * 这是「选错图时用户自己换图」的唯一手工入口，别删。
   */
  const insertPictureRef = useCallback((index: number) => {
    const marker = `<Picture ${index + 1}>`;
    const el = textareaRef.current;
    // 🔴 锁定态下输入框显示的是**中文镜像**，光标位置对不上英文原文（`el.value` 是中文），
    //    绝不能拿它的 slice 拼回 `prompt` —— 会把中文写进提交串。一律追加到英文末尾。
    if (promptLocked || !el) {
      setPrompt((prev) => (prev ? `${prev} ${marker}` : marker));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${marker}${el.value.slice(end)}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + marker.length;
      el.setSelectionRange(pos, pos);
    });
  }, [promptLocked]);


  // 参考图上限：走 videoPricing 的统一常量（9），与后端 H3 的 MAX_REF_IMAGES 对齐。
  // 别再写死 5 —— 5 是「带参考视频」时的档位（MAX_REFERENCE_IMAGES_WITH_VIDEO）。
  const maxImages = MAX_REFERENCE_IMAGES;
  const creditCost = computeVideoCost(duration, false);
  // 订阅整个 history 引用，用 useMemo 稳定返回值避免空数组无限渲染
  const historyStore = useVideoGenStore((s) => s.history);
  const historyEntries = useMemo(() => {
    if (!nodeId) return [];
    const entries = historyStore[nodeId];
    return entries ?? [];
  }, [historyStore, nodeId]);

  // 正在生成的任务也列入历史（放在最前面，标注"正在生成"）
  const activeGeneratingEntry = isGenerating && pendingTaskId
    ? { id: '__active__', prompt, aspectRatio, duration, createdAt: Date.now(), taskId: pendingTaskId, videoUrl: null as string | null, _generating: true as const }
    : null;

  // 历史列表 = 正在生成(最前) + 已完成记录
  const combinedHistory = useMemo(() => {
    const completed = historyEntries.map((e) => ({ ...e, _generating: false as const }));
    return activeGeneratingEntry ? [activeGeneratingEntry, ...completed] : completed;
  }, [historyEntries, activeGeneratingEntry]);

  // Close history popover on click outside
  useEffect(() => {
    if (!showHistory) return;
    const onPointerDown = (event: PointerEvent) => {
      if (historyRef.current?.contains(event.target as Node)) return;
      setShowHistory(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [showHistory]);

  const refMetas = useMemo(
    () => inferRefTypes(prompt, referenceImages.length),
    [prompt, referenceImages.length],
  );

  const handleGenerate = useCallback(async () => {
    setError(null);

    // 检查积分
    try {
      const creditsInfo = await bananaCheckCredits();
      const cost = computeVideoCost(duration, false);
      if (creditsInfo.credits < cost) {
        setInsufficientRequired(cost);
        setInsufficientCurrent(creditsInfo.credits);
        setShowInsufficientDialog(true);
        return;
      }
    } catch (e: any) {
      setError(e?.message || '无法检查积分，请重试');
      return;
    }

    setShowConfirmDialog(true);
  }, [prompt, referenceImages, duration, t]);

  const executeGenerate = useCallback(async (queueToken?: string) => {
    setShowConfirmDialog(false);
    setError(null);

    // 校验：必须有故事板提示词
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError(t('videoGen.emptyPrompt', '请先在提示词框中输入或选择分镜提示词'));
      return;
    }

    setIsGenerating(true);
    setVideoUrl(null);

    try {
      // 1. 获取规则文件（mode 决定取宫格版还是直出版规则头）
      const rules = await fetchVideoGenRules(videoModel, mode);

      // 分镜提示词原样提交：H3 走自然语言视听时间线，靠 SKILL.md 生成约束
      // + prompt_rule 注入约束双保险，不再经过二次清洗。
      // 出站 `<d>` 审计：用户脚本千变万化，没法拿输入原文逐字比对 —— 只看 `<d>` 本身。
      // 标签内除「语言标签 + 台词」外的字符，视频模型都会当成台词念出来（多出听不懂的人声）。
      // 确定性的垃圾就地修正，可疑内容只报告；这部分不碰持久化链路，只改本次提交的文本。
      const dAudit = auditAndFixDTags(trimmedPrompt);
      if (dAudit.fixes.length || dAudit.issues.length) {
        console.warn(summarizeDTagAudit(dAudit), {
          fixes: dAudit.fixes,
          issues: dAudit.issues,
        });
        rememberDTagAudit(dAudit);
      }

      // 🔴 2026-10-28 产品定调：提示词**全程中文**（写手出中文、用户可改中文），
      //    只在提交这一刻翻成官方英文正文交给 H3 —— 回译规则是一份独立规则
      //    （`src-tauri/src/commands/translate_rules/prompt_to_english.md`）。
      //    ⚠️ 翻不出来**不能退回中文原文提交**：规则头要求英文正文，中英混排正是
      //    「旁白听不懂 / 旁白时人物张嘴」的病根，花钱换一段坏片不值得 ⇒ 直接报错让用户重试。
      // 🔴 2026-10-31 用户定调：这道英文闸门管**全部**送 H3 的正文，不只是回译出来的那份。
      //    中文 ⇒ 回译；英文（老项目）⇒ finalize_english_prompt 原地过同一套官方闸门。
      //    任一分支不过 ⇒ 拦在扣费之前，绝不把不合格英文送去出片。
      const rawContent = dAudit.text;
      const contentForH3 = await prepareVideoPromptForSubmit(rawContent);
      if (!contentForH3) {
        console.error('[VideoGenDialog] 英文闸门未通过，已拦截提交');
        setIsGenerating(false);
        setGenerationPhase(null);
        setQueueAhead(0);
        queueTokenRef.current = null;
        setError(
          t('videoGen.promptTranslateFailed', {
            defaultValue: '提示词未通过官方英文校验，已拦截本次提交（不会扣费）。',
          })
        );
        return;
      }
      const userContent = contentForH3;
      if (contentForH3 !== rawContent) {
        console.log(
          `[VideoGenDialog] 送 H3 正文已过闸门：${rawContent.length} → ${contentForH3.length} 字`
        );
      }

      // 2.5 shotFrameMap 保留在节点缓存中（用于后续分析/调试），
      // 但不再注入图N引用到 prompt。
      // 让模型从整张六宫格图中自行匹配帧，避免指定图N干扰模型判断。

      let finalPrompt: string;

      // 3. 规则头：从 video_gen_rules_{model}.json 注入（服务端热更新，不需重构建）
      const promptRule = rules.prompt_rule ?? '';
      const negativePrompt = rules.negative_prompt ?? '';
      const guidanceScale = rules.guidance_scale;
      const shotType = rules.shot_type;

      // 🔴 兜底（2026-10-28 实测事故）：App.tsx 里 `hydrateVideoGenStore()` 是 fire-and-forget，
      // 弹窗可能在配置读盘完成前就被点「生成」——本地 state 还是空的，界面却已通过
      // savedConfig 渲染出音色，结果请求带着 audio=0 发出去。本地为空时改用节点已持久化的
      // 音色（只读，不写回，不碰回填/持久化链路）。
      const storedVoices: ReferenceVoice[] = (() => {
        const cfg = nodeIdRef.current
          ? useVideoGenStore.getState().configs[nodeIdRef.current]
          : undefined;
        if (!cfg) return [];
        if (cfg.referenceVoices?.length) return cfg.referenceVoices;
        return cfg.referenceVoice ? [cfg.referenceVoice] : [];
      })();
      const voicesForSubmit = referenceVoices.length > 0 ? referenceVoices : storedVoices;

      // 规则头尾句（代码层 100% 可靠追加，AI 无法遗忘）
      // 带音色参考时，后端还要往六段里补 `<Audio N>` 声明 / reference 标记 / 内联引用，
      // 这部分字数要从规则头预算里先扣掉，否则拼接后可能越过上游 7000 字上限。
      const audioReserve = voicesForSubmit.length > 0
        ? 120 + voicesForSubmit.length * 240
        : 0;
      finalPrompt = assembleVideoPrompt(promptRule, userContent, audioReserve);
      console.log(`[VideoGenDialog] MiniMax H3, mode:`, mode, 'refs:', referenceImages.length, 'hasRule:', !!promptRule, 'hasNegPrompt:', !!negativePrompt, 'guidanceScale:', guidanceScale, 'shotType:', shotType, 'promptLen:', finalPrompt.length, 'ruleLen:', promptRule.length, 'bodyLen:', userContent.length);

      // 🔴 提交闸口（2026-10-28 用户定调）：视频模型对**整段提交内容**（规则头 + 正文）
      //    的硬限是 7000 字符，超了任务根本建不出来（`Params [Prompt], should be in [1, 7000]`）。
      //    这里在**扣费之前**拦住，直接告诉用户去缩减提示词，别让他花了钱才看到失败。
      //    带音色参考时，后端还要往六段里插 `<Audio N>` 声明 / reference 标记 / 内联从句，
      //    这部分字数不在 finalPrompt 里 —— 必须一起算进去，否则「正文接近上限 + 2~3 段音色」
      //    会在扣费之后才被上游 7000 拦下。
      const submittedLen = finalPrompt.length + audioReserve;
      if (submittedLen > PROMPT_HARD_LIMIT) {
        console.warn('[VideoGenDialog] 提示词超过硬限，已拦截提交:', submittedLen);
        setIsGenerating(false);
        setGenerationPhase(null);
        setQueueAhead(0);
        queueTokenRef.current = null;
        setError(
          t('videoGen.promptTooLongGate', {
            len: submittedLen,
            limit: PROMPT_HARD_LIMIT,
            defaultValue: `提示词共 ${submittedLen} 字，超过 ${PROMPT_HARD_LIMIT} 字上限，容易导致生成失败，建议缩减提示词后重试。`,
          })
        );
        return;
      }

      // 4. 准备参考图 — 直接用 base64
      const imageInput: string[] = [];
      // 传入宫格参考图（compshare 直连，≤9 张）
      // 🔴 少传一张，正文里的 `<Picture N>` 会整体错位（N 按**提交顺序**对齐，
      //    官方 §2 要求每个 `<Picture N>` 都指到真实那几张图），所以转换失败必须中止，
      //    不能像以前那样 `continue` 静默跳过。
      for (const [index, img] of referenceImages.entries()) {
        try {
          const dataUrl = img.rawUrl.startsWith('data:')
            ? img.rawUrl
            : await imageUrlToDataUrl(img.url);
          imageInput.push(dataUrl);
        } catch (e) {
          console.warn('[VideoGenDialog] failed to convert to base64:', img.rawUrl, e);
          setIsGenerating(false);
          setGenerationPhase(null);
          setQueueAhead(0);
          queueTokenRef.current = null;
          setError(
            t('videoGen.referenceImageLoadFailed', {
              index: index + 1,
              defaultValue: `第 ${index + 1} 张参考图读取失败，已取消提交。请重新添加这张图后再生成。`,
            })
          );
          return;
        }
      }

      // 准备音色参考 audio data URL（最多 3 段，顺序即提示词里的 reference audio 序号）
      const voiceRefs: Array<{ dataUrl: string; character?: string }> = [];
      for (const voice of voicesForSubmit.slice(0, VOICE_REF_MAX_COUNT)) {
        try {
          const rawUrl = voice.rawUrl;
          let dataUrl: string;
          if (rawUrl.startsWith('data:')) {
            dataUrl = rawUrl;
          } else {
            // Read audio file via fetch + FileReader → base64 data URL
            const response = await fetch(rawUrl);
            const blob = await response.blob();
            dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error('Failed to read audio file'));
              reader.readAsDataURL(blob);
            });
          }
          // 名字先解析成 `<Subject N>`，再交给后端（回译后正文里已无中文角色名可对）
          voiceRefs.push({ dataUrl, character: resolveVoiceSubject(rawContent, voice.character) });
        } catch (e) {
          console.warn('[VideoGenDialog] failed to read voice file:', e);
        }
      }

      // 5. 提交视频任务（非阻塞，拿到 taskId 后轮询）
      const result = await bananaSubmitVideoJob({
        prompt: finalPrompt,
        aspectRatio,
        resolution,
        durationSeconds: duration,
        imageInput,
        voiceRefs,
        negativePrompt: negativePrompt || undefined,
        guidanceScale,
        shotType,
        model: videoModel,
        // 排队重发时带上同一个凭据（后端据此复用排队位、并防止同一个凭据重复扣费）
        queueToken,
      });

      // 本机 KEY 池没有空位 → 排队（**此时未扣费**），交给 startQueueWait 轮询
      if (result.queued && result.queueToken) {
        queueTokenRef.current = result.queueToken;
        setQueueAhead(result.queueAhead ?? 0);
        setGenerationPhase('localQueue');
        setIsGenerating(true);
        startQueueWait(result.queueToken);
        return;
      }

      if (result.success) {
        const deducted = result.creditsDeducted ?? 0;
        if (deducted > 0) setCreditsDeducted(deducted);
        // 保存提交参数供 429 重试用
        retryCountRef.current = 0;
        submitParamsRef.current = {
          aspectRatio,
          duration,
          videoModel,
          refUrls: referenceImages.map((img) => img.rawUrl),
          negativePrompt,
        };
        if (result.videoUrl) {
          // 同步完成（罕见），也下载到本地
          setVideoUrl(result.videoUrl);
          let syncVideoPath = result.videoUrl;
          try {
            const { invoke: invokeSync } = await import('@tauri-apps/api/core');
            syncVideoPath = await invokeSync<string>('download_video_to_local', {
              url: result.videoUrl,
              filename: `video_${Date.now()}.mp4`,
            });
          } catch (downloadErr) {
            console.warn('[VideoGenDialog] sync video download failed:', downloadErr);
          }
          // 生成完成后自动本地超分到 2K，失败则回退原视频
          const finalVideoPath = await autoEnhanceTo2K(syncVideoPath);
          setVideoUrl(finalVideoPath);
          const config = {
            prompt: prompt.trim() || '',
            aspectRatio,
            duration,
            videoModel,
            videoUrl: finalVideoPath,
            referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
            referenceVoice: voicesForSubmit[0] ?? undefined,
            referenceVoices: voicesForSubmit.length > 0 ? voicesForSubmit : undefined,
            gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
          };
          if (nodeIdRef.current) {
            saveConfig(nodeIdRef.current, config);
            addToHistory(nodeIdRef.current, config, result.taskId || undefined);
            try {
              useCanvasStore.getState().updateNodeData(nodeIdRef.current, {
                generatedVideoUrl: finalVideoPath,
              });
            } catch { /* non-critical */ }
          }
          setIsGenerating(false);
        } else if (result.taskId) {
          // 异步任务，存储 taskId 开始轮询
          // 凭据交还给后端了：清空排队引用，卸载清理就不会再去取消（保证不干扰在跑的任务）
          queueTokenRef.current = null;
          setQueueAhead(0);
          setPendingTaskId(result.taskId);
          if (nodeIdRef.current) {
            saveConfig(nodeIdRef.current, {
              prompt: prompt.trim(),
              aspectRatio,
              duration,
              pendingTaskId: result.taskId,
              pendingCreditsDeducted: deducted,
              referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
              // 这条保存会整体覆盖节点配置：不带音色就会把已挂上的音色从盘上抹掉
              referenceVoice: voicesForSubmit[0] ?? undefined,
              referenceVoices: voicesForSubmit.length > 0 ? voicesForSubmit : undefined,
            });
          }
          startPolling(result.taskId, false, deducted, videoModel);
        } else {
          setIsGenerating(false);
          queueTokenRef.current = null;
          setGenerationPhase(null);
          setError(t('videoGen.unknownError', '未知错误'));
        }
      } else if (result.error) {
        setIsGenerating(false);
        queueTokenRef.current = null;
        setGenerationPhase(null);
        setQueueAhead(0);
        if (result.error.startsWith('INSUFFICIENT_CREDITS')) {
          setInsufficientRequired(result.requiredCredits ?? computeVideoCost(duration, false));
          setInsufficientCurrent(result.currentCredits ?? 0);
          setShowInsufficientDialog(true);
        } else {
          setError(result.error);
        }
      } else {
        setIsGenerating(false);
        queueTokenRef.current = null;
        setGenerationPhase(null);
        setError(t('videoGen.unknownError', '未知错误'));
      }
    } catch (e: any) {
      setIsGenerating(false);
      queueTokenRef.current = null;
      setGenerationPhase(null);
      setError(e?.message || e?.toString() || t('videoGen.unknownError', '未知错误'));
    }
    // 注意：不在 finally 中 setIsGenerating(false)，轮询函数会在完成/失败时设置
  }, [prompt, aspectRatio, duration, videoModel, referenceImages, t, saveConfig, addToHistory, startPolling, startQueueWait, mode]);

  // 供 startQueueWait 回调（避免 useCallback 之间的循环依赖/失效闭包）
  executeGenerateRef.current = executeGenerate;

  // 对话框关闭时强制落盘，防止防抖窗口内数据丢失
  useEffect(() => {
    return () => {
      forcePersistVideoGen().catch(() => {});
    };
  }, []);

  /** 本机能力探测：整个会话只跑一次（内部缓存），探测失败静默降级为只用快速档 */
  useEffect(() => {
    let alive = true;
    probeSrCapability()
      .then((cap) => {
        if (alive) setSrCap(cap);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 探测结果要经 ref 读：`autoEnhanceTo2K` 会被更早定义的轮询/生成回调捕获，
   *  那些 useCallback 不会因探测完成而重建 —— 直接读 state 会永远停在 srCap=null 那一版。 */
  const srCapRef = useRef<SrCapability | null>(null);
  srCapRef.current = srCap;

  /** AI 逐帧重建的真实进度（后端 `enhance-video-progress`），只有 AI 档会用上 */
  useEffect(() => {
    if (!isLocalEnhancing) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ percent: number }>('enhance-video-progress', (event) => {
          if (!cancelled) setLocalEnhanceProgress(event.payload?.percent ?? 0);
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isLocalEnhancing]);

  const autoEnhanceTo2K = useCallback(async (localVideoPath: string): Promise<string> => {
    // 档位由程序自己定：本机实测能跑 AI 重建就用（探测里含一次微基准），否则走快速档。
    // 用户不选、也看不到这个选择。
    const useAi = !!srCapRef.current?.aiAvailable;
    setIsLocalEnhancing(true);
    setLocalEnhanceProgress(0);
    // 快速档只有几秒、拿不到逐帧进度，用模拟进度条顶着；AI 档显示后端真实进度
    const progressTimer = useAi
      ? null
      : setInterval(() => {
          setLocalEnhanceProgress(prev => {
            if (prev >= 90) return prev;
            const increment = Math.random() * 6 + 2;
            return Math.min(90, prev + increment);
          });
        }, 2500);
    try {
      if (useAi) {
        const result = await enhanceVideoAi(localVideoPath, LOCAL_ENHANCE_SHORT_EDGE);
        setLocalEnhanceProgress(100);
        return result;
      }
      const result = await enhanceVideo(localVideoPath, 2, LOCAL_ENHANCE_SHORT_EDGE);
      setLocalEnhanceProgress(100);
      return result;
    } catch (e: any) {
      console.warn('[VideoGenDialog] auto local upscale to 2K failed:', e);
      // AI 档失败（驱动/显存抖动）时退回快速档，别让用户白等一场
      if (useAi) {
        try {
          const result = await enhanceVideo(localVideoPath, 2, LOCAL_ENHANCE_SHORT_EDGE);
          setLocalEnhanceProgress(100);
          return result;
        } catch (fallbackErr) {
          console.warn('[VideoGenDialog] fallback upscale failed, keep original:', fallbackErr);
        }
      }
      return localVideoPath;
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      setIsLocalEnhancing(false);
    }
  }, []);

  // ── 「缩小」到侧栏所需的三个派生值（全部从**已有** state 派生，不新增持久化）──

  /** 本次轮询开始的时刻（`startPolling` 内部的 `startTime` 语义）。
   *  🔴 口径必须说「本次已等待」而不是「已生成 N 分钟」—— 跨会话续接时它会从 0 重算。
   *  之所以从这里派生、而不是往 `startPolling` 的成功/失败/超时/网络异常 4 条出口各插一次
   *  `setState`：那 4 条出口正落在 CLAUDE.md §12.4 的敏感区里，能不动就不动。 */
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setJobStartedAt(isGenerating ? Date.now() : null);
  }, [isGenerating]);

  /** 作业**成功**结束时通知外层。只在 `isGenerating` 的 true→false 跳变上触发 ——
   *  否则打开一个**已有成片**的节点会立刻误报一条「生成完成」。
   *  `error` 为真时不提示（失败有失败的样子，别混成「完成」）。 */
  const prevGeneratingRef = useRef(false);
  useEffect(() => {
    const was = prevGeneratingRef.current;
    prevGeneratingRef.current = isGenerating;
    if (was && !isGenerating && !error && videoUrl) onJobComplete(nodeId);
  }, [isGenerating, error, videoUrl, onJobComplete, nodeId]);

  /** 节点是否还在当前画布上。编辑器**不会**在删节点时调 `forgetConfig`
   *  （`forgetConfig` 全库零调用者），所以 config 还在、作业也还在 —— 但侧栏的
   *  「展开」必须禁用，否则点开的是一个画布上根本不存在的节点。
   *  只订阅一个布尔值 ⇒ 画布抖动不会引起重渲染。 */
  const nodeExists = useCanvasStore((s) => (nodeId ? s.nodes.some((n) => n.id === nodeId) : false));

  /** 小窗标题行第一排：**该节点在画布上的标题**。
   *  用画布节点同一个函数（`resolveNodeDisplayName`）取，所以两处天然一致；
   *  节点已删（`nodeTitle` 为 `null`）时由 `VideoGenDock` 回落成「视频生成」。
   *  ⚠️ 选择器**返回字符串**（原始类型）⇒ `Object.is` 稳定 ⇒ 画布 60fps 抖动不会引起重渲染。
   *     不要改成返回对象，那会让每次 store 更新都重渲一次。 */
  const nodeTitle = useCanvasStore((s) => {
    if (!nodeId) return null;
    const node = s.nodes.find((n) => n.id === nodeId);
    if (!node?.type) return null;
    return resolveNodeDisplayName(node.type, node.data ?? {});
  });

  /** 小窗标题行第二排：**这一单的内容摘要**。
   *  取源优先级 = 逐格描述（`initialGridFrames[0]`，写手写的、逐节点不同）→ 正文。
   *  **不看 `mode`**：宫格路缺 frames、直出路本就没有 frames，两条路都自动落到正文。
   *  摘不出来返回 `null`，`VideoGenDock` 据此整行不渲染。纯函数在 `./dockTitle`。 */
  const dockSubtitle = useMemo(
    () => deriveDockSubtitle([initialGridFrames[0], prompt]),
    [initialGridFrames, prompt],
  );

  /** 交给外层的槽位 payload。刻意用**挂载时那份** `initialImages`/`initialGridFrames`
   *  （它们是 `useState` 初值，本来就不随后续编辑变化）—— 这样「展开后与缩小前一致」
   *  是结构性成立的，而不是靠两边各自重算碰巧相等。
   *  `title`/`subtitle` 是**纯显示字段**：不落盘、不进任何 store、不进 `imagePool`
   *  （§12.4 的冻结区一个字节都没碰），只为了让外层渲染提示条时知道「是哪一单」。 */
  const currentPayload = useMemo<DialogPayload>(
    () => ({
      nodeId,
      initialImages,
      initialGridFrames,
      shotFrameMap: _shotFrameMap,
      mode,
      title: nodeTitle ?? undefined,
      subtitle: dockSubtitle ?? undefined,
    }),
    [nodeId, initialImages, initialGridFrames, _shotFrameMap, mode, nodeTitle, dockSubtitle],
  );

  /** 标题栏「缩小」。
   *  这些浮层/查看器的开合标志**不会**随形态切换自动复位，不清掉的话
   *  docked 期间它们的状态悬着，展开时会毫无预兆地弹出来。 */
  const handleMinimizeClick = useCallback(() => {
    setShowConfirmDialog(false);
    setShowPromptPicker(false);
    setAddMenuOpen(false);
    setShowAssetPicker(false);
    setShowHistory(false);
    onMinimize(currentPayload);
  }, [onMinimize, currentPayload]);

  // ── docked 形态：**同一实例的另一种皮**，不是第二个弹窗 ──
  // ⚠️ 这个提前 return 必须落在**所有 hooks 之后**（已核：本文件在弹窗 JSX 之后
  //    到文件末尾没有任何 hook 调用）。
  if (variant === 'docked') {
    const videoErr = error ? translateVideoError(error) : null;
    return (
      <VideoGenDock
        isGenerating={isGenerating}
        isResuming={isResuming}
        generationPhase={generationPhase}
        queueAhead={queueAhead}
        jobStartedAt={jobStartedAt}
        videoUrl={videoUrl}
        errorTitle={videoErr?.title ?? null}
        errorDetail={videoErr?.detail ?? null}
        historyCount={combinedHistory.length}
        nodeExists={nodeExists}
        title={nodeTitle}
        subtitle={dockSubtitle}
        container={dockContainer ?? null}
        // 这两个回调都带 payload ⇒ 多窗之下「展开/关闭的是哪一格」是内层当场指定的，
        // 外层不用猜。
        onExpand={() => onExpand(currentPayload)}
        onClose={() => onDockClose(currentPayload)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[92vh] max-h-[900px] w-[1100px] max-w-[95vw] overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.12)] bg-surface-dark shadow-2xl">
        {/* Left panel: parameters */}
        <div className="flex w-[420px] shrink-0 flex-col border-r border-[rgba(255,255,255,0.08)]">
          <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-5 py-3.5">
            <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold text-text-dark">
              <Film className="h-4 w-4 shrink-0 text-purple-400" />
              {/* 多窗并存时弹窗之间也要能分辨 —— 缩小 ↔ 展开不该丢掉身份。
                  节点标题与画布上那个节点同名（同一个 `resolveNodeDisplayName`）。 */}
              {nodeTitle ? (
                <>
                  <span className="shrink-0">{t('videoGen.title')}</span>
                  <span className="truncate text-sm font-normal text-text-muted">· {nodeTitle}</span>
                </>
              ) : (
                <span className="truncate">{t('videoGen.title')}</span>
              )}
            </h2>
            <div className="flex items-center gap-0.5">
              {/* 缩小到右侧侧栏 —— 内层**不卸载**，只换形态，所以轮询与进度原地保留。 */}
              <button
                type="button"
                onClick={handleMinimizeClick}
                title={t('videoGen.minimize')}
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="ui-scrollbar flex-1 space-y-5 overflow-y-auto p-5">
            {/* Duration —— 第一行：用户最先定的是「多长」 */}
            <div>
              <label className="mb-2 block text-xs font-medium text-text-muted">
                {t('videoGen.duration', '时长')}
              </label>
              <div className="flex gap-2">
                {VIDEO_DURATION_OPTIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDuration(d)}
                    className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                      duration === d
                        ? 'border-purple-400/60 bg-purple-500/20 text-purple-200'
                        : 'border-[rgba(255,255,255,0.1)] bg-bg-dark text-text-muted hover:border-purple-400/30'
                    }`}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </div>

            {/* Aspect ratio —— 第二行：与时长同一套 chip 交互。
                画幅原来是下拉框，用户经常会漏点（下拉框看不出当前选项、也不占视觉权重）。
                改成并排 chip 后五个选项一眼可见，默认值也直接显出来。 */}
            <div>
              <label className="mb-2 block text-xs font-medium text-text-muted">
                {t('videoGen.aspectRatio', '画幅')}
              </label>
              {/* 五档挤一行：标签只写比例（`9:16`），横屏/竖屏的解释放 title 提示里；
                  chip 里不留横向内边距，靠 `flex-1` 平分宽度 */}
              <div className="flex gap-2">
                {ASPECT_RATIO_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setAspectRatio(opt.value)}
                    aria-pressed={aspectRatio === opt.value}
                    title={t(ASPECT_LABEL_KEYS[opt.value] ?? 'videoGen.aspectRatio', opt.label)}
                    className={`flex-1 rounded-lg border px-1 py-2 text-sm font-medium transition-colors ${
                      aspectRatio === opt.value
                        ? 'border-purple-400/60 bg-purple-500/20 text-purple-200'
                        : 'border-[rgba(255,255,255,0.1)] bg-bg-dark text-text-muted hover:border-purple-400/30'
                    }`}
                  >
                    {opt.value}
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-text-muted">
                  {t('videoGen.prompt', '提示词')}
                </label>
                <div className="flex items-center gap-2">                  <button
                    type="button"
                    onClick={() => setShowPromptPicker(true)}
                    className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                  >
                    {t('videoGen.extractFromStoryboard', '从分镜提取')}
                  </button>
                </div>
              </div>

              <div className="relative">
                {/* 高亮叠加层：对 `<Picture N>` / @图N 着色，其余透明，露出下方 textarea 文字 */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-10 overflow-hidden whitespace-pre-wrap rounded-lg border border-transparent px-3 py-2 text-sm"
                  style={{ fontFamily: 'inherit', lineHeight: '1.5', wordBreak: 'break-word' }}
                  ref={(el) => { highlightRef.current = el; }}
                >
                  {prompt
                    ? prompt.split(/(<Picture \d+>|@图\d+)/g).map((part, i) =>
                        /^(<Picture \d+>|@图\d+)$/.test(part) ? (
                          <mark key={i} className="rounded-sm bg-purple-500/20 text-purple-300 font-medium">
                            {part}
                          </mark>
                        ) : (
                          <span key={i} className="text-transparent">{part}</span>
                        ),
                      )
                    : null}
                </div>
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  // 🔴 2026-10-28：**提示词可以手改**（chat 页与这里都能改），提交那一刻由回译规则译成官方英文。
                  // 🔴 2026-10-31：英文正文只可能是 2026-10-28 之前的老项目 ⇒ 原样显示、只读，不改不翻。
                  readOnly={promptLocked && !promptIsChinese}
                  placeholder={t('videoGen.promptPlaceholder', '描述你想要生成的视频内容...')}
                  // 15 行：比原来的 13 行多两行，但不把下面的「音色参考」挤出第一屏
                  //（20 行实测会把音色参考压到折叠线以下）。
                  rows={15}
                  className="relative w-full resize-none rounded-lg border border-[rgba(255,255,255,0.12)] bg-transparent px-3 py-2 text-sm placeholder-text-muted focus:outline-none"
                  style={{ lineHeight: '1.5', wordBreak: 'break-word' }}
                  onScroll={(e) => {
                    const hl = highlightRef.current;
                    if (hl) hl.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
                  }}
                />
              </div>
              {promptIsChinese && prompt.trim().length > 0 && (
                <div className="mt-1 text-[11px] text-text-muted/70">
                  {t('videoGen.promptEditableHint')}
                </div>
              )}
            </div>

            {/* Reference images */}
            <div>
              <label className="mb-2 block text-xs font-medium text-text-muted">
                {t('videoGen.referenceImages', '参考图')}{' '}
                <span className="text-text-muted/60">
                  ({referenceImages.length}/{maxImages})
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                {referenceImages.map((img, i) => {
                  const meta = refMetas[i];
                  return (
                  <div key={img.id} className="group relative">
                    {/* 点击放大（放大层是 portal，见组件末尾）；按 Esc 或点背景关闭 */}
                    <img
                      src={img.url}
                      alt=""
                      onClick={() => setPreviewImageUrl(img.url)}
                      title={t('videoGen.clickToEnlarge', '点击放大')}
                      className="h-16 w-16 cursor-zoom-in rounded-lg border border-[rgba(255,255,255,0.1)] object-cover transition-opacity hover:opacity-85"
                    />
                    {/* 序号角标 = 这张图在正文里的 <Picture N>。点一下把标记插到光标处 */}
                    <button
                      type="button"
                      onClick={() => insertPictureRef(i)}
                      title={t('videoGen.insertPictureRef', {
                        n: i + 1,
                        defaultValue: '插入 <Picture {{n}}> 到提示词',
                      })}
                      className="absolute -left-1.5 -top-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-purple-500/90 px-1 text-[10px] font-semibold text-white shadow transition-colors hover:bg-purple-400"
                    >
                      {i + 1}
                    </button>
                    {meta && (
                      <span className={`absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-medium ${
                        meta.type === 'storyboard' ? 'bg-amber-500/80 text-amber-950' :
                        meta.type === 'character' ? 'bg-blue-500/80 text-blue-950' :
                        meta.type === 'scene' ? 'bg-emerald-500/80 text-emerald-950' :
                        meta.type === 'clothing' ? 'bg-pink-500/80 text-pink-950' :
                        'bg-zinc-500/80 text-zinc-200'
                      }`}>
                        {REF_TYPE_LABELS[meta.type]}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveImage(img.id)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500/80 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  );
                })}
                {referenceImages.length < maxImages && (
                  <div ref={addMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setAddMenuOpen((v) => !v)}
                      className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-[rgba(255,255,255,0.15)] bg-bg-dark text-text-muted transition-colors hover:border-purple-400/40 hover:text-purple-300"
                      title={t('videoGen.addReference', '添加参考图')}
                    >
                      <ImagePlus className="h-5 w-5" />
                    </button>
                    {addMenuOpen && (
                      <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[180px] rounded-xl border border-[rgba(255,255,255,0.14)] bg-surface-dark p-1.5 shadow-xl">
                        <button
                          type="button"
                          onClick={handleOpenAssetPicker}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
                        >
                          <FolderOpen className="h-4 w-4 text-purple-400" />
                          {t('videoGen.importFromAssets', '从资产导入')}
                        </button>
                        <button
                          type="button"
                          onClick={handleLocalUpload}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
                        >
                          <Upload className="h-4 w-4 text-purple-400" />
                          {t('videoGen.uploadLocal', '本地上传')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 音色参考上传 —— 官方 r2va 的 reference_audio
                  （WAV/MP3、单段 2–15 秒、≤15MB、最多 3 段、总时长 ≤15 秒）
                  每段可绑定一个角色，提交时按序号写进提示词，指明这段声音由谁发出。 */}
              {VOICE_REF_UI_ENABLED && (
                <div className="mt-4">
                  <label className="mb-1.5 block text-xs font-medium text-text-muted">
                    {t('videoGen.voiceRef')}
                  </label>
                  <div className="space-y-2">
                    {referenceVoices.map((voice, index) => (
                      <div
                        key={voice.id}
                        className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">
                            #{index + 1}
                          </span>
                          <span className="flex-1 truncate text-xs text-text-dark">{voice.fileName}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setReferenceVoices((prev) => prev.filter((v) => v.id !== voice.id));
                              setVoiceError(null);
                            }}
                            className="text-text-muted hover:text-red-400"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {/* 这段声音属于谁：项目「人物」资产逐个列出 + 旁白（画外音），点选一个即可。
                            再点一次已选中的可取消。旁白不是角色，后端会写成官方的 `off-screen voiceover`。 */}
                        <div className="mt-1.5">
                          <p className="mb-1 text-[11px] text-text-muted">
                            {t('videoGen.voiceOwnerPlaceholder')}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {voiceOwnerOptions.map((label) => {
                              const active = (voice.character ?? '').trim() === label;
                              return (
                                <button
                                  key={label}
                                  type="button"
                                  onClick={() =>
                                    setReferenceVoices((prev) =>
                                      prev.map((v) =>
                                        v.id === voice.id
                                          ? { ...v, character: active ? '' : label }
                                          : v,
                                      ),
                                    )
                                  }
                                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                                    active
                                      ? 'border-purple-400/60 bg-purple-500/15 text-purple-300'
                                      : 'border-[rgba(255,255,255,0.12)] text-text-muted hover:border-purple-400/40 hover:text-purple-300'
                                  }`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ))}
                    {referenceVoices.length < VOICE_REF_MAX_COUNT && (
                      <button
                        type="button"
                        onClick={handleAddVoice}
                        className="flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-[rgba(255,255,255,0.15)] bg-bg-dark px-3 text-xs text-text-muted transition-colors hover:border-purple-400/40 hover:text-purple-300"
                      >
                        <Upload className="h-4 w-4" />
                        {referenceVoices.length === 0
                          ? t('videoGen.uploadVoice')
                          : t('videoGen.addVoice')}
                      </button>
                    )}
                  </div>
                  {referenceVoices.length === 0 && !voiceError && (
                    <p className="mt-1.5 text-xs text-text-muted">{t('videoGen.voiceHint')}</p>
                  )}
                  {voiceError && (
                    <p className="mt-1.5 text-xs text-red-400">{voiceError}</p>
                  )}
                </div>
              )}
            </div>

          </div>
        </div>

        {/* Right panel: preview */}
        <div className="flex flex-1 flex-col items-center justify-center p-6">
          {isLocalEnhancing && videoUrl ? (
            /* 本地2K超分 — 视频上叠加进度蒙版 */
            <div className="relative">
              <video
                src={displayVideoUrl ?? undefined}
                controls
                className="max-h-[600px] max-w-full rounded-xl"
                autoPlay
                loop
              />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-bg-dark/65">
                <div className="w-56 space-y-3">
                  <p className="text-center text-sm font-medium text-white">正在生成2K视频...</p>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/15">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700 ease-out"
                      style={{ width: `${localEnhanceProgress}%` }}
                    />
                  </div>
                  <p className="text-center text-xs text-white/70">
                    {localEnhanceProgress < 100
                      ? `${Math.round(localEnhanceProgress)}% — 预计需要 2–5 分钟`
                      : '处理完成'}
                  </p>
                </div>
              </div>
            </div>
          ) : videoUrl ? (
            <video
              src={displayVideoUrl ?? undefined}
              controls
              className="max-h-[600px] max-w-full rounded-xl"
              autoPlay
              loop
            />
          ) : isGenerating ? (
            <div className="flex flex-col items-center gap-6">
              <div className="relative">
                <div className="absolute inset-0 animate-ping rounded-full border-2 border-purple-400/30" />
                <div className="absolute inset-0 animate-pulse rounded-full border-2 border-purple-400/20" />
                <LoaderCircle className="relative h-14 w-14 animate-spin text-purple-400" />
              </div>
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm font-medium text-text-dark">
                  {isResuming
                    ? t('videoGen.resuming', '正在恢复之前的视频生成任务...')
                    : generationPhase === 'localQueue'
                      ? t('videoGen.localQueue', '正在等待空闲通道...')
                      : generationPhase === 'queued'
                        ? t('videoGen.queued', '正在排队中，请耐心等待...')
                        : t('videoGen.generating', '正在生成视频...')}
                </p>
                <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                  {isResuming ? '小鸭正在处理中，请耐心等待...' : generationPhase === 'localQueue' ? t('videoGen.queueAhead', { n: queueAhead, defaultValue: '前面还有 {{n}} 个任务，轮到后会自动开始' }) : generationPhase === 'queued' ? t('videoGen.queuedHint', '排队任务较多，可能需要几分钟到十几分钟，请勿关闭窗口') : '预计需要 30–60 秒'}
                  <span className="inline-flex items-center">
                    <span className="mx-0.5 h-1 w-1 animate-bounce rounded-full bg-purple-400" style={{ animationDelay: '0ms' }} />
                    <span className="mx-0.5 h-1 w-1 animate-bounce rounded-full bg-purple-400" style={{ animationDelay: '150ms' }} />
                    <span className="mx-0.5 h-1 w-1 animate-bounce rounded-full bg-purple-400" style={{ animationDelay: '300ms' }} />
                  </span>
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 text-text-muted">
              <Film className="h-16 w-16 opacity-20" />
              <p className="text-sm">
                {t('videoGen.previewPlaceholder', '生成后将在此处预览视频')}
              </p>
            </div>
          )}

          {/* Credit display + actions */}
          <div className="mt-6 flex w-full max-w-md items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Sparkles className="h-4 w-4 text-amber-400" />
              <span>
                {t('videoGen.creditCost', '本次消耗: {{cost}} 积分', { cost: creditCost })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* History button */}
              <div ref={historyRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  disabled={combinedHistory.length === 0}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark px-2.5 text-xs text-text-muted transition-colors hover:bg-bg-dark/70 hover:text-text-dark disabled:opacity-30"
                  title={t('videoGen.history', '历史记录')}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {combinedHistory.length > 0 && (
                    <span className="text-[10px]">{combinedHistory.length}</span>
                  )}
                </button>
                {showHistory && combinedHistory.length > 0 && (
                  <div className="absolute bottom-full right-0 z-50 mb-2 w-[360px] max-h-[320px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.14)] bg-surface-dark shadow-2xl">
                    <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-4 py-2.5">
                      <span className="text-xs font-semibold text-text-dark">
                        {t('videoGen.history', '历史记录')}
                      </span>
                      <span className="text-[10px] text-text-muted">
                        {combinedHistory.length} {t('videoGen.historyCount', '条记录')}
                      </span>
                    </div>
                    <div className="ui-scrollbar max-h-[260px] overflow-y-auto">
                      {combinedHistory.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => {
                            if (entry._generating) {
                              // 正在生成的任务：关闭历史，回到生成中视图即可
                              setVideoUrl(null);
                              setShowHistory(false);
                              return;
                            }
                            setVideoUrl(entry.videoUrl ?? null);
                            setPrompt(entry.prompt);
                            setPromptLocked(looksGeneratedPrompt(entry.prompt));
                            setAspectRatio(entry.aspectRatio);
                            setDuration(entry.duration);
                            setShowHistory(false);
                          }}
                          className="w-full border-b border-[rgba(255,255,255,0.04)] px-4 py-3 text-left transition-colors hover:bg-bg-dark last:border-b-0"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-text-dark truncate">
                                {entry.prompt.startsWith('【2K视频】') ? (
                                  <span className="text-purple-300 font-medium">2K视频 </span>
                                ) : entry.prompt.startsWith('【4K视频】') ? (
                                  <span className="text-amber-300 font-medium">4K视频 </span>
                                ) : null}
                                {entry.prompt.replace(/^【[24]K视频】/, '').slice(0, 60)}
                                {entry.prompt.length > 60 ? '...' : ''}
                              </p>
                              <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
                                <span>{entry.aspectRatio}</span>
                                <span>{entry.duration}s</span>
                                {entry._generating ? (
                                  <span className="text-amber-400 font-medium">{t('videoGen.generatingLabel', '正在生成')}</span>
                                ) : (
                                  <span>{new Date(entry.createdAt).toLocaleString()}</span>
                                )}
                              </div>
                            </div>
                            {entry._generating ? (
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-amber-500/15">
                                <svg className="h-4 w-4 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                              </div>
                            ) : entry.videoUrl ? (
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-purple-500/15">
                                <svg className="h-4 w-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                              </div>
                            ) : null}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {videoUrl && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { invoke } = await import('@tauri-apps/api/core');
                      const { save } = await import('@tauri-apps/plugin-dialog');
                      let filename = videoUrl.split(/[/\\]/).pop() || 'video.mp4';
                      // 清理URL参数和编码字符
                      filename = filename.split('?')[0].split('#')[0];
                      filename = decodeURIComponent(filename);
                      if (filename.length > 50) filename = `video_${Date.now()}.mp4`;
                      const dest = await save({ defaultPath: filename, filters: [{ name: '视频', extensions: ['mp4'] }] });
                      if (dest) await invoke('copy_file_to_path', { src: videoUrl, dest });
                    } catch (e) { console.error('[VideoGenDialog] save failed:', e); }
                  }}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark/70"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('videoGen.download', '下载')}
                </button>
              )}
              <button
                type="button"
                onClick={handleGenerate}
                // 配置读盘未完成前不许提交：否则音色/提示词等回填还没到，请求会漏参
                disabled={isGenerating || !hydrated}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-purple-500/80 px-4 text-xs font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {isResuming
                  ? t('videoGen.resuming', '正在恢复...')
                  : t('videoGen.generate', '生成视频（2K）')}
              </button>
            </div>
          </div>

          {error && (() => {
            const videoErr = translateVideoError(error);
            return (
              <div className="mt-3 max-w-md rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-left">
                <p className="text-sm font-semibold text-red-400">{videoErr.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-red-300/80 whitespace-pre-wrap">{videoErr.detail}</p>
              </div>
            );
          })()}

        </div>
      </div>

      {/* Confirm dialog */}
      <UiModal
        isOpen={showConfirmDialog}
        onClose={() => setShowConfirmDialog(false)}
        title={t('videoGen.confirmGenerateTitle', '确认生成')}
        widthClassName="w-[420px]"
        footer={
          <div className="flex items-center gap-2 w-full">
            <UiChipButton
              className="h-8 px-3 text-xs"
              onClick={() => setShowConfirmDialog(false)}
            >
              {t('common.cancel', '取消')}
            </UiChipButton>
            <UiChipButton
              className="h-8 px-3 text-xs border-purple-400/60 bg-purple-500/20 text-purple-200"
              onClick={() => executeGenerate()}
            >
              {t('videoGen.confirmGenerate', '确认生成')}
            </UiChipButton>
          </div>
        }
      >
        <div className="py-2 text-center">
          <p className="text-sm text-text-dark leading-relaxed">
            {t('videoGen.confirmGenerateMessage', '将消耗 {{cost}} 积分生成 {{duration}}秒 视频，确定生成吗？', {
              cost: creditCost,
              duration,
            })}
          </p>
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            {t('videoGen.promptOptimizationNotice', '为了准确性，系统可能会根据您的提示词做再次优化，可能会导致1-2积分的额外扣减')}
          </p>
        </div>
      </UiModal>

      {/* Insufficient credits dialog */}
      <UiModal
        isOpen={showInsufficientDialog && !showRecharge}
        onClose={() => setShowInsufficientDialog(false)}
        title={t('videoGen.insufficientCreditsTitle', '积分不足')}
        widthClassName="w-[420px]"
        footer={
          <div className="flex items-center gap-2 w-full">
            <UiChipButton
              className="h-8 px-3 text-xs"
              onClick={() => setShowInsufficientDialog(false)}
            >
              {t('common.cancel', '取消')}
            </UiChipButton>
            <UiChipButton
              className="h-8 px-3 text-xs border-amber-400/60 bg-amber-500/20 text-amber-200"
              onClick={() => setShowRecharge(true)}
            >
              {t('videoGen.goRecharge', '去充值')}
            </UiChipButton>
          </div>
        }
      >
        <div className="py-2 text-center">
          <p className="text-sm text-text-dark leading-relaxed">
            {t('videoGen.insufficientCreditsMessage', '本次生成需要 {{required}} 积分，当前剩余 {{current}} 积分，请充值后再试。', {
              required: insufficientRequired,
              current: insufficientCurrent,
            })}
          </p>
        </div>
      </UiModal>

      {showRecharge && (
        <RechargeDialog
          isOpen={showRecharge}
          onClose={() => setShowRecharge(false)}
          onPaid={async () => {
            setShowRecharge(false);
            setShowInsufficientDialog(false);
            setError(null);
          }}
        />
      )}

      {/* Storyboard prompt picker */}
      <StoryboardPromptPicker
        isOpen={showPromptPicker}
        onClose={() => setShowPromptPicker(false)}
        onSelect={handleSelectPrompt}
      />

      {/* Asset picker dialog */}
      {showAssetPicker && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex h-[500px] w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.12)] bg-surface-dark shadow-2xl">
            <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-5 py-3.5">
              <h3 className="text-sm font-semibold text-text-dark">
                {t('videoGen.selectAssets', '选择资产')}
              </h3>
              <button
                type="button"
                onClick={() => setShowAssetPicker(false)}
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {assets.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
                {t('videoGen.noAssets', '暂无资产，请先在项目管理中添加资产')}
              </div>
            ) : (
              <div className="ui-scrollbar flex-1 overflow-y-auto p-3">
                <div className="grid grid-cols-3 gap-2">
                  {assets.map((asset: any) => {
                    const isSelected = assetPickerSelected.has(asset.id);
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => toggleAssetSelection(asset.id)}
                        className={`relative flex flex-col items-center rounded-xl border p-2 transition-colors ${
                          isSelected
                            ? 'border-purple-400/60 bg-purple-500/20'
                            : 'border-[rgba(255,255,255,0.08)] bg-bg-dark hover:border-purple-400/30'
                        }`}
                      >
                        <img
                          src={convertFileSrc(asset.filePath)}
                          alt={asset.name}
                          className="h-20 w-full rounded-lg object-cover"
                        />
                        <span className="mt-1.5 text-center text-xs font-medium text-text-dark truncate w-full">
                          {asset.name}
                        </span>
                        <span className="text-[10px] text-text-muted">
                          {String(t(`asset.category.${asset.category}`, asset.category))}
                        </span>
                        {isSelected && (
                          <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-purple-500 text-white">
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-[rgba(255,255,255,0.08)] px-5 py-3">
              <span className="text-xs text-text-muted">
                {assetPickerSelected.size > 0
                  ? t('videoGen.assetCount', '已选 {{count}} 项', { count: assetPickerSelected.size })
                  : t('videoGen.clickToSelect', '点击选择资产')}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAssetPicker(false)}
                  className="h-8 rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark px-3 text-xs text-text-muted transition-colors hover:text-text-dark"
                >
                  {t('common.cancel', '取消')}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmAssetImport}
                  disabled={assetPickerSelected.size === 0}
                  className="h-8 rounded-lg bg-purple-500/80 px-4 text-xs font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-30"
                >
                  {t('common.confirm', '确认')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 参考图放大层 —— portal 到 body，层级高于弹窗(z-140)与资产选择器(z-160) */}
      {previewImageUrl && typeof document !== 'undefined'
        ? createPortal(
          <div
            className="fixed inset-0 z-[240] flex items-center justify-center"
            onClick={() => setPreviewImageUrl(null)}
          >
            <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />
            <img
              src={previewImageUrl}
              alt=""
              className="relative max-h-[88vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={() => setPreviewImageUrl(null)}
              className="absolute right-4 top-4 rounded-lg bg-black/50 p-2 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
              title={t('common.close', '关闭')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
