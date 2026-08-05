import { invoke } from '@tauri-apps/api/core';

// ---- types ----

export interface GridPromptRules {
  version: string;
  grid_prompt: {
    global_header: string;
    reference_image_priority: string;
    continuity_and_axis: string;
    grid_layout: string;
    section_identity_lock: string;
    identity_lock: string;
    section_scene_lock: string;
    scene_lock: string;
    section_camera: string;
    camera_style: string;
    section_sequence: string;
    sequence_context: string;
    section_visual_carryover: string;
    visual_identity_carryover: string[];
    section_reference_priority: string;
    section_prop_spatial_lock: string;
    prop_spatial_lock: string;
    section_frames: string;
    frame_title_template: string;
    frame_fields: string[];
    frame_field_labels: Record<string, string>;
    frame_default_shot: string;
    frame_default_emotion: string;
    frame_default_facing: string;
    frame_field_source_auto: string;
    frame_field_source_user: string;
    frame_ref_image_instruction: string;
    section_layout: string;
    layout_strictness: string;
    section_hard_constraints: string;
    hard_constraints: string[];
    action_continuity_fallback: string;
    facing_inference_rule: string;
    style_consistent_text: string;
    disable_text_in_image_text: string;
  };
}

export interface FramePromptContext {
  index: number;
  row: number;
  col: number;
  description: string;
  hasRefImage: boolean;
}

export interface GridPromptContext {
  rows: number;
  cols: number;
  total: number;
  aspectRatio: string;
  cellAspectRatio?: string;
  frames: FramePromptContext[];
  hasAnyRefImage: boolean;
  disableTextInImage: boolean;
}


export interface PromptSanitizeResult {
  prompt: string;
  warnings: string[];
}

// ---- default rules (fallback when server unreachable) ----

