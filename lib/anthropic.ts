import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from './types';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

let cachedKey: string | null | undefined;

/**
 * Resolve the Anthropic key from the app env first, then fall back to the key
 * Hermes already stores in ~/.hermes/.env — so the machine keeps one secret and
 * rotating it in one place updates both Hermes and the co-browse teacher.
 */
export function anthropicKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return (cachedKey = fromEnv);
  try {
    const env = readFileSync(join(homedir(), '.hermes', '.env'), 'utf8');
    const match = env.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    cachedKey = match ? match[1].trim() : null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

export function anthropicAvailable(): boolean {
  return Boolean(anthropicKey());
}

export interface AnthropicChatOptions {
  system: string;
  messages: ChatMessage[];
  /** Small by default — co-browse teaching is 1-3 spoken sentences, and a tight
   *  cap is the biggest latency lever (output tokens dominate response time). */
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export async function anthropicChat(options: AnthropicChatOptions): Promise<string> {
  const key = anthropicKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (and not found in ~/.hermes/.env).');

  const model = options.model || process.env.COBROWSE_TEACHER_MODEL || DEFAULT_MODEL;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? 160,
      temperature: options.temperature ?? 0.5,
      // Cache the static teaching instructions so repeated turns skip re-processing it.
      system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
      messages: options.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic request failed (${res.status}). ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

/**
 * Streaming variant: calls `onDelta` with each text fragment as it arrives so
 * the caller can start speaking the first sentence before generation finishes.
 * Returns the full text once complete.
 */
export async function anthropicStream(
  options: AnthropicChatOptions,
  onDelta: (text: string) => void,
): Promise<string> {
  const key = anthropicKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (and not found in ~/.hermes/.env).');

  const model = options.model || process.env.COBROWSE_TEACHER_MODEL || DEFAULT_MODEL;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: options.maxTokens ?? 200,
      temperature: options.temperature ?? 0.5,
      system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
      messages: options.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic stream failed (${res.status}). ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text ?? '';
          if (text) {
            full += text;
            onDelta(text);
          }
        }
      } catch {
        /* ignore non-JSON keepalives */
      }
    }
  }
  return full.trim();
}
