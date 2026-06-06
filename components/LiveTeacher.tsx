'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelSpeech, getRecognition, sanitizeForSpeech, speak } from '@/lib/speech';
import type { TeachEvent } from '@/lib/teacher-contracts';

type TeacherState = 'idle' | 'running' | 'paused' | 'error';

interface TimelineItem {
  id: number;
  kind: TeachEvent['kind'];
  text: string;
}

const STARTER_GOALS = [
  'Open the React docs and teach me how useEffect works by walking through the page.',
  'Open browser-use.com and teach me what Browser Use is good for.',
  'Search for a system design primer and teach me the first useful concept.',
];

export default function LiveTeacher({ onBack }: { onBack: () => void }) {
  const [goal, setGoal] = useState(STARTER_GOALS[0]);
  const [steerDraft, setSteerDraft] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [state, setState] = useState<TeacherState>('idle');
  const [status, setStatus] = useState('Ready.');
  const [currentLine, setCurrentLine] = useState('');
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [listening, setListening] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const itemIdRef = useRef(0);
  const speakChainRef = useRef(Promise.resolve());

  const append = useCallback((kind: TeachEvent['kind'], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    itemIdRef.current += 1;
    setTimeline((prev) => [...prev.slice(-80), { id: itemIdRef.current, kind, text: trimmed }]);
  }, []);

  const speakQueued = useCallback((text: string) => {
    const spoken = sanitizeForSpeech(text);
    if (!spoken) return;
    speakChainRef.current = speakChainRef.current.then(
      () =>
        new Promise<void>((resolve) => {
          setCurrentLine(spoken);
          speak(spoken, resolve);
        }),
    );
  }, []);

  const runLesson = useCallback(
    async (nextGoal: string, resumeSessionId?: string) => {
      const trimmed = nextGoal.trim();
      if (!trimmed) return;
      abortRef.current?.abort();
      cancelSpeech();
      const abort = new AbortController();
      abortRef.current = abort;
      setState('running');
      setStatus(resumeSessionId ? 'Sending your steering to Hermes...' : 'Starting the lesson...');
      append('status', resumeSessionId ? `Steering: ${trimmed}` : `Goal: ${trimmed}`);

      try {
        const res = await fetch('/api/teach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: trimmed, sessionId: resumeSessionId }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'The live teacher route is unavailable.');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const event = parseSseEvent(part);
            if (!event) continue;
            if (event.kind === 'status') {
              setStatus(event.text);
              append(event.kind, event.text);
            } else if (event.kind === 'thought') {
              append(event.kind, event.text);
            } else if (event.kind === 'observe' || event.kind === 'act') {
              append(event.kind, event.text);
            } else if (event.kind === 'say') {
              append(event.kind, event.text);
              speakQueued(event.text);
            } else if (event.kind === 'checkpoint') {
              setSessionId(event.sessionId);
              setState('paused');
              setStatus(event.text);
              append(event.kind, event.text);
            } else if (event.kind === 'done') {
              setSessionId(event.sessionId);
              setStatus('Lesson run finished.');
              append(event.kind, event.summary);
              if (event.summary) speakQueued(event.summary.split('\n').slice(-2).join(' '));
              setState(event.sessionId ? 'paused' : 'idle');
            } else if (event.kind === 'error') {
              setState('error');
              setStatus(event.error);
              append(event.kind, event.error);
              speakQueued('Hermes needs a little setup before I can drive the browser.');
            }
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'The live teacher failed.';
        setState('error');
        setStatus(message);
        append('error', message);
      }
    },
    [append, speakQueued],
  );

  const start = useCallback(() => {
    setTimeline([]);
    setSessionId(undefined);
    setCurrentLine('');
    void runLesson(goal);
  }, [goal, runLesson]);

  const sendSteer = useCallback(() => {
    const text = steerDraft.trim();
    if (!text) return;
    setSteerDraft('');
    void runLesson(text, sessionId);
  }, [runLesson, sessionId, steerDraft]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    cancelSpeech();
    setState('idle');
    setStatus('Stopped.');
  }, []);

  const showBrowser = useCallback(async () => {
    try {
      const res = await fetch('/api/teach/show-browser', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      setStatus(data.status || data.error || 'Showing the watched Chrome window.');
    } catch {
      setStatus('Could not bring the watched Chrome window forward.');
    }
  }, []);

  const captureSteering = useCallback(() => {
    const recognition = getRecognition();
    if (!recognition) {
      setStatus('Voice steering needs Chrome or Edge speech recognition.');
      return;
    }
    setListening(true);
    setStatus('Listening for your steering...');
    let finalText = '';
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      setSteerDraft((finalText + interim).trim());
    };
    recognition.onend = () => {
      setListening(false);
      setStatus(finalText.trim() ? 'Steering captured.' : 'No steering captured.');
    };
    recognition.onerror = () => {
      setListening(false);
      setStatus('Speech recognition could not capture steering.');
    };
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cancelSpeech();
    };
  }, []);

  const running = state === 'running';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div className="flex flex-col gap-2 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
          Agent-led browser teacher
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Watch Hermes browse. Hear Gemma teach.</h1>
        <p className="mx-auto max-w-2xl text-sm text-slate-500">
          Hermes drives a visible Chrome window in bounded bursts. The app turns its browser
          actions and observations into short spoken teaching moments, then pauses so you can steer.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="text-sm font-semibold text-slate-700" htmlFor="teacher-goal">
            Lesson goal
          </label>
          <textarea
            id="teacher-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={running}
            className="mt-2 min-h-28 w-full rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:bg-white"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {STARTER_GOALS.map((starter) => (
              <button
                key={starter}
                type="button"
                disabled={running}
                onClick={() => setGoal(starter)}
                className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
              >
                {starter.split(' ').slice(0, 5).join(' ')}…
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={start}
              disabled={running || !goal.trim()}
              className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-40"
            >
              Start lesson
            </button>
            <button
              type="button"
              onClick={stop}
              disabled={!running}
              className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-40"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={showBrowser}
              className="rounded-xl border border-sky-200 px-4 py-2.5 text-sm font-medium text-sky-700 transition hover:bg-sky-50"
            >
              Show browser
            </button>
            <button
              type="button"
              onClick={onBack}
              disabled={running}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            >
              Back to interview prep
            </button>
          </div>
        </section>

        <aside className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-100 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${
                running
                  ? 'animate-pulse bg-emerald-400'
                  : state === 'error'
                    ? 'bg-red-400'
                    : state === 'paused'
                      ? 'bg-amber-400'
                      : 'bg-slate-600'
              }`}
            />
            Spoken teacher line
          </div>
          <p className="mt-3 min-h-24 text-sm leading-relaxed">
            {currentLine || 'Press Start lesson. A dedicated Chrome window should open.'}
          </p>
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-xs text-slate-300">
            {status}
            {sessionId ? (
              <div className="mt-2 font-mono text-[10px] text-slate-500">session {sessionId}</div>
            ) : null}
          </div>
        </aside>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-sm font-semibold text-slate-700" htmlFor="teacher-steer">
              Ask or steer between bursts
            </label>
            <input
              id="teacher-steer"
              value={steerDraft}
              onChange={(e) => setSteerDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendSteer();
              }}
              disabled={running}
              placeholder="e.g. slow down and show me the exact paragraph"
              className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
            />
          </div>
          <button
            type="button"
            onClick={captureSteering}
            disabled={running || listening}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            {listening ? 'Listening…' : 'Voice steer'}
          </button>
          <button
            type="button"
            onClick={sendSteer}
            disabled={running || !steerDraft.trim()}
            className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-40"
          >
            Send steer
          </button>
        </div>
      </section>

      <section className="min-h-72 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700">Hermes stream</h2>
        <div className="mt-3 flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
          {timeline.length === 0 ? (
            <p className="text-sm text-slate-400">
              The raw browser-agent stream and spoken teaching moments will appear here.
            </p>
          ) : (
            timeline.map((item) => (
              <div
                key={item.id}
                className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  item.kind === 'say'
                    ? 'bg-emerald-50 text-emerald-900'
                    : item.kind === 'observe'
                      ? 'bg-sky-50 text-sky-900'
                      : item.kind === 'act'
                        ? 'bg-violet-50 text-violet-900'
                    : item.kind === 'error'
                      ? 'bg-red-50 text-red-700'
                      : item.kind === 'thought'
                        ? 'bg-slate-50 text-slate-600'
                        : 'bg-amber-50 text-amber-900'
                }`}
              >
                <span className="mr-2 font-semibold uppercase tracking-wide opacity-60">
                  {item.kind}
                </span>
                {item.text}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function parseSseEvent(part: string): TeachEvent | null {
  const line = part
    .split('\n')
    .find((entry) => entry.startsWith('data:'))
    ?.slice(5)
    .trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as TeachEvent;
  } catch {
    return null;
  }
}
