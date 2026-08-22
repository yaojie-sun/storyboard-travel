import { invoke } from '@tauri-apps/api/core';

// ---- types ----

export interface GridPromptRules {
  version: string;
  grid_prompt: {
    persona?: string;
    global_header: string;
    cinematic_quality?: string;
    reference_image_priority: string;
    continuity_and_axis: string;
    closeup_axis_lock?: string;
    grid_layout: string;
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
    frame_quality_suffix?: string;
    hard_constraints: string[];
    disable_text_in_image_text?: string;
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
  version: '1-travel',
  grid_prompt: {
    persona:
      '你是一位专业的旅行/酒店/建筑摄影师，擅长电影级光影与空间叙事。',
    global_header:
      '按以下规则生成一张{aspect_ratio}真实照片级图像，包含恰好{rows}×{cols}={total}个等大画面，固定网格排列，白色细边间距。所有画面描绘同一目的地/场景，视觉风格一致。\n\n[规则A·空间递进] 画面按空间逻辑排列：从外到内、从全景到细节、从远景到特写。第1格建立空间锚点（全景/外观），后续画面层层递进。禁止画面间出现空间跳跃或逻辑断裂。\n\n[规则B·地标锚定] 每个画面必须包含可见的空间参照物（建筑轮廓/自然地貌/室内结构/招牌标识），作为空间连续性的锚点。特写画面需保留背景中可辨识的空间元素，禁止纯色/完全虚化背景。',
    cinematic_quality:
      '[规则C·光影时刻] 全部{total}个画面强制高质量光影体系。户外场景精确到黄金时刻/蓝调时刻/正午/夜景时段，光色温度与时段匹配。体积光可见（窗光/阳光空气散射/灯光雾），高光柔和不溢出。暖冷对比色调，胶片质感颗粒，暗部不发灰。室内场景须有三灯立体层次（主光+辅光+轮廓光）。禁止平光/无阴影的扁平打光。\n\n[规则D·质感] 浅景深虚化背景（f/2.8-f/5.6），焦外光斑自然。建筑纹理清晰可见（石材/木材/玻璃/金属），自然景观质感真实（水面波纹/树叶细节/天空云彩/山石纹理）。禁止塑料感/过度锐化/CG感/动漫/3D渲染风格。',
    reference_image_priority:
      '[规则E·参考图] 参考图是视觉元素的唯一来源（目的地/建筑/环境/色彩/风格/天气）。文字仅指定运镜方式/光影条件/氛围调整。禁止修改参考图中任何视觉内容。',
    continuity_and_axis:
      '[规则F·空间连续] 全部{total}个画面共享一个连续的地理空间。空间方向感从画面1继承——建筑朝向/地貌走向/室内布局保持一致，不出现矛盾的空间关系。光照方向（太阳位置/主光源方向）在全部{total}个画面中保持一致。',
    closeup_axis_lock:
      '[特写空间锚] 本格为特写/近景：1) 保留可见空间参照物作为空间锚点 2) 光影方向=画面1 3) 禁止纯色/完全虚化背景 4) 不确定时参考上一格远景布局中的空间关系。',
    grid_layout:
      '[规则G·网格] 严格{rows}×{cols}={total}个画面，等大格子，均匀间距。不可协商。',
    section_frames: '--- 画面描述 ---',
    frame_title_template: '画面{index}/{total} [第{row}行第{col}列]:',
    frame_default_shot: '中景',
    frame_default_emotion: '宁静',
    frame_default_facing: '',
    frame_field_source_auto: '(自动)',
    frame_field_source_user: '(用户)',
    frame_ref_image_instruction: '',
    frame_fields: ['shot', 'action', 'emotion', 'lighting', 'space'],
    frame_field_labels: {
      shot: '景别',
      action: '运镜',
      emotion: '氛围',
      lighting: '光影',
      space: '空间',
    },
    hard_constraints: [
      '[空间递进] 从外到内、从全景到细节，空间逻辑不可断裂。',
      '[地标锚定] 特写/近景须保留空间参照物，禁止纯背景。',
      '[光影一致] 光源方向与时段特征在全部{total}个画面中保持一致。',
      '[格式] 比例{aspect_ratio}，{total}画面{rows}×{cols}网格，禁止合并重排。',
      '[地标保全] 建筑轮廓/自然地貌/地标特征100%一致。参考图覆盖文字视觉描述。空间关系从前格继承。',
    ],
    frame_quality_suffix:
      '高仿真度，电影级光影，胶片质感，浅景深虚化，体积光可见，建筑纹理真实，水面波纹自然，天空云彩层次分明。保留参考图中原有文字/Logo/标识/牌匾，仅禁止AI凭空新增水印/字幕/随机字母。',
    disable_text_in_image_text:
      '禁止在图片中新增任何描述文本、字幕、水印、编号或随机字母。仅保留参考图中原有的文字/Logo/标识/牌匾。'
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

// ---- lighting detection (per-frame 光影) ----

const LIGHTING_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /黄金时刻|golden[-\s]?hour/i, label: '黄金时刻' },
  { re: /蓝调时刻|blue[-\s]?hour/i, label: '蓝调时刻' },
  { re: /黄昏|傍晚|夕阳|日落/i, label: '黄昏' },
  { re: /夜景|夜晚|夜间|深夜|灯会|夜市|霓虹/i, label: '夜景' },
  { re: /正午|晌午|烈日/i, label: '正午' },
  { re: /清晨|日出|晨光|朝阳/i, label: '清晨' },
  { re: /白天|日间/i, label: '白天' },
  { re: /暖光|暖黄|暖色光/i, label: '暖光' },
  { re: /冷光|冷色|冷调/i, label: '冷光' },
  { re: /月光|星光|星空/i, label: '月光' },
  { re: /阴天|多云|雾天|雨天|雪天/i, label: '阴天/雾' },
];

export function detectLighting(description: string): string | null {
  for (const { re, label } of LIGHTING_PATTERNS) {
    if (re.test(description)) return label;
  }
  return null;
}

// ---- space detection (per-frame 空间锚点) ----

const SPACE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /外观|外立面|门头|楼体|建筑/i, label: '外观/建筑' },
  { re: /大门|入口|门厅|玄关/i, label: '大门/入口' },
  { re: /大堂|大厅|前台|接待|服务台/i, label: '大堂/前台' },
  { re: /走廊|通道|过道|楼梯|电梯/i, label: '走廊/通道' },
  { re: /客房|房间|卧室/i, label: '客房' },
  { re: /餐厅|餐台|吧台|厨房/i, label: '餐厅' },
  { re: /健身房|泳池|spa|桑拿|棋牌/i, label: '健身房/泳池' },
  { re: /室内|屋内/i, label: '室内' },
  { re: /室外|户外|露天|街边/i, label: '室外' },
  { re: /海边|沙滩|海岸|海滨/i, label: '海边' },
  { re: /山|湖|河|森林|草原|沙漠|雪山|峡谷/i, label: '自然地貌' },
  { re: /古镇|街道|广场|街景|商圈|集市|步行街/i, label: '街景/古镇' },
];

