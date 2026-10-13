import { invoke } from '@tauri-apps/api/core';

export interface AssetRecord {
  id: string;
  projectId: string;
  category: string;
  name: string;
  filePath: string;
  fileName: string;
  createdAt: number;
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
  if (readIfMissing) {
    const missing = assets.filter((a) => !descMap.has(a.id));
    if (missing.length > 0) {
      await Promise.allSettled(missing.map((a) => describeAsset(a.id).catch(() => null)));
    }
    const refreshed = await getAssetDescriptions(projectId).catch(() => []);
    refreshed.forEach((d) => descMap.set(d.assetId, d.description));
  }

  const catLabel = (cat: string) =>
    cat === 'character' ? '角色' : cat === 'scene' ? '场景' : '服饰道具';

  return assets.map((a, i) => {
    const base = `@图${i + 1}: ${a.name} (${catLabel(a.category)})`;
    const desc = descMap.get(a.id);
    return desc ? `${base}\n  视觉描述：${desc}` : base;
  });
}
