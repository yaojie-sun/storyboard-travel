import { invoke } from '@tauri-apps/api/core';

export interface AssetRecord {
  id: string;
  projectId: string;
  category: string;
  name: string;
  filePath: string;
  fileName: string;
  createdAt: number;
  /** 项目内稳定序号（从 1 起，按上传先后递增，删除后留空号不复用）= @图N 的 N */
  seq: number;
}

export type AssetCategory = 'character' | 'scene' | 'costume_prop';

export async function addAsset(
  id: string,
  projectId: string,
  category: string,
  name: string,
  sourcePath: string,
  fileName: string,
): Promise<AssetRecord> {
  return await invoke<AssetRecord>('add_asset', {
    id,
    projectId,
    category,
    name,
    sourcePath,
    fileName,
  });
}

export async function updateAsset(
  id: string,
  name: string,
  category: string,
): Promise<AssetRecord> {
  return await invoke<AssetRecord>('update_asset', { id, name, category });
}

export async function listAssets(projectId: string): Promise<AssetRecord[]> {
  return await invoke<AssetRecord[]>('list_assets', { projectId });
}

export async function deleteAsset(id: string): Promise<void> {
  await invoke('delete_asset', { id });
}
export interface AssetDescription {
  assetId: string;
  description: string;
}

export async function describeAsset(id: string): Promise<string | null> {
  return await invoke<string | null>('describe_asset', { assetId: id });
}

export async function getAssetDescriptions(projectId: string): Promise<AssetDescription[]> {
  return await invoke<AssetDescription[]>('get_asset_descriptions', { projectId });
}

// 组装 Chat context 用的 @图N 参考图行（含视觉描述）。
// readIfMissing=true 时才补读缺失描述（生成分镜时显式触发）；默认 false 不读，避免「上传/进画布即读图」。
// 行业无关，复刻到各行业版时仅 catLabel 文案随行业微调。
export async function buildAssetReferenceLines(
  projectId: string,
  opts?: { readIfMissing?: boolean },
): Promise<string[]> {
  const readIfMissing = opts?.readIfMissing ?? false;
  const assets = await listAssets(projectId);
  if (assets.length === 0) return [];

  const descArr = await getAssetDescriptions(projectId).catch(() => []);
  const descMap = new Map(descArr.map((d) => [d.assetId, d.description]));

  // 只在生成时补读缺失描述（阻塞 + 补读后重查缓存，保证发消息时描述已就绪）
  // 分批并发：读图引导词升级后，老项目会一次性「全部缺失」，不限流会瞬间打出几十个请求
  if (readIfMissing) {
    const missing = assets.filter((a) => !descMap.has(a.id));
    const DESCRIBE_CONCURRENCY = 3;
    for (let i = 0; i < missing.length; i += DESCRIBE_CONCURRENCY) {
      await Promise.allSettled(
        missing
          .slice(i, i + DESCRIBE_CONCURRENCY)
          .map((a) => describeAsset(a.id).catch(() => null)),
      );
    }
    const refreshed = await getAssetDescriptions(projectId).catch(() => []);
    refreshed.forEach((d) => descMap.set(d.assetId, d.description));
  }

  const catLabel = (cat: string) =>
    cat === 'character' ? '角色' : cat === 'scene' ? '场景' : '服装及道具';

  // 编号用资产自己的稳定序号 seq（不是数组下标）——新传一张图不会让已发出的 @图N 指错
  return assets.map((a, i) => {
    const n = a.seq > 0 ? a.seq : i + 1;
    const base = `@图${n}: ${a.name} (${catLabel(a.category)})`;
    const desc = descMap.get(a.id);
    return desc ? `${base}\n  视觉描述：${desc}` : base;
  });
}

