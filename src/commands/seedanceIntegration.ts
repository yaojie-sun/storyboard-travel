import { invoke } from '@tauri-apps/api/core';

export interface GridConfig {
  rows: number;
  cols: number;
}

export interface SeedanceProjectRequest {
  prompt: string;
  grid: GridConfig;
  projectName?: string;
}

export interface SeedanceProjectResponse {
  projectId: string;
  projectName: string;
  storyboardNodeId: string;
}

/**
 * 从seedance-t创建新项目
 * 根据提供的提示词和宫格配置创建包含故事板节点的新项目
 */
export async function createProjectFromSeedance(
  request: SeedanceProjectRequest
): Promise<SeedanceProjectResponse> {
  return await invoke<SeedanceProjectResponse>('create_project_from_seedance', { request });
}