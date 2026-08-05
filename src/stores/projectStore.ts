import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Viewport } from '@xyflow/react';
import {
  useCanvasStore,
  type CanvasEdge,
  type CanvasHistoryState,
  type CanvasNode,
  type CanvasNodeData,
} from './canvasStore';
import { useEpisodeStore } from './episodeStore';
import {
  deleteProjectRecord,
  getProjectRecord,
  listProjectSummaries,
  renameProjectRecord,
  updateProjectViewportRecord,
  upsertProjectRecord,
  type ProjectRecord,
  type ProjectSummaryRecord,
} from '@/commands/projectState';

const DEFAULT_VIEWPORT: Viewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

function createEmptyHistory(): CanvasHistoryState {
  return {
    past: [],
    future: [],
  };
}

const IMAGE_REF_PREFIX = '__img_ref__:';
let openProjectRequestSeq = 0;
const UPSERT_DEBOUNCE_MS = 260;
const VIEWPORT_UPSERT_DEBOUNCE_MS = 280;
const VIEWPORT_EPSILON = 0.001;
const IDLE_PERSIST_TIMEOUT_MS = 1200;
const FALLBACK_IDLE_DELAY_MS = 64;
const MAX_PERSISTED_HISTORY_STEPS = 12;
const MAX_HISTORY_RESTORE_JSON_CHARS = 1_500_000;
const DELETE_RETRY_DELAY_MS = 80;
const MAX_DELETE_RETRIES = 10;

const queuedProjectUpserts = new Map<string, Project>();
const projectUpsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectUpsertsInFlight = new Set<string>();
const queuedViewportUpserts = new Map<string, string>();
const viewportUpsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
const viewportUpsertsInFlight = new Set<string>();
const deletingProjectIds = new Set<string>();

export interface EmphasisDimension {
  key: string;
  label: string;
  enabled: boolean;
  template: string;
}

const DEFAULT_EMPHASIS_DIMENSIONS: EmphasisDimension[] = [
  { key: 'drone_aerial', label: '航拍运镜', enabled: false, template: '' },
  { key: 'walkthrough', label: '探店动线', enabled: false, template: '' },
  { key: 'lighting', label: '光影时刻', enabled: false, template: '' },
  { key: 'space_flow', label: '空间流线', enabled: false, template: '' },
  { key: 'food_detail', label: '美食特写', enabled: false, template: '' },
  { key: 'landmark_framing', label: '地标构图', enabled: false, template: '' },
  { key: 'seasonal', label: '季节时令', enabled: false, template: '' },
  { key: 'local_culture', label: '在地文化', enabled: false, template: '' },
  { key: 'crowd_atmosphere', label: '人气氛围', enabled: false, template: '' },
  { key: 'transition_flow', label: '场景过渡', enabled: false, template: '' },
];

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface Project extends ProjectSummary {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  history: CanvasHistoryState;

  // 项目参数（新建项目时设置，可在仪表盘修改）
  videoType: string;
  aspectRatio: string;
  style: string;
  tone: string;
  directorRef: string;
  emphasisDimensions: EmphasisDimension[];
  aiAnalysis: string;
  aiParams: string;          // JSON Record<string, string>
  globalParamsMdPath: string;
}

type PersistedProject = Project & {
  imagePool?: string[];
};

function encodeImageReference(
  imageUrl: string | null | undefined,
  imagePool: string[],
  imageIndexMap: Map<string, number>
): string | null | undefined {
  if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
    return imageUrl;
  }

  const existingIndex = imageIndexMap.get(imageUrl);
  if (typeof existingIndex === 'number') {
    return `${IMAGE_REF_PREFIX}${existingIndex}`;
  }

  const nextIndex = imagePool.length;
  imagePool.push(imageUrl);
  imageIndexMap.set(imageUrl, nextIndex);
  return `${IMAGE_REF_PREFIX}${nextIndex}`;
}

function decodeImageReference(
  imageUrl: string | null | undefined,
  imagePool: string[] | undefined,
  _nodeId?: string,
  _field?: string,
): string | null | undefined {
  if (typeof imageUrl !== 'string' || !imagePool || !imageUrl.startsWith(IMAGE_REF_PREFIX)) {
    return imageUrl;
  }

  const index = Number.parseInt(imageUrl.slice(IMAGE_REF_PREFIX.length), 10);
  if (!Number.isFinite(index) || index < 0) {
    return imageUrl;
  }

  if (imagePool[index] == null) {
    console.warn(
      `[projectStore] Image pool index ${index} out of bounds (pool size=${imagePool.length})` +
      (_nodeId ? ` for node=${_nodeId}` : '') + (_field ? ` field=${_field}` : '')
    );
    return null;
  }

  return imagePool[index];
}

