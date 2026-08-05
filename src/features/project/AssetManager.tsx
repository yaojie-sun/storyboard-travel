import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ImageOff } from 'lucide-react';
import { useAssetStore, type AssetCategory } from '@/stores/assetStore';
import { AssetCard } from './AssetCard';
import { AddAssetDialog } from './AddAssetDialog';
import { EditAssetDialog } from './EditAssetDialog';
import { UiButton } from '@/components/ui/primitives';

const CATEGORY_TABS: { key: AssetCategory | 'all'; labelKey: string }[] = [
  { key: 'all', labelKey: 'asset.tab.all' },
  { key: 'character', labelKey: 'asset.category.character' },
  { key: 'scene', labelKey: 'asset.category.scene' },
  { key: 'costume_prop', labelKey: 'asset.category.costume_prop' },
];

interface AssetManagerProps {
  projectId: string;
}

export function AssetManager({ projectId }: AssetManagerProps) {
  const { t } = useTranslation();
  const assetsByProject = useAssetStore((s) => s.assetsByProject);
  const loadAssets = useAssetStore((s) => s.loadAssets);
  const deleteAsset = useAssetStore((s) => s.deleteAsset);
  const [activeTab, setActiveTab] = useState<AssetCategory | 'all'>('all');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingAsset, setEditingAsset] = useState<{ id: string; name: string; category: AssetCategory } | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (projectId && !loadedRef.current) {
      loadedRef.current = true;
      void loadAssets(projectId);
    }
  }, [projectId, loadAssets]);

  const allAssets = assetsByProject[projectId] ?? [];
  const filteredAssets = activeTab === 'all'
    ? allAssets
    : allAssets.filter((a) => a.category === activeTab);

  const handleDelete = useCallback((assetId: string) => {
    deleteAsset(projectId, assetId);
  }, [projectId, deleteAsset]);

  const handleEdit = useCallback((assetId: string) => {
    const asset = allAssets.find((a) => a.id === assetId);
    if (asset) {
      setEditingAsset({ id: asset.id, name: asset.name, category: asset.category as AssetCategory });
    }
  }, [allAssets]);

  return (
    <div className="border border-border-dark rounded-lg p-4 bg-surface-dark">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-dark">{t('dashboard.assetManagement')}</h3>
        <UiButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAddDialog(true)}
          className="gap-1"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('asset.add')}
        </UiButton>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-1 mb-3 overflow-x-auto">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-2.5 py-1 text-xs rounded-lg whitespace-nowrap transition-colors ${
              activeTab === tab.key
                ? 'bg-accent/10 text-accent border border-accent/30'
                : 'text-text-muted hover:text-text-dark border border-transparent'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Asset Grid */}
      {filteredAssets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-text-muted">
          <ImageOff className="w-8 h-8 mb-2 opacity-40" />
          <p className="text-sm">{t('asset.empty')}</p>
          <UiButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAddDialog(true)}
            className="mt-2 gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('asset.addFirst')}
          </UiButton>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {filteredAssets.map((asset) => (
            <AssetCard
              key={asset.id}
              id={asset.id}
              name={asset.name}
              category={asset.category}
              filePath={asset.filePath}
              onDelete={handleDelete}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      {/* Add Asset Dialog */}
      <AddAssetDialog
        projectId={projectId}
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
      />

      {/* Edit Asset Dialog */}
      {editingAsset && (
        <EditAssetDialog
          assetId={editingAsset.id}
          initialName={editingAsset.name}
          initialCategory={editingAsset.category}
          isOpen={!!editingAsset}
          onClose={() => setEditingAsset(null)}
        />
      )}
    </div>
  );
}
