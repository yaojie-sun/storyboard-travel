import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SceneMarker } from '../domain/sceneMarker';
import { generateTopDownPositioningMapDataUrl } from '@/features/canvas/application/topDownMapRenderer';
import { UiButton, UiModal } from '@/components/ui';
import SceneMarkerEditor from './SceneMarkerEditor';

interface SceneMarkerManagerProps {
  isOpen: boolean;
  onClose: () => void;
  markers: SceneMarker[];
  onMarkersChange: (markers: SceneMarker[]) => void;
}

export default function SceneMarkerManager({
  isOpen,
  onClose,
  markers,
  onMarkersChange,
}: SceneMarkerManagerProps) {
  const { t } = useTranslation();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [newNameInput, setNewNameInput] = useState('');

  const handleEdit = useCallback((index: number) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setEditingIndex(index);
  }, []);

  const handleCreate = () => {
    const name = newNameInput.trim();
    if (!name) return;
    const newMarker: SceneMarker = {
      id: `sm-${Date.now()}`,
      name,
      characters: [],
      cameras: [],
      props: [],
      movementArrows: [],
    };
    const next = [...markers, newMarker];
    onMarkersChange(next);
    setEditingIndex(next.length - 1);
    setNewNameInput('');
  };

  const handleDelete = (index: number) => {
    const name = markers[index].name;
    if (!window.confirm(t('node.sceneMarkerManager.deleteConfirm', { name }))) return;
    const next = markers.filter((_, i) => i !== index);
    onMarkersChange(next);
    if (editingIndex === index) setEditingIndex(null);
  };

  const handleMarkerUpdate = (updated: SceneMarker) => {
    if (editingIndex === null) return;
    const next = [...markers];
    next[editingIndex] = updated;
    onMarkersChange(next);
  };

  const thumbnails = useMemo(() => {
    return markers.map((m) => {
      try {
        return generateTopDownPositioningMapDataUrl(m, { imageSize: 128 });
      } catch {
        return null;
      }
    });
  }, [markers]);

  return (
    <>
      <UiModal
        isOpen={isOpen}
        title={t('node.sceneMarkerManager.title')}
        onClose={onClose}
        widthClassName="max-w-lg"
      >
        <div className="flex flex-col gap-3">
          {/* Create new */}
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-primary"
              placeholder={t('node.sceneMarkerManager.newMarkerPlaceholder')}
              value={newNameInput}
              onChange={(e) => setNewNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
            <UiButton size="sm" onClick={handleCreate}>
              {t('node.sceneMarkerManager.newMarker')}
            </UiButton>
          </div>

          {/* List */}
          {markers.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">
              {t('node.sceneMarkerManager.empty')}
            </p>
          ) : (
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {markers.map((m, i) => (
                <div
                  key={m.id}
                  className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-bg-secondary"
                  onClick={() => handleEdit(i)}
                >
                  {/* Preview thumbnail */}
                  {thumbnails[i] ? (
                    <img
                      src={thumbnails[i]!}
                      alt={m.name}
                      className="h-10 w-14 flex-shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-bg-secondary text-[18px] font-bold text-text-muted">
                      {i + 1}
                    </div>
                  )}
                  {/* Info */}
                  <div className="flex-1 text-sm text-text">
                    <div>{m.name}</div>
                    <div className="text-[10px] text-text-muted">
                      {t('node.sceneMarkerManager.characters', { count: m.characters.length })}
                      {' | '}
                      {t('node.sceneMarkerManager.cameras', { count: m.cameras.length })}
                    </div>
                  </div>
                  {/* Delete */}
                  <button
                    className="text-xs text-danger hover:text-danger-hover"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(i);
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <UiButton variant="muted" onClick={onClose}>
              {t('common.close')}
            </UiButton>
          </div>
        </div>
      </UiModal>

      {/* Sub-editor */}
      {editingIndex !== null && markers[editingIndex] && (
        <SceneMarkerEditor
          marker={markers[editingIndex]}
          isOpen={editingIndex !== null}
          onClose={() => setEditingIndex(null)}
          onMarkerChange={handleMarkerUpdate}
        />
      )}
    </>
  );
}
