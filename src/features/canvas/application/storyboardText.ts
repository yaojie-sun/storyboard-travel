export const STORYBOARD_AT_TAG_REGEX = /@\s*图\d+/g;

export function sanitizeStoryboardText(input: string, ignoreAtTag: boolean): string {
  if (!ignoreAtTag) {
    return input.trim();
  }

  return input
    .replace(STORYBOARD_AT_TAG_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function sanitizeStoryboardPromptText(input: string): string {
  return input
    // 去掉时间码标记，如 [00:00-00:04] 或 [00:06-00:09]
    .replace(/\[\d{2}:\d{2}-\d{2}:\d{2}\]/g, '')
    // 去掉"镜头N："或"镜头N."前缀，避免模型误解为额外格子
    .replace(/镜头\d+[：:\.\s]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
