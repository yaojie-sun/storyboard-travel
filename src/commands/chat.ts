import { invoke } from '@tauri-apps/api/core';

export interface ChatMessageDto {
  role: string;
  content: string;
}

export interface ChatResponse {
  chat_id: string;
  text: string;
}

export async function chatSendMessage(
  messages: ChatMessageDto[],
  projectContext?: string,
  billingTag?: string,
): Promise<ChatResponse> {
  return await invoke<ChatResponse>('chat_send_message', {
    messages,
    projectContext: projectContext ?? '',
    billingTag: billingTag ?? null,
  });
}

export async function saveChatConversations(projectId: string, json: string): Promise<void> {
  return await invoke<void>('save_chat_conversations', { projectId, json });
}

export async function loadChatConversations(projectId: string): Promise<string> {
  return await invoke<string>('load_chat_conversations', { projectId });
}

export async function migrateChatStorage(): Promise<string> {
  return await invoke<string>('migrate_chat_storage');
}

export interface SkillUpgradeInfo {
  upgrade_available: boolean;
  local_version: string;
  server_version: string;
  description: string;
}

export async function checkSkillUpgrade(): Promise<SkillUpgradeInfo> {
  return await invoke<SkillUpgradeInfo>('check_skill_upgrade');
}

export async function performSkillUpgrade(): Promise<SkillUpgradeInfo> {
  return await invoke<SkillUpgradeInfo>('perform_skill_upgrade');
}

// ── Story analysis ──

export interface AnalysisCharacter {
  name: string;
  archetype: string;
  arc: string;
}

export interface AnalysisVisualStyle {
  color_palette: string;
  lighting: string;
  camera: string;
}

export interface StoryAnalysisResult {
  logline: string;
  genre: string;
  themes: string[];
  characters: AnalysisCharacter[];
  visual_style: AnalysisVisualStyle;
  pacing: string;
  analysis_summary: string;
  raw_json: string;
}

/** DeepSeek清洗 — 去掉光影/场景/外观，只保留运镜+精简动作+声音 */
export async function cleanVideoPrompt(params: {
  storyboardPrompt: string;
  gridFrames: string[];
  targetModel?: string;
  referenceImages?: string[];
}): Promise<string> {
  return await invoke<string>('integrate_video_prompt', {
    storyboardPrompt: params.storyboardPrompt,
    gridFrames: params.gridFrames,
    targetModel: params.targetModel ?? null,
    referenceImages: params.referenceImages ?? null,
  });
}

export async function analyzeStory(params: {
  storyOutline: string;
  aspectRatio: string;
  style: string;
  tone: string;
  directorRef: string;
  emphasisDimensions: string[];
}): Promise<StoryAnalysisResult> {
  return await invoke<StoryAnalysisResult>('analyze_story', {
    storyOutline: params.storyOutline,
    aspectRatio: params.aspectRatio,
    style: params.style,
    tone: params.tone,
    directorRef: params.directorRef,
    emphasisDimensions: params.emphasisDimensions,
  });
}
