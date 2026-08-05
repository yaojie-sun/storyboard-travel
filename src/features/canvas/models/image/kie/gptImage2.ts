import type { ImageModelDefinition } from '../../types';
import { createFixedResolutionPricing } from '@/features/canvas/pricing';

export const KIE_GPT_IMAGE_2_MODEL_ID = 'kie/gpt-image-2-image-to-image';

const KIE_GPT_IMAGE_2_ASPECT_RATIOS = [
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
  id: KIE_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2',
  providerId: 'kie',
  description: '小鸭 · GPT Image 2 图像生成（宫格优化）',
  eta: '45s',
  expectedDurationMs: 45000,
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  aspectRatios: KIE_GPT_IMAGE_2_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' },
  ],
  pricing: createFixedResolutionPricing({
    currency: 'USD',
    standardRates: {
      '1K': 0.05,
      '2K': 0.08,
      '4K': 0.12,
    },
    discountedRates: {
      '1K': 0.03,
      '2K': 0.05,
      '4K': 0.08,
    },
  }),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: KIE_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
