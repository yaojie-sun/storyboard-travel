import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { SceneMarker, SceneMarkerCharacter, SceneMarkerCamera, FloorPlanProp, MovementArrow } from '@/features/canvas/domain/sceneMarker';
import { FLOOR_PLAN_PRESETS } from '@/features/canvas/domain/sceneMarker';
import { FloorPlanEditor } from './FloorPlanEditor';
import { UiModal } from '@/components/ui';

interface SceneComposerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  markers: SceneMarker[];
  onMarkersChange: (markers: SceneMarker[]) => void;
  /** Character names extracted from frame descriptions, for auto-sync */
  promptCharacterNames?: string[];
  /** Called when user exports a top-down map — parent can create a reference node */
  onImagePersisted?: (imagePath: string, markerName: string) => void;
}

const CHARACTER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
];

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function SceneComposerDialog({
  isOpen,
  onClose,
  markers,
  onMarkersChange,
  promptCharacterNames = [],
  onImagePersisted,
}: SceneComposerDialogProps) {
  const { t } = useTranslation();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [customName, setCustomName] = useState('');
  const [customCharName, setCustomCharName] = useState('');
  const [renameValue, setRenameValue] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const containerSizeRef = useRef({ w: 850, h: 0 }); // h=0 means use CSS 62vh
  const [containerWidth, setContainerWidth] = useState(850);
  const [containerHeight, setContainerHeight] = useState<number | null>(null); // null = use 62vh default
  containerSizeRef.current = { w: containerWidth, h: containerHeight ?? 0 };

  // Native DOM resize handle — must use native events to stopImmediatePropagation
  // because React's synthetic stopPropagation can't block Tauri window drag
  const installResizeHandleRef = useRef<(el: HTMLElement) => void>();
  installResizeHandleRef.current = (el: HTMLElement) => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = rect.width;
      const startH = rect.height;
      resizingRef.current = true;

      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        ev.preventDefault();
        const newW = Math.max(700, Math.min(window.innerWidth * 0.95, startW + (ev.clientX - startX)));
        const newH = Math.max(400, Math.min(window.innerHeight * 0.88, startH + (ev.clientY - startY)));
        if (containerRef.current) {
          containerRef.current.style.width = `${newW}px`;
          containerRef.current.style.height = `${newH}px`;
        }
      };
      const onUp = () => {
        resizingRef.current = false;
        if (containerRef.current) {
          setContainerWidth(containerRef.current.offsetWidth);
          setContainerHeight(containerRef.current.offsetHeight);
        }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    el.addEventListener('mousedown', onDown);
    (el as any).__resizeCleanup = () => el.removeEventListener('mousedown', onDown);
  };

  // Reset size when dialog opens with new markers
  useEffect(() => {
    if (isOpen) {
      setContainerWidth(850);
      setContainerHeight(null);
    }
  }, [isOpen]);

  const editingMarker = editingIndex !== null ? markers[editingIndex] : null;

  const availableCharacters = useMemo(() => {
    if (editingIndex === null) return [];
    const existing = markers[editingIndex]?.characters ?? [];
    const existingNames = new Set(existing.map((c) => c.name));
    // Sync: prompt names that don't yet have a character in this marker
    const unsynced = promptCharacterNames.filter((n) => !existingNames.has(n));
    return unsynced;
  }, [editingIndex, markers, promptCharacterNames]);

  const handleCreateMarker = useCallback(() => {
    const newMarker: SceneMarker = {
      id: makeId('sm'),
      name: t('node.sceneMarkerManager.newMarkerPlaceholder', '新场景'),
      characters: [],
      cameras: [],
      props: [],
      movementArrows: [],
    };
    onMarkersChange([...markers, newMarker]);
    setEditingIndex(markers.length);
  }, [markers, onMarkersChange, t]);

  const handleDeleteMarker = useCallback(
    (index: number) => {
      if (!window.confirm(t('node.sceneMarkerManager.deleteConfirm', { name: markers[index].name }))) return;
      const next = markers.filter((_, i) => i !== index);
      onMarkersChange(next);
      if (editingIndex === index) {
        setEditingIndex(null);
      } else if (editingIndex !== null && editingIndex > index) {
        setEditingIndex(editingIndex - 1);
      }
    },
    [markers, editingIndex, onMarkersChange, t],
  );

  const handleMarkerChange = useCallback(
    (updated: SceneMarker) => {
      if (editingIndex === null) return;
      const next = [...markers];
      next[editingIndex] = updated;
      onMarkersChange(next);
    },
    [markers, editingIndex, onMarkersChange],
  );

  const handleAddCharacter = useCallback(
    (name: string) => {
      if (editingIndex === null || !editingMarker) return;
      const exists = editingMarker.characters.some((c) => c.name === name);
      if (exists) return;
      const char: SceneMarkerCharacter = {
        id: makeId('char'),
        name,
        horizontal: 'center',
        vertical: 'center',
        shotScale: 'medium',
        colorHex: CHARACTER_COLORS[editingMarker.characters.length % CHARACTER_COLORS.length],
        floorPosition: {
          x: 0.3 + Math.random() * 0.4,
          y: 0.3 + Math.random() * 0.4,
        },
      };
      handleMarkerChange({
        ...editingMarker,
        characters: [...editingMarker.characters, char],
      });
    },
    [editingIndex, editingMarker, handleMarkerChange],
  );

  const handleAddProp = useCallback(
    (preset: { name: string; colorHex: string; width: number; height: number }) => {
      if (editingIndex === null || !editingMarker) return;
      if (preset.name === '动线' || preset.name === '轴线') {
        const arrow: MovementArrow = {
          id: makeId('arrow'),
          label: preset.name,
          lineStyle: preset.name === '轴线' ? 'dashed' : 'solid',
          startPosition: { x: 0.25, y: 0.5 },
          endPosition: { x: 0.55, y: 0.5 },
          colorHex: preset.colorHex,
        };
        handleMarkerChange({
          ...editingMarker,
          movementArrows: [...(editingMarker.movementArrows ?? []), arrow],
        });
        return;
      }
      const prop: FloorPlanProp = {
        id: makeId('prop'),
        name: preset.name,
        floorPosition: { x: 0.3 + Math.random() * 0.4, y: 0.3 + Math.random() * 0.4 },
        colorHex: preset.colorHex,
        width: preset.width,
        height: preset.height,
      };
      handleMarkerChange({
        ...editingMarker,
        props: [...editingMarker.props, prop],
      });
    },
    [editingIndex, editingMarker, handleMarkerChange],
  );

  const handleAddCustomProp = useCallback(() => {
    const name = customName.trim();
    if (!name || editingIndex === null || !editingMarker) return;
    handleAddProp({ name, colorHex: '#9B9B9B', width: 0.12, height: 0.08 });
    setCustomName('');
  }, [customName, editingIndex, editingMarker, handleAddProp]);

  const handleAddCustomCharacter = useCallback(() => {
    const name = customCharName.trim();
    if (!name) return;
    handleAddCharacter(name);
    setCustomCharName('');
  }, [customCharName, handleAddCharacter]);

  const handleRenameMarker = useCallback(() => {
    const name = renameValue.trim();
    if (!name || editingIndex === null) return;
    const next = [...markers];
    next[editingIndex] = { ...next[editingIndex], name };
    onMarkersChange(next);
  }, [renameValue, editingIndex, markers, onMarkersChange]);

  const handleAddCamera = useCallback(() => {
    if (editingIndex === null || !editingMarker) return;
    const cameraCount = editingMarker.cameras.length + 1;
    const cam: SceneMarkerCamera = {
      id: makeId('cam'),
      label: `${t('node.sceneMarkerEditor.cameraDefaultName', '机位')} ${cameraCount}`,
      direction: 'center',
      angle: 'level',
      floorPosition: { x: 0.5, y: 0.92 },
      floorOrientation: { rotationDeg: 270, fovDeg: 60 },
    };
    handleMarkerChange({
      ...editingMarker,
      cameras: [...editingMarker.cameras, cam],
    });
  }, [editingIndex, editingMarker, handleMarkerChange, t]);

  return (
    <UiModal isOpen={isOpen} onClose={onClose} title={t('node.sceneMarkerManager.title')} widthClassName="">
      <div
        ref={containerRef}
        className="flex flex-col gap-3 relative"
        style={{
          width: `${containerWidth}px`,
          height: containerHeight != null ? `${containerHeight}px` : '62vh',
          overflow: 'hidden',
          minWidth: '700px',
          minHeight: '400px',
          maxWidth: '95vw',
          maxHeight: '88vh',
        }}
        data-no-drag="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <h2 className="text-lg font-semibold">{t('node.sceneMarkerManager.title')}</h2>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left: Marker list + Material library */}
          <div className="w-56 shrink-0 flex flex-col gap-2 overflow-y-auto overflow-x-hidden">
            {/* Marker list */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-white/60 font-medium px-1">
                <span>{t('node.sceneMarkerManager.title')}</span>
                <button onClick={handleCreateMarker} className="p-0.5 hover:bg-white/10 rounded">
                  <Plus size={14} />
                </button>
              </div>
              {markers.map((m, i) => (
                <div
                  key={m.id}
                  className={`w-full rounded text-sm flex items-center justify-between group ${
                    editingIndex === i ? 'bg-white/15' : 'hover:bg-white/5'
                  }`}
                >
                  {editingIndex === i ? (
                    <input
                      className="flex-1 bg-transparent text-white text-sm px-2 py-1.5 outline-none min-w-0"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameMarker();
                        if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={handleRenameMarker}
                      onFocus={(e) => e.target.select()}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <button
                      className="flex-1 text-left px-2 py-1.5 truncate text-white/70 min-w-0"
                      onClick={() => {
                        setEditingIndex(i);
                        setRenameValue(m.name);
                      }}
                    >
                      {m.name}
                    </button>
                  )}
                  <X
                    size={12}
                    className="opacity-0 group-hover:opacity-100 text-red-400 shrink-0 ml-1 mr-1 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteMarker(i);
                    }}
                  />
                </div>
              ))}
            </div>

            {editingMarker && (
              <>
                {/* Sync characters from prompt */}
                {availableCharacters.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs text-white/50 font-medium px-1">
                      {t('node.sceneMarkerEditor.characters', { count: availableCharacters.length })}
                    </div>
                    {availableCharacters.map((name) => (
                      <button
                        key={name}
                        className="w-full text-left px-2 py-1 rounded text-xs hover:bg-white/10 text-white/70 flex items-center gap-1.5"
                        onClick={() => handleAddCharacter(name)}
                      >
                        <Plus size={10} />
                        {name}
                      </button>
                    ))}
                  </div>
                )}

                {/* Custom character input */}
                <div className="flex gap-1">
                  <input
                    className="flex-1 px-2 py-1 text-xs rounded bg-white/5 border border-white/10 text-white placeholder:text-white/30"
                    placeholder={t('node.sceneMarkerEditor.addCharacter')}
                    value={customCharName}
                    onChange={(e) => setCustomCharName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCustomCharacter()}
                  />
                  <button
                    className="px-2 py-1 text-xs bg-white/10 hover:bg-white/20 rounded"
                    onClick={handleAddCustomCharacter}
                  >
                    <Plus size={12} />
                  </button>
                </div>

                {/* Preset material library */}
                <div className="space-y-1">
                  <div className="text-xs text-white/50 font-medium px-1">素材库</div>
                  {FLOOR_PLAN_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      className="w-full text-left px-2 py-1 rounded text-xs hover:bg-white/10 text-white/70 flex items-center gap-1.5"
                      onClick={() => handleAddProp(preset)}
                    >
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: preset.colorHex }} />
                      {preset.name}
                    </button>
                  ))}
                </div>

                {/* Custom prop input */}
                <div className="flex gap-1">
                  <input
                    className="flex-1 px-2 py-1 text-xs rounded bg-white/5 border border-white/10 text-white placeholder:text-white/30"
                    placeholder={t('node.sceneMarkerEditor.addProp')}
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCustomProp()}
                  />
                  <button
                    className="px-2 py-1 text-xs bg-white/10 hover:bg-white/20 rounded"
                    onClick={handleAddCustomProp}
                  >
                    <Plus size={12} />
                  </button>
                </div>

                {/* Add camera */}
                <button
                  className="w-full text-left px-2 py-1 rounded text-xs hover:bg-white/10 text-white/60 flex items-center gap-1.5"
                  onClick={handleAddCamera}
                >
                  <Plus size={10} />
                  {t('node.sceneMarkerEditor.addCamera')}
                </button>
              </>
            )}
          </div>

          {/* Right: Editor or empty state */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            {editingMarker ? (
              <FloorPlanEditor
                marker={editingMarker}
                onMarkerChange={handleMarkerChange}
                onImagePersisted={onImagePersisted}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-white/30 text-sm">
                {markers.length === 0
                  ? t('node.sceneMarkerManager.empty')
                  : t('node.sceneMarkerManager.selectHint', '选择一个场景定位')}
              </div>
            )}
          </div>
        </div>

        {/* Bottom buttons */}
        <div className="flex justify-end gap-2 pt-2 border-t border-white/10 shrink-0">
          <button
            className="px-3 py-1.5 text-sm bg-white/5 hover:bg-white/10 rounded text-white/70"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>

        {/* Resize handle — large hit area, native DOM events to beat Tauri window drag */}
        <div
          className="absolute right-0 bottom-0 w-5 h-5 cursor-nwse-resize flex items-center justify-center group"
          ref={(el) => { if (el) installResizeHandleRef.current?.(el); }}
          data-no-drag="true"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className="text-white/30 group-hover:text-white/60 transition-colors"
          >
            <path
              d="M1 11L11 1M5 11L11 5M9 11L11 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    </UiModal>
  );
}
