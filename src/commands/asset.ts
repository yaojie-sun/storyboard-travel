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
