# Interview Prep Coach

A web app for practicing how you *talk about* your resume and projects — out loud, on a
mock video call, without sounding rehearsed.

You upload your materials, then hop on a call with an AI coach:

1. **It asks** an interview question out loud (grounded in your materials).
2. **You speak** your answer. When you pause, your turn is sent automatically.
3. **The coach reacts to how you sounded** — pace, filler words ("um"/"like"), long pauses,
   confidence — plus a live transcript, and replies by voice with a concrete line to
   practice ("Try saying it something like this…").
4. **You push back or practice**, all spoken, until it feels natural and like *you*.

You also **choose the interviewer** — recruiter, hiring manager, technical, behavioral, VC, or
executive — and the questions shift to match that lens. Every question is grounded in your
actual materials; it won't invent projects or topics you didn't mention.

The coach is a **Gemma** model. It runs either against a **local Ollama** instance (great for
solo dev — Gemma 3) or the **Google AI API** (required for a hosted, public deployment — Gemma
4), switched with a single env var.

## How a turn works (the "video call" feel)

- **Self-view webcam** so you get used to being on camera (frames are not analyzed).
- **Open mic with silence detection** — speak naturally; a pause ends your turn. Or hit
  **Done answering**.
- **Live captions** (Chrome/Edge, via the Web Speech API) show your words as you talk.
- **Delivery signals** are computed in-browser every turn — words-per-minute, filler-word
  count, long pauses, duration — and sent to the coach so it critiques *delivery*, not just
  content. **This is how delivery coaching works on the hosted path**, where the model only
  sees text.
- **Raw audio → model is the exception, not the rule.** The hosted Gemini API Gemma 4 models
  (`gemma-4-26b-a4b-it`, `gemma-4-31b-it`) are **text + image only — they do not accept
  audio**. Only the small **E2B/E4B** variants accept audio (and only up to 30s), and those
  run **locally**, not on the hosted API. So on a public deployment the coach reads your
  transcript + delivery signals; it does not literally hear the recording. Set
  `SEND_AUDIO=true` only when pointing at a local audio-capable Gemma 4.
- **The coach talks back** via the browser's built-in text-to-speech.

---

## Run it locally (Ollama — free, private, no API key)

**Prerequisites:** Node 18+ and [Ollama](https://ollama.com).

```bash
# 1. Install Ollama, start its server, and pull a model
brew install ollama            # macOS; see ollama.com for other platforms
ollama serve &                 # local model server on :11434 (skip if already running)
ollama pull gemma3:4b          # ~3.3 GB — a solid default for text coaching

# 2. Install + configure the app
npm install
cp .env.example .env.local     # defaults already target Ollama + gemma3:4b

# 3. Run it
npm run dev                    # → http://localhost:3100
```

Open **http://localhost:3100** in **Chrome** (best Web Speech support) and **allow camera +
mic**. In the lobby: **pick who's interviewing you** (recruiter, hiring manager, technical,
behavioral, VC, or executive), upload your resume, and start the call.

`.env.local` (Ollama defaults — already set by `cp .env.example .env.local`):

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:4b         # any tag from `ollama list`
```

For image-heavy PDFs and slide decks, add `GOOGLE_API_KEY` or `GEMINI_API_KEY` even if the
coach itself stays on Ollama. The upload route first tries the embedded PDF text layer, then
falls back to Gemini document vision (`PDF_EXTRACTOR_MODEL=gemini-3.5-flash`) when the text
layer is empty or tiny. If no Gemini key is configured, it can render PDF pages locally with
Poppler's `pdftoppm` and send those page images to Ollama
(`PDF_EXTRACTOR_OLLAMA_MODEL=gemma3:4b`, or `qwen2.5vl:7b` if you pull it). The local path
defaults to the first 3 rendered pages so uploads stay responsive on small local models.

> **Bigger model = sharper, more on-persona questions.** `gemma3:4b` is fast and fine for
> practice; `ollama pull gemma3:12b` then set `OLLAMA_MODEL=gemma3:12b` for noticeably better
> persona adherence (a bit slower).

> Want the model to actually **hear** your audio? Use an audio-capable Gemma variant
> (E2B/E4B) via Ollama and set `SEND_AUDIO=true`. Audio is capped at 30 seconds; longer
> answers still get coached via transcript + delivery signals (which work on any model).

> Note: browser camera/mic require a **secure context** — `localhost` counts, so local dev
> works without HTTPS.

---

## Deploying for a broad audience (hosted)

A public deployment **cannot use Ollama** (it's a local process). Point it at the hosted
**Google AI API** so every visitor hits a hosted Gemma 4. The hosted API offers two Gemma 4
models — both **text + image only (no audio)**:

```
LLM_PROVIDER=google
GOOGLE_API_KEY=your_key_here
GOOGLE_MODEL=gemma-4-26b-a4b-it   # MoE, lighter/cheaper (recommended). Or gemma-4-31b-it (dense, higher quality)
PDF_EXTRACTOR_MODEL=gemini-3.5-flash # visual PDF extraction for slide decks/scanned PDFs
PDF_EXTRACTOR_OLLAMA_MODEL=gemma3:4b # local visual PDF fallback; qwen2.5vl:7b is stronger if installed
SEND_AUDIO=false                  # hosted Gemma 4 rejects audio; coaching uses transcript + delivery signals

