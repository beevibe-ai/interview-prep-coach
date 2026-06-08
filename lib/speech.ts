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

let pendingVoiceStart: { timer?: ReturnType<typeof setTimeout>; cleanup?: () => void } | null = null;

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
  clearPendingVoiceStart();
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

  const startSpeech = () => {
    const voices = getSpeechVoices(synth);
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickSpeechVoice(lang, voices);
    utter.lang = voice?.lang || lang;
    if (voice) utter.voice = voice;
    utter.rate = speechRateForLang(lang);
    utter.pitch = 1;
    utter.onend = finish;
    utter.onerror = finish;

    // Estimate speaking time + buffer; if the browser never reports the
    // utterance finished, the fallback hands the mic back anyway.
    fallback = setTimeout(finish, estimateSpeechMs(text, lang));
    // Chrome pauses long utterances after ~15s; nudge it to keep speaking.
    keepAlive = setInterval(() => {
      if (synth.speaking) {
        synth.pause();
        synth.resume();
      }
    }, 6000);

    synth.speak(utter);
  };

  if (shouldWaitForVoiceLoad(lang, synth)) {
    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      clearPendingVoiceStart();
      startSpeech();
    };
    const timer = setTimeout(startOnce, 250);
    const onVoicesChanged = () => startOnce();
    synth.addEventListener('voiceschanged', onVoicesChanged, { once: true });
    pendingVoiceStart = {
      timer,
      cleanup: () => synth.removeEventListener('voiceschanged', onVoicesChanged),
    };
  } else {
    startSpeech();
  }
}

export function cancelSpeech(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    clearPendingVoiceStart();
    window.speechSynthesis.cancel();
  }
}

export function pickSpeechVoice(
  lang: string,
  voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  const primary = lang.split('-')[0].toLowerCase();
  let best: { voice: SpeechSynthesisVoice; score: number } | null = null;
  for (const voice of voices) {
    const score = scoreVoice(voice, lang, primary);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { voice, score };
  }
  return best?.voice ?? null;
}

function clearPendingVoiceStart() {
  if (!pendingVoiceStart) return;
  if (pendingVoiceStart.timer) clearTimeout(pendingVoiceStart.timer);
  pendingVoiceStart.cleanup?.();
  pendingVoiceStart = null;
}

function getSpeechVoices(synth: SpeechSynthesis): SpeechSynthesisVoice[] {
  try {
    const getVoices = (synth as SpeechSynthesis & { getVoices?: () => SpeechSynthesisVoice[] })
      .getVoices;
    return typeof getVoices === 'function' ? getVoices.call(synth) : [];
  } catch {
    return [];
  }
}

function shouldWaitForVoiceLoad(lang: string, synth: SpeechSynthesis): boolean {
  if (!lang.toLowerCase().startsWith('zh')) return false;
  if (typeof (synth as EventTarget).addEventListener !== 'function') return false;
  return lang.toLowerCase().startsWith('zh') && getSpeechVoices(synth).length === 0;
}

function scoreVoice(voice: SpeechSynthesisVoice, lang: string, primary: string): number {
  const target = lang.toLowerCase();
  const voiceLang = voice.lang.toLowerCase();
  const name = voice.name.toLowerCase();
  let score = 0;
  if (voiceLang === target) score += 100;
  else if (voiceLang.startsWith(`${target}-`)) score += 90;
  else if (voiceLang.split('-')[0] === primary) score += 60;
  else return 0;

  if (primary === 'zh') {
    if (/mandarin|普通话|普通話|国语|國語|xiaoxiao|xiaoyi|xiaobei|yunxi|yunyang|tingting|mei-?jia|sin-?ji|li-?mu|mainland|china/.test(name)) {
      score += 35;
    }
    if (/cantonese|yue|粤|粵|hong kong|香港|taiwan|台灣|台湾/.test(name)) {
      score -= 50;
    }
  }
  if (/natural|premium|enhanced|google|microsoft/.test(name)) score += 8;
  if (voice.localService) score += 2;
  return score;
}

function speechRateForLang(lang: string): number {
  return lang.toLowerCase().startsWith('zh') ? 0.92 : 1.02;
}

function estimateSpeechMs(text: string, lang: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const wordMs = (words / 2.5) * 1000;
  const cjkChars = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const cjkMs = lang.toLowerCase().startsWith('zh') ? (cjkChars / 4.2) * 1000 : 0;
  return Math.max(1500, wordMs, cjkMs) + 2500;
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
