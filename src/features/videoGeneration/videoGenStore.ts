import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useCanvasStore } from '@/stores/canvasStore';
import type { VideoDuration, VideoResolution } from './videoPricing';

export interface PersistedRefImage {
  id: string;
  rawUrl: string;
  url: string;
}

export interface PersistedVoice {
  id: string;
  rawUrl: string;
  url: string;
  fileName: string;
}

export interface VideoGenNodeConfig {
  prompt: string;
  aspectRatio: string;
  resolution?: VideoResolution;
  duration: VideoDuration;
  videoModel?: string;
  videoUrl?: string;
  referenceImageUrls?: PersistedRefImage[];
  referenceVoice?: PersistedVoice;
  pendingTaskId?: string;
  pendingCreditsDeducted?: number;
  gridFrames?: string[];
}

export interface VideoGenHistoryEntry extends VideoGenNodeConfig {
  id: string;
  createdAt: number;
  taskId?: string;
}

interface VideoGenStoreState {
  configs: Record<string, VideoGenNodeConfig>;
  history: Record<string, VideoGenHistoryEntry[]>;
  _hydrated: boolean;

  saveConfig: (nodeId: string, config: VideoGenNodeConfig) => void;
  loadConfig: (nodeId: string) => VideoGenNodeConfig | null;
  forgetConfig: (nodeId: string) => void;
  addToHistory: (nodeId: string, config: VideoGenNodeConfig, taskId?: string) => void;
  getHistory: (nodeId: string) => VideoGenHistoryEntry[];
  getAllHistory: () => VideoGenHistoryEntry[];
  forcePersist: () => Promise<void>;
  reset: () => void;
}

const STORE_KEY = 'storyboard-shortvideo-videogen-configs';

let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function readStoreFromFile(): Promise<{ data: Partial<VideoGenStoreState>; isReadError: boolean }> {
  try {
    const raw: string = await invoke('load_videogen_store');
    if (!raw || raw === '{}') return { data: {}, isReadError: false };
    const parsed = JSON.parse(raw);
    // 安全校验：JSON 解析成功但内容为空（文件存在但格式不匹配）
    if (!parsed.configs && !parsed.history) {
      console.error('[videoGenStore] 文件存在但内容为空——可能是格式不匹配，不重置');
      return { data: {}, isReadError: true };
    }
    return {
      data: { configs: parsed.configs ?? {}, history: parsed.history ?? {} },
      isReadError: false,
    };
  } catch (e) {
    console.error('[videoGenStore] 读取文件失败:', e);
    // 返回 isReadError=true，防止 hydrate 把空数据写回磁盘
    return { data: {}, isReadError: true };
  }
}

async function writeStoreToFile(state: { configs: Record<string, unknown>; history: Record<string, unknown> }) {
  try {
    await invoke('persist_videogen_store', { json: JSON.stringify(state) });
  } catch (e) {
    console.warn('[videoGenStore] 持久化到文件失败:', e);
  }
}

function schedulePersist(state: { configs: Record<string, unknown>; history: Record<string, unknown> }) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => writeStoreToFile(state), 500);
}

// Sync to localStorage as fallback, but file storage is primary
function syncToLocalStorage(state: { configs: Record<string, unknown>; history: Record<string, unknown> }) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* ignore quota errors */ }
}


export const useVideoGenStore = create<VideoGenStoreState>()((set, get) => ({
  configs: {},
  history: {},
  _hydrated: false,

  saveConfig: (nodeId, config) =>
    set((s) => {
      const next = { configs: { ...s.configs, [nodeId]: config }, history: s.history };
      schedulePersist(next);
      syncToLocalStorage(next);
      return { configs: next.configs };
    }),

  loadConfig: (nodeId) => get().configs[nodeId] ?? null,

  forgetConfig: (nodeId) =>
    set((s) => {
      const next = { ...s.configs };
      delete next[nodeId];
      const result = { configs: next, history: s.history };
      schedulePersist(result);
      syncToLocalStorage(result);
      return { configs: next };
    }),

  addToHistory: (nodeId, config, taskId) =>
    set((s) => {
      const existing = s.history[nodeId] ?? [];
      // 防重复：同一 taskId 只记录一次
      if (taskId && existing.some((e) => e.taskId === taskId)) {
        return {};
      }
      const entry: VideoGenHistoryEntry = {
        ...config,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: Date.now(),
        taskId,
      };
      const result = {
        configs: s.configs,
        history: { ...s.history, [nodeId]: [entry, ...existing] },
      };
      schedulePersist(result);
      syncToLocalStorage(result);
      return { history: result.history };
    }),

  getHistory: (nodeId) => get().history[nodeId] ?? [],

  getAllHistory: () => {
    const all: VideoGenHistoryEntry[] = [];
    for (const entries of Object.values(get().history)) {
      all.push(...entries);
    }
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all;
  },

  forcePersist: async () => {
    const { configs, history } = get();
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    await writeStoreToFile({ configs, history });
  },

  reset: () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    set({ configs: {}, history: {}, _hydrated: false });
    try { localStorage.removeItem(STORE_KEY); } catch {}
  },
}));

