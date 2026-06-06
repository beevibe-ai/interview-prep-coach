import { randomUUID } from 'node:crypto';
import type { PageContext } from './teacher-contracts';

const MAX_VISIBLE_TEXT = 8000;
const MAX_SELECTION = 2000;
const MAX_FOCUSED = 240;

export interface CoBrowsePageContext extends PageContext {
  tabId?: number;
  windowId?: number;
  capturedAt: string;
  viewport?: { width: number; height: number };
}

export type BrowserGuideCommand =
  | { id: string; type: 'highlight'; text: string; createdAt: string }
  | { id: string; type: 'scrollToText'; text: string; createdAt: string }
  | { id: string; type: 'navigate'; url: string; createdAt: string };

export type BrowserGuideCommandInput =
  | { type: 'highlight'; text: string }
  | { type: 'scrollToText'; text: string }
  | { type: 'navigate'; url: string };

type ContextListener = (context: CoBrowsePageContext) => void;

interface CoBrowseState {
  latestContext: CoBrowsePageContext | null;
  listeners: Set<ContextListener>;
  commandQueues: Map<string, BrowserGuideCommand[]>;
  teachingHistory: Map<string, string[]>;
}

const MAX_TEACHING_HISTORY = 6;

declare global {
  // eslint-disable-next-line no-var
  var __interviewPrepCoBrowseState: CoBrowseState | undefined;
}

const state =
  globalThis.__interviewPrepCoBrowseState ??
  (globalThis.__interviewPrepCoBrowseState = {
    latestContext: null,
    listeners: new Set<ContextListener>(),
    commandQueues: new Map<string, BrowserGuideCommand[]>(),
    teachingHistory: new Map<string, string[]>(),
  });

// Backfill fields on a singleton that survived a hot-reload from before they
// existed, so a long-running dev server doesn't crash on the new memory map.
state.commandQueues ??= new Map<string, BrowserGuideCommand[]>();
state.teachingHistory ??= new Map<string, string[]>();

export function setLatestContext(input: unknown): CoBrowsePageContext {
  state.latestContext = normalizePageContext(input);
  for (const listener of state.listeners) listener(state.latestContext);
  return state.latestContext;
}

export function getLatestContext(): CoBrowsePageContext | null {
  return state.latestContext;
}

export function subscribeToContext(listener: ContextListener): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function normalizePageContext(input: unknown): CoBrowsePageContext {
  const source = isRecord(input) ? input : {};
  const viewport = isRecord(source.viewport)
    ? {
        width: toFiniteNumber(source.viewport.width, 0),
        height: toFiniteNumber(source.viewport.height, 0),
      }
    : undefined;

  return {
    url: toText(source.url, 2048),
    title: toText(source.title, 300),
    selection: toOptionalText(source.selection, MAX_SELECTION),
    visibleText: toText(source.visibleText, MAX_VISIBLE_TEXT),
    focusedElement: toOptionalText(source.focusedElement, MAX_FOCUSED),
    scrollPercent: clamp(toFiniteNumber(source.scrollPercent, 0), 0, 100),
    tabId: toOptionalInteger(source.tabId),
    windowId: toOptionalInteger(source.windowId),
    capturedAt: toOptionalText(source.capturedAt, 80) ?? new Date().toISOString(),
    viewport,
  };
}

export function enqueueCommand(
  tabId: number | string | undefined,
  command: BrowserGuideCommandInput,
): BrowserGuideCommand {
  const queued = {
    ...command,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  } as BrowserGuideCommand;
  const key = tabKey(tabId);
  state.commandQueues.set(key, [...(state.commandQueues.get(key) ?? []), queued].slice(-20));
  return queued;
}

export function takeCommands(tabId: number | string | undefined): BrowserGuideCommand[] {
  const key = tabKey(tabId);
  const commands = state.commandQueues.get(key) ?? [];
  state.commandQueues.delete(key);
  return commands;
}

// Per-page memory so the teacher advances instead of re-introducing the page on
// every follow-along turn. Keyed by URL — a new page starts a fresh lesson.
export function recordTeaching(url: string, line: string): void {
  const key = url || 'active';
  const text = line.trim();
  if (!text) return;
  const prev = state.teachingHistory.get(key) ?? [];
  state.teachingHistory.set(key, [...prev, text].slice(-MAX_TEACHING_HISTORY));
}

export function getTeachingHistory(url: string): string[] {
  return state.teachingHistory.get(url || 'active') ?? [];
}

function tabKey(tabId: number | string | undefined): string {
  return tabId === undefined || tabId === '' ? 'active' : String(tabId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toOptionalText(value: unknown, max: number): string | undefined {
  const text = toText(value, max);
  return text || undefined;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toOptionalInteger(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
