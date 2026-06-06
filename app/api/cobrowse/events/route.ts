import { getLatestContext, subscribeToContext } from '@/lib/cobrowse-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const latest = getLatestContext();
      if (latest) send({ context: latest });

      const unsubscribe = subscribeToContext((context) => send({ context }));
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 15000);

      req.signal.addEventListener(
        'abort',
        () => {
          clearInterval(heartbeat);
          unsubscribe();
          controller.close();
        },
        { once: true },
      );
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