// Hydrate from file on load (primary), fall back to localStorage
export async function hydrateVideoGenStore() {
  // 防重入：已 hydrate 过则跳过。重复调用会导致 merge 把数据翻倍膨胀
  if (useVideoGenStore.getState()._hydrated) return;

  // 在读取文件前，先 flush 任何待写入的数据，确保内存最新数据已落盘
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  const current = useVideoGenStore.getState();
  if (Object.keys(current.configs).length > 0 || Object.keys(current.history).length > 0) {
    await writeStoreToFile({ configs: current.configs, history: current.history });
  }

  // Try file storage first (app data dir — survives reinstalls)
  const { data: fileData, isReadError } = await readStoreFromFile();
  console.log('[videoGenStore][DEBUG] hydrate fileData: configs keys=', fileData.configs ? Object.keys(fileData.configs).length : 0,
    'history keys=', fileData.history ? Object.keys(fileData.history).length : 0,
    'isReadError=', isReadError);

  // 读取错误：文件可能损坏或不存在。标记完成，不清空内存
  if (isReadError) {
    console.error('[videoGenStore] hydrate 读取失败，保留现有数据');
    useVideoGenStore.setState({ _hydrated: true });
    return;
  }

  // Rust 文件是唯一数据源。localStorage 只做 write-through 同步，不做回退读取。
  // 原因：曾出现文件删除后 localStorage 脏数据回流，导致历史记录翻倍膨胀。
  // 老用户数据已在升级时迁移到文件，此处不再需要 localStorage 回退。

  // If we have data from file, merge it with memory (don't replace)
  if ((fileData.configs && Object.keys(fileData.configs).length > 0) ||
      (fileData.history && Object.keys(fileData.history).length > 0)) {
    const mem = useVideoGenStore.getState();
    // 合并：内存优先覆盖同 key，文件补入新 key。history 用覆盖而非拼接，避免重复 hydrate 翻倍
    const mergedConfigs = { ...fileData.configs, ...mem.configs };
    const mergedHistory = { ...fileData.history, ...mem.history };
    useVideoGenStore.setState({
      configs: mergedConfigs,
      history: mergedHistory,
      _hydrated: true,
    });
    syncToLocalStorage({ configs: fileData.configs ?? {}, history: fileData.history ?? {} });

    // Sync videoUrls to canvas nodes so generated videos are visible on nodes
    try {
      const { updateNodeData } = useCanvasStore.getState();
      for (const [nodeId, config] of Object.entries(mergedConfigs)) {
        if (config?.videoUrl) {
          try {
            updateNodeData(nodeId, { generatedVideoUrl: config.videoUrl });
          } catch { /* node may not exist in current canvas */ }
        }
      }
    } catch { /* canvas store may not be ready */ }
  } else {
    // 数据真正为空 = 新用户。只清空 localStorage 不删文件（文件不存在）
    useVideoGenStore.setState({ configs: {}, history: {}, _hydrated: true });
    try { localStorage.removeItem(STORE_KEY); } catch {}
  }
}

// hydrateVideoGenStore() 不再在模块初始化时调用——此时 CURRENT_USER_ID 为空，
// 无法确定读取哪个用户的文件。仅通过 handleLoginSuccess / bananaInitialize /
// sync-data-updated 等登录后回调触发 hydrate。

// 暴露到 window 供备份/关闭前强制 flush
if (typeof window !== 'undefined') {
  (window as any).__videoGenStore = useVideoGenStore;
  (window as any).__forcePersistVideoGenAsync__ = async () => {
    const { configs, history } = useVideoGenStore.getState();
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    await writeStoreToFile({ configs, history });
  };
}
