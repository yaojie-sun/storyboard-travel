import type { ImageModelDefinition } from '../../types';
import { createFixedResolutionPricing } from '@/features/canvas/pricing';

export const BAIDU_GPT_IMAGE_2_MODEL_ID = 'baidu/gpt-image-2';

const BAIDU_GPT_IMAGE_2_ASPECT_RATIOS = [
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '2:3',
  '3:2',
  '21:9',
] as const;

export const imageModel: ImageModelDefinition = {
  id: BAIDU_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2',
  providerId: 'baidu',
  description: '百度 · GPT Image 2 图像生成（宫格优化）',
  eta: '45s',
  expectedDurationMs: 45000,
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',

  aspectRatios: BAIDU_GPT_IMAGE_2_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [
    { value: '2K', label: '2K' },
  ],
  pricing: createFixedResolutionPricing({
    currency: 'USD',
    standardRates: { '2K': 0.05 },
    discountedRates: { '2K': 0.05 },
  }),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: BAIDU_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
