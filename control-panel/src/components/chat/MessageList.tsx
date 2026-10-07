'use client';

import clsx from 'clsx';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import type { ChatMessage, ChatRole } from '@/lib/types';

export interface MessageListProps {
  messages: ChatMessage[];
  onChange: (messages: ChatMessage[]) => void;
  disabled?: boolean;
  /** Live assistant text while a stream is in flight. */
  streamingText?: string;
  streamingModel?: string | null;
  reasoningText?: string;
}

const ROLE_TONE: Record<ChatRole, 'green' | 'blue' | 'orange'> = {
  system: 'orange',
  user: 'blue',
  assistant: 'green',
};

const BUBBLE: Record<ChatRole, string> = {
  system: 'chat-bubble chat-bubble-system',
  user: 'chat-bubble chat-bubble-user',
  assistant: 'chat-bubble chat-bubble-assistant',
};

/** Ordered, editable conversation with add/remove/reorder controls. */
export function MessageList({
  messages,
  onChange,
  disabled,
  streamingText,
  streamingModel,
  reasoningText,
}: MessageListProps) {
  const update = (index: number, patch: Partial<ChatMessage>): void => {
    const next = messages.map((message, position) =>
      position === index ? { ...message, ...patch } : message,
    );
    onChange(next);
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= messages.length) return;
    const next = [...messages];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    onChange(next);
  };

  const remove = (index: number): void => {
    onChange(messages.filter((_, position) => position !== index));
  };

  const add = (role: ChatRole): void => {
    onChange([
      ...messages,
      { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role, content: '' },
    ]);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-white/50">
          Conversation
        </span>
        <span className="text-[11px] text-white/35">{messages.length} message(s)</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => add('system')} disabled={disabled}>
            + system
          </Button>
          <Button size="sm" variant="ghost" onClick={() => add('user')} disabled={disabled}>
            + user
          </Button>
          <Button size="sm" variant="ghost" onClick={() => add('assistant')} disabled={disabled}>
            + assistant
          </Button>
        </div>
      </div>

      <ol className="space-y-2.5">
        {messages.map((message, index) => (
          <li key={message.id} className="group">
            <div className="mb-1 flex items-center gap-2">
              <Badge tone={ROLE_TONE[message.role]}>{message.role}</Badge>
              <span className="font-mono text-[10px] text-white/30">#{index + 1}</span>
              <div className="ml-auto flex gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move message ${index + 1} up`}
                  onClick={() => move(index, -1)}
                  disabled={disabled || index === 0}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move message ${index + 1} down`}
                  onClick={() => move(index, 1)}
                  disabled={disabled || index === messages.length - 1}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete message ${index + 1}`}
                  onClick={() => remove(index)}
                  disabled={disabled}
                >
                  ✕
                </Button>
              </div>
            </div>
            <textarea
              value={message.content}
              onChange={(event) => update(index, { content: event.target.value })}
              rows={Math.min(10, Math.max(2, Math.ceil(message.content.length / 90)))}
              disabled={disabled}
              aria-label={`${message.role} message ${index + 1} content`}
              placeholder={message.role === 'assistant' ? 'Assistant turn (optional)…' : 'Type here…'}
              className={clsx(BUBBLE[message.role], 'w-full resize-y text-white/85 glass-input')}
            />
          </li>
        ))}

        {streamingText !== undefined ? (
          <li>
            <div className="mb-1 flex items-center gap-2">
              <Badge tone="green">assistant</Badge>
              {streamingModel ? (
                <span className="font-mono text-[10px] text-white/35">{streamingModel}</span>
              ) : null}
              <span className="text-[10px] text-white/40">streaming…</span>
            </div>
            {reasoningText ? (
              <div className="mb-1.5 rounded-xl border border-white/10 bg-white/5 p-2 text-[11px] italic text-white/50">
                {reasoningText}
              </div>
            ) : null}
            <div className={clsx(BUBBLE.assistant, 'caret')}>
              {streamingText === '' ? <span className="text-white/35">waiting for first token…</span> : streamingText}
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

export default MessageList;