const DEFAULT_RULES: GridPromptRules =
{
  version: '6',
  grid_prompt: {
    global_header:
      'CRITICAL: Unless user explicitly requests anime/manga/cartoon style, ALL content MUST be PHOTOREALISTIC — hyper-realistic humans, realistic skin/hair/fabrics, cinematic lighting. Generate ONE image at {aspect_ratio}, containing exactly {total} panels with thin white gutters. {spatial_layout} All panels equal size. All panels = SAME scene, SAME characters.',
    reference_image_priority:
      'REFERENCE IMAGE ABSOLUTE PRIORITY: All reference images are shared across ALL {total} panels. References are the SINGLE SOURCE OF TRUTH for ALL visual aspects — characters, clothing, props, colors, materials, architecture, environment, style. Text has ZERO authority over anything visible in references. Text ONLY describes actions, emotions, camera angles. Reference=LAW. Text=actions/feelings ONLY.',
    continuity_and_axis:
      'CHARACTER & PROP CONTINUITY + 180 DEG AXIS LOCK: All {total} panels share ONE continuous physical reality. Each panel inherits posture, stance, body axis, facing direction, AND all nearby prop/object positions from PREVIOUS panel UNCHANGED — unless user EXPLICITLY states a change. DEFAULT=CONTINUITY. BODY AXIS LOCK: Head direction, body orientation, limb placement must remain IDENTICAL across panels. PROP SPATIAL LOCK: All nearby objects/pets maintain fixed position relative to character. Cat in front of character in panel 1 = in front in ALL panels. 180 DEG CAMERA AXIS LOCK: Camera must NEVER cross the axis line. Consistent screen direction across ALL panels.',
    grid_layout:
      'LAYOUT: {spatial_layout} Each panel is {cell_aspect_ratio} aspect ratio. Compose each panel to fit {cell_aspect_ratio} — do NOT crop or cut off subjects. Do NOT rearrange, reflow, or change panel count. Panel numbers here are for spatial reference ONLY — do NOT draw any numbers or labels on the image. NON-NEGOTIABLE.',
    section_identity_lock: 'CHARACTER IDENTITY LOCK',
    identity_lock:
      'Characters in reference images are the SINGLE SOURCE OF TRUTH. Copy EXACTLY — do NOT guess, interpret, or embellish.',
    section_scene_lock: 'SCENE LOCK',
    scene_lock:
      'Environment, lighting, colors, materials in reference images are the ONLY valid scene. Reference shows black roof tiles → generate black roof tiles. Text about materials/colors = VOID.',
    section_camera: 'CAMERA STYLE',
    camera_style:
      'All {total} panels must use consistent cinematography: same lens, depth of field, color grading, lighting direction across every panel.',
    section_sequence: 'SEQUENCE & CHARACTER CONTINUITY',
    sequence_context:
      'These {total} panels form ONE continuous narrative. Each panel inherits posture, stance, body axis, facing, physical state, AND all nearby prop positions from PREVIOUS panel UNCHANGED — unless user EXPLICITLY states a change. DEFAULT=CONTINUITY.',
    section_visual_carryover: 'VISUAL IDENTITY CARRY-OVER',
    visual_identity_carryover: [
      'Panel 1 establishes canonical visual identity. Every subsequent panel must carry over EXACTLY: face, hair, clothing, accessories, props, body axis, spatial orientation.',
      'Before each panel, verify: character looks identical to panel 1. Any difference = CORRECT IT immediately.',
      'When in doubt, COPY previous panel. Continuity is ALWAYS safer than unrequested variation.',
    ],
    section_reference_priority: 'REFERENCE IMAGE ABSOLUTE PRIORITY',
    section_prop_spatial_lock: 'PROP & OBJECT SPATIAL LOCK',
    prop_spatial_lock:
      'All props, objects, and animals near a character have FIXED relative positions across ALL {total} panels. If cat sleeps on mat in front of character in panel 1, it stays there in all panels — no drift, no side-switching, no disappearing. Scene objects (furniture, rugs, lamps) remain at fixed locations. Before each panel, verify prop positions match panel 1.',
    section_frames: 'PANEL DESCRIPTIONS',
    frame_title_template: 'Panel {index} of {total}:',
    frame_default_shot: 'Medium shot',
    frame_default_emotion: 'neutral',
    frame_default_facing: 'front-facing',
    frame_field_source_auto: '(auto)',
    frame_field_source_user: '(user)',
    frame_ref_image_instruction: '',
    frame_fields: ['shot', 'action', 'emotion', 'facing'],
    frame_field_labels: {
      shot: 'Shot',
      action: 'Action',
      emotion: 'Emotion',
      facing: 'Facing',
    },
    section_layout: 'LAYOUT',
    layout_strictness:
      'Layout is EXACTLY as described: {spatial_layout} All panels equal size with uniform gutters. Do NOT reflow, rearrange, or change panel count. This layout is NON-NEGOTIABLE.',
    section_hard_constraints: 'HARD CONSTRAINTS',
    hard_constraints: [
      'Overall image aspect ratio MUST be exactly {aspect_ratio}. Each of the {total} panels MUST be {cell_aspect_ratio} — compose subjects to fit without cropping.',
      'Exactly {total} panels — {spatial_layout} No rearrangement, reflow, or merging.',
      'Character appearance 100% identical across all panels — face, hair, clothing, skin tone, eye color. ZERO deviation.',
      'ALL props, objects, and animals must maintain FIXED spatial positions relative to characters and scene across ALL {total} panels. No drift, teleporting, or side-switching. Handheld items stay in same hand with same grip.',
      'Reference images override ALL text for any visual element. Posture, body axis, and 180° camera axis carry over UNCHANGED from previous panel. Default=continuity.',
    ],
    action_continuity_fallback:
      'Every panel inherits posture, stance, body position, physical state, AND nearby prop positions from PREVIOUS panel UNCHANGED unless user EXPLICITLY states a change.',
    facing_inference_rule:
      'Determine facing from PREVIOUS panel direction as baseline via 180-degree rule.',
    style_consistent_text:
      'Maintain visual style, lighting, and color grading consistent with reference images across all panels.',
    disable_text_in_image_text:
      'Keep all existing text, logos, labels, and branding from the reference images exactly as they appear. Do NOT add new text overlays, subtitles, UI elements, or panel numbers to the generated image. Reference image text must be preserved faithfully.'
  },
};

// ---- fetch & cache ----

let cachedRules: GridPromptRules | null = null;
let fetchPromise: Promise<GridPromptRules> | null = null;

