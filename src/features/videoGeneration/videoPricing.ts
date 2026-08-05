export type VideoDuration = 4 | 6 | 8 | 10 | 12 | 15;
export type VideoResolution = '720P' | '1080P';

export const VIDEO_DURATION_OPTIONS: VideoDuration[] = [4, 6, 8, 10, 12, 15];
export const VIDEO_RESOLUTION_OPTIONS: VideoResolution[] = ['720P', '1080P'];

export const VIDEO_PRICING: Record<VideoDuration, { '720P': number; '1080P': number }> = {
  4:  { '720P': 35,  '1080P': 45 },
  6:  { '720P': 45,  '1080P': 55 },
  8:  { '720P': 55,  '1080P': 78 },
  10: { '720P': 65,  '1080P': 93 },
  12: { '720P': 78,  '1080P': 105 },
  15: { '720P': 93,  '1080P': 120 },
};

export function computeVideoCost(duration: VideoDuration, resolution: VideoResolution, hasVideoInput: boolean): number {
  return Math.ceil(VIDEO_PRICING[duration][resolution] * (hasVideoInput ? 1.5 : 1));
}

export const ASPECT_RATIO_OPTIONS = [
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
] as const;

export const MAX_REFERENCE_IMAGES = 9;
export const MAX_REFERENCE_IMAGES_WITH_VIDEO = 5;
