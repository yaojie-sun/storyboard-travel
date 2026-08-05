import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Upload, AlertTriangle } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useAssetStore, type AssetCategory } from '@/stores/assetStore';
import { UiButton } from '@/components/ui/primitives';

const CATEGORIES: { key: AssetCategory; labelKey: string }[] = [
  { key: 'character', labelKey: 'asset.category.character' },
  { key: 'scene', labelKey: 'asset.category.scene' },
  { key: 'costume_prop', labelKey: 'asset.category.costume_prop' },
];

interface AddAssetDialogProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function AddAssetDialog({ projectId, isOpen, onClose }: AddAssetDialogProps) {
  const { t } = useTranslation();
  const addAsset = useAssetStore((s) => s.addAsset);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [category, setCategory] = useState<AssetCategory>('character');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handlePickFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      });
      if (!selected) return;
      const path = selected as string;
      setSelectedFilePath(path);
      setSelectedFileName(path.split(/[\\/]/).pop() ?? path);
      setPreviewUrl(convertFileSrc(path));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSave = async () => {
    if (!selectedFilePath) {
      setError(t('asset.error.noFile'));
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('asset.error.noName'));
      return;
    }

    setSaving(true);
    setError('');

    try {
      const id = uuidv4();

      await addAsset(
        id,
        projectId,
        category,
        trimmedName,
        selectedFilePath,
        selectedFileName,
      );

      // Reset form
      setSelectedFilePath(null);
      setSelectedFileName('');
      setPreviewUrl(null);
      setName('');
      setCategory('character');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setSelectedFilePath(null);
    setSelectedFileName('');
    setPreviewUrl(null);
    setName('');
    setCategory('character');
    setError('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose}>
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-dark">
          <h2 className="text-base font-semibold text-text-dark">{t('asset.addTitle')}</h2>
          <button type="button" onClick={handleClose} className="p-1 hover:bg-bg-dark rounded text-text-muted">
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

          {/* Image Upload */}
          <div>
            <label className="block text-sm font-medium text-text-dark mb-2">{t('asset.image')}</label>
            <div
              className="border-2 border-dashed border-border-dark rounded-lg p-4 text-center cursor-pointer hover:border-accent/50 transition-colors"
              onClick={handlePickFile}
            >
              {previewUrl ? (
                <div className="relative inline-block">
                  <img src={previewUrl} alt="preview" className="max-h-48 rounded-lg object-contain" />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setSelectedFilePath(null); setPreviewUrl(null); }}
                    className="absolute -top-2 -right-2 p-0.5 bg-surface-dark border border-border-dark rounded-full text-text-muted"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center py-6 text-text-muted">
                  <Upload className="w-8 h-8 mb-2" />
                  <p className="text-sm">{t('asset.clickToUpload')}</p>
                </div>
              )}
            </div>
          </div>

          {/* Name Input */}
          <div>
            <label className="block text-sm font-medium text-text-dark mb-2">
              {t('asset.name')}
              <span className="ml-1 text-xs text-warning">*</span>
            </label>
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

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-dark">
          <UiButton type="button" variant="ghost" size="sm" onClick={handleClose}>
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
