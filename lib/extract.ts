import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DocText } from './types';

/** Keep prompts manageable for small local models. */
const MAX_CHARS_PER_DOC = 16000;
const MIN_NATIVE_PDF_CHARS = 200;
const DEFAULT_OLLAMA_PDF_MAX_PAGES = 3;
const DEFAULT_OLLAMA_PDF_RENDER_DPI = '120';

const execFile = promisify(execFileCb);

function truncate(text: string): { text: string; chars: number } {
  const chars = text.length;
  if (chars <= MAX_CHARS_PER_DOC) return { text, chars };
  return {
    text: `${text.slice(0, MAX_CHARS_PER_DOC)}\n\n[... document truncated for length ...]`,
    chars,
  };
}

function cleanText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function toDocText(
  name: string,
  raw: string,
  extractionMethod: NonNullable<DocText['extractionMethod']>,
  nativeTextChars?: number,
): DocText {
  const clean = cleanText(raw);
  const { text, chars } = truncate(clean);
  return {
    name,
    text,
    chars,
    includedChars: Math.min(chars, MAX_CHARS_PER_DOC),
    truncated: chars > MAX_CHARS_PER_DOC,
    extractionMethod,
    nativeTextChars,
  };
}

/**
 * Extract plain text from an uploaded file. Supports PDF, DOCX, and plain
 * text / markdown. Unknown types are read as UTF-8 best-effort.
 */
export async function extractText(name: string, buffer: Buffer): Promise<DocText> {
  const lower = name.toLowerCase();

  if (lower.endsWith('.pdf')) {
    // Import the implementation file directly: importing the package index
    // triggers pdf-parse's debug/test harness when no module parent exists.
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
    const result = await pdf(buffer);
    const native = cleanText(result.text);

    if (native.length < MIN_NATIVE_PDF_CHARS) {
      const visual = await extractVisualPdfWithGemini(name, buffer).catch(() => '');
      if (visual && cleanText(visual).length > native.length) {
        return toDocText(name, visual, 'pdf-vision', native.length);
      }

      const localVisual = await extractVisualPdfWithOllama(name, buffer).catch(() => '');
      if (localVisual && cleanText(localVisual).length > native.length) {
        return toDocText(name, localVisual, 'pdf-ollama-vision', native.length);
      }
    }

    return toDocText(name, native, 'pdf-text');
  } else if (lower.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return toDocText(name, result.value, 'docx-text');
  } else {
    // .txt, .md, .markdown, and anything else: treat as UTF-8 text.
    return toDocText(name, buffer.toString('utf8'), 'plain-text');
  }
}

type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } };
type OllamaMessage = { role: 'user'; content: string; images: string[] };

export async function extractVisualPdfWithGemini(
  name: string,
  buffer: Buffer,
): Promise<string> {
  const key = getPdfVisionApiKey();
  if (!key) return '';
  const model = process.env.PDF_EXTRACTOR_MODEL || 'gemini-3.5-flash';

  const prompt = `Extract the readable content from this PDF for interview preparation.
Return Markdown/plain text only, not a summary.

Rules:
- Preserve exact company, product, project, person, metric, URL, and technology names.
- Read slide text, tables, diagrams, chart labels, axes, captions, and callouts.
- For visual diagrams, write a concise text equivalent of the important relationships.
- Do not invent or rename anything that is not visible in the PDF.
- Skip decorative images and empty pages.

PDF filename: ${name}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: buffer.toString('base64'),
              },
            },
          ] satisfies GeminiPart[],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Visual PDF extraction failed (${res.status}). ${detail}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();

  if (!text && data.promptFeedback?.blockReason) {
    throw new Error(`Visual PDF extraction was blocked: ${data.promptFeedback.blockReason}.`);
  }

  return text;
}

export function getPdfVisionApiKey(): string {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
}

export function getOllamaPdfVisionModel(): string {
  return process.env.PDF_EXTRACTOR_OLLAMA_MODEL || process.env.OLLAMA_MODEL || 'gemma3:4b';
}

export async function extractVisualPdfWithOllama(
  name: string,
  buffer: Buffer,
): Promise<string> {
  const maxPages = getOllamaPdfVisionMaxPages();
  const images = await renderPdfPagesToPngBase64(buffer, maxPages);
  if (!images.length) return '';

  const base = process.env.PDF_EXTRACTOR_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = getOllamaPdfVisionModel();
  const prompt = `Extract the readable content from this PDF for interview preparation.
The attached images are rendered PDF pages from "${name}" in page order.

Return Markdown/plain text only, not a summary.

Rules:
- Preserve exact company, product, project, person, metric, URL, and technology names.
- Read slide text, tables, diagrams, chart labels, axes, captions, and callouts.
- For visual diagrams, write a concise text equivalent of the important relationships.
- Do not invent or rename anything that is not visible in the PDF.
- Skip decorative images and empty pages.
- Separate pages with "## Page N".`;

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content: prompt, images } satisfies OllamaMessage],
      options: { temperature: 0, num_ctx: 16384 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama PDF vision extraction failed (${res.status}). ${detail}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const text = data.message?.content?.trim() ?? '';
  if (!text) return '';
  return `[Local Ollama PDF vision extracted the first ${images.length} rendered page(s) of "${name}". For full visual-deck extraction, set GOOGLE_API_KEY/GEMINI_API_KEY for Gemini PDF vision or increase PDF_EXTRACTOR_OLLAMA_MAX_PAGES with a stronger local vision model.]\n\n${text}`;
}

function getOllamaPdfVisionMaxPages(): number {
  const parsed = Number(process.env.PDF_EXTRACTOR_OLLAMA_MAX_PAGES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_OLLAMA_PDF_MAX_PAGES;
}

function getOllamaPdfVisionDpi(): string {
  return process.env.PDF_EXTRACTOR_OLLAMA_DPI || DEFAULT_OLLAMA_PDF_RENDER_DPI;
}

async function renderPdfPagesToPngBase64(buffer: Buffer, maxPages: number): Promise<string[]> {
  if (!(await commandExists('pdftoppm'))) return [];

  const dir = await mkdtemp(join(tmpdir(), 'interview-prep-pdf-pages-'));
  try {
    const pdfPath = join(dir, 'input.pdf');
    const pagePrefix = join(dir, 'page');
    await writeFile(pdfPath, buffer);
    await execFile(
      'pdftoppm',
      [
        '-png',
        '-r',
        getOllamaPdfVisionDpi(),
        '-f',
        '1',
        '-l',
        String(maxPages),
        pdfPath,
        pagePrefix,
      ],
      { timeout: 30_000 },
    );

    const pages = (await readdir(dir))
      .filter((file) => /^page-\d+\.png$/.test(file))
      .sort((a, b) => pageNumber(a) - pageNumber(b));

    return Promise.all(
      pages.map(async (file) => (await readFile(join(dir, file))).toString('base64')),
    );
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile('which', [command], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function pageNumber(file: string): number {
  const match = file.match(/page-(\d+)\.png$/);
  return match ? Number(match[1]) : 0;
}
