import { type ChatMessage } from '@/stores/chatStore';
import { EditablePromptBlock } from './EditablePromptBlock';

interface ChatBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export function ChatBubble({ message, isStreaming }: ChatBubbleProps) {
  const isUser = message.role === 'user';

  const hasBlocks =
    !isUser && !isStreaming && message.promptBlocks && message.promptBlocks.length > 0;

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
            <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:0.3s]" />
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
