import { invoke } from '@tauri-apps/api/core';

export interface ProjectSummaryRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
  // 项目参数
  videoType: string;
  aspectRatio: string;
  style: string;
  tone: string;
  directorRef: string;
  emphasisDimensions: string;
  aiAnalysis: string;
  aiParams: string;
  globalParamsMdPath: string;
}

export interface EpisodeRecord {
  id: string;
  projectId: string;
  name: string;
  number: number;
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
  createdAt: number;
  updatedAt: number;
}

export async function listProjectSummaries(): Promise<ProjectSummaryRecord[]> {
  return await invoke<ProjectSummaryRecord[]>('list_project_summaries');
}

export async function getProjectRecord(projectId: string): Promise<ProjectRecord | null> {
  return await invoke<ProjectRecord | null>('get_project_record', { projectId });
}

export async function upsertProjectRecord(record: ProjectRecord): Promise<void> {
  await invoke('upsert_project_record', { record });
}

export async function updateProjectViewportRecord(
  projectId: string,
  viewportJson: string
): Promise<void> {
  await invoke('update_project_viewport_record', { projectId, viewportJson });
}

export async function renameProjectRecord(
  projectId: string,
  name: string,
  updatedAt: number
): Promise<void> {
  await invoke('rename_project_record', { projectId, name, updatedAt });
}

export async function deleteProjectRecord(projectId: string): Promise<void> {
  await invoke('delete_project_record', { projectId });
}

// ── Episode commands ──

export async function listEpisodeRecords(projectId: string): Promise<EpisodeRecord[]> {
  return await invoke<EpisodeRecord[]>('list_episode_records', { projectId });
}

export async function getEpisodeRecord(episodeId: string): Promise<EpisodeRecord | null> {
  return await invoke<EpisodeRecord | null>('get_episode_record', { episodeId });
}

export async function upsertEpisodeRecord(record: EpisodeRecord): Promise<void> {
  await invoke('upsert_episode_record', { record });
}

export async function deleteEpisodeRecord(episodeId: string): Promise<void> {
  await invoke('delete_episode_record', { episodeId });
}

// ── Project globals MD ──

export async function generateProjectGlobalsMd(params: {
  projectId: string;
  projectName: string;
  videoType: string;
  aspectRatio: string;
  style: string;
  tone: string;
  directorRef: string;
  emphasisDimensions: string[];
  analysisSummary: string;
  aiParamsJson: string;
}): Promise<string> {
  return await invoke<string>('generate_project_globals_md', {
    projectId: params.projectId,
    projectName: params.projectName,
    videoType: params.videoType,
    aspectRatio: params.aspectRatio,
    style: params.style,
    tone: params.tone,
    directorRef: params.directorRef,
    emphasisDimensionsJson: JSON.stringify(params.emphasisDimensions),
    analysisSummary: params.analysisSummary,
    aiParamsJson: params.aiParamsJson,
  });
}

export async function readProjectGlobalsMd(projectId: string): Promise<string> {
  return await invoke<string>('read_project_globals_md', { projectId });
}

export async function confirmClose(): Promise<void> {
  await invoke('confirm_close');
}
