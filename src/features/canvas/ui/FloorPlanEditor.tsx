import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { save } from '@tauri-apps/plugin-dialog';
import type { FloorPosition, SceneMarker, MovementArrow } from '@/features/canvas/domain/sceneMarker';
import { getPropSize } from '@/features/canvas/domain/sceneMarker';
import { generateTopDownPositioningMapDataUrl, resolveCharacterFloorPosition } from '@/features/canvas/application/topDownMapRenderer';
import { persistImageSource, saveImageSourceToPath } from '@/commands/image';
import { Trash2, RotateCw, Download, Undo2 } from 'lucide-react';

export { resolveCharacterFloorPosition };

interface FloorPlanEditorProps {
  marker: SceneMarker;
  onMarkerChange: (updated: SceneMarker) => void;
  /** Called after export: persisted image path + marker name, so parent can create a reference node */
  onImagePersisted?: (imagePath: string, markerName: string) => void;
}

type DragTarget =
  | { kind: 'character'; id: string }
  | { kind: 'prop'; id: string }
  | { kind: 'camera'; id: string }
  | { kind: 'arrow'; id: string };

const GRID_COLOR = 'rgba(255,255,255,0.08)';

function toPercent(fp: FloorPosition): { left: string; top: string } {
  const scale = 1 - 2 * PADDING_RATIO;
  return {
    left: `${((PADDING_RATIO + fp.x * scale) * 100).toFixed(1)}%`,
    top: `${((PADDING_RATIO + fp.y * scale) * 100).toFixed(1)}%`,
  };
}

// --- Top-down view shape renderers for props ---

function TopDownShape({ name, colorHex, widthPx, heightPx, selected }: {
  name: string; colorHex: string; widthPx: number; heightPx: number; selected: boolean;
}) {
  const w = widthPx;
  const h = heightPx;
  const stroke = selected ? '#fff' : 'rgba(255,255,255,0.5)';
  const sw = selected ? 2 : 1;

  switch (name) {
    case '桌子':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 40 40">
          <rect x="2" y="2" width="36" height="36" rx="3" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <circle cx="8" cy="8" r="2.5" fill="rgba(255,255,255,0.3)" /><circle cx="32" cy="8" r="2.5" fill="rgba(255,255,255,0.3)" />
          <circle cx="8" cy="32" r="2.5" fill="rgba(255,255,255,0.3)" /><circle cx="32" cy="32" r="2.5" fill="rgba(255,255,255,0.3)" />
        </svg>
      );
    case '椅子':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="2" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <rect x="9" y="16" width="6" height="3" rx="0.5" fill="rgba(255,255,255,0.3)" />
        </svg>
      );
    case '沙发':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 60 30">
          <rect x="2" y="2" width="56" height="26" rx="4" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <rect x="4" y="4" width="16" height="22" rx="2" fill="rgba(255,255,255,0.2)" />
          <rect x="22" y="4" width="16" height="22" rx="2" fill="rgba(255,255,255,0.2)" />
          <rect x="40" y="4" width="16" height="22" rx="2" fill="rgba(255,255,255,0.2)" />
        </svg>
      );
    case '床':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 50 36">
          <rect x="2" y="2" width="46" height="32" rx="4" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <rect x="4" y="4" width="42" height="20" rx="2" fill="rgba(255,255,255,0.25)" />
          <rect x="4" y="26" width="42" height="8" rx="2" fill="rgba(255,255,255,0.15)" />
        </svg>
      );
    case '门':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 12 30">
          <rect x="1" y="1" width="10" height="28" rx="1" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
        </svg>
      );
    case '窗户':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 30 10">
          <rect x="1" y="1" width="28" height="8" rx="1" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.7" />
          <line x1="15" y1="1" x2="15" y2="9" stroke="rgba(255,255,255,0.5)" strokeWidth="1" />
        </svg>
      );
    case '汽车':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 44 24">
          <rect x="2" y="4" width="40" height="16" rx="5" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <circle cx="12" cy="21" r="3" fill="#333" /><circle cx="32" cy="21" r="3" fill="#333" />
        </svg>
      );
    case '路灯':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="6" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <circle cx="8" cy="8" r="3" fill="rgba(255,255,255,0.5)" />
        </svg>
      );
    case '树':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 20 20">
          <circle cx="10" cy="8" r="7" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <circle cx="10" cy="9" r="4" fill="rgba(255,255,255,0.2)" />
        </svg>
      );
    case '书柜':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 30 16">
          <rect x="1" y="1" width="28" height="14" rx="2" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <line x1="1" y1="5" x2="29" y2="5" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
          <line x1="1" y1="9" x2="29" y2="9" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
          <line x1="10" y1="1" x2="10" y2="15" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
          <line x1="20" y1="1" x2="20" y2="15" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        </svg>
      );
    case '电视':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 30 14">
          <rect x="1" y="1" width="28" height="10" rx="2" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <rect x="3" y="2" width="24" height="8" rx="1" fill="rgba(255,255,255,0.15)" />
        </svg>
      );
    case '电脑':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 20 20">
          <rect x="2" y="2" width="16" height="12" rx="2" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <rect x="4" y="4" width="12" height="8" rx="0.5" fill="rgba(255,255,255,0.15)" />
        </svg>
      );
    case '茶几':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 40 24">
          <rect x="2" y="6" width="36" height="12" rx="2" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
          <line x1="10" y1="2" x2="10" y2="6" stroke={colorHex} strokeWidth="2" opacity="0.7" />
          <line x1="30" y1="2" x2="30" y2="6" stroke={colorHex} strokeWidth="2" opacity="0.7" />
          <line x1="10" y1="18" x2="10" y2="22" stroke={colorHex} strokeWidth="2" opacity="0.7" />
          <line x1="30" y1="18" x2="30" y2="22" stroke={colorHex} strokeWidth="2" opacity="0.7" />
        </svg>
      );
    case '道路':
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 50 14">
          <rect x="0" y="3" width="50" height="8" rx="1" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.7" />
          <line x1="10" y1="1" x2="20" y2="13" stroke="rgba(255,255,255,0.4)" strokeWidth="1" strokeDasharray="3,4" />
          <line x1="30" y1="1" x2="40" y2="13" stroke="rgba(255,255,255,0.4)" strokeWidth="1" strokeDasharray="3,4" />
        </svg>
      );
    default:
      return (
        <svg width={w} height={h} preserveAspectRatio="none" viewBox="0 0 20 20">
          <rect x="2" y="2" width="16" height="16" rx="2" fill={colorHex} stroke={stroke} strokeWidth={sw} opacity="0.85" />
        </svg>
      );
  }
}

