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

/**
 * 迁移旧版单文件 `chat_conversations.json` → 按项目分文件。
 *
 * `fallbackProjectId` 传**当前打开的项目**：反查不到归属的对话会并入它，
 * 而不是倒进没人读的 `chat/global.json`（2026-10-16 数据事故根因）。
 * 未打开项目时不传 —— 后端会**拒绝迁移并保留源文件**，下次再试。
 */
export async function migrateChatStorage(fallbackProjectId?: string): Promise<string> {
  return await invoke<string>('migrate_chat_storage', {
    fallbackProjectId: fallbackProjectId ?? null,
  });
}

/**
 * 一次性回捞：把历史上被错误写进 `chat/global.json` 的对话重新分发回各自项目文件。
 * **只增不减**（先备份 + 并集合并），不删 `global.json` —— 它是那批对话的最后一份备份。
 */
export async function recoverStrandedChat(fallbackProjectId?: string): Promise<string> {
  return await invoke<string>('recover_stranded_chat', {
    fallbackProjectId: fallbackProjectId ?? null,
  });
}

/**
 * 把解析失败的对话文件另存一份 `.corrupt-<ts>`，返回备份绝对路径。
 *
 * 前端在读坏的那一刻必须先调它：`safeParseConversations` 失败会回退成空列表，
 * 而 5 秒定时器的下一次整量存盘会把坏文件覆盖成 `[]`。
 * 后备端**只复制、不动原文件**（见 Rust `backup_corrupt_chat_file`）。
 */
export async function backupCorruptChatFile(projectId: string): Promise<string> {
  return await invoke<string>('backup_corrupt_chat_file', { projectId });
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
