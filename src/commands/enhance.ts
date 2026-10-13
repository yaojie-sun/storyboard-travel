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
 * 使用本地 realesrgan-ncnn-vulkan 超分视频
 * 流水线：ffmpeg 帧提取 → realesrgan 帧超分 → ffmpeg 合并
 * @param videoPath 视频的本地文件路径
 * @param scale 超分倍数，默认 2（可选 2/3/4）
 * @returns 增强后的视频文件路径
 */
export async function enhanceVideo(
  videoPath: string,
  scale: 2 | 3 | 4 = 2,
): Promise<string> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<string>('enhance_video', {
    videoPath,
    scale,
  });
}