export async function fetchGridPromptRules(): Promise<GridPromptRules> {
  if (cachedRules) return cachedRules;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const raw: string = await invoke('fetch_grid_prompt_rules');
      const parsed = JSON.parse(raw) as GridPromptRules;
      if (parsed && parsed.grid_prompt && parsed.version) {
        cachedRules = parsed;
        return cachedRules;
      }
    } catch {
      // fall through to default
    }
    cachedRules = DEFAULT_RULES;
    return cachedRules;
  })();

  return fetchPromise;
}

// ---- shot scale detection ----

const SHOT_KEYWORDS: Array<{ re: RegExp; label: string }> = [
  { re: /extreme[-\s]?close[-\s]?up|ecu|extreme close/i, label: 'Extreme close-up' },
  { re: /close[-\s]?up|特写|近景/i, label: 'Close-up' },
  { re: /medium[-\s]?close[-\s]?up|mcu|中近景/i, label: 'Medium close-up' },
  { re: /medium[-\s]?shot|中景/i, label: 'Medium shot' },
  { re: /medium[-\s]?full|中全景/i, label: 'Medium full shot' },
  { re: /full[-\s]?shot|全景|远景/i, label: 'Full shot' },
  { re: /wide[-\s]?shot|广角/i, label: 'Wide shot' },
  { re: /extreme[-\s]?wide|极广/i, label: 'Extreme wide shot' },
  { re: /establishing[-\s]?shot|定场/i, label: 'Establishing shot' },
  { re: /over[-\s]?the[-\s]?shoulder|ots|过肩/i, label: 'Over-the-shoulder' },
  { re: /pov[-\s]?shot|pov|主观视角/i, label: 'POV shot' },
  { re: /low[-\s]?angle|仰拍|仰角/i, label: 'Low angle' },
  { re: /high[-\s]?angle|俯拍|俯角/i, label: 'High angle' },
  { re: /dutch[-\s]?angle|canted|倾斜/i, label: 'Dutch angle' },
];

export function detectShotScale(description: string): string | null {
  for (const { re, label } of SHOT_KEYWORDS) {
    if (re.test(description)) return label;
  }
  return null;
}

// ---- facing direction detection ----

const FACING_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /front[-\s]?facing|facing (the )?camera|正面|面对镜头|朝向镜头/i, label: 'front-facing' },
  { re: /back[-\s]?facing|背面|背对镜头|背对|背向/i, label: 'back-facing' },
  { re: /facing left|looking left|面向左|朝左|向左看|左侧面/i, label: 'facing left' },
  { re: /facing right|looking right|面向右|朝右|向右看|右侧面/i, label: 'facing right' },
  { re: /three[-\s]?quarter|3\/4|四分之三/i, label: 'three-quarter view' },
  { re: /profile|侧脸|侧面|侧身/i, label: 'profile view' },
  { re: /turning|转身|回头|转过头/i, label: 'turning' },
  { re: /looking up|向上看|仰头/i, label: 'looking up' },
  { re: /looking down|向下看|低头/i, label: 'looking down' },
  { re: /over[-\s]?shoulder|over shoulder|过肩|回头|回望/i, label: 'over-shoulder' },
];

export function detectUserSpecifiedFacing(description: string): string | null {
  for (const { re, label } of FACING_PATTERNS) {
    if (re.test(description)) return label;
  }
  return null;
}

// ---- emotion detection ----

const EMOTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /happy|joyful|cheerful|开心|高兴|愉快|喜悦|欢笑/i, label: 'happy' },
  { re: /sad|sorrow|grief|悲伤|难过|伤心|哀伤|哭泣/i, label: 'sad' },
  { re: /angry|furious|rage|愤怒|生气|发怒|暴怒/i, label: 'angry' },
  { re: /fear|scared|terrified|害怕|恐惧|惊恐|畏惧/i, label: 'fearful' },
  { re: /surprised|shocked|astonished|惊讶|吃惊|震惊|诧异/i, label: 'surprised' },
  { re: /disgust|厌恶|反感|讨厌/i, label: 'disgusted' },
  { re: /neutral|calm|冷静|中性|平静|平和|淡定/i, label: 'neutral' },
  { re: /anxious|nervous|worried|焦虑|紧张|不安|担忧/i, label: 'anxious' },
  { re: /confident|自信|坚定|从容/i, label: 'confident' },
  { re: /playful|mischievous|调皮|顽皮|俏皮/i, label: 'playful' },
  { re: /serious|solemn|严肃|庄重|认真/i, label: 'serious' },
  { re: /thoughtful|pensive|沉思|思考|若有所思/i, label: 'thoughtful' },
  { re: /excited|enthusiastic|兴奋|激动|热情/i, label: 'excited' },
  { re: /tender|gentle|温柔|温存|柔情/i, label: 'tender' },
  { re: /pain|agony|痛苦|剧痛|疼痛/i, label: 'in pain' },
  { re: /determined|resolute|决心|果断|坚毅/i, label: 'determined' },
];

