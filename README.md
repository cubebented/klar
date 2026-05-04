# klar

**Live: [klar-de.vercel.app](https://klar-de.vercel.app)**

Read German at your level. Click any word for an instant translation, listen with native German TTS.

A single-page app for casual German reading practice — generates fresh A1–C1 texts on demand, hover-free click-to-translate vocabulary, native German voices via Inworld TTS, real-life topics anchored in lived German culture (Anmeldung, Späti, U-Bahn delays, WG drama).

## Stack

- Static frontend (`index.html`, `js/app.js`, `css/styles.css`) — no build step
- Vercel Edge Functions (`api/generate`, `api/tts`, `api/voices`) proxy upstream APIs so keys stay server-side
- DeepSeek for content generation, Inworld TTS for German speech, DiceBear avatars for dialogue

## Local development

```bash
npm i -g vercel
vercel dev
```

Then open [http://localhost:3000](http://localhost:3000).

Set environment variables in a `.env.local` file:

```
DEEPSEEK_API_KEY=sk-...
INWORLD_AUTH=Basic <base64-encoded-credentials>
```

## Deployment

```bash
vercel --prod
```

Set the same env vars in the Vercel dashboard (Project Settings → Environment Variables).

## License

MIT.
