'use client';

import { useState } from 'react';
import type { DocText, Interviewer } from '@/lib/types';

const INTERVIEWER_OPTIONS: { value: Interviewer; label: string; blurb: string }[] = [
  { value: 'recruiter', label: 'Recruiter / HR', blurb: 'Screen: motivation, fit, background' },
  { value: 'hiring-manager', label: 'Hiring manager', blurb: 'Impact, ownership, judgment' },
  { value: 'technical', label: 'Technical', blurb: 'Deep dive on how you built it' },
  { value: 'behavioral', label: 'Behavioral', blurb: 'STAR stories: conflict, failure' },
  { value: 'vc', label: 'VC / Investor', blurb: 'Problem, market, traction, moat' },
  { value: 'executive', label: 'Executive', blurb: 'Vision, strategy, leadership' },
];

export default function Lobby({
  documents,
  setDocuments,
  interviewer,
  setInterviewer,
  onStart,
}: {
  documents: DocText[];
  setDocuments: (updater: (prev: DocText[]) => DocText[]) => void;
  interviewer: Interviewer;
  setInterviewer: (i: Interviewer) => void;
  onStart: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(fileList).forEach((f) => form.append('files', f));
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      setDocuments((prev) => mergeDocs(prev, data.documents as DocText[]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Interview Prep — mock call</h1>
        <p className="text-sm text-slate-500">
          Upload your resume and project notes, then jump on a call. The coach speaks, you
          speak back. It picks up on how you actually sound — pace, filler, where you trail
          off — and helps you get it natural, not memorised.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700">Your materials</h2>
        <p className="mt-1 text-xs text-slate-500">
          PDF, DOCX, TXT, or Markdown. Resume + a few project files work best. (Optional — you
          can also do generic practice.)
        </p>

        <label className="mt-3 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-5 text-center text-sm text-slate-600 transition hover:border-slate-400 hover:bg-slate-100">
          <input
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.markdown"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              handleUpload(e.target.files);
              e.target.value = '';
            }}
          />
          {uploading ? 'Reading files…' : 'Click to upload files'}
        </label>

        {documents.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {documents.map((d) => (
              <li
                key={d.name}
                className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"
              >
                <span className="truncate text-slate-700" title={d.name}>
                  {d.name}
                </span>
                <button
                  className="shrink-0 text-slate-400 hover:text-red-500"
                  onClick={() => setDocuments((prev) => prev.filter((p) => p.name !== d.name))}
                  aria-label={`Remove ${d.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700">Who&apos;s interviewing you?</h2>
        <p className="mt-1 text-xs text-slate-500">
          Sets the kind of questions you get and the lens the coach uses.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {INTERVIEWER_OPTIONS.map((opt) => {
            const selected = interviewer === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setInterviewer(opt.value)}
                aria-pressed={selected}
                className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition ${
                  selected
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
                }`}
              >
                <span className="text-xs font-semibold">{opt.label}</span>
                <span
                  className={`text-[10px] leading-tight ${selected ? 'text-slate-300' : 'text-slate-400'}`}
                >
                  {opt.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <button
        className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
        onClick={onStart}
      >
        Start the call →
      </button>
      <p className="-mt-3 text-center text-[11px] text-slate-400">
        We will ask for camera + mic access. Best in Chrome or Edge (for live captions).
      </p>
    </div>
  );
}

function mergeDocs(prev: DocText[], next: DocText[]): DocText[] {
  const byName = new Map(prev.map((d) => [d.name, d]));
  for (const d of next) byName.set(d.name, d);
  return Array.from(byName.values());
}