function mapNodeImageReferences(
  nodes: CanvasNode[],
  mapImageUrl: (imageUrl: string | null | undefined) => string | null | undefined
): CanvasNode[] {
  return nodes.map((node) => {
    const nodeData = node.data as Record<string, unknown>;
    const nextData: Record<string, unknown> = { ...nodeData };

    if ('imageUrl' in nextData) {
      nextData.imageUrl = mapImageUrl(nextData.imageUrl as string | null | undefined) ?? null;
    }
    if ('previewImageUrl' in nextData) {
      nextData.previewImageUrl =
        mapImageUrl(nextData.previewImageUrl as string | null | undefined) ?? null;
    }

    // Encode gridCellImageUrls: array of image URLs used by video generation
    if (Array.isArray(nextData.gridCellImageUrls)) {
      nextData.gridCellImageUrls = (nextData.gridCellImageUrls as string[]).map(
        (url) => mapImageUrl(url) ?? null,
      );
    }

    if (Array.isArray(nextData.frames)) {
      nextData.frames = nextData.frames.map((frame) => {
        if (!frame || typeof frame !== 'object') {
          return frame;
        }

        const frameRecord = frame as Record<string, unknown>;
        if (!('imageUrl' in frameRecord)) {
          return frame;
        }

        return {
          ...frameRecord,
          imageUrl: mapImageUrl(frameRecord.imageUrl as string | null | undefined) ?? null,
          previewImageUrl:
            mapImageUrl(frameRecord.previewImageUrl as string | null | undefined) ?? null,
        };
      });
    }

    return {
      ...node,
      data: nextData as CanvasNodeData,
    };
  });
}

function mapHistoryImageReferences(
  history: CanvasHistoryState,
  mapImageUrl: (imageUrl: string | null | undefined) => string | null | undefined
): CanvasHistoryState {
  return {
    past: history.past.map((snapshot) => ({
      ...snapshot,
      nodes: mapNodeImageReferences(snapshot.nodes, mapImageUrl),
    })),
    future: history.future.map((snapshot) => ({
      ...snapshot,
      nodes: mapNodeImageReferences(snapshot.nodes, mapImageUrl),
    })),
  };
}

function trimHistoryForPersistence(history: CanvasHistoryState): CanvasHistoryState {
  return {
    past: history.past.slice(-MAX_PERSISTED_HISTORY_STEPS),
    future: history.future.slice(-MAX_PERSISTED_HISTORY_STEPS),
  };
}

function encodeProject(project: Project): PersistedProject {
  const imagePool: string[] = [];
  const imageIndexMap = new Map<string, number>();
  const encode = (imageUrl: string | null | undefined) =>
    encodeImageReference(imageUrl, imagePool, imageIndexMap);

  return {
    ...project,
    nodes: mapNodeImageReferences(project.nodes, encode),
    history: mapHistoryImageReferences(project.history, encode),
    imagePool,
  };
}

function decodeProject(project: PersistedProject): Project {
  const decode = (imageUrl: string | null | undefined) =>
    decodeImageReference(imageUrl, project.imagePool);

  return {
    ...project,
    nodes: mapNodeImageReferences(project.nodes, decode),
    history: mapHistoryImageReferences(project.history, decode),
  };
}

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractImagePoolFromHistoryJson(historyJson: string): string[] {
  const imagePoolKey = '"imagePool"';
  const keyIndex = historyJson.indexOf(imagePoolKey);
  if (keyIndex < 0) {
    return [];
  }

  const arrayStart = historyJson.indexOf('[', keyIndex + imagePoolKey.length);
  if (arrayStart < 0) {
    return [];
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayEnd = -1;

  for (let index = arrayStart; index < historyJson.length; index += 1) {
    const char = historyJson[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = index;
        break;
      }
    }
  }

  if (arrayEnd < 0) {
    return [];
  }

  const rawArrayJson = historyJson.slice(arrayStart, arrayEnd + 1);
  const parsed = safeParseJson<unknown>(rawArrayJson, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === 'string');
}

function toProjectSummary(record: ProjectSummaryRecord): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
  };
}

