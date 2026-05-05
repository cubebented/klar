# Architecture

A static, no-build single-page app deployed on Vercel. The browser runs `index.html` directly; three Vercel Edge Functions proxy the AI/TTS APIs so secrets never ship to the client.

## Repository layout

```
.
├── api/                    Vercel Edge Functions (server-side, secrets here)
│   ├── generate.js         DeepSeek chat-completions proxy
│   ├── tts.js              Inworld TTS streaming proxy
│   └── voices.js           Inworld voice catalog proxy
│
├── css/                    Stylesheets — entry is styles.css
│   ├── styles.css          Legacy consolidated stylesheet (being split incrementally)
│   ├── welcome.css         Splash / intro screen
│   └── journal.css         Conversational profile (Journal v2)
│
├── js/
│   ├── app.js              Application code (single-file, IIFE-scoped)
│   └── dev-reload.js       Dev-only hot reload helper
│
├── docs/                   Project docs
│   ├── ARCHITECTURE.md     This file
│   └── CHANGELOG.md        Notable changes
│
├── index.html              Single page entry
├── vercel.json             Routing + clean URLs
├── package.json            Scripts only — no JS deps
├── README.md
├── LICENSE
└── .editorconfig
```

## Why no build step

The app is small enough that one HTML + one CSS + one JS file load fast over HTTP/2 with edge caching. A bundler would add a deploy step, source-map maintenance, and dependencies in exchange for marginal gains here. If app.js grows past a comfortable single-file ceiling, the migration target is native ES modules (`<script type="module">`) — no bundler still required.

## Data flow

```
  Browser
    │
    │  fetch /api/generate   (DeepSeek prompts — German texts, tutor replies, journal extraction)
    │  fetch /api/tts        (Inworld streaming TTS — NDJSON of audio chunks)
    │  fetch /api/voices     (Inworld voice catalog, filtered to German)
    ▼
  Vercel Edge (api/*.js)
    │  attach Authorization header (env var)
    ▼
  DeepSeek / Inworld upstream
```

All upstream credentials live in Vercel project env vars: `DEEPSEEK_API_KEY` and `INWORLD_AUTH`.

## Client state

Everything user-facing — profiles, saved words, XP, streaks, journal history — lives in `localStorage` under keys prefixed `deutschify:` / `klar:`. There is no server-side user state and no analytics.

The active profile is whatever `state.activeProfileId` points to in `state.profiles`. A "family" is just multiple profiles in the same map; switching between them swaps every per-profile bit of state (level, words, history, journal).

## CSS organisation

`styles.css` is the entry the browser loads. Newer self-contained features (welcome, journal v2) live in their own files imported via separate `<link>` tags. The plan is to incrementally extract sections of the legacy `styles.css` into feature-scoped files (`reader.css`, `chat.css`, `progress.css`, `settings.css`) until `styles.css` only contains design tokens + base.

## Journal AI flow

The Journal is a chat thread. Each user message is sent to `/api/generate` (DeepSeek) with a system prompt that asks for strict JSON containing:

```json
{
  "reply":   "1 sentence ack + 1 follow-up question",
  "extracted": { name, age, occupation, hobbies, location, goals, weakAreas },
  "summary": "second-person 'about you' paragraph (or '')",
  "plan":    "second-person personalised teaching plan (or '')"
}
```

Extracted fields merge into the active profile. Summary and plan render as cards above the chat. The plan is what every text generator request reads when building the system prompt for the German text — that's how the profile actually shapes output.

## Splash screen

Single-shot, session-scoped (`sessionStorage` flag `klar:splash-seen`). Never re-appears in the same browser session unless storage is cleared.
