import type { ImageModelDefinition } from '../../types';

export const HAPPYHORSE_11_R2V_MODEL_ID = 'happyhorse/happyhorse-1.1-r2v';

const HAPPYHORSE_11_ASPECT_RATIOS = [
  '16:9',
  '9:16',
  '1:1',
  '4:3',
  '3:4',
] as const;

export const imageModel: ImageModelDefinition = {
  id: HAPPYHORSE_11_R2V_MODEL_ID,
  mediaType: 'video',
  displayName: '欢乐马 1.1 参考生视频',
  providerId: 'happyhorse',
  description: '阿里 · 欢乐马 1.1 参考生视频（3-15秒，最多9张参考图）',
  eta: '3min',
  expectedDurationMs: 180000,
  defaultAspectRatio: '16:9',
  defaultResolution: '720P',
  aspectRatios: HAPPYHORSE_11_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [
    { value: '720P', label: '720P' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: HAPPYHORSE_11_R2V_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '参考生视频' : '文生视频',
  }),
};
