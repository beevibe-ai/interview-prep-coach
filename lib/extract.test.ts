import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractVisualPdfWithGemini } from './extract';

const originalGoogleKey = process.env.GOOGLE_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;
const originalExtractorModel = process.env.PDF_EXTRACTOR_MODEL;

afterEach(() => {
  restoreEnv('GOOGLE_API_KEY', originalGoogleKey);
  restoreEnv('GEMINI_API_KEY', originalGeminiKey);
  restoreEnv('PDF_EXTRACTOR_MODEL', originalExtractorModel);
  vi.unstubAllGlobals();
});

describe('extractVisualPdfWithGemini', () => {
  it('sends PDFs to Gemini document vision and returns extracted text', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    process.env.PDF_EXTRACTOR_MODEL = 'gemini-test';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Beevibe pitch deck text' }] } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const text = await extractVisualPdfWithGemini('deck.pdf', Buffer.from('%PDF-test'));

    expect(text).toBe('Beevibe pitch deck text');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/models/gemini-test:generateContent?key=test-key'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Extract the readable content') }),
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: Buffer.from('%PDF-test').toString('base64'),
          },
        },
      ]),
    );
  });

  it('returns empty text when no Google key is configured', async () => {
    process.env.GOOGLE_API_KEY = '';
    process.env.GEMINI_API_KEY = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractVisualPdfWithGemini('deck.pdf', Buffer.from('%PDF-test'))).resolves.toBe(
      '',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts GEMINI_API_KEY as an alias for PDF vision extraction', async () => {
    process.env.GOOGLE_API_KEY = '';
    process.env.GEMINI_API_KEY = 'gemini-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Deck text' }] } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractVisualPdfWithGemini('deck.pdf', Buffer.from('%PDF-test'))).resolves.toBe(
      'Deck text',
    );
    expect(fetchMock.mock.calls[0][0]).toContain('key=gemini-key');
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
