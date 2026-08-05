import type { FloorPosition, SceneMarker, SceneMarkerCharacter } from '@/features/canvas/domain/sceneMarker';
import { getPropSize } from '@/features/canvas/domain/sceneMarker';

const DEFAULT_SIZE = 1536;
const PADDING_RATIO = 0.08;
const BACKGROUND_COLOR = '#1a1a2e';
const GRID_COLOR = 'rgba(255,255,255,0.08)';
const BOUNDARY_COLOR = 'rgba(255,255,255,0.3)';
const CAMERA_COLOR = '#FF6B35';
const SCALE_COLOR = 'rgba(255,255,255,0.55)';

export function resolveCharacterFloorPosition(character: SceneMarkerCharacter): FloorPosition {
  if (character.floorPosition) return character.floorPosition;
  const hMap: Record<string, number> = { left: 0.2, center: 0.5, right: 0.8 };
  const vMap: Record<string, number> = { top: 0.2, center: 0.5, bottom: 0.8 };
  return { x: hMap[character.horizontal] ?? 0.5, y: vMap[character.vertical] ?? 0.5 };
}

function resolveCameraFloorPosition(camera: { direction: string; floorPosition?: FloorPosition }): FloorPosition {
  if (camera.floorPosition) return camera.floorPosition;
  const xMap: Record<string, number> = { left: 0.3, center: 0.5, right: 0.7 };
  return { x: xMap[camera.direction] ?? 0.5, y: 0.92 };
}

function resolveCameraOrientation(camera: {
  direction: string;
  floorOrientation?: { rotationDeg: number; fovDeg: number };
}): { rotationDeg: number; fovDeg: number } {
  if (camera.floorOrientation) return camera.floorOrientation;
  const rotMap: Record<string, number> = { left: 300, center: 270, right: 240 };
  return { rotationDeg: rotMap[camera.direction] ?? 270, fovDeg: 60 };
}

interface RenderOptions {
  imageSize?: number;
  backgroundColor?: string;
  gridColor?: string;
  boundaryColor?: string;
  cameraColor?: string;
  titlePrefix?: string;
}