// IME-safe input for Chinese/Japanese text entry
function ArrowLabelInput({
  arrow,
  markerRef,
  onChangeRef,
}: {
  arrow: MovementArrow;
  markerRef: MutableRefObject<SceneMarker>;
  onChangeRef: MutableRefObject<(updated: SceneMarker) => void>;
}) {
  const [value, setValue] = useState(arrow.label);
  const composingRef = useRef(false);
  const arrowIdRef = useRef(arrow.id);
  arrowIdRef.current = arrow.id;

  // Sync external label change (e.g. from undo or another input)
  useEffect(() => {
    if (!composingRef.current) {
      setValue(arrow.label);
    }
  }, [arrow.label]);

  const commit = (finalValue: string) => {
    const m = markerRef.current;
    const trimmed = finalValue.trim();
    onChangeRef.current({
      ...m,
      movementArrows: (m.movementArrows ?? []).map((a) =>
        a.id === arrowIdRef.current ? { ...a, label: trimmed || '动线' } : a,
      ),
    });
  };

  return (
    <input
      className="bg-black/80 text-white text-[13px] px-1.5 py-0.5 rounded border border-white/30 text-center outline-none min-w-[50px]"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        if (!composingRef.current) {
          const m = markerRef.current;
          onChangeRef.current({
            ...m,
            movementArrows: (m.movementArrows ?? []).map((a) =>
              a.id === arrowIdRef.current ? { ...a, label: e.target.value || '动线' } : a,
            ),
          });
        }
      }}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        const finalValue = (e.target as HTMLInputElement).value;
        setValue(finalValue);
        commit(finalValue);
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setValue(arrow.label);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.target.select()}
    />
  );
}

