export type HorizontalPosition = 'left' | 'center' | 'right';
export type VerticalPosition = 'top' | 'center' | 'bottom';
export type ShotScale = 'close' | 'medium' | 'full';
export type CameraAngle = 'level' | 'high' | 'low';

// Top-down floor plan coordinates (0-1 normalized)
export interface FloorPosition {
  x: number;
  y: number;
}

export interface CameraFloorOrientation {
  rotationDeg: number; // 0=right, 90=down, 180=left, 270=up
  fovDeg: number; // default 60
}

export interface SceneMarkerCharacter {
  id: string;
  name: string;
  horizontal: HorizontalPosition;
  vertical: VerticalPosition;
  shotScale: ShotScale;
  colorHex: string;
  floorPosition?: FloorPosition;
}

export interface SceneMarkerCamera {
  id: string;
  label: string;
  direction: HorizontalPosition;
  angle: CameraAngle;
  floorPosition?: FloorPosition;
  floorOrientation?: CameraFloorOrientation;
}

// Prop/item placed on the floor plan (furniture, objects, vehicles, etc.)
export interface FloorPlanProp {
  id: string;
  name: string;
  floorPosition: FloorPosition;
  colorHex: string;
  size?: number; // @deprecated — use width/height instead
  width?: number; // 0-1 relative width, default = size ?? 0.08
  height?: number; // 0-1 relative height, default = size ?? 0.08
}

export function getPropSize(prop: FloorPlanProp): { width: number; height: number } {
  const fallback = prop.size ?? 0.08;
  return {
    width: prop.width ?? fallback,
    height: prop.height ?? fallback,
  };
}

// Movement arrow showing motion paths through the scene
export interface MovementArrow {
  id: string;
  label: string;
  startPosition: FloorPosition;
  endPosition: FloorPosition;
  colorHex: string;
  lineStyle?: 'solid' | 'dashed'; // default 'solid'
}

export interface SceneMarker {
  id: string;
  name: string;
  characters: SceneMarkerCharacter[];
  cameras: SceneMarkerCamera[];
  props: FloorPlanProp[];
  movementArrows: MovementArrow[];
}

// Preset material library items
export type FloorPlanPreset = { name: string; colorHex: string; width: number; height: number };
export const FLOOR_PLAN_PRESETS: FloorPlanPreset[] = [
  { name: '桌子', colorHex: '#8B7355', width: 0.14, height: 0.10 },
  { name: '椅子', colorHex: '#6B4226', width: 0.07, height: 0.09 },
  { name: '沙发', colorHex: '#4A90D9', width: 0.22, height: 0.12 },
  { name: '床', colorHex: '#E8D5B7', width: 0.24, height: 0.16 },
  { name: '门', colorHex: '#8B4513', width: 0.04, height: 0.10 },
  { name: '窗户', colorHex: '#87CEEB', width: 0.14, height: 0.04 },
  { name: '汽车', colorHex: '#DC143C', width: 0.22, height: 0.12 },
  { name: '路灯', colorHex: '#FFD700', width: 0.05, height: 0.05 },
  { name: '树', colorHex: '#228B22', width: 0.10, height: 0.12 },
  { name: '书柜', colorHex: '#8B7355', width: 0.10, height: 0.14 },
  { name: '电视', colorHex: '#2F2F2F', width: 0.12, height: 0.06 },
  { name: '电脑', colorHex: '#333333', width: 0.08, height: 0.06 },
  { name: '茶几', colorHex: '#A0522D', width: 0.12, height: 0.06 },
  { name: '道路', colorHex: '#808080', width: 0.30, height: 0.08 },
  { name: '动线', colorHex: '#FF4444', width: 0.15, height: 0.02 },
  { name: '轴线', colorHex: '#FFFFFF', width: 0.15, height: 0.02 },
];
