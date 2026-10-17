import { invoke } from '@tauri-apps/api/core';

export interface IntegrationRules {
  model: string;
  max_tokens: number;
  system_prompt: string;
}

export interface VideoGenConstraints {
  global_rule: string;
  spatial_anchor?: string;
  physics_rule?: string;
  facing_lock: string;
  axis_lock: string;
  pose_lock?: string;
  prop_lock?: string;
  anti_hallucination?: string;
  physics_law?: string;
  shot_cutting?: string;
  object_persistence?: string;
  motion_catalog: string;
  shot_continuity: string;
  hard_constraints: string[];
}

export interface VideoGenRules {
  version: string;
  integration: IntegrationRules;
  constraints: VideoGenConstraints;
  /** 负面提示词，用于视频生成质量过滤 */
  negative_prompt?: string;
  /** 注入到提示词前面的规则文本（所有模型通用） */
  prompt_rule?: string;
  /** 服务端 Wan R2V 专用规则（字段名 r2v_prompt_rule） */
  r2v_prompt_rule?: string;
  /** CFG scale，控制生成与提示词的匹配度 */
  guidance_scale?: number;
  /** 镜头模式：single 单镜头 / multi 多镜头 */
  shot_type?: string;
}

// 最小兜底规则 — 仅网络故障时使用。完整规则见服务端 video_gen_rules_minimax_h3.json
const DEFAULT_PROMPT_RULE = '【语言】正文为中文；句中括注的官方英文词是执行指令，按括注执行。\n\n【参考图形态】参考图是 6 宫格故事板：宫格 1→2→3→4→5→6 是一条连续时间线，不是 6 张独立快照拼成的幻灯片。人物/场景/道具/光影跨宫格完全一致，动作从前一格自然延续到后一格。本形态的主参考图只有这一张故事板：正文里的 <Picture N> 一律按官方 §2.2 作为这张故事板的镜头规划参考（storyboard reference）来理解，不要因为编号大于 1 就去寻找另一张参考图。\n\n【参考图是真相】参考图锁定外观与身份，但不是负面清单 —— 官方 §4.2 明确：目标视频里新增的动作/背景/情节都不算参考保真度损失。不许新增的只有用户脚本里没有的场面/人物/地点/故事走向。\n\n【禁止凭空人声】本任务入参只有参考图，不存在任何独立音频资产 ⇒ 一律不许出现 <Audio N>，不许加 audio reference / audio reuse。没有台词的镜头不许写成「有人在说台词」、不许给画面里的人挂 <d>；但环境音必须照官方 §4.6 正面写：官方逐字要求 overall_soundscape 汇总 ambient sound, physical action sounds, and non-verbal human sounds（如 wind, rain, traffic, footsteps, fabric movement, impacts, breathing, laughter, or panting）—— 嘈杂市场/餐馆的人群嗡杂、笑声、餐具碰撞、街市车流都属于这一档，必须写进 overall_soundscape；只有「用户明确要求全片静音」才写 N/A。不许把环境人声写成逐字台词、不许挂到具体人物身上做口型。\n\n【画外音】画外音只按正文里的官方英文句念，不许译成「以画外音说道」：says in an off-screen voiceover，同时 lips remain completely closed。\n\n【文字】画面里/参考图上确实可见的文字（招牌/标签/霓虹/包装字/参考图原有文字与Logo）按官方 §4.5 放进英文双引号逐字保留、不翻译；只禁止凭空新增字幕/水印/随机字母。不许写分辨率、画幅、模型名。';

const DEFAULT_RULES_NEGATIVE_PROMPT = 'chromatic aberration, motion blur excess, morphing, distortion, warping, flicker, unnatural physics, floating objects, anti-gravity, landmark distortion, landscape morphing, building warping, perspective distortion, color bleeding, plastic texture, CG look, 3D render, video game graphics, oversaturated colors, wrong scale, cloning artifacts, AI watermark, empty frame, static image, abrupt transition, gibberish text, random invented lettering, invented speech bubbles, AI-generated watermark overlay, AI-generated subtitles, hallucinated on-screen captions, distorted existing lettering, misspelled existing signage text';

