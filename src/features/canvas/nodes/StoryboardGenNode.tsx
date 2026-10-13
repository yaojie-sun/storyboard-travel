import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { Handle, Position, useReactFlow, useUpdateNodeInternals, useViewport } from '@xyflow/react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type ImageSize,
  type StoryboardRatioControlMode,
  type StoryboardGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  type AspectRatioChoice,
  type PickerAnchor,
  PICKER_FALLBACK_ANCHOR,
  STORYBOARD_NODE_HORIZONTAL_PADDING_PX,
  STORYBOARD_GRID_GAP_PX,
  STORYBOARD_GRID_BASE_CELL_HEIGHT_PX,
  STORYBOARD_GRID_MAX_WIDTH_PX,
  STORYBOARD_CONTROL_ROW_WIDTH_PX,
  STORYBOARD_PARAMS_ROW_WIDTH_PX,
  STORYBOARD_GEN_NODE_MIN_WIDTH_PX,
  STORYBOARD_GEN_NODE_MIN_HEIGHT_PX,
  STORYBOARD_GEN_HEADER_ADJUST,
  STORYBOARD_GEN_ICON_ADJUST,
  STORYBOARD_GEN_TITLE_ADJUST,
  GRID_CONTROL_CONTAINER_CLASS,
  GRID_CONTROL_LABEL_CLASS,
  GRID_CONTROL_VALUE_CLASS,
  GRID_SUMMARY_CLASS,
  FRAME_GRID_GAP_PX,
  CONTROL_ROW_HEIGHT_PX,
  CONTROL_ROW_MARGIN_BOTTOM_PX,
  FRAME_GRID_MARGIN_BOTTOM_PX,
  PARAM_ROW_HEIGHT_PX,
  NODE_VERTICAL_PADDING_PX,
  FRAME_CELL_MIN_WIDTH_PX,
  FRAME_CELL_MIN_HEIGHT_PX,
  RATIO_CONTROL_MODE_BUTTON_CLASS,
  resolvePickerAnchor,
  resolvePointerAnchor,
  resolveReferenceIndexFromDescription,
  renderFrameDescriptionWithHighlights,
  buildFrameDescriptionDrafts,
  areFrameDescriptionDraftsEqual,
  pickClosestAspectRatio,
  resolveStoryboardAspectRatios,
  generateFrameId,
  toCssAspectRatio,
  generateGridImageDataUrl,
} from './storyboardGenUtils';
import { EXPORT_RESULT_DISPLAY_NAME, resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  canvasAiGateway,
  graphImageResolver,
} from '@/features/canvas/application/canvasServices';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  parseAspectRatio,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import {
  STORYBOARD_AT_TAG_REGEX,
  sanitizeStoryboardPromptText,
  sanitizeStoryboardText,
} from '@/features/canvas/application/storyboardText';
import { expandSceneMarkersInText } from '@/features/canvas/application/sceneMarkerParser';
import {
  fetchGridPromptRules,
  buildGridPrompt,
  sanitizeGridPrompt,
  type GridPromptRules,
  type GridPromptContext,
  type FramePromptContext,
} from '@/features/canvas/application/gridPromptRules';
import {
  findReferenceTokens,
  insertReferenceToken,
  removeTextRange,
  resolveReferenceAwareDeleteRange,
} from '@/features/canvas/application/referenceTokenEditing';
import {
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  listImageModels,
  resolveImageModelResolution,
  resolveImageModelResolutions,
} from '@/features/canvas/models';
import { GRSAI_NANO_BANANA_PRO_MODEL_ID } from '@/features/canvas/models/image/grsai/nanoBananaPro';
import { ModelParamsControls } from '@/features/canvas/ui/ModelParamsControls';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import {
  UiButton,
  UiChipButton,
} from '@/components/ui';
import { CreditInsufficientModal } from '@/components/CreditInsufficientModal';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodePriceBadge } from '@/features/canvas/ui/NodePriceBadge';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_MODEL_CHIP_CLASS,
  NODE_CONTROL_PARAMS_CHIP_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { bananaCheckCredits, bananaReportUsage } from '@/commands/ai';
import { SceneComposerDialog } from '@/features/canvas/ui/SceneComposerDialog';

type StoryboardGenNodeProps = {
  id: string;
  data: StoryboardGenNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

// 常量、纯函数、接口已提取到 ./storyboardGenUtils.tsx（CLAUDE.md §4.3 文件规模控制）

/**
 * 解析图像生成错误（宫格图），返回用户友好提示。
 * 错误来源：Rust Provider 层 + HTTP 响应。
 */
function translateImageGenError(errorMsg: string): { title: string; detail: string } {
  const msg = errorMsg || '';
  const lower = msg.toLowerCase();

  // —— 内容安全审核（最高频） ——
  const safetyKeywords = [
    '安全', '策略', '未通过', '审核', '违规', '敏感', '不合规',
    'contentnotpass', 'content_filter', 'safety', 'blocked',
    'moderation', 'rejected', 'reject',
  ];
  if (safetyKeywords.some(k => lower.includes(k))) {
    return {
      title: '内容安全审核未通过',
      detail: '本次生成的画面触发了网络安全审核。请返回Chat修改分镜提示词，调整画面描述后重试。\n\n常见触发场景：裸露、血腥暴力、政治敏感、枪支武器、成人用品等。',
    };
  }

  // —— 速率限制 ——
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('限流') || lower.includes('throttl')) {
    return {
      title: '请求过于频繁',
      detail: '服务器限流中，请等待30秒后再试。积分已保留，不会重复扣费。',
    };
  }

  // —— 超时 ——
  if (lower.includes('408') || lower.includes('超时') || lower.includes('timeout')) {
    return {
      title: '生成超时',
      detail: '图像生成请求超时，积分已返还。请检查网络后重试，或尝试降低分辨率。',
    };
  }

  // —— 服务端错误 ——
  if (lower.includes('500') || lower.includes('503') || lower.includes('internal') || lower.includes('服务异常') || lower.includes('暂不可用')) {
    return {
      title: '服务器繁忙',
      detail: '图像生成服务暂时异常，请稍后重试。积分已返还。',
    };
  }

  // —— 网络/连接 ——
  if (lower.includes('网络') || lower.includes('network') || lower.includes('connect') || lower.includes('连接')) {
    return {
      title: '网络连接异常',
      detail: '网络连接失败，请检查网络后重试。积分已返还。',
    };
  }

  // —— 参数错误 ——
  if (lower.includes('参数') || lower.includes('invalid') || lower.includes('不合法') || lower.includes('不支持')) {
    return {
      title: '生成参数有误',
      detail: msg.replace(/^[^：:]+[：:]\s*/, '').trim() || '图像生成参数不合法，请检查参考图、比例和分辨率设置后重试。',
    };
  }

  // —— 额度不足 ——
  if (lower.includes('quota') || lower.includes('额度') || lower.includes('insufficient') || lower.includes('积分')) {
    return {
      title: '额度不足',
      detail: msg.replace(/^[^：:]+[：:]\s*/, '').trim() || '服务端资源不足，请联系管理员充值后重试。',
    };
  }

  // —— 未知错误 ——
  return {
    title: '图像生成失败',
    detail: msg || '未知错误，请稍后重试。',
  };
}