// Inline-editable camera label with IME support
function CameraLabelInput({
  cam,
  markerRef,
  onChangeRef,
}: {
  cam: { id: string; label: string };
  markerRef: MutableRefObject<SceneMarker>;
  onChangeRef: MutableRefObject<(updated: SceneMarker) => void>;
}) {
  const [value, setValue] = useState(cam.label);
  const composingRef = useRef(false);
  const camIdRef = useRef(cam.id);
  camIdRef.current = cam.id;

  useEffect(() => {
    if (!composingRef.current) setValue(cam.label);
  }, [cam.label]);

  const commit = (finalValue: string) => {
    const m = markerRef.current;
    const trimmed = finalValue.trim();
    onChangeRef.current({
      ...m,
      cameras: m.cameras.map((c) =>
        c.id === camIdRef.current ? { ...c, label: trimmed || '机位' } : c,
      ),
    });
  };

  return (
    <input
      className="bg-black/80 text-white text-[11px] px-1 py-0.5 rounded border border-white/30 text-center outline-none min-w-[36px] mt-0.5"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        if (!composingRef.current) {
          const m = markerRef.current;
          onChangeRef.current({
            ...m,
            cameras: m.cameras.map((c) =>
              c.id === camIdRef.current ? { ...c, label: e.target.value || '机位' } : c,
            ),
          });
        }
      }}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        const finalValue = (e.target as HTMLInputElement).value;
        setValue(finalValue);
        commit(finalValue);
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setValue(cam.label);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.target.select()}
    />
  );
}

const PADDING_RATIO = 0.08; // must match topDownMapRenderer.ts
const CHARACTER_HEAD_FACTOR = 0.028;
const CAMERA_BODY_FACTOR = 0.02;

