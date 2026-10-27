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
  /** CFG scale，控制生成与提示词的匹配度 */
  guidance_scale?: number;
  /** 镜头模式：single 单镜头 / multi 多镜头 */
  shot_type?: string;
}

// 最小兜底规则 — 仅网络故障时使用。完整规则见服务端 video_gen_rules_minimax_h3.json
const DEFAULT_PROMPT_RULE = '';

const DEFAULT_RULES_NEGATIVE_PROMPT = 'chromatic aberration, motion blur excess, morphing, distortion, warping, flicker, unnatural physics, floating objects, anti-gravity, product shape drift, product color shift, invented objects, disappearing objects, object deformation, bad anatomy, deformed hands, extra fingers, distorted faces, identity shift, oversharpening, plastic skin, waxy skin, blurry, jitter, noise, ghosting, frame skipping, lowres, overexposure, text artifacts, AI watermark, AI subtitle, empty frame, grid lines, split screen, static image, abrupt transition, doll-like, wax figure, dead eyes, lifeless eyes, frozen expression, fixed smile, uncanny valley, robotic movement, mechanical motion, exaggerated gesture, over-smooth skin, stiffness, waxiness, gibberish text, random invented lettering, invented speech bubbles, AI-generated watermark overlay, AI-generated subtitles, hallucinated on-screen captions, distorted existing lettering, misspelled existing signage text, landmark distortion, landscape morphing, building warping, perspective distortion, color bleeding, plastic texture, CG look, 3D render, video game graphics, oversaturated colors, wrong scale, cloning artifacts';