export const StoryboardGenNode = memo(({ id, data, selected, width, height }: StoryboardGenNodeProps) => {
  const { t } = useTranslation();
  const { zoom } = useViewport();
  const updateNodeInternals = useUpdateNodeInternals();
  const { fitView } = useReactFlow();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const grsaiNanoBananaProModel = useSettingsStore((state) => state.grsaiNanoBananaProModel);
  const storyboardGenKeepStyleConsistent = useSettingsStore(
    (state) => state.storyboardGenKeepStyleConsistent
  );
  const storyboardGenDisableTextInImage = useSettingsStore(
    (state) => state.storyboardGenDisableTextInImage
  );
  const storyboardGenAutoInferEmptyFrame = useSettingsStore(
    (state) => state.storyboardGenAutoInferEmptyFrame
  );
  const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
    (state) => state.ignoreAtTagWhenCopyingAndGenerating
  );
  const enableStoryboardGenGridPreviewShortcut = useSettingsStore(
    (state) => state.enableStoryboardGenGridPreviewShortcut
  );
  const showStoryboardGenAdvancedRatioControls = useSettingsStore(
    (state) => state.showStoryboardGenAdvancedRatioControls
  );
  const deepseekPromptOptimization = useSettingsStore(
    (state) => state.deepseekPromptOptimization
  );

  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeFrameTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [pickerFrameIndex, setPickerFrameIndex] = useState<number | null>(null);
  const [sceneComposerOpen, setSceneComposerOpen] = useState(false);
  const [cellAspectRatio, setCellAspectRatio] = useState<'9:16' | '16:9' | '1:1'>(() => {
    const existing = (data as StoryboardGenNodeData).requestAspectRatio;
    const val = (existing === '9:16' || existing === '16:9' || existing === '1:1') ? existing : '9:16';
    // Force-inject a version marker so we know this code is running
    (window as any).__CELL_RATIO_FIX_V2 = true;
    return val;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('scene-marker-modal-open', sceneComposerOpen);
  }, [sceneComposerOpen]);
  // 修正历史数据：旧版可能把竖屏的2行×3列交换为3行×2列写回nodeData
  useEffect(() => {
    if (nodeData.gridRows !== 2 || nodeData.gridCols !== 3) {
      updateNodeData(id, { gridRows: 2, gridCols: 3 });
    }
  }, []);
  // 修正历史数据：nodeData.requestAspectRatio 可能是旧版值(如 '4:3' 或 'auto')，
  // 导致 UI 显示为兜底 '9:16' 但生成时读到旧值，第一次错第二次对。
  useEffect(() => {
    if (nodeData.requestAspectRatio !== cellAspectRatio) {
      updateNodeData(id, { requestAspectRatio: cellAspectRatio });
    }
  }, []);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [showInsufficientCreditsDialog, setShowInsufficientCreditsDialog] = useState(false);
  const [insufficientCredits, setInsufficientCredits] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  const lastPointerAnchorRef = useRef<{ frameIndex: number; anchor: PickerAnchor } | null>(null);
  const frameTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const frameHighlightRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const nodeData = data as StoryboardGenNodeData;
  const [frameDescriptionDrafts, setFrameDescriptionDrafts] = useState<Record<string, string>>(() =>
    buildFrameDescriptionDrafts(nodeData.frames)
  );
  const frameDescriptionDraftsRef = useRef(frameDescriptionDrafts);

  // Extract character names from frame descriptions for auto-sync to scene composer
  const promptCharacterNames = useMemo(() => {
    const allText = (nodeData.frames ?? []).map((f: { description?: string }) => f.description ?? '').join(' ');
    const names = new Set<string>();
    const tokenRegex = /@([一-龥a-zA-Z0-9_]+)/g;
    let m;
    while ((m = tokenRegex.exec(allText)) !== null) {
      const name = m[1];
      if (!/^图\d+$/.test(name) && !/^Image\d+$/i.test(name)) {
        names.add(name);
      }
    }
    return [...names];
  }, [nodeData.frames]);

  // 远端提示词规则缓存
  const gridPromptRulesRef = useRef<GridPromptRules | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchGridPromptRules().then((rules) => {
      if (!cancelled) {
        gridPromptRulesRef.current = rules;
      }
    });
    return () => { cancelled = true; };
  }, []);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.storyboardGen, nodeData),
    [nodeData]
  );

  const incomingImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [id, nodes, edges]
  );
  const incomingImageItems = useMemo(
    () =>
      incomingImages.map((imageUrl, index) => ({
        imageUrl,
        displayUrl: resolveImageDisplayUrl(imageUrl),
        label: `图${index + 1}`,
      })),
    [incomingImages]
  );
  const incomingImageViewerList = useMemo(
    () => incomingImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [incomingImageItems]
  );

  const imageModels = useMemo(() => listImageModels(), []);

  const selectedModel = useMemo(() => {
    return getImageModel((data as StoryboardGenNodeData).model || DEFAULT_IMAGE_MODEL_ID);
  }, []);
  const providerApiKey = apiKeys[selectedModel.providerId] ?? '';
  const effectiveExtraParams = useMemo(
    () => ({
      ...(nodeData.extraParams ?? {}),
      ...(selectedModel.id === GRSAI_NANO_BANANA_PRO_MODEL_ID
        ? { grsai_pro_model: grsaiNanoBananaProModel }
        : {}),
    }),
    [grsaiNanoBananaProModel, nodeData.extraParams, selectedModel.id]
  );
  const resolutionOptions = useMemo(
    () => resolveImageModelResolutions(selectedModel, { extraParams: effectiveExtraParams })
      .filter(r => r.value !== '4K'),
    [effectiveExtraParams, selectedModel]
  );

  const selectedResolution = useMemo((): AspectRatioChoice => {
    return resolveImageModelResolution(selectedModel, '2K', {
      extraParams: effectiveExtraParams,
    });
  }, [effectiveExtraParams, selectedModel]);

  const aspectRatioOptions = useMemo<AspectRatioChoice[]>(
    () => selectedModel.aspectRatios.filter((item) =>
      ['9:16', '16:9', '1:1'].includes(item.value)
    ),
    [selectedModel.aspectRatios]
  );

  const selectedAspectRatio = useMemo((): AspectRatioChoice => {
    return { value: cellAspectRatio, label: cellAspectRatio };
  }, [cellAspectRatio]);

  const ratioControlMode: StoryboardRatioControlMode = showStoryboardGenAdvancedRatioControls
    ? (nodeData.ratioControlMode === 'overall' ? 'overall' : 'cell')
    : 'cell';
  const controlAspectRatioValue = cellAspectRatio;
  const resolvedAspectRatios = useMemo(
    () => resolveStoryboardAspectRatios(
      ratioControlMode,
      parseAspectRatio(controlAspectRatioValue),
      2, // 短视频版固定 2 行
      3  // 短视频版固定 3 列
    ),
    [controlAspectRatioValue, ratioControlMode]
  );
  const frameAspectRatioValue = resolvedAspectRatios.cellAspectRatio;

  const baseFrameLayout = useMemo(() => {
    const aspectRatio = Math.max(0.1, parseAspectRatio(frameAspectRatioValue));
    const GRID_COLS = 3; // 短视频版固定 3 列
    const GRID_ROWS = 2; // 短视频版固定 2 行
    let cellWidth = STORYBOARD_GRID_BASE_CELL_HEIGHT_PX * aspectRatio;
    let gridWidth = GRID_COLS * cellWidth + Math.max(0, GRID_COLS - 1) * STORYBOARD_GRID_GAP_PX;

    if (gridWidth > STORYBOARD_GRID_MAX_WIDTH_PX) {
      const scale = STORYBOARD_GRID_MAX_WIDTH_PX / gridWidth;
      cellWidth *= scale;
      gridWidth =
        GRID_COLS * cellWidth + Math.max(0, GRID_COLS - 1) * STORYBOARD_GRID_GAP_PX;
    }

    const roundedCellWidth = Math.max(FRAME_CELL_MIN_WIDTH_PX, Math.round(cellWidth));
    const roundedCellHeight = Math.max(FRAME_CELL_MIN_HEIGHT_PX, Math.round(roundedCellWidth / aspectRatio));
    const roundedGridWidth =
      GRID_COLS * roundedCellWidth + Math.max(0, GRID_COLS - 1) * STORYBOARD_GRID_GAP_PX;
    const roundedGridHeight =
      GRID_ROWS * roundedCellHeight + Math.max(0, GRID_ROWS - 1) * FRAME_GRID_GAP_PX;
    const nodeInnerWidth = Math.max(
      STORYBOARD_CONTROL_ROW_WIDTH_PX,
      STORYBOARD_PARAMS_ROW_WIDTH_PX,
      roundedGridWidth
    );
    const nodeWidth = Math.max(
      STORYBOARD_GEN_NODE_MIN_WIDTH_PX,
      Math.round(nodeInnerWidth + STORYBOARD_NODE_HORIZONTAL_PADDING_PX)
    );
    const nodeHeight = Math.max(
      STORYBOARD_GEN_NODE_MIN_HEIGHT_PX,
      Math.round(
        NODE_VERTICAL_PADDING_PX +
        CONTROL_ROW_HEIGHT_PX +
        CONTROL_ROW_MARGIN_BOTTOM_PX +
        roundedGridHeight +
        FRAME_GRID_MARGIN_BOTTOM_PX +
        PARAM_ROW_HEIGHT_PX
      )
    );

    return {
      nodeWidth,
      nodeHeight,
    };
  }, [frameAspectRatioValue]);

  const requestResolution = selectedModel.resolveRequest({
    referenceImageCount: incomingImages.length,
  });
  const showWebSearchToggle =
    selectedModel.id === GRSAI_NANO_BANANA_PRO_MODEL_ID;
  const webSearchEnabled = Boolean(nodeData.extraParams?.enable_web_search);
  const supportedAspectRatioValues = useMemo(
    () => selectedModel.aspectRatios.map((item) => item.value),
    [selectedModel.aspectRatios]
  );
  const mappedOverallRequestAspectRatio = useMemo(
    () =>
      pickClosestAspectRatio(
        resolvedAspectRatios.overallRatioValue,
        supportedAspectRatioValues
      ),
    [resolvedAspectRatios.overallRatioValue, supportedAspectRatioValues]
  );

  const totalFrames = 6;
  const resolvedNodeWidth = Math.max(
    baseFrameLayout.nodeWidth,
    Math.round(width ?? baseFrameLayout.nodeWidth)
  );
  const resolvedNodeHeight = Math.max(
    baseFrameLayout.nodeHeight,
    Math.round(height ?? baseFrameLayout.nodeHeight)
  );
  const frameLayout = useMemo(() => {
    const cols = 3; // 短视频版固定 3 列
    const rows = 2; // 短视频版固定 2 行
    const aspectRatio = Math.max(0.1, parseAspectRatio(frameAspectRatioValue));
    const innerWidth = Math.max(120, resolvedNodeWidth - STORYBOARD_NODE_HORIZONTAL_PADDING_PX);
    const availableGridHeight = Math.max(
      72,
      resolvedNodeHeight
      - NODE_VERTICAL_PADDING_PX
      - CONTROL_ROW_HEIGHT_PX
      - CONTROL_ROW_MARGIN_BOTTOM_PX
      - FRAME_GRID_MARGIN_BOTTOM_PX
      - PARAM_ROW_HEIGHT_PX
    );
    const widthLimitedCellWidth =
      (innerWidth - Math.max(0, cols - 1) * STORYBOARD_GRID_GAP_PX) / cols;
    const heightLimitedCellHeight =
      (availableGridHeight - Math.max(0, rows - 1) * FRAME_GRID_GAP_PX) / rows;
    const heightLimitedCellWidth = heightLimitedCellHeight * aspectRatio;
    const resolvedCellWidth = Math.floor(Math.min(widthLimitedCellWidth, heightLimitedCellWidth));
    const cellWidth = Math.max(FRAME_CELL_MIN_WIDTH_PX, resolvedCellWidth);
    const gridWidth = cols * cellWidth + Math.max(0, cols - 1) * STORYBOARD_GRID_GAP_PX;
    const paramsRowWidth = Math.max(
      STORYBOARD_PARAMS_ROW_WIDTH_PX,
      Math.floor(innerWidth)
    );

    return {
      cellWidth,
      gridWidth,
      paramsRowWidth,
      cellAspectRatio: toCssAspectRatio(frameAspectRatioValue),
    };
  }, [frameAspectRatioValue, resolvedNodeHeight, resolvedNodeWidth]);

  useEffect(() => {
    frameDescriptionDraftsRef.current = frameDescriptionDrafts;
  }, [frameDescriptionDrafts]);

  useEffect(() => {
    const nextDrafts = buildFrameDescriptionDrafts(nodeData.frames);
    setFrameDescriptionDrafts((previous) =>
      areFrameDescriptionDraftsEqual(previous, nextDrafts) ? previous : nextDrafts
    );
  }, [nodeData.frames]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedNodeHeight, resolvedNodeWidth, updateNodeInternals]);

  // Sync size with node data (aspect ratio is managed by cell aspect ratio buttons)
  useEffect(() => {
    if (nodeData.size !== selectedResolution.value) {
      updateNodeData(id, { size: selectedResolution.value as ImageSize });
    }
  }, [
    id,
    nodeData,
    selectedResolution.value,
    updateNodeData,
  ]);

  useEffect(() => {
    if (incomingImages.length === 0) {
      setShowImagePicker(false);
      setPickerFrameIndex(null);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }
    setPickerActiveIndex((previous) => Math.min(previous, incomingImages.length - 1));
  }, [incomingImages.length]);

  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }

      setShowImagePicker(false);
      setPickerFrameIndex(null);
      setPickerCursor(null);
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, []);

  // Auto-generate frames when grid changes
  useEffect(() => {
    const currentFrames = nodeData.frames;
    const targetCount = totalFrames;

    if (currentFrames.length === targetCount) {
      return;
    }

    const newFrames: StoryboardGenNodeData['frames'] = [];
    for (let i = 0; i < targetCount; i++) {
      if (i < currentFrames.length) {
        newFrames.push(currentFrames[i]);
      } else {
        newFrames.push({
          id: generateFrameId(),
          description: '',
          referenceIndex: null,
        });
      }
    }

    updateNodeData(id, { frames: newFrames });
  }, [id, nodeData.frames, totalFrames, updateNodeData]);

  // Build prompt from frames using remote rules engine
  const buildPrompt = useCallback((): string => {
    if (!nodeData) {
      return '';
    }

    const rules = gridPromptRulesRef.current;
    if (!rules) {
      // rules 尚未加载完成
      return '';
    }

    const { frames } = nodeData;

    // 短视频版固定 2行×3列，不做竖屏行列交换
    const safeRows = 2;
    const safeCols = 3;

    // 汇总所有宫格中的 @图N 参考标记 —— 任一宫格标记的参考图全宫格通用
    const globalReferenceIndices = new Set<number>();
    const rawDescriptions = frames.map((frame) =>
      frameDescriptionDraftsRef.current[frame.id] ?? frame.description
    );
    for (const rawDescription of rawDescriptions) {
      for (const token of findReferenceTokens(rawDescription, incomingImages.length)) {
        globalReferenceIndices.add(token.value);
      }
    }

    // 有参考图传入时，必须启用全局身份锁定，不论各帧是否写了 @图N
    const hasAnyRefImage = incomingImages.length > 0 || globalReferenceIndices.size > 0;

    // 构建每个分镜的上下文
    const frameContexts: FramePromptContext[] = frames.map((_frame, index) => {
      const rawDescription = rawDescriptions[index];

      // 全宫格共享参考图：任一宫格写了 @图N，所有宫格都标记 hasRefImage
      // 有参考图时：移除 @图N 标记，保留用户的动作/情绪描述
      // 无参考图时：展开场景标记，保留完整描述
      const description = hasAnyRefImage
        ? sanitizeStoryboardPromptText(
            rawDescription.replace(STORYBOARD_AT_TAG_REGEX, '').trim()
          )
        : sanitizeStoryboardPromptText(
            expandSceneMarkersInText(rawDescription, nodeData.sceneMarkers)
          );

      return {
        index: index + 1,
        row: Math.floor(index / safeCols) + 1,
        col: (index % safeCols) + 1,
        description,
        hasRefImage: hasAnyRefImage,
      };
    });

    const perCellRatio_context = cellAspectRatio;
    const [pcw, pch] = perCellRatio_context.split(':').map(Number);
    const overallW = (pcw || safeCols) * safeCols;
    const overallH = (pch || safeRows) * safeRows;
    const gcdOverall = (a: number, b: number): number => { while (b) { [a, b] = [b, a % b]; } return a || 1; };
    const div = gcdOverall(overallW, overallH);
    const overallRatio = `${overallW / div}:${overallH / div}`;

    const context: GridPromptContext = {
      rows: safeRows,
      cols: safeCols,
      total: frames.length,
      aspectRatio: overallRatio,
      cellAspectRatio: perCellRatio_context,
      frames: frameContexts,
      hasAnyRefImage,
      disableTextInImage: storyboardGenDisableTextInImage,
      storyContext: nodeData.storySynopsis,
    };

    return buildGridPrompt(rules, context);
  }, [
    nodeData,
    incomingImages,
    cellAspectRatio,
    storyboardGenAutoInferEmptyFrame,
    storyboardGenDisableTextInImage,
    storyboardGenKeepStyleConsistent,
  ]);
  const resolveEffectiveRequestAspectRatio = useCallback((): string => {
    return resolvedAspectRatios.overallAspectRatio;
  }, [resolvedAspectRatios.overallAspectRatio]);

  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = useCallback(async (previewGridOnly = false) => {
    if (!nodeData || isGenerating) {
      return;
    }

    setIsGenerating(true);
    console.log('[DEBUG handleGenerate] step1: setIsGenerating, refs=', incomingImages.length);

    // 检查用户剩余次数是否为0，如果是则弹出充值引导对话框
    // macOS 上 native-tls 可能不遵守超时导致永久挂起，加前端超时兜底
    let creditsInfo: { credits: number } | null = null;
    try {
      creditsInfo = await Promise.race([
        bananaCheckCredits(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CREDITS_CHECK_TIMEOUT')), 10000)
        ),
      ]);
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === 'CREDITS_CHECK_TIMEOUT';
      if (isTimeout) {
        console.warn('[StoryboardGen] 积分检查超时（10s），跳过预检查继续生成');
        // 不阻塞生成 — 后续 banana_consume_credit 会做真正的扣费校验
      } else {
        console.error('[StoryboardGen] 积分检查失败:', err);
        setIsGenerating(false);
        const errorMessage = t('node.imageEdit.creditsCheckFailed');
        setError(errorMessage);
        void showErrorDialog(errorMessage, t('common.error'));
        return;
      }
    }
    const minCreditsForGridGen = 10;
    if (creditsInfo && creditsInfo.credits < minCreditsForGridGen) {
      setInsufficientCredits(creditsInfo.credits);
      setShowInsufficientCreditsDialog(true);
      setIsGenerating(false);
      return;
    }

    console.log('[DEBUG handleGenerate] step2: nodeData.requestAspectRatio=', nodeData.requestAspectRatio, 'cellAspectRatio=', cellAspectRatio);
    // 短视频版固定 2行×3列，不从 nodeData 读取（历史数据可能被旧版交换过）
    const safeRows = 2;
    const safeCols = 3;
    // 🔴 强制使用 UI 选择的 cellAspectRatio，忽略可能被旧数据污染的 requestAspectRatio
    const perCellRatio = cellAspectRatio;
    console.log('[DEBUG handleGenerate] perCellRatio=', perCellRatio, 'safeRows=', safeRows, 'safeCols=', safeCols);
    const [pcw, pch] = perCellRatio.split(':').map(Number);
    // 整体宫格比例 = 单格比例 × 行列数
    const overallW = (pcw || safeCols) * safeCols;
    const overallH = (pch || safeRows) * safeRows;
    const gcd = (a: number, b: number): number => { while (b) { [a, b] = [b, a % b]; } return a || 1; };
    const ratioDivisor = gcd(overallW, overallH);
    const resolvedRequestAspectRatio = `${overallW / ratioDivisor}:${overallH / ratioDivisor}`;

    if (previewGridOnly) {
      const gridImageDataUrl = generateGridImageDataUrl(
        resolvedRequestAspectRatio,
        safeRows,
        safeCols,
        selectedResolution.value
      );
      const newNodePosition = findNodePosition(
        id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      const previewNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        newNodePosition,
        {
          displayName: t('node.storyboardGen.gridPreviewTitle'),
          resultKind: 'storyboardGenOutput',
          imageUrl: gridImageDataUrl,
          previewImageUrl: gridImageDataUrl,
          aspectRatio: resolvedRequestAspectRatio,
          isGenerating: false,
          generationStartedAt: null,
          requestAspectRatio: resolvedRequestAspectRatio,
        }
      );
      addEdge(id, previewNodeId);
      setSelectedNode(null);
      setError(null);
      setIsGenerating(false);
      return;
    }

    console.log('[DEBUG handleGenerate] step3: calling buildPrompt');
    const rawPrompt = buildPrompt();
    console.log('[DEBUG handleGenerate] step4: buildPrompt returned, length=', rawPrompt.length);
    if (!rawPrompt) {
      const errorMessage = t('node.storyboardGen.promptRequired', { count: 1 });
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      setIsGenerating(false);
      return;
    }

    if (!providerApiKey) {
      const errorMessage = t('node.imageEdit.apiKeyRequired');
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      setIsGenerating(false);
      return;
    }

    // Sanitize prompt before sending — always runs, zero cost
    const sanitizeResult = sanitizeGridPrompt(rawPrompt, {
      rows: safeRows,
      cols: safeCols,
      total: safeRows * safeCols,
      aspectRatio: resolvedRequestAspectRatio,
      frames: [],
      hasAnyRefImage: incomingImages.length > 0,
      disableTextInImage: storyboardGenDisableTextInImage,
    });
    const prompt = sanitizeResult.prompt;
    if (sanitizeResult.warnings.length > 0) {
      console.warn('[StoryboardGen] prompt sanitized:', sanitizeResult.warnings);
    }

    const generationDurationMs = selectedModel.expectedDurationMs ?? 600000;
    const generationStartedAt = Date.now();
    console.log('[DEBUG handleGenerate] step5: before getRuntimeDiagnostics');
    const runtimeDiagnostics = await getRuntimeDiagnostics();
    console.log('[DEBUG handleGenerate] step6: getRuntimeDiagnostics done');

    // Create new image node with generating state immediately
    // Use auto-positioning to avoid collisions with existing nodes
    const newNodePosition = findNodePosition(
      id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT
    );
    console.log('[DEBUG handleGenerate] step7: adding result node');
    const newNodeId = addNode(
      CANVAS_NODE_TYPES.exportImage,
      newNodePosition,
      {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs,
        displayName: EXPORT_RESULT_DISPLAY_NAME.storyboardGenOutput,
        resultKind: 'storyboardGenOutput',
        prompt: '',
        model: selectedModel.id,
        size: selectedResolution.value as ImageSize,
        requestAspectRatio: resolvedRequestAspectRatio,
      }
    );

    // Connect the storyboard node to the new image node
    addEdge(id, newNodeId);

    setSelectedNode(null);
    setError(null);

    // Scroll the canvas to the newly created generation result node
    fitView({ nodes: [{ id: newNodeId }], duration: 300, padding: 0.3 });

    console.log('[DEBUG handleGenerate] step8: entering try block, calling setApiKey');
    try {
      await canvasAiGateway.setApiKey(selectedModel.providerId, providerApiKey);
      console.log('[DEBUG handleGenerate] step9: setApiKey done');

      // 生成俯视定位图（如已启用且有场景标记数据）
      const topDownMapDataUrls: string[] = [];
      const enableTopDownMap = useSettingsStore.getState().storyboardGenEnableTopDownMap;
      if (enableTopDownMap && nodeData.sceneMarkers && nodeData.sceneMarkers.length > 0) {
        const { generateTopDownPositioningMapDataUrl } = await import(
          '@/features/canvas/application/topDownMapRenderer'
        );
        for (const marker of nodeData.sceneMarkers) {
          const hasContent = marker.characters.length > 0 || marker.cameras.length > 0 || marker.props.length > 0 || (marker.movementArrows ?? []).length > 0;
          if (hasContent) {
            try {
              const dataUrl = generateTopDownPositioningMapDataUrl(marker, {
                imageSize: 768,
                titlePrefix: t('node.sceneMarkerEditor.floorPlanTitlePrefix', '顶视人物场景定位参考图'),
              });
              if (dataUrl) topDownMapDataUrls.push(dataUrl);
            } catch (err) {
              console.warn('[StoryboardGen] 俯视定位图生成失败:', marker.name, err);
            }
          }
        }
      }

      // 生成网格图片作为最后一张参考图片
      const gridImageDataUrl = generateGridImageDataUrl(
        resolvedRequestAspectRatio,
        safeRows,
        safeCols,
        selectedResolution.value
      );

      // 参考图顺序: 上游图片 → 俯视定位图 → 网格预览
      // 参考图顺序: 上游图片 → 俯视定位图 → 网格预览（无用户图时网格作兜底）
      const allReferenceImages = [...incomingImages, ...topDownMapDataUrls, gridImageDataUrl];

      const metadataFrameNotes = nodeData.frames
        .slice(0, safeRows * safeCols)
        .map((frame) => {
          const description = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;
          return sanitizeStoryboardText(description, ignoreAtTagWhenCopyingAndGenerating);
        });

      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt,
        model: requestResolution.requestModel,
        size: selectedResolution.value,
        aspectRatio: resolvedRequestAspectRatio,
        referenceImages: allReferenceImages,
        extraParams: {
          ...effectiveExtraParams,
          grid_rows: safeRows,
          grid_cols: safeCols,
        },
        enable_optimization: deepseekPromptOptimization,
      });
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'storyboardGen',
        providerId: selectedModel.providerId,
        requestModel: requestResolution.requestModel,
        requestSize: selectedResolution.value,
        requestAspectRatio: resolvedRequestAspectRatio,
        prompt,
        extraParams: effectiveExtraParams,
        referenceImageCount: 1,
        referenceImagePlaceholders: createReferenceImagePlaceholders(1),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'storyboardGen',
        generationProviderId: selectedModel.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationDebugContext,
        generationStoryboardMetadata: {
          gridRows: safeRows,
          gridCols: safeCols,
          frameNotes: metadataFrameNotes,
        },
      });
    } catch (generationError) {
      const resolvedError = resolveErrorContent(generationError, '生成失败');
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'storyboardGen',
        providerId: selectedModel.providerId,
        requestModel: requestResolution.requestModel,
        requestSize: selectedResolution.value,
        requestAspectRatio: resolvedRequestAspectRatio,
        prompt,
        extraParams: effectiveExtraParams,
        referenceImageCount: 1,
        referenceImagePlaceholders: createReferenceImagePlaceholders(1),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };
      const reportText = buildGenerationErrorReport({
        errorMessage: resolvedError.message,
        errorDetails: resolvedError.details,
        context: generationDebugContext,
      });
      const imgErr = translateImageGenError(resolvedError.message);
      setError(resolvedError.message);
      void showErrorDialog(imgErr.title, '错误', imgErr.detail, reportText);
      // Clear generating state and mark as failed
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationProviderId: null,
        generationClientSessionId: null,
        generationStoryboardMetadata: undefined,
        generationError: resolvedError.message,
        generationErrorDetails: resolvedError.details ?? null,
        generationDebugContext,
      });
    } finally {
      setIsGenerating(false);
      bananaReportUsage({
        api_type: selectedModel.providerId,
        is_success: !error,
        cost_credits: 0,
        response_time_ms: Date.now() - generationStartedAt,
        category: 'image_generation',
        image_size: selectedResolution.value,
        duration_seconds: 0,
        prompt_len: rawPrompt?.length ?? 0,
        error_message: error ?? '',
      }).catch(() => {});
    }
  }, [
    providerApiKey,
    nodeData,
    incomingImages,
    isGenerating,
    requestResolution.requestModel,
    effectiveExtraParams,
    selectedModel.expectedDurationMs,
    selectedModel.id,
    selectedModel.providerId,
    supportedAspectRatioValues,
    setSelectedNode,
    cellAspectRatio,
    selectedResolution.value,
    addNode,
    addEdge,
    buildPrompt,
    selectedModel.id,
    findNodePosition,
    updateNodeData,
    mappedOverallRequestAspectRatio,
    resolveEffectiveRequestAspectRatio,
    t,
    ignoreAtTagWhenCopyingAndGenerating,
  ]);

  const handleFrameDescriptionChange = useCallback(
    (index: number, description: string) => {
      const frame = nodeData.frames[index];
      if (!frame) {
        return;
      }

      setFrameDescriptionDrafts((previous) =>
        previous[frame.id] === description
          ? previous
          : {
            ...previous,
            [frame.id]: description,
          }
      );

      const referenceIndex = resolveReferenceIndexFromDescription(description, incomingImages.length);
      if (frame.description === description && frame.referenceIndex === referenceIndex) {
        return;
      }

      const newFrames = [...nodeData.frames];
      newFrames[index] = { ...frame, description, referenceIndex };
      updateNodeData(id, { frames: newFrames });
    },
    [id, incomingImages.length, nodeData.frames, updateNodeData]
  );

  const closeImagePicker = useCallback(() => {
    setShowImagePicker(false);
    setPickerFrameIndex(null);
    setPickerCursor(null);
    setPickerActiveIndex(0);
  }, []);

  const syncFrameHighlightScroll = useCallback((frameId: string) => {
    const textarea = frameTextareaRefs.current[frameId];
    const highlight = frameHighlightRefs.current[frameId];
    if (!textarea || !highlight) {
      return;
    }

    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  const insertImageReference = useCallback((imageIndex: number) => {
    if (!nodeData || pickerFrameIndex === null) {
      return;
    }

    const frame = nodeData.frames[pickerFrameIndex];
    if (!frame) {
      closeImagePicker();
      return;
    }

    const marker = `@图${imageIndex + 1}`;
    const currentDescription = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;
    const cursor = pickerCursor ?? currentDescription.length;
    const { nextText: nextDescription, nextCursor } = insertReferenceToken(
      currentDescription,
      cursor,
      marker
    );
    handleFrameDescriptionChange(pickerFrameIndex, nextDescription);
    closeImagePicker();

    requestAnimationFrame(() => {
      activeFrameTextareaRef.current?.focus();
      activeFrameTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [closeImagePicker, handleFrameDescriptionChange, nodeData, pickerCursor, pickerFrameIndex]);

  const handleImagePersisted = useCallback(
    (imagePath: string, markerName: string) => {
      const position = findNodePosition(
        id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      );
      const newNodeId = addNode(CANVAS_NODE_TYPES.exportImage, position, {
        displayName: markerName,
        imageUrl: imagePath,
        previewImageUrl: imagePath,
        aspectRatio: '1:1',
        resultKind: 'generic' as const,
      });
      if (newNodeId) {
        addEdge(newNodeId, id);
      }
    },
    [id, addNode, addEdge, findNodePosition],
  );

  const handleFrameDescriptionKeyDown = useCallback(
    (index: number, event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (showImagePicker && pickerFrameIndex === index) {
        if (incomingImages.length === 0) { /* no-op */ } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
          return;
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setPickerActiveIndex((previous) =>
            previous === 0 ? incomingImages.length - 1 : previous - 1
          );
          return;
        } else if (event.key === 'Enter') {
          event.preventDefault();
          insertImageReference(pickerActiveIndex);
          return;
        }
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        const frame = nodeData.frames[index];
        if (!frame) {
          return;
        }

        const currentDescription = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;
        const selectionStart = event.currentTarget.selectionStart ?? currentDescription.length;
        const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
        const deleteDirection = event.key === 'Backspace' ? 'backward' : 'forward';
        const deleteRange = resolveReferenceAwareDeleteRange(
          currentDescription,
          selectionStart,
          selectionEnd,
          deleteDirection,
          incomingImages.length
        );
        if (deleteRange) {
          event.preventDefault();
          const { nextText, nextCursor } = removeTextRange(currentDescription, deleteRange);
          handleFrameDescriptionChange(index, nextText);
          requestAnimationFrame(() => {
            activeFrameTextareaRef.current?.focus();
            activeFrameTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
            syncFrameHighlightScroll(frame.id);
          });
          return;
        }
      }

      if (event.key === '@' && incomingImages.length > 0) {
        event.preventDefault();
        const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
        const pointerAnchor = lastPointerAnchorRef.current;
        if (pointerAnchor && pointerAnchor.frameIndex === index) {
          setPickerAnchor(pointerAnchor.anchor);
        } else {
          setPickerAnchor(resolvePickerAnchor(rootRef.current, event.currentTarget, cursor, zoom));
        }
        setPickerFrameIndex(index);
        setPickerCursor(cursor);
        setPickerActiveIndex(0);
        setShowImagePicker(true);
        activeFrameTextareaRef.current = event.currentTarget;
        return;
      }

      if (event.key === 'Escape' && showImagePicker) {
        event.preventDefault();
        closeImagePicker();
      }
    },
    [
      closeImagePicker,
      handleFrameDescriptionChange,
      incomingImages.length,
      insertImageReference,
      nodeData.frames,
      pickerActiveIndex,
      pickerFrameIndex,
      showImagePicker,
      syncFrameHighlightScroll,
      zoom,
    ]
  );

  if (!nodeData) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/95 p-3 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'
        }
      `}
      style={{
        width: `${resolvedNodeWidth}px`,
        height: `${resolvedNodeHeight}px`,
      }}
      onClick={() => setSelectedNode(id)}
    >
      {/* Floating title */}
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Sparkles className="h-4 w-4" />}
        titleText={resolvedTitle}
        headerAdjust={STORYBOARD_GEN_HEADER_ADJUST}
        iconAdjust={STORYBOARD_GEN_ICON_ADJUST}
        titleAdjust={STORYBOARD_GEN_TITLE_ADJUST}
        rightSlot={
          false ? (
            <NodePriceBadge
              label=""
              title=""
            />
          ) : undefined
        }
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      {/* Frame summary + grid settings */}
      <div className="mb-2.5 flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className={GRID_CONTROL_CONTAINER_CLASS}>
            <span className={GRID_CONTROL_LABEL_CLASS}>{t('node.storyboardGen.rowsShort')}</span>
            <span className={GRID_CONTROL_VALUE_CLASS}>2</span>
          </div>
          <div className={GRID_CONTROL_CONTAINER_CLASS}>
            <span className={GRID_CONTROL_LABEL_CLASS}>{t('node.storyboardGen.colsShort')}</span>
            <span className={GRID_CONTROL_VALUE_CLASS}>3</span>
          </div>
        </div>

        {showStoryboardGenAdvancedRatioControls && (
          <div className="min-w-0 flex-1 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-center text-[10px] text-text-muted">
            <span>{t('node.storyboardGen.cellAspectRatio')}: {resolvedAspectRatios.cellAspectRatioLabel}</span>
            <span className="mx-1 text-[rgba(255,255,255,0.22)]">|</span>
            <span>{t('node.storyboardGen.overallAspectRatio')}: {resolvedAspectRatios.overallAspectRatioLabel}</span>
          </div>
        )}

        <div className="flex items-center gap-1">
          {showStoryboardGenAdvancedRatioControls && (
            <div className="flex h-5 items-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.04)] p-0.5">
              <button
                type="button"
                className={`${RATIO_CONTROL_MODE_BUTTON_CLASS} ${ratioControlMode === 'overall'
                  ? 'border-accent/55 bg-accent/18 text-text-dark'
                  : 'border-transparent bg-transparent text-text-muted hover:bg-white/5'
                  }`}
                onClick={(event) => {
                  event.stopPropagation();
                  updateNodeData(id, { ratioControlMode: 'overall' });
                }}
              >
                {t('node.storyboardGen.ratioModeOverall')}
              </button>
              <button
                type="button"
                className={`${RATIO_CONTROL_MODE_BUTTON_CLASS} ${ratioControlMode === 'cell'
                  ? 'border-accent/55 bg-accent/18 text-text-dark'
                  : 'border-transparent bg-transparent text-text-muted hover:bg-white/5'
                  }`}
                onClick={(event) => {
                  event.stopPropagation();
                  updateNodeData(id, { ratioControlMode: 'cell' });
                }}
              >
                {t('node.storyboardGen.ratioModeCell')}
              </button>
            </div>
          )}
          <div className={GRID_SUMMARY_CLASS}>
            {t('node.storyboardGen.frameCount', { count: totalFrames })}
          </div>
        </div>
      </div>

      {/* Frame Grid */}
      <div className="mb-2 flex min-h-0 flex-1 items-center justify-center">
        <div
          className="grid gap-0.5"
          style={{
            width: `${frameLayout.gridWidth}px`,
            gridTemplateColumns: `repeat(3, ${frameLayout.cellWidth}px)`,
          }}
        >
          {nodeData.frames.map((frame, index) => {
            const frameDescription = frameDescriptionDrafts[frame.id] ?? frame.description;
            return (
              <div
                key={frame.id}
                className="relative overflow-hidden rounded border border-[rgba(255,255,255,0.06)] bg-bg-dark/40"
                style={{ aspectRatio: frameLayout.cellAspectRatio }}
              >
                <div
                  ref={(element) => {
                    frameHighlightRefs.current[frame.id] = element;
                  }}
                  aria-hidden="true"
                  className="ui-scrollbar pointer-events-none absolute inset-0 overflow-y-auto overflow-x-hidden text-[10px] leading-4 text-text-dark"
                  style={{ scrollbarGutter: 'stable' }}
                >
                  <div className="min-h-full whitespace-pre-wrap break-words px-1.5 py-1 text-left">
                    {renderFrameDescriptionWithHighlights(frameDescription, incomingImages.length)}
                  </div>
                </div>
                <textarea
                  ref={(element) => {
                    frameTextareaRefs.current[frame.id] = element;
                  }}
                  value={frameDescription}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    handleFrameDescriptionChange(index, nextValue);
                  }}
                  onKeyDown={(event) => handleFrameDescriptionKeyDown(index, event)}
                  onScroll={() => syncFrameHighlightScroll(frame.id)}
                  onPointerDown={(event) => {
                    lastPointerAnchorRef.current = {
                      frameIndex: index,
                      anchor: resolvePointerAnchor(rootRef.current, event.clientX, event.clientY, zoom),
                    };
                  }}
                  onFocus={(event) => {
                    activeFrameTextareaRef.current = event.currentTarget;
                    syncFrameHighlightScroll(frame.id);
                  }}
                  placeholder={t('node.storyboardGen.framePlaceholder', {
                    index: String(index + 1).padStart(2, '0'),
                  })}
                  wrap="soft"
                  className="ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden bg-transparent px-1.5 py-1 text-left text-[10px] leading-4 text-transparent caret-text-dark placeholder:text-text-muted/40 focus:border-accent/50 focus:outline-none whitespace-pre-wrap break-words"
                  style={{ scrollbarGutter: 'stable' }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {showImagePicker && (
        <div
          className="nowheel absolute z-30 w-[180px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
          style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <div
            className="ui-scrollbar nowheel max-h-[240px] overflow-y-auto"
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {/* Reference images */}
            {incomingImageItems.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] text-text-muted/60">
                  {t('node.storyboardGen.pickerReferenceImages')}
                </div>
                {incomingImageItems.map((item, imageIndex) => (
                  <button
                    key={`${item.imageUrl}-${imageIndex}`}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      insertImageReference(imageIndex);
                    }}
                    onMouseEnter={() => setPickerActiveIndex(imageIndex)}
                    className={`flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)] ${pickerActiveIndex === imageIndex
                      ? 'border-[rgba(255,255,255,0.24)] bg-bg-dark'
                      : ''
                      }`}
                  >
                    <CanvasNodeImage
                      src={item.displayUrl}
                      alt={item.label}
                      viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                      viewerImageList={incomingImageViewerList}
                      className="h-8 w-8 rounded object-cover"
                    />
                    <span>{item.label}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {error && (() => {
            const imgErr = translateImageGenError(error);
            return (
              <div className="mb-1.5 shrink-0 rounded-md border border-red-400/25 bg-red-500/8 px-2.5 py-1.5 text-left">
                <p className="text-[11px] font-semibold text-red-400">{imgErr.title}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-red-300/70 whitespace-pre-wrap">{imgErr.detail}</p>
              </div>
            );
          })()}

      {/* AI Parameters */}
      <div
        className="relative mx-auto mt-auto flex shrink-0 items-center justify-between"
        style={{ width: `${frameLayout.paramsRowWidth}px` }}
      >
        <div className="flex items-center gap-1">
          <ModelParamsControls
            imageModels={imageModels}
            selectedModel={selectedModel}
            resolutionOptions={resolutionOptions}
            selectedResolution={selectedResolution}
            selectedAspectRatio={selectedAspectRatio}
            aspectRatioOptions={aspectRatioOptions}
            onModelChange={(modelId) => updateNodeData(id, { model: modelId })}
            onResolutionChange={(resolution) =>
              updateNodeData(id, { size: resolution as ImageSize })
            }
            onAspectRatioChange={(aspectRatio) =>
              updateNodeData(id, { requestAspectRatio: aspectRatio })
            }
            extraParams={nodeData.extraParams}
            onExtraParamChange={(key, value) =>
              updateNodeData(id, {
                extraParams: {
                  ...(nodeData.extraParams ?? {}),
                  [key]: value,
                },
              })
            }
            showWebSearchToggle={showWebSearchToggle}
            webSearchEnabled={webSearchEnabled}
            onWebSearchToggle={(enabled) =>
              updateNodeData(id, {
                extraParams: {
                  ...(nodeData.extraParams ?? {}),
                  enable_web_search: enabled,
                },
              })
            }
            triggerSize="sm"
            chipClassName={NODE_CONTROL_CHIP_CLASS}
            modelChipClassName={NODE_CONTROL_MODEL_CHIP_CLASS}
            paramsChipClassName={NODE_CONTROL_PARAMS_CHIP_CLASS}
            modelPanelAlign="center"
            paramsPanelAlign="center"
            modelPanelClassName="inline-block min-w-[300px] max-w-[calc(100vw-32px)] p-2"
            paramsPanelClassName="w-[420px] p-3"
            hideModelSelector={true}
            hideParamsChip={true}
          />

          {/* 单格画幅比例选择 */}
          {['9:16', '16:9', '1:1'].map((ratio) => {
            const isActive = cellAspectRatio === ratio;
            return (
              <UiChipButton
                key={ratio}
                className={`${NODE_CONTROL_CHIP_CLASS} w-auto shrink-0 justify-center ${
                  isActive ? '!bg-blue-600' : ''
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  setCellAspectRatio(ratio as '9:16' | '16:9' | '1:1');
                  updateNodeData(id, { requestAspectRatio: ratio });
                }}
              >
                <span className="text-[11px] text-white">{ratio}</span>
              </UiChipButton>
            );
          })}

          <UiChipButton
            className={`${NODE_CONTROL_CHIP_CLASS} w-auto shrink-0 justify-center`}
            onClick={(event) => {
              event.stopPropagation();
              activeFrameTextareaRef.current?.blur();
              setSceneComposerOpen(true);
            }}
          >
            <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-[11px] text-white">
              {nodeData.sceneMarkers && nodeData.sceneMarkers.length > 0
                ? `顶视定位(${nodeData.sceneMarkers.length})`
                : '顶视定位'}
            </span>
          </UiChipButton>

          {/* Video preview indicator: shows when a video was generated for this node */}
          {nodeData.generatedVideoUrl && (
            <UiChipButton
              className={`${NODE_CONTROL_CHIP_CLASS} w-auto shrink-0 justify-center border-lime-500/30 bg-lime-500/10`}
              onClick={async (event) => {
                event.stopPropagation();
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  await invoke('open_video_in_shell', { path: nodeData.generatedVideoUrl });
                } catch { /* non-critical */ }
              }}
            >
              <svg className="h-3 w-3 text-lime-400" fill="currentColor" viewBox="0 0 16 16">
                <path d="M4 2.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-11zM5 3v10h6V3H5z"/>
                <path d="M6.5 5.5l4 2.5-4 2.5v-5z"/>
              </svg>
              <span className="text-[11px] text-lime-300">已生成视频</span>
            </UiChipButton>
          )}
        </div>

        <UiButton
            disabled={isGenerating}
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              const previewGridOnly =
                enableStoryboardGenGridPreviewShortcut && event.ctrlKey && event.altKey && event.shiftKey;
              handleGenerate(previewGridOnly).catch((err) => {
                console.error('[StoryboardGen] handleGenerate 未捕获异常:', err);
              });
            }}
            variant="primary"
            size="sm"
            className={`!min-w-0 shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          >
            <Sparkles className={NODE_CONTROL_ICON_CLASS} strokeWidth={2.8} />
            {t('canvas.generate')}
          </UiButton>

      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={baseFrameLayout.nodeWidth}
        minHeight={baseFrameLayout.nodeHeight}
        maxWidth={1800}
        maxHeight={1400}
      />
      <CreditInsufficientModal
        isOpen={showInsufficientCreditsDialog}
        credits={insufficientCredits}
        onClose={() => setShowInsufficientCreditsDialog(false)}
        onRecharged={() => setShowInsufficientCreditsDialog(false)}
      />

      {sceneComposerOpen && (
        <SceneComposerDialog
          isOpen={sceneComposerOpen}
          onClose={() => setSceneComposerOpen(false)}
          markers={nodeData.sceneMarkers ?? []}
          onMarkersChange={(nextMarkers) => {
            updateNodeData(id, { sceneMarkers: nextMarkers });
          }}
          promptCharacterNames={promptCharacterNames}
          onImagePersisted={handleImagePersisted}
        />
      )}
    </div>
  );
});

StoryboardGenNode.displayName = 'StoryboardGenNode';