const DEFAULT_RULES: VideoGenRules = {
  version: '10',
  integration: {
    model: 'none',
    max_tokens: 0,
    system_prompt: '',
  },
  guidance_scale: 8.0,
  shot_type: 'multi',
  negative_prompt: DEFAULT_RULES_NEGATIVE_PROMPT,
  prompt_rule: DEFAULT_PROMPT_RULE,
  constraints: {
    global_rule: '正文恒为官方全参考六段式：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段是 detailed_description。六段内不写否定句，缺席写 N/A。参考图锁定外观与身份，运动与状态变化由文字逐项写出。运镜只用官方三维闭集，切镜只用官方 5 动词，参考图用 <Picture N> 指代，台词用 <d>[Chinese] 原文</d> 包装。',
    object_persistence: '物体状态跨格锁定。数量与位置由参考图决定，不消失、不变形、不增减。',
    facing_lock: '人物朝向由参考图锚定，摄像机运动不改变人物朝向。',
    axis_lock: '摄像机保持在轴线同侧，不越轴。',
    motion_catalog: 'Zoom In / Zoom Out | Push In / Pull Out | Pan Left / Pan Right | Truck Left / Truck Right | Tilt Up / Tilt Down | Pedestal Up / Pedestal Down | Arc Shot | Tracking Shot | Static Shot | Shake Slightly / Shake Strongly | POV | Roll Clockwise / Roll Counterclockwise（幅度 with small/large amplitude，速度 at slow/fast speed，中等幅度与常速省略）',
    shot_continuity: '六格→一个连续视频。镜头运动均匀串联，场景/道具/光影跨格一致。官方 §4.2 逐字：If only the distance or a slight angle needs to change, prefer camera motion ⇒ 只是距离或轻微角度要变时优先用运镜；用户明确要求时 cross-dissolve / fade / wipe 也可以用。官方对镜头时长、每镜动作数没有任何量化规定。[Shot 1] 不带时间戳，第 2 镜起 At MM:SS.mmm 严格递增。',
    hard_constraints: [
      '视频提示词正文恒为六段式，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段 detailed_description',
      '六段之外不再添加任何工程约束段（画面稳定/主体与场景锁定/反文字水印由规则头统一注入）',
      '六段内不写否定句；缺席只有 N/A 一个写法',
      '宫格1-6是连续时间线，顺序不变，不添加/不删减/不修改画面内容',
      '参考图里看得见的活物/道具/环境，其运动与状态变化必须逐项写出；禁止新增的理由只有一条：用户脚本里没有的场面/人物/地点/故事走向一个字都不加（官方 §4.2：参考图不是负面清单）',
      'retention_analysis 的判定必须与 detailed_description 的正文同义，不许打架',
      '运镜只用官方三维闭集（12 类 motion type × 幅度 × 速度），表外镜头动作与镜头内光学操作一律不写',
      '切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行',
      '[Shot 1] 不带时间戳；第 2 镜起 At MM:SS.mmm 严格递增、落在总时长内；标记与内容同一行',
      'overall_soundscape 与 non_diegetic_music 两段正面写「有什么」，没有的写 N/A',
      '画内说话在 </d> 之后逐字写「他说话时下颌开合、嘴唇随字句张动」；画外音才写「嘴唇保持完全闭合」；有可见人物无台词必须正面交代嘴在做什么',
      '色温严格按指定值',
      '物体状态跨格锁定，已毁物体只留碎片',
      '所有运动必须符合真实物理规律（重力/惯性/碰撞/流体），禁止反重力悬浮和物体穿模',
      '人物形象/服装/场景外观严格锁死参考图，禁止AI自行重新设计、简化或改写',
      '指代参考图统一用 <Picture N>（N 自 1 起），禁止 @图N / [Image N] 写法',
      '台词用 <d>[Chinese] 原文</d> 包装，标签内一字不改，仅可在标签外补充角色名与情绪语调',
      '画面里/参考图上确实可见的文字（招牌/标签/霓虹/包装字/参考图原有文字与Logo）按官方 §4.5 放进英文双引号逐字保留、不翻译；只禁止凭空新增字幕/水印/随机字母',
      'No text overlays, no watermarks, no subtitles, no captions.',
      'Human realism: breathing, weight shift, natural blinking, live eyes — never frozen, never doll-like, never plastic.',
      'Scene realism: real locations, natural ambient light and weather, believable depth and scale — never plastic, never CG, never 3D render.',
      '旅游内容不做绝对化承诺（最安全、必打卡、100% 保证等），不出现虚构的目的地特征或违反当地文化的画面。',
    ],
  },
};

