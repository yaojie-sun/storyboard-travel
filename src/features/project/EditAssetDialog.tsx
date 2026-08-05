import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, AlertTriangle } from 'lucide-react';
import { useAssetStore, type AssetCategory } from '@/stores/assetStore';
import { UiButton } from '@/components/ui/primitives';

const CATEGORIES: { key: AssetCategory; labelKey: string }[] = [
  { key: 'character', labelKey: 'asset.category.character' },
  { key: 'scene', labelKey: 'asset.category.scene' },
  { key: 'costume_prop', labelKey: 'asset.category.costume_prop' },
];

interface EditAssetDialogProps {
  assetId: string;
  initialName: string;
  initialCategory: AssetCategory;
  isOpen: boolean;
  onClose: () => void;
}

export function EditAssetDialog({ assetId, initialName, initialCategory, isOpen, onClose }: EditAssetDialogProps) {
  const { t } = useTranslation();
  const updateAsset = useAssetStore((s) => s.updateAsset);
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState<AssetCategory>(initialCategory);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('asset.error.noName'));
      return;
    }

    setSaving(true);
    setError('');

    try {
      await updateAsset(assetId, trimmedName, category);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-xl w-full max-w-sm mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-dark">
          <h2 className="text-base font-semibold text-text-dark">{t('asset.editTitle')}</h2>
          <button type="button" onClick={onClose} className="p-1 hover:bg-bg-dark rounded text-text-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Category Select */}
          <div>
            <label className="block text-sm font-medium text-text-dark mb-2">{t('asset.categoryLabel')}</label>
            <div className="flex gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setCategory(cat.key)}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    category === cat.key
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border-dark text-text-muted hover:border-text-muted'
                  }`}
                >
                  {t(cat.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Name Input */}
          <div>
            <label className="block text-sm font-medium text-text-dark mb-2">{t('asset.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('asset.namePlaceholder')}
              className="w-full px-3 py-2 text-sm rounded-lg bg-bg-dark text-text-dark border border-border-dark focus:outline-none focus:border-accent"
            />
            <div className="flex items-start gap-1.5 mt-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
              <p className="text-xs text-warning">{t('asset.nameHint')}</p>
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-danger bg-danger/10 px-3 py-2 rounded-lg">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-dark">
          <UiButton type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton type="button" variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </UiButton>
        </div>
      </div>
    </div>
  );
}
