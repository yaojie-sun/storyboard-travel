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
const DEFAULT_PROMPT_RULE = '【核心指令】这是一段「参考图 → 视频」（全参考）的生成任务。正文必须严格遵循官方全参考六段式：段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行。subject_definitions: / summary: / retention_analysis: / detailed_description: / overall_soundscape: / non_diegetic_music:。主字段是 detailed_description（不是 integrated_multimodal_description）。客户端按字符串认段名，写错/漏段/换序 = 解析失败。六段之外不要再添加任何工程约束段——画面稳定、主体与场景锁定、反文字水印这类约束由本规则头统一注入，你不写。【时间线】参考图是 6 宫格故事板：宫格 1→2→3→4→5→6 是一条连续时间线，不是 6 张独立快照拼接的幻灯片。人物/场景/道具/光影跨宫格完全一致，动作从前一格自然延续到后一格，无跳跃、无重置、无时间倒流。【参考图是真相，运动是你的职责】参考图锁定外观、身份与构图；但参考图里看得见的活物、道具、环境，它们的运动与状态变化必须用文字逐项写出——写明才会动，不写它就不动。用「环境保持不变」这类概括话等于没写。参考图里没有的元素，一件都不许加。【运镜闭集】运镜只能取自：Zoom In / Zoom Out、Push In / Pull Out、Pan Left / Pan Right、Truck Left / Truck Right、Tilt Up / Tilt Down、Pedestal Up / Pedestal Down、Arc Shot、Tracking Shot、Static Shot、Shake Slightly / Shake Strongly、POV、Roll Clockwise / Roll Counterclockwise，另加幅度 with small amplitude / with large amplitude、速度 at slow speed / at fast speed（中等幅度与常速省略不写）。表以外的镜头动作一律不写。运镜写成一整句自然的镜头内动作，不要在句尾堆机位标签。【切镜】切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行。不写 Cut to / Then / Begin with 这类裸指令。【时间戳】[Shot 1] 不带时间戳；第 2 镜起写 At MM:SS.mmm，严格递增、落在总时长内、保留三位毫秒；标记与内容必须在同一行。每个镜头时长不低于 1.5 秒，相邻镜头时间戳间隔 ≥1.5 秒，禁止一闪而过的碎镜头。单镜头内动作不超过 2-3 个。【两段音频】overall_soundscape 写环境音+物理声+非语言人声（1-4 句，声源+质感）；对白与画内声留在 detailed_description，这里不重复。non_diegetic_music 写仅观众可听的配乐。两段都必须正面写「有什么」，没有的写 N/A。【不写否定句】六段里一律不写否定句（「没有人声」「不含配乐」「没有动」）。本模型无负面分支，否定句会被当成要求渲染出来。缺席只有 N/A 一个写法。【说话与嘴部】说话人给稳定 ID (S1)/(S2)，同人跨镜同号，从不发声的不给号；(Sx) 不写进 retention_analysis。画内说话时，台词包在 <d>[Chinese] 台词原文</d> 里，并在 </d> 之后逐字写「他说话时下颌开合、嘴唇随字句张动」（主语按实际说话人换成她/它，其余逐字不动）。画外音（心里说/心声/内心独白/旁白）才写「嘴唇保持完全闭合」。有可见人物但没有台词的镜头，必须正面交代嘴在做什么。【retention 与正文同义】标注 fully_preserved 的内容，正文必须让它完全保留；正文要改动它，就改判 partially_preserved。两者打架 = 自相矛盾，重写那句。【物理规律·强制】所有运动符合真实物理：重力向下、物体自然下落、碰撞反弹、布料/头发/液体按物理运动；禁止反重力悬浮、物体凭空出现/消失、违反惯性瞬时变速。【色温】指定色温时严格遵循：暖光 3200K / 中性 4500K / 冷光 5600K。【物体状态锁定】物体被摧毁后只留碎片，不复活、不重置。【参考图引用标签】需要指定「某张参考图」时，用 <Picture N> 标签指代，N 按参考图上传顺序从 1 开始。禁止 @图N / [Image N] 写法。【台词标记】用户提供的台词必须逐字保留，用 <d>[Chinese] 台词原文</d> 包装，标签内文字一字不改。【人物真人质感】静止也有呼吸起伏/重心微移/自然眨眼/发丝微动，表情由眼神与细微张力传递（克制真实不夸张），动作有加减速与重心转移；禁止蜡像感/娃娃感/塑料皮肤/死鱼眼/固定微笑/机器人匀速/瞬间起停/卡通夸张表情。【禁止】禁止画面上的任何文字（招牌字/包装字/字幕/霓虹字/对话框/水印）；禁止分辨率/画幅/模型名。No text overlays, no watermarks, no subtitles, no captions.';