export function detectEmotion(description: string): string | null {
  for (const { re, label } of EMOTION_PATTERNS) {
    if (re.test(description)) return label;
  }
  return null;
}

// ---- action continuity detection ----

const CONTINUITY_KEYWORDS: RegExp[] = [
  /然后/,
  /接着/,
  /之后/,
  /随后/,
  /转身/,
  /走向/,
  /跑向/,
  /回到/,
  /继续/,
  /开始/,
  /最终/,
  /最后/,
  /先后/,
  /接下来/,
  /then\b/i,
  /next\b/i,
  /after\b/i,
  /afterward/i,
  /continue/i,
  /finally/i,
  /transition/i,
  /sequence/i,
];

export function detectUserSpecifiedContinuity(
  frames: FramePromptContext[]
): boolean {
  return frames.some((frame) =>
    CONTINUITY_KEYWORDS.some((re) => re.test(frame.description))
  );
}

// ---- prompt builder ----

function buildSpatialLayoutDescription(rows: number, cols: number, total: number): string {
  if (rows <= 0 || cols <= 0) return '';
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const start = r * cols + 1;
    const end = Math.min(start + cols - 1, total);
    const panelNums = start === end ? `Panel ${start}` : `Panels ${start}-${end}`;
    let position: string;
    if (rows === 1) {
      position = 'in a single row';
    } else if (r === 0) {
      position = 'in the top row';
    } else if (r === rows - 1) {
      position = 'in the bottom row';
    } else if (rows === 3 && r === 1) {
      position = 'in the middle row';
    } else {
      const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
      position = `in the ${ordinals[r] || `${r + 1}th`} row`;
    }
    lines.push(`${panelNums} ${position}, evenly spaced left to right`);
  }
  return lines.join('. ') + '.';
}

function fillPlaceholders(template: string, context: GridPromptContext): string {
  if (!template) return '';
  return template
    .replace(/\{rows\}/g, String(context.rows))
    .replace(/\{cols\}/g, String(context.cols))
    .replace(/\{total\}/g, String(context.total))
    .replace(/\{aspect_ratio\}/g, context.aspectRatio)
    .replace(/\{cell_aspect_ratio\}/g, context.cellAspectRatio ?? context.aspectRatio)
    .replace(/\{spatial_layout\}/g, buildSpatialLayoutDescription(context.rows, context.cols, context.total));
}

function fillFramePlaceholders(
  template: string,
  context: GridPromptContext,
  frame: FramePromptContext
): string {
  return template
    .replace(/\{index\}/g, String(frame.index))
    .replace(/\{row\}/g, String(frame.row))
    .replace(/\{col\}/g, String(frame.col))
    .replace(/\{total\}/g, String(context.total));
}

function buildFrameLine(
  key: string,
  value: string,
  source: string,
  rules: GridPromptRules
): string {
  const gp = rules.grid_prompt;
  const label = gp.frame_field_labels[key] ?? key;
  return `  - ${label}: ${value} ${source}`;
}

interface FrameFieldEntry {
  key: string;
  value: string;
  source: string;
}

