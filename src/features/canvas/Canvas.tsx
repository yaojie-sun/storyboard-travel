import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';

import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEpisodeStore } from '@/stores/episodeStore';
import { useChatStore } from '@/stores/chatStore';
import { useAssetStore } from '@/stores/assetStore';
import { readProjectGlobalsMd } from '@/commands/projectState';
import { listAssets } from '@/commands/asset';
import { canvasAiGateway, canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
  type ShotFrameMap,
} from '@/features/canvas/domain/canvasNodes';
import { prepareNodeImage } from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
} from '@/features/canvas/application/generationErrorReport';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  getConnectMenuNodeTypes,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { embedStoryboardImageMetadata } from '@/commands/image';
import { nodeTypes } from './nodes';
import { edgeTypes } from './edges';
import { NodeSelectionMenu } from './NodeSelectionMenu';
import { SelectedNodeOverlay } from './ui/SelectedNodeOverlay';
import { NodeToolDialog } from './ui/NodeToolDialog';
import { ImageViewerModal } from './ui/ImageViewerModal';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';
import { ChatPanel } from '@/features/chat';
import { getEmphasisLabels, getVideoTypeLabel } from '@/features/project/presets';
import { splitGridPromptIntoFrames } from '@/utils/gridPromptParser';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  start?: {
    x: number;
    y: number;
  };
}

interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
}

interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

const ALT_DRAG_COPY_Z_INDEX = 2000;
const GENERATION_JOB_POLL_INTERVAL_MS = 1400;

interface GenerationStoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || element.isContentEditable;
}

function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      return file;
    }

    const subtype = item.type.split('/')[1]?.split('+')[0] || 'png';
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }

  return null;
}

function resolveAllowedNodeTypes(handleType: HandleType): CanvasNodeType[] {
  return getConnectMenuNodeTypes(handleType);
}

function canNodeTypeBeManualConnectionSource(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.upload || type === CANVAS_NODE_TYPES.exportImage;
}

function canNodeBeManualConnectionSource(nodeId: string | null | undefined, nodes: CanvasNode[]): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  return node ? canNodeTypeBeManualConnectionSource(node.type) : false;
}

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = 'changedTouches' in event
    ? event.changedTouches[0] ?? event.touches[0]
    : null;
  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === 'source' ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;

  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}

interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}