function toProjectRecord(project: Project): ProjectRecord {
  const encodedProject = encodeProject(project);
  const persistedNodes = encodedProject.nodes;
  const persistedHistory = trimHistoryForPersistence(encodedProject.history);

  return {
    id: encodedProject.id,
    name: encodedProject.name,
    createdAt: encodedProject.createdAt,
    updatedAt: encodedProject.updatedAt,
    nodeCount: encodedProject.nodeCount,
    nodesJson: JSON.stringify(persistedNodes),
    edgesJson: JSON.stringify(encodedProject.edges),
    viewportJson: JSON.stringify(encodedProject.viewport),
    historyJson: JSON.stringify({
      ...persistedHistory,
      imagePool: encodedProject.imagePool ?? [],
    }),
    videoType: encodedProject.videoType,
    aspectRatio: encodedProject.aspectRatio,
    style: encodedProject.style,
    tone: encodedProject.tone,
    directorRef: encodedProject.directorRef,
    emphasisDimensions: JSON.stringify(encodedProject.emphasisDimensions),
    aiAnalysis: encodedProject.aiAnalysis,
    aiParams: encodedProject.aiParams,
    globalParamsMdPath: encodedProject.globalParamsMdPath,
  };
}

function fromProjectRecord(record: ProjectRecord): Project {
  console.log('[DEBUG] fromProjectRecord: id=%s, name=%s, aspectRatio=%s, emphasisDimensions=%s',
    record.id, record.name, record.aspectRatio, record.emphasisDimensions?.slice(0, 80));
  const parsedNodes = safeParseJson<CanvasNode[]>(record.nodesJson, []);
  const parsedEdges = safeParseJson<CanvasEdge[]>(record.edgesJson, []);
  const parsedViewport = safeParseJson<Viewport>(record.viewportJson, DEFAULT_VIEWPORT);
  const extractedImagePool = extractImagePoolFromHistoryJson(record.historyJson);

  // Progressive history truncation: when JSON exceeds the limit, keep as many
  // recent past snapshots as fit. Drop future first (less valuable than undo).
  let truncated = false;
  const fullHistoryPayload = safeParseJson<{
    past?: CanvasHistoryState['past'];
    future?: CanvasHistoryState['future'];
    imagePool?: string[];
  }>(record.historyJson, {});
  let parsedPast = fullHistoryPayload.past ?? [];
  let parsedFuture = fullHistoryPayload.future ?? [];

  if (record.historyJson.length > MAX_HISTORY_RESTORE_JSON_CHARS) {
    truncated = true;
    // Priority: keep most recent past snapshots; drop future first
    let estimate = 0;
    const keptPast: typeof parsedPast = [];
    // Iterate from newest (end) to oldest (start)
    for (let i = parsedPast.length - 1; i >= 0; i--) {
      const snapshotStr = JSON.stringify(parsedPast[i]);
      if (estimate + snapshotStr.length < MAX_HISTORY_RESTORE_JSON_CHARS) {
        keptPast.unshift(parsedPast[i]);
        estimate += snapshotStr.length;
      } else {
        break;
      }
    }
    parsedPast = keptPast;
    parsedFuture = []; // future is less valuable — drop entirely when oversized

    console.warn(
      `[projectStore] History trimmed: ${record.historyJson.length} → ~${estimate} chars, ` +
      `past ${fullHistoryPayload.past?.length ?? 0} → ${keptPast.length}, future dropped`
    );
  }

  const parsedHistory = {
    past: parsedPast,
    future: parsedFuture,
  };

  // Notify UI when history was truncated so it can show a toast
  if (truncated) {
    try {
      window.dispatchEvent(
        new CustomEvent('history-truncated', {
          detail: {
            projectId: record.id,
            originalPastCount: fullHistoryPayload.past?.length ?? 0,
            keptCount: parsedPast.length,
          },
        })
      );
    } catch { /* non-critical */ }
  }

  const persistedProject: PersistedProject = {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    nodes: parsedNodes,
    edges: parsedEdges,
    viewport: parsedViewport ?? DEFAULT_VIEWPORT,
    history: parsedHistory,
    imagePool: fullHistoryPayload.imagePool ?? extractedImagePool,
    // 从记录读取新字段（兼容旧项目，给空默认值）
    aspectRatio: record.aspectRatio ?? '',
    style: record.style ?? '',
    tone: record.tone ?? '',
    directorRef: record.directorRef ?? '',
    videoType: record.videoType ?? '',
    emphasisDimensions: record.emphasisDimensions
      ? safeParseJson(record.emphasisDimensions, DEFAULT_EMPHASIS_DIMENSIONS.map((d) => ({ ...d })))
      : DEFAULT_EMPHASIS_DIMENSIONS.map((d) => ({ ...d })),
    aiAnalysis: record.aiAnalysis ?? '',
    aiParams: record.aiParams ?? '{}',
    globalParamsMdPath: record.globalParamsMdPath ?? '',
  };

  const decodedProject = decodeProject(persistedProject);
  return {
    ...decodedProject,
    nodeCount: parsedNodes.length,
    viewport: decodedProject.viewport ?? DEFAULT_VIEWPORT,
    history: decodedProject.history ?? createEmptyHistory(),
  };
}

