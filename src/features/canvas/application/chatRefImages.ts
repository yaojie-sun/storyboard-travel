import type { AssetRecord } from '@/stores/assetStore';

export interface MatchedRefAsset {
  name: string;
  filePath: string;
  /** 资产在 listAssets 原始顺序中的下标（0-based），即 @图N 的 N-1 */
  index: number;
}

/**
 * 把写手选中的 @图N 编号（1-based）映射到具体资产。
 *
 * 🔴 锚点是 listAssets 的**原始顺序**：`buildAssetReferenceLines` 里
 * `@图${i + 1}` 的编号直接来自 `listAssets(projectId)` 的数组下标（Rust 侧
 * `ORDER BY created_at DESC`）。因此这里**绝不能** filter / sort —— 任何过滤都会
 * 让下标位移，把 @图2 指到别人的图上。filePath 缺失的资产按「跳过但不下移下标」处理。
 *
 * 🔴 参考图规则「以写手为准」：写手没写【选图】（也没在正文引用 `<Picture N>`）时
 * `selectedRefImages` 为空 ⇒ **一张都不挂**，不再回退到「最近上传 N 张」。
 *
 * @param assets listAssets 的原始顺序（不要预先过滤/排序）
 * @param selectedRefImages 写手选中的 1-based 编号；空表示不挂任何参考图
 * @param max 上限（宫格/直出均为 6）
 * @param onNoSelection 无选图时的回调（打印 warn / 埋点用）
 */
export function matchRefAssets(
  assets: AssetRecord[],
  selectedRefImages: number[] | undefined,
  max: number,
  onNoSelection?: () => void,
): MatchedRefAsset[] {
  if (!selectedRefImages || selectedRefImages.length === 0) {
    onNoSelection?.();
    return [];
  }

  const matched: MatchedRefAsset[] = [];
  for (const n of selectedRefImages) {
    if (matched.length >= max) break;
    const asset = assets[n - 1]; // 原始下标，不受任何过滤影响
    if (!asset?.filePath) continue; // 跳过但不下移下标
    matched.push({ name: asset.name, filePath: asset.filePath, index: n - 1 });
  }
  return matched;
}