export function FloorPlanEditor({ marker, onMarkerChange, onImagePersisted }: FloorPlanEditorProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<DragTarget | null>(null);
  const [undoStack, setUndoStack] = useState<SceneMarker[]>([]);
  const [containerSize, setContainerSize] = useState(400);
  const undoStackRef = useRef(undoStack);
  undoStackRef.current = undoStack;

  // Reset undo stack when marker identity changes
  useEffect(() => {
    setUndoStack([]);
  }, [marker.id]);

  // Track container size for proportional element sizing (matching export renderer)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContainerSize(Math.min(rect.width, rect.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pushUndo = useCallback(() => {
    setUndoStack((prev) => {
      const snapshot = markerRef.current;
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        // Avoid duplicate entries for the same state
        if (JSON.stringify(last) === JSON.stringify(snapshot)) return prev;
      }
      return [...prev.slice(-49), snapshot];
    });
  }, []);

  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    onChangeRef.current(prev);
  }, []);

  // Ctrl+Z / Cmd+Z keyboard listener
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        // Only handle if no input/textarea is focused
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo]);

  // Refs for always-current values
  const markerRef = useRef(marker);
  markerRef.current = marker;
  const onChangeRef = useRef(onMarkerChange);
  onChangeRef.current = onMarkerChange;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onImagePersistedRef = useRef(onImagePersisted);
  onImagePersistedRef.current = onImagePersisted;
  const containerRefCopy = useRef(containerRef);
  containerRefCopy.current = containerRef;

  const getNormalizedPos = (clientX: number, clientY: number): FloorPosition | null => {
    const rect = containerRefCopy.current.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const scale = 1 - 2 * PADDING_RATIO;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, (fx - PADDING_RATIO) / scale)),
      y: Math.max(0, Math.min(1, (fy - PADDING_RATIO) / scale)),
    };
  };

  const moveItem = (target: DragTarget, fp: FloorPosition) => {
    const m = markerRef.current;
    const updated = { ...m };
    switch (target.kind) {
      case 'character':
        updated.characters = m.characters.map((c) => (c.id === target.id ? { ...c, floorPosition: fp } : c)); break;
      case 'prop':
        updated.props = m.props.map((p) => (p.id === target.id ? { ...p, floorPosition: fp } : p)); break;
      case 'camera':
        updated.cameras = m.cameras.map((c) => (c.id === target.id ? { ...c, floorPosition: fp } : c)); break;
    }
    onChangeRef.current(updated);
  };

  const resizeProp = (propId: string, newWidth?: number, newHeight?: number) => {
    const m = markerRef.current;
    onChangeRef.current({
      ...m,
      props: m.props.map((p) => {
        if (p.id !== propId) return p;
        const cur = getPropSize(p);
        return {
          ...p,
          width: newWidth != null ? Math.max(0.005, Math.min(0.95, newWidth)) : cur.width,
          height: newHeight != null ? Math.max(0.005, Math.min(0.95, newHeight)) : cur.height,
        };
      }),
    });
  };

  const moveArrowPoint = (arrowId: string, endpoint: 'start' | 'end', fp: FloorPosition) => {
    const m = markerRef.current;
    const field = endpoint === 'start' ? 'startPosition' : 'endPosition';
    onChangeRef.current({
      ...m,
      movementArrows: (m.movementArrows ?? []).map((a) => (a.id === arrowId ? { ...a, [field]: fp } : a)),
    });
  };

  const rotateCamera = (camId: string, deg: number) => {
    const m = markerRef.current;
    onChangeRef.current({
      ...m,
      cameras: m.cameras.map((c) =>
        c.id === camId ? { ...c, floorOrientation: { ...(c.floorOrientation ?? { fovDeg: 60 }), rotationDeg: deg } } : c),
    });
  };

  // --- Native DOM event-based drag (fires before Tauri intercepts) ---

  const installDragRef = useRef<(el: HTMLElement, target: DragTarget) => void>();
  installDragRef.current = (el: HTMLElement, target: DragTarget) => {
    let moveInstalled = false;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      pushUndo();
      setSelected(target);

      const onMove = (ev: MouseEvent) => {
        ev.preventDefault();
        const fp = getNormalizedPos(ev.clientX, ev.clientY);
        if (fp) moveItem(target, fp);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        moveInstalled = false;
      };

      if (!moveInstalled) {
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        moveInstalled = true;
      }
    };

    el.addEventListener('mousedown', onDown);
    // Store cleanup if needed
    (el as any).__dragCleanup = () => el.removeEventListener('mousedown', onDown);
  };

  const installResizeRef = useRef<(el: HTMLElement, propId: string, axis: 'width' | 'height' | 'both') => void>();
  installResizeRef.current = (el: HTMLElement, propId: string, axis: 'width' | 'height' | 'both') => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      pushUndo();
      const startX = e.clientX;
      const startY = e.clientY;
      const prop = markerRef.current.props.find((p) => p.id === propId);
      const startSize = prop ? getPropSize(prop) : { width: 0.08, height: 0.08 };

      const onMove = (ev: MouseEvent) => {
        ev.preventDefault();
        const rectW = containerRefCopy.current.current?.getBoundingClientRect().width ?? 500;
        const rectH = containerRefCopy.current.current?.getBoundingClientRect().height ?? 500;
        const scale = 1 - 2 * PADDING_RATIO;
        const dW = (ev.clientX - startX) / rectW / scale;
        const dH = (ev.clientY - startY) / rectH / scale;
        resizeProp(
          propId,
          (axis === 'width' || axis === 'both') ? startSize.width + dW : undefined,
          (axis === 'height' || axis === 'both') ? startSize.height + dH : undefined,
        );
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    el.addEventListener('mousedown', onDown);
    (el as any).__dragCleanup = () => el.removeEventListener('mousedown', onDown);
  };

  const installRotateRef = useRef<(el: HTMLElement, camId: string) => void>();
  installRotateRef.current = (el: HTMLElement, camId: string) => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      pushUndo();
      const onMove = (ev: MouseEvent) => {
        ev.preventDefault();
        const rect = containerRefCopy.current.current?.getBoundingClientRect();
        if (!rect) return;
        const angle = Math.atan2(ev.clientY - (rect.top + rect.height / 2), ev.clientX - (rect.left + rect.width / 2)) * (180 / Math.PI);
        rotateCamera(camId, Math.round((angle + 360) % 360));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    el.addEventListener('mousedown', onDown);
    (el as any).__dragCleanup = () => el.removeEventListener('mousedown', onDown);
  };

  const installArrowPointDragRef = useRef<(el: HTMLElement, arrowId: string, endpoint: 'start' | 'end') => void>();
  installArrowPointDragRef.current = (el: HTMLElement, arrowId: string, endpoint: 'start' | 'end') => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      pushUndo();
      const onMove = (ev: MouseEvent) => {
        ev.preventDefault();
        const fp = getNormalizedPos(ev.clientX, ev.clientY);
        if (fp) moveArrowPoint(arrowId, endpoint, fp);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    el.addEventListener('mousedown', onDown);
    (el as any).__dragCleanup = () => el.removeEventListener('mousedown', onDown);
  };

  // Keyboard delete — capture phase to intercept before React Flow deletes canvas nodes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
      // Always eat Delete/Backspace to prevent React Flow from deleting canvas nodes
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const sel = selectedRef.current;
      if (!sel) return;
      const m = markerRef.current;
      const updated = { ...m };
      switch (sel.kind) {
        case 'character': updated.characters = m.characters.filter((c) => c.id !== sel.id); break;
        case 'prop': updated.props = m.props.filter((p) => p.id !== sel.id); break;
        case 'camera': updated.cameras = m.cameras.filter((c) => c.id !== sel.id); break;
        case 'arrow': updated.movementArrows = (m.movementArrows ?? []).filter((a) => a.id !== sel.id); break;
      }
      setSelected(null);
      onChangeRef.current(updated);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const handleDelete = useCallback(() => {
    const sel = selectedRef.current;
    if (!sel) return;
    pushUndo();
    const m = markerRef.current;
    const updated = { ...m };
    switch (sel.kind) {
      case 'character': updated.characters = m.characters.filter((c) => c.id !== sel.id); break;
      case 'prop': updated.props = m.props.filter((p) => p.id !== sel.id); break;
      case 'camera': updated.cameras = m.cameras.filter((c) => c.id !== sel.id); break;
      case 'arrow': updated.movementArrows = (m.movementArrows ?? []).filter((a) => a.id !== sel.id); break;
    }
    setSelected(null);
    onChangeRef.current(updated);
  }, []);

  const handleExportImage = useCallback(async () => {
    const m = markerRef.current;
    const url = generateTopDownPositioningMapDataUrl(m, {
      titlePrefix: t('node.sceneMarkerEditor.floorPlanTitlePrefix', '顶视人物场景定位参考图'),
    });
    if (!url) return;

    // Persist to reference image server (app images dir)
    let persistedPath: string | null = null;
    try {
      persistedPath = await persistImageSource(url);
    } catch (err) {
      console.error('Failed to persist floor plan:', err);
    }

    // Save locally via user-chosen path (existing behavior)
    const selectedPath = await save({
      defaultPath: `${m.name || 'floor-plan'}.jpg`,
      filters: [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }],
    });
    if (selectedPath && !Array.isArray(selectedPath)) {
      try {
        await saveImageSourceToPath(url, selectedPath);
      } catch (err) {
        console.error('Failed to export floor plan:', err);
      }
    }

    // Notify parent so it can create a reference node for @图N
    if (persistedPath) {
      onImagePersistedRef.current?.(persistedPath, m.name);
    }
  }, [t]);

  return (
    <div className="flex flex-col gap-3 h-full">
      <div
        ref={containerRef}
        className="relative w-full flex-1 rounded-lg select-none"
        style={{
          minHeight: 0,
          background: '#1a1a2e',
          backgroundImage: `linear-gradient(${GRID_COLOR} 1px, transparent 1px), linear-gradient(90deg, ${GRID_COLOR} 1px, transparent 1px)`,
          backgroundSize: '12.5% 12.5%',
          border: '1px solid rgba(255,255,255,0.1)',
        }}
        onClick={() => setSelected(null)}
      >
        <div className="absolute inset-[8%] border-2 border-dashed pointer-events-none" style={{ borderColor: 'rgba(255,255,255,0.2)' }} />

        {/* Props */}
        {marker.props.map((prop) => {
          const pos = toPercent(prop.floorPosition);
          const sel = selected?.kind === 'prop' && selected.id === prop.id;
          const sz = getPropSize(prop);
          const innerSize = containerSize * (1 - 2 * PADDING_RATIO);
          const propW = innerSize * sz.width;
          const propH = innerSize * sz.height;
          const fontSize = Math.max(12, Math.min(innerSize * 0.035, 28));
          return (
            <div
              key={prop.id}
              className="absolute flex flex-col items-center"
              style={{ left: pos.left, top: pos.top, transform: 'translate(-50%, -50%)', cursor: 'move', zIndex: sel ? 50 : 10 }}
              ref={(el) => { if (el) installDragRef.current?.(el, { kind: 'prop', id: prop.id }); }}
              onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'prop', id: prop.id }); }}
            >
              <div style={{ filter: sel ? 'drop-shadow(0 0 6px rgba(255,255,255,0.9))' : 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}>
                <TopDownShape name={prop.name} colorHex={prop.colorHex} widthPx={Math.max(8, propW)} heightPx={Math.max(8, propH)} selected={sel} />
              </div>
              {sel && (
                <>
                  <div
                    className="absolute rounded-full bg-white/20 border border-white/40 hover:bg-white/40"
                    style={{ width: 12, height: 12, right: -6, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' }}
                    ref={(el) => { if (el) installResizeRef.current?.(el, prop.id, 'width'); }}
                    onClick={(e) => e.stopPropagation()}
                    title="拖拽调整宽度"
                  />
                  <div
                    className="absolute rounded-full bg-white/20 border border-white/40 hover:bg-white/40"
                    style={{ width: 12, height: 12, bottom: 0, left: '50%', transform: 'translateX(-50%)', cursor: 'ns-resize' }}
                    ref={(el) => { if (el) installResizeRef.current?.(el, prop.id, 'height'); }}
                    onClick={(e) => e.stopPropagation()}
                    title="拖拽调整高度"
                  />
                </>
              )}
              <span className="font-semibold text-white mt-0.5 px-1 rounded-full whitespace-nowrap pointer-events-none"
                style={{ fontSize, backgroundColor: sel ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.6)' }}>
                {prop.name}
              </span>
            </div>
          );
        })}

        {/* Characters */}
        {marker.characters.map((char) => {
          const fp = char.floorPosition ?? resolveCharacterFloorPosition(char);
          const pos = toPercent(fp);
          const sel = selected?.kind === 'character' && selected.id === char.id;
          const innerSize = containerSize * (1 - 2 * PADDING_RATIO);
          const headDiameter = innerSize * CHARACTER_HEAD_FACTOR * 2;
          const bodyDiameter = headDiameter * 0.72;
          const fontSize = Math.max(12, Math.min(innerSize * 0.04, 32));
          return (
            <div
              key={char.id}
              className="absolute flex flex-col items-center"
              style={{ left: pos.left, top: pos.top, transform: 'translate(-50%, -50%)', cursor: 'move', zIndex: sel ? 50 : 20 }}
              ref={(el) => { if (el) installDragRef.current?.(el, { kind: 'character', id: char.id }); }}
              onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'character', id: char.id }); }}
            >
              <span className="font-semibold text-white mb-0.5 px-1.5 py-0.5 rounded-full whitespace-nowrap pointer-events-none"
                style={{ fontSize, backgroundColor: 'rgba(0,0,0,0.7)' }}>
                {char.name}
              </span>
              <div className="rounded-full" style={{
                width: headDiameter, height: headDiameter,
                backgroundColor: char.colorHex,
                border: sel ? '3px solid #fff' : '2px solid rgba(255,255,255,0.5)',
                boxShadow: sel ? `0 0 12px ${char.colorHex}` : `0 0 6px ${char.colorHex}60`,
              }} />
              <div className="rounded-full -mt-[2px]" style={{
                width: bodyDiameter, height: bodyDiameter,
                backgroundColor: char.colorHex,
                border: sel ? '2px solid #fff' : '1px solid rgba(255,255,255,0.4)',
              }} />
            </div>
          );
        })}

        {/* Cameras */}
        {marker.cameras.map((cam) => {
          const fp = cam.floorPosition ?? { x: 0.5, y: 0.92 };
          const pos = toPercent(fp);
          const sel = selected?.kind === 'camera' && selected.id === cam.id;
          const rotDeg = cam.floorOrientation?.rotationDeg ?? 270;
          const fovDeg = cam.floorOrientation?.fovDeg ?? 60;
          const innerSize = containerSize * (1 - 2 * PADDING_RATIO);
          const bodyDiameter = innerSize * CAMERA_BODY_FACTOR * 2;
          const coneSize = innerSize * 0.1;
          const arrowLen = innerSize * 0.085;
          const labelFontSize = Math.max(10, Math.min(innerSize * 0.03, 24));
          return (
            <div key={cam.id} className="absolute" style={{ left: pos.left, top: pos.top, transform: 'translate(-50%, -50%)', zIndex: sel ? 50 : 30 }}>
              {/* FOV cone — shows field of view, extends in the direction the camera faces */}
              {sel && (
                <svg className="absolute pointer-events-none" style={{
                  left: '50%', top: '50%', width: coneSize, height: coneSize,
                  transform: `translate(-50%, -50%) rotate(${rotDeg + 90}deg)`, opacity: 0.25,
                }} preserveAspectRatio="none" viewBox="0 0 60 60">
                  <path d={`M30,30 L${30 - Math.sin((fovDeg / 2) * Math.PI / 180) * 40},${30 - Math.cos((fovDeg / 2) * Math.PI / 180) * 40} A40,40 0 0,1 ${30 + Math.sin((fovDeg / 2) * Math.PI / 180) * 40},${30 - Math.cos((fovDeg / 2) * Math.PI / 180) * 40} Z`} fill="#FF6B35" />
                </svg>
              )}
              {/* Direction arrow — clearly shows which way the camera points */}
              {sel && (
                <div className="absolute pointer-events-none" style={{
                  left: '50%', top: '50%',
                  width: arrowLen, height: '2px',
                  background: '#FF6B35',
                  transform: `translate(0, -50%) rotate(${rotDeg}deg)`,
                  transformOrigin: 'left center',
                }}>
                  <div style={{
                    position: 'absolute', right: -5, top: -4,
                    width: 0, height: 0,
                    borderLeft: '8px solid #FF6B35',
                    borderTop: '5px solid transparent',
                    borderBottom: '5px solid transparent',
                  }} />
                </div>
              )}
              {/* Camera body */}
              <div className="flex flex-col items-center cursor-move"
                ref={(el) => { if (el) installDragRef.current?.(el, { kind: 'camera', id: cam.id }); }}
                onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'camera', id: cam.id }); }}
              >
                {/* Camera icon — always shows a camera shape */}
                <svg width={Math.max(16, bodyDiameter)} height={Math.max(16, bodyDiameter)} preserveAspectRatio="none" viewBox="0 0 24 24"
                  style={{ filter: sel ? 'drop-shadow(0 0 4px rgba(255,107,53,0.8))' : 'none' }}>
                  <rect x="2" y="5" width="14" height="14" rx="2" fill="#FF6B35" stroke="#fff" strokeWidth="1.5" />
                  <rect x="16" y="8" width="6" height="8" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.5" />
                  <circle cx="9" cy="12" r="3" fill="#fff" />
                  <circle cx="9" cy="12" r="1.5" fill="#1a1a2e" />
                </svg>
                {sel ? (
                  <CameraLabelInput
                    cam={cam}
                    markerRef={markerRef}
                    onChangeRef={onChangeRef}
                  />
                ) : (
                  <span className="font-medium text-white mt-0.5 px-1 rounded-full whitespace-nowrap pointer-events-none"
                    style={{ fontSize: labelFontSize, backgroundColor: 'rgba(0,0,0,0.6)' }}>
                    {cam.label || '📷'}
                  </span>
                )}
              </div>
              {/* Rotation handle with angle display */}
              {sel && (
                <div style={{ position: 'absolute', top: -44, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <span className="text-[10px] font-mono text-white/80 whitespace-nowrap pointer-events-none"
                    style={{ textShadow: '0 0 4px rgba(0,0,0,0.8)' }}>
                    {rotDeg}°
                  </span>
                  <div className="flex items-center justify-center rounded-full cursor-grab"
                    style={{ width: 24, height: 24,
                      backgroundColor: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)' }}
                    ref={(el) => { if (el) installRotateRef.current?.(el, cam.id); }}
                    onClick={(e) => e.stopPropagation()}
                    title="拖拽旋转摄像机朝向"
                  >
                    <RotateCw size={12} className="text-white/80 pointer-events-none" />
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Movement Arrows — SVG overlay with viewBox for consistent coordinates */}
        {(marker.movementArrows ?? []).length > 0 && (
          <svg className="absolute inset-0 pointer-events-none" preserveAspectRatio="none" viewBox="0 0 100 100" style={{ zIndex: 25, overflow: 'visible' }}>
            {(marker.movementArrows ?? []).map((arrow) => {
              const sel = selected?.kind === 'arrow' && selected?.id === arrow.id;
              const isDashed = arrow.lineStyle === 'dashed';
              const sx = arrow.startPosition.x * 100;
              const sy = arrow.startPosition.y * 100;
              const ex = arrow.endPosition.x * 100;
              const ey = arrow.endPosition.y * 100;
              const dx = arrow.endPosition.x - arrow.startPosition.x;
              const dy = arrow.endPosition.y - arrow.startPosition.y;
              const angle = Math.atan2(dy, dx);
              const headLen = 4.5;
              const ha = Math.PI / 6;
              const hx1 = ex - headLen * Math.cos(angle - ha);
              const hy1 = ey - headLen * Math.sin(angle - ha);
              const hx2 = ex - headLen * Math.cos(angle + ha);
              const hy2 = ey - headLen * Math.sin(angle + ha);
              return (
                <g key={arrow.id}>
                  {/* Wide invisible click target */}
                  <line x1={sx} y1={sy} x2={ex} y2={ey}
                    stroke="transparent" strokeWidth="3" style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                    onClick={(e) => { e.stopPropagation(); setSelected({ kind: 'arrow', id: arrow.id }); }} />
                  {/* Visible arrow line (solid or dashed) */}
                  <line x1={sx} y1={sy} x2={ex} y2={ey}
                    stroke={arrow.colorHex} strokeWidth={sel ? '0.5' : '0.35'} opacity={isDashed ? 0.6 : 0.9}
                    strokeDasharray={isDashed ? '2.5 2' : undefined}
                    style={{ pointerEvents: 'none' }} />
                  {/* Arrowhead (solid arrows only) */}
                  {!isDashed && (
                    <polygon
                      points={`${ex},${ey} ${hx1},${hy1} ${hx2},${hy2}`}
                      fill={arrow.colorHex} stroke="rgba(255,255,255,0.5)" strokeWidth="0.15" opacity={0.9}
                      style={{ pointerEvents: 'none' }} />
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {/* Movement arrow labels + handles */}
        {(marker.movementArrows ?? []).map((arrow) => {
          const sel = selected?.kind === 'arrow' && selected?.id === arrow.id;
          const sx = `${arrow.startPosition.x * 100}%`;
          const sy = `${arrow.startPosition.y * 100}%`;
          const ex = `${arrow.endPosition.x * 100}%`;
          const ey = `${arrow.endPosition.y * 100}%`;
          const mx = `${((arrow.startPosition.x + arrow.endPosition.x) / 2) * 100}%`;
          const my = `${((arrow.startPosition.y + arrow.endPosition.y) / 2) * 100}%`;
          return (
            <div key={arrow.id}>
              {/* Label on the arrow line */}
              <div className="absolute" style={{
                left: mx, top: my,
                transform: 'translate(-50%, -50%)',
                zIndex: sel ? 50 : 26,
                pointerEvents: sel ? 'auto' : 'none',
              }}>
                {sel ? (
                  <ArrowLabelInput arrow={arrow} markerRef={markerRef} onChangeRef={onChangeRef} />
                ) : (
                  <span className="text-[12px] font-bold text-white px-1.5 py-0.5 rounded-full whitespace-nowrap leading-tight"
                    style={{ backgroundColor: arrow.colorHex, boxShadow: '0 0 6px rgba(0,0,0,0.6)' }}>
                    {arrow.label || '动线'}
                  </span>
                )}
              </div>
              {/* Draggable endpoints — only when selected */}
              {sel && (
                <>
                  <div className="absolute rounded-full border-2 cursor-move"
                    style={{
                      left: sx, top: sy, width: 14, height: 14,
                      borderColor: 'rgba(255,255,255,0.8)', backgroundColor: arrow.colorHex,
                      transform: 'translate(-50%, -50%)', zIndex: 50,
                      boxShadow: '0 0 8px rgba(255,255,255,0.4)',
                    }}
                    ref={(el) => { if (el) installArrowPointDragRef.current?.(el, arrow.id, 'start'); }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="absolute rounded-full border-2 cursor-move"
                    style={{
                      left: ex, top: ey, width: 16, height: 16,
                      borderColor: '#fff', backgroundColor: arrow.colorHex,
                      transform: 'translate(-50%, -50%)', zIndex: 50,
                      boxShadow: '0 0 10px rgba(255,255,255,0.6)',
                    }}
                    ref={(el) => { if (el) installArrowPointDragRef.current?.(el, arrow.id, 'end'); }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </>
              )}
            </div>
          );
        })}

        <div className="absolute top-2 right-3 text-white/50 text-xs pointer-events-none font-mono">N ▲</div>
      </div>

      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1">
          <button
            className="flex items-center gap-1 px-2 py-1 text-xs text-white/60 hover:bg-white/10 rounded disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Ctrl+Z"
          >
            <Undo2 size={12} />
            {undoStack.length > 0 ? `(${undoStack.length})` : ''}
          </button>
          <button className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:bg-red-400/10 rounded" onClick={handleDelete}>
            <Trash2 size={12} />{t('common.delete')}
          </button>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/10 hover:bg-white/20 text-white rounded-md border border-white/10 transition-colors" onClick={handleExportImage}>
          <Download className="w-4 h-4" />{t('node.sceneMarkerEditor.exportFloorPlan', '导出图片')}
        </button>
      </div>
    </div>
  );
}
