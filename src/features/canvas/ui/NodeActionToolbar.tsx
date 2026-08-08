import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { Copy, Crop, Download, Film, FolderOpen, PenLine, RefreshCw, Scissors, Sparkles, Trash2, Unlink2 } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';

import {
  NODE_TOOL_TYPES,
  isExportImageNode,
  isGroupNode,
  isImageEditNode,
  isStoryboardGenNode,
  isStoryboardSplitNode,
  isUploadNode,
  type CanvasNode,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { getNodeToolPlugins } from '@/features/canvas/tools';
import type { ToolIconKey } from '@/features/canvas/tools';
import { UiChipButton, UiModal, UiPanel } from '@/components/ui';
import {
  copyImageSourceToClipboard,
  saveImageSourceToDirectory,
  saveImageSourceToPath,
} from '@/commands/image';
import { enhanceImage } from '@/commands/enhance';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';
import { sanitizeStoryboardText } from '@/features/canvas/application/storyboardText';
import { buildGenerationErrorReport } from '@/features/canvas/application/generationErrorReport';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeActionToolbarProps {
  node: CanvasNode;
}

const toolIconMap: Record<ToolIconKey, typeof Crop> = {
  crop: Crop,
  annotate: PenLine,
  split: Scissors,
};

const TOOLBAR_BUTTON_RADIUS_CLASS = 'rounded-full';
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  'border-[rgba(255,255,255,0.18)] bg-bg-dark/70 text-text-dark hover:border-[rgba(255,255,255,0.32)] hover:bg-bg-dark';

/** 检查节点是否包含图片数据（用于视频生成入口等） */
function hasImageData(node: CanvasNode): boolean {
  const d = node.data as Record<string, unknown>;
  if (d.previewImageUrl || d.imageUrl) return true;
  if (Array.isArray(d.gridCellImageUrls) && d.gridCellImageUrls.length > 0) return true;
  if (Array.isArray(d.frames)) {
    for (const f of d.frames as Array<Record<string, unknown>>) {
      if (f.imageUrl || f.previewImageUrl) return true;
    }
  }
  return false;
}

export const NodeActionToolbar = memo(({ node }: NodeActionToolbarProps) => {
  const { t, i18n } = useTranslation();
  const isImageEdit = isImageEditNode(node);
  const isStoryboardGen = isStoryboardGenNode(node);
  const isStoryboardSplit = isStoryboardSplitNode(node);
  const canCopyStoryboardText = isStoryboardGen || isStoryboardSplit;
  const tools = useMemo(() => getNodeToolPlugins(node), [node]);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const canReupload = isUploadNode(node) && Boolean(node.data.imageUrl);
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);
  const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
    (state) => state.ignoreAtTagWhenCopyingAndGenerating
  );
  const [downloadMenu, setDownloadMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDownloadMenuVisible, setIsDownloadMenuVisible] = useState(false);
  const [isCopySuccess, setIsCopySuccess] = useState(false);
  const [isCopyTextSuccess, setIsCopyTextSuccess] = useState(false);
  const [isCopyErrorSuccess, setIsCopyErrorSuccess] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [showEnhanceConfirm, setShowEnhanceConfirm] = useState(false);
  const enhanceSuppressConfirmRef = useRef(
    localStorage.getItem('enhance:suppressConfirm') === '1',
  );
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTextFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyErrorFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageSource = useMemo(() => {
    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return node.data.imageUrl || node.data.previewImageUrl || null;
    }
    return null;
  }, [node]);
  const canHandleImage = Boolean(imageSource);
  const generationError =
    isExportImageNode(node)
    && typeof (node.data as { generationError?: unknown }).generationError === 'string'
      ? ((node.data as { generationError?: string }).generationError ?? '').trim()
      : '';
  const generationErrorDetails =
    isExportImageNode(node)
    && typeof (node.data as { generationErrorDetails?: unknown }).generationErrorDetails === 'string'
      ? ((node.data as { generationErrorDetails?: string }).generationErrorDetails ?? '').trim()
      : '';
  const canCopyGenerationError = isExportImageNode(node) && generationError.length > 0;
  const generationErrorReport = useMemo(
    () =>
      buildGenerationErrorReport({
        errorMessage: generationError || t('ai.error'),
        errorDetails: generationErrorDetails || undefined,
        context: (node.data as { generationDebugContext?: unknown }).generationDebugContext,
      }),
    [generationError, generationErrorDetails, node.data, t]
  );

  const closeDownloadMenu = useCallback(() => {
    setIsDownloadMenuVisible(false);
    if (downloadMenuCloseTimerRef.current) {
      clearTimeout(downloadMenuCloseTimerRef.current);
    }
    downloadMenuCloseTimerRef.current = setTimeout(() => {
      setDownloadMenu(null);
      downloadMenuCloseTimerRef.current = null;
    }, UI_POPOVER_TRANSITION_MS);
  }, []);

  const resolveToolLabel = useCallback((toolType: NodeToolType) => {
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('tool.crop');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('tool.annotate');
    }
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      return t('tool.split');
    }
    return '';
  }, [t]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const menuElement = downloadMenuRef.current;
      if (!menuElement) {
        closeDownloadMenu();
        return;
      }
      if (menuElement.contains(event.target as Node)) {
        return;
      }
      closeDownloadMenu();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [closeDownloadMenu, downloadMenu]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      setIsDownloadMenuVisible(true);
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [downloadMenu]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      if (copyTextFeedbackTimerRef.current) {
        clearTimeout(copyTextFeedbackTimerRef.current);
      }
      if (copyErrorFeedbackTimerRef.current) {
        clearTimeout(copyErrorFeedbackTimerRef.current);
      }
      if (downloadMenuCloseTimerRef.current) {
        clearTimeout(downloadMenuCloseTimerRef.current);
      }
    };
  }, []);

  const handleCopyImage = useCallback(async () => {
    if (!imageSource) {
      return;
    }

    setIsCopySuccess(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setIsCopySuccess(false);
      copyFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await copyImageSourceToClipboard(imageSource);
    } catch (error) {
      console.error('Failed to copy image to clipboard', error);
    }
  }, [imageSource]);

  const storyboardText = useMemo(() => {
    if (isStoryboardGen) {
      return node.data.frames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(
            frame.description ?? '',
            ignoreAtTagWhenCopyingAndGenerating
          ),
        }))
        .join('\n');
    }
    if (isStoryboardSplit) {
      const orderedFrames = [...node.data.frames].sort((a, b) => a.order - b.order);
      return orderedFrames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(frame.note ?? '', ignoreAtTagWhenCopyingAndGenerating),
        }))
        .join('\n');
    }
    return '';
  }, [ignoreAtTagWhenCopyingAndGenerating, isStoryboardGen, isStoryboardSplit, node, t, i18n.language]);

  const handleCopyStoryboardText = useCallback(async () => {
    if (!storyboardText) {
      return;
    }

    setIsCopyTextSuccess(true);
    if (copyTextFeedbackTimerRef.current) {
      clearTimeout(copyTextFeedbackTimerRef.current);
    }
    copyTextFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyTextSuccess(false);
      copyTextFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(storyboardText);
    } catch (error) {
      console.error('Failed to copy storyboard text', error);
    }
  }, [storyboardText]);

  const handleCopyGenerationError = useCallback(async () => {
    if (!canCopyGenerationError) {
      return;
    }

    setIsCopyErrorSuccess(true);
    if (copyErrorFeedbackTimerRef.current) {
      clearTimeout(copyErrorFeedbackTimerRef.current);
    }
    copyErrorFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyErrorSuccess(false);
      copyErrorFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(generationErrorReport);
    } catch (error) {
      console.error('Failed to copy generation error report', error);
    }
  }, [canCopyGenerationError, generationErrorReport]);

  const handleDownloadSaveAs = useCallback(async () => {
    if (!imageSource) {
      return;
    }

    try {
      const selectedPath = await save({
        defaultPath: `node-${node.id}.png`,
      });
      if (!selectedPath || Array.isArray(selectedPath)) {
        return;
      }
      await saveImageSourceToPath(imageSource, selectedPath);
      closeDownloadMenu();
    } catch (error) {
      console.error('Failed to save image with save-as', error);
    }
  }, [closeDownloadMenu, imageSource, node.id]);

  const handleDownloadToPreset = useCallback(
    async (targetDir: string) => {
      if (!imageSource) {
        return;
      }
      try {
        await saveImageSourceToDirectory(imageSource, targetDir, `node-${node.id}`);
        closeDownloadMenu();
      } catch (error) {
        console.error('Failed to save image to preset dir', error);
      }
    },
    [closeDownloadMenu, imageSource, node.id]
  );

  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const handleEnhance = useCallback(async () => {
    if (!imageSource) return;

    setIsEnhancing(true);
    // 复用 ImageNode 已有的渐变进度条
    updateNodeData(node.id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationDurationMs: 30000,
    } as any);

    try {
      const enhancedPath = await enhanceImage(imageSource, 4);

      // 清除进度条，更新为增强后图片
      updateNodeData(node.id, {
        isGenerating: false,
        generationStartedAt: null,
        imageUrl: enhancedPath,
        previewImageUrl: null,
      } as any);

      // 生成新预览缩略图
      const { prepareNodeImage } = await import('@/features/canvas/application/imageData');
      const prepared = await prepareNodeImage(enhancedPath);
      updateNodeData(node.id, {
        imageUrl: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio,
      } as any);
    } catch (e: any) {
      console.error('[Enhance] 增强失败:', e);
      // 失败时清除进度条，恢复原图
      updateNodeData(node.id, {
        isGenerating: false,
        generationStartedAt: null,
      } as any);
    } finally {
      setIsEnhancing(false);
    }
  }, [imageSource, node.id, updateNodeData]);

  return (
    <ReactFlowNodeToolbar
      nodeId={node.id}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={NODE_TOOLBAR_OFFSET}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="flex items-center gap-1 rounded-full p-1">
        {!isImageEdit && tools.map((tool) => {
          const Icon = toolIconMap[tool.icon] ?? Crop;

          return (
            <UiChipButton
              key={tool.type}
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
              onClick={() =>
                canvasEventBus.publish('tool-dialog/open', {
                  nodeId: node.id,
                  toolType: tool.type,
                })
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {resolveToolLabel(tool.type)}
            </UiChipButton>
          );
        })}
        {!isImageEdit && canReupload && (
          <UiChipButton
            key="upload-reupload"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={() =>
              canvasEventBus.publish('upload-node/reupload', {
                nodeId: node.id,
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('nodeToolbar.reupload')}
          </UiChipButton>
        )}
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopySuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyImage();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copy')}
          </UiChipButton>
        )}
        {!isImageEdit && canCopyStoryboardText && (
          <UiChipButton
            key="storyboard-text-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyTextSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyStoryboardText();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copyText')}
          </UiChipButton>
        )}
        {!isImageEdit && canCopyGenerationError && (
          <UiChipButton
            key="generation-error-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyErrorSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : '!border-red-500/45 !bg-red-500/15 !text-red-200 hover:!bg-red-500/25'
            }`}
            onClick={() => {
              void handleCopyGenerationError();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {isCopyErrorSuccess ? t('nodeToolbar.copied') : t('nodeToolbar.copyErrorReport')}
          </UiChipButton>
        )}
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-download"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              if (downloadPresetPaths.length === 0) {
                void handleDownloadSaveAs();
                return;
              }
              setDownloadMenu({
                x: event.clientX,
                y: event.clientY,
              });
              setIsDownloadMenuVisible(false);
            }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('nodeToolbar.download')}
          </UiChipButton>
        )}
        {!isImageEdit && isGroupNode(node) && (
          <UiChipButton
            key="group-ungroup"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} hover:!border-amber-400/60 hover:!bg-amber-500/20 hover:!text-amber-200`}
            onClick={(event) => {
              event.stopPropagation();
              closeDownloadMenu();
              ungroupNode(node.id);
            }}
          >
            <Unlink2 className="h-3.5 w-3.5" />
            {t('nodeToolbar.ungroup')}
          </UiChipButton>
        )}
        {/* 图片增强 — 仅单图节点（上传/导出/编辑） */}
        {canHandleImage && !isImageEdit && (
          <UiChipButton
            key="image-enhance"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${
              isEnhancing
                ? '!border-emerald-400/60 !bg-emerald-500/20 !text-emerald-200'
                : `${TOOLBAR_NEUTRAL_BUTTON_CLASS} hover:!border-emerald-400/60 hover:!bg-emerald-500/20 hover:!text-emerald-200`
            }`}
            onClick={(event) => {
              event.stopPropagation();
              closeDownloadMenu();
              if (enhanceSuppressConfirmRef.current) {
                void handleEnhance();
              } else {
                setShowEnhanceConfirm(true);
              }
            }}
            disabled={isEnhancing}
          >
            <Sparkles className={`h-3.5 w-3.5 ${isEnhancing ? 'animate-pulse' : ''}`} />
            {isEnhancing ? '增强中...' : '增强'}
          </UiChipButton>
        )}
        {hasImageData(node) && (
          <UiChipButton
            key="video-gen"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} hover:!border-purple-400/60 hover:!bg-purple-500/20 hover:!text-purple-200`}
            onClick={(event) => {
              event.stopPropagation();
              closeDownloadMenu();
              const d = node.data as any;
              const images: string[] = [];
              if (d.previewImageUrl) images.push(d.previewImageUrl);
              if (d.imageUrl && d.imageUrl !== d.previewImageUrl) images.push(d.imageUrl);
              if (Array.isArray(d.gridCellImageUrls)) {
                for (const u of d.gridCellImageUrls) {
                  if (u && !images.includes(u)) images.push(u);
                }
              }
              canvasEventBus.publish('video-gen-dialog/open', {
                nodeId: node.id,
                images,
              });
            }}
          >
            <Film className="h-3.5 w-3.5" />
            {t('nodeToolbar.videoGen')}
          </UiChipButton>
        )}
        <UiChipButton
          key="node-delete"
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25`}
          onClick={(event) => {
            event.stopPropagation();
            closeDownloadMenu();
            deleteNode(node.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </UiChipButton>
      </UiPanel>

      {!isImageEdit && downloadMenu && (
        <div
          ref={downloadMenuRef}
          className={`fixed z-[120] min-w-[280px] rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 p-2 shadow-2xl backdrop-blur-sm transition-opacity duration-150 ${isDownloadMenuVisible ? 'opacity-100' : 'opacity-0'}`}
          style={{ left: `${downloadMenu.x}px`, top: `${downloadMenu.y}px` }}
        >
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
            onClick={() => {
              void handleDownloadSaveAs();
            }}
          >
            <Download className="h-4 w-4" />
            {t('nodeToolbar.saveAs')}
          </button>

          {downloadPresetPaths.length > 0 ? (
            <div className="mt-1 space-y-1 border-t border-[rgba(255,255,255,0.1)] pt-2">
              {downloadPresetPaths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
                  onClick={() => {
                    void handleDownloadToPreset(path);
                  }}
                  title={path}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  <span className="truncate">{path}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-1 border-t border-[rgba(255,255,255,0.1)] px-2.5 pt-2 text-xs text-text-muted">
              {t('nodeToolbar.noDownloadPresetPathsHint')}
            </div>
          )}
        </div>
      )}

      {/* 硬件要求确认弹窗 */}
      <UiModal
        isOpen={showEnhanceConfirm}
        title="本地图片增强"
        onClose={() => setShowEnhanceConfirm(false)}
        widthClassName="w-[480px]"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-emerald-500"
                onChange={(e) => {
                  enhanceSuppressConfirmRef.current = e.currentTarget.checked;
                  if (e.currentTarget.checked) {
                    localStorage.setItem('enhance:suppressConfirm', '1');
                  } else {
                    localStorage.removeItem('enhance:suppressConfirm');
                  }
                }}
              />
              以后不再提示
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-8 rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark px-3 text-xs text-text-muted transition-colors hover:bg-bg-dark/70"
                onClick={() => setShowEnhanceConfirm(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="h-8 rounded-lg bg-emerald-500/80 px-4 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
                onClick={() => {
                  setShowEnhanceConfirm(false);
                  void handleEnhance();
                }}
              >
                继续增强
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 text-sm leading-relaxed">
          <div>
            <p className="font-medium text-text-dark">此功能使用本地 GPU 进行 AI 图片超分增强</p>
            <p className="mt-2 text-text-muted">
              处理时间取决于您的显卡性能和图片尺寸，通常在 <strong className="text-text-dark">10–60 秒</strong>。
            </p>
          </div>

          <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-bg-dark/50 p-3">
            <p className="mb-2 text-xs font-medium text-text-dark">最低配置要求</p>
            <ul className="space-y-1.5 text-xs text-text-muted">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-emerald-400">&#9679;</span>
                <span>独立显卡，支持 <strong className="text-text-dark">Vulkan 1.1+</strong></span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-emerald-400">&#9679;</span>
                <span>显存 <strong className="text-text-dark">2 GB</strong> 以上</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-emerald-400">&#9679;</span>
                <span>兼容 NVIDIA / AMD / Intel Arc 显卡</span>
              </li>
            </ul>
            <p className="mt-2 text-[11px] text-text-muted/70">
              处理器集成显卡（Intel UHD / AMD APU）也可运行，但速度较慢。
              增强过程中请勿关闭应用。
            </p>
          </div>
        </div>
      </UiModal>
    </ReactFlowNodeToolbar>
  );
});

NodeActionToolbar.displayName = 'NodeActionToolbar';