function drawPropShape(
  ctx: CanvasRenderingContext2D,
  name: string,
  cx: number,
  cy: number,
  propW: number,
  propH: number,
  colorHex: string,
) {
  const hw = propW / 2;
  const hh = propH / 2;
  ctx.fillStyle = colorHex;
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;

  const fillRect = (x: number, y: number, w: number, h: number, r?: number) => {
    if (r) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  };

  const dot = (dx: number, dy: number, r: number, col: string) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  switch (name) {
    case '桌子':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.08);
      dot(cx - hw + propW * 0.18, cy - hh + propH * 0.18, propW * 0.06, 'rgba(255,255,255,0.3)');
      dot(cx + hw - propW * 0.18, cy - hh + propH * 0.18, propW * 0.06, 'rgba(255,255,255,0.3)');
      dot(cx - hw + propW * 0.18, cy + hh - propH * 0.18, propW * 0.06, 'rgba(255,255,255,0.3)');
      dot(cx + hw - propW * 0.18, cy + hh - propH * 0.18, propW * 0.06, 'rgba(255,255,255,0.3)');
      break;
    case '椅子':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.1);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(cx - hw + propW * 0.35, cy + hh * 0.2, propW * 0.3, propH * 0.15);
      break;
    case '沙发':
      fillRect(cx - hw, cy - hh, propW, propH, propH * 0.15);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(cx - hw + propW * 0.06, cy - hh + propH * 0.1, propW * 0.26, propH * 0.8);
      ctx.fillRect(cx - propW * 0.13, cy - hh + propH * 0.1, propW * 0.26, propH * 0.8);
      ctx.fillRect(cx + propW * 0.07, cy - hh + propH * 0.1, propW * 0.26, propH * 0.8);
      break;
    case '床':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.08);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(cx - hw + propW * 0.1, cy - hh + propH * 0.12, propW * 0.8, propH * 0.55);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(cx - hw + propW * 0.1, cy + hh * 0.1, propW * 0.8, propH * 0.3);
      break;
    case '门':
      fillRect(cx - propW * 0.15, cy - hh, propW * 0.3, propH, propW * 0.08);
      break;
    case '窗户':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.08);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - hh);
      ctx.lineTo(cx, cy + hh);
      ctx.stroke();
      break;
    case '汽车':
      fillRect(cx - hw, cy - hh * 0.5, propW, propH * 0.8, propH * 0.25);
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.arc(cx - propW * 0.22, cy + propH * 0.3, propH * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + propW * 0.22, cy + propH * 0.3, propH * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case '路灯':
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(hw, hh), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(hw, hh) * 0.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case '树':
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(hw, hh), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(hw, hh) * 0.55, 0, Math.PI * 2);
      ctx.fill();
      break;
    case '书柜':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.06);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.5;
      for (let ly = cy - hh + propH * 0.2; ly < cy + hh; ly += propH * 0.2) {
        ctx.beginPath();
        ctx.moveTo(cx - hw, ly);
        ctx.lineTo(cx + hw, ly);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - propW * 0.15, cy - hh);
      ctx.lineTo(cx - propW * 0.15, cy + hh);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + propW * 0.1, cy - hh);
      ctx.lineTo(cx + propW * 0.1, cy + hh);
      ctx.stroke();
      break;
    case '电视':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.06);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(cx - hw + propW * 0.06, cy - hh + propH * 0.2, propW * 0.88, propH * 0.6);
      break;
    case '电脑':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.08);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(cx - hw + propW * 0.12, cy - hh + propH * 0.1, propW * 0.76, propH * 0.65);
      break;
    case '茶几':
      fillRect(cx - hw, cy - hh * 0.6, propW, propH * 0.6, propW * 0.06);
      [cx - propW * 0.35, cx + propW * 0.35].forEach((lx) => {
        ctx.strokeStyle = colorHex;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(lx, cy - hh * 0.7);
        ctx.lineTo(lx, cy - hh * 1.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(lx, cy + hh * 0.7);
        ctx.lineTo(lx, cy + hh * 1.5);
        ctx.stroke();
      });
      break;
    case '道路':
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.04);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([propW * 0.2, propW * 0.3]);
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.6, cy - hh * 0.4);
      ctx.lineTo(cx + hw * 0.2, cy + hh * 0.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + hw * 0.4, cy - hh * 0.4);
      ctx.lineTo(cx + hw * 0.8, cy + hh * 0.4);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    default:
      fillRect(cx - hw, cy - hh, propW, propH, propW * 0.08);
      break;
  }

  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
}

const CAM_DIRECTION_LABELS: Record<string, string> = {
  left: '拍摄方向: 左',
  center: '拍摄方向: 中',
  right: '拍摄方向: 右',
};
const CAM_ANGLE_LABELS: Record<string, string> = {
  level: '角度: 平视',
  high: '角度: 俯视',
  low: '角度: 仰视',
};