# Rate limiting — protects your paid API on a public URL
RATE_LIMIT_MAX=30            # model calls per IP per window (0 disables)
RATE_LIMIT_WINDOW_SEC=3600
UPSTASH_REDIS_REST_URL=      # optional, see below
UPSTASH_REDIS_REST_TOKEN=
```

### Vercel (recommended — repo already uses Vercel)

1. Create a Vercel project from this repo (the repo root is the app — no subdirectory).
2. Framework preset: **Next.js** (auto-detected; a `vercel.json` is included).
3. Add the env vars above in **Project Settings → Environment Variables**.
4. Deploy. Vercel serves over **HTTPS**, which the camera, mic, and Web Speech API require.

Notes for hosted serverless:
- Request bodies are kept small (uploads capped at 4 MB/file; spoken-audio clips are tiny).
- The chat route sets `maxDuration = 60` — model responses need Vercel **Pro** to use the
  full 60s; the Hobby tier caps functions at 10s (usually fine for short coach replies).

### Anything that runs a Node server

`npm run build && npm run start` behind an HTTPS reverse proxy works too — just serve it
over TLS and set the same env vars.

### Cost / abuse protection (rate limiting)

The `/api/chat` endpoint — the one that costs money — is **rate limited per IP**
(`RATE_LIMIT_MAX` calls per `RATE_LIMIT_WINDOW_SEC`). Over the limit returns HTTP 429 and the
app shows a friendly "hit the practice limit" message.

- **Out of the box:** a best-effort in-memory limiter (per serverless instance).
- **For a real public launch:** add a free **Upstash Redis** database
  (https://console.upstash.com) and set `UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN`. The limiter then enforces limits **durably across Vercel's
  whole serverless fleet** (the in-memory fallback resets on every cold start and isn't
  shared between instances, so it's only a soft guard). No SDK is added — it uses Upstash's
  REST API directly.

There is still **no login** — anyone with the URL can practice (within the rate limit). Add
accounts later if you need per-user history or stricter control.

---

## How it's built

A self-contained **Next.js 14 (App Router)** app — no database. A call's state lives in the
browser; the backend is stateless.

```
app/
  page.tsx              # phase switch: Lobby ↔ Call; holds the interviewer choice
  api/upload/route.ts   # extract text from PDF/DOCX/TXT/MD
  api/chat/route.ts     # build the coach prompt (persona + grounding), call the model
components/
  Lobby.tsx             # pick interviewer, upload materials, start the call
  Call.tsx              # webcam, mic VAD, captions, recording, TTS, turn-taking
lib/
  llm.ts                # provider abstraction (ollama | google), audio attach
  speech.ts             # TTS, speech recognition, delivery-signal computation
  extract.ts            # document text extraction
  prompts.ts            # interviewer personas + grounded question / coach prompts
  types.ts
```

## Model tags (verified against the Google AI catalog)

Hosted Gemini API Gemma 4 models — set `GOOGLE_MODEL` to one of:
- `gemma-4-26b-a4b-it` — MoE, lighter/cheaper (default, recommended)
- `gemma-4-31b-it` — dense, higher quality

Both are **text + image only**. Audio input belongs to the **E2B/E4B** variants
(`gemma-4-E4B-it`, `gemma-4-E2B-it`), which run locally (Ollama / download), accept audio up
to 30s, and are **not** on the hosted API. The Gemini API free tier allows ~1,500 Gemma 4
requests/day. For Ollama, set `OLLAMA_MODEL` to the exact tag from `ollama list`.

## Not done yet

User accounts + saved sessions and progress tracking, rate limiting / abuse protection for
public hosting, optional nicer (hosted) TTS voices, and full live-duplex (barge-in)
conversation. All deferred from this focused MVP.