const DEFAULT_RULES_NEGATIVE_PROMPT = 'chromatic aberration, motion blur excess, morphing, distortion, warping, flicker, unnatural physics, floating objects, anti-gravity, landmark distortion, landscape morphing, building warping, perspective distortion, color bleeding, plastic texture, CG look, 3D render, video game graphics, oversaturated colors, wrong scale, cloning artifacts, AI watermark, empty frame, static image, abrupt transition';

const DEFAULT_RULES: VideoGenRules = {
  version: '4',
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
    shot_continuity: '六格→一个连续视频。镜头运动均匀串联，每个镜头时长≥1.5秒，禁止一闪而过的碎镜头。场景/道具/光影跨格一致。画面与人物一致时用运镜连贯过渡、禁止硬切；仅场景发生实质变化时才用官方切镜动词切镜。[Shot 1] 不带时间戳，第 2 镜起 At MM:SS.mmm 严格递增。',
    hard_constraints: [
      '视频提示词正文恒为六段式，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段 detailed_description',
      '六段之外不再添加任何工程约束段（画面稳定/主体与场景锁定/反文字水印由规则头统一注入）',
      '六段内不写否定句；缺席只有 N/A 一个写法',
      '宫格1-6是连续时间线，顺序不变，不添加/不删减/不修改画面内容',
      '参考图里看得见的活物/道具/环境，其运动与状态变化必须逐项写出；参考图里没有的一件不加',
      'retention_analysis 的判定必须与 detailed_description 的正文同义，不许打架',
      '运镜只用官方三维闭集（12 类 motion type × 幅度 × 速度），表外镜头动作与镜头内光学操作一律不写',
      '切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行',
      '[Shot 1] 不带时间戳；第 2 镜起 At MM:SS.mmm 严格递增、落在总时长内；标记与内容同一行',
      '每个镜头时长≥1.5秒，相邻镜头时间戳间隔≥1.5秒，禁止一闪而过的碎镜头',
      'overall_soundscape 与 non_diegetic_music 两段正面写「有什么」，没有的写 N/A',
      '画内说话在 </d> 之后逐字写「他说话时下颌开合、嘴唇随字句张动」；画外音才写「嘴唇保持完全闭合」；有可见人物无台词必须正面交代嘴在做什么',
      '色温严格按指定值',
      '物体状态跨格锁定，已毁物体只留碎片',
      '所有运动必须符合真实物理规律（重力/惯性/碰撞/流体），禁止反重力悬浮和物体穿模',
      '人物形象/服装/场景外观严格锁死参考图，禁止AI自行重新设计、简化或改写',
      '指代参考图统一用 <Picture N>（N 自 1 起），禁止 @图N / [Image N] 写法',
      '台词用 <d>[Chinese] 原文</d> 包装，标签内一字不改，仅可在标签外补充角色名与情绪语调',
      '成片里不出现任何画面上的文字（招牌字/包装字/字幕/霓虹字/对话框/水印）',
      'No text overlays, no watermarks, no subtitles, no captions.',
      'Human realism: breathing, weight shift, natural blinking, live eyes — never frozen, never doll-like, never plastic.',
      'Scene realism: real locations, natural ambient light and weather, believable depth and scale — never plastic, never CG, never 3D render.',
      '旅游内容不做绝对化承诺（最安全、必打卡、100% 保证等），不出现虚构的目的地特征或违反当地文化的画面。',
    ],
  },
};