interface PersistProjectOptions {
  immediate?: boolean;
  debounceMs?: number;
}

interface PersistViewportOptions {
  immediate?: boolean;
  debounceMs?: number;
}

function scheduleIdlePersist(task: () => void): void {
  const idleHost = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };

  if (typeof idleHost.requestIdleCallback === 'function') {
    idleHost.requestIdleCallback(task, { timeout: IDLE_PERSIST_TIMEOUT_MS });
    return;
  }

  setTimeout(task, FALLBACK_IDLE_DELAY_MS);
}

function hasViewportMeaningfulDelta(current: Viewport, next: Viewport): boolean {
  return (
    Math.abs(current.x - next.x) > VIEWPORT_EPSILON ||
    Math.abs(current.y - next.y) > VIEWPORT_EPSILON ||
    Math.abs(current.zoom - next.zoom) > VIEWPORT_EPSILON
  );
}

function normalizeViewport(viewport: Viewport): Viewport {
  return {
    x: Number(viewport.x.toFixed(2)),
    y: Number(viewport.y.toFixed(2)),
    zoom: Number(viewport.zoom.toFixed(4)),
  };
}

function clearQueuedProjectUpsert(projectId: string): void {
  const timer = projectUpsertTimers.get(projectId);
  if (timer) {
    clearTimeout(timer);
    projectUpsertTimers.delete(projectId);
  }
  queuedProjectUpserts.delete(projectId);
}

function clearQueuedViewportUpsert(projectId: string): void {
  const timer = viewportUpsertTimers.get(projectId);
  if (timer) {
    clearTimeout(timer);
    viewportUpsertTimers.delete(projectId);
  }
  queuedViewportUpserts.delete(projectId);
}

interface FlushProjectUpsertOptions {
  bypassIdle?: boolean;
}

function flushProjectUpsert(projectId: string, options?: FlushProjectUpsertOptions): void {
  if (deletingProjectIds.has(projectId) || projectUpsertsInFlight.has(projectId)) {
    return;
  }

  const project = queuedProjectUpserts.get(projectId);
  if (!project) {
    return;
  }

  queuedProjectUpserts.delete(projectId);
  projectUpsertsInFlight.add(projectId);

  const settle = () => {
    projectUpsertsInFlight.delete(projectId);

    if (deletingProjectIds.has(projectId)) {
      return;
    }

    if (queuedProjectUpserts.has(projectId)) {
      flushProjectUpsert(projectId);
    }
  };

  const executePersist = () => {
    if (deletingProjectIds.has(projectId)) {
      settle();
      return;
    }

    const record = toProjectRecord(project);
    void upsertProjectRecord(record)
      .catch((error) => {
        console.error('Failed to persist project record', error);
      })
      .finally(settle);
  };

  if (options?.bypassIdle) {
    executePersist();
    return;
  }

  scheduleIdlePersist(executePersist);
}

function queueProjectUpsert(project: Project, options?: PersistProjectOptions): void {
  const projectId = project.id;
  deletingProjectIds.delete(projectId);
  queuedProjectUpserts.set(projectId, project);

  const existingTimer = projectUpsertTimers.get(projectId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    projectUpsertTimers.delete(projectId);
  }

  const debounceMs = options?.immediate ? 0 : (options?.debounceMs ?? UPSERT_DEBOUNCE_MS);
  if (debounceMs <= 0) {
    flushProjectUpsert(projectId, { bypassIdle: true });
    return;
  }

  const timer = setTimeout(() => {
    projectUpsertTimers.delete(projectId);
    flushProjectUpsert(projectId);
  }, debounceMs);
  projectUpsertTimers.set(projectId, timer);
}

function persistProject(project: Project, options?: PersistProjectOptions): void {
  clearQueuedViewportUpsert(project.id);
  queueProjectUpsert(project, options);
}

function flushViewportUpsert(projectId: string): void {
  if (deletingProjectIds.has(projectId) || viewportUpsertsInFlight.has(projectId)) {
    return;
  }

  const viewportJson = queuedViewportUpserts.get(projectId);
  if (typeof viewportJson !== 'string') {
    return;
  }

  queuedViewportUpserts.delete(projectId);
  viewportUpsertsInFlight.add(projectId);

  void updateProjectViewportRecord(projectId, viewportJson)
    .catch((error) => {
      console.error('Failed to persist project viewport', error);
    })
    .finally(() => {
      viewportUpsertsInFlight.delete(projectId);

      if (deletingProjectIds.has(projectId)) {
        return;
      }

      if (queuedViewportUpserts.has(projectId)) {
        flushViewportUpsert(projectId);
      }
    });
}

