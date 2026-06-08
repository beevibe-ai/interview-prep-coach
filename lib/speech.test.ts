import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecognition, pickSpeechVoice, speak } from './speech';

// Minimal stand-in for the browser's SpeechSynthesisUtterance.
class FakeUtterance {
  text: string;
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

// Install a fake speechSynthesis on the global. `autoEnd: true` simulates a
// browser that fires onend; `false` simulates Chrome's bug where it never does.
function installSynth(autoEnd: boolean, voices: SpeechSynthesisVoice[] = []) {
  const synth = {
    speaking: true,
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: vi.fn(() => voices),
    speak: vi.fn((u: FakeUtterance) => {
      if (autoEnd) u.onend?.();
    }),
  };
  (globalThis as Record<string, unknown>).window = { speechSynthesis: synth };
  (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = FakeUtterance;
  return synth;
}

describe('speak()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;
  });

  // Regression guard for the call-freeze bug: the turn loop hands the mic back
  // from onDone, and onDone used to fire ONLY on speechSynthesis.onend — which
  // Chrome frequently never sends. onDone must still fire via the fallback, or
  // the mock interview deadlocks on "Coach is speaking".
  it('still calls onDone when the browser never fires onend (deadlock regression)', () => {
    installSynth(false);
    const onDone = vi.fn();
    speak('Tell me about the Postgres migration you led.', onDone);
    expect(onDone).not.toHaveBeenCalled(); // nothing fires synchronously
    vi.advanceTimersByTime(15000); // past the estimated-duration fallback
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('calls onDone once on onend, and the fallback does not double-fire', () => {
    installSynth(true);
    const onDone = vi.fn();
    speak('Short one.', onDone);
    expect(onDone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('calls onDone immediately when speechSynthesis is unavailable', () => {
    (globalThis as Record<string, unknown>).window = {}; // window exists, no speechSynthesis
    const onDone = vi.fn();
    speak('Hello', onDone);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('sets the requested utterance language', () => {
    const synth = installSynth(false);
    speak('你好，欢迎。', undefined, 'zh-CN');

    const utterance = synth.speak.mock.calls[0][0] as FakeUtterance;
    expect(utterance.lang).toBe('zh-CN');
  });

  it('selects a Mandarin voice when one is available', () => {
    const mandarin = voice('Microsoft Xiaoxiao Online Natural - Chinese Mainland', 'zh-CN');
    const synth = installSynth(false, [voice('Google Cantonese Hong Kong', 'zh-HK'), mandarin]);

    speak('你好，欢迎。', undefined, 'zh-CN');

    const utterance = synth.speak.mock.calls[0][0] as FakeUtterance;
    expect(utterance.voice).toBe(mandarin);
    expect(utterance.rate).toBeLessThan(1);
  });

  it('does not cut off unspaced Chinese text with the English word-count fallback', () => {
    installSynth(false);
    const onDone = vi.fn();

    speak('这是一段比较长的中文句子，用来确认语音不会太早结束。', onDone, 'zh-CN');

    vi.advanceTimersByTime(4000);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(12000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('pickSpeechVoice()', () => {
  it('prefers Mainland Mandarin over Cantonese or Taiwan voices for zh-CN', () => {
    const mandarin = voice('Microsoft Xiaoxiao Online Natural - Chinese Mainland', 'zh-CN');
    const picked = pickSpeechVoice('zh-CN', [
      voice('Google Cantonese Hong Kong', 'zh-HK'),
      voice('Mei-Jia Taiwan', 'zh-TW'),
      mandarin,
    ]);

    expect(picked).toBe(mandarin);
  });
});

describe('getRecognition()', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it('sets the requested speech-recognition language', () => {
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
    }
    (globalThis as Record<string, unknown>).window = {
      SpeechRecognition: FakeRecognition,
    };

    const recognition = getRecognition('zh-CN');

    expect(recognition).toMatchObject({
      continuous: true,
      interimResults: true,
      lang: 'zh-CN',
    });
  });
});

function voice(name: string, lang: string): SpeechSynthesisVoice {
  return {
    name,
    lang,
    default: false,
    localService: false,
    voiceURI: name,
  };
}
