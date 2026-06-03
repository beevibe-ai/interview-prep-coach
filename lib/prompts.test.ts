import { describe, expect, it } from 'vitest';
import { buildSystem } from './prompts';

describe('buildSystem', () => {
  it('warns the coach not to invent project names around Beevibe', () => {
    const system = buildSystem(
      [{ name: 'beevibe.md', text: 'Beevibe is an agent-native workspace.', chars: 43 }],
      'question',
    );

    expect(system).toContain('Do not invent or rename project names.');
    expect(system).toContain('your Beevibe work');
    expect(system).toMatch(/ask\s+about Beevibe directly instead of inventing a project name/);
  });

  it('marks truncated document scope in the prompt', () => {
    const system = buildSystem(
      [
        {
          name: 'long.md',
          text: 'Beevibe details.',
          chars: 32000,
          includedChars: 16000,
          truncated: true,
        },
      ],
      'question',
    );

    expect(system).toContain('### long.md (showing 16,000 of 32,000 extracted characters)');
  });
});