function queueViewportUpsert(
  projectId: string,
  viewport: Viewport,
  options?: PersistViewportOptions
): void {
  deletingProjectIds.delete(projectId);
  queuedViewportUpserts.set(projectId, JSON.stringify(viewport));

  const existingTimer = viewportUpsertTimers.get(projectId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    viewportUpsertTimers.delete(projectId);
  }

  const debounceMs = options?.immediate ? 0 : (options?.debounceMs ?? VIEWPORT_UPSERT_DEBOUNCE_MS);
  if (debounceMs <= 0) {
    flushViewportUpsert(projectId);
    return;
  }

  const timer = setTimeout(() => {
    viewportUpsertTimers.delete(projectId);
    flushViewportUpsert(projectId);
  }, debounceMs);
  viewportUpsertTimers.set(projectId, timer);
}

function flushAllProjectPersists(): void {
  // Force-flush all queued project upserts immediately (beforeunload safety net)
  for (const [projectId] of projectUpsertTimers) {
    clearTimeout(projectUpsertTimers.get(projectId));
    projectUpsertTimers.delete(projectId);
  }
  for (const projectId of queuedProjectUpserts.keys()) {
    flushProjectUpsert(projectId, { bypassIdle: true });
  }
  // Force-flush all queued viewport upserts
  for (const [projectId] of viewportUpsertTimers) {
    clearTimeout(viewportUpsertTimers.get(projectId));
    viewportUpsertTimers.delete(projectId);
  }
  for (const projectId of queuedViewportUpserts.keys()) {
    flushViewportUpsert(projectId);
  }
}

function persistProjectDelete(projectId: string): void {
  deletingProjectIds.add(projectId);
  clearQueuedProjectUpsert(projectId);
  clearQueuedViewportUpsert(projectId);

  const attemptDelete = (retryCount: number): void => {
    if (projectUpsertsInFlight.has(projectId) || viewportUpsertsInFlight.has(projectId)) {
      if (retryCount >= MAX_DELETE_RETRIES) {
        deletingProjectIds.delete(projectId);
        return;
      }

      setTimeout(() => {
        attemptDelete(retryCount + 1);
      }, DELETE_RETRY_DELAY_MS);
      return;
    }

    void deleteProjectRecord(projectId)
      .catch((error) => {
        console.error('Failed to delete project record', error);
      })
      .finally(() => {
        deletingProjectIds.delete(projectId);
      });
  };

  attemptDelete(0);
}

function updateProjectSummary(
  summaries: ProjectSummary[],
  updated: ProjectSummary
): ProjectSummary[] {
  const next = summaries.map((summary) => (summary.id === updated.id ? updated : summary));
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}

export type AppView = 'manager' | 'dashboard' | 'canvas';

interface ProjectState {
  projects: ProjectSummary[];
  currentProjectId: string | null;
  currentProject: Project | null;
  isHydrated: boolean;
  isOpeningProject: boolean;
  view: AppView;

  hydrate: () => Promise<void>;
  forceRehydrate: () => Promise<void>;
  createProject: (name: string) => string;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  copyProject: (id: string, newName: string) => Promise<string>;
  openProject: (id: string) => void;
  closeProject: () => void;
  reset: () => void;
  setView: (view: AppView) => void;
  getCurrentProject: () => Project | null;
  saveCurrentProject: (
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    viewport?: Viewport,
    history?: CanvasHistoryState,
    options?: { immediate?: boolean },
  ) => void;
  saveCurrentProjectViewport: (viewport: Viewport) => void;
  cancelPendingViewportPersist: () => void;
  updateProjectParams: (projectId: string, params: {
    videoType?: string;
    aspectRatio: string;
    style: string;
    tone: string;
    directorRef: string;
    emphasisKeys: string[];
  }) => void;
  saveProjectAnalysis: (projectId: string, analysis: {
    aiAnalysis?: string;
    aiParams?: string;
    globalParamsMdPath?: string;
  }) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  currentProject: null,
  isHydrated: false,
  isOpeningProject: false,
  view: 'manager',

