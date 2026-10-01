# KolkataOS Speech Portal

This folder is a self-contained website and API for the browser Microphone app. It uses the browser's built-in speech recognition, so no speech provider key is exposed to players. The transcript is sent to the API and the Roblox server polls it. Roblox then runs the text through `TextService` before showing it or passing it to the phone system.

## Run locally

```bash
copy .env.example .env
# edit SPEECH_PORTAL_KEY in .env
npm run dev
```

The server listens on `http://localhost:8787` by default. For a hosted deployment, set `PUBLIC_URL` to the public HTTPS URL and set a strong `SPEECH_PORTAL_KEY`.

## Deploy on Vercel

Import this `speech-portal` folder as the Vercel project root. Vercel will use `api/index.js` for the API and `vercel.json` to serve the `public` UI. Add `SPEECH_PORTAL_KEY` in the Vercel project environment variables and set `PUBLIC_URL` to the production URL if you want generated links to use a custom domain. The API currently keeps active sessions in memory, so a server restart expires links; for a larger production deployment, move the session map to Redis or another shared store.

## API contract

The Roblox server calls `POST /api/v1/game/sessions` with `x-speech-portal-key`. The response contains a six-character `code`, `sessionId`, `pollToken`, and `portalUrl`. The player enters the code on the Microphone app. The browser posts transcript lines to `/api/v1/sessions/:id/transcripts`; Roblox polls `/api/v1/game/sessions/:id/transcripts?after=N` using both the server key and session token.

The API stores only a short in-memory queue. Restarting the process ends active links, and the process should run behind HTTPS in production.

## Hosting notes

Use any Node 18+ host that supports a long-running process. Set the environment variables from `.env.example` and enable HTTPS. Put the public URL in `Match/src/ServerScriptService/SpeechPortalConfig/source.luau` (`URL = 'https://your-host.example'`) and add the same server key as the `SPEECH_PORTAL_SERVER_KEY` Roblox secret. If your host uses a start command, use `npm start`.
