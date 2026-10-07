'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, SectionTitle } from '@/components/ui/Card';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/lib/hooks/useToast';
import { MessageList } from '@/components/chat/MessageList';
import { ParamForm } from '@/components/chat/ParamForm';
import { createPreset, deletePreset, fetchModels, fetchPresets } from '@/lib/api';
import { streamChatCompletion, type ChatStreamResult } from '@/lib/sse';
import { ApiClientError, csrfToken } from '@/lib/api';
import { formatBytes, formatJson, formatMs, formatNumber } from '@/lib/format';
import type { ChatMessage, ChatParams, ChatPreset, ModelInfo, ModelsResponse } from '@/lib/types';

export interface ChatPanelProps {
  initialModels: ModelsResponse;
  initialPresets: ChatPreset[];
}

interface RunStats {
  ttfbMs: number | null;
  totalMs: number;
  chunks: number;
  bytes: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  finishReason: string | null;
  requestId: string;
  model: string;
  status: number;
}

const DEFAULT_PARAMS: ChatParams = {
  model: '',
  temperature: 0.7,
  top_p: 1,
  max_tokens: null,
  presence_penalty: 0,
  frequency_penalty: 0,
  seed: null,
  stop: [],
  stream: true,
};

function newMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role, content };
}

/**
 * Playground.
 *
 * Streams token-by-token through `fetch` + `ReadableStream` (EventSource cannot
 * POST), shows TTFB/total latency and the usage from the final chunk, and keeps
 * the exact request/response payloads for inspection.
 */
