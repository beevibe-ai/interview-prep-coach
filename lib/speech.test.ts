import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { speak } from './speech';

// Minimal stand-in for the browser's SpeechSynthesisUtterance.
class FakeUtterance {
  text: string;
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
function installSynth(autoEnd: boolean) {
  const synth = {
    speaking: true,
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
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
});
