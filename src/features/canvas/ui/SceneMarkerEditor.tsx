import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SceneMarker,
  SceneMarkerCharacter,
  SceneMarkerCamera,
  HorizontalPosition,
  VerticalPosition,
  ShotScale,
  CameraAngle,
} from '../domain/sceneMarker';
import { UiButton, UiModal } from '@/components/ui';

interface SceneMarkerEditorProps {
  marker: SceneMarker;
  isOpen: boolean;
  onClose: () => void;
  onMarkerChange: (marker: SceneMarker) => void;
}

const HORIZONTAL_OPTIONS: { value: HorizontalPosition; labelKey: string }[] = [
  { value: 'left', labelKey: 'node.sceneMarkerEditor.horizontalLeft' },
  { value: 'center', labelKey: 'node.sceneMarkerEditor.horizontalCenter' },
  { value: 'right', labelKey: 'node.sceneMarkerEditor.horizontalRight' },
];

const VERTICAL_OPTIONS: { value: VerticalPosition; labelKey: string }[] = [
  { value: 'top', labelKey: 'node.sceneMarkerEditor.verticalTop' },
  { value: 'center', labelKey: 'node.sceneMarkerEditor.verticalCenter' },
  { value: 'bottom', labelKey: 'node.sceneMarkerEditor.verticalBottom' },
];

const SHOT_SCALE_OPTIONS: { value: ShotScale; labelKey: string }[] = [
  { value: 'close', labelKey: 'node.sceneMarkerEditor.shotScaleClose' },
  { value: 'medium', labelKey: 'node.sceneMarkerEditor.shotScaleMedium' },
  { value: 'full', labelKey: 'node.sceneMarkerEditor.shotScaleFull' },
];

const CAMERA_DIRECTION_OPTIONS: { value: HorizontalPosition; labelKey: string }[] = [
  { value: 'left', labelKey: 'node.sceneMarkerEditor.cameraLeft' },
  { value: 'center', labelKey: 'node.sceneMarkerEditor.cameraCenter' },
  { value: 'right', labelKey: 'node.sceneMarkerEditor.cameraRight' },
];

const CAMERA_ANGLE_OPTIONS: { value: CameraAngle; labelKey: string }[] = [
  { value: 'level', labelKey: 'node.sceneMarkerEditor.angleLevel' },
  { value: 'high', labelKey: 'node.sceneMarkerEditor.angleHigh' },
  { value: 'low', labelKey: 'node.sceneMarkerEditor.angleLow' },
];

const MARKER_COLORS = [
  '#4F46E5', '#DC2626', '#059669', '#D97706',
  '#0891B2', '#7C3AED', '#DB2777', '#2563EB',
];

let colorIndex = 0;
function nextColor(): string {
  const c = MARKER_COLORS[colorIndex % MARKER_COLORS.length];
  colorIndex++;
  return c;
}

