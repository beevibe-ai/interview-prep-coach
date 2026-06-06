import { NextRequest, NextResponse } from 'next/server';
import { enqueueCommand, getLatestContext, takeCommands } from '@/lib/cobrowse-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  const tabId = req.nextUrl.searchParams.get('tabId') ?? undefined;
  return NextResponse.json({ commands: takeCommands(tabId) }, { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    tabId?: string | number;
    type?: string;
    text?: string;
    url?: string;
  };
  const tabId = body.tabId ?? getLatestContext()?.tabId;

  if (body.type === 'highlight' || body.type === 'scrollToText') {
    const text = body.text?.trim();
    if (!text) {
      return NextResponse.json(
        { ok: false, error: 'Command text is required.' },
        { status: 400, headers: corsHeaders },
      );
    }
    const command = enqueueCommand(tabId, { type: body.type, text });
    return NextResponse.json({ ok: true, command }, { headers: corsHeaders });
  }

  if (body.type === 'navigate') {
    const url = body.url?.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return NextResponse.json(
        { ok: false, error: 'A safe http(s) URL is required.' },
        { status: 400, headers: corsHeaders },
      );
    }
    const command = enqueueCommand(tabId, { type: 'navigate', url });
    return NextResponse.json({ ok: true, command }, { headers: corsHeaders });
  }

  return NextResponse.json(
    { ok: false, error: 'Unknown browser guide command.' },
    { status: 400, headers: corsHeaders },
  );
}
