import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, ImageOff, Pencil } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';

interface AssetCardProps {
  id: string;
  name: string;
  category: string;
  filePath: string;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}

export function AssetCard({ id, name, category, filePath, onDelete, onEdit }: AssetCardProps) {
  const { t } = useTranslation();
  const [imgError, setImgError] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const imageUrl = convertFileSrc(filePath);

  const categoryLabel = t(`asset.category.${category}` as any, category);

  const handleDelete = () => {
    setDeleting(true);
    onDelete(id);
  };

  return (
    <div className="group relative bg-surface-dark border border-border-dark rounded-lg overflow-hidden hover:border-accent/50 transition-colors">
      {/* Image */}
      <div className="aspect-square bg-bg-dark flex items-center justify-center overflow-hidden">
        {imgError ? (
          <ImageOff className="w-8 h-8 text-text-muted/50" />
        ) : (
          <img
            src={imageUrl}
            alt={name}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        )}
      </div>

      {/* Info */}
      <div className="p-2.5">
        <p className="text-sm font-medium text-text-dark truncate" title={name}>{name}</p>
        <p className="text-xs text-text-muted mt-0.5">{categoryLabel}</p>
      </div>

      {/* Action buttons (visible on hover) */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => onEdit(id)}
          className="p-1.5 bg-black/60 rounded-full text-white/80 hover:text-accent transition-colors"
          title={t('common.edit')}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="p-1.5 bg-black/60 rounded-full text-white/80 hover:text-danger transition-colors"
          title={t('common.delete')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
