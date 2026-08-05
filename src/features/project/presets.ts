/**
 * Industry-standard presets for project creation/editing.
 * Shared across ProjectSetupDialog, EditParamsDialog, and ReanalyzeDialog.
 * Travel industry edition.
 */
export const STYLE_PRESETS = [
  '写实', '电影感', '极简高级', '温暖胶片', '清新明亮',
  '暗调奢华', '自然光', '黄金时刻', '蓝调时刻', 'INS风',
  '度假风情', '日系治愈', '纪实人文', '航拍大景', '微距细节',
];

export const TONE_PRESETS = [
  '温暖', '静谧', '活力', '浪漫', '文艺',
  '大气', '治愈', '清新', '怀旧', '悠闲',
  '神秘', '震撼', '优雅', '野奢', '禅意',
];

export const SHORTVIDEO_STYLE_PRESETS = [
  '酒店高端展示',
  '民宿探店体验',
  '自然风光航拍',
  '城市打卡Vlog',
  '美食探店打卡',
  '文化古迹探秘',
  '度假天堂慢生活',
  '户外冒险极限',
  '海滨日落浪漫',
  '古镇漫步怀旧',
];

export const ASPECT_RATIO_OPTIONS = [
  { value: '', label: '未选择' },
  { value: '16:9', label: '16:9' },
  { value: '2.35:1', label: '2.35:1' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
];

export const TRAVEL_VIDEO_TYPES = [
  { value: 'hotel', label: '酒店宣传片', desc: '高端酒店/度假村的全景展示、客房体验、配套设施' },
  { value: 'explore', label: '探店视频', desc: '民宿/餐厅/咖啡馆/买手店的沉浸式探店体验' },
  { value: 'scenic', label: '景区风光', desc: '自然风景区/国家公园/山水景观的航拍与地面拍摄' },
  { value: 'checkin', label: '打卡Vlog', desc: '城市地标/网红景点/主题活动的人物打卡互动' },
  { value: 'food', label: '美食探店', desc: '地方美食/特色小吃/高端餐饮的食材到成品展示' },
  { value: 'culture', label: '文化古迹', desc: '历史遗迹/博物馆/古镇/非遗文化的深度探访' },
];

export const EMPHASIS_DIMENSIONS = [
  { key: 'drone_aerial', label: '航拍运镜', desc: '无人机航拍高度/速度/环绕/穿梭路线设计' },
  { key: 'walkthrough', label: '探店动线', desc: '第一人称步行路线：门头→大厅→细节→高潮的空间递进' },
  { key: 'lighting', label: '光影时刻', desc: '黄金时刻/蓝调时刻/夜景灯光/室内氛围光的精准运用' },
  { key: 'space_flow', label: '空间流线', desc: '从外到内/从全景到细节/从公共区域到私密空间' },
  { key: 'food_detail', label: '美食特写', desc: '食材纹理/烹饪过程/摆盘美学的微距呈现' },
  { key: 'landmark_framing', label: '地标构图', desc: '地标与人物/环境的构图关系、最佳拍摄角度与时段' },
  { key: 'seasonal', label: '季节时令', desc: '季节特征（花季/雪景/秋叶）、时段氛围与天气配合' },
  { key: 'local_culture', label: '在地文化', desc: '本地特色元素/民俗/建筑风格/方言标识的呈现' },
  { key: 'crowd_atmosphere', label: '人气氛围', desc: '人流/排队/互动场景的热闹感或静谧感的节奏控制' },
  { key: 'transition_flow', label: '场景过渡', desc: '室内→室外/白天→夜晚/高空→地面的自然过渡方式' },
] as const;

const EMPHASIS_MAP: Map<string, { label: string; desc: string }> = new Map(
  EMPHASIS_DIMENSIONS.map((d) => [d.key as string, { label: d.label, desc: d.desc }]),
);

const VIDEO_TYPE_MAP: Map<string, string> = new Map(
  TRAVEL_VIDEO_TYPES.map((t) => [t.value, t.label]),
);

export function getVideoTypeLabel(key: string): string {
  return VIDEO_TYPE_MAP.get(key) ?? key;
}

export function getEmphasisLabels(keys: string[]): string[] {
  return keys
    .map((k) => {
      const dim = EMPHASIS_MAP.get(k);
      return dim ? `${dim.label}（${dim.desc}）` : k;
    });
}
