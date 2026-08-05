/**
 * 服饰版行业预设 — 面向服装展示的AI短视频创作
 */
export const STYLE_PRESETS = [
  '写实', '高级时装', '极简高级', '温暖日常', '清新明亮',
  '暗调奢华', '自然光', '柔光棚拍', 'INS风', '日系清新',
  '街头潮流', '复古胶片', '韩系温柔', '欧美大气', '微距细节',
];

export const TONE_PRESETS = [
  '优雅', '活力', '温柔', '前卫', '文艺',
  '简约', '高级', '清新', '复古', '松弛',
  '酷感', '甜酷', '中性', '慵懒', '干练',
];

export const FASHION_STYLE_PRESETS = [
  '高级时装T台',
  '日常通勤穿搭',
  '街头潮流穿搭',
  '法式优雅穿搭',
  '韩系温柔穿搭',
  '日系清新穿搭',
  '运动休闲穿搭',
  '甜酷少女穿搭',
  '极简设计师风',
  '复古名伶穿搭',
];

export const ASPECT_RATIO_OPTIONS = [
  { value: '', label: '未选择' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '2.35:1', label: '2.35:1' },
  { value: '3:4', label: '3:4' },
];

export const FASHION_VIDEO_TYPES = [
  { value: 'catwalk', label: 'T台走秀', desc: '专业T台风格，全身/侧面/背面展示，动态走步+定点' },
  { value: 'outfit', label: '穿搭展示', desc: '整套搭配呈现，上下身+配饰的完整LOOK' },
  { value: 'detail', label: '细节特写', desc: '领口/袖口/纽扣/面料纹理/刺绣印花微距特写' },
  { value: 'mixmatch', label: '一衣多穿', desc: '同一单品搭配不同下装/配饰，展示多种穿法' },
  { value: 'lookbook', label: 'LOOKBOOK', desc: '多套服装的白底/杂志风画册展示' },
  { value: 'fabric', label: '面料动态', desc: '面料飘动/垂坠/透光/弹性动态展示' },
];

export const EMPHASIS_DIMENSIONS = [
  { key: 'silhouette', label: '服装廓形', desc: 'A型/H型/X型/O型廓形的镜头呈现与强调' },
  { key: 'fabric_drape', label: '面料垂坠', desc: '面料自然垂坠感/飘逸感/挺括感的动态呈现' },
  { key: 'color_match', label: '色彩搭配', desc: '上下身/内外搭/配饰的色彩呼应和对比关系' },
  { key: 'movement', label: '动态走位', desc: '模特走步/转身/坐立切换的节奏和路线设计' },
  { key: 'detail_focus', label: '细节呈现', desc: '领口设计/袖口工艺/纽扣材质/缝线密度微距' },
  { key: 'lighting_fabric', label: '面料光影', desc: '侧光/逆光/柔光对面料质感和层次的表现' },
  { key: 'layering', label: '叠穿层次', desc: '内外搭配的层次感和过渡节奏' },
  { key: 'accessory', label: '配饰点缀', desc: '包/鞋/首饰与服装的搭配关系和视觉比重' },
  { key: 'style_consistency', label: '风格统一', desc: '整套LOOK的视觉风格一致性和主题表达' },
  { key: 'occasion_fit', label: '场景适配', desc: '通勤/约会/运动/派对等场景的服装选择逻辑' },
] as const;

const EMPHASIS_MAP: Map<string, { label: string; desc: string }> = new Map(
  EMPHASIS_DIMENSIONS.map((d) => [d.key as string, { label: d.label, desc: d.desc }]),
);

export function getEmphasisLabels(keys: string[]): string[] {
  return keys
    .map((k) => {
      const dim = EMPHASIS_MAP.get(k);
      return dim ? `${dim.label}（${dim.desc}）` : k;
    });
}

const VIDEO_TYPE_MAP: Map<string, string> = new Map(
  FASHION_VIDEO_TYPES.map((t) => [t.value, t.label]),
);

export function getVideoTypeLabel(key: string): string {
  return VIDEO_TYPE_MAP.get(key) ?? key;
}
