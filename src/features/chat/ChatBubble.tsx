import { useTranslation } from 'react-i18next';
import { type ChatMessage, type ChatPhase } from '@/stores/chatStore';
import { EditablePromptBlock } from './EditablePromptBlock';
import {
  STAGE_NAME_KEY,
  STAGE_NAME_FALLBACK,
  chainProgress,
  type StageId,
} from './stageCards';

interface ChatBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  /** 在途阶段（见 `ChatPhase`）。缺省时按「正在思考」显示。 */
  phase?: ChatPhase | null;
  /**
   * 在途的**那一步**（见 `chatStore.streamingStage`）。
   * 有它时**优先于** `phase` 显示 —— 用户定调：「左下的思考中，就提示每一步的名称就行」。
   */
  stage?: StageId | null;
}

/**
 * 阶段 → i18n key。
 *
 * 写手调用是**非流式**的（`endpoint.rs` 里 `"stream": false`），客户端拿不到
 * token 级信号，所以这里报的是**我们确实知道的阶段**，不是猜模型在想什么。
 */
const PHASE_LABEL_KEY: Record<ChatPhase, string> = {
  reading: 'chat.phaseReading',
  thinking: 'chat.phaseThinking',
};

export function ChatBubble({ message, isStreaming, phase, stage }: ChatBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';

  const hasBlocks =
    !isUser && !isStreaming && message.promptBlocks && message.promptBlocks.length > 0;

  // 「思考中」那一行：**优先报步骤名**（用户定调），带上主干进度 `6/8`。
  // 没有步骤名（例如发「暂停」、或老会话）时退回 `phase` 那套动作文案。
  //
  // 🔴 不报「模型在推理什么」—— 写手调用是非流式的（`endpoint.rs` 的 `"stream": false`），
  //    客户端拿不到 token 级信号。这里报的是**我们确实知道的**：我们刚问的是哪一步。
  const stageName =
    stage && STAGE_NAME_KEY[stage]
      ? t(STAGE_NAME_KEY[stage], STAGE_NAME_FALLBACK[stage] ?? stage)
      : '';
  const progress = stage ? chainProgress(stage) : null;

  const inFlightLabel = stageName
    ? progress
      ? t('chat.stageName.writing', {
          name: stageName,
          index: progress.index,
          total: progress.total,
          defaultValue: '正在写：{{name}}（{{index}}/{{total}}）',
        })
      : t('chat.stageName.writingPlain', {
          name: stageName,
          defaultValue: '正在写：{{name}}',
        })
    : t(PHASE_LABEL_KEY[phase ?? 'thinking']);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${hasBlocks ? 'flex-col' : ''} px-4`}>
      {!hasBlocks && (
        <div
          className={`
            max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed
            ${isUser
              ? 'bg-[var(--accent)] text-white rounded-br-md'
              : 'bg-[var(--surface)] text-[var(--text)] rounded-bl-md'
            }
            ${isStreaming ? 'animate-pulse' : ''}
          `}
        >
          {isStreaming && !message.content ? (
            <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
              <span>{inFlightLabel}</span>
              <span className="inline-flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-current animate-bounce" />
                <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:0.15s]" />
                <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:0.3s]" />
              </span>
            </span>
          ) : (
            <div className="whitespace-pre-wrap break-words">
              {message.content}
            </div>
          )}
        </div>
      )}

      {hasBlocks && (
        <div className="space-y-3">
          {message.promptBlocks!.map((block) => (
            <EditablePromptBlock
              key={block.id}
              block={block}
              messageId={message.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
