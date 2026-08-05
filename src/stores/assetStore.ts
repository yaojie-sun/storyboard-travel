import { create } from 'zustand';
import {
  addAsset as apiAddAsset,
  updateAsset as apiUpdateAsset,
  listAssets as apiListAssets,
  deleteAsset as apiDeleteAsset,
  type AssetRecord,
  type AssetCategory,
} from '@/commands/asset';

export type { AssetCategory, AssetRecord } from '@/commands/asset';

interface AssetState {
  assetsByProject: Record<string, AssetRecord[]>;
  isLoading: boolean;

  loadAssets: (projectId: string) => Promise<void>;
  addAsset: (
    id: string,
    projectId: string,
    category: AssetCategory,
    name: string,
    sourcePath: string,
    fileName: string,
  ) => Promise<AssetRecord>;
  updateAsset: (id: string, name: string, category: AssetCategory) => Promise<AssetRecord>;
  deleteAsset: (projectId: string, assetId: string) => void;
  getAssetsByCategory: (projectId: string, category: AssetCategory) => AssetRecord[];
  getAssets: (projectId: string) => AssetRecord[];
  findAssetByName: (projectId: string, name: string) => AssetRecord | undefined;
}

export const useAssetStore = create<AssetState>((set, get) => ({
  assetsByProject: {},
  isLoading: false,

  loadAssets: async (projectId) => {
    set({ isLoading: true });
    try {
      const assets = await apiListAssets(projectId);
      set((state) => ({
        assetsByProject: {
          ...state.assetsByProject,
          [projectId]: assets,
        },
        isLoading: false,
      }));
    } catch {
      set({ isLoading: false });
    }
  },

  addAsset: async (id, projectId, category, name, sourcePath, fileName) => {
    const record = await apiAddAsset(id, projectId, category, name, sourcePath, fileName);
    set((state) => {
      const existing = state.assetsByProject[projectId] ?? [];
      return {
        assetsByProject: {
          ...state.assetsByProject,
          [projectId]: [record, ...existing],
        },
      };
    });
    return record;
  },

  updateAsset: async (id, name, category) => {
    const record = await apiUpdateAsset(id, name, category);
    set((state) => {
      // Find which project this asset belongs to
      for (const [projectId, assets] of Object.entries(state.assetsByProject)) {
        const idx = assets.findIndex((a) => a.id === id);
        if (idx >= 0) {
          const updated = [...assets];
          updated[idx] = record;
          return {
            assetsByProject: {
              ...state.assetsByProject,
              [projectId]: updated,
            },
          };
        }
      }
      return {};
    });
    return record;
  },

  deleteAsset: (projectId, assetId) => {
    // Optimistic delete
    set((state) => {
      const existing = state.assetsByProject[projectId] ?? [];
      return {
        assetsByProject: {
          ...state.assetsByProject,
          [projectId]: existing.filter((a) => a.id !== assetId),
        },
      };
    });
    void apiDeleteAsset(assetId);
  },

  getAssetsByCategory: (projectId, category) => {
    const assets = get().assetsByProject[projectId] ?? [];
    return assets.filter((a) => a.category === category);
  },

  getAssets: (projectId) => {
    return get().assetsByProject[projectId] ?? [];
  },

  findAssetByName: (projectId, name) => {
    const assets = get().assetsByProject[projectId] ?? [];
    return assets.find((a) => a.name === name);
  },
}));
