import { NextRequest, NextResponse } from 'next/server';
import { getLatestContext, getTeachingHistory, recordTeaching } from '@/lib/cobrowse-store';
import {
  buildCoBrowseSystem,
  extractTeachingHighlights,
  splitCompleteTeachingSentences,
} from '@/lib/cobrowse-teach';
import { anthropicAvailable, anthropicStream } from '@/lib/anthropic';
import { chat } from '@/lib/llm';
import type { ChatMessage } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    question?: string;
    focus?: string;
    mode?: string;
    language?: string;
  };
  const language: 'en' | 'zh' = body.language === 'zh' ? 'zh' : 'en';
  const context = getLatestContext();
  if (!context) {
    return NextResponse.json(
      { error: 'No active browser tab is connected yet.' },
      { status: 409, headers: corsHeaders },
    );
  }

  const question = body.question?.trim();
  const focus = (body.focus || '').trim();
  const material = (focus || context.visibleText || '').slice(0, 2500);
  const mode = question ? 'detail' : body.mode === 'overview' ? 'overview' : body.mode === 'section' ? 'section' : 'detail';
  const history = getTeachingHistory(context.url);
  const alreadyCovered = history.length
    ? ['You have already said these to the learner — do NOT repeat or reword any of them:', ...history.map((h) => `- ${h}`), ''].join('\n')
    : '';
  const instruction =
    mode === 'overview'
      ? 'Give the opening of a guided walkthrough of this whole source, using the title, section list, and opening text below.'
      : mode === 'section'
        ? 'Teach the key takeaway of this section to the learner.'
        : `Learner question: ${question}`;
  const label = mode === 'overview' ? 'Source overview:' : mode === 'section' ? 'Section:' : 'On screen:';
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [instruction, '', alreadyCovered, label, material || '(no text captured)']
        .filter(Boolean)
        .join('\n'),
    },
  ];
  const system = buildCoBrowseSystem(mode, language);
  const url = context.url;

  // Stream sentence-by-sentence over SSE so the client can speak sentence 1
  // before generation finishes. Both the Claude and Gemma-fallback paths emit
  // the same `{type:'say'|'done'|'error'}` events, so clients have one contract.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let pending = '';
      const emit = (sentence: string) => {
        const { text, highlights } = extractTeachingHighlights(sentence, language);
        if (text) send({ type: 'say', text, highlights });
      };
      const flush = (final: boolean) => {
        const split = splitCompleteTeachingSentences(pending, final);
        split.sentences.forEach(emit);
        pending = split.rest;
      };

      try {
        let full = '';
        if (anthropicAvailable()) {
          full = await anthropicStream({ system, messages, maxTokens: 200, temperature: 0.5 }, (delta) => {
            pending += delta;
            flush(false);
          });
          flush(true);
        } else {
          full = await chat(system, messages);
          pending = full;
          flush(true);
        }
        const plain = full.replace(/\[\[(.+?)\]\]/g, '$1').trim();
        if (!question && plain) recordTeaching(url, plain);
        send({ type: 'done' });
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : 'The co-browse teacher is unavailable.' });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
