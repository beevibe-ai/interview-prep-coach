'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelSpeech, getRecognition, sanitizeForSpeech, speak } from '@/lib/speech';
import type { CoBrowsePageContext } from '@/lib/cobrowse-store';

type TeacherState = 'idle' | 'thinking' | 'speaking' | 'error';

interface TimelineItem {
  id: number;
  kind: 'status' | 'page' | 'say' | 'error' | 'command';
  text: string;
}

export default function CoBrowseTeacher({ onBack }: { onBack: () => void }) {
  const [context, setContext] = useState<CoBrowsePageContext | null>(null);
  const [state, setState] = useState<TeacherState>('idle');
  const [status, setStatus] = useState('Waiting for a browser tab.');
  const [currentLine, setCurrentLine] = useState('');
  const [question, setQuestion] = useState('');
  const [guideText, setGuideText] = useState('');
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [listening, setListening] = useState(false);
  const [language, setLanguage] = useState<'en' | 'zh'>('en');
  const itemIdRef = useRef(0);
  const speakChainRef = useRef(Promise.resolve());
  const speechLang = language === 'zh' ? 'zh-CN' : 'en-US';

  const append = useCallback((kind: TimelineItem['kind'], text: string) => {
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
          setState('speaking');
          setCurrentLine(spoken);
          speak(
            spoken,
            () => {
              setState('idle');
              resolve();
            },
            speechLang,
          );
        }),
    );
  }, [speechLang]);

  useEffect(() => {
    const events = new EventSource('/api/cobrowse/events');
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { context?: CoBrowsePageContext };
        if (!data.context) return;
        setContext(data.context);
        setStatus(`Following ${data.context.title || data.context.url || 'active tab'}`);
        append('page', `${data.context.title || '(untitled)'} · ${data.context.url}`);
      } catch {
        /* ignore malformed keep-alive payloads */
      }
    };
    events.onerror = () => setStatus('Browser context stream is reconnecting.');
    return () => {
      events.close();
      cancelSpeech();
    };
  }, [append]);

  const askTeacher = useCallback(
    async (prompt?: string) => {
      if (!context) {
        const message = 'No active browser tab is connected yet.';
        setStatus(message);
        append('error', message);
        return;
      }
      setState('thinking');
      setStatus('Reading the current tab...');
      const trimmed = prompt?.trim() ?? '';
      if (trimmed) append('status', `Question: ${trimmed}`);
      try {
        const res = await fetch('/api/cobrowse/teach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed, language }),
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || 'Teacher is unavailable.');
        }
        // Read the SSE stream; speak each sentence the moment it lands.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let spoke = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split: number;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
            if (!dataLine) continue;
            let event: { type?: string; text?: string; message?: string };
            try {
              event = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if (event.type === 'say' && event.text) {
              spoke = true;
              append('say', event.text);
              speakQueued(event.text);
            } else if (event.type === 'error') {
              throw new Error(event.message || 'Teacher is unavailable.');
            }
          }
        }
        if (!spoke) throw new Error('Teacher returned nothing.');
        setStatus('Teaching from the active tab.');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Teacher is unavailable.';
        setState('error');
        setStatus(message);
        append('error', message);
      }
    },
    [append, context, language, speakQueued],
  );

  const sendCommand = useCallback(
    async (type: 'highlight' | 'scrollToText') => {
      const text = (guideText || context?.selection || '').trim();
      if (!text) return;
      const res = await fetch('/api/cobrowse/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, text, tabId: context?.tabId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        append('command', `${type === 'highlight' ? 'Highlight' : 'Scroll to'}: ${text}`);
        setStatus('Sent guide command to the active tab.');
      } else {
        append('error', data.error || 'Could not send browser guide command.');
      }
    },
    [append, context?.selection, context?.tabId, guideText],
  );

  const captureQuestion = useCallback(() => {
    const recognition = getRecognition(speechLang);
    if (!recognition) {
      setStatus('Voice input needs Chrome or Edge speech recognition.');
      return;
    }
    setListening(true);
    setStatus('Listening...');
    let finalText = '';
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      setQuestion((finalText + interim).trim());
    };
    recognition.onend = () => {
      setListening(false);
      const text = finalText.trim();
      setStatus(text ? 'Question captured.' : 'No question captured.');
      if (text) void askTeacher(text);
    };
    recognition.onerror = () => {
      setListening(false);
      setStatus('Speech recognition could not capture a question.');
    };
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  }, [askTeacher, speechLang]);

  const selectedText = context?.selection?.trim();
  const busy = state === 'thinking' || state === 'speaking';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div className="flex flex-col gap-2 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
          Co-browse teacher
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Browse normally. The teacher follows.</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-700">Active tab</h2>
              <p className="mt-1 truncate text-sm text-slate-900">
                {context?.title || 'No browser tab connected'}
              </p>
              <p className="mt-1 truncate text-xs text-slate-500">
                {context?.url || 'Load the extension from the extension folder, then open any page.'}
              </p>
            </div>
            <div className="shrink-0 rounded-full border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500">
              {context ? `${Math.round(context.scrollPercent)}%` : 'offline'}
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="line-clamp-6 text-xs leading-relaxed text-slate-600">
              {selectedText
                ? `Selected: ${selectedText}`
                : context?.visibleText || 'Visible page text will appear here.'}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <div className="flex overflow-hidden rounded-xl border border-slate-200 text-sm font-medium">
              <button
                type="button"
                onClick={() => setLanguage('en')}
                className={`px-3 py-2 transition ${
                  language === 'en'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLanguage('zh')}
                className={`px-3 py-2 transition ${
                  language === 'zh'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                中文
              </button>
            </div>
            <button
              type="button"
              onClick={() => void askTeacher()}
              disabled={!context || busy}
              className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-40"
            >
              Teach current tab
            </button>
            <button
              type="button"
              onClick={captureQuestion}
              disabled={!context || busy || listening}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              {listening ? 'Listening...' : 'Voice ask'}
            </button>
            <button
              type="button"
              onClick={() => {
                cancelSpeech();
                setState('idle');
                setStatus('Speech stopped.');
              }}
              className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 transition hover:bg-red-50"
            >
              Stop speech
            </button>
            <button
              type="button"
              onClick={onBack}
              disabled={busy}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            >
              Back
            </button>
          </div>
        </section>

        <aside className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-100 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${
                state === 'thinking'
                  ? 'animate-pulse bg-sky-400'
                  : state === 'speaking'
                    ? 'animate-pulse bg-emerald-400'
                    : state === 'error'
                      ? 'bg-red-400'
                      : context
                        ? 'bg-amber-400'
                        : 'bg-slate-600'
              }`}
            />
            Spoken teacher line
          </div>
          <p className="mt-3 min-h-24 text-sm leading-relaxed">
            {currentLine || 'Open a page in Chrome, then ask the teacher to explain what you see.'}
          </p>
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-xs text-slate-300">
            {status}
            {context?.tabId ? (
              <div className="mt-2 font-mono text-[10px] text-slate-500">tab {context.tabId}</div>
            ) : null}
          </div>
        </aside>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-sm font-semibold text-slate-700" htmlFor="cobrowse-question">
              Ask about the active tab
            </label>
            <input
              id="cobrowse-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void askTeacher(question);
              }}
              disabled={!context || busy}
              placeholder="e.g. explain the paragraph I selected"
              className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
            />
          </div>
          <button
            type="button"
            onClick={() => void askTeacher(question)}
            disabled={!context || busy || !question.trim()}
            className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-sm font-semibold text-slate-700" htmlFor="guide-text">
              Guide in page
            </label>
            <input
              id="guide-text"
              value={guideText}
              onChange={(e) => setGuideText(e.target.value)}
              disabled={!context}
              placeholder={selectedText || 'Exact words to highlight or scroll to'}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
            />
          </div>
          <button
            type="button"
            onClick={() => void sendCommand('highlight')}
            disabled={!context || !(guideText.trim() || selectedText)}
            className="rounded-xl border border-sky-200 px-4 py-2.5 text-sm font-medium text-sky-700 transition hover:bg-sky-50 disabled:opacity-40"
          >
            Highlight
          </button>
          <button
            type="button"
            onClick={() => void sendCommand('scrollToText')}
            disabled={!context || !(guideText.trim() || selectedText)}
            className="rounded-xl border border-violet-200 px-4 py-2.5 text-sm font-medium text-violet-700 transition hover:bg-violet-50 disabled:opacity-40"
          >
            Scroll
          </button>
        </div>
      </section>

      <section className="min-h-72 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700">Session stream</h2>
        <div className="mt-3 flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
          {timeline.length === 0 ? (
            <p className="text-sm text-slate-400">Page context and teaching moments will appear here.</p>
          ) : (
            timeline.map((item) => (
              <div
                key={item.id}
                className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  item.kind === 'say'
                    ? 'bg-emerald-50 text-emerald-900'
                    : item.kind === 'page'
                      ? 'bg-sky-50 text-sky-900'
                      : item.kind === 'command'
                        ? 'bg-violet-50 text-violet-900'
                        : item.kind === 'error'
                          ? 'bg-red-50 text-red-700'
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
