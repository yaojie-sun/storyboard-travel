export type VideoDuration = 4 | 6 | 8 | 10 | 12 | 15;

/**
 * 分辨率只卖 720P 一档（2026-10-13 产品决策：下线 1080P）。
 * 类型里保留 '1080P' 只是为了让**旧配置**（`configs[nodeId].resolution` 里可能存着 '1080P'）
 * 仍能通过类型检查 —— 它已不参与计价，也没有任何代码按它分支。
 */
export type VideoResolution = '720P' | '1080P';

export const VIDEO_DURATION_OPTIONS: VideoDuration[] = [4, 6, 8, 10, 12, 15];
export const VIDEO_RESOLUTION_OPTIONS: VideoResolution[] = ['720P'];

/**
 * 视频生成定价：0.3 元/秒。
 * 线上 1 积分 = 0.1 元（服务器 `system_configs.credits_per_yuan` = 10）⇒ **3 积分/秒**，
 * 即 15 秒 = 45 积分。分辨率不影响价格（只有 720P 一档）。
 * ⚠️ 改这里必须同改 `src-tauri/src/commands/banana_api.rs` 的 `base_credits`（真正送去扣费的金额）。
 */
export const VIDEO_PRICING: Record<VideoDuration, number> = {
  4: 12,
  6: 18,
  8: 24,
  10: 30,
  12: 36,
  15: 45,
};

export function computeVideoCost(duration: VideoDuration, hasVideoInput: boolean): number {
  return Math.ceil(VIDEO_PRICING[duration] * (hasVideoInput ? 1.5 : 1));
}

export const ASPECT_RATIO_OPTIONS = [
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
] as const;

export const MAX_REFERENCE_IMAGES = 9;
export const MAX_REFERENCE_IMAGES_WITH_VIDEO = 5;
