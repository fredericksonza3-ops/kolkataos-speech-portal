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

## Roblox setup

1. In `Match/src/ServerScriptService/SpeechPortalConfig/source.luau`, set the public URL:

   ```lua
   return {
       URL = 'https://kolkataos-speech-portal.vercel.app',
       SERVER_KEY = '',
   }
   ```

   Keep `SERVER_KEY` empty for production. The server script reads the secret store first.

2. In Roblox Studio, open **File → Experience Settings → Security**, enable **Allow HTTP Requests**, and add a local secret named `SPEECH_PORTAL_SERVER_KEY` with the exact same value as Vercel's `SPEECH_PORTAL_KEY`. Roblox's `HttpService:GetSecret()` reads this value only from server scripts; local secrets are intended for Studio testing. See the [Roblox secrets documentation](https://create.roblox.com/docs/cloud-services/secrets).

3. For the published experience, create the same `SPEECH_PORTAL_SERVER_KEY` secret in the experience's Creator Dashboard secret store. Do not put the key in a LocalScript, the website, or a public module.

4. Sync/build the `Match/match.project.json` project and publish the place. `SpeechPortalService` creates one pairing session per player and polls the Vercel API. During an active Phone call, the `+` button beside the microphone shows the code and instructions.

5. Open the Vercel website, launch **Microphone**, enter the code, allow browser microphone access, and press **Start microphone**. The transcript is sent to the game server, where `SpeechService` applies Roblox filtering before displaying or using it.

## Hosting notes

Use any Node 18+ host that supports a long-running process. Set the environment variables from `.env.example` and enable HTTPS. Put the public URL in `Match/src/ServerScriptService/SpeechPortalConfig/source.luau` (`URL = 'https://your-host.example'`) and add the same server key as the `SPEECH_PORTAL_SERVER_KEY` Roblox secret. If your host uses a start command, use `npm start`.
