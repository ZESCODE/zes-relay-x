import { readdir, readFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ChatParams, ChatPreset } from '@/lib/types';
import { env } from './env';
import { ensureDataLayout, paths, withLock, writeJsonAtomic } from './fs-paths';
import { getLogBus } from './log-bus';
import { DEFAULT_PARAMS, parseMessages, parseParams } from './chat-payload';
import { ApiHttpError } from './http';

/**
 * Playground presets — one JSON file per preset under `data/presets/`.
 *
 * Ids are always regenerated server-side (never taken from the client) so a
 * crafted request cannot escape the presets directory.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base === '' ? 'preset' : base;
}

function newId(name: string): string {
  return `${slugify(name)}-${randomBytes(3).toString('hex')}`;
}

export interface PresetInput {
  name: string;
  params: ChatParams;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export class PresetStore {
  async list(): Promise<ChatPreset[]> {
    ensureDataLayout();
    const dir = paths().presetsDir;
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
    } catch {
      return [];
    }
    const presets: ChatPreset[] = [];
    for (const file of files) {
      const preset = await this.readFile(path.join(dir, file));
      if (preset) presets.push(preset);
    }
    return presets.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  }

  async get(id: string): Promise<ChatPreset | null> {
    if (!ID_PATTERN.test(id)) return null;
    return this.readFile(path.join(paths().presetsDir, `${id}.json`));
  }

  async create(input: PresetInput): Promise<ChatPreset> {
    ensureDataLayout();
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 80) {
      throw new ApiHttpError('validation_failed', 'Preset name must be 1–80 characters.', 422);
    }

    const messages = parseMessages(input.messages);
    const params = parseParams(input.params ?? {}, DEFAULT_PARAMS);
    const id = newId(name);

    const existing = await this.list();
    if (existing.length >= env.maxPresets) {
      throw new ApiHttpError(
        'conflict',
        `Preset limit reached (${env.maxPresets}). Delete a preset before adding another.`,
        409,
      );
    }

    const now = new Date().toISOString();
    const preset: ChatPreset = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      params,
      messages,
    };

    await withLock(`preset:${id}`, async () => {
      await writeJsonAtomic(this.pathFor(id), preset, 0o600);
    });
    getLogBus().push({
      source: 'system',
      level: 'info',
      message: `Saved playground preset "${name}" (${id}).`,
    });
    return preset;
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) {
      throw new ApiHttpError('validation_failed', 'Invalid preset id.', 422);
    }
    const file = this.pathFor(id);
    if (!existsSync(file)) return false;
    return withLock(`preset:${id}`, async () => {
      try {
        unlinkSync(file);
        getLogBus().push({
          source: 'system',
          level: 'info',
          message: `Deleted playground preset ${id}.`,
        });
        return true;
      } catch {
        return false;
      }
    });
  }

  private pathFor(id: string): string {
    return path.join(paths().presetsDir, `${id}.json`);
  }

  private async readFile(file: string): Promise<ChatPreset | null> {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ChatPreset>;
      if (!parsed || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null;
      return {
        id: parsed.id,
        name: parsed.name,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        updatedAt: parsed.updatedAt ?? parsed.createdAt ?? new Date().toISOString(),
        params: { ...DEFAULT_PARAMS, ...(parsed.params ?? {}) },
        messages: Array.isArray(parsed.messages)
          ? parsed.messages
              .filter(
                (message): message is { role: 'system' | 'user' | 'assistant'; content: string } =>
                  Boolean(message) &&
                  typeof message === 'object' &&
                  typeof (message as { content?: unknown }).content === 'string' &&
                  ['system', 'user', 'assistant'].includes(
                    String((message as { role?: unknown }).role),
                  ),
              )
              .map((message) => ({ role: message.role, content: message.content }))
          : [],
      };
    } catch {
      return null;
    }
  }
}

const GLOBAL_KEY = Symbol.for('zes.panel.preset-store');

type GlobalWithPresets = typeof globalThis & { [GLOBAL_KEY]?: PresetStore };

export function getPresetStore(): PresetStore {
  const scope = globalThis as GlobalWithPresets;
  if (!scope[GLOBAL_KEY]) scope[GLOBAL_KEY] = new PresetStore();
  return scope[GLOBAL_KEY] as PresetStore;
}
