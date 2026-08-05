// StoryboardGenNode 常量和纯函数，从主组件提取以控制文件规模
// 详见 CLAUDE.md §4.3 文件规模控制

import type { ReactNode } from 'react';
import type { StoryboardRatioControlMode, StoryboardGenNodeData } from '@/features/canvas/domain/canvasNodes';
import { DEFAULT_ASPECT_RATIO } from '@/features/canvas/domain/canvasNodes';
import { parseAspectRatio } from '@/features/canvas/application/imageData';
import { findReferenceTokens } from '@/features/canvas/application/referenceTokenEditing';

// ─── 接口 ──────────────────────────────────────────────

export interface AspectRatioChoice {
  value: string;
  label: string;
}

export interface PickerAnchor {
  left: number;
  top: number;
}

// ─── 常量 ──────────────────────────────────────────────

export const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };

export const STORYBOARD_NODE_HORIZONTAL_PADDING_PX = 24;
export const STORYBOARD_GRID_GAP_PX = 2;
export const STORYBOARD_GRID_BASE_CELL_HEIGHT_PX = 78;
export const STORYBOARD_GRID_MAX_WIDTH_PX = 320;
export const STORYBOARD_CONTROL_ROW_WIDTH_PX = 274;
export const STORYBOARD_PARAMS_ROW_WIDTH_PX = 286;
export const STORYBOARD_GEN_NODE_MIN_WIDTH_PX = 200;
export const STORYBOARD_GEN_NODE_MIN_HEIGHT_PX = 320;
export const STORYBOARD_GEN_HEADER_ADJUST = { x: 0, y: 0, scale: 1 };
export const STORYBOARD_GEN_ICON_ADJUST = { x: 0, y: 0, scale: 0.95 };
export const STORYBOARD_GEN_TITLE_ADJUST = { x: 0, y: 0, scale: 1 };
export const GRID_CONTROL_CONTAINER_CLASS = 'flex h-5 items-center gap-0.5 rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.04)] px-1';
export const GRID_CONTROL_LABEL_CLASS = 'text-[9px] text-text-muted';
export const GRID_CONTROL_VALUE_CLASS = 'min-w-[14px] text-center text-[9px] font-semibold text-text-dark';
export const GRID_SUMMARY_CLASS = 'flex h-5 items-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.05)] px-1.5 text-[9px] text-text-muted';
export const FRAME_GRID_GAP_PX = 2;
export const CONTROL_ROW_HEIGHT_PX = 20;
export const CONTROL_ROW_MARGIN_BOTTOM_PX = 10;
export const FRAME_GRID_MARGIN_BOTTOM_PX = 8;
export const PARAM_ROW_HEIGHT_PX = 20;
export const NODE_VERTICAL_PADDING_PX = 24;
export const FRAME_CELL_MIN_WIDTH_PX = 24;
export const FRAME_CELL_MIN_HEIGHT_PX = 16;
export const GRID_LINE_THICKNESS_PERCENT = 0.4;
export const RATIO_CONTROL_MODE_BUTTON_CLASS =
  'flex h-5 items-center rounded-full border px-1.5 text-[9px] transition-colors';
export const FRIENDLY_ASPECT_RATIO_CANDIDATES = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '3:2', '2:3', '5:4', '4:5',
];

// ─── 纯函数 ────────────────────────────────────────────

export function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number,
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return { left: Math.max(0, left), top: Math.max(0, top) };
}

export function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number,
  zoom: number,
): PickerAnchor {
  if (!container) return PICKER_FALLBACK_ANCHOR;

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  return {
    left: Math.max(0, (textareaRect.left - containerRect.left) / safeZoom + caretOffset.left),
    top: Math.max(0, (textareaRect.top - containerRect.top) / safeZoom + caretOffset.top),
  };
}

export function resolvePointerAnchor(
  container: HTMLDivElement | null,
  clientX: number,
  clientY: number,
  zoom: number,
): PickerAnchor {
  if (!container) return PICKER_FALLBACK_ANCHOR;

  const containerRect = container.getBoundingClientRect();
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  return {
    left: Math.max(0, (clientX - containerRect.left) / safeZoom),
    top: Math.max(0, (clientY - containerRect.top) / safeZoom),
  };
}

export function resolveReferenceIndexFromDescription(
  description: string,
  maxImageCount: number,
): number | null {
  const firstReference = findReferenceTokens(description, maxImageCount)[0];
  if (!firstReference) return null;
  return firstReference.value - 1;
}

export function renderFrameDescriptionWithHighlights(
  description: string,
  maxImageCount: number,
): ReactNode {
  if (!description) return ' ';

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(description, maxImageCount);

  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{description.slice(lastIndex, matchStart)}</span>,
      );
    }

    segments.push(
      <span
        key={`ref-${matchStart}`}
        className="relative z-0 text-white [text-shadow:0.24px_0_currentColor,-0.24px_0_currentColor] before:absolute before:-inset-x-[4px] before:-inset-y-[1px] before:-z-10 before:rounded-[7px] before:bg-accent/55 before:content-['']"
      >
        {matchText}
      </span>,
    );

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < description.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{description.slice(lastIndex)}</span>);
  }

  return segments;
}

