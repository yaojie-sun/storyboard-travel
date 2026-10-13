import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { useChatStore, resolveSelectedRefImages } from '@/stores/chatStore';
import { useEpisodeStore } from '@/stores/episodeStore';
import { useProjectStore } from '@/stores/projectStore';
import { checkSkillUpgrade, performSkillUpgrade, type SkillUpgradeInfo } from '@/commands/chat';
import { ChatBubble } from './ChatBubble';
import { FillGridButtons } from './FillGridButtons';
import { StageProcessLine } from './StageProcessLine';
import { ChatInput } from './ChatInput';
import {
  autoNextAnchor,
  cardForStage,
  isProcessStage,
  isStageAnchorMessage,
  resolveUnitPlan,
} from './stageCards';

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
  const streamPhase = useChatStore((s) => s.streamPhase);
  const streamingStage = useChatStore((s) => s.streamingStage);
  const autoChain = useChatStore((s) => s.autoChain);
  const autoChainMode = useChatStore((s) => s.autoChainMode);
  const error = useChatStore((s) => s.error);
  const chatStorageWarning = useChatStore((s) => s.chatStorageWarning);
  const setChatStorageWarning = useChatStore((s) => s.setChatStorageWarning);
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

  // 单元进度（`【单元】U1/U2/…`）—— `STEP6` 的「出下一单元」按钮靠它算。
  // 会话整条扫一遍，**不能放进逐条消息的渲染里**（那样是 O(n²)）。
  // 拿不到（老会话、单单元脚本、写手没给〈分段建议〉）⇒ `null` ⇒ 该按钮不出现，
  // 行为与改动前一致。
  const unitPlan = useMemo(
    () => resolveUnitPlan(activeConversation?.messages),
    [activeConversation?.messages],
  );

  // 🔴 可见列表与高亮 id 失配时自愈。
  //    高亮由 `switchToProject` 挑（`chatStore.ts`），列表由上面这个 memo 按
  //    `currentEpisodeId` 过滤 —— 两条判据不保证重合。一旦不重合，
  //    `activeConversation` 就是 `undefined`，下面消息区**连空状态文案都不渲染**
  //    （判据 `activeConversation?.messages.length === 0` 在 undefined 时求值为
  //    `undefined === 0` = false）⇒ 整片空白，且不会自己恢复，只能整页刷新。
  //    这里只挪「选中哪一条」这个指针，不动任何对话数据。
  useEffect(() => {
    if (conversations.length === 0) return;
    if (conversations.some((c) => c.id === activeConversationId)) return;
    setActiveConversation(conversations[0].id);
  }, [conversations, activeConversationId, setActiveConversation]);

  // 项目切换时：保存当前项目数据，加载新项目数据
  const prevProjectRef = useRef<string>('');
  useEffect(() => {
    const pid = currentProjectId || '';

    // 🔴 判据必须同时问「store 里装的到底是不是这个项目」。
    //    只比「项目 id 有没有变」（`pid === prevProjectRef.current`）是不够的：
    //    模块热替换会重新执行 chatStore、把 store 重置成空状态
    //    （currentProjectId 归空、hydrated 归 false），而组件被 Fast Refresh **保留**、
    //    useRef 里的 id 没变 ⇒ 这里会把「store 被清空」误判成「没换项目」而早退，
    //    `switchToProject` 永远不被调用，面板就一直空着，只能整页刷新才回来。
    if (chatProjectId === pid && chatHydrated) {
      prevProjectRef.current = pid;
      return;
    }

    // 空 id 且此前也是空的：没有可加载的项目，直接跳过
    // （避免对 '' 调用 switchToProject，那会白走一趟保存逻辑）
    if (!pid && !prevProjectRef.current) return;

    prevProjectRef.current = pid;
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
          {/* 🔴 `activeConversation` 为 undefined 时必须给出可见交代。
              原来只有下面那一条判据，而它在 undefined 时**什么也不渲染**：
              `activeConversation?.messages.length === 0` 求值是 `undefined === 0` = false。
              「一条对话都没有」与「有对话但全被 currentEpisodeId 过滤掉」两种情况
              都会落到这里 —— 面板看起来就像被清空了。
              上面那个自愈 effect 会在一帧内把选中项挪到可见对话上，所以这条只是兜底，
              不会与它抢。 */}
          {!activeConversation && !isStreaming && (
            <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-3">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              <p className="text-sm">{t('chat.noConversations', '暂无对话')}</p>
            </div>
          )}

          {activeConversation?.messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-3">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              <p className="text-sm">{t('chat.emptyState', '描述你的想法，小鸭分镜大师会帮你生成专业分镜提示词')}</p>
            </div>
          )}

          {activeConversation?.messages.flatMap((msg) => {
            // 🔴 用户定调：「前边五步不需要显示给用户内容，
            //    用户能看到的，就是最终的视频提示词，用户选择是直出还是宫格就行了」。
            //
            // ① **机器替用户发的锚点整条不渲染** —— 自动串联每跑完一步就替用户发一条
            //    `【阶段】STEPn`，那是机器对机器的对话，落成气泡对用户只是噪音。
            //    ⚠️ 判据必须精确到 `【阶段】`：用户贴的脚本首行**常常也是 `【` 开头**
            //    （`【场景】雨夜…`），放宽到「首行是 `【`」会把用户的脚本一起吞掉
            //    —— 见 `stageCards.isStageAnchorMessage` 的注释。
            if (msg.role === 'user' && isStageAnchorMessage(msg.content)) return null;

            // ② **过程步=缩略回执**：一行步骤名 + 两行正文预览，点标题展开全文。
            //    ⇒ 与「前边五步不显示内容」合起来的读法是
            //      **默认不占版面，但要能看到写手在干嘛**。
            //    🔴 **这里只换气泡、不能提前 `return`** —— 下面那段选项卡逻辑还得走：
            //       `STEP5.5` 正是过程步的**最后一格**，那张「宫格 / 直出 / 重跑自检」
            //       三选一的卡就挂在它身上（提前 return 会把卡一起吞掉）。
            const isProcess = msg.role === 'assistant' && isProcessStage(msg.stage);
            const bubble = isProcess ? (
              <StageProcessLine key={msg.id} content={msg.content} stage={msg.stage} />
            ) : (
              <ChatBubble key={msg.id} message={msg} />
            );

            // ── 气泡外的动作区 ────────────────────────────────────────────────
            // 🔴 用户定调（原话）：「**直接生成视频的按钮跑到气泡里面了，
            //    这个是有问题的，必须在气泡外**」。
            // ⇒ 分叉按钮（生成宫格分镜 / 生成宫格图 / 直接生成视频）住在**这里**，
            //    **不再住在 `EditablePromptBlock` 里面**。
            //
            // 🔴 它**不看 `msg.stage`**：老会话（`stage` 为 `undefined`）里那个
            //    「生成宫格图」按钮一直长在提示词块里、从不依赖 `stage`；搬到这儿必须
            //    保持同样的覆盖范围，否则老对话会凭空少一个按钮。
            const videoBlock = msg.promptBlocks?.find((b) => b.type === 'video' && b.content.trim());
            const gridBlock = msg.promptBlocks?.find((b) => b.type === 'grid' && b.content.trim());

            // 🔴 **这里现算，不直接读 `block.selectedRefImages`。**
            //    那个字段是**解析时刻**的缓存，老块**连键都没有**（`undefined` 不进 JSON），
            //    而会话加载路径不会再解析一遍 ⇒ 用户点「直接生成视频」时它恒为 `undefined`
            //    ⇒ Canvas 判「写手没选图」⇒ **一张参考图都不挂**。
            //    判据一直在 `content` 里，所以读取时刻现算即可；四级顺序见
            //    `resolveSelectedRefImages` 的注释 —— 先盘上（解析时刻的权威值），
            //    再正文现算；宫格块优先于视频块，与改动前的 `??` 链**同序**。
            const blockRefImages =
              gridBlock?.selectedRefImages ??
              videoBlock?.selectedRefImages ??
              resolveSelectedRefImages(gridBlock) ??
              resolveSelectedRefImages(videoBlock);

            // 🔴 用户上报：「在生成状态步骤提示中，多出了这两个按钮，需要去掉，
            //    视频提示词下方有这两个按钮是对的」。
            //    起因：写手在**过程步**里也可能吐出一份完整六段式，解析器照常建出
            //    `video` 块，而这里若不看 `stage` ⇒ 分叉按钮被挂到 `StageProcessLine`
            //    那条**回执**下面，看着就像「步骤提示自己长了两个按钮」。
            // ⇒ 加一条 `!isProcess`：**过程步只当回执，不发指令**。该出现分叉按钮的是
            //    `STEP6` —— 唯一产出送模型正文的那一步，它**不是**过程步。
            //    老会话 `stage` 为 `undefined` ⇒ `isProcessStage` 返回 `false` ⇒ 覆盖范围不变。
            const showActions =
              !isProcess &&
              !isStreaming &&
              msg.role === 'assistant' &&
              Boolean(videoBlock || gridBlock);

            // 🔴 会自动续下一步的那些步**不渲染选项卡**。
            //    渲染了也只存在一帧（下一帧锚点就被自动发出去），用户看到的是「闪一下」。
            //    链路停在 `STEP6`、用户点了停止（`autoChain` 转 false）、或这一步不在主链上时，
            //    选择权才交回用户 —— 那时卡片照常出现。
            const chainContinues =
              autoChain && msg.stage
                ? autoNextAnchor(msg.stage, autoChainMode) !== null
                : false;

            // 🔴 **选项卡查表，不写死**（新协议）。
            //    旧代码在这里硬编码了两张卡（L2 的「A-生成宫格提示词 / 继续生成下一段」、
            //    L3 的「继续 / 暂停」），发的都是裸词 —— 那套词表连同协议一起废掉了。
            //    现在**光标在前端**：`msg.stage` 是产生这条回复时我们问的那一步，
            //    从这里查 `STAGE_CARDS` 得到该屏的选项，每个选项自带一行锚点。
            //    「写手该输出什么」住在 B 层（`writer_rules/step_shapes.md`），**不在这里**。
            const showCard =
              !isStreaming && msg.role === 'assistant' && Boolean(msg.stage) && !chainContinues;
            //    `unitPlan` 只有 `STEP6` 用得上（「出下一单元」）；其余步骤忽略它。
            const card = showCard && msg.stage ? cardForStage(msg.stage, unitPlan) : null;
            const cardHasOptions = Boolean(card && card.options.length > 0);

            if (!showActions && !cardHasOptions) return bubble;

            return [
              bubble,
              (showActions || cardHasOptions) && (
                <div key={`${msg.id}-actions`} className="flex flex-col items-start gap-2 px-1 pt-2">
                  {/* ① **分叉按钮**：主决策，放最上面。
                      宫格那份数据取自 `grid` 块（`frames` / `shotFrameMap` / 场景锚点都在它身上），
                      直出那份取自 `video` 块 —— 用户**可能刚编辑过**，要发的就是改后的那一份。 */}
                  {showActions && (
                    <FillGridButtons
                      prompt={gridBlock?.content ?? videoBlock?.content ?? ''}
                      frames={gridBlock?.frames}
                      conversationId={activeConversation?.id}
                      shotFrameMap={gridBlock?.shotFrameMap}
                      selectedRefImages={blockRefImages}
                      storySynopsis={gridBlock?.storySynopsis}
                      characterContext={gridBlock?.characterContext}
                      sceneContext={gridBlock?.sceneContext}
                      // ⚠️ 只有 **video** 块的正文才是送视频模型的六段式；`grid` 块的正文是
                      //    6 格描述，拿它当直出正文会把宫格描述喂给模型。
                      directPrompt={videoBlock?.content}
                      directSelectedRefImages={blockRefImages}
                      // 没有 `grid` 块 = 写手按 `【模式】直出` 跑的、这一轮**还没有** 6 格
                      // ⇒ 宫格按钮变成「生成宫格分镜」（再问写手要一次），见 `needsCells`。
                      needsCells={!gridBlock}
                    />
                  )}

                  {/* ② 选项卡（复检按钮已按用户定调摘除入口、保留能力） */}
                  {card && card.options.length > 0 && (
                    <>
                      {card.question && (
                        <p className="text-xs text-[var(--text-muted)]">{t(card.questionKey, card.question)}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {card.options.map((option) => (
                          <button
                            key={option.labelKey}
                            type="button"
                            onClick={() => useChatStore.getState().sendMessage(option.anchor)}
                            className={
                              option.recommended
                                ? 'px-4 py-2 text-sm font-medium rounded-xl bg-[var(--accent)] text-white hover:opacity-90 transition-opacity shadow-sm'
                                : 'px-4 py-2 text-sm font-medium rounded-xl bg-[var(--surface)] text-[var(--text)] border border-[var(--ui-border-soft)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors'
                            }
                          >
                            {t(option.labelKey, {
                              ...(option.labelVars ?? {}),
                              defaultValue: option.label,
                            })}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ),
            ].filter(Boolean);
          })}

          {/* Streaming message
              🔴 不要给 `content` 加 `|| '...'` 之类的兜底：
              `ChatBubble` 靠 `isStreaming && !message.content` 判断「还没出字」。
              写手调用是**非流式**的，`streamingText` 在整条链路上只被赋值为空串
              ⇒ 任何非空兜底都会让 `!message.content` 恒为 false，
              「正在写」的那个点阵动画一次都进不去，用户看到的就永远是兜底字符串。 */}
          {isStreaming && streamingMessageId && (
            <ChatBubble
              message={{
                id: streamingMessageId,
                role: 'assistant',
                content: streamingText,
                timestamp: Date.now(),
              }}
              isStreaming
              phase={streamPhase}
              stage={streamingStage}
            />
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-500">
              {error}
            </div>
          )}

          {/* 对话文件损坏告警 —— 不能静默：「记录没了」和「文件还在、只是我们不敢写」是两回事 */}
          {chatStorageWarning && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-600 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="break-words">
                  {chatStorageWarning.kind === 'backedUp'
                    ? t('chat.storageWarningBackedUp', { path: chatStorageWarning.path })
                    : t('chat.storageWarningWriteBlocked')}
                </p>
                <button
                  type="button"
                  onClick={() => setChatStorageWarning(null)}
                  className="mt-1.5 text-xs underline opacity-70 hover:opacity-100"
                >
                  {t('common.dismiss')}
                </button>
              </div>
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
