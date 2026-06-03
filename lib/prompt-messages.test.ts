import { describe, expect, it } from 'vitest';
import { promptMessagesForAction } from './prompt-messages';
import type { ChatMessage } from './types';

describe('promptMessagesForAction', () => {
  it('adds a user turn for a question request when the transcript is empty', () => {
    expect(promptMessagesForAction([], 'question')).toEqual([
      { role: 'user', content: 'Please ask the next interview question now.' },
    ]);
  });

  it('adds a user turn for a question request after the coach last spoke', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'Tell me about your most recent project.' },
    ];

    expect(promptMessagesForAction(messages, 'question')).toEqual([
      ...messages,
      { role: 'user', content: 'Please ask the next interview question now.' },
    ]);
  });

  it('leaves respond turns untouched', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Here is my answer.' }];

    expect(promptMessagesForAction(messages, 'respond')).toBe(messages);
  });
});
