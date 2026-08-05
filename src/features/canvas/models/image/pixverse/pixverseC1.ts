import type { ImageModelDefinition } from '../../types';

export const PIXVERSE_C1_MODEL_ID = 'pixverse/c1';

export const imageModel: ImageModelDefinition = {
  id: PIXVERSE_C1_MODEL_ID,
  mediaType: 'video',
  displayName: 'PixVerse C1',
  providerId: 'pixverse',
  description: '拍我AI · PixVerse C1 视频生成（支持多宫格分镜）',
  eta: '45s',
  expectedDurationMs: 120000,
  defaultAspectRatio: '9:16',
  defaultResolution: '720P',
  aspectRatios: [
    '16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2', '21:9',
  ].map((value) => ({ value, label: value })),
  resolutions: [
    { value: '360P', label: '360P' },
    { value: '540P', label: '540P' },
    { value: '720P', label: '720P' },
    { value: '1080P', label: '1080P' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: PIXVERSE_C1_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '图生视频' : '文生视频',
  }),
};
