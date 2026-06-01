/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import Call from './Call';

// jsdom implements none of the media/speech APIs the call uses, so stub the
// minimum the turn loop touches. The point of this test isn't the audio
// pipeline — it's that, under React Strict Mode's dev double-mount, the call
// still reaches the listening phase after the coach speaks.

function fakeTrack() {
  return { stop: vi.fn(), enabled: true, kind: 'audio' };
}

beforeEach(() => {
  const stream = {
    getTracks: () => [fakeTrack()],
    getAudioTracks: () => [fakeTrack()],
    getVideoTracks: () => [fakeTrack()],
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });

  class FakeMediaStream {
    getAudioTracks() {
      return [fakeTrack()];
    }
  }
  class FakeMediaRecorder {
    state = 'inactive';
    onstop: (() => void) | null = null;
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect: vi.fn() };
    }
    createAnalyser() {
      return { fftSize: 1024, getByteTimeDomainData: vi.fn() };
    }
    close() {
      return Promise.resolve();
    }
  }
  class FakeUtterance {
    rate = 1;
    pitch = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  }

  Object.assign(globalThis as Record<string, unknown>, {
    MediaStream: FakeMediaStream,
    MediaRecorder: FakeMediaRecorder,
    AudioContext: FakeAudioContext,
    SpeechSynthesisUtterance: FakeUtterance,
    requestAnimationFrame: vi.fn(() => 0),
    cancelAnimationFrame: vi.fn(),
  });
  // Coach "speaks" instantly: fire onend so the turn advances without waiting.
  (window as Record<string, unknown>).speechSynthesis = {
    speaking: false,
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    speak: vi.fn((u: FakeUtterance) => u.onend?.()),
  };
  (window.HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play = vi
    .fn()
    .mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: 'Tell me about your most recent project.' }),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Call — Strict Mode', () => {
  // Regression guard. React Strict Mode (dev) mounts → unmounts → remounts.
  // The first unmount sets endedRef = true; if it isn't reset on the live
  // remount, onDone bails before startListening() and the call freezes on
  // "Coach is speaking". With the reset, listening starts.
  it('reaches the listening phase after the coach speaks, even under Strict Mode', async () => {
    render(
      <StrictMode>
        <Call documents={[]} interviewer="hiring-manager" onEnd={() => {}} />
      </StrictMode>,
    );
    expect(
      await screen.findByText(/Listening — speak your answer/i, {}, { timeout: 4000 }),
    ).toBeTruthy();
  });
});