function buildFrameFields(
  frame: FramePromptContext,
  rules: GridPromptRules
): FrameFieldEntry[] {
  const gp = rules.grid_prompt;
  const fields = gp.frame_fields;
  const entries: FrameFieldEntry[] = [];

  // Detect user-specified attributes from description
  const userShot = detectShotScale(frame.description);
  const userEmotion = detectEmotion(frame.description);
  const userFacing = detectUserSpecifiedFacing(frame.description);

  for (const field of fields) {
    switch (field) {
      case 'shot':
        entries.push({
          key: 'shot',
          value: userShot ?? gp.frame_default_shot,
          source: userShot
            ? gp.frame_field_source_user
            : gp.frame_field_source_auto,
        });
        break;
      case 'action': {
        // Strip camera motion + sound from description — grid images are static
        let actionText = stripMotionAndSound(frame.description);
        if (frame.hasRefImage && gp.frame_ref_image_instruction) {
          actionText = actionText
            ? `${gp.frame_ref_image_instruction}, ${actionText}`
            : gp.frame_ref_image_instruction;
        }
        entries.push({
          key: 'action',
          value: actionText || '(infer from context)',
          source: frame.description
            ? gp.frame_field_source_user
            : gp.frame_field_source_auto,
        });
        break;
      }
function stripMotionAndSound(description: string): string {
  if (!description) return description;
  let result = description;

  // Remove camera movement (Chinese) — keep only static visual info
  result = result.replace(/固定机位[，。；\s]*/g, '');
  result = result.replace(/缓慢推近[至\w]*[，。；\s]*/g, '');
  result = result.replace(/缓慢拉远[至\w]*[，。；\s]*/g, '');
  result = result.replace(/平稳摇镜\([^)]*\)[，。；\s]*/g, '');
  result = result.replace(/平稳跟拍[^，。；]*[，。；\s]*/g, '');
  result = result.replace(/手持晃动[^，。；]*[，。；\s]*/g, '');
  result = result.replace(/轻微手持[^，。；]*[，。；\s]*/g, '');
  result = result.replace(/慢动作捕捉[^，。；]*[，。；\s]*/g, '');
  result = result.replace(/快速摇镜[^，。；]*[，。；\s]*/g, '');
  result = result.replace(/FPV[^，。；]*[，。；\s]*/g, '');
  result = result.replace(/镜头[围绕环绕旋转推近拉远摇移升降跟拍俯仰晃动][^，。；]*[，。；\s]*/g, '');
  result = result.replace(/硬切转场[，。；\s]*/g, '');
  result = result.replace(/平稳摇镜[，。；\s]*/g, '');
  result = result.replace(/动态镜头角度[，。；\s]*/g, '');
  result = result.replace(/下移[，。；\s]*/g, '');

  // Remove sound descriptions
  result = result.replace(/[^，。；。]*声[^，。；。]*[，。；\s]*/g, (match) => {
    // Don't remove if it's visual, only remove auditory descriptions
    if (/风声|水声|脚步声|钢琴|音乐|BGM|鸣叫|低鸣|轻响|啄食声|拨水声|车流声|钢琴|配乐|背景乐|轻拍声|飞溅声|笑声|说话|说道|语气|语速/.test(match)) {
      return '';
    }
    return match;
  });
  result = result.replace(/[^。；。]*舒缓[^。；。]*[，。；\s]*/g, '');

  // Remove lingering English camera terms
  result = result.replace(/\b(dolly|pan|tilt|tracking|handheld|whip\s*pan|crane|orbit|zoom|FPV|drone)\b[^,.;]*[,.;\s]*/gi, '');

  // Clean up
  result = result.replace(/[，。；\s]{2,}/g, '，');
  result = result.replace(/^[，。；\s]+/, '');
  result = result.replace(/[，。；\s]+$/, '');
  result = result.replace(/[，。；]+/g, '，');
  result = result.trim();

  return result;
}
      case 'emotion':
        entries.push({
          key: 'emotion',
          value: userEmotion ?? gp.frame_default_emotion,
          source: userEmotion
            ? gp.frame_field_source_user
            : gp.frame_field_source_auto,
        });
        break;
      case 'facing':
        entries.push({
          key: 'facing',
          value: userFacing ?? gp.frame_default_facing,
          source: userFacing
            ? gp.frame_field_source_user
            : gp.frame_field_source_auto,
        });
        break;
      default:
        break;
    }
  }

  return entries;
}