export function ChatPanel({ initialModels, initialPresets }: ChatPanelProps) {
  const toast = useToast();
  const [modelsResponse, setModelsResponse] = useState(initialModels);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [params, setParams] = useState<ChatParams>({
    ...DEFAULT_PARAMS,
    model: initialModels.models[0]?.id ?? '',
  });
  const [messages, setMessages] = useState<ChatMessage[]>([
    newMessage('system', 'You are a concise, helpful assistant.'),
    newMessage('user', 'Explain in two sentences what this relay does.'),
  ]);
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState<string | undefined>(undefined);
  const [reasoningText, setReasoningText] = useState<string>('');
  const [stats, setStats] = useState<RunStats | null>(null);
  const [rawRequest, setRawRequest] = useState<string>('—');
  const [rawResponse, setRawResponse] = useState<string>('—');
  const [error, setError] = useState<string | null>(null);
  const [presets, setPresets] = useState<ChatPreset[]>(initialPresets);
  const [presetName, setPresetName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatPreset | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const responseBuffer = useRef<string>('');

  useEffect(() => () => abortRef.current?.abort(), []);

  const refreshModels = useCallback(
    async (refresh = true) => {
      setRefreshingModels(true);
      try {
        const response = await fetchModels(refresh);
        setModelsResponse(response);
        setParams((current) => ({
          ...current,
          model:
            current.model && response.models.some((model) => model.id === current.model)
              ? current.model
              : (response.models[0]?.id ?? ''),
        }));
        if (response.error) toast.warning('Model list degraded', response.error);
      } catch (caught) {
        toast.error('Could not load models', caught instanceof Error ? caught.message : String(caught));
      } finally {
        setRefreshingModels(false);
      }
    },
    [toast],
  );

  const payload = useMemo(
    () => ({
      model: params.model,
      messages: messages
        .filter((message) => message.content.trim() !== '')
        .map((message) => ({ role: message.role, content: message.content })),
      params,
    }),
    [messages, params],
  );

  const send = useCallback(async () => {
    if (params.model === '') {
      toast.error('Pick a model first');
      return;
    }
    if (payload.messages.length === 0) {
      toast.error('Add at least one non-empty message');
      return;
    }

    setError(null);
    setStats(null);
    setReasoningText('');
    responseBuffer.current = '';
    setRawResponse('—');
    setRawRequest(formatJson(payload));
    setStreamingText(params.stream ? '' : undefined);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let collected = '';
    let succeeded = false;

    try {
      const result = await streamChatCompletion(
        payload,
        {
          onDelta: (content) => {
            // Rendered immediately — the first token reaches the DOM before the
            // response finishes.
            collected += content;
            setStreamingText(collected);
          },
          onReasoning: (content) => setReasoningText((current) => current + content),
          onEvent: (event) => {
            responseBuffer.current += `${event.event}: ${event.data}\n`;
            if (responseBuffer.current.length > 200_000) {
              responseBuffer.current = responseBuffer.current.slice(-100_000);
            }
          },
          onDone: (final: ChatStreamResult) => {
            succeeded = true;
            setRawResponse(responseBuffer.current || formatJson(final));
            setStats({
              ttfbMs: final.ttfbMs,
              totalMs: final.totalMs,
              chunks: final.chunks,
              bytes: final.bytes,
              usage: final.usage,
              finishReason: final.finishReason,
              requestId: final.requestId,
              model: final.model || params.model,
              status: final.status,
            });
          },
          onError: (caught) => {
            setError(caught.message);
          },
        },
        { signal: controller.signal, csrfToken: csrfToken() },
      );

      if (succeeded || result.status < 400) {
        setMessages((current) => [
          ...current,
          newMessage('assistant', collected === '' ? '(empty response)' : collected),
        ]);
      }
      if (!result.usage) {
        toast.info(
          'No usage reported',
          'The upstream did not include a usage object in the final chunk.',
        );
      }
    } catch (caught) {
      const message =
        caught instanceof ApiClientError
          ? caught.message
          : caught instanceof DOMException && caught.name === 'AbortError'
            ? 'Stream cancelled'
            : caught instanceof Error
              ? caught.message
              : String(caught);
      setError(message);
      toast.error('Chat request failed', message);
    } finally {
      setRunning(false);
      setStreamingText(undefined);
      abortRef.current = null;
    }
  }, [params, payload, toast]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    toast.warning('Stream cancelled');
  }, [toast]);

  const savePreset = useCallback(async () => {
    if (presetName.trim().length < 1) {
      toast.error('Give the preset a name');
      return;
    }
    try {
      const { preset } = await createPreset({
        name: presetName.trim(),
        params,
        messages: payload.messages,
      });
      setPresets((current) => [...current, preset]);
      setPresetName('');
      setSaveOpen(false);
      toast.success('Preset saved', preset.id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      toast.error('Could not save the preset', message);
    }
  }, [params, payload.messages, presetName, toast]);

  const applyPreset = useCallback(
    (preset: ChatPreset) => {
      setParams({ ...DEFAULT_PARAMS, ...preset.params });
      setMessages(preset.messages.map((message) => newMessage(message.role, message.content)));
      toast.info('Preset loaded', preset.name);
    },
    [toast],
  );

  const removePreset = useCallback(
    async (preset: ChatPreset) => {
      try {
        await deletePreset(preset.id);
        setPresets((current) => current.filter((item) => item.id !== preset.id));
        toast.success('Preset deleted', preset.name);
      } catch (caught) {
        toast.error('Could not delete the preset', caught instanceof Error ? caught.message : String(caught));
      } finally {
        setDeleteTarget(null);
      }
    },
    [toast],
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[20rem_1fr_20rem]">
      {/* ── parameters ─────────────────────────────────────────────────── */}
      <Card tone="plain" className="h-fit xl:sticky xl:top-5">
        <CardHeader title="Parameters" subtitle="Sent to /api/chat → relay → upstream" />
        <ParamForm
          params={params}
          models={modelsResponse.models}
          modelsSource={modelsResponse.source}
          modelsError={modelsResponse.error}
          onParamsChange={setParams}
          onRefreshModels={() => void refreshModels(true)}
          refreshingModels={refreshingModels}
          disabled={running}
        />
      </Card>

      {/* ── conversation ───────────────────────────────────────────────── */}
      <Card tone="plain" className="flex min-h-[32rem] flex-col">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle className="mb-0" hint={params.stream ? 'streaming SSE' : 'single JSON response'}>
            Playground
          </SectionTitle>
          <div className="flex items-center gap-2">
            <Badge tone={running ? 'green' : 'neutral'} dot={running}>
              {running ? 'streaming' : 'idle'}
            </Badge>
            {stats ? (
              <Badge tone="blue" size="md">
                TTFB {formatMs(stats.ttfbMs)} · total {formatMs(stats.totalMs)}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex-1">
          <MessageList
            messages={messages}
            onChange={setMessages}
            disabled={running}
            streamingText={streamingText}
            streamingModel={stats?.model ?? params.model}
            reasoningText={reasoningText || undefined}
          />
        </div>

        {error ? (
          <p role="alert" className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-200">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="frost" onClick={() => void send()} loading={running} disabled={running}>
            Send request
          </Button>
          <Button variant="destructive" onClick={cancel} disabled={!running}>
            Cancel stream
          </Button>
          <Button variant="ghost" onClick={() => setSaveOpen(true)} disabled={running}>
            Save preset
          </Button>
        </div>
      </Card>

      {/* ── presets + stats + raw panes ────────────────────────────────── */}
      <div className="space-y-4">
        <Card tone="plain">
          <CardHeader title="Presets" subtitle={`${presets.length} saved in data/presets/`} />
          {presets.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-white/40">
              No presets yet — configure the request, then “Save preset”.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {presets.map((preset) => (
                <li
                  key={preset.id}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className="min-w-0 flex-1 text-left text-xs text-white/80 transition hover:text-white"
                  >
                    <span className="block truncate">{preset.name}</span>
                    <span className="block font-mono text-[10px] text-white/35">
                      {preset.params.model || 'no model'} · {preset.messages.length} msg
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(preset)}
                    aria-label={`Delete preset ${preset.name}`}
                    className="rounded-md px-1.5 text-white/40 transition hover:bg-white/10 hover:text-red-300"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card tone="plain">
          <CardHeader title="Usage & timing" subtitle="From the final stream chunk" />
          {stats ? (
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">Finish reason</dt>
                <dd className="font-mono text-white/80">{stats.finishReason ?? '—'}</dd>
              </div>
              {stats.usage ? (
                <>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/45">prompt tokens</dt>
                    <dd className="font-mono text-white/80">{formatNumber(stats.usage.prompt_tokens)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/45">completion tokens</dt>
                    <dd className="font-mono text-white/80">{formatNumber(stats.usage.completion_tokens)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/45">total tokens</dt>
                    <dd className="font-mono text-white/80">{formatNumber(stats.usage.total_tokens)}</dd>
                  </div>
                </>
              ) : (
                <p className="text-white/45">Upstream did not report usage for this response.</p>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">chunks</dt>
                <dd className="font-mono text-white/80">{formatNumber(stats.chunks)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">payload</dt>
                <dd className="font-mono text-white/80">{formatBytes(stats.bytes)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/45">request id</dt>
                <dd className="max-w-[8rem] truncate font-mono text-white/60">{stats.requestId || '—'}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-white/45">
              Send a request to see TTFB, total latency and token usage.
            </p>
          )}
        </Card>

        <details className="glass-card rounded-2xl p-4">
          <summary className="cursor-pointer text-sm font-medium text-white/80">
            Raw request / raw response
          </summary>
          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-widest text-white/45">Request body</p>
              <pre className="code-pane scroll-slim max-h-64">{rawRequest}</pre>
            </div>
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-widest text-white/45">
                Response stream (SSE frames)
              </p>
              <pre className="code-pane scroll-slim max-h-64">{rawResponse}</pre>
            </div>
          </div>
        </details>
      </div>

      {/* ── save preset modal ──────────────────────────────────────────── */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save preset"
        description="Stores the parameters and messages under data/presets/."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button variant="frost" onClick={() => void savePreset()}>
              Save
            </Button>
          </>
        }
      >
        <Input
          label="Preset name"
          value={presetName}
          onChange={(event) => setPresetName(event.target.value)}
          placeholder="e.g. Creative story"
          maxLength={80}
          autoFocus
        />
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete preset?"
        message={`"${deleteTarget?.name}" will be removed from data/presets/.`}
        confirmLabel="Delete"
        destructive
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void removePreset(deleteTarget)}
      />
    </div>
  );
}

export default ChatPanel;