// 直出兜底规则 —— 「直接生成视频」（videoGenNode）。完整规则见服务端 video_gen_rules_minimax_h3_direct.json
// 与宫格版的唯一实质差异：参考图是若干张独立资产，**没有** 6 宫格时间线语义。
const DEFAULT_PROMPT_RULE_DIRECT = '【语言】正文为中文；句中括注的官方英文词是执行指令，按括注执行。\n\n【参考图形态】参考图是若干张相互独立的素材（人物形象 / 产品 / 场景 / 风格），不是宫格故事板，彼此没有先后顺序、不构成时间线。每张图各自锁定它承载的那部分外观与身份；镜头顺序、动作推进、时间线完全由正文建立，不要假设参考图之间存在「上一格 → 下一格」的延续关系。\n\n【参考图是真相】参考图锁定外观与身份，但不是负面清单 —— 官方 §4.2 明确：目标视频里新增的动作/背景/情节都不算参考保真度损失。不许新增的只有用户脚本里没有的场面/人物/地点/故事走向。\n\n【禁止凭空人声】本任务入参只有参考图，不存在任何独立音频资产 ⇒ 一律不许出现 <Audio N>，不许加 audio reference / audio reuse。没有台词的镜头不许写成「有人在说台词」、不许给画面里的人挂 <d>；但环境音必须照官方 §4.6 正面写：官方逐字要求 overall_soundscape 汇总 ambient sound, physical action sounds, and non-verbal human sounds（如 wind, rain, traffic, footsteps, fabric movement, impacts, breathing, laughter, or panting）—— 嘈杂市场/餐馆的人群嗡杂、笑声、餐具碰撞、街市车流都属于这一档，必须写进 overall_soundscape；只有「用户明确要求全片静音」才写 N/A。不许把环境人声写成逐字台词、不许挂到具体人物身上做口型。\n\n【画外音】画外音只按正文里的官方英文句念，不许译成「以画外音说道」：says in an off-screen voiceover，同时 lips remain completely closed。\n\n【文字】画面里/参考图上确实可见的文字（招牌/标签/霓虹/包装字/参考图原有文字与Logo）按官方 §4.5 放进英文双引号逐字保留、不翻译；只禁止凭空新增字幕/水印/随机字母。不许写分辨率、画幅、模型名。';