const DEFAULT_RULES: VideoGenRules = {
  version: '10',
  integration: {
    model: 'minimax/minimax-h3',
    max_tokens: 0,
    system_prompt: '',
  },
  guidance_scale: 8.0,
  shot_type: 'multi',
  negative_prompt: DEFAULT_RULES_NEGATIVE_PROMPT,
  prompt_rule: DEFAULT_PROMPT_RULE,
  constraints: {
    global_rule: '正文恒为官方全参考六段式：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段是 detailed_description。声音两段落笔只写「有什么」，六段散文正文用中文写（提交前由回译规则译成官方英文，官方 §5.1 的英文要求由提交链路满足），<d> 内台词按台词原语言逐字保留；overall_soundscape 只有「用户明确要求全片静音」才写 N/A，有一点声音就必须正面写，non_diegetic_music 没有配乐写 N/A。全文不许出现 <Audio N>。参考图锁定外观与身份，运动与状态变化由文字逐项写出。运镜只用官方 `Available Expression` 表，切镜只用官方 5 动词，参考图用 <Picture N> 指代，台词用 <d>[Language] 原文</d> 包装。',
    object_persistence: '物体状态跨格锁定。数量与位置由参考图决定，不消失、不变形、不增减。',
    facing_lock: '人物朝向由参考图锚定，摄像机运动不改变人物朝向。',
    axis_lock: '摄像机保持在轴线同侧，不越轴。',
    motion_catalog: 'Zoom In / Zoom Out | Push In / Pull Out | Pan Left / Pan Right | Truck Left / Truck Right | Tilt Up / Tilt Down | Pedestal Up / Pedestal Down | Arc Shot | Tracking Shot | Static Shot | Shake Slightly / Shake Strongly | POV | Roll Clockwise / Roll Counterclockwise（幅度 with small/large amplitude，速度 at slow/fast speed，中等幅度与常速省略）',
    shot_continuity: '六格→一个连续视频。镜头运动均匀串联，场景/道具/光影跨格一致。官方 §4.2 逐字：If only the distance or a slight angle needs to change, prefer camera motion ⇒ 只是距离或轻微角度要变时优先用运镜；用户明确要求时 cross-dissolve / fade / wipe 也可以用。官方对镜头时长、每镜动作数没有任何量化规定。[Shot 1] 不带时间戳，第 2 镜起 At MM:SS.mmm 严格递增。',
    hard_constraints: [
      '视频提示词正文恒为六段式，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段 detailed_description',
      '六段之外不再添加任何工程约束段（规则头已于 2026-10-28 整段置空，客户端不再注入任何附加条款）',
      '两段声音正文用中文正面写「有什么」；overall_soundscape 写 N/A 只有「用户明确要求全片静音」一个前提（官方 §4.6），有一点声音就必须正面写；non_diegetic_music 没有非剧情配乐写 N/A（官方 §4.7）',
      '六段散文正文一律用中文写（提交前由回译规则译成官方英文）；<d> 内台词按台词原语言逐字保留；官方字面量（段名 / [Shot N] / At MM:SS.mmm / N/A / retention 标记 / 各类标签 / 画外音句 / 双唇闭合句 / 运镜闭集 / 景别 5 档 / 切镜 5 动词）直接写英文原文，不再加中文括注；不许自造官方没有的英文（a wide shot / a full shot / a medium close-up / an extreme wide shot 一律不写）；光影只做英文定性描述，不贴 golden hour / Rembrandt lighting 这类流派标签；人声写 recitation / recites / speaks，不许写 chant / sing / intone（用户明确要求唱歌时才用 sing）；有台词画内说话镜在 </d> 之后逐字写官方口型串 `his/her/its mouth movements naturally syncing to the new dialogue`（2026-10-28 起撤回中文口型句，正文不再有任何中文内容句）',
      '全文禁止出现 <Audio N>；summary 恒为 [reference generation]，不许加 + audio reuse / + audio reference（本产品入参只有参考图，官方 §2.4 / §2.5）',
      '宫格1-6是连续时间线，顺序不变，不添加/不删减/不修改画面内容',
      '参考图里看得见的活物/道具/环境，其运动与状态变化必须逐项写出；禁止新增的理由只有一条：用户脚本里没有的场面/人物/地点/故事走向一个字都不加（官方 §4.2：参考图不是负面清单）',
      'retention_analysis 的判定必须与 detailed_description 的正文同义，不许打架；正文里出现脱落/破损/数量变化/光影变化这类状态变化时，该条声明必须覆盖它，覆盖不到就改判 partially_preserved',
      '运镜只用官方 `Available Expression` 表（12 类 motion type × 幅度 × 速度，幅度与速度只在有意义时才加），表外镜头动作与镜头内光学操作一律不写；同一镜内同一个运镜只写一次',
      '切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行',
      '[Shot 1] 不带时间戳；第 2 镜起 At MM:SS.mmm 严格递增、落在总时长内；标记与内容同一行',
      'overall_soundscape 与 non_diegetic_music 两段正文用英文正面写「有什么」；overall_soundscape 写 N/A 只有「用户明确要求全片静音」一个前提，non_diegetic_music 没有非剧情配乐写 N/A',
      '说话人一律写成 <Subject N> (Sx) 两件套（官方 §5.4），不许用代词顶替 <Subject N>；识别语/动作/语气写在 <d> 外面，<d> 里只放语言标签 + 用户台词原文（官方 §4.4）；每个发声处必须带上该人的 (Sx)（官方 §5.4 编号一次处处复用）；画内说话时在 </d> 之后逐字写官方口型串 `his/her/its mouth movements naturally syncing to the new dialogue`（主语按实际说话人取）；画外音逐字用官方英文 <Subject N> (Sx) says in an off-screen voiceover: <d>[Language] …</d> while his/her/its lips remain completely closed（不许译成中文——那是触发字面量）；**画内主体说画外音时不加 off-screen 标注**（官方 §4.4 范例无此标注；§5.4 的 off-screen 只用于主体本人在画框外发声）；没有发声事件的镜头不给 (Sx)、不写 <d>，嘴部只写不发声的动作',
      '光线只做中文定性描述（方向 + 光质 + 冷暖）；不写 3200K / 4500K / 5600K / 2000K 这类色温数值，也不贴 golden hour / Rembrandt lighting 这类流派标签',
      '物体状态跨格锁定，已毁物体只留碎片',
      '所有运动必须符合真实物理规律（重力/惯性/碰撞/流体），禁止反重力悬浮和物体穿模',
      '产品外形/材质/颜色/Logo严格锁死参考图，禁止AI自行重新设计或简化产品外观',
      '人物形象/服装/场景外观严格锁死参考图，禁止AI自行重新设计、简化或改写',
      'Scene realism: real locations, natural ambient light and weather, believable depth and scale — never plastic, never CG, never 3D render.',
      '旅游内容不做绝对化承诺（最安全、必打卡、100% 保证等），不出现虚构的目的地特征或违反当地文化的画面。',
      '指代参考图统一用 <Picture N>（N 自 1 起），禁止 @图N / [Image N] 写法',
      '台词用 <d>[Language] 原文</d> 包装（语言标签按台词实际语言写），标签内一字不改，仅可在标签外补充角色名与情绪语调',
      '画面里/参考图上确实可见的文字（招牌/标签/霓虹/包装字/参考图原有文字与Logo）按官方 §4.5 放进英文双引号逐字保留、不翻译；只禁止凭空新增字幕/水印/随机字母',
      'Human realism: breathing, weight shift, natural blinking, live eyes — never frozen, never doll-like, never plastic.',
    ],
  },
};