  hydrate: async () => {
    if (get().isHydrated) {
      return;
    }

    try {
      const records = await listProjectSummaries();
      const projects = records.map(toProjectSummary).sort((a, b) => b.updatedAt - a.updatedAt);
      set({
        projects,
        currentProjectId: null,
        currentProject: null,
        isHydrated: true,
      });
    } catch (error) {
      console.error('Failed to hydrate project summaries from SQLite', error);
      set({
        projects: [],
        currentProjectId: null,
        currentProject: null,
        isHydrated: true,
      });
    }
  },

  forceRehydrate: async () => {
    try {
      const records = await listProjectSummaries();
      const projects = records.map(toProjectSummary).sort((a, b) => b.updatedAt - a.updatedAt);
      set({ projects, isHydrated: true });
    } catch (error) {
      console.error('Failed to refresh project list after sync:', error);
      set({ isHydrated: true });
    }
  },

  createProject: (name) => {
    const id = uuidv4();
    const now = Date.now();
    const project: Project = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      nodeCount: 0,
      nodes: [],
      edges: [],
      viewport: DEFAULT_VIEWPORT,
      history: createEmptyHistory(),
      videoType: '',
      aspectRatio: '',
      style: '',
      tone: '',
      directorRef: '',
      emphasisDimensions: DEFAULT_EMPHASIS_DIMENSIONS.map((d) => ({ ...d })),
      aiAnalysis: '',
      aiParams: '{}',
      globalParamsMdPath: '',
    };