const DEFAULT_RULES_DIRECT: VideoGenRules = {
  version: '10',
  integration: {
    model: 'none',
    max_tokens: 0,
    system_prompt: '',
  },
  guidance_scale: 8.0,
  shot_type: 'multi',
  negative_prompt: DEFAULT_RULES_NEGATIVE_PROMPT,
  prompt_rule: DEFAULT_PROMPT_RULE_DIRECT,
  constraints: {
    global_rule: '正文恒为官方全参考六段式：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段是 detailed_description。六段内不写否定句，缺席写 N/A。参考图是若干张相互独立的素材，不构成时间线；每张图各自锁定其承载的外观与身份，运动与状态变化由文字逐项写出。运镜只用官方三维闭集，切镜只用官方 5 动词，参考图用 <Picture N> 指代，台词用 <d>[Chinese] 原文</d> 包装。',
    object_persistence: '物体状态在整条时间线内锁定。数量与位置由参考图决定，不消失、不变形、不增减。',
    facing_lock: '人物朝向由参考图锚定，摄像机运动不改变人物朝向。',
    axis_lock: '摄像机保持在轴线同侧，不越轴。',
    motion_catalog: 'Zoom In / Zoom Out | Push In / Pull Out | Pan Left / Pan Right | Truck Left / Truck Right | Tilt Up / Tilt Down | Pedestal Up / Pedestal Down | Arc Shot | Tracking Shot | Static Shot | Shake Slightly / Shake Strongly | POV | Roll Clockwise / Roll Counterclockwise（幅度 with small/large amplitude，速度 at slow/fast speed，中等幅度与常速省略）',
    shot_continuity: '镜头顺序与动作推进由正文建立，参考图之间不存在「上一格→下一格」的延续关系。镜头运动均匀串联，同一主体跨镜外观/服装/光影一致。官方 §4.2 逐字：If only the distance or a slight angle needs to change, prefer camera motion ⇒ 只是距离或轻微角度要变时优先用运镜；用户明确要求时 cross-dissolve / fade / wipe 也可以用。官方对镜头时长、每镜动作数没有任何量化规定。[Shot 1] 不带时间戳，第 2 镜起 At MM:SS.mmm 严格递增。',
    hard_constraints: [
      '视频提示词正文恒为六段式，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段 detailed_description',
      '六段之外不再添加任何工程约束段（画面稳定/主体与场景锁定/反文字水印由规则头统一注入）',
      '六段内不写否定句；缺席只有 N/A 一个写法',
      '参考图是若干张相互独立的素材，不假设它们之间存在宫格或时间线顺序',
      '参考图里看得见的活物/道具/环境，其运动与状态变化必须逐项写出；禁止新增的理由只有一条：用户脚本里没有的场面/人物/地点/故事走向一个字都不加（官方 §4.2：参考图不是负面清单）',
      'retention_analysis 的判定必须与 detailed_description 的正文同义，不许打架',
      '运镜只用官方三维闭集（12 类 motion type × 幅度 × 速度），表外镜头动作与镜头内光学操作一律不写',
      '切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行',
      '[Shot 1] 不带时间戳；第 2 镜起 At MM:SS.mmm 严格递增、落在总时长内；标记与内容同一行',
      'overall_soundscape 与 non_diegetic_music 两段正面写「有什么」，没有的写 N/A',
      '画内说话在 </d> 之后逐字写「他说话时下颌开合、嘴唇随字句张动」；画外音才写「嘴唇保持完全闭合」；有可见人物无台词必须正面交代嘴在做什么',
      '色温严格按指定值',
      '物体状态锁定，已毁物体只留碎片',
      '所有运动必须符合真实物理规律（重力/惯性/碰撞/流体），禁止反重力悬浮和物体穿模',
      '人物形象/服装/场景外观严格锁死参考图，禁止AI自行重新设计、简化或改写',
      '指代参考图统一用 <Picture N>（N 自 1 起），禁止 @图N / [Image N] 写法',
      '台词用 <d>[Chinese] 原文</d> 包装，标签内一字不改，仅可在标签外补充角色名与情绪语调',
      '画面里/参考图上确实可见的文字（招牌/标签/霓虹/包装字/参考图原有文字与Logo）按官方 §4.5 放进英文双引号逐字保留、不翻译；只禁止凭空新增字幕/水印/随机字母',
      'No text overlays, no watermarks, no subtitles, no captions.',
      'Human realism: breathing, weight shift, natural blinking, live eyes — never frozen, never doll-like, never plastic.',
      'Scene realism: real locations, natural ambient light and weather, believable depth and scale — never plastic, never CG, never 3D render.',
      '旅游内容不做绝对化承诺（最安全、必打卡、100% 保证等），不出现虚构的目的地特征或违反当地文化的画面。',
    ],
  },
};