export function buildFrameDescriptionDrafts(
  frames: StoryboardGenNodeData['frames'],
): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const frame of frames) {
    drafts[frame.id] = frame.description;
  }
  return drafts;
}

export function areFrameDescriptionDraftsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;

  for (const [key, value] of leftEntries) {
    if (right[key] !== value) return false;
  }

  return true;
}

export function pickClosestAspectRatio(
  targetRatio: number,
  supportedAspectRatios: string[],
): string {
  const supported = supportedAspectRatios.length > 0 ? supportedAspectRatios : ['1:1'];
  let bestValue = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const aspectRatio of supported) {
    const ratio = parseAspectRatio(aspectRatio);
    const distance = Math.abs(Math.log(ratio / targetRatio));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = aspectRatio;
    }
  }

  return bestValue;
}

export function ratioValueToAspectRatioString(ratioValue: number): string {
  if (!Number.isFinite(ratioValue) || ratioValue <= 0) return DEFAULT_ASPECT_RATIO;

  const scaledWidth = Math.max(1, Math.round(ratioValue * 1000));
  const scaledHeight = 1000;
  const gcd = (left: number, right: number): number => {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b !== 0) {
      const temp = b;
      b = a % b;
      a = temp;
    }
    return a || 1;
  };

  const divisor = gcd(scaledWidth, scaledHeight);
  return `${Math.round(scaledWidth / divisor)}:${Math.round(scaledHeight / divisor)}`;
}

export function formatFriendlyAspectRatio(ratioValue: number): string {
  if (!Number.isFinite(ratioValue) || ratioValue <= 0) return DEFAULT_ASPECT_RATIO;

  const snapped = pickClosestAspectRatio(ratioValue, FRIENDLY_ASPECT_RATIO_CANDIDATES);
  const snappedValue = parseAspectRatio(snapped);
  const snapDistance = Math.abs(Math.log(snappedValue / ratioValue));
  if (snapDistance <= Math.log(1.04)) return snapped;

  if (ratioValue >= 1) return `${ratioValue.toFixed(2)}:1`;
  return `1:${(1 / ratioValue).toFixed(2)}`;
}


export function resolveStoryboardAspectRatios(
  mode: StoryboardRatioControlMode,
  controlRatioValue: number,
  rows: number,
  cols: number,
): {
  cellRatioValue: number;
  overallRatioValue: number;
  cellAspectRatio: string;
  overallAspectRatio: string;
  cellAspectRatioLabel: string;
  overallAspectRatioLabel: string;
} {
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const safeControl =
    Number.isFinite(controlRatioValue) && controlRatioValue > 0 ? controlRatioValue : 1;

  const cellRatioValue = mode === 'cell' ? safeControl : safeControl * (safeRows / safeCols);
  const overallRatioValue =
    mode === 'overall' ? safeControl : safeControl * (safeCols / safeRows);

  return {
    cellRatioValue,
    overallRatioValue,
    cellAspectRatio: ratioValueToAspectRatioString(cellRatioValue),
    overallAspectRatio: ratioValueToAspectRatioString(overallRatioValue),
    cellAspectRatioLabel: formatFriendlyAspectRatio(cellRatioValue),
    overallAspectRatioLabel: formatFriendlyAspectRatio(overallRatioValue),
  };
}

export function generateFrameId(): string {
  return `frame-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function toCssAspectRatio(aspectRatio: string): string {
  const [width = '1', height = '1'] = aspectRatio.split(':');
  return `${width} / ${height}`;
}

export function resolveSizeToPixels(size: string): number {
  const sizeMap: Record<string, number> = {
    '0.5K': 512,
    '1K': 1024,
    '2K': 2048,
  };
  return sizeMap[size] ?? 1024;
}

export function generateGridImageDataUrl(
  aspectRatio: string,
  rows: number,
  cols: number,
  resolution: string,
  lineThicknessPercent: number = GRID_LINE_THICKNESS_PERCENT,
): string {
  const [ratioW = '16', ratioH = '9'] = aspectRatio.split(':');
  const ratioWNum = parseFloat(ratioW);
  const ratioHNum = parseFloat(ratioH);

  const totalPixels = resolveSizeToPixels(resolution);
  const canvasWidth = totalPixels;
  const canvasHeight = Math.round(totalPixels * (ratioHNum / ratioWNum));
  const thickness = Math.max(
    1,
    Math.round((Math.min(canvasWidth, canvasHeight) * lineThicknessPercent) / 100),
  );

  const cellWidth = canvasWidth / cols;
  const cellHeight = canvasHeight / rows;

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('Failed to create canvas context');

  // 白色背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 黑色线条
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = thickness;

  // 内部垂直线
  for (let i = 1; i < cols; i++) {
    const x = i * cellWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
  }

  // 内部水平线
  for (let i = 1; i < rows; i++) {
    const y = i * cellHeight;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasWidth, y);
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}
