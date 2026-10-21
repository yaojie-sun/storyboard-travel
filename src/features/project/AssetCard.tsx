import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, ImageOff, Pencil } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';

interface AssetCardProps {
  id: string;
  name: string;
  category: string;
  filePath: string;
  /** 资产稳定序号 = 写手【选图】/ 资产行里用的 @图N */
  seq?: number;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}

export function AssetCard({ id, name, category, filePath, seq, onDelete, onEdit }: AssetCardProps) {
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

      {/* 资产编号角标 = 写手选图用的 @图N，让用户能核对编号 */}
      {typeof seq === 'number' && seq > 0 && (
        <span
          className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white/90"
          title={t('asset.seqBadge', { n: seq, defaultValue: '@图{{n}}' })}
        >
          @图{seq}
        </span>
      )}

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