/**
 * 规则用途：
 * - `grid`：宫格路。参考图是 1 张 6 宫格故事板，宫格 1→6 是一条连续时间线。
 * - `direct`：直出路。参考图是若干张独立资产（chat 页「直接生成视频」建的 videoGenNode），
 *   没有宫格时间线语义，绝不能套用宫格规则头。
 */
export type VideoGenRuleMode = 'grid' | 'direct';

/** 按 `${model||'default'}|${mode}` 分键缓存 —— 单值缓存会让切模型/切 mode 串规则 */
/**
 * 规则头的进程内缓存有效期。
 *
 * 🔴 2026-10-16 两次生产事故都栽在这里：缓存原先**没有 TTL**，一个进程只取一次，
 *   ⇒ 服务端热更后，**开着的客户端永远拿不到新头**，用户必须重启客户端才行。
 *   最惨的一次：客户端还揣着 v6 头（5355 字），加上正文合计 7848 字，
 *   直接撞上视频模型 `Params [Prompt], should be in [1, 7000]` 提交失败 ——
 *   而线上早已是短得多的新版头。查了服务端 access log 才确认是**客户端没换头**。
 * 5 分钟：热点路径最多每 5 分钟多一次 HTTP 请求，对交互无可感影响。
 */
const RULES_TTL_MS = 5 * 60 * 1000;

interface RulesCacheEntry {
  rules: VideoGenRules;
  at: number;
}
const rulesCache = new Map<string, RulesCacheEntry>();
const inflight = new Map<string, Promise<VideoGenRules>>();

function cacheKey(model: string | undefined, mode: VideoGenRuleMode): string {
  return `${model || 'default'}|${mode}`;
}

export async function fetchVideoGenRules(
  model?: string,
  mode: VideoGenRuleMode = 'grid',
): Promise<VideoGenRules> {
  const key = cacheKey(model, mode);
  const hit = rulesCache.get(key);
  if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit.rules;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const raw: string = await invoke('fetch_video_gen_rules', {
        model: model || null,
        mode,
      });
      const parsed = JSON.parse(raw) as VideoGenRules;
      // 服务端 Wan R2V 用 r2v_prompt_rule 字段名，映射到通用 prompt_rule
      if (!parsed.prompt_rule && parsed.r2v_prompt_rule) {
        parsed.prompt_rule = parsed.r2v_prompt_rule;
      }
      if (parsed?.version && parsed.constraints) {
        rulesCache.set(key, { rules: parsed, at: Date.now() });
        return parsed;
      }
      throw new Error('Invalid rules from server');
    } catch (e) {
      console.warn(`[videoGenRules] Server fetch failed (${key}), using fallback:`, e);
      // 🔴 兜底**不再永久驻留**：曾经一次网络抖动就让整个进程再也拿不到线上头。
      // 优先沿用上次成功取到的规则头（那也远比内置兜底接近线上）；
      // 沿用时不刷新时间戳 ⇒ 下个 TTL 窗口还会重试。只有从没成功取到过时才用内置兜底。
      if (hit) return hit.rules;
      const fallback = mode === 'direct' ? DEFAULT_RULES_DIRECT : DEFAULT_RULES;
      rulesCache.set(key, { rules: fallback, at: Date.now() });
      return fallback;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

export function getCachedRules(model?: string, mode: VideoGenRuleMode = 'grid'): VideoGenRules | null {
  return rulesCache.get(cacheKey(model, mode))?.rules ?? null;
}

export function clearRulesCache(): void {
  rulesCache.clear();
  inflight.clear();
}
