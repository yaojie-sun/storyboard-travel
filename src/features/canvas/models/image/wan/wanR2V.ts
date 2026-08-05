import type { ImageModelDefinition } from '../../types';

export const WAN_R2V_MODEL_ID = 'wan/wan2.7-r2v';

const WAN_R2V_ASPECT_RATIOS = [
  '16:9',
  '9:16',
  '1:1',
] as const;

export const imageModel: ImageModelDefinition = {
  id: WAN_R2V_MODEL_ID,
  mediaType: 'image',
  displayName: '万相2.7 参考生视频',
  providerId: 'wan',
  description: '阿里 · 万相2.7 故事板生视频（3-15秒）',
  eta: '3min',
  expectedDurationMs: 180000,
  defaultAspectRatio: '16:9',
  defaultResolution: '720P',
  aspectRatios: WAN_R2V_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [
    { value: '720P', label: '720P' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: WAN_R2V_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '故事板生视频' : '文生视频',
  }),
};
