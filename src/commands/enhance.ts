import { invoke, isTauri } from '@tauri-apps/api/core';

export interface EnhanceImageResult {
  imagePath: string;
  previewImagePath: string;
  aspectRatio: string;
}

/**
 * 使用本地 realesrgan-ncnn-vulkan 超分图片
 * @param imagePath 图片的本地文件路径
 * @param scale 超分倍数，默认 4（可选 2/3/4）
 * @returns 增强后的图片文件路径
 */
export async function enhanceImage(
  imagePath: string,
  scale: 2 | 3 | 4 = 4,
): Promise<string> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<string>('enhance_image', {
    imagePath,
    scale,
  });
}

/**
 * 使用 ffmpeg Lanczos 缩放对视频进行本地超分
 * ffmpeg Lanczos scale → libx264 编码，一条命令完成，秒级耗时
 * @param videoPath 视频的本地文件路径或远程 URL
 * @param scale 超分倍数，默认 2（可选 2/3/4）；给了 targetShortEdge 时忽略
 * @param targetShortEdge 目标短边（如 1080），按比例换算目标分辨率；源码率更高时不会降分辨率
 * @returns 增强后的视频文件路径
 */
export async function enhanceVideo(
  videoPath: string,
  scale: 2 | 3 | 4 = 2,
  targetShortEdge?: number,
): Promise<string> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<string>('enhance_video', {
    videoPath,
    scale,
    targetShortEdge: targetShortEdge ?? null,
  });
}

export interface SrCapability {
  /** 能不能跑 AI 超分：二进制/模型齐全 + 有真 GPU + 实测速度过线 */
  aiAvailable: boolean;
  /** Vulkan 设备名，如 `AMD Radeon RX 5700 XT` */
  gpu: string | null;
  /** 只有软件光栅化设备时为真 */
  softwareRenderer: boolean;
  /** 实测每百万输出像素的推理耗时（毫秒，含模型加载） */
  msPerMegapixel: number | null;
  /** 实际会使用的 H.264 编码器 */
  encoder: string;
  hardwareEncoder: boolean;
}

const NO_SR_CAPABILITY: SrCapability = {
  aiAvailable: false,
  gpu: null,
  softwareRenderer: false,
  msPerMegapixel: null,
  encoder: 'libx264',
  hardwareEncoder: false,
};

let srCapabilityPromise: Promise<SrCapability> | null = null;

/**
 * 探测本机 AI 超分能力。
 *
 * 会在本机跑一次 8 帧微基准（独显约 1 秒），因此整个会话只探一次；
 * 探测失败不缓存，下次调用可重试。
 */
export function probeSrCapability(): Promise<SrCapability> {
  if (!isTauri()) return Promise.resolve(NO_SR_CAPABILITY);
  if (!srCapabilityPromise) {
    srCapabilityPromise = invoke<SrCapability>('probe_sr_capability').catch((e) => {
      console.warn('[enhance] 本机超分能力探测失败:', e);
      srCapabilityPromise = null;
      return NO_SR_CAPABILITY;
    });
  }
  return srCapabilityPromise;
}

/**
 * 本地 AI 视频超分：抽帧 → Real-ESRGAN 逐帧推理 → 带原音轨重编码。
 * 真正还原细节（对比 enhanceVideo 的 ffmpeg Lanczos 插值放大），耗时约 1–5 分钟。
 * 进度通过 `enhance-video-progress` 事件上报。
 * @param videoPath 本地视频文件路径（不支持远程 URL，请先用 enhanceVideo）
 * @param targetShortEdge 目标短边，默认 1080（横版 1920x1080 / 竖版 1080x1920）。
 *   推理倍数由后端按目标自动选最小整数档位；源已达到目标时直接返回原路径。
 * @param model 模型名，默认 realesr-animevideov3
 */
export async function enhanceVideoAi(
  videoPath: string,
  targetShortEdge: number = 1080,
  model?: string,
): Promise<string> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<string>('enhance_video_ai', {
    videoPath,
    targetShortEdge,
    model: model ?? null,
  });
}
