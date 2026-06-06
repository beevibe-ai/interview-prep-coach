import { describe, expect, it } from 'vitest';
import {
  enqueueCommand,
  getTeachingHistory,
  normalizePageContext,
  recordTeaching,
  setLatestContext,
  takeCommands,
} from './cobrowse-store';

describe('cobrowse store', () => {
  it('normalizes page context from extension input', () => {
    const context = normalizePageContext({
      url: 'https://example.com',
      title: 'Example',
      visibleText: 'x'.repeat(9000),
      selection: ' selected text ',
      focusedElement: 'button: Learn more',
      scrollPercent: 140,
      tabId: 42,
      windowId: 7,
      viewport: { width: 1280, height: 720 },
    });

    expect(context.url).toBe('https://example.com');
    expect(context.visibleText).toHaveLength(8000);
    expect(context.selection).toBe('selected text');
    expect(context.scrollPercent).toBe(100);
    expect(context.tabId).toBe(42);
    expect(context.viewport).toEqual({ width: 1280, height: 720 });
  });

  it('stores latest context', () => {
    const context = setLatestContext({
      url: 'https://react.dev',
      title: 'React',
      visibleText: 'Hooks and components',
      scrollPercent: 10,
    });

    expect(context.title).toBe('React');
  });

  it('queues and drains commands by tab id', () => {
    const command = enqueueCommand(123, { type: 'highlight', text: 'Example Domain' });

    expect(command.id).toBeTruthy();
    expect(takeCommands(123)).toEqual([command]);
    expect(takeCommands(123)).toEqual([]);
  });

  it('remembers what was taught per page and keeps it fresh, capped, and url-scoped', () => {
    const url = `https://docs.example.com/${Math.random()}`;
    expect(getTeachingHistory(url)).toEqual([]);
    recordTeaching(url, 'A harness gives an agent its tools and guardrails.');
    recordTeaching(url, '   '); // blank is ignored
    recordTeaching(url, 'It constrains the model the way reins constrain a horse.');
    expect(getTeachingHistory(url)).toEqual([
      'A harness gives an agent its tools and guardrails.',
      'It constrains the model the way reins constrain a horse.',
    ]);

    for (let i = 0; i < 10; i++) recordTeaching(url, `point ${i}`);
    expect(getTeachingHistory(url)).toHaveLength(6); // capped
    expect(getTeachingHistory(url).at(-1)).toBe('point 9');

    // A different page is a fresh lesson.
    expect(getTeachingHistory(`${url}/other`)).toEqual([]);
  });
});