export function Canvas() {
  const { t } = useTranslation();
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const suppressNextPaneClickRef = useRef(false);
  const suppressNextEdgeClickRef = useRef(false);

  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(
    undefined
  );
  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(
    null
  );
  const [previewConnectionVisual, setPreviewConnectionVisual] =
    useState<PreviewConnectionVisual | null>(null);
  const [showChatPanel, setShowChatPanel] = useState(false);

  const isRestoringCanvasRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedSnapshotRef = useRef<ClipboardSnapshot | null>(null);
  const pasteIterationRef = useRef(0);
  const pasteImageHandledRef = useRef(false);
  const activeGenerationPollNodeIdsRef = useRef(new Set<string>());
  const duplicateNodesRef = useRef<((sourceNodeIds: string[]) => string | null) | null>(null);
  const altDragCopyRef = useRef<{
    sourceNodeIds: string[];
    startPositions: Map<string, { x: number; y: number }>;
    copiedNodeIds: string[];
    sourceToCopyIdMap: Map<string, string>;
  } | null>(null);
  const edgePanGestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
    zoom: number;
    moved: boolean;
  } | null>(null);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const history = useCanvasStore((state) => state.history);
  const dragHistorySnapshot = useCanvasStore((state) => state.dragHistorySnapshot);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const setCanvasData = useCanvasStore((state) => state.setCanvasData);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const configuredApiKeyCount = useSettingsStore((state) => state.getConfiguredApiKeyCount());

  // 调试：监听apiKeys变化
  useEffect(() => {
    console.log('[DEBUG] apiKeys changed:', apiKeys);
  }, [apiKeys]);

  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const saveCurrentProject = useProjectStore((state) => state.saveCurrentProject);
  const saveCurrentProjectViewport = useProjectStore((state) => state.saveCurrentProjectViewport);
  const cancelPendingViewportPersist = useProjectStore(
    (state) => state.cancelPendingViewportPersist
  );
  const currentEpisodeId = useEpisodeStore((state) => state.currentEpisodeId);
  const saveCurrentEpisodeCanvas = useEpisodeStore((state) => state.saveCurrentEpisodeCanvas);

  const persistCanvasSnapshot = useCallback(() => {
    if (isRestoringCanvasRef.current) {
      return;
    }

    const currentProject = getCurrentProject();
    if (!currentProject) {
      return;
    }

    const projectId = currentProject.id;
    const currentNodes = useCanvasStore.getState().nodes;
    const currentEdges = useCanvasStore.getState().edges;
    const currentHistory = useCanvasStore.getState().history;
    const viewport = reactFlowInstance.getViewport();

    const epId = useEpisodeStore.getState().currentEpisodeId;
    if (epId) {
      // Episode context: save to episode only (avoids polluting project-level data)
      saveCurrentEpisodeCanvas(projectId, epId, currentNodes, currentEdges, viewport, currentHistory);
    } else {
      // No episode context: save to project level (legacy)
      saveCurrentProject(
        currentNodes,
        currentEdges,
        viewport,
        currentHistory
      );
    }
  }, [getCurrentProject, reactFlowInstance, saveCurrentProject, saveCurrentEpisodeCanvas]);

  const scheduleCanvasPersist = useCallback(
    (delayMs = 140) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvasSnapshot();
      }, delayMs);
    },
    [persistCanvasSnapshot]
  );

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [openToolDialog, closeToolDialog]);

  // Ensure episodes are loaded when canvas mounts
  const canvasProjectId = useProjectStore((state) => state.currentProject?.id);
  useEffect(() => {
    if (canvasProjectId) {
      const episodes = useEpisodeStore.getState().episodesByProject[canvasProjectId];
      if (!episodes && !useEpisodeStore.getState().isLoading) {
        void useEpisodeStore.getState().loadEpisodes(canvasProjectId);
      }
    }
  }, [canvasProjectId]);

  // Build project context for AI chat on mount (with fallback when no MD exists)
  useEffect(() => {
    if (!canvasProjectId) return;
    const project = useProjectStore.getState().currentProject;
    if (!project) return;

    const buildAndSetContext = async () => {
      // 1. Try to read existing project_globals.md
      let context = await readProjectGlobalsMd(canvasProjectId).catch(() => '');

      // 2. Fallback: build minimal context from project params when no MD
      if (!context.trim()) {
        const parts: string[] = [];
        parts.push(`# ${project.name}\n`);
        parts.push('## 项目全局参数\n');
        if (project.videoType) parts.push(`- 视频类型: ${getVideoTypeLabel(project.videoType)}`);
        if (project.aspectRatio) parts.push(`- 画幅比例: ${project.aspectRatio}`);
        if (project.style) parts.push(`- 视觉风格: ${project.style}`);
        if (project.tone) parts.push(`- 项目调性: ${project.tone}`);
        if (project.directorRef) parts.push(`- 旅行视频风格: ${project.directorRef}`);
        const emphasisLabels = getEmphasisLabels(project.emphasisDimensions.filter((d) => d.enabled).map((d) => d.key));
        if (emphasisLabels.length > 0) {
          parts.push(`- 提示词重点维度: ${emphasisLabels.join('、')}`);
        }
        context = parts.join('\n') + '\n';
      }

      // 3. Append asset @图N mapping
      try {
        const assets = await listAssets(canvasProjectId);
        if (assets.length > 0) {
          const catLabel = (cat: string) =>
            cat === 'character' ? '角色' : cat === 'scene' ? '场景' : '服饰道具';
          const lines = assets.map((a, i) =>
            `@图${i + 1}: ${a.name} (${catLabel(a.category)})`,
          );
          context = `${context}\n## 可用参考图\n${lines.join('\n')}\n\n生成分镜提示词时，如需引用参考图请使用 @图N 格式。`;
        }
      } catch { /* assets not critical */ }

      useChatStore.getState().setProjectContext(context);
    };

    void buildAndSetContext();
  }, [canvasProjectId]);

  // Re-check episodes after load completes (handles race with loadEpisodes)
  const episodesForProject = useEpisodeStore(
    useCallback((s) => s.episodesByProject[canvasProjectId ?? ''] ?? null, [canvasProjectId])
  );
  const [episodeLoadKey, setEpisodeLoadKey] = useState(0);
  useEffect(() => {
    if (episodesForProject && episodeLoadKey === 0) {
      setEpisodeLoadKey(1); // Signal that episodes are ready
    }
  }, [episodesForProject, episodeLoadKey]);

  useEffect(() => {
    isRestoringCanvasRef.current = true;
    const project = getCurrentProject();
    if (project) {
      const epId = useEpisodeStore.getState().currentEpisodeId;
      const episodes = useEpisodeStore.getState().episodesByProject[project.id];

      // If in episode context but episodes haven't loaded yet, wait (don't clear canvas)
      if (epId && !episodes) {
        return;
      }

      const episode = epId && episodes ? episodes.find((ep) => ep.id === epId) : undefined;

      if (episode && episode.nodes.length > 0) {
        // Restore from episode data
        setCanvasData(episode.nodes, episode.edges, episode.history);
        setViewportState(episode.viewport ?? DEFAULT_VIEWPORT);
        requestAnimationFrame(() => {
          reactFlowInstance.setViewport(episode.viewport ?? DEFAULT_VIEWPORT, { duration: 0 });
        });
      } else if (episode && project.nodes.length > 0) {
        // Migration: only for projects without any episode data (first-time migration)
        // If other episodes already have data, project-level data is stale → show empty
        const hasAnyEpisodeData = episodes.some((ep) => ep.nodes.length > 0);
        if (!hasAnyEpisodeData) {
          setCanvasData(project.nodes, project.edges, project.history);
          setViewportState(project.viewport ?? DEFAULT_VIEWPORT);
          requestAnimationFrame(() => {
            reactFlowInstance.setViewport(project.viewport ?? DEFAULT_VIEWPORT, { duration: 0 });
          });
          // Immediately persist project data to episode so it's not lost
          saveCurrentEpisodeCanvas(project.id, epId!, project.nodes, project.edges, project.viewport, project.history);
        } else {
          // Episode exists but empty, and other episodes already have data → show empty canvas
          setCanvasData([], [], { past: [], future: [] });
          setViewportState(DEFAULT_VIEWPORT);
        }
      } else if (project.nodes.length > 0) {
        // Fallback: restore from project-level data (pre-episode projects)
        setCanvasData(project.nodes, project.edges, project.history);
        setViewportState(project.viewport ?? DEFAULT_VIEWPORT);
        requestAnimationFrame(() => {
          reactFlowInstance.setViewport(project.viewport ?? DEFAULT_VIEWPORT, { duration: 0 });
        });
      } else {
        // Empty canvas
        setCanvasData([], [], { past: [], future: [] });
        setViewportState(DEFAULT_VIEWPORT);
      }
    } else {
      setViewportState(DEFAULT_VIEWPORT);
    }
    const restoreTimer = setTimeout(() => {
      isRestoringCanvasRef.current = false;
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      isRestoringCanvasRef.current = false; // MUST reset before save, otherwise persistCanvasSnapshot skips saving
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      closeImageViewer();

      // Use closure-captured currentEpisodeId (the episode we're LEAVING).
      // persistCanvasSnapshot reads from zustand which already has the NEW
      // episode ID — saving canvas data to the wrong episode slot.
      const project = getCurrentProject();
      if (project && currentEpisodeId) {
        const currentNodes = useCanvasStore.getState().nodes;
        const currentEdges = useCanvasStore.getState().edges;
        const currentHistory = useCanvasStore.getState().history;

        // getViewport() may throw if ReactFlow instance is already torn down during unmount.
        // Catch gracefully and use a default viewport to avoid silently losing the save.
        let viewport: Viewport;
        try {
          viewport = reactFlowInstance.getViewport();
        } catch {
          viewport = { x: 0, y: 0, zoom: 1 };
          console.warn('[Canvas] cleanup: reactFlowInstance.getViewport() threw, using default viewport');
        }

        console.info(
          `[Canvas] cleanup: saving episode ${currentEpisodeId} with ${currentNodes.length} nodes, ${currentEdges.length} edges`
        );
        saveCurrentEpisodeCanvas(
          project.id,
          currentEpisodeId,
          currentNodes,
          currentEdges,
          viewport,
          currentHistory,
        );
      } else {
        persistCanvasSnapshot();
      }
    };
  }, [
    closeImageViewer,
    getCurrentProject,
    persistCanvasSnapshot,
    reactFlowInstance,
    saveCurrentEpisodeCanvas,
    setCanvasData,
    setViewportState,
    currentEpisodeId,
    episodeLoadKey,
  ]);

  useEffect(() => {
    if (isRestoringCanvasRef.current || dragHistorySnapshot) {
      return;
    }

    scheduleCanvasPersist();
  }, [nodes, edges, history, dragHistorySnapshot, scheduleCanvasPersist]);

  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    const pendingExportNodes = nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.exportImage) {
        return false;
      }
      const data = node.data as Record<string, unknown>;
      return data.isGenerating === true && typeof data.generationJobId === 'string' && data.generationJobId.length > 0;
    });

    for (const pendingNode of pendingExportNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        try {
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            const isGenerating = currentData.isGenerating === true;
            if (!jobId || !isGenerating) {
              break;
            }

            const generationProviderId = typeof currentData.generationProviderId === 'string'
              ? currentData.generationProviderId
              : '';
            if (generationProviderId) {
              const providerApiKey = apiKeys[generationProviderId] ?? '';
              if (providerApiKey) {
                await canvasAiGateway.setApiKey(generationProviderId, providerApiKey).catch((error) => {
                  console.warn('[GenerationJob] set_api_key failed before poll', {
                    nodeId: pendingNode.id,
                    generationProviderId,
                    error,
                  });
                });
              }
            }

            const status = await canvasAiGateway.getGenerateImageJob(jobId).catch((error) => {
              console.warn('[GenerationJob] poll failed', { nodeId: pendingNode.id, jobId, error });
              return null;
            });
            if (!status) {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'queued' || status.status === 'running') {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              const prepared = await prepareNodeImage(status.result);
              const storyboardMetadataRaw = currentData.generationStoryboardMetadata as GenerationStoryboardMetadata | undefined;
              const hasStoryboardMetadata = Boolean(
                storyboardMetadataRaw
                && Number.isFinite(storyboardMetadataRaw.gridRows)
                && Number.isFinite(storyboardMetadataRaw.gridCols)
                && Array.isArray(storyboardMetadataRaw.frameNotes)
              );
              let imageWithMetadata = prepared.imageUrl;
              if (hasStoryboardMetadata && storyboardMetadataRaw) {
                imageWithMetadata = await embedStoryboardImageMetadata(prepared.imageUrl, {
                  gridRows: Math.max(1, Math.round(storyboardMetadataRaw.gridRows)),
                  gridCols: Math.max(1, Math.round(storyboardMetadataRaw.gridCols)),
                  frameNotes: storyboardMetadataRaw.frameNotes,
                }).catch((error) => {
                  console.warn('[GenerationJob] embed storyboard metadata failed', {
                    nodeId: pendingNode.id,
                    error,
                  });
                  return prepared.imageUrl;
                });
              }
              const previewWithMetadata = prepared.previewImageUrl === prepared.imageUrl
                ? imageWithMetadata
                : prepared.previewImageUrl;

              updateNodeData(pendingNode.id, {
                imageUrl: imageWithMetadata,
                previewImageUrl: previewWithMetadata,
                aspectRatio: prepared.aspectRatio,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationClientSessionId: null,
                generationStoryboardMetadata: undefined,
                generationError: null,
                generationErrorDetails: null,
                generationDebugContext: undefined,
              });
              // 生成成功，立即持久化项目数据（绕过所有 debounce）
              try {
                const freshNodes = useCanvasStore.getState().nodes;
                const freshEdges = useCanvasStore.getState().edges;
                const freshHistory = useCanvasStore.getState().history;
                const freshViewport = reactFlowInstance?.getViewport();
                useProjectStore.getState().saveCurrentProject(
                  freshNodes, freshEdges, freshViewport, freshHistory, { immediate: true }
                );
              } catch (persistErr) {
                console.warn('[GenerationJob] immediate persist after generation failed', persistErr);
              }
              break;
            }

            const errorMessage = status.error ?? (status.status === 'not_found' ? 'generation job not found' : 'generation failed');
            const generationClientSessionId = typeof currentData.generationClientSessionId === 'string'
              ? currentData.generationClientSessionId
              : '';
            const shouldShowDialog = generationClientSessionId === CURRENT_RUNTIME_SESSION_ID;
            if (shouldShowDialog) {
              const reportText = buildGenerationErrorReport({
                errorMessage,
                errorDetails: status.error ?? undefined,
                context: currentData.generationDebugContext,
              });
              void showErrorDialog(errorMessage, t('common.error'), status.error ?? undefined, reportText);
            }
            updateNodeData(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationClientSessionId: null,
              generationStoryboardMetadata: undefined,
              generationError: errorMessage,
              generationErrorDetails: status.error ?? null,
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [apiKeys, nodes, updateNodeData]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [setCanvasViewportSize]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      applyNodesChange(changes);

      const hasDragMove = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      if (hasInteractionMove) {
        return;
      }

      if (hasInteractionEnd) {
        scheduleCanvasPersist(0);
        return;
      }

      scheduleCanvasPersist();
    },
    [applyNodesChange, scheduleCanvasPersist]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      applyEdgesChange(changes);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist]
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist]
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!canNodeBeManualConnectionSource(connection.source, nodes)) {
        return;
      }
      connectNodes(connection);
      scheduleCanvasPersist(0);
    },
    [connectNodes, nodes, scheduleCanvasPersist]
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);

      // Also save viewport to episode
      const epId = useEpisodeStore.getState().currentEpisodeId;
      if (epId) {
        const ep = useEpisodeStore.getState().episodesByProject[project.id]?.find((e) => e.id === epId);
        if (ep) {
          useEpisodeStore.getState().saveCurrentEpisodeCanvas(
            project.id, epId, ep.nodes, ep.edges, viewport, ep.history,
          );
        }
      }
    },
    [getCurrentProject, saveCurrentProjectViewport, setViewportState]
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
    },
    [setViewportState]
  );

  const handleMoveStart = useCallback(() => {
    cancelPendingViewportPersist();
  }, [cancelPendingViewportPersist]);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const edgePathSelector = '.react-flow__edge-path, .react-flow__edge-interaction';
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest('.react-flow__edgeupdater')) {
        return;
      }

      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
      cancelPendingViewportPersist();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }

      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;

      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }

      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 }
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }

      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);

      // Also save viewport to episode
      const epId = useEpisodeStore.getState().currentEpisodeId;
      if (epId) {
        const ep = useEpisodeStore.getState().episodesByProject[project.id]?.find((e) => e.id === epId);
        if (ep) {
          useEpisodeStore.getState().saveCurrentEpisodeCanvas(
            project.id, epId, ep.nodes, ep.edges, viewport, ep.history,
          );
        }
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    cancelPendingViewportPersist,
    getCurrentProject,
    reactFlowInstance,
    saveCurrentProjectViewport,
    setViewportState,
  ]);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id),
    [nodes]
  );
  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [nodes, selectedNodeIds]);

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }

    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      pasteImageHandledRef.current = false;
      if (!selectedUploadNodeId || isTypingTarget(event.target)) {
        return;
      }

      const imageFile = resolveClipboardImageFile(event);
      if (!imageFile) {
        return;
      }

      event.preventDefault();
      pasteImageHandledRef.current = true;
      canvasEventBus.publish('upload-node/paste-image', {
        nodeId: selectedUploadNodeId,
        file: imageFile,
      });
    };

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [selectedUploadNodeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }

      const commandPressed = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const isUndo = commandPressed && key === 'z' && !event.shiftKey;
      const isRedo = commandPressed && (key === 'y' || (key === 'z' && event.shiftKey));
      const isGroup = commandPressed && key === 'g';
      const isCopy = commandPressed && key === 'c' && !event.shiftKey;
      const isPaste = commandPressed && key === 'v' && !event.shiftKey;

      if (isCopy) {
        // If user has selected text (e.g. in chat panel), let browser handle copy
        if (window.getSelection()?.toString()) {
          return;
        }
        if (selectedNodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        const selectedIdSet = new Set(selectedNodeIds);
        copiedSnapshotRef.current = {
          nodes: nodes.filter((node) => selectedIdSet.has(node.id)),
          edges: edges.filter(
            (edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target)
          ),
        };
        return;
      }

      if (isPaste) {
        if (selectedUploadNodeId) {
          pasteImageHandledRef.current = false;
          window.setTimeout(() => {
            if (pasteImageHandledRef.current) {
              pasteImageHandledRef.current = false;
              return;
            }

            if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
              return;
            }

            void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
          }, 0);
          return;
        }

        if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
          return;
        }
        event.preventDefault();
        void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
        return;
      }

      if (isUndo || isRedo) {
        event.preventDefault();
        const changed = isUndo ? undo() : redo();
        if (changed) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (isGroup) {
        if (selectedNodeIds.length < 2) {
          return;
        }
        event.preventDefault();
        const createdGroupId = groupNodes(selectedNodeIds);
        if (createdGroupId) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }

      const idsToDelete = selectedNodeIds.length > 0
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : [];
      if (idsToDelete.length === 0) {
        return;
      }

      event.preventDefault();
      if (idsToDelete.length === 1) {
        deleteNode(idsToDelete[0]);
      } else {
        deleteNodes(idsToDelete);
      }
      scheduleCanvasPersist(0);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    edges,
    nodes,
    selectedNodeId,
    selectedNodeIds,
    deleteNode,
    deleteNodes,
    groupNodes,
    undo,
    redo,
    scheduleCanvasPersist,
    selectedUploadNodeId,
  ]);

  const openNodeMenuAtClientPosition = useCallback((clientX: number, clientY: number) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }

    const flowPos = reactFlowInstance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });

    setFlowPosition(flowPos);
    setMenuPosition({
      x: clientX - containerRect.left,
      y: clientY - containerRect.top,
    });
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
    setShowNodeMenu(true);
  }, [reactFlowInstance]);

  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (suppressNextPaneClickRef.current) {
      suppressNextPaneClickRef.current = false;
      return;
    }

    // 仅当画布已有节点时允许双击弹出菜单（避免新用户空画布双击误操作）
    if (event.detail >= 2 && nodes.length > 0) {
      openNodeMenuAtClientPosition(event.clientX, event.clientY);
      return;
    }

    setSelectedNode(null);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, [openNodeMenuAtClientPosition, setSelectedNode]);

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType) => {
      const newNodeId = addNode(type, flowPosition);
      if (pendingConnectStart) {
        if (pendingConnectStart.handleType === 'source') {
          connectNodes({
            source: pendingConnectStart.nodeId,
            target: newNodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
        } else {
          connectNodes({
            source: newNodeId,
            target: pendingConnectStart.nodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
        }
      }

      scheduleCanvasPersist(0);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
    },
    [
      addNode,
      connectNodes,
      flowPosition,
      pendingConnectStart,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
    ]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const dedupedIds = Array.from(new Set(sourceNodeIds));
      if (dedupedIds.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceNodes = nodes.filter((node) => dedupedIds.includes(node.id));
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = edges.filter(
        (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
      );

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];

      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        return !hasRectCollision(
          {
            x: node.position.x + offset.x + offsetStep * 8,
            y: node.position.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });

      if (!options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }

        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          {
            x: sourceNode.position.x + chosenOffset.x + offsetStep * 8,
            y: sourceNode.position.y + chosenOffset.y + offsetStep * 6,
          },
          { ...data }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }

      for (const edge of internalEdges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) {
          continue;
        }
        connectNodes({
          source: nextSource,
          target: nextTarget,
          sourceHandle: edge.sourceHandle ?? 'source',
          targetHandle: edge.targetHandle ?? 'target',
        });
      }

      if (!options.disableOffsetIteration) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (firstNodeId && !options.suppressSelect) {
        setSelectedNode(firstNodeId);
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }
      return { firstNodeId, idMap };
    },
    [addNode, applyNodesChange, connectNodes, edges, nodes, scheduleCanvasPersist, setSelectedNode]
  );

  useEffect(() => {
    duplicateNodesRef.current = (sourceNodeIds: string[]) => duplicateNodes(sourceNodeIds)?.firstNodeId ?? null;
  }, [duplicateNodes]);

  // Listen for chat-fill-grid custom event to create StoryboardGenNode on canvas.
  // Creates a 6-grid (2×3) by default, auto-matches reference images from project assets.
  useEffect(() => {
    const handleChatFillGrid = (e: Event) => {
      const detail = (e as CustomEvent<{
        prompt: string;
        rows: number;
        cols: number;
        frames?: Array<{ description: string }>;
        conversationId?: string;
        shotFrameMap?: ShotFrameMap;
      }>).detail;
      const wrapper = wrapperRef.current;
      if (!wrapper || !reactFlowInstance) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      const rect = wrapper.getBoundingClientRect();
      const centerX = (rect.width / 2 - viewport.x) / viewport.zoom;
      const centerY = (rect.height / 2 - viewport.y) / viewport.zoom;

      const totalFrames = detail.rows * detail.cols;

      // Use frames from chat store if available (exact match with conversation);
      // fall back to regex parse for backward compatibility
      let descriptions: string[];
      if (detail.frames && detail.frames.length >= 2) {
        descriptions = detail.frames.slice(0, totalFrames).map((f: any) => f.description || '');
        while (descriptions.length < totalFrames) {
          descriptions.push('');
        }
      } else {
        descriptions = splitGridPromptIntoFrames(detail.prompt, totalFrames);
      }

      const frames = descriptions.map((desc) => ({
        id: `frame-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        description: desc,
        referenceIndex: null,
      }));

      // Auto-match reference images from project assets
      const matchedAssets: Array<{ name: string; filePath: string; index: number }> = [];
      const projectId = useProjectStore.getState().currentProject?.id;
      if (projectId) {
        const allAssets = useAssetStore.getState().getAssets(projectId);
        for (const asset of allAssets) {
          if (detail.prompt.includes(asset.name) && asset.filePath) {
            matchedAssets.push({
              name: asset.name,
              filePath: asset.filePath,
              index: matchedAssets.length,
            });
          }
        }
      }

      // Create upload nodes for matched assets
      const uploadNodeIds: string[] = [];
      if (matchedAssets.length > 0) {
        const uploadNodeWidth = 160;
        const spacing = 20;
        const totalWidth = matchedAssets.length * uploadNodeWidth + (matchedAssets.length - 1) * spacing;
        const startX = centerX - totalWidth / 2;
        const uploadY = centerY + 220;

        matchedAssets.forEach((asset, i) => {
          const nodeId = addNode(CANVAS_NODE_TYPES.upload, {
            x: startX + i * (uploadNodeWidth + spacing),
            y: uploadY,
          }, {
            imageUrl: asset.filePath,
            previewImageUrl: null,
            aspectRatio: '1:1',
            displayName: asset.name,
          });
          if (nodeId) {
            uploadNodeIds.push(nodeId);
          }
        });
      }

      // Create StoryboardGenNode — always 6-grid
      const sgNodeId = addNode(CANVAS_NODE_TYPES.storyboardGen, { x: centerX, y: centerY }, {
        gridRows: detail.rows,
        gridCols: detail.cols,
        frames,
        sourceConversationId: detail.conversationId,
        shotFrameMap: detail.shotFrameMap,
      });

      // Connect upload nodes to StoryboardGenNode
      if (sgNodeId) {
        uploadNodeIds.forEach((uploadId) => {
          addEdge(uploadId, sgNodeId);
        });
      }
    };

    window.addEventListener('chat-fill-grid', handleChatFillGrid);
    return () => window.removeEventListener('chat-fill-grid', handleChatFillGrid);
  }, [reactFlowInstance, addNode, addEdge]);

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPreviewConnectionVisual(null);

      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }

      if (
        params.handleType === 'source'
        && !canNodeBeManualConnectionSource(params.nodeId, nodes)
      ) {
        setPendingConnectStart(null);
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.('.react-flow__handle') as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        start,
      });
    },
    [nodes]
  );

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }

      const sourceNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds
        : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }

      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }

      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }

      // Keep the duplicated nodes visually above the original dragged node.
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));

      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, nodes, selectedNodeIds]
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [applyNodesChange]
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      altDragCopyRef.current = null;

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [applyNodesChange, scheduleCanvasPersist, setSelectedNode]
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const nodeElementFromPoint = document.elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        const sourceNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pendingConnectStart.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          connectNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const allowedTypes = resolveAllowedNodeTypes(pendingConnectStart.handleType);
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;

      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === 'source'
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }

      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: 'rgba(255,255,255,0.9)',
          strokeWidth: 1,
          strokeLinecap: 'round',
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }

      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [connectNodes, nodes, pendingConnectStart, reactFlowInstance, scheduleCanvasPersist]
  );

  const emptyHint = useMemo(
    () => (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="flex max-w-3xl flex-col items-center gap-5 px-6 text-center">
          {configuredApiKeyCount === 0 && <MissingApiKeyHint />}
          <div className="flex items-center gap-4">
            <svg width="36" height="36" viewBox="0 0 48 48" fill="none" className="text-[var(--accent)]/60 animate-pulse shrink-0">
              <path d="M38 24H14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M22 14L12 24L22 34" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="text-left">
              <div className="text-2xl text-[var(--text)] font-medium">{t('canvas.emptyHintTitle')}</div>
              <div className="text-sm text-text-muted mt-1">{t('canvas.emptyHintSubtitle')}</div>
            </div>
          </div>
        </div>
      </div>
    ),
    [configuredApiKeyCount, t]
  );

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full"
      onContextMenu={(e) => {
        // 阻止右键菜单防止用户在生成或编辑中误刷新导致数据丢失
        e.preventDefault();
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'disconnectableEdge' }}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={5}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Control', 'Meta']}
        selectionKeyCode={['Control', 'Meta']}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="bg-bg-dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a2a" />
        <MiniMap
          className="canvas-minimap nopan nowheel !border-border-dark !bg-surface-dark"
          style={{ pointerEvents: 'all', zIndex: 10000 }}
          nodeColor="rgba(120, 120, 120, 0.92)"
          maskColor="rgba(0, 0, 0, 0.62)"
          pannable
          zoomable
        />

        <SelectedNodeOverlay />
      </ReactFlow>

      {nodes.length === 0 && emptyHint}
      {nodes.length > 0 && configuredApiKeyCount === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
          <MissingApiKeyHint />
        </div>
      )}

      {showNodeMenu && previewConnectionVisual && (
        <svg
          className="pointer-events-none absolute z-40 overflow-visible"
          style={{
            left: previewConnectionVisual.left,
            top: previewConnectionVisual.top,
            width: previewConnectionVisual.width,
            height: previewConnectionVisual.height,
          }}
          width={previewConnectionVisual.width}
          height={previewConnectionVisual.height}
        >
          <path
            className="pointer-events-none"
            d={previewConnectionVisual.d}
            fill="none"
            stroke={previewConnectionVisual.stroke}
            strokeWidth={previewConnectionVisual.strokeWidth}
            strokeLinecap={previewConnectionVisual.strokeLinecap}
          />
        </svg>
      )}

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          onSelect={handleNodeSelect}
          onClose={() => {
            setShowNodeMenu(false);
            setMenuAllowedTypes(undefined);
            setPendingConnectStart(null);
            setPreviewConnectionVisual(null);
          }}
        />
      )}

      <NodeToolDialog />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />

      <ChatPanel
        isOpen={showChatPanel}
        onToggle={() => setShowChatPanel((prev) => !prev)}
      />
    </div>
  );
}
