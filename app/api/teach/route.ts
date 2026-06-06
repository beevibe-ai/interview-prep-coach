import { NextRequest } from 'next/server';
import { ensureCdpBrowser, runHermesLesson } from '@/lib/hermes-teacher';
import type { TeachEvent } from '@/lib/teacher-contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface TeachRequest {
  goal?: string;
  sessionId?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as TeachRequest;
  const goal = body.goal?.trim();
  if (!goal) {
    return new Response(JSON.stringify({ error: 'A lesson goal is required.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TeachEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      req.signal.addEventListener('abort', () => abort.abort(), { once: true });

      try {
        send({ kind: 'status', text: 'Preparing the visible browser...' });
        const browser = await ensureCdpBrowser();
        send({ kind: 'status', text: browser.status });
        send({ kind: 'status', text: body.sessionId ? 'Resuming Hermes...' : 'Starting Hermes...' });

        const result = await runHermesLesson({
          goal,
          sessionId: body.sessionId,
          cdpUrl: browser.cdpUrl,
          signal: abort.signal,
          onThought: (text) => send({ kind: 'thought', text }),
          onMoment: (moment) => {
            if (moment.kind === 'observe' || moment.kind === 'act') {
              send({ kind: moment.kind, text: moment.text });
            }
          },
          onSay: (text) => send({ kind: 'say', text }),
        });

        if (result.ok && result.sessionId) {
          send({
            kind: 'checkpoint',
            sessionId: result.sessionId,
            text: 'Hermes is paused. Ask a question or steer the next browser step.',
          });
        }

        if (result.ok) {
          send({ kind: 'done', sessionId: result.sessionId, summary: result.summary });
        } else {
          send({
            kind: 'error',
            error:
              result.setupError
                ? result.summary
                : `${result.summary}\n\nHermes exited with a non-zero status. Run \`hermes model\` if this is an auth or model setup issue.`,
          });
        }
      } catch (err) {
        send({
          kind: 'error',
          error: err instanceof Error ? err.message : 'The live teacher failed.',
        });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
