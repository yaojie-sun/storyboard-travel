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
 * 视频生成定价：**4 积分/秒 = 0.4 元/秒**（2026-10-16 产品决策）。
 * 线上 1 积分 = 0.1 元（服务器 `system_configs.credits_per_yuan` = 10）⇒ 15 秒 = 60 积分。
 * 分辨率不影响价格（只有 720P 一档）。
 * 🔴 除专业版外，所有版本的扣费规则一致（本条即基准）。
 * ⚠️ 改这里必须同改 `src-tauri/src/commands/banana_api.rs` 的 `base_credits`（真正送去扣费的金额）。
 */
export const VIDEO_PRICING: Record<VideoDuration, number> = {
  4: 16,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  15: 60,
};

export function computeVideoCost(duration: VideoDuration, hasVideoInput: boolean): number {
  return Math.ceil(VIDEO_PRICING[duration] * (hasVideoInput ? 1.5 : 1));
}

/**
 * 画幅候选。**取值必须落在上游白名单里**：
 * `minimax/mod.rs::normalize_ratio` 的白名单是
 * `adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16`，白名单外的值会被上游静默改成
 * `adaptive`（跟着参考图跑）—— 那等于用户选的画幅没生效，所以这里一个都不能自造。
 *
 * 标签只写比例数字 —— 五个 chip 要挤在一行里，`16:9 横屏` 这种后缀会把按钮撑破；
 * 「横屏/竖屏」的解释放在 `title` 提示里（见 `VideoGenDialog` 的 `ASPECT_LABEL_KEYS`）。
 */
export const ASPECT_RATIO_OPTIONS = [
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
] as const;

export const MAX_REFERENCE_IMAGES = 9;
export const MAX_REFERENCE_IMAGES_WITH_VIDEO = 5;