// 直出兜底规则 —— 「直接生成视频」（videoGenNode）。完整规则见服务端 video_gen_rules_minimax_h3_direct.json
// 与宫格版的唯一实质差异：参考图是若干张独立资产，**没有** 6 宫格时间线语义。
const DEFAULT_PROMPT_RULE_DIRECT = '【核心指令】这是一段「参考图 → 视频」（全参考）的生成任务。正文必须严格遵循官方全参考六段式：段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行。subject_definitions: / summary: / retention_analysis: / detailed_description: / overall_soundscape: / non_diegetic_music:。主字段是 detailed_description（不是 integrated_multimodal_description）。客户端按字符串认段名，写错/漏段/换序 = 解析失败。六段之外不要再添加任何工程约束段——画面稳定、主体与场景锁定、反文字水印这类约束由本规则头统一注入，你不写。【参考图形态】本次参考图是若干张**相互独立**的素材（人物形象 / 产品 / 场景 / 风格），不是宫格故事板，它们之间**没有先后顺序、不构成时间线**。每张图各自锁定它承载的那部分外观与身份；镜头顺序、动作推进、时间线完全由你的正文建立，不要假设参考图之间存在「上一格 → 下一格」的延续关系。【参考图是真相，运动是你的职责】参考图锁定外观、身份与构图；但参考图里看得见的活物、道具、环境，它们的运动与状态变化必须用文字逐项写出——写明才会动，不写它就不动。用「环境保持不变」这类概括话等于没写。参考图里没有的元素，一件都不许加。【运镜闭集】运镜只能取自：Zoom In / Zoom Out、Push In / Pull Out、Pan Left / Pan Right、Truck Left / Truck Right、Tilt Up / Tilt Down、Pedestal Up / Pedestal Down、Arc Shot、Tracking Shot、Static Shot、Shake Slightly / Shake Strongly、POV、Roll Clockwise / Roll Counterclockwise，另加幅度 with small amplitude / with large amplitude、速度 at slow speed / at fast speed（中等幅度与常速省略不写）。表以外的镜头动作、表以外的镜头内光学操作，一律不写。运镜写成一整句自然的镜头内动作，不要在句尾堆机位标签。【切镜】切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行。不写 Cut to / Then / Begin with 这类裸指令。【时间戳】[Shot 1] 不带时间戳；第 2 镜起写 At MM:SS.mmm，严格递增、落在总时长内、保留三位毫秒；镜头标记与镜头内容必须在同一行。每个镜头时长不低于 1.5 秒，相邻镜头时间戳间隔 ≥1.5 秒，禁止一闪而过的碎镜头。单镜头内动作不超过 2-3 个。【两段音频】overall_soundscape 写环境音+物理声+非语言人声（1-4 句，声源+质感）；对白与画内声留在 detailed_description，这里不重复。non_diegetic_music 写仅观众可听的配乐。两段都必须正面写「有什么」，没有的写 N/A。【不写否定句】六段里一律不写否定句（「没有人声」「不含配乐」「没有动」）。本模型无负面分支，否定句会被当成要求渲染出来。缺席只有 N/A 一个写法。【说话与嘴部】说话人给稳定 ID (S1)/(S2)，同人跨镜同号，从不发声的不给号；(Sx) 不写进 retention_analysis。画内说话时，台词包在 <d>[Chinese] 台词原文</d> 里，并在 </d> 之后逐字写「他说话时下颌开合、嘴唇随字句张动」（主语按实际说话人换成她/它，其余逐字不动）。画外音（心里说/心声/内心独白/旁白）才写「嘴唇保持完全闭合」。有可见人物但没有台词的镜头，必须正面交代嘴在做什么。【retention 与正文同义】retention_analysis 逐张交代每张参考图（及其上的主体）在本片的保留判定；标 fully_preserved 的内容正文必须让它完全保留，正文要改动它就改判 partially_preserved。两者打架 = 自相矛盾，重写那句。「完全保留」只锁外观与身份，不锁画面里天然在动的东西。【物理规律·强制】所有运动符合真实物理：重力向下、物体自然下落、碰撞反弹、布料/头发/液体按物理运动；禁止反重力悬浮、物体凭空出现/消失、违反惯性瞬时变速。【色温】指定色温时严格遵循：暖光 3200K / 中性 4500K / 冷光 5600K。【物体状态锁定】物体被摧毁后只留碎片，不复活、不重置。【人物与场景锁定·旅游专用】人物形象、服装与场景外观严格锁定于参考图，不漂移、不变形、不简化、不被 AI 重新设计。人物与环境始终是画面主角——每一帧都能看到主体或通过光影/构图暗示其存在。【人物真人质感】静止也有呼吸起伏/重心微移/自然眨眼/发丝微动，表情由眼神与细微张力传递（克制真实不夸张），动作有加减速与重心转移；禁止蜡像感/娃娃感/塑料皮肤/死鱼眼/固定微笑/机器人匀速/瞬间起停/卡通夸张表情。【参考图引用标签】需要指定「某张参考图」时，用 <Picture N> 标签指代，N 按参考图上传顺序从 1 开始（如 <Picture 1>）。禁止用 @图N、[Image N] 等其它写法。【台词标记】用户提供的台词/对白必须逐字保留，用 <d>[Chinese] 台词原文</d> 包装，标签内文字一字不改（不改写/不润色/不翻译/不增删字词），仅角色名与情绪语调可在标签外补充。【禁止】禁止画面上的任何文字（招牌字/包装字/字幕/霓虹字/对话框/水印）；禁止分辨率/画幅/模型名。No text overlays, no watermarks, no subtitles, no captions.';

