'use client';

import { Input, Select, Slider, Toggle } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import type { ChatParams, ModelInfo } from '@/lib/types';

export interface ParamFormProps {
  params: ChatParams;
  models: ModelInfo[];
  modelsSource: 'relay' | 'cache' | 'fallback';
  modelsError: string | null;
  onParamsChange: (next: ChatParams) => void;
  onRefreshModels: () => void;
  refreshingModels: boolean;
  disabled?: boolean;
}

/** All sampling controls for the next completion. */
export function ParamForm({
  params,
  models,
  modelsSource,
  modelsError,
  onParamsChange,
  onRefreshModels,
  refreshingModels,
  disabled,
}: ParamFormProps) {
  const update = <K extends keyof ChatParams>(key: K, value: ChatParams[K]): void => {
    onParamsChange({ ...params, [key]: value });
  };

  const modelOptions = models.map((model) => ({ value: model.id, label: model.id }));

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Select
          label="Model"
          value={params.model}
          onChange={(event) => update('model', event.target.value)}
          options={modelOptions}
          placeholder={models.length === 0 ? 'No models available' : 'Select a model…'}
          disabled={disabled || models.length === 0}
          hint={
            modelsError
              ? `Relay unreachable — showing ${modelsSource} list. ${modelsError}`
              : `${models.length} models from ${modelsSource}`
          }
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefreshModels}
            disabled={refreshingModels}
            className="rounded-lg border border-white/15 px-2 py-0.5 text-[11px] text-white/60 transition hover:bg-white/10 disabled:opacity-50"
          >
            {refreshingModels ? 'Refreshing…' : 'Refresh list'}
          </button>
          {modelsSource !== 'relay' ? <Badge tone="orange">{modelsSource}</Badge> : null}
        </div>
      </div>

      <Slider
        label="temperature"
        value={params.temperature}
        min={0}
        max={2}
        step={0.05}
        onChange={(value) => update('temperature', value)}
        disabled={disabled}
        format={(value) => value.toFixed(2)}
      />

      <Slider
        label="top_p"
        value={params.top_p}
        min={0}
        max={1}
        step={0.01}
        onChange={(value) => update('top_p', value)}
        disabled={disabled}
        format={(value) => value.toFixed(2)}
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="max_tokens"
          type="number"
          min={1}
          max={1_000_000}
          inputMode="numeric"
          value={params.max_tokens ?? ''}
          placeholder="default"
          onChange={(event) =>
            update('max_tokens', event.target.value === '' ? null : Number.parseInt(event.target.value, 10))
          }
          disabled={disabled}
        />
        <Input
          label="seed"
          type="number"
          min={0}
          inputMode="numeric"
          value={params.seed ?? ''}
          placeholder="random"
          onChange={(event) =>
            update('seed', event.target.value === '' ? null : Number.parseInt(event.target.value, 10))
          }
          disabled={disabled}
        />
      </div>

      <Slider
        label="presence_penalty"
        value={params.presence_penalty}
        min={-2}
        max={2}
        step={0.1}
        onChange={(value) => update('presence_penalty', value)}
        disabled={disabled}
        format={(value) => value.toFixed(1)}
      />

      <Slider
        label="frequency_penalty"
        value={params.frequency_penalty}
        min={-2}
        max={2}
        step={0.1}
        onChange={(value) => update('frequency_penalty', value)}
        disabled={disabled}
        format={(value) => value.toFixed(1)}
      />

      <Input
        label="stop sequences"
        value={params.stop.join(', ')}
        placeholder="comma separated, max 4"
        onChange={(event) =>
          update(
            'stop',
            event.target.value
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item !== '')
              .slice(0, 4),
          )
        }
        disabled={disabled}
        hint="Sent as the OpenAI `stop` array."
      />

      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
        <Toggle
          label="Stream response"
          hint="Token-by-token SSE (recommended). Turn off to receive a single JSON object."
          checked={params.stream}
          onChange={(value) => update('stream', value)}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export default ParamForm;
