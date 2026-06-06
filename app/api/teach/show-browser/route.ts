import { NextResponse } from 'next/server';
import { showCdpBrowser } from '@/lib/hermes-teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await showCdpBrowser();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Could not show the browser.' },
      { status: 500 },
    );
  }
}
