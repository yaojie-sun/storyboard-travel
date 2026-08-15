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
  facing_lock?: string;
  axis_lock?: string;
  landmark_lock?: string;
  spatial_progression?: string;
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

// 旅游版兜底规则 — 仅网络故障时使用。完整规则见服务端 video_gen_rules_travel.json
const DEFAULT_PROMPT_RULE = '【铁律·旅游版】图1=视频首帧，视频从图1开始空间递进（外→内·全景→细节），经过图2-图5自然过渡，在图6结束。按左→右、上→下顺序逐格处理全部6张宫格图。每张宫格=一个关键帧。画面内容100%来自宫格参考图，文字仅提供运镜+动作+环境音。禁止添加参考图不存在的任何地标/建筑/物品/人物。地标外形/自然地貌/光影时段由参考图锁定。运镜优先无人机/POV步行/延时摄影。【平滑运镜·禁止硬切】同一目的地的六格是同一空间的连续递进（外→内·全景→细节），镜头之间禁止硬切/跳切/幻灯片式切换，必须用连续平滑运镜（无人机拉升→POV步行→慢推→微距→延时）一气呵成丝滑衔接，如同一镜到底的空间漫游短片；禁止逐格用固定机位定点硬切。旅游写实美学：禁止CG感/塑料感/3D渲染。自然材质纹理、大气透视、真实不完全完美。';

const DEFAULT_RULES: VideoGenRules = {
  version: '30',
  integration: {
    model: 'none',
    max_tokens: 0,
    system_prompt: '',
  },
  guidance_scale: 8.0,
  shot_type: 'multi',
  negative_prompt: 'chromatic aberration, motion blur excess, morphing, distortion, warping, flicker, unnatural physics, floating objects, anti-gravity, building shape drift, landmark distortion, bad weather, overcast sky, haze, construction site, trash on ground, crowded background clutter, ugly modern buildings, power lines, CG look, plastic texture, 3D render, video game graphics, oversaturated colors, HDR halo, invented objects, hallucinated props, AI watermark, AI subtitle, empty frame, static image, abrupt transition',
  prompt_rule: DEFAULT_PROMPT_RULE,
  constraints: {
    global_rule: 'STORYBOARD = GROUND TRUTH. Visual content 100% anchored by 6 storyboard frames. Text provides camera + movement + environmental audio only. All camera movement within frame boundaries. Travel photorealism required — no CG/plastic/3D render aesthetics.',
    object_persistence: 'Landmarks and spatial elements exist every frame. Building shapes, natural landforms, and spatial layout locked by storyboard. No morphing or count change.',
    landmark_lock: 'Landmark appearance anchored by storyboard. Camera movement does not alter building/landmark geometry or position.',
    spatial_progression: 'Spatial narrative: outside→inside, wide→detail. Each shot advances the spatial story. No random jumping between unrelated locations.',
    motion_catalog: 'fixed | slow push-in | slow pull-out | smooth pan L->R | smooth pan R->L | smooth tracking | slight handheld shake | orbit L | orbit R | drone pull-up | drone orbit | drone fly-through | POV walkthrough | macro close-up | time-lapse | crane up | crane down',
    shot_continuity: 'Storyboard L->R, T->B = spatial progression. Same-destination frames must connect via continuous smooth camera moves (drone pull-up / POV walkthrough / slow push-in / macro) for a seamless one-take feel. Hard cut ONLY when the destination / time fundamentally changes; never hard-cut between frames of the same destination.',
    hard_constraints: [
      'Storyboard = ground truth. Visual content from storyboard only.',
      'Each shot aligns with corresponding storyboard frame.',
      'Frame-to-frame transitions must be smooth.',
      'No hard cuts between same-destination frames — connect them with continuous smooth camera moves (one-take feel).',
      'All camera movement within storyboard frame boundaries.',
      'Landmarks/spatial elements exist every frame — no morphing.',
      'No image stretching. No landmark distortion.',
      'Process all 6 storyboard frames in spatial sequence.',
      'Golden hour / blue hour lighting consistency across all frames.',
      'No AI dialogue, voiceover, or narration.',
    ],
  },
};

let cachedRules: VideoGenRules | null = null;
let fetchPromise: Promise<VideoGenRules> | null = null;

export async function fetchVideoGenRules(model?: string): Promise<VideoGenRules> {
  if (cachedRules) return cachedRules;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const raw: string = await invoke('fetch_video_gen_rules', { model: model || null });
      const parsed = JSON.parse(raw) as VideoGenRules;
      if (parsed?.version && parsed.constraints) {
        cachedRules = parsed;
        return cachedRules;
      }
      throw new Error('Invalid rules from server');
    } catch (e) {
      console.warn('[videoGenRules] Server fetch failed, using fallback:', e);
      cachedRules = DEFAULT_RULES;
      return cachedRules;
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

export function getCachedRules(): VideoGenRules | null {
  return cachedRules;
}

export function clearRulesCache(): void {
  cachedRules = null;
  fetchPromise = null;
}
