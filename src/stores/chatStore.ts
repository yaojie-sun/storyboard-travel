import { create } from 'zustand';
import {
  chatSendMessage,
  saveChatConversations,
  loadChatConversations,
  migrateChatStorage,
  type ChatMessageDto,
  type ChatResponse,
} from '@/commands/chat';
import { useEpisodeStore } from '@/stores/episodeStore';
import { buildProjectChatContext } from '@/features/chat/projectContext';
import { splitGridPromptIntoFrames } from '@/utils/gridPromptParser';

export interface PromptBlockFrame {
  description: string;
}

export interface ShotFrameMapping {
  shot: number;
  time: string;
  frames: number[];
  camera: string;
  sound?: string;
  bgm?: string;
}

export interface ShotFrameMap {
  shots: ShotFrameMapping[];
}

export interface PromptBlock {
  id: string;
  type: 'video' | 'grid';
  content: string;
  frames?: PromptBlockFrame[];
  /** 分镜→宫格帧映射（从 AI 输出的【分镜映射】JSON 解析），仅 grid 类型可能有值 */
  shotFrameMap?: Record<string, unknown>;
  /** AI 从脚本挑出的参考图编号（1-based @图N），仅 grid 类型可能有值；用于宫格节点自动连线 */
  selectedRefImages?: number[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  promptBlocks?: PromptBlock[];
  /** L3 继续确认文本（从 AI 回复中解析的【继续确认】段），多段视频每段宫格后出现 */
  continuationPrompt?: string;
  /** 分镜→宫格帧映射（从 AI 输出的【分镜映射】JSON 解析） */
  shotFrameMap?: ShotFrameMap;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** 所属项目 ID —— 数据结构层面确保项目隔离，不依赖 UI 过滤逻辑 */
  projectId?: string;
  /** 所属子项目 ID */
  episodeId?: string;
}

const CHAT_STORAGE_KEY = 'storyboard-chat-conversations';
const CHAT_STORAGE_MAX_CONVERSATIONS = 100;

/** 智能裁剪：优先保留有生成内容（promptBlocks）的对话，防止付费内容被静默删除 */
function trimConversations(conversations: Conversation[], max: number): Conversation[] {
  if (conversations.length <= max) return conversations;
  // 分组：有 promptBlocks 的优先保留
  const valuable: Conversation[] = [];
  const textOnly: Conversation[] = [];
  for (const c of conversations) {
    const hasBlocks = c.messages.some((m) => m.promptBlocks && m.promptBlocks.length > 0);
    if (hasBlocks) {
      valuable.push(c);
    } else {
      textOnly.push(c);
    }
  }
  // 有价值的对话全部保留（除非超过 max）
  if (valuable.length >= max) {
    return valuable.slice(0, max);
  }
  // 剩余名额由纯文本对话按时间排序填充
  const remaining = max - valuable.length;
  return [...valuable, ...textOnly.slice(0, remaining)];
}

let filePersistTimer: ReturnType<typeof setTimeout> | null = null;
let filePending: Conversation[] | null = null;

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 安全解析 JSON，失败返回空数组 */
function safeParseConversations(raw: string, source: string): Conversation[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid: Conversation[] = [];
      for (const c of parsed) {
        if (c && typeof c.id === 'string' && Array.isArray(c.messages)) {
          valid.push(c);
        } else {
          console.warn(`[ChatStore] ${source} 跳过格式异常的对话条目:`, c?.id ?? '(无id)');
        }
      }
      return valid;
    }
  } catch (e) {
    console.error(`[ChatStore] ${source} JSON 解析失败:`, e);
  }
  return [];
}