    set((state) => ({
      projects: [{ ...project }, ...state.projects],
      currentProjectId: id,
      currentProject: project,
      isOpeningProject: false,
    }));
    persistProject(project, { immediate: true });
    return id;
  },

  deleteProject: (id) => {
    set((state) => ({
      projects: state.projects.filter((project) => project.id !== id),
      currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
      currentProject: state.currentProject?.id === id ? null : state.currentProject,
      isOpeningProject: false,
    }));

    persistProjectDelete(id);
  },

  renameProject: (id, name) => {
    const now = Date.now();

    set((state) => {
      const projects = state.projects.map((summary) =>
        summary.id === id
          ? {
              ...summary,
              name,
              updatedAt: now,
            }
          : summary
      );

      return {
        projects: projects.sort((a, b) => b.updatedAt - a.updatedAt),
        currentProject:
          state.currentProject?.id === id
            ? {
                ...state.currentProject,
                name,
                updatedAt: now,
              }
            : state.currentProject,
      };
    });

    const nextCurrentProject = get().currentProject?.id === id ? get().currentProject : null;
    if (nextCurrentProject) {
      persistProject(nextCurrentProject, { immediate: true });
      return;
    }

    void renameProjectRecord(id, name, now).catch((error) => {
      console.error('Failed to rename project record', error);
    });
  },

  copyProject: async (id, newName) => {
    const projects = get().projects;
    const projectToCopy = projects.find(p => p.id === id);

    if (!projectToCopy) {
      throw new Error(`Project with id ${id} not found`);
    }

    // Get the project record to copy all data
    const record = await getProjectRecord(id);
    if (!record) {
      throw new Error(`Project record with id ${id} not found`);
    }

    // Decode the project to get the full data
    const originalProject = fromProjectRecord(record);

    // Create a new project with new ID and name
    const newId = uuidv4();
    const now = Date.now();
    const newProject: Project = {
      ...originalProject,
      id: newId,
      name: newName,
      createdAt: now,
      updatedAt: now,
    };

    set((state) => ({
      projects: [{ ...newProject }, ...state.projects],
    }));

    persistProject(newProject, { immediate: true });
    return newId;
  },

  openProject: (id) => {
    console.log('[DEBUG] openProject called with id:', id);
    const reqSeq = ++openProjectRequestSeq;
    useCanvasStore.getState().closeImageViewer();
    set({ isOpeningProject: true });

    void (async () => {
      try {
        console.log('[DEBUG] openProject: fetching record from DB...');
        const record = await getProjectRecord(id);
        console.log('[DEBUG] openProject: record fetched:', record ? 'found' : 'null');
        if (reqSeq !== openProjectRequestSeq) {
          console.log('[DEBUG] openProject: stale request, returning');
          return;
        }
        if (!record) {
          console.log('[DEBUG] openProject: record not found, aborting');
          set({ isOpeningProject: false });
          return;
        }

        const project = fromProjectRecord(record);
        console.log('[DEBUG] openProject: project parsed, setting view=dashboard, currentProject.id:', project.id);
        set((state) => ({
          currentProjectId: id,
          currentProject: project,
          isOpeningProject: false,
          view: 'dashboard',
          projects: updateProjectSummary(state.projects, {
            id: project.id,
            name: project.name,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            nodeCount: project.nodeCount,
          }),
        }));
      } catch (error) {
        if (reqSeq !== openProjectRequestSeq) {
          return;
        }
        console.error('Failed to open project', error);
        set({ isOpeningProject: false });
      }
    })();
  },

  closeProject: () => {
    openProjectRequestSeq += 1;
    useCanvasStore.getState().closeImageViewer();
    const { currentProjectId, currentProject } = get();
    let persistedSummary: ProjectSummary | null = null;

    if (currentProjectId && currentProject && currentProject.id === currentProjectId) {
      const epId = useEpisodeStore.getState().currentEpisodeId;
      const canvasState = useCanvasStore.getState();
      if (epId) {
        // Episode mode: only update metadata, keep original project-level nodes/edges
        // to avoid polluting project_image_refs and triggering image pruning
        persistedSummary = {
          id: currentProject.id,
          name: currentProject.name,
          createdAt: currentProject.createdAt,
          updatedAt: Date.now(),
          nodeCount: currentProject.nodeCount,
        };
      } else {
        const nextProject: Project = {
          ...currentProject,
          nodes: canvasState.nodes,
          edges: canvasState.edges,
          viewport: canvasState.currentViewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT,
          history: canvasState.history ?? currentProject.history ?? createEmptyHistory(),
          nodeCount: canvasState.nodes.length,
          updatedAt: Date.now(),
        };
        persistedSummary = {
          id: nextProject.id,
          name: nextProject.name,
          createdAt: nextProject.createdAt,
          updatedAt: nextProject.updatedAt,
          nodeCount: nextProject.nodeCount,
        };
        persistProject(nextProject, { immediate: true });
      }
    }

    set((state) => ({
      projects: persistedSummary
        ? updateProjectSummary(state.projects, persistedSummary)
        : state.projects,
      currentProjectId: null,
      currentProject: null,
      isOpeningProject: false,
      view: 'manager',
    }));
  },

  reset: () => {
    openProjectRequestSeq += 1;
    set({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      isHydrated: false,
      isOpeningProject: false,
      view: 'manager',
    });
  },

  setView: (view) => {
    const state = get();
    // When leaving canvas, persist canvas state
    if (state.view === 'canvas' && view !== 'canvas' && state.currentProject && state.currentProjectId) {
      const epId = useEpisodeStore.getState().currentEpisodeId;
      if (epId) {
        // Episode mode: saving project-level data here would overwrite project_image_refs
        // with episode-only image URLs, then prune_unreferenced_images deletes all
        // images referenced by other episodes. Let the Canvas cleanup effect handle it.
        console.info('[ProjectStore] setView: skipping project-level save (episode mode)');
      } else {
        const canvasState = useCanvasStore.getState();
        const nextProject: Project = {
          ...state.currentProject,
          nodes: canvasState.nodes,
          edges: canvasState.edges,
          viewport: canvasState.currentViewport ?? state.currentProject.viewport ?? DEFAULT_VIEWPORT,
          history: canvasState.history ?? state.currentProject.history ?? createEmptyHistory(),
          nodeCount: canvasState.nodes.length,
          updatedAt: Date.now(),
        };
        set({ currentProject: nextProject });
        persistProject(nextProject, { immediate: true });
      }
    }
    set({ view });
  },

  getCurrentProject: () => {
    const { currentProjectId, currentProject } = get();
    if (!currentProjectId || !currentProject) {
      return null;
    }
    if (currentProject.id !== currentProjectId) {
      return null;
    }
    return currentProject;
  },

  saveCurrentProject: (nodes, edges, viewport, history, options) => {
    const { currentProjectId, currentProject } = get();
    if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
      return;
    }

    const nextViewport = viewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT;
    const nextHistory = history ?? currentProject.history ?? createEmptyHistory();
    const nextNodeCount = nodes.length;

    const hasViewportChanged =
      currentProject.viewport.x !== nextViewport.x ||
      currentProject.viewport.y !== nextViewport.y ||
      currentProject.viewport.zoom !== nextViewport.zoom;
    const hasChanged =
      currentProject.nodes !== nodes ||
      currentProject.edges !== edges ||
      currentProject.history !== nextHistory ||
      currentProject.nodeCount !== nextNodeCount ||
      hasViewportChanged;
    if (!hasChanged) {
      return;
    }

    const nextProject: Project = {
      ...currentProject,
      nodes,
      edges,
      viewport: nextViewport,
      history: nextHistory,
      nodeCount: nextNodeCount,
      updatedAt: Date.now(),
    };

    set((state) => ({
      currentProject: nextProject,
      projects: updateProjectSummary(state.projects, {
        id: nextProject.id,
        name: nextProject.name,
        createdAt: nextProject.createdAt,
        updatedAt: nextProject.updatedAt,
        nodeCount: nextProject.nodeCount,
      }),
    }));
    persistProject(nextProject, { immediate: options?.immediate ?? false });
  },

  saveCurrentProjectViewport: (viewport) => {
    const { currentProjectId, currentProject } = get();
    if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
      return;
    }

    const nextViewport = normalizeViewport(viewport);
    const hasChanged = hasViewportMeaningfulDelta(currentProject.viewport, nextViewport);
    if (!hasChanged) {
      return;
    }

    const nextProject: Project = {
      ...currentProject,
      viewport: nextViewport,
    };

    set({ currentProject: nextProject });
    queueViewportUpsert(currentProjectId, nextViewport);
  },

  cancelPendingViewportPersist: () => {
    const currentProjectId = get().currentProjectId;
    if (!currentProjectId) {
      return;
    }
    clearQueuedViewportUpsert(currentProjectId);
  },

  updateProjectParams: (projectId, params) => {
    set((state) => {
      const enabledDims = state.currentProject?.emphasisDimensions.map((d) => ({
        ...d,
        enabled: params.emphasisKeys.includes(d.key),
      })) ?? [];

      const updatedSummary = state.projects.map((p) =>
        p.id === projectId ? { ...p, updatedAt: Date.now() } : p,
      );

      return {
        projects: updatedSummary,
        currentProject:
          state.currentProject?.id === projectId
            ? {
                ...state.currentProject,
                videoType: params.videoType ?? state.currentProject.videoType,
                aspectRatio: params.aspectRatio,
                style: params.style,
                tone: params.tone,
                directorRef: params.directorRef,
                emphasisDimensions: enabledDims,
                updatedAt: Date.now(),
              }
            : state.currentProject,
      };
    });

    const nextProject = get().currentProject;
    if (nextProject) {
      persistProject(nextProject, { immediate: true });
    }
  },

  saveProjectAnalysis: (projectId, analysis) => {
    set((state) => {
      const updatedSummary = state.projects.map((p) =>
        p.id === projectId ? { ...p, updatedAt: Date.now() } : p,
      );

      return {
        projects: updatedSummary,
        currentProject:
          state.currentProject?.id === projectId
            ? {
                ...state.currentProject,
                aiAnalysis: analysis.aiAnalysis ?? state.currentProject.aiAnalysis,
                aiParams: analysis.aiParams ?? state.currentProject.aiParams,
                globalParamsMdPath: analysis.globalParamsMdPath ?? state.currentProject.globalParamsMdPath,
                updatedAt: Date.now(),
              }
            : state.currentProject,
      };
    });

    const nextProject = get().currentProject;
    if (nextProject) {
      persistProject(nextProject, { immediate: true });
    }
  },
}));

