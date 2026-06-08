import { describe, expect, it } from 'vitest';
import {
  buildCoBrowseSystem,
  extractTeachingHighlights,
  splitCompleteTeachingSentences,
} from './cobrowse-teach';

describe('co-browse teach helpers', () => {
  it('adds a Simplified Chinese instruction when Mandarin mode is requested', () => {
    const system = buildCoBrowseSystem('detail', 'zh');

    expect(system).toContain('Respond entirely in Simplified Chinese');
    expect(system).toContain('。！？');
  });

  it('does not add Chinese-only output rules by default', () => {
    const system = buildCoBrowseSystem('detail');

    expect(system).not.toContain('Respond entirely in Simplified Chinese');
  });

  it('streams Chinese sentences without requiring whitespace after punctuation', () => {
    const split = splitCompleteTeachingSentences('第一句。第二句！还没结束', false);

    expect(split.sentences).toEqual(['第一句。', '第二句！']);
    expect(split.rest).toBe('还没结束');
  });

  it('keeps waiting for English punctuation until a following space or final flush', () => {
    const partial = splitCompleteTeachingSentences('First sentence.Next', false);
    expect(partial.sentences).toEqual([]);
    expect(partial.rest).toBe('First sentence.Next');

    const complete = splitCompleteTeachingSentences('First sentence. Next', false);
    expect(complete.sentences).toEqual(['First sentence.']);
    expect(complete.rest).toBe('Next');
  });

  it('keeps highlight metadata but removes exact English source phrases from Mandarin speech', () => {
    const extracted = extractTeachingHighlights(
      '上下文窗口（[[context windows]]）决定模型能记住多少内容。',
      'zh',
    );

    expect(extracted.text).toBe('上下文窗口决定模型能记住多少内容。');
    expect(extracted.highlights).toEqual(['context windows']);
  });
});
