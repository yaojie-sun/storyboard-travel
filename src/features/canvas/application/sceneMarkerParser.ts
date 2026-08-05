import type { SceneMarker, HorizontalPosition, VerticalPosition, ShotScale, CameraAngle } from '../domain/sceneMarker';

const SCENE_MARKER_TOKEN_REGEX = /@([一-龥a-zA-Z0-9_]+)/g;

export interface SceneMarkerToken {
  start: number;
  end: number;
  markerName: string;
  marker: SceneMarker;
}

export function findSceneMarkerTokens(
  text: string,
  markers: SceneMarker[] | undefined,
): SceneMarkerToken[] {
  if (!markers || markers.length === 0) return [];

  const nameToMarker = new Map(markers.map((m) => [m.name, m]));
  const tokens: SceneMarkerToken[] = [];
  let match: RegExpExecArray | null;

  SCENE_MARKER_TOKEN_REGEX.lastIndex = 0;
  while ((match = SCENE_MARKER_TOKEN_REGEX.exec(text)) !== null) {
    const markerName = match[1];
    const marker = nameToMarker.get(markerName);
    if (marker) {
      tokens.push({
        start: match.index,
        end: match.index + match[0].length,
        markerName,
        marker,
      });
    }
  }
  return tokens;
}

const HORIZONTAL_LABELS: Record<HorizontalPosition, string> = {
  left: '画面左侧',
  center: '画面中间',
  right: '画面右侧',
};

const VERTICAL_LABELS: Record<VerticalPosition, string> = {
  top: '上方',
  center: '',
  bottom: '下方',
};

const SHOT_SCALE_LABELS: Record<ShotScale, string> = {
  close: '近景',
  medium: '中景',
  full: '远景',
};

const CAMERA_DIRECTION_LABELS: Record<HorizontalPosition, string> = {
  left: '偏左',
  center: '正中',
  right: '偏右',
};

const CAMERA_ANGLE_LABELS: Record<CameraAngle, string> = {
  level: '平拍',
  high: '俯拍',
  low: '仰拍',
};

function describeCharacter(name: string, horizontal: HorizontalPosition, vertical: VerticalPosition, shotScale: ShotScale): string {
  const h = HORIZONTAL_LABELS[horizontal];
  const v = VERTICAL_LABELS[vertical];
  const s = SHOT_SCALE_LABELS[shotScale];
  return `${name}在${h}${v}${s}`;
}

function describeCamera(label: string, direction: HorizontalPosition, angle: CameraAngle): string {
  return `${label}镜头${CAMERA_DIRECTION_LABELS[direction]}，${CAMERA_ANGLE_LABELS[angle]}`;
}

function expandSceneMarkerDescription(marker: SceneMarker): string {
  const parts: string[] = [];

  if (marker.characters.length > 0) {
    parts.push(
      marker.characters.map((c) => describeCharacter(c.name, c.horizontal, c.vertical, c.shotScale)).join('，'),
    );
  }

  if (marker.cameras.length > 0) {
    parts.push(marker.cameras.map((c) => describeCamera(c.label, c.direction, c.angle)).join('，'));
  }

  return parts.join('；');
}

export function expandSceneMarkersInText(
  text: string,
  markers: SceneMarker[] | undefined,
): string {
  if (!markers || markers.length === 0) return text;

  const tokens = findSceneMarkerTokens(text, markers);
  if (tokens.length === 0) return text;

  const sorted = [...tokens].sort((a, b) => b.start - a.start);
  let result = text;
  for (const token of sorted) {
    const expansion = expandSceneMarkerDescription(token.marker);
    result = result.slice(0, token.start) + expansion + result.slice(token.end);
  }

  return result;
}
