import type { DeliverySignals } from './types';

const FILLERS = [
  'um',
  'uh',
  'er',
  'ah',
  'hmm',
  'like',
  'you know',
  'sort of',
  'kind of',
  'basically',
  'actually',
  'literally',
  'i mean',
  'i guess',
];

/** Compute objective delivery signals from a transcript + timing. */
export function computeDelivery(
  transcript: string,
  durationSec: number,
  longPauses: number,
): DeliverySignals {
  const normalized = ` ${transcript.toLowerCase().replace(/[^\w'\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const words = transcript.trim() ? transcript.trim().split(/\s+/) : [];
  const wordCount = words.length;

  let fillerCount = 0;
  const fillers: string[] = [];
  for (const f of FILLERS) {
    const re = new RegExp(`\\b${f.replace(/ /g, '\\s+')}\\b`, 'g');
    const matches = normalized.match(re);
    if (matches) {
      fillerCount += matches.length;
      fillers.push(`${f} ×${matches.length}`);
    }
  }

  const wordsPerMinute = durationSec > 0 ? Math.round(wordCount / (durationSec / 60)) : 0;
  return {
    durationSec: Math.round(durationSec),
    wordCount,
    wordsPerMinute,
    fillerCount,
    fillers,
    longPauses,
  };
}

/** Speak text aloud via the browser's built-in TTS. */
export function speak(text: string, onDone?: () => void, lang = 'en-US'): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    onDone?.();
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel();

  // The call loop hands the mic back from onDone, so onDone MUST fire — or the
  // turn deadlocks (stuck on "Coach is speaking", listening never starts).
  // Chrome's speechSynthesis is unreliable about onend: voices load async and
  // long utterances get silently cut at ~15s, so onend can never arrive. Fire
  // onDone exactly once — from onend/onerror OR a duration-based fallback.
  let finished = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (fallback) clearTimeout(fallback);
    if (keepAlive) clearInterval(keepAlive);
    onDone?.();
  };

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 1.02;
  utter.pitch = 1;
  utter.onend = finish;
  utter.onerror = finish;

  // Estimate speaking time (~2.5 words/sec) + buffer; if the browser never
  // reports the utterance finished, the fallback hands the mic back anyway.
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const estMs = Math.max(1500, (words / 2.5) * 1000) + 2500;
  fallback = setTimeout(finish, estMs);
  // Chrome pauses long utterances after ~15s; nudge it to keep speaking.
  keepAlive = setInterval(() => {
    if (synth.speaking) {
      synth.pause();
      synth.resume();
    }
  }, 6000);

  synth.speak(utter);
}

export function cancelSpeech(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

/** Strip markdown artefacts so TTS reads cleanly. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Create a live speech-recognition session, or null if unsupported. */
export function getRecognition(lang = 'en-US'): SpeechRecognition | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lang;
  return recognition;
}

/** Convert a recorded Blob to base64 (without the data-URL prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
