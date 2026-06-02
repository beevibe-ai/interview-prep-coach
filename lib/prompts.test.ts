import { describe, expect, it } from 'vitest';
import { buildSystem } from './prompts';
import type { DocText } from './types';

const RESUME: DocText = {
  name: 'resume.md',
  text: '# Jane Doe\n\nEngineer at Acme. Built the foo migration.',
  chars: 50,
};

describe('buildSystem — no-resume branch', () => {
  // Regression: when the candidate hasn't uploaded a resume, the "question"
  // directive used to demand grounding in materials ("reference an actual
  // project, role, or detail") AND forbid asking about anything not in those
  // materials. With documents=[], that's a contradiction the model resolves by
  // saying almost nothing ("ok") — the bug a user hit on the recruiter persona.
  it('drops the materials-grounding requirement when no documents are uploaded', () => {
    const sys = buildSystem([], 'question', 'recruiter');
    expect(sys).not.toMatch(/Ground it in their real materials/);
    expect(sys).toMatch(/has not shared a resume/i);
    // Generic openers must be explicitly permitted for the recruiter persona.
    expect(sys).toMatch(/tell me about yourself/i);
  });

  it('keeps the strict grounding directive when documents are present', () => {
    const sys = buildSystem([RESUME], 'question', 'recruiter');
    expect(sys).toMatch(/Ground it in their real materials/);
    expect(sys).not.toMatch(/has not shared a resume/i);
  });
});
