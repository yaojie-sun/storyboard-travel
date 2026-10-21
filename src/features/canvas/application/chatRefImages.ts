import type { AssetRecord } from '@/stores/assetStore';

export interface MatchedRefAsset {
  name: string;
  filePath: string;
  /** @图N 的 N（= 资产稳定序号），不是数组下标 */
  index: number;
}

/**
 * 把写手选中的 @图N 编号（1-based）映射到具体资产。
 *
 * 🔴 锚点是资产的**稳定序号 `seq`**（Rust 侧 `ORDER BY seq ASC`，按上传先后递增、
 * 删除后不复用）。`buildAssetReferenceLines` 里的 `@图N` 用的也是 `seq`。
 * 老数据若还没有 seq（升级瞬间的内存缓存），回退到数组下标兜底。
 * 这里**绝不能** filter / sort —— 任何过滤都会让编号位移。filePath 缺失按「跳过但不下移」。
 *
 * 🔴 参考图规则「以写手为准」：写手没写【选图】（也没在正文引用 `<Picture N>`）时
 * `selectedRefImages` 为空 ⇒ **一张都不挂**，不再回退到「最近上传 N 张」。
 *
 * @param assets listAssets 的顺序（seq 升序，不要预先过滤/排序）
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

  const bySeq = new Map<number, AssetRecord>();
  let seqComplete = assets.length > 0;
  for (const a of assets) {
    if (typeof a.seq === 'number' && a.seq > 0) bySeq.set(a.seq, a);
    else seqComplete = false;
  }

  const matched: MatchedRefAsset[] = [];
  for (const n of selectedRefImages) {
    if (matched.length >= max) break;
    const asset = seqComplete ? bySeq.get(n) : assets[n - 1];
    if (!asset?.filePath) continue; // 跳过但不下移编号
    matched.push({ name: asset.name, filePath: asset.filePath, index: n });
  }
  return matched;
}