export function detectSpace(description: string): string | null {
  for (const { re, label } of SPACE_PATTERNS) {
    if (re.test(description)) return label;
  }
  return null;
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
  const userLighting = detectLighting(frame.description);
  const userSpace = detectSpace(frame.description);

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
      case 'lighting':
        entries.push({
          key: 'lighting',
          value: userLighting ?? '光影与画面1一致',
          source: userLighting
            ? gp.frame_field_source_user
            : gp.frame_field_source_auto,
        });
        break;
      case 'space':
        entries.push({
          key: 'space',
          value: userSpace ?? '空间关系继承前格',
          source: userSpace
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

  const altRows = context.cols;
  const altCols = context.rows;

  // 0. Persona (professional role — orients the model toward pro photography)
  if (gp.persona) {
    parts.push(gp.persona);
    parts.push('');
  }

  // 1. Global header: grid + 空间递进/地标锚定 (fallback to minimal header)
  parts.push(fillPlaceholders(
    gp.global_header ||
      '生成一张{aspect_ratio}真实照片级图像。画面包含恰好{total}个等大的{cell_aspect_ratio}画面，按{cols}列×{rows}行排列，白色细边间距。所有画面同一场景、同一角色。',
    context
  ));
  parts.push('');

  // 2. 布局铁律 (anti-transpose lock — always present, critical)
  parts.push(fillPlaceholders(
    '【布局铁律】严格按{cols}列×{rows}行排列。上面一横排{cols}格从左到右，下面一横排{cols}格从左到右。绝对禁止改为' +
      `${altRows}行×${altCols}列` +
      '排列（该排列会使画面裁切变形，直接视为废图）。',
    context
  ));
  parts.push('');

  // 3. Grid layout (规则G — positive grid statement)
  if (gp.grid_layout) {
    parts.push(fillPlaceholders(gp.grid_layout, context));
    parts.push('');
  }

  // 4. Reference image priority (only when ref images present)
  if (context.hasAnyRefImage) {
    parts.push(fillPlaceholders(gp.reference_image_priority, context));
    parts.push('');
  }

  // 5. Cinematic quality (光影时刻 + 质感)
  if (gp.cinematic_quality) {
    parts.push(fillPlaceholders(gp.cinematic_quality, context));
    parts.push('');
  }

  // 6. Spatial continuity (空间连续)
  if (gp.continuity_and_axis) {
    parts.push(fillPlaceholders(gp.continuity_and_axis, context));
    parts.push('');
  }

  // 7. Close-up spatial anchor (特写空间锚)
  if (gp.closeup_axis_lock) {
    parts.push(fillPlaceholders(gp.closeup_axis_lock, context));
    parts.push('');
  }

  // 8. No-text constraint
  if (context.disableTextInImage && gp.disable_text_in_image_text) {
    parts.push(gp.disable_text_in_image_text);
    parts.push('');
  }

  // 9. Frame descriptions
  if (gp.section_frames) {
    parts.push(gp.section_frames);
    parts.push('');
  }
  context.frames.forEach((frame) => {
    const title = fillFramePlaceholders(gp.frame_title_template, context, frame);
    parts.push(title);

    const fields = buildFrameFields(frame, rules);
    for (const field of fields) {
      parts.push(buildFrameLine(field.key, field.value, field.source, rules));
    }
    parts.push('');
  });

  // 10. Hard constraints (recency — reinforces space/landmark/lighting lock)
  if (gp.hard_constraints && gp.hard_constraints.length > 0) {
    parts.push(gp.hard_constraints.map((c) => fillPlaceholders(c, context)).join('\n'));
    parts.push('');
  }

  // 11. Layout lock (repeated at end for recency — highest priority)
  parts.push(fillPlaceholders(
    '【最终布局确认 — 比上面所有描述优先级更高】' +
      `画面必须是{cols}列×{rows}行 = {cols}个竖列。${altRows}行×${altCols}列排列 = 废图。` +
      '如果你排列错了，请删除图片并重新按{cols}列×{rows}行生成。',
    context
  ));
  parts.push('');

  // 12. Global quality line (once for the whole grid, not per frame)
  if (gp.frame_quality_suffix) {
    parts.push(gp.frame_quality_suffix);
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
