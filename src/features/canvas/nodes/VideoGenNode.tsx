import { memo, useCallback, useEffect, useMemo } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Film } from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type VideoGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveMinEdgeFittedSize,
  resolveResizeMinConstraintsByAspect,
} from '@/features/canvas/application/imageNodeSizing';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  canvasEventBus,
  graphImageResolver,
} from '@/features/canvas/application/canvasServices';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiChipButton } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';

type VideoGenNodeProps = NodeProps & {
  id: string;
  data: VideoGenNodeData;
  selected?: boolean;
};

/** 节点默认边长。要同时放下参考图行与提示词预览，因此比图片节点高。 */
const VIDEO_GEN_NODE_DEFAULT_WIDTH = 260;
const VIDEO_GEN_NODE_DEFAULT_HEIGHT = 340;
const VIDEO_GEN_NODE_MAX_WIDTH = 1200;
const VIDEO_GEN_NODE_MAX_HEIGHT = 1400;
/** 节点上最多展示几张参考图缩略图（超出的只计数，不铺满节点） */
const MAX_REF_THUMBNAILS = 6;

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

/** 用系统默认播放器打开成片。走 tauri-plugin-opener，与 StoryboardNode 一致。 */
async function openVideoExternally(path: string): Promise<void> {
  try {
    await openPath(path);
  } catch {
    /* 非关键路径：打不开系统播放器不影响节点数据 */
  }
}

/**
 * **直出视频节点** —— 「分镜提示词 + 参考图 → 成片」，不经过六宫格。
 *
 * 节点上的三块信息，与生成时一一对应（CLAUDE.md §12.4）：
 * 1. **参考图**：来自**上游 `upload` 节点的连线**，不是本节点的数据字段。
 *    所以关掉弹窗再点开、甚至重启软件，看到的都是同一组图。
 * 2. **提示词**：`configs[nodeId].prompt` 由视频生成弹窗读写，本节点不落第二份。
 * 3. **成片**：`generatedVideoUrl` 由弹窗成功回调写入，点「已生成视频」交给系统播放器。
 *
 * ⚠️ data.imageUrl 恒为空是有意为之：VideoGenDialog 对「无 imageUrl 的节点」会走
 * 「用传入 images」的分支，正是直出路线需要的行为。
 */
export const VideoGenNode = memo(({ id, data, selected, width, height }: VideoGenNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);

  const resolvedAspectRatio = data.aspectRatio || '1:1';
  const compactSize = resolveMinEdgeFittedSize(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
  const resolvedWidth = resolveNodeDimension(width, VIDEO_GEN_NODE_DEFAULT_WIDTH);
  const resolvedHeight = resolveNodeDimension(height, VIDEO_GEN_NODE_DEFAULT_HEIGHT);
  const resizeConstraints = resolveResizeMinConstraintsByAspect(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
  const resizeMinWidth = Math.max(resizeConstraints.minWidth, compactSize.width);
  const resizeMinHeight = resizeConstraints.minHeight;

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.videoGen, data),
    [data]
  );

  const referenceImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [id, nodes, edges]
  );
  const referenceItems = useMemo(
    () =>
      referenceImages.map((rawUrl, index) => ({
        rawUrl,
        displayUrl: resolveImageDisplayUrl(rawUrl),
        label: t('node.videoGen.refLabel', { index: index + 1 }),
      })),
    [referenceImages, t]
  );

  const promptText = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  const hasVideo = Boolean(data.generatedVideoUrl);

  const handleOpenDialog = useCallback(() => {
    setSelectedNode(id);
    canvasEventBus.publish('video-gen-dialog/open', {
      nodeId: id,
      // 空数组也要发：弹窗会按「参考图 0 张」给出明确报错，而不是静默用上一轮缓存。
      images: referenceImages,
    });
  }, [id, referenceImages, setSelectedNode]);

  // 节点尺寸变化后通知 xyflow 重算连接点位置（沿用 UploadNode 的做法）。
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/85 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Film className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="flex h-full w-full flex-col gap-2 overflow-hidden rounded-[var(--node-radius)] bg-bg-dark p-2">
        {/* 参考图行 —— 来源是上游 upload 节点的连线 */}
        <div className="flex shrink-0 items-center gap-1.5 overflow-hidden">
          {referenceItems.length > 0 ? (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {referenceItems.slice(0, MAX_REF_THUMBNAILS).map((item) => (
                  <img
                    key={item.rawUrl}
                    src={item.displayUrl}
                    alt={item.label}
                    title={item.label}
                    className="h-9 w-9 shrink-0 rounded border border-[rgba(255,255,255,0.14)] object-cover"
                    draggable={false}
                  />
                ))}
              </div>
              <span className="shrink-0 text-[11px] text-text-muted">
                {t('node.videoGen.refCount', { count: referenceItems.length })}
              </span>
            </>
          ) : (
            <span className="text-[11px] leading-5 text-text-muted/80">
              {t('node.videoGen.noRefs')}
            </span>
          )}
        </div>

        {/* 提示词预览（完整正文在视频生成弹窗里编辑） */}
        <div className="min-h-0 flex-1 overflow-hidden rounded-md bg-black/20 px-2 py-1.5">
          {promptText ? (
            <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-text-muted">
              {promptText}
            </p>
          ) : (
            <span className="text-[11px] leading-5 text-text-muted/70">
              {t('node.videoGen.emptyPrompt')}
            </span>
          )}
        </div>

        {/* 底栏：成片入口 + 生成入口 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {hasVideo && (
            <UiChipButton
              className={`${NODE_CONTROL_CHIP_CLASS} w-auto shrink-0 justify-center border-lime-500/30 bg-lime-500/10`}
              onClick={(event) => {
                event.stopPropagation();
                void openVideoExternally(data.generatedVideoUrl as string);
              }}
            >
              <svg className={`${NODE_CONTROL_ICON_CLASS} text-lime-400`} fill="currentColor" viewBox="0 0 16 16">
                <path d="M4 2.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-11zM5 3v10h6V3H5z" />
                <path d="M6.5 5.5l4 2.5-4 2.5v-5z" />
              </svg>
              <span className="text-[11px] text-lime-300">{t('nodeToolbar.videoGen')}</span>
            </UiChipButton>
          )}
          <UiChipButton
            className={`${NODE_CONTROL_CHIP_CLASS} w-auto shrink-0 justify-center bg-accent/90 text-white hover:bg-accent`}
            onClick={(event) => {
              event.stopPropagation();
              handleOpenDialog();
            }}
          >
            <Film className={NODE_CONTROL_ICON_CLASS} />
            <span className="text-[11px]">{t('node.videoGen.generate')}</span>
          </UiChipButton>
        </div>
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
        minWidth={resizeMinWidth}
        minHeight={resizeMinHeight}
        maxWidth={VIDEO_GEN_NODE_MAX_WIDTH}
        maxHeight={VIDEO_GEN_NODE_MAX_HEIGHT}
      />
    </div>
  );
});

VideoGenNode.displayName = 'VideoGenNode';