const DEFAULT_RULES_DIRECT: VideoGenRules = {
  version: '4',
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
    shot_continuity: '镜头顺序与动作推进由正文建立，参考图之间不存在「上一格→下一格」的延续关系。镜头运动均匀串联，每个镜头时长≥1.5秒，禁止一闪而过的碎镜头。同一主体跨镜外观/服装/光影一致。[Shot 1] 不带时间戳，第 2 镜起 At MM:SS.mmm 严格递增。',
    hard_constraints: [
      '视频提示词正文恒为六段式，段名逐字、次序固定、段名独占一行、尾随半角冒号、段间空行；主字段 detailed_description',
      '六段之外不再添加任何工程约束段（画面稳定/主体与场景锁定/反文字水印由规则头统一注入）',
      '六段内不写否定句；缺席只有 N/A 一个写法',
      '参考图是若干张相互独立的素材，不假设它们之间存在宫格或时间线顺序',
      '参考图里看得见的活物/道具/环境，其运动与状态变化必须逐项写出；参考图里没有的一件不加',
      'retention_analysis 的判定必须与 detailed_description 的正文同义，不许打架',
      '运镜只用官方三维闭集（12 类 motion type × 幅度 × 速度），表外镜头动作与镜头内光学操作一律不写',
      '切镜只用 the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to，且与镜头内容同一行',
      '[Shot 1] 不带时间戳；第 2 镜起 At MM:SS.mmm 严格递增、落在总时长内；标记与内容同一行',
      '每个镜头时长≥1.5秒，相邻镜头时间戳间隔≥1.5秒，禁止一闪而过的碎镜头',
      'overall_soundscape 与 non_diegetic_music 两段正面写「有什么」，没有的写 N/A',
      '画内说话在 </d> 之后逐字写「他说话时下颌开合、嘴唇随字句张动」；画外音才写「嘴唇保持完全闭合」；有可见人物无台词必须正面交代嘴在做什么',
      '色温严格按指定值',
      '物体状态锁定，已毁物体只留碎片',
      '所有运动必须符合真实物理规律（重力/惯性/碰撞/流体），禁止反重力悬浮和物体穿模',
      '人物形象/服装/场景外观严格锁死参考图，禁止AI自行重新设计、简化或改写',
      '指代参考图统一用 <Picture N>（N 自 1 起），禁止 @图N / [Image N] 写法',
      '台词用 <d>[Chinese] 原文</d> 包装，标签内一字不改，仅可在标签外补充角色名与情绪语调',
      '成片里不出现任何画面上的文字（招牌字/包装字/字幕/霓虹字/对话框/水印）',
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
const rulesCache = new Map<string, VideoGenRules>();
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
  if (hit) return hit;
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
        rulesCache.set(key, parsed);
        return parsed;
      }
      throw new Error('Invalid rules from server');
    } catch (e) {
      console.warn(`[videoGenRules] Server fetch failed (${key}), using fallback:`, e);
      const fallback = mode === 'direct' ? DEFAULT_RULES_DIRECT : DEFAULT_RULES;
      rulesCache.set(key, fallback);
      return fallback;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

export function getCachedRules(model?: string, mode: VideoGenRuleMode = 'grid'): VideoGenRules | null {
  return rulesCache.get(cacheKey(model, mode)) ?? null;
}

export function clearRulesCache(): void {
  rulesCache.clear();
  inflight.clear();
}
