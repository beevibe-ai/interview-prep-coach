export interface PageContext {
  url: string;
  title: string;
  selection?: string;
  visibleText: string;
  focusedElement?: string;
  scrollPercent: number;
}

export interface BrowserActorInput {
  goal: string;
  context?: PageContext;
  sessionId?: string;
}

export interface BrowserActorResult {
  ok: boolean;
  summary: string;
  sessionId?: string;
}

export interface BrowserActor {
  run(
    input: BrowserActorInput,
    onThought?: (line: string) => void | Promise<void>,
  ): Promise<BrowserActorResult>;
}

export type TeacherMomentKind = 'observe' | 'act' | 'explain';

export interface TeacherMoment {
  kind: TeacherMomentKind;
  text: string;
}

export type TeachEvent =
  | { kind: 'status'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'observe'; text: string }
  | { kind: 'act'; text: string }
  | { kind: 'say'; text: string }
  | { kind: 'checkpoint'; sessionId?: string; text: string }
  | { kind: 'done'; sessionId?: string; summary: string }
  | { kind: 'error'; error: string };
