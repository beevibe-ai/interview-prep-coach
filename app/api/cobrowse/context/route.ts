import { NextRequest, NextResponse } from 'next/server';
import { getLatestContext, setLatestContext } from '@/lib/cobrowse-store';

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

export async function GET() {
  return NextResponse.json({ context: getLatestContext() }, { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const context = setLatestContext(await req.json());
    return NextResponse.json({ ok: true, context }, { headers: corsHeaders });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Invalid page context.' },
      { status: 400, headers: corsHeaders },
    );
  }
}