export function generateTopDownPositioningMapDataUrl(
  marker: SceneMarker,
  options?: RenderOptions,
): string | null {
  const { characters, cameras, props, movementArrows = [] } = marker;
  if (characters.length === 0 && cameras.length === 0 && props.length === 0 && movementArrows.length === 0) return null;

  const size = options?.imageSize ?? DEFAULT_SIZE;
  const bg = options?.backgroundColor ?? BACKGROUND_COLOR;
  const gridColor = options?.gridColor ?? GRID_COLOR;
  const boundary = options?.boundaryColor ?? BOUNDARY_COLOR;
  const camColor = options?.cameraColor ?? CAMERA_COLOR;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const pad = size * PADDING_RATIO;
  const innerSize = size - pad * 2;

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // Grid (8 x 8) with coordinate labels
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1.2;
  const gridCols = 8;
  const gridRows = 8;
  const gridSpacing = innerSize / gridCols;
  for (let i = 0; i <= gridCols; i++) {
    const pos = pad + i * gridSpacing;
    ctx.beginPath();
    ctx.moveTo(pos, pad);
    ctx.lineTo(pos, pad + innerSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pad, pos);
    ctx.lineTo(pad + innerSize, pos);
    ctx.stroke();
  }

  // Grid coordinate labels — columns 1-8 (top & bottom), rows A-H (left & right)
  const labelFontSize = Math.min(innerSize * 0.018, 14);
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.font = `600 ${labelFontSize}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const topLabelY = pad - gridSpacing * 0.14;
  const bottomLabelY = pad + innerSize + gridSpacing * 0.14;
  for (let i = 0; i < gridCols; i++) {
    const cx = pad + (i + 0.5) * gridSpacing;
    ctx.fillText(`${i + 1}`, cx, topLabelY);
    ctx.fillText(`${i + 1}`, cx, bottomLabelY);
  }
  ctx.textAlign = 'right';
  const rowLabels = 'ABCDEFGH'.split('');
  const leftLabelX = pad - gridSpacing * 0.08;
  const rightLabelX = pad + innerSize + gridSpacing * 0.16;
  for (let i = 0; i < gridRows; i++) {
    const cy = pad + (i + 0.5) * gridSpacing;
    ctx.fillText(rowLabels[i], leftLabelX, cy);
    ctx.fillText(rowLabels[i], rightLabelX, cy);
  }

  // Scene boundary
  ctx.strokeStyle = boundary;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([10, 5]);
  ctx.strokeRect(pad, pad, innerSize, innerSize);
  ctx.setLineDash([]);

  // Mapping helper
  const toCanvas = (fp: FloorPosition): { cx: number; cy: number } => ({
    cx: pad + fp.x * innerSize,
    cy: pad + fp.y * innerSize,
  });

  // Draw cameras (with direction + angle annotations)
  for (const camera of cameras) {
    const pos = resolveCameraFloorPosition(camera);
    const { cx, cy } = toCanvas(pos);
    const orient = resolveCameraOrientation(camera);
    const rad = (orient.rotationDeg * Math.PI) / 180;
    const halfFov = (orient.fovDeg / 2) * (Math.PI / 180);

    // FOV cone
    const coneLen = innerSize * 0.15;
    ctx.fillStyle = 'rgba(255, 107, 53, 0.14)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad - halfFov) * coneLen, cy + Math.sin(rad - halfFov) * coneLen);
    ctx.lineTo(cx + Math.cos(rad + halfFov) * coneLen, cy + Math.sin(rad + halfFov) * coneLen);
    ctx.closePath();
    ctx.fill();

    // Direction arrow
    const arrowLen = innerSize * 0.1;
    ctx.strokeStyle = camColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * arrowLen, cy + Math.sin(rad) * arrowLen);
    ctx.stroke();
    // Arrowhead
    const tipX = cx + Math.cos(rad) * arrowLen;
    const tipY = cy + Math.sin(rad) * arrowLen;
    ctx.fillStyle = camColor;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.cos(rad - 0.6) * 10, tipY - Math.sin(rad - 0.6) * 10);
    ctx.lineTo(tipX - Math.cos(rad + 0.6) * 10, tipY - Math.sin(rad + 0.6) * 10);
    ctx.closePath();
    ctx.fill();

    // Camera body
    const camBodyRadius = innerSize * 0.02;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = camColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, camBodyRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Camera label + direction + angle below body
    const camLabelFontSize = innerSize * 0.035;
    const camMetaFontSize = innerSize * 0.025;
    const labelY0 = cy + camBodyRadius + innerSize * 0.032;
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${camLabelFontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(camera.label || '📷', cx, labelY0);

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `${camMetaFontSize}px sans-serif`;
    ctx.fillText(`${orient.rotationDeg}°`, cx, labelY0 + camLabelFontSize + 4);

    const dirLabel = CAM_DIRECTION_LABELS[camera.direction];
    const angLabel = CAM_ANGLE_LABELS[camera.angle];
    if (dirLabel) {
      ctx.fillText(dirLabel, cx, labelY0 + camLabelFontSize + camMetaFontSize + 10);
    }
    if (angLabel) {
      ctx.fillText(angLabel, cx, labelY0 + camLabelFontSize + camMetaFontSize * 2 + 14);
    }
  }

  // Draw props
  for (const prop of props) {
    const { cx, cy } = toCanvas(prop.floorPosition);
    const sz = getPropSize(prop);
	    const propW = innerSize * sz.width;
	    const propH = innerSize * sz.height;
    drawPropShape(ctx, prop.name, cx, cy, propW, propH, prop.colorHex);

    // Prop label below shape
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.min(innerSize * 0.035, 28)}px sans-serif`;
    ctx.textAlign = 'center';
    const propLabelY = cy + propH / 2 + Math.min(innerSize * 0.035, 28) + 6;
    ctx.fillText(prop.name, cx, propLabelY);
  }

  // Draw movement arrows
  for (const arrow of marker.movementArrows) {
    const start = toCanvas(arrow.startPosition);
    const end = toCanvas(arrow.endPosition);
    const dx = end.cx - start.cx;
    const dy = end.cy - start.cy;
    const angle = Math.atan2(dy, dx);
    const arrowSize = innerSize * 0.013;

    // Arrow shaft
    const isDashed = arrow.lineStyle === 'dashed';
    ctx.strokeStyle = arrow.colorHex;
    ctx.lineWidth = isDashed ? 2 : 3.5;
    if (isDashed) ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(start.cx, start.cy);
    ctx.lineTo(end.cx, end.cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead (solid only)
    if (!isDashed) {
      const headLen = innerSize * 0.04;
      const headAngle = Math.PI / 7;
      ctx.fillStyle = arrow.colorHex;
      ctx.beginPath();
      ctx.moveTo(end.cx, end.cy);
      ctx.lineTo(
        end.cx - headLen * Math.cos(angle - headAngle),
        end.cy - headLen * Math.sin(angle - headAngle),
      );
      ctx.lineTo(
        end.cx - headLen * Math.cos(angle + headAngle),
        end.cy - headLen * Math.sin(angle + headAngle),
      );
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Start dot
    ctx.fillStyle = arrow.colorHex;
    ctx.beginPath();
    ctx.arc(start.cx, start.cy, arrowSize, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // End dot
    ctx.fillStyle = arrow.colorHex;
    ctx.beginPath();
    ctx.arc(end.cx, end.cy, isDashed ? arrowSize : arrowSize * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isDashed ? 'rgba(255,255,255,0.7)' : '#fff';
    ctx.lineWidth = isDashed ? 1.5 : 2;
    ctx.stroke();

    // Label at midpoint with background pill
    const midX = (start.cx + end.cx) / 2;
    const midY = (start.cy + end.cy) / 2;
    const arrowLabelFontSize = Math.min(innerSize * 0.04, 30);
    ctx.font = `700 ${arrowLabelFontSize}px sans-serif`;
    ctx.textAlign = 'center';
    const labelWidth = ctx.measureText(arrow.label).width;
    const labelPad = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    const pillH = arrowLabelFontSize + 10;
    ctx.roundRect(
      midX - labelWidth / 2 - labelPad,
      midY - pillH - 5,
      labelWidth + labelPad * 2,
      pillH,
      pillH / 2,
    );
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'bottom';
    ctx.fillText(arrow.label, midX, midY - 10);
  }

  // Draw characters (two stacked circles: head + body)
  for (const character of characters) {
    const fp = resolveCharacterFloorPosition(character);
    const { cx, cy } = toCanvas(fp);
    const headRadius = innerSize * 0.028;
    const bodyRadius = headRadius * 0.72;
    const fontSize = Math.min(innerSize * 0.04, 32);
    ctx.font = `700 ${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(character.name).width;
    const pillPad = 8;
    const pillH = fontSize + pillPad;
    const labelY = cy - headRadius - fontSize - 8;

    // Background pill behind text
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath();
    ctx.roundRect(
      cx - textWidth / 2 - pillPad,
      labelY - fontSize / 2 - pillPad / 2,
      textWidth + pillPad * 2,
      pillH,
      pillH / 2,
    );
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(character.name, cx, labelY);

    // Glow
    ctx.fillStyle = character.colorHex + '40';
    ctx.beginPath();
    ctx.arc(cx, cy, headRadius * 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Head
    ctx.fillStyle = character.colorHex;
    ctx.beginPath();
    ctx.arc(cx, cy, headRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Body
    const bodyCy = cy + headRadius + bodyRadius - 2;
    ctx.fillStyle = character.colorHex;
    ctx.beginPath();
    ctx.arc(cx, bodyCy, bodyRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }


  // ── Title + subtitle ABOVE grid (top-left), all within top padding ──
  const title = options?.titlePrefix ? `${options.titlePrefix}-${marker.name}` : marker.name;
  const topTitleSize = Math.min(innerSize * 0.034, 30);
  const topSubSize = Math.min(innerSize * 0.02, 16);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${topTitleSize}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(title, pad, pad - topSubSize - 14);

  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `${topSubSize}px sans-serif`;
  ctx.fillText('彩色双圈=人物 | 白圆橙箭头=机位 | 俯视图标=素材 | 红色箭头=动线 | 白色虚线=轴线', pad, pad - 8);

  // North indicator (top-right corner)
  const northX = pad + innerSize - 20;
  const northY = pad - topSubSize - 16;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `700 ${innerSize * 0.024}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N ▲', northX, northY);

  // ── Bottom bar: compact horizontal legend + scale (all within bottom padding) ──
  const bottomY = pad + innerSize + innerSize * 0.025;
  const bottomFontSize = Math.min(innerSize * 0.017, 14);
  ctx.textBaseline = 'middle';

  type LegendItem = { draw: (x: number, y: number) => void; label: string };
  const legendItems: LegendItem[] = [];

  if (characters.length > 0) {
    legendItems.push({
      draw(x, y) {
        ctx.fillStyle = '#FF6B6B';
        ctx.beginPath(); ctx.arc(x + 5, y - 1, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(x + 5, y + 5 + 3 - 1, 3, 0, Math.PI * 2); ctx.fill();
      },
      label: '人物',
    });
  }
  if (cameras.length > 0) {
    legendItems.push({
      draw(x, y) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = CAMERA_COLOR; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.arc(x + 5, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = CAMERA_COLOR; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(x + 5, y); ctx.lineTo(x + 5, y - 7); ctx.stroke();
        ctx.fillStyle = CAMERA_COLOR;
        ctx.beginPath(); ctx.moveTo(x + 5, y - 7); ctx.lineTo(x + 2, y - 4); ctx.lineTo(x + 8, y - 4); ctx.fill();
      },
      label: '机位',
    });
  }
  if (props.length > 0) {
    legendItems.push({
      draw(x, y) {
        ctx.fillStyle = '#8B7355';
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.roundRect(x, y - 5, 12, 10, 1.5); ctx.fill(); ctx.stroke();
      },
      label: '素材',
    });
  }
  if (movementArrows.length > 0) {
    legendItems.push({
      draw(x, y) {
        ctx.strokeStyle = '#FF4444'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 14, y); ctx.stroke();
        ctx.fillStyle = '#FF4444';
        ctx.beginPath(); ctx.moveTo(x + 14, y); ctx.lineTo(x + 10, y - 3); ctx.lineTo(x + 10, y + 3); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      },
      label: '动线',
    });
  }
  if (movementArrows.some((a) => a.lineStyle === 'dashed')) {
    legendItems.push({
      draw(x, y) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.3;
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 12, y); ctx.stroke();
        ctx.setLineDash([]);
      },
      label: '轴线',
    });
  }

  // Draw legend horizontally from left
  let legX = pad;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `600 ${bottomFontSize}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText('图例', legX, bottomY);
  legX += ctx.measureText('图例').width + 10;

  for (const item of legendItems) {
    item.draw(legX, bottomY);
    legX += 16;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `600 ${bottomFontSize}px sans-serif`;
    ctx.fillText(item.label, legX, bottomY);
    legX += ctx.measureText(item.label).width + 16;
  }

  // Scale reference (right-aligned, same row as legend)
  const scaleBarW = 56;
  const scaleX = pad + innerSize - scaleBarW;
  ctx.strokeStyle = SCALE_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(scaleX, bottomY);
  ctx.lineTo(scaleX + scaleBarW, bottomY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(scaleX, bottomY - 5);
  ctx.lineTo(scaleX, bottomY + 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(scaleX + scaleBarW, bottomY - 5);
  ctx.lineTo(scaleX + scaleBarW, bottomY + 5);
  ctx.stroke();
  ctx.fillStyle = SCALE_COLOR;
  ctx.font = `600 ${bottomFontSize * 0.9}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('参考比例', scaleX + scaleBarW / 2, bottomY + bottomFontSize + 4);

  return canvas.toDataURL('image/jpeg', 0.92);
}
