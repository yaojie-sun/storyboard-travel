import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Viewport } from '@xyflow/react';
import type {
  CanvasEdge,
  CanvasHistoryState,
  CanvasNode,
} from './canvasStore';
import {
  listEpisodeRecords,
  upsertEpisodeRecord,
  deleteEpisodeRecord,
  type EpisodeRecord,
} from '@/commands/projectState';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

function createEmptyHistory(): CanvasHistoryState {
  return { past: [], future: [] };
}

export interface Episode {
  id: string;
  projectId: string;
  name: string;
  number: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  history: CanvasHistoryState;
  createdAt: number;
  updatedAt: number;
}

function toEpisodeRecord(episode: Episode): EpisodeRecord {
  return {
    id: episode.id,
    projectId: episode.projectId,
    name: episode.name,
    number: episode.number,
    nodesJson: JSON.stringify(episode.nodes),
    edgesJson: JSON.stringify(episode.edges),
    viewportJson: JSON.stringify(episode.viewport),
    historyJson: JSON.stringify(episode.history),
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
  };
}

function fromEpisodeRecord(record: EpisodeRecord): Episode {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    number: record.number,
    nodes: JSON.parse(record.nodesJson || '[]'),
    edges: JSON.parse(record.edgesJson || '[]'),
    viewport: JSON.parse(record.viewportJson || '{}'),
    history: JSON.parse(record.historyJson || '{"past":[],"future":[]}'),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

interface EpisodeState {
  episodesByProject: Record<string, Episode[]>;
  currentEpisodeId: string | null;
  isLoading: boolean;

  // Actions
  getEpisodes: (projectId: string) => Episode[];
  loadEpisodes: (projectId: string) => Promise<void>;
  forceRehydrate: (projectId: string) => Promise<void>;
  createEpisode: (projectId: string, name: string) => string;
  deleteEpisode: (projectId: string, episodeId: string) => void;
  renameEpisode: (projectId: string, episodeId: string, name: string) => void;
  setCurrentEpisode: (episodeId: string | null) => void;
  getCurrentEpisode: () => Episode | undefined;
  saveCurrentEpisodeCanvas: (
    projectId: string,
    episodeId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    viewport?: Viewport,
    history?: CanvasHistoryState,
  ) => void;
}

export const useEpisodeStore = create<EpisodeState>((set, get) => ({
  episodesByProject: {},
  currentEpisodeId: null,
  isLoading: false,

  getEpisodes: (projectId) => {
    return get().episodesByProject[projectId] ?? [];
  },

  loadEpisodes: async (projectId) => {
    // Don't reload if already in memory — avoids race with pending backend saves
    const existing = get().episodesByProject[projectId];
    if (existing && existing.length > 0) {
      return;
    }
    set({ isLoading: true });
    try {
      const records = await listEpisodeRecords(projectId);
      const episodes = records.map(fromEpisodeRecord);
      set((state) => ({
        episodesByProject: {
          ...state.episodesByProject,
          [projectId]: episodes,
        },
        isLoading: false,
      }));
    } catch {
      set({ isLoading: false });
    }
  },

  forceRehydrate: async (projectId) => {
    set({ isLoading: true });
    try {
      const records = await listEpisodeRecords(projectId);
      const episodes = records.map(fromEpisodeRecord);
      set((state) => ({
        episodesByProject: {
          ...state.episodesByProject,
          [projectId]: episodes,
        },
        isLoading: false,
      }));
    } catch {
      set({ isLoading: false });
    }
  },

  createEpisode: (projectId, name) => {
    const id = uuidv4();
    const now = Date.now();
    const episodes = get().episodesByProject[projectId] ?? [];
    const maxNumber = episodes.reduce((max, ep) => Math.max(max, ep.number), 0);

    const episode: Episode = {
      id,
      projectId,
      name,
      number: maxNumber + 1,
      nodes: [],
      edges: [],
      viewport: DEFAULT_VIEWPORT,
      history: createEmptyHistory(),
      createdAt: now,
      updatedAt: now,
    };

    set((state) => ({
      episodesByProject: {
        ...state.episodesByProject,
        [projectId]: [...episodes, episode],
      },
      currentEpisodeId: id,
    }));

    // Persist to backend
    void upsertEpisodeRecord(toEpisodeRecord(episode));

    return id;
  },

  deleteEpisode: (projectId, episodeId) => {
    set((state) => {
      const episodes = state.episodesByProject[projectId] ?? [];
      const next = episodes.filter((ep) => ep.id !== episodeId);
      return {
        episodesByProject: {
          ...state.episodesByProject,
          [projectId]: next,
        },
        currentEpisodeId:
          state.currentEpisodeId === episodeId ? null : state.currentEpisodeId,
      };
    });

    void deleteEpisodeRecord(episodeId);
  },

  renameEpisode: (projectId, episodeId, name) => {
    const now = Date.now();
    set((state) => {
      const episodes = state.episodesByProject[projectId] ?? [];
      const next = episodes.map((ep) =>
        ep.id === episodeId ? { ...ep, name, updatedAt: now } : ep,
      );
      return {
        episodesByProject: {
          ...state.episodesByProject,
          [projectId]: next,
        },
      };
    });

    // Persist rename
    const episode = get().episodesByProject[projectId]?.find((ep) => ep.id === episodeId);
    if (episode) {
      void upsertEpisodeRecord(toEpisodeRecord(episode));
    }
  },

  setCurrentEpisode: (episodeId) => {
    set({ currentEpisodeId: episodeId });
  },

  getCurrentEpisode: () => {
    const { currentEpisodeId, episodesByProject } = get();
    if (!currentEpisodeId) return undefined;
    for (const episodes of Object.values(episodesByProject)) {
      const found = episodes.find((ep) => ep.id === currentEpisodeId);
      if (found) return found;
    }
    return undefined;
  },

  saveCurrentEpisodeCanvas: (projectId, episodeId, nodes, edges, viewport, history) => {
    const now = Date.now();
    set((state) => {
      const episodes = state.episodesByProject[projectId] ?? [];
      const next = episodes.map((ep) =>
        ep.id === episodeId
          ? {
              ...ep,
              nodes,
              edges,
              viewport: viewport ?? ep.viewport ?? DEFAULT_VIEWPORT,
              history: history ?? ep.history ?? createEmptyHistory(),
              updatedAt: now,
            }
          : ep,
      );
      return {
        episodesByProject: {
          ...state.episodesByProject,
          [projectId]: next,
        },
      };
    });

    // Persist to backend
    const episode = get().episodesByProject[projectId]?.find((ep) => ep.id === episodeId);
    if (episode) {
      void upsertEpisodeRecord(toEpisodeRecord(episode));
    }
  },
}));
