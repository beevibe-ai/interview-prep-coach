import { NextRequest, NextResponse } from 'next/server';
import { extractText, getOllamaPdfVisionModel, getPdfVisionApiKey } from '@/lib/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Kept under common serverless request-body limits (e.g. Vercel ~4.5 MB) so
// uploads work on hosted deployments, not just locally.
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB per file

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files uploaded.' }, { status: 400 });
    }

    const docs = [];
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `"${file.name}" is larger than 4 MB.` },
          { status: 413 },
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const doc = await extractText(file.name, buffer);
      if (!doc.text.trim()) {
        const visualHint =
          file.name.toLowerCase().endsWith('.pdf') && !getPdfVisionApiKey()
            ? ` Local Ollama PDF vision also tried "${getOllamaPdfVisionModel()}"; set GOOGLE_API_KEY or GEMINI_API_KEY to enable Gemini PDF vision extraction instead.`
            : '';
        return NextResponse.json(
          {
            error: `"${file.name}" uploaded, but no readable text could be extracted.${visualHint}`,
          },
          { status: 422 },
        );
      }
      docs.push(doc);
    }

    return NextResponse.json({ documents: docs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to process upload.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
