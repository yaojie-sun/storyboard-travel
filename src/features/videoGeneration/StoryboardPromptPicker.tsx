import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Video } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useEpisodeStore } from '@/stores/episodeStore';
import type { PromptBlock } from '@/stores/chatStore';
import { UiChipButton, UiModal } from '@/components/ui';

interface StoryboardPromptPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (prompt: string, gridFrames?: string[]) => void;
}

interface PromptEntry {
  id: string;
  prompt: string;
  sourceType: 'video' | 'grid' | 'frames';
  frameCount?: number;
  label: string;
  gridFrames?: string[];
}

/** Strip grid-question tail from video prompts before extracting */
function stripGridQuestionTail(prompt: string): string {
  return prompt
    .replace(/[\s\n]*🎬\s*视频提示词已生成[\s\S]*$/, '')
    .replace(/[\s\n]*---\s*\n[\s\S]*$/, '')
    .replace(/[\s\n]*需要.*?宫格.*?A-生成[\s\S]*$/, '')
    .replace(/[\s\n]*是否需要生成宫格分镜图[\s\S]*$/, '')
    .replace(/[\s\n]*请确认是否需要生成[\s\S]*$/, '')
    .replace(/[\s\n]*-\s*A[：:][\s\S]*$/, '')
    .replace(/[\s\n]*A[\.\s、：:][\s\S]*$/, '')
    .trim();
}

function buildEntryFromBlock(block: PromptBlock, msgIndex: number, blockIndex: number, allBlocks: PromptBlock[], convIndex: number): PromptEntry | null {
  if (block.type === 'video' && block.content.trim()) {
    const cleaned = stripGridQuestionTail(block.content.trim());
    if (!cleaned) return null;
    let gridFrames: string[] | undefined;
    const nextBlock = allBlocks[blockIndex + 1];
    if (nextBlock?.type === 'grid' && nextBlock.frames?.length) {
      gridFrames = nextBlock.frames.map((f) => f.description).filter(Boolean);
    }
    const prevBlock = allBlocks[blockIndex - 1];
    if (!gridFrames && prevBlock?.type === 'grid' && prevBlock.frames?.length) {
      gridFrames = prevBlock.frames.map((f) => f.description).filter(Boolean);
    }
    return {
      id: `c${convIndex}-m${msgIndex}-b${blockIndex}-video`,
      prompt: cleaned,
      sourceType: 'video',
      label: `视频提示词 #${msgIndex + 1}`,
      gridFrames: gridFrames?.length ? gridFrames : undefined,
    };
  }
  return null;
}

export function StoryboardPromptPicker({ isOpen, onClose, onSelect }: StoryboardPromptPickerProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const conversations = useChatStore((s) => s.conversations);
  const chatHydrated = useChatStore((s) => s.hydrated);
  const forceRehydrate = useChatStore((s) => s.forceRehydrate);
  const currentEpisodeId = useEpisodeStore((s) => s.currentEpisodeId);

  useEffect(() => {
    if (!isOpen) return;

    const loadPrompts = async () => {
      if (!chatHydrated) {
        await forceRehydrate();
      }
      setLoading(true);

      const entries: PromptEntry[] = [];

      // 物理隔离：store 中 conversations 已是当前项目数据，只需按 episodeId 隔离子项目
      const projectConvs = currentEpisodeId
        ? conversations.filter((c) => !c.episodeId || c.episodeId === currentEpisodeId)
        : conversations;

      for (let ci = 0; ci < projectConvs.length; ci++) {
        const c = projectConvs[ci];
        const convIndex = conversations.indexOf(c);
        const messages = c.messages;
        for (let mi = 0; mi < messages.length; mi++) {
          const msg = messages[mi];
          if (msg.role !== 'assistant' || !msg.promptBlocks) continue;
          for (let bi = 0; bi < msg.promptBlocks.length; bi++) {
            const entry = buildEntryFromBlock(msg.promptBlocks[bi], mi, bi, msg.promptBlocks!, convIndex);
            if (entry) entries.push(entry);
          }
        }
      }


      setPrompts(entries);
      if (entries.length > 0) setSelectedId(entries[0].id);
      setLoading(false);
    };

    loadPrompts();
  }, [isOpen]);

  const selectedPrompt = useMemo(() => {
    if (!selectedId) return '';
    return prompts.find((p) => p.id === selectedId)?.prompt || '';
  }, [selectedId, prompts]);

  const selectedEntry = useMemo(() => {
    if (!selectedId) return undefined;
    return prompts.find((p) => p.id === selectedId);
  }, [selectedId, prompts]);

  const handleConfirm = () => {
    if (selectedPrompt) {
      onSelect(selectedPrompt, selectedEntry?.gridFrames);
      setSelectedId(null);
      onClose();
    }
  };

  const iconForType = () => <Video className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />;

  return (
    <UiModal
      isOpen={isOpen}
      onClose={() => {
        setSelectedId(null);
        onClose();
      }}
      title={t('videoGen.pickStoryboardPrompt', '选择分镜提示词')}
      widthClassName="w-[560px]"
      footer={
        <div className="flex items-center justify-between gap-2 w-full">
          <span className="text-xs text-text-muted">
            {!selectedId
              ? t('videoGen.selectPromptHint', '↑ 请先在上方选择一条分镜提示词')
              : t('videoGen.promptSelected', '已选择分镜提示词')}
          </span>
          <div className="flex items-center gap-2">
            <UiChipButton
              className="h-8 px-3 text-xs"
              onClick={() => {
                setSelectedId(null);
                onClose();
              }}
            >
              {t('common.cancel', '取消')}
            </UiChipButton>
            <UiChipButton
              className="h-8 px-3 text-xs border-purple-400/60 bg-purple-500/20 text-purple-200"
              onClick={handleConfirm}
              disabled={!selectedId}
            >
              {t('common.confirm', '确认')}
            </UiChipButton>
          </div>
        </div>
      }
    >
      <div className="ui-scrollbar max-h-[60vh] space-y-2 overflow-y-auto p-1">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('videoGen.loadingPrompts', '正在加载分镜提示词...')}
          </div>
        ) : prompts.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            {t('videoGen.noStoryboardPrompt', 'Chat 中暂无分镜/视频提示词，请先在 Chat 中生成分镜。')}
          </p>
        ) : (
          prompts.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              className={`w-full rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                selectedId === item.id
                  ? 'border-purple-400 bg-purple-500/20 text-text-dark ring-1 ring-purple-400/30'
                  : 'border-border-dark bg-bg-dark text-text-muted hover:border-purple-400/30'
              }`}
            >
              <div className="flex items-start gap-2">
                {iconForType()}
                <span className="max-h-44 overflow-y-auto whitespace-pre-wrap break-all text-xs leading-relaxed ui-scrollbar">
                  {item.prompt}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-text-muted/60">
                {item.label}
              </div>
            </button>
          ))
        )}
      </div>
    </UiModal>
  );
}
