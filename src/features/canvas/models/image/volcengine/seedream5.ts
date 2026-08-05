import type { ImageModelDefinition } from '../../types';
import { createFixedResolutionPricing } from '@/features/canvas/pricing';

export const VOLCENGINE_SEEDREAM_5_MODEL_ID = 'volcengine/doubao-seedream-5-0-260128';

const VOLCENGINE_ASPECT_RATIOS = [
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
  id: VOLCENGINE_SEEDREAM_5_MODEL_ID,
  mediaType: 'image',
  displayName: 'Seedream 5.0',
  providerId: 'volcengine',
  description: '火山引擎 · Seedream 5.0 图像生成（支持组图）',
  eta: '45s',
  expectedDurationMs: 60000,
  defaultAspectRatio: '9:16',
  defaultResolution: '2K',
  aspectRatios: VOLCENGINE_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [
    { value: '2K', label: '2K' },
  ],
  extraParamsSchema: [
    {
      key: 'sequential_image_generation',
      type: 'enum',
      label: '组图模式',
      defaultValue: 'auto',
      options: [
        { value: 'auto', label: '自动' },
        { value: 'enabled', label: '强制组图' },
        { value: 'disabled', label: '单图' },
      ],
    },
  ],
  pricing: createFixedResolutionPricing({
    currency: 'USD',
    standardRates: {
      '2K': 0.06,
    },
    discountedRates: {
      '2K': 0.04,
    },
  }),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: VOLCENGINE_SEEDREAM_5_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '图生图' : '文生图',
  }),
};