export function buildGridPrompt(
  rules: GridPromptRules,
  context: GridPromptContext,
  _opts?: { compact?: boolean }
): string {
  const gp = rules.grid_prompt;
  const parts: string[] = [];

  // 0. Minimal header: grid + aspect ratio + anti-layout lock
  const altRows = context.cols;
  const altCols = context.rows;
  parts.push(fillPlaceholders(
    '生成一张{aspect_ratio}真实照片级图像。画面包含恰好{total}个等大的{cell_aspect_ratio}竖幅画面，按{cols}列×{rows}行排列，白色细边间距。所有画面同一场景、同一角色。' +
    `【布局铁律】严格按{cols}列×{rows}行排列。上面一横排{cols}格从左到右，下面一横排{cols}格从左到右。绝对禁止改为${altRows}行×${altCols}列排列（该排列会使画面裁切变形，直接视为废图）。`,
    context
  ));
  parts.push('');

  // 1. Reference image priority (only when ref images present)
  if (context.hasAnyRefImage) {
    parts.push(fillPlaceholders(gp.reference_image_priority, context));
    parts.push('');
  }

  // 2. No-text constraint
  if (context.disableTextInImage) {
    parts.push(gp.disable_text_in_image_text);
    parts.push('');
  }

  // 3. Frame descriptions (no per-frame quality suffix — added globally below)
  context.frames.forEach((frame) => {
    const title = fillFramePlaceholders(gp.frame_title_template, context, frame);
    parts.push(title);

    const fields = buildFrameFields(frame, rules);
    for (const field of fields) {
      parts.push(buildFrameLine(field.key, field.value, field.source, rules));
    }
    parts.push('');
  });

  // 4. Layout lock (repeated at end for recency — highest priority)
  parts.push(fillPlaceholders(
    '【最终布局确认 — 比上面所有描述优先级更高】' +
    `画面必须是{cols}列×{rows}行 = {cols}个竖列。${altRows}行×${altCols}列排列 = 废图。` +
    '如果你排列错了，请删除图片并重新按{cols}列×{rows}行生成。',
    context
  ));
  parts.push('');

  // 5. Global quality line (once for the whole grid, not per frame)
  if ((gp as any).frame_quality_suffix) {
    parts.push((gp as any).frame_quality_suffix);
  }

  return parts.join('\n');
}

export function sanitizeGridPrompt(
  prompt: string,
  context?: GridPromptContext,
): PromptSanitizeResult {
  const warnings: string[] = [];
  let result = prompt;

  // 1. Detect & remove unresolved {placeholder} patterns
  const unresolvedRe = /\{[a-z_]+\}/gi;
  const unresolved: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = unresolvedRe.exec(result)) !== null) {
    unresolved.push(m[0]);
  }
  if (unresolved.length > 0) {
    warnings.push(`unresolved placeholder(s): ${unresolved.join(', ')}`);
    result = result.replace(unresolvedRe, '');
  }

  // 2. Remove bare @ symbols (noise from @图N stripping)
  result = result.replace(/(?<![a-zA-Z0-9])@(?![a-zA-Z0-9])/g, '');
  result = result.replace(/@[ \t]+/g, ' ');

  // 3. Normalize whitespace
  result = result.replace(/[ \t]+/g, ' ');
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.split('\n').map((l) => l.trimEnd()).join('\n');
  result = result.trim();

  // 4. Aspect ratio sanity check
  if (!/aspect ratio.*?\d+:\d+/i.test(result)) {
    warnings.push('prompt missing aspect ratio specification');
  }

  // 5. Grid consistency checks (when context is provided)
  if (context) {
    const expectedTotal = context.rows * context.cols;

    // 5a. Check for references to panels beyond the grid total
    const panelRefRe = /panel\s+(\d+)/gi;
    let pm: RegExpExecArray | null;
    while ((pm = panelRefRe.exec(result)) !== null) {
      const n = parseInt(pm[1], 10);
      if (n > expectedTotal) {
        warnings.push(
          `prompt references panel ${n} but grid only has ${expectedTotal} panels`,
        );
      }
    }

    // 5b. Check for mismatched panel count mentions
    const totalMentionRe = /(\d+)\s*panels/gi;
    let tm: RegExpExecArray | null;
    while ((tm = totalMentionRe.exec(result)) !== null) {
      const n = parseInt(tm[1], 10);
      if (n !== expectedTotal) {
        warnings.push(
          `grid total mismatch: prompt says ${n} panels, context expects ${expectedTotal}`,
        );
      }
    }
  }

  // 6. Check for mid-prompt Chinese-English line splicing
  if (/\p{Script=Han},\s*[a-z]/iu.test(result)) {
    warnings.push('Chinese-English spliced on same line may confuse the model');
  }

  return { prompt: result, warnings };
}