/** 安全合并：按 ID 去重，同一 ID 保留消息更多的版本 */
function mergeConversations(lists: Conversation[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const conv of lists) {
    const existing = map.get(conv.id);
    if (!existing || conv.messages.length > existing.messages.length) {
      map.set(conv.id, conv);
    } else if (conv.messages.length === existing.messages.length) {
      // 消息数相同 → 保留更新时间更晚的
      if ((conv.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        map.set(conv.id, conv);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Parse grid prompts by extracting numbered frame items.
 *
 * 统一解析：识别所有编号格式（数字+顿号/点/括号/中文数字/第N格/宫格N/场景N），
 * 丢弃前言概括句，处理编号超量。详见 @/utils/gridPromptParser。
 */
function parseGridFrames(gridContent: string): PromptBlockFrame[] {
  return splitGridPromptIntoFrames(gridContent, 6)
    .map((description) => description.trim())
    .filter(Boolean)
    .map((description) => ({ description }));
}

/** Detect whether text looks like a video prompt (has time-anchored shots). */
function looksLikeVideoPrompt(text: string): boolean {
  // Match happyhorse 1.1 shot markers like: Begin with Shot 1 [0-3s], Then Shot 2 [3-8s], Cut to Shot 3 [8-12s]
  return /(?:Begin with|Then|Cut to)\s+Shot\s+\d+\s*\[\s*\d+\s*-\s*\d+\s*s\s*\]/i.test(text);
}

/** Detect whether text looks like a grid prompt (numbered shot descriptions without time anchors). */
function looksLikeGridPrompt(text: string): boolean {
  // Match at least 3 numbered items (1. 2. 3. etc.) with shot content
  const numberedLines = text.match(/^\d+[\.、\)）\s]\s*.+$/gm);
  if (!numberedLines || numberedLines.length < 3) return false;
  // Check that items describe shots: contain camera distance or composition terms
  const shotTerms = /(?:中景|近景|远景|特写|全景|面向镜头|侧身|背对|画面|背景|光线|镜头|shot|camera|frame|scene)/i;
  const shotCount = numberedLines.filter((line) => shotTerms.test(line)).length;
  return shotCount >= 3;
}

function parseShotFrameMap(text: string): ShotFrameMap | undefined {
  const mapPattern = /【分镜映射】\s*(\{[\s\S]*?\})\s*(?:$|(?=【)|(?=\*\*))/;
  const mapMatch = text.match(mapPattern);
  if (mapMatch?.[1]) {
    try {
      const parsed = JSON.parse(mapMatch[1].trim());
      if (parsed && Array.isArray(parsed.shots)) {
        return parsed as ShotFrameMap;
      }
    } catch { /* ignore malformed JSON */ }
  }
  return undefined;
}

/** 解析 AI 输出的【选图】@图N,@图M 行，返回 1-based 编号数组（去重、上限 6）。 */
function parseSelectedRefImages(text: string): number[] | undefined {
  const match = text.match(/【选图】\s*([^\n【]*)/);
  if (!match) return undefined;
  const nums = (match[1].match(/@图(\d+)/g) ?? []).map((s) => parseInt(s.slice(2), 10));
  const unique = [...new Set(nums)].filter((n) => Number.isInteger(n) && n >= 1).slice(0, 6);
  return unique.length > 0 ? unique : undefined;
}

function parsePromptBlocks(content: string): { blocks: PromptBlock[]; continuationPrompt?: string; shotFrameMap?: ShotFrameMap } {
  const blocks: PromptBlock[] = [];
  let continuationPrompt: string | undefined;
  let shotFrameMap: ShotFrameMap | undefined;

  // ⚠️ 解析并剥离【选图】标记（独立于其他标记顺序）
  const selectedRefImages = parseSelectedRefImages(content);
  content = content.replace(/【选图】[^\n【]*\n?/g, '').trim();

  // ⚠️ Parse 【分镜映射】 BEFORE stripping 【继续确认】 — order-independent
  // If AI outputs 继续确认 before 分镜映射, parsing it first would strip the JSON.
  shotFrameMap = parseShotFrameMap(content);
  const mapIdx = content.indexOf('【分镜映射】');
  if (mapIdx >= 0) {
    const jsonStart = content.indexOf('{', mapIdx);
    if (jsonStart >= 0) {
      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
      }
      if (jsonEnd > jsonStart) {
        content = (content.slice(0, mapIdx) + content.slice(jsonEnd)).replace(/\n{3,}/g, '\n\n').trim();
      }
    }
  }

  // Strip 【继续确认】 block — it belongs to the message, not the grid
  const contPattern = /(?:【继续确认】|\*\*继续确认\*\*)\s*([\s\S]*)$/;
  const contMatch = content.match(contPattern);
  if (contMatch?.[1]?.trim()) {
    continuationPrompt = contMatch[1].trim();
    content = content.slice(0, contMatch.index).trim();
  }

  const videoPattern = /(?:【视频提示词】|\*\*视频提示词\*\*)\s*([\s\S]*?)(?=(?:【分镜提示词】|\*\*分镜提示词\*\*)|$)/;
  const gridPattern = /(?:【分镜提示词】|\*\*分镜提示词\*\*)\s*([\s\S]*?)$/;

  const videoMatch = content.match(videoPattern);
  const gridMatch = content.match(gridPattern);

  if (videoMatch?.[1]?.trim()) {
    let videoContent = videoMatch[1].trim();
    // Strip trailing grid question injected by AI
    videoContent = videoContent.replace(
      /[\s\n]*需要.*?宫格.*?[\s\S]*$/,
      '',
    );
    blocks.push({
      id: generateId(),
      type: 'video',
      content: videoContent,
    });
  } else if (!gridMatch && looksLikeVideoPrompt(content)) {
    // Fallback: AI omitted the 【视频提示词】 marker but the content
    // is recognizably a video prompt (time-anchored shot descriptions).
    let videoContent = content.trim();
    videoContent = videoContent.replace(
      /[\s\n]*需要.*?宫格.*?[\s\S]*$/,
      '',
    );
    if (videoContent) {
      blocks.push({
        id: generateId(),
        type: 'video',
        content: videoContent,
      });
    }
  }

  if (gridMatch?.[1]?.trim()) {
    const gridContent = gridMatch[1].trim();
    const frames = parseGridFrames(gridContent);
    blocks.push({
      id: generateId(),
      type: 'grid',
      content: gridContent,
      frames: frames.length >= 2 ? frames : undefined,
      shotFrameMap: shotFrameMap as unknown as Record<string, unknown>,
      selectedRefImages,
    });
  }

  // Fallback: multi-segment continuation may omit 【分镜提示词】 header,
  // but the numbered shots (1. 2. 3. ...) are still valid grid content
  if (blocks.length === 0 && looksLikeGridPrompt(content)) {
    const frames = parseGridFrames(content);
    blocks.push({
      id: generateId(),
      type: 'grid',
      content: content.trim(),
      frames: frames.length >= 2 ? frames : undefined,
      shotFrameMap: shotFrameMap as unknown as Record<string, unknown>,
      selectedRefImages,
    });
  }

  return { blocks, continuationPrompt, shotFrameMap };
}

function buildMessages(conversation: Conversation): ChatMessageDto[] {
  return conversation.messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

function persistToLocalStorage(conversations: Conversation[], projectId: string, userId?: string): void {
  try {
    const trimmed = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
    const payload = userId
      ? { userId, projectId, conversations: trimmed }
      : { projectId, conversations: trimmed };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error('[ChatStore] localStorage 写入失败:', e);
  }
}

async function flushFileNow(projectId: string): Promise<void> {
  if (filePersistTimer) {
    clearTimeout(filePersistTimer);
    filePersistTimer = null;
  }
  if (!filePending) return;
  try {
    await saveChatConversations(projectId, JSON.stringify(filePending));
  } catch (e) {
    console.error('[ChatStore] 文件持久化失败:', e);
  }
  filePending = null;
}

// 暴露到 window 供关闭时 sync_closing_overlay.js 强制 flush
if (typeof window !== 'undefined') {
  (window as any).__flushChatNow__ = () => {
    const { conversations, currentProjectId } = useChatStore.getState();
    if (conversations.length > 0) {
      filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      void flushFileNow(currentProjectId);
    }
  };
  (window as any).__flushChatNowAsync__ = async (): Promise<void> => {
    const { conversations, currentProjectId } = useChatStore.getState();
    if (conversations.length > 0) {
      filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      await flushFileNow(currentProjectId);
    }
  };
}

function schedulePersistConversations(conversations: Conversation[]): void {
  const state = useChatStore.getState();
  persistToLocalStorage(conversations, state.currentProjectId, state.currentUserId);
  filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
  if (filePersistTimer) {
    clearTimeout(filePersistTimer);
    filePersistTimer = null;
  }
  void flushFileNow(state.currentProjectId);
}

// Periodic safety net: flush to file every 5 seconds
if (typeof window !== 'undefined') {
  setInterval(() => {
    const { conversations, currentUserId, currentProjectId } = useChatStore.getState();
    if (conversations.length > 0) {
      persistToLocalStorage(conversations, currentProjectId, currentUserId);
      filePending = trimConversations(conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      void flushFileNow(currentProjectId);
    }
  }, 5_000);
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  hydrated: boolean;
  currentUserId: string;
  currentProjectId: string;
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingText: string;
  error: string | null;
  projectContext: string;

  hydrate: (projectId?: string) => Promise<void>;
  forceRehydrate: () => Promise<void>;
  setCurrentUserId: (userId: string) => void;
  switchToProject: (projectId: string) => Promise<void>;
  createConversation: (episodeId?: string, projectId?: string) => string;
  deleteConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  sendMessage: (content: string, billingTag?: string) => Promise<void>;
  cancelStream: () => void;
  updateMessage: (messageId: string, newContent: string) => void;
  updatePromptBlock: (
    messageId: string,
    blockId: string,
    newContent: string,
  ) => void;
  renameConversation: (id: string, title: string) => void;
  getActiveConversation: () => Conversation | undefined;
  setProjectContext: (context: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  hydrated: false,
  currentUserId: '',
  currentProjectId: '',
  isStreaming: false,
  streamingMessageId: null,
  streamingText: '',
  error: null,
  projectContext: '',

  setCurrentUserId: (userId) => {
    set({ currentUserId: userId });
  },

  hydrate: async (projectId) => {
    if (get().hydrated) return;

    const pid = projectId || get().currentProjectId || '';

    // 0) 尝试迁移旧版单文件存储（仅一次）
    try {
      const result = await migrateChatStorage();
      if (result !== 'no_old_file') {
        console.log('[ChatStore] 迁移旧聊天数据:', result);
      }
    } catch (e) {
      console.warn('[ChatStore] 迁移旧聊天数据失败（可忽略）:', e);
    }

    // 1) 从项目专属文件加载
    const loaded: Conversation[] = [];
    if (pid) {
      try {
        const raw = await loadChatConversations(pid);
        if (raw && raw !== '[]') {
          const parsed = safeParseConversations(raw, 'file');
          loaded.push(...parsed);
        }
      } catch (e) {
        console.error('[ChatStore] 文件加载失败:', e);
      }
    }

    // 2) localStorage 作为备份
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        const envelope = JSON.parse(raw);
        if (envelope && typeof envelope === 'object' && Array.isArray(envelope.conversations)) {
          const currentUserId = get().currentUserId;
          if (currentUserId && envelope.userId && envelope.userId !== currentUserId) {
            console.warn('[ChatStore] localStorage 属于其他用户，忽略');
          } else if (pid && envelope.projectId === pid) {
            loaded.push(...safeParseConversations(JSON.stringify(envelope.conversations), 'localStorage'));
          }
        }
      }
    } catch (e) {
      console.error('[ChatStore] localStorage 读取失败:', e);
    }

    // 3) 合并去重
    const merged = mergeConversations(loaded);
    // 标记中断的 AI 回复：assistant 消息 content 为空 = 在生成期间 App 关闭
    for (const conv of merged) {
      for (const msg of conv.messages) {
        if (msg.role === 'assistant' && msg.content === '') {
          msg.content = '⚠️ AI 回复中断（App 在生成期间关闭）\n请重新发送消息。';
          msg.timestamp = Date.now();
        }
      }
    }
    const existingConvs = get().conversations;
    if (existingConvs.length > 0) {
      const hasMessages = existingConvs.some((c) => c.messages.length > 0);
      if (hasMessages) {
        const allConvs = mergeConversations([...merged, ...existingConvs]);
        set({ conversations: allConvs, currentProjectId: pid, hydrated: true });
        return;
      }
    }

    const convs = trimConversations(merged, CHAT_STORAGE_MAX_CONVERSATIONS);
    set({ conversations: convs, currentProjectId: pid, hydrated: true });
  },

  forceRehydrate: async () => {
    set({ hydrated: false });
    await get().hydrate();
  },

  switchToProject: async (projectId) => {
    const state = get();
    // 保存当前项目数据
    if (state.currentProjectId && state.conversations.length > 0) {
      filePending = trimConversations(state.conversations, CHAT_STORAGE_MAX_CONVERSATIONS);
      await flushFileNow(state.currentProjectId);
      persistToLocalStorage(state.conversations, state.currentProjectId, state.currentUserId);
    }
    // 切换到新项目：重置并从文件加载
    set({ conversations: [], activeConversationId: null, hydrated: false, currentProjectId: projectId });
    await get().hydrate(projectId);
    // 加载完成后清除过期的高亮对话
    const loaded = get().conversations;
    if (loaded.length > 0 && !loaded.some((c) => c.id === state.activeConversationId)) {
      set({ activeConversationId: loaded[0].id });
    }
  },

  createConversation: (episodeId, projectId) => {
    const id = generateId();
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
      projectId,
      episodeId,
    };

    set((state) => {
      const next = [conversation, ...state.conversations];
      schedulePersistConversations(next);
      return {
        conversations: next,
        activeConversationId: id,
        error: null,
      };
    });

    return id;
  },

  deleteConversation: (id) => {
    const { isStreaming } = get();
    if (isStreaming) {
      return;
    }

    set((state) => {
      const next = state.conversations.filter((c) => c.id !== id);
      schedulePersistConversations(next);
      return {
        conversations: next,
        activeConversationId:
          state.activeConversationId === id ? null : state.activeConversationId,
      };
    });
  },

  setActiveConversation: (id) => {
    if (get().isStreaming) {
      return;
    }
    set({ activeConversationId: id, error: null });
  },

  renameConversation: (id, title) => {
    set((state) => {
      const next = state.conversations.map((conv) =>
        conv.id === id ? { ...conv, title, updatedAt: Date.now() } : conv,
      );
      schedulePersistConversations(next);
      return { conversations: next };
    });
  },

  sendMessage: async (content, billingTag) => {
    let { activeConversationId, conversations, isStreaming, projectContext } = get();
    // Auto-create conversation on first send if none is active
    if (!activeConversationId) {
      const epStore = useEpisodeStore.getState();
      const epId = epStore.currentEpisodeId ?? undefined;
      // 从 episode 反查 projectId
      let prjId: string | undefined;
      if (epId) {
        for (const [pid, eps] of Object.entries(epStore.episodesByProject)) {
          if (eps.some((e) => e.id === epId)) {
            prjId = pid;
            break;
          }
        }
      }
      activeConversationId = get().createConversation(epId, prjId);
      conversations = get().conversations;
    }
    if (isStreaming) {
      return;
    }

    const convIndex = conversations.findIndex(
      (c) => c.id === activeConversationId,
    );
    if (convIndex < 0) {
      return;
    }

    const conversation = conversations[convIndex];
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };

    const updatedMessages = [...conversation.messages, userMessage];
    const updatedConversation: Conversation = {
      ...conversation,
      title:
        conversation.messages.length === 0
          ? content.slice(0, 30) + (content.length > 30 ? '...' : '')
          : conversation.title,
      messages: updatedMessages,
      updatedAt: Date.now(),
    };

    const nextConversations = [...conversations];
    nextConversations[convIndex] = updatedConversation;

    const assistantMessageId = generateId();

    // Create a placeholder assistant message BEFORE API call so if the app
    // is killed during streaming, we retain at least an empty assistant marker
    // that hydrate can detect and flag to the user.
    const placeholderAssistant: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    const conversationWithPlaceholder: Conversation = {
      ...updatedConversation,
      messages: [...updatedMessages, placeholderAssistant],
      updatedAt: Date.now(),
    };
    const nextWithPlaceholder = [...conversations];
    nextWithPlaceholder[convIndex] = conversationWithPlaceholder;

    set({
      conversations: nextWithPlaceholder,
      isStreaming: true,
      streamingMessageId: assistantMessageId,
      streamingText: '',
      error: null,
    });

    schedulePersistConversations(nextWithPlaceholder);

    try {
      // 生成时读图：触发分镜生成前，补读缺失参考图描述（缓存复用，只读一次）
      let context = projectContext;
      try {
        const fresh = await buildProjectChatContext(get().currentProjectId, {
          readIfMissing: true,
        });
        if (fresh) context = fresh;
      } catch {
        // 读图失败不阻塞生成
      }

      const response: ChatResponse = await chatSendMessage(
        buildMessages(updatedConversation),
        context || undefined,
        billingTag,
      );

      const state = get();
      const currentConvIndex = state.conversations.findIndex(
        (c) => c.id === activeConversationId,
      );
      if (currentConvIndex < 0) {
        set({ isStreaming: false, streamingMessageId: null, streamingText: '' });
        return;
      }

      const currentConv = state.conversations[currentConvIndex];
      // Replace placeholder content with actual AI response
      const updatedMessages: ChatMessage[] = currentConv.messages.map((msg) => {
        if (msg.id !== assistantMessageId) return msg;
        const { blocks, continuationPrompt, shotFrameMap } = parsePromptBlocks(response.text);
        return {
          ...msg,
          content: response.text,
          timestamp: Date.now(),
          promptBlocks: blocks.length > 0 ? blocks : undefined,
          continuationPrompt,
          shotFrameMap,
        };
      });

      const finalConversation: Conversation = {
        ...currentConv,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };

      const finalConversations = [...state.conversations];
      finalConversations[currentConvIndex] = finalConversation;

      schedulePersistConversations(finalConversations);
      set({
        conversations: finalConversations,
        isStreaming: false,
        streamingMessageId: null,
        streamingText: '',
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '发送消息失败';
      set({
        isStreaming: false,
        streamingMessageId: null,
        streamingText: '',
        error: message,
      });
    }
  },

  cancelStream: () => {
    set({
      isStreaming: false,
      streamingMessageId: null,
      streamingText: '',
      error: '已取消',
    });
  },

  updateMessage: (messageId, newContent) => {
    set((state) => {
      const next = state.conversations.map((conv) => ({
        ...conv,
        messages: conv.messages.map((msg) => {
          if (msg.id !== messageId) return msg;
          const { blocks, continuationPrompt, shotFrameMap } = parsePromptBlocks(newContent);
          return {
            ...msg,
            content: newContent,
            promptBlocks: blocks.length > 0 ? blocks : undefined,
            continuationPrompt,
            shotFrameMap,
          };
        }),
      }));
      schedulePersistConversations(next);
      return { conversations: next };
    });
  },

  updatePromptBlock: (messageId, blockId, newContent) => {
    set((state) => {
      const next = state.conversations.map((conv) => ({
        ...conv,
        messages: conv.messages.map((msg) => {
          if (msg.id !== messageId || !msg.promptBlocks) {
            return msg;
          }
          return {
            ...msg,
            promptBlocks: msg.promptBlocks.map((block) =>
              block.id === blockId
                ? { ...block, content: newContent, frames: block.type === 'grid' ? parseGridFrames(newContent) : block.frames }
                : block,
            ),
          };
        }),
      }));
      schedulePersistConversations(next);
      return { conversations: next };
    });
  },

  getActiveConversation: () => {
    const { activeConversationId, conversations } = get();
    if (!activeConversationId) {
      return undefined;
    }
    return conversations.find((c) => c.id === activeConversationId);
  },

  setProjectContext: (context) => {
    set({ projectContext: context });
  },
}));