async function flushAllProjectPersistsAndWait(): Promise<void> {
  // 清除所有 debounce 定时器
  for (const [projectId] of projectUpsertTimers) {
    clearTimeout(projectUpsertTimers.get(projectId));
    projectUpsertTimers.delete(projectId);
  }
  for (const [projectId] of viewportUpsertTimers) {
    clearTimeout(viewportUpsertTimers.get(projectId));
    viewportUpsertTimers.delete(projectId);
  }

  // 收集所有需要 flush 的项目，await 等待每次 IPC 完成
  const projectIds = Array.from(queuedProjectUpserts.keys());
  const viewportIds = Array.from(queuedViewportUpserts.keys());

  // 先 flush viewport（轻量）
  for (const projectId of viewportIds) {
    const viewportJson = queuedViewportUpserts.get(projectId);
    if (!viewportJson) continue;
    queuedViewportUpserts.delete(projectId);
    try {
      await updateProjectViewportRecord(projectId, viewportJson);
    } catch (e) {
      console.error('flush viewport failed', e);
    }
  }

  // 再 flush 项目数据（await 确保 SQLite 事务提交完成）
  for (const projectId of projectIds) {
    const project = queuedProjectUpserts.get(projectId);
    if (!project) continue;
    queuedProjectUpserts.delete(projectId);
    const record = toProjectRecord(project);
    try {
      await upsertProjectRecord(record);
    } catch (e) {
      console.error('flush project failed', e);
    }
  }
}

// 暴露到 window 供关闭前强制 flush 待保存数据
if (typeof window !== 'undefined') {
  (window as any).__flushProjectPersists__ = () => {
    flushAllProjectPersists();
  };
  (window as any).__flushProjectPersistsAndWait__ = () => {
    return flushAllProjectPersistsAndWait();
  };
}