// 直出兜底规则 —— 「直接生成视频」（videoGenNode）。完整规则见服务端 video_gen_rules_minimax_h3_direct.json
// 与宫格版的唯一实质差异：参考图是若干张独立资产，**没有** 6 宫格时间线语义。
const DEFAULT_PROMPT_RULE_DIRECT = '';

const DEFAULT_RULES_DIRECT: VideoGenRules = {
  version: '10',
  integration: {
    model: 'minimax/minimax-h3',
    max_tokens: 0,
    system_prompt: '',
  },
  guidance_scale: 8.0,
  shot_type: 'multi',
  negative_prompt: DEFAULT_RULES_NEGATIVE_PROMPT,
  prompt_rule: DEFAULT_PROMPT_RULE_DIRECT,
  constraints: {
    global_rule: '正文恒为官方全参考六段式：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段是 detailed_description。声音两段落笔只写「有什么」，六段散文正文用中文写（明示例外：官方 §5.1 要求英文，但正文是用户可见、可改的产物；除语言外结构/字面量/标记照官方）；overall_soundscape 只有「用户明确要求全片静音」才写 N/A，有一点声音就必须正面写，non_diegetic_music 没有配乐写 N/A。全文不许出现 <Audio N>。参考图是若干张相互独立的素材，不构成时间线；每张图各自锁定其承载的外观与身份，运动与状态变化由文字逐项写出。运镜只用官方 `Available Expression` 表，切镜只用官方 5 动词，参考图用 <Picture N> 指代，台词用 <d>[Language] 原文</d> 包装。',
    object_persistence: '物体状态在整条时间线内锁定。数量与位置由参考图决定，不消失、不变形、不增减。',
    facing_lock: '人物朝向由参考图锚定，摄像机运动不改变人物朝向。',
    axis_lock: '摄像机保持在轴线同侧，不越轴。',
    motion_catalog: 'Zoom In / Zoom Out | Push In / Pull Out | Pan Left / Pan Right | Truck Left / Truck Right | Tilt Up / Tilt Down | Pedestal Up / Pedestal Down | Arc Shot | Tracking Shot | Static Shot | Shake Slightly / Shake Strongly | POV | Roll Clockwise / Roll Counterclockwise（幅度 with small/large amplitude，速度 at slow/fast speed，中等幅度与常速省略）',
    shot_continuity: '镜头顺序与动作推进由正文建立，参考图之间不存在「上一格→下一格」的延续关系。镜头运动均匀串联，同一主体跨镜外观/服装/光影一致。官方 §4.2 逐字：If only the distance or a slight angle needs to change, prefer camera motion ⇒ 只是距离或轻微角度要变时优先用运镜；用户明确要求时 cross-dissolve / fade / wipe 也可以用。官方对镜头时长、每镜动作数没有任何量化规定。[Shot 1] 不带时间戳，第 2 镜起 At MM:SS.mmm 严格递增。',
    hard_constraints: [
      '视频提示词正文恒为六段式，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段 detailed_description',
      '六段之外不再添加任何工程约束段（规则头已于 2026-10-28 整段置空，客户端不再注入任何附加条款）',
      '两段声音正文用中文正面写「有什么」；overall_soundscape 写 N/A 只有「用户明确要求全片静音」一个前提（官方 §4.6），有一点声音就必须正面写；non_diegetic_music 没有非剧情配乐写 N/A（官方 §4.7）',
      '六段散文正文一律用中文写（提交前由回译规则译成官方英文）；<d> 内台词按台词原语言逐字保留；官方字面量（段名 / [Shot N] / At MM:SS.mmm / N/A / retention 标记 / 各类标签 / 画外音句 / 双唇闭合句 / 运镜闭集 / 景别 5 档 / 切镜 5 动词）直接写英文原文，不再加中文括注；不许自造官方没有的英文（a wide shot / a full shot / a medium close-up / an extreme wide shot 一律不写）；光影只做英文定性描述，不贴 golden hour / Rembrandt lighting 这类流派标签；人声写 recitation / recites / speaks，不许写 chant / sing / intone（用户明确要求唱歌时才用 sing）；有台词画内说话镜在 </d> 之后逐字写官方口型串 `his/her/its mouth movements naturally syncing to the new dialogue`（2026-10-28 起撤回中文口型句，正文不再有任何中文内容句）',
      '全文禁止出现 <Audio N>；summary 恒为 [reference generation]，不许加 + audio reuse / + audio reference（本产品入参只有参考图，官方 §2.4 / §2.5）',
      '参考图是若干张相互独立的素材，不假设它们之间存在宫格或时间线顺序',
      '参考图里看得见的活物/道具/环境，其运动与状态变化必须逐项写出；禁止新增的理由只有一条：用户脚本里没有的场面/人物/地点/故事走向一个字都不加（官方 §4.2：参考图不是负面清单）',
      'retention_analysis 的判定必须与 detailed_description 的正文同义，不许打架；正文里出现脱落/破损/数量变化/光影变化这类状态变化时，该条声明必须覆盖它，覆盖不到就改判 partially_preserved',
      '运镜只用官方 `Available Expression` 表（12 类 motion type × 幅度 × 速度，幅度与速度只在有意义时才加），表外镜头动作与镜头内光学操作一律不写；同一镜内同一个运镜只写一次',
      '切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行',
      '[Shot 1] 不带时间戳；第 2 镜起 At MM:SS.mmm 严格递增、落在总时长内；标记与内容同一行',
      'overall_soundscape 与 non_diegetic_music 两段正文用英文正面写「有什么」；overall_soundscape 写 N/A 只有「用户明确要求全片静音」一个前提，non_diegetic_music 没有非剧情配乐写 N/A',
      '说话人一律写成 <Subject N> (Sx) 两件套（官方 §5.4），不许用代词顶替 <Subject N>；识别语/动作/语气写在 <d> 外面，<d> 里只放语言标签 + 用户台词原文（官方 §4.4）；每个发声处必须带上该人的 (Sx)（官方 §5.4 编号一次处处复用）；画内说话时在 </d> 之后逐字写官方口型串 `his/her/its mouth movements naturally syncing to the new dialogue`（主语按实际说话人取）；画外音逐字用官方英文 <Subject N> (Sx) says in an off-screen voiceover: <d>[Language] …</d> while his/her/its lips remain completely closed（不许译成中文——那是触发字面量）；**画内主体说画外音时不加 off-screen 标注**（官方 §4.4 范例无此标注；§5.4 的 off-screen 只用于主体本人在画框外发声）；没有发声事件的镜头不给 (Sx)、不写 <d>，嘴部只写不发声的动作',
      '光线只做中文定性描述（方向 + 光质 + 冷暖）；不写 3200K / 4500K / 5600K / 2000K 这类色温数值，也不贴 golden hour / Rembrandt lighting 这类流派标签',
      '物体状态锁定，已毁物体只留碎片',
      '所有运动必须符合真实物理规律（重力/惯性/碰撞/流体），禁止反重力悬浮和物体穿模',
      '产品外形/材质/颜色/Logo严格锁死参考图，禁止AI自行重新设计或简化产品外观',
      '人物形象/服装/场景外观严格锁死参考图，禁止AI自行重新设计、简化或改写',
      'Scene realism: real locations, natural ambient light and weather, believable depth and scale — never plastic, never CG, never 3D render.',
      '旅游内容不做绝对化承诺（最安全、必打卡、100% 保证等），不出现虚构的目的地特征或违反当地文化的画面。',
      '指代参考图统一用 <Picture N>（N 自 1 起），禁止 @图N / [Image N] 写法',
      '台词用 <d>[Language] 原文</d> 包装（语言标签按台词实际语言写），标签内一字不改，仅可在标签外补充角色名与情绪语调',
      '画面里/参考图上确实可见的文字（招牌/标签/霓虹/包装字/参考图原有文字与Logo）按官方 §4.5 放进英文双引号逐字保留、不翻译；只禁止凭空新增字幕/水印/随机字母',
      'Human realism: breathing, weight shift, natural blinking, live eyes — never frozen, never doll-like, never plastic.',
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

/**
 * 规则头的进程内缓存有效期。
 *
 * 🔴 2026-10-16 两次生产事故都栽在这里：缓存原先**没有 TTL**，一个进程只取一次，
 *    ⇒ 服务端热更后，**开着的客户端永远拿不到新头**，用户必须重启客户端才行。
 *    最惨的一次：客户端还揣着 v6 头（5355 字），加上正文合计 7848 字，
 *    直接撞上视频模型 `Params [Prompt], should be in [1, 7000]` 提交失败 ——
 *    而线上早已是短得多的新版头。查了服务端 access log 才确认是**客户端没换头**。
 * 5 分钟：热点路径最多每 5 分钟多一次 HTTP 请求，对交互无可感影响。
 */
const RULES_TTL_MS = 5 * 60 * 1000;

interface RulesCacheEntry {
  rules: VideoGenRules;
  at: number;
}

/** 按 `${model||'default'}|${mode}` 分键缓存 —— 单值缓存会让切模型/切 mode 串规则 */
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