export default function SceneMarkerEditor({
  marker,
  isOpen,
  onClose,
  onMarkerChange,
}: SceneMarkerEditorProps) {
  const { t } = useTranslation();
  // Local draft refs to avoid re-render on every keystroke
  const draftNames = useRef<Record<string, string>>({});
  const draftLabels = useRef<Record<string, string>>({});

  const updateMarker = useCallback(
    (patch: Partial<SceneMarker>) => {
      onMarkerChange({ ...marker, ...patch });
    },
    [marker, onMarkerChange],
  );

  useEffect(() => {
    if (!isOpen) return;
    colorIndex = 0;
    draftNames.current = {};
    draftLabels.current = {};
  }, [isOpen, marker.id]);

  const addCharacter = useCallback(() => {
    const newChar: SceneMarkerCharacter = {
      id: `char-${Date.now()}`,
      name: '',
      horizontal: 'center',
      vertical: 'center',
      shotScale: 'medium',
      colorHex: nextColor(),
    };
    updateMarker({ characters: [...marker.characters, newChar] });
  }, [marker, updateMarker]);

  const addCamera = useCallback(() => {
    const newCam: SceneMarkerCamera = {
      id: `cam-${Date.now()}`,
      label: '',
      direction: 'center',
      angle: 'level',
    };
    updateMarker({ cameras: [...marker.cameras, newCam] });
  }, [marker, updateMarker]);

  const updateCharacter = useCallback(
    (id: string, patch: Partial<SceneMarkerCharacter>) => {
      updateMarker({
        characters: marker.characters.map((c) =>
          c.id === id ? { ...c, ...patch } : c,
        ),
      });
    },
    [marker, updateMarker],
  );

  const updateCamera = useCallback(
    (id: string, patch: Partial<SceneMarkerCamera>) => {
      updateMarker({
        cameras: marker.cameras.map((c) =>
          c.id === id ? { ...c, ...patch } : c,
        ),
      });
    },
    [marker, updateMarker],
  );

  const deleteCharacter = useCallback(
    (id: string) => {
      updateMarker({
        characters: marker.characters.filter((c) => c.id !== id),
      });
    },
    [marker, updateMarker],
  );

  const deleteCamera = useCallback(
    (id: string) => {
      updateMarker({
        cameras: marker.cameras.filter((c) => c.id !== id),
      });
    },
    [marker, updateMarker],
  );

  return (
    <UiModal
      isOpen={isOpen}
      title={t('node.sceneMarkerEditor.title', { name: marker.name })}
      onClose={onClose}
      widthClassName="max-w-xl"
    >
      <div className="flex flex-col gap-4">
        {/* Characters section */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-text">
              {t('node.sceneMarkerEditor.characters', { count: marker.characters.length })}
            </span>
            <UiButton variant="muted" size="sm" onClick={addCharacter}>
              {t('node.sceneMarkerEditor.addCharacter')}
            </UiButton>
          </div>
          {marker.characters.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-muted">
              {t('node.sceneMarkerEditor.noCharactersHint')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {marker.characters.map((ch) => (
                <CharacterRow
                  key={ch.id}
                  character={ch}
                  draftNames={draftNames}
                  onUpdate={(patch) => updateCharacter(ch.id, patch)}
                  onDelete={() => deleteCharacter(ch.id)}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>

        {/* Cameras section */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-text">
              {t('node.sceneMarkerEditor.cameras', { count: marker.cameras.length })}
            </span>
            <UiButton variant="muted" size="sm" onClick={addCamera}>
              {t('node.sceneMarkerEditor.addCamera')}
            </UiButton>
          </div>
          {marker.cameras.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-muted">
              {t('node.sceneMarkerEditor.noCamerasHint')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {marker.cameras.map((cam) => (
                <CameraRow
                  key={cam.id}
                  camera={cam}
                  draftLabels={draftLabels}
                  onUpdate={(patch) => updateCamera(cam.id, patch)}
                  onDelete={() => deleteCamera(cam.id)}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <UiButton variant="muted" onClick={onClose}>
            {t('common.close')}
          </UiButton>
        </div>
      </div>
    </UiModal>
  );
}

/* ---- sub-components with local state for text inputs ---- */

function CharacterRow({
  character,
  draftNames,
  onUpdate,
  onDelete,
  t,
}: {
  character: SceneMarkerCharacter;
  draftNames: React.MutableRefObject<Record<string, string>>;
  onUpdate: (patch: Partial<SceneMarkerCharacter>) => void;
  onDelete: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-bg-secondary/40 p-2">
      <input
        className="h-7 w-24 rounded border border-border bg-bg px-2 text-xs text-text outline-none focus:border-primary"
        placeholder={t('node.sceneMarkerEditor.characterNamePlaceholder')}
        defaultValue={character.name}
        onChange={(e) => {
          draftNames.current[character.id] = e.target.value;
        }}
        onBlur={(e) => {
          const val = e.target.value.trim();
          if (val && val !== character.name) onUpdate({ name: val });
          delete draftNames.current[character.id];
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <select
        className="h-7 rounded border border-border bg-bg px-1 text-xs text-text outline-none focus:border-primary"
        value={character.horizontal}
        onChange={(e) => onUpdate({ horizontal: e.target.value as HorizontalPosition })}
      >
        {HORIZONTAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
        ))}
      </select>
      <select
        className="h-7 rounded border border-border bg-bg px-1 text-xs text-text outline-none focus:border-primary"
        value={character.vertical}
        onChange={(e) => onUpdate({ vertical: e.target.value as VerticalPosition })}
      >
        {VERTICAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
        ))}
      </select>
      <select
        className="h-7 rounded border border-border bg-bg px-1 text-xs text-text outline-none focus:border-primary"
        value={character.shotScale}
        onChange={(e) => onUpdate({ shotScale: e.target.value as ShotScale })}
      >
        {SHOT_SCALE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
        ))}
      </select>
      <button
        className="ml-auto text-xs text-danger hover:text-danger-hover"
        onClick={onDelete}
      >
        {t('common.delete')}
      </button>
    </div>
  );
}

function CameraRow({
  camera,
  draftLabels,
  onUpdate,
  onDelete,
  t,
}: {
  camera: SceneMarkerCamera;
  draftLabels: React.MutableRefObject<Record<string, string>>;
  onUpdate: (patch: Partial<SceneMarkerCamera>) => void;
  onDelete: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-bg-secondary/40 p-2">
      <input
        className="h-7 w-24 rounded border border-border bg-bg px-2 text-xs text-text outline-none focus:border-primary"
        placeholder={t('node.sceneMarkerEditor.cameraLabelPlaceholder')}
        defaultValue={camera.label}
        onChange={(e) => {
          draftLabels.current[camera.id] = e.target.value;
        }}
        onBlur={(e) => {
          const val = e.target.value.trim();
          if (val && val !== camera.label) onUpdate({ label: val });
          delete draftLabels.current[camera.id];
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <select
        className="h-7 rounded border border-border bg-bg px-1 text-xs text-text outline-none focus:border-primary"
        value={camera.direction}
        onChange={(e) => onUpdate({ direction: e.target.value as HorizontalPosition })}
      >
        {CAMERA_DIRECTION_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
        ))}
      </select>
      <select
        className="h-7 rounded border border-border bg-bg px-1 text-xs text-text outline-none focus:border-primary"
        value={camera.angle}
        onChange={(e) => onUpdate({ angle: e.target.value as CameraAngle })}
      >
        {CAMERA_ANGLE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
        ))}
      </select>
      <button
        className="ml-auto text-xs text-danger hover:text-danger-hover"
        onClick={onDelete}
      >
        {t('common.delete')}
      </button>
    </div>
  );
}
