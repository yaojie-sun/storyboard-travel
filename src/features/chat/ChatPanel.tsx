import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/stores/chatStore';
import { useEpisodeStore } from '@/stores/episodeStore';
import { useProjectStore } from '@/stores/projectStore';
import { checkSkillUpgrade, performSkillUpgrade, type SkillUpgradeInfo } from '@/commands/chat';
import { ChatBubble } from './ChatBubble';
import { ChatInput } from './ChatInput';

const PANEL_MIN_WIDTH = 300;
const PANEL_DEFAULT_WIDTH = 380;
const PANEL_STORAGE_KEY = 'storyboard-chat-panel-width';
const CHAT_HINT_DISMISSED_KEY = 'storyboard-chat-hint-dismissed';

function loadPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= PANEL_MIN_WIDTH) {
        return parsed;
      }
    }
  } catch { /* ignore */ }
  return PANEL_DEFAULT_WIDTH;
}

function savePanelWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, String(width));
  } catch { /* ignore */ }
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

interface ChatPanelProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function ChatPanel({ isOpen, onToggle }: ChatPanelProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showConvList, setShowConvList] = useState(false);
  const [showNewConfirm, setShowNewConfirm] = useState(false);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return localStorage.getItem(CHAT_HINT_DISMISSED_KEY) === '1'; } catch { return false; }
  });
  const isResizingRef = useRef(false);
  const resizeStartRef = useRef({ startX: 0, startWidth: 0 });

  const allConversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);
  const error = useChatStore((s) => s.error);
  const createConversation = useChatStore((s) => s.createConversation);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const switchToProject = useChatStore((s) => s.switchToProject);
  const chatHydrated = useChatStore((s) => s.hydrated);
  const chatProjectId = useChatStore((s) => s.currentProjectId);
  const currentEpisodeId = useEpisodeStore((s) => s.currentEpisodeId);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  // 物理隔离：store 中的 conversations 已经是当前项目的数据，无需过滤
  // 再按 episodeId 做子项目隔离
  const conversations = useMemo(
    () => {
      if (!currentEpisodeId) return allConversations;
      return allConversations.filter((c) => !c.episodeId || c.episodeId === currentEpisodeId);
    },
    [allConversations, currentEpisodeId],
  );

  const activeConversation = conversations.find(
    (c) => c.id === activeConversationId,
  );

  // 项目切换时：保存当前项目数据，加载新项目数据
  const prevProjectRef = useRef<string>('');
  useEffect(() => {
    const pid = currentProjectId || '';
    if (pid === prevProjectRef.current) return;
    prevProjectRef.current = pid;
    // 如果 store 已经是这个项目的数据，跳过
    if (chatProjectId === pid && chatHydrated) return;
    switchToProject(pid);
  }, [currentProjectId, chatProjectId, chatHydrated, switchToProject]);

  // ── Skill upgrade state ──
  const [upgradeState, setUpgradeState] = useState<'idle' | 'checking' | 'upgrading' | 'done' | 'error' | 'uptodate'>('idle');
  const [upgradeInfo, setUpgradeInfo] = useState<SkillUpgradeInfo | null>(null);
  const upgradeCheckedRef = useRef(false);

  // Auto-check skill upgrade when chat opens
  useEffect(() => {
    if (!isOpen || !chatHydrated || upgradeCheckedRef.current) return;
    upgradeCheckedRef.current = true;

    (async () => {
      setUpgradeState('checking');
      // 确保 "检查中" 至少显示 1 秒，避免网络太快一闪而过
      const minDelay = new Promise((r) => setTimeout(r, 1000));
      try {
        const info = await checkSkillUpgrade();
        if (info.upgrade_available) {
          setUpgradeInfo(info);
          setUpgradeState('upgrading');
          try {
            const result = await performSkillUpgrade();
            setUpgradeInfo(result);
            setUpgradeState('done');
          } catch (e) {
            console.error('[SkillUpgrade] 升级失败:', e);
            setUpgradeState('error');
          }
        } else {
          setUpgradeInfo(info);
          await minDelay;
          setUpgradeState('uptodate');
          setTimeout(() => setUpgradeState('idle'), 3000);
        }
      } catch (e) {
        console.error('[SkillUpgrade] 检查失败:', e);
        await minDelay;
        setUpgradeState('idle');
      }
    })();
  }, [isOpen, chatHydrated]);

  // Auto-select an existing conversation for current episode (never auto-create)
  useEffect(() => {
    if (!isOpen || !chatHydrated || isStreaming) return;
    if (activeConversation) return;

    if (conversations.length > 0) {
      if (activeConversationId !== conversations[0].id) {
        setActiveConversation(conversations[0].id);
      }
    } else if (activeConversationId) {
      setActiveConversation(null);
    }
  }, [isOpen, chatHydrated, activeConversation, activeConversationId, isStreaming, conversations, setActiveConversation]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeConversation?.messages, streamingText]);

  const handleNewClick = () => {
    if (isStreaming) return;
    setShowNewConfirm(true);
  };

  const handleSaveAndNew = () => {
    if (activeConversation) {
      const timestampTitle = `会话 ${formatTimestamp()}`;
      renameConversation(activeConversation.id, timestampTitle);
    }
    setShowNewConfirm(false);
    createConversation(currentEpisodeId ?? undefined, currentProjectId || undefined);
    setShowConvList(false);
  };

  const handleDirectNew = () => {
    setShowNewConfirm(false);
    createConversation(currentEpisodeId ?? undefined, currentProjectId || undefined);
    setShowConvList(false);
  };

  const handleSaveRename = () => {
    if (activeConversation && activeConversation.messages.length > 0) {
      const timestampTitle = `会话 ${formatTimestamp()}`;
      renameConversation(activeConversation.id, timestampTitle);
    }
  };

  const dismissHint = () => {
    setHintDismissed(true);
    try { localStorage.setItem(CHAT_HINT_DISMISSED_KEY, '1'); } catch { /* ignore */ }
  };

  // Auto-dismiss hint when chat is opened
  useEffect(() => {
    if (isOpen && !hintDismissed) {
      dismissHint();
    }
  }, [isOpen]);

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    resizeStartRef.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = e.clientX - resizeStartRef.current.startX;
      const maxWidth = window.innerWidth * 0.85;
      const nextWidth = Math.max(
        PANEL_MIN_WIDTH,
        Math.min(maxWidth, resizeStartRef.current.startWidth + delta),
      );
      setPanelWidth(nextWidth);
    };

    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setPanelWidth((current) => {
        savePanelWidth(current);
        return current;
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <>
      {/* Toggle button — left side, with hint tooltip when closed */}
      <div
        className={`
          fixed left-0 top-1/2 -translate-y-1/2 z-40
          ${isOpen ? '-translate-x-full opacity-0 pointer-events-none' : 'translate-x-0 opacity-100'}
          transition-all duration-200
        `}
      >
        <button
          type="button"
          onClick={onToggle}
          className={`
            flex items-center justify-center gap-1
            w-10 h-24
            rounded-r-xl chat-toggle-pulse
            bg-[var(--ui-surface-panel)] border-2 border-l-0 border-[var(--accent)]/30
            shadow-[var(--ui-shadow-panel)]
            hover:bg-[var(--surface)] hover:border-[var(--accent)]
            transition-all duration-200
            ${!hintDismissed ? 'chat-toggle-hint' : ''}
          `}
          title={t('chat.toggleOpen', '打开对话')}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path
              d="M5 3L10 8L5 13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-xs text-white font-medium" style={{ writingMode: 'vertical-rl' }}>
            提示词
          </span>
        </button>

        {/* Hint tooltip — shown when panel is closed and not yet dismissed */}
        {!hintDismissed && (
          <div className="absolute left-12 top-1/2 -translate-y-1/2 flex items-center gap-2">
            {/* Animated arrow */}
            <svg
              className="chat-toggle-hint-arrow text-[var(--accent)]"
              width="20" height="20" viewBox="0 0 20 20" fill="none"
            >
              <path
                d="M3 10H13M10 6L14 10L10 14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {/* Hint bubble */}
            <div className="
              bg-[var(--ui-surface-panel)] border border-[var(--ui-border-soft)]
              rounded-xl shadow-lg px-4 py-2.5
              whitespace-nowrap
              flex items-center gap-2
            ">
              <span className="text-sm text-[var(--text)]">
                点击这里，小鸭帮你生成专业提示词
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); dismissHint(); }}
                className="p-0.5 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors shrink-0"
                title="不再提示"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Panel — left side, resizable */}
      <div
        className={`
          fixed left-0 top-0 bottom-0 z-50
          flex flex-col
          bg-[var(--ui-surface-panel)]
          border-r border-[var(--ui-border-soft)]
          shadow-[var(--ui-shadow-panel)]
          transition-transform duration-300 ease-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{ width: panelWidth }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ui-border-soft)] shrink-0">
          <div className="flex items-center gap-2">
            {/* History button */}
            <button
              type="button"
              onClick={() => setShowConvList(!showConvList)}
              className="p-1 rounded hover:bg-[var(--surface)] transition-colors"
              title={t('chat.conversations', '历史对话')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="text-sm font-medium text-[var(--text)]">
              {t('chat.title', '小鸭对话')}
            </span>
            {/* Save/rename button */}
            {activeConversation && activeConversation.messages.length > 0 && (
              <button
                type="button"
                onClick={handleSaveRename}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)] transition-colors"
                title={t('chat.saveConversation', '保存会话')}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 2v12l5-3 5 3V2a1 1 0 00-1-1H4a1 1 0 00-1 1z" />
                </svg>
                保存
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <div className="relative">
              <button
                type="button"
                onClick={handleNewClick}
                disabled={isStreaming}
                className="p-1.5 rounded-lg hover:bg-[var(--surface)] transition-colors disabled:opacity-40"
                title={t('chat.newConversation', '新对话')}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 3V13M3 8H13"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>

              {/* New conversation confirm dropdown */}
              {showNewConfirm && (
                <div className="absolute right-0 top-full mt-1 w-52 bg-[var(--ui-surface-panel)] border border-[var(--ui-border-soft)] rounded-xl shadow-lg z-20 p-3">
                  <p className="text-xs text-[var(--text)] mb-2.5 leading-relaxed">
                    {t('chat.confirmNewConversation', '确认新建会话？当前会话将保留在对话列表中。')}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={handleSaveAndNew}
                      className="w-full px-3 py-1.5 text-xs rounded-lg bg-[var(--accent)] text-white hover:opacity-90 transition-opacity text-left"
                    >
                      {t('chat.saveAndNew', '保存并新建')}
                    </button>
                    <button
                      type="button"
                      onClick={handleDirectNew}
                      className="w-full px-3 py-1.5 text-xs rounded-lg bg-[var(--surface)] text-[var(--text)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-left"
                    >
                      {t('chat.directNew', '直接新建')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNewConfirm(false)}
                      className="w-full px-3 py-1.5 text-xs rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface)] transition-colors text-left"
                    >
                      {t('common.cancel', '取消')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onToggle}
              className="flex items-center gap-1 p-1.5 rounded-lg hover:bg-[var(--surface)] transition-colors group"
              title={t('chat.toggleClose', '收起对话')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M11 3L6 8L11 13"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-xs text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors mr-0.5">
                收起
              </span>
            </button>
          </div>
        </div>

        {/* Conversation list overlay */}
        {showConvList && (
          <div className="absolute top-12 left-0 right-0 bottom-0 z-10 bg-[var(--ui-surface-panel)] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ui-border-soft)]">
              <span className="text-xs text-[var(--text-muted)]">
                {t('chat.conversations', '对话列表')}
              </span>
              <button
                type="button"
                onClick={() => setShowConvList(false)}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {t('common.close', '关闭')}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className={`
                    flex items-center justify-between px-4 py-2.5 cursor-pointer
                    hover:bg-[var(--surface)] transition-colors
                    ${conv.id === activeConversationId ? 'bg-[var(--surface)]' : ''}
                  `}
                  onClick={() => {
                    setActiveConversation(conv.id);
                    setShowConvList(false);
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text)] truncate">
                      {conv.title}
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {conv.messages.length} 条消息
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(conv.id);
                    }}
                    className="p-1 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                    title={t('common.delete', '删除')}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M4 4L12 12M12 4L4 12"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              ))}
              {conversations.length === 0 && (
                <div className="p-6 text-center text-sm text-[var(--text-muted)]">
                  {t('chat.noConversations', '暂无对话')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Skill upgrade banner */}
        {upgradeState !== 'idle' && (
          <div className="shrink-0 px-4 py-2.5 border-b border-[var(--ui-border-soft)]">
            {upgradeState === 'checking' && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span className="w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                正在检查技能更新...
              </div>
            )}
            {upgradeState === 'upgrading' && upgradeInfo && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span className="w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                正在升级技能 {upgradeInfo.local_version} → {upgradeInfo.server_version}...
              </div>
            )}
            {upgradeState === 'done' && upgradeInfo && (
              <div className="flex items-start gap-2">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="mt-0.5 shrink-0">
                  <circle cx="8" cy="8" r="7" fill="#22c55e" />
                  <path d="M5 8l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div className="text-xs">
                  <span className="font-medium text-[var(--text)]">
                    技能已升级到 v{upgradeInfo.server_version}
                  </span>
                  {upgradeInfo.description && (
                    <span className="text-[var(--text-muted)] ml-2">
                      — {upgradeInfo.description}
                    </span>
                  )}
                </div>
              </div>
            )}
            {upgradeState === 'error' && (
              <div className="text-xs text-red-500">
                技能升级失败，您可继续使用当前版本
              </div>
            )}
            {upgradeState === 'uptodate' && upgradeInfo && (
              <div className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
                  <circle cx="8" cy="8" r="7" fill="#22c55e" />
                  <path d="M5 8l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-xs text-[var(--text-muted)]">
                  技能已是最新版本 v{upgradeInfo.local_version}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto py-4 space-y-4 ui-scrollbar"
        >
          {activeConversation?.messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-3">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              <p className="text-sm">{t('chat.emptyState', '描述你的想法，小鸭分镜大师会帮你生成专业分镜提示词')}</p>
            </div>
          )}

          {activeConversation?.messages.flatMap((msg) => {
            const bubble = <ChatBubble key={msg.id} message={msg} />;
            if (!isStreaming && msg.role === 'assistant') {
              // L2: video prompt → ask for grid generation
              if (msg.promptBlocks?.some((b) => b.type === 'video' && b.content.trim())) {
                return [
                  bubble,
                  <div key={`${msg.id}-ask`} className="flex items-center gap-2 px-1 pt-2">
                    <button type="button" onClick={() => useChatStore.getState().sendMessage('A')}
                      className="px-4 py-2 text-sm font-medium rounded-xl bg-[var(--accent)] text-white hover:opacity-90 transition-opacity shadow-sm">
                      A-生成宫格提示词
                    </button>
                  </div>,
                ];
              }
              // L3: grid prompt + continuation → ask whether to continue to next segment
              if (msg.continuationPrompt && msg.promptBlocks?.some((b) => b.type === 'grid')) {
                return [
                  bubble,
                  <div key={`${msg.id}-l3`} className="flex items-center gap-2 px-1 pt-2">
                    <button type="button" onClick={() => useChatStore.getState().sendMessage('继续')}
                      className="px-4 py-2 text-sm font-medium rounded-xl bg-[var(--accent)] text-white hover:opacity-90 transition-opacity shadow-sm">
                      继续生成下一段
                    </button>
                    <button type="button" onClick={() => useChatStore.getState().sendMessage('暂停')}
                      className="px-4 py-2 text-sm font-medium rounded-xl bg-[var(--surface)] text-[var(--text)] border border-[var(--ui-border-soft)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                      暂停
                    </button>
                  </div>,
                ];
              }
            }
            return bubble;
          })}

          {/* Streaming message */}
          {isStreaming && streamingMessageId && (
            <ChatBubble
              message={{
                id: streamingMessageId,
                role: 'assistant',
                content: streamingText || '...',
                timestamp: Date.now(),
              }}
              isStreaming
            />
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-500">
              {error}
            </div>
          )}

        </div>

        {/* Input */}
        <ChatInput />
      </div>

      {/* Resize handle — sits on the right edge of the panel */}
      <div
        className={`
          fixed top-0 bottom-0 z-50
          w-1.5
          cursor-col-resize
          hover:bg-[var(--accent)]/30
          transition-colors
          ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}
        `}
        style={{ left: panelWidth }}
        onMouseDown={handleResizeStart}
      />
    </>
  );
}
