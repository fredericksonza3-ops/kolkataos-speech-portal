import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendTranscript, attachSession, codeExists, deleteSession, getSession, getSessionByCode, saveSession, storageMode, storageReady } from "./store.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "..", "public");
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SERVER_KEY = process.env.SPEECH_PORTAL_KEY || "dev-only-change-me";
const CODE_TTL_MS = Number(process.env.CODE_TTL_MS || 15 * 60 * 1000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 60 * 60 * 1000);
const MAX_TEXT = 1000;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-speech-portal-key, x-speech-session-token, authorization",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(data);
}

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function auth(req) {
  return sameSecret(req.headers["x-speech-portal-key"], SERVER_KEY);
}

function sessionAuth(req, session) {
  const header = req.headers["x-speech-session-token"] || "";
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return sameSecret(header || bearer, session.pollToken);
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

async function makeCode() {
  let code = randomCode();
  while (await codeExists(code)) code = randomCode();
  return code;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32_000) throw new Error("request too large");
  }
  if (!body) return {};
  return JSON.parse(body);
}

function validSession(session) {
  return session && session.expiresAt > Date.now();
}

function publicSession(session) {
  return {
    sessionId: session.id,
    code: session.code,
    player: session.player,
    expiresAt: session.expiresAt,
    attached: Boolean(session.browserToken),
  };
}

async function findSession(id) {
  const session = await getSession(id);
  if (!validSession(session)) {
    if (session) await deleteSession(session);
    return null;
  }
  return session;
}

function routeParam(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length).split("/")[0];
  return value ? decodeURIComponent(value) : null;
}

function mutationError(res, status) {
  const errors = {
    session_missing: [401, "Your Roblox link is no longer available. Get a new pairing code from the game."],
    session_expired: [401, "Your Roblox link expired. Get a new pairing code from the game."],
    code_expired: [404, "This pairing code expired. Get a new code from the game."],
    attachment_missing: [401, "Pair this window with your Roblox code before speaking."],
    token_invalid: [401, "This window's pairing token is no longer valid. Reconnect using your Roblox code."],
    rate_limited: [429, "Speech updates arrived too quickly. Please try again."],
  };
  const [httpStatus, error] = errors[status] || [500, "Could not update the speech session."];
  return json(res, httpStatus, { error, code: status });
}

export async function handle(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, PUBLIC_URL);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/v1/health") return json(res, storageReady() ? 200 : 503, { ok: storageReady(), service: "speech-portal", storage: storageMode() });
  if (pathname.startsWith("/api/v1/") && !storageReady()) {
    return json(res, 503, { code: "storage_not_configured", error: "The portal's shared session storage is not configured. Connect Redis in Vercel, add its REST URL and token to Production, then redeploy." });
  }

  if (req.method === "POST" && pathname === "/api/v1/game/sessions") {
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });
    try {
      const body = await readBody(req);
      if (!Number.isInteger(Number(body.userId)) || Number(body.userId) <= 0) return json(res, 400, { error: "userId is required" });
      const now = Date.now();
      const session = {
        id: crypto.randomUUID(),
        code: await makeCode(),
        pollToken: crypto.randomBytes(32).toString("base64url"),
        browserToken: null,
        player: {
          userId: Number(body.userId),
          username: String(body.username || "Player").slice(0, 32),
          displayName: String(body.displayName || body.username || "Player").slice(0, 32),
          placeId: Number(body.placeId) || null,
        },
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        codeExpiresAt: now + CODE_TTL_MS,
        cursor: 0,
        events: [],
        lastPostAt: 0,
        lastPartialAt: 0,
      };
      await saveSession(session);
      return json(res, 201, {
        ...publicSession(session),
        pollToken: session.pollToken,
        portalUrl: `${PUBLIC_URL}/?code=${encodeURIComponent(session.code)}`,
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "invalid json" });
    }
  }

  if (req.method === "POST" && pathname === "/api/v1/browser/attach") {
    try {
      const body = await readBody(req);
      const code = String(body.code || "").trim().toUpperCase();
      const session = await getSessionByCode(code);
      if (!session || !validSession(session)) return json(res, 404, { error: "pairing code expired or not found" });
      if (session.codeExpiresAt <= Date.now()) return json(res, 404, { error: "pairing code expired or not found" });
      const result = await attachSession(session.id, crypto.randomBytes(32).toString("base64url"));
      if (result.status !== "ok") return mutationError(res, result.status);
      return json(res, 200, { ...publicSession(result.session), browserToken: result.session.browserToken });
    } catch (error) {
      return json(res, 400, { error: error.message || "invalid json" });
    }
  }

  const gameId = routeParam(pathname, "/api/v1/game/sessions/");
  if (gameId) {
    const session = await findSession(gameId);
    if (!session || !auth(req) || !sessionAuth(req, session)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && pathname.endsWith("/transcripts")) {
      const after = Math.max(0, Number(url.searchParams.get("after") || 0));
      const pending = session.events.filter((event) => event.cursor > after);
      // Several browser interim results can arrive between Roblox polls. Keep only
      // the newest update for each stream so the game does not replay stale words.
      const latest = new Map();
      for (const event of pending) latest.set(event.streamId ? `stream:${event.streamId}` : `event:${event.cursor}`, event);
      const events = [...latest.values()].sort((a, b) => a.cursor - b.cursor).slice(-8);
      const nextCursor = pending.length ? pending[pending.length - 1].cursor : after;
      return json(res, 200, { events, nextCursor, expiresAt: session.expiresAt, attached: Boolean(session.browserToken) });
    }
    if (req.method === "GET") return json(res, 200, publicSession(session));
    if (req.method === "DELETE") {
      await deleteSession(session);
      return json(res, 200, { ok: true });
    }
  }

  const transcriptId = routeParam(pathname, "/api/v1/sessions/");
  if (transcriptId && pathname.endsWith("/transcripts") && req.method === "POST") {
    try {
      const body = await readBody(req);
      const text = String(body.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT);
      if (!text) return json(res, 400, { error: "text is required" });
      const partial = body.partial === true;
      const now = Date.now();
      const streamId = String(body.streamId || "").trim().slice(0, 80) || null;
      const token = typeof req.headers["x-speech-session-token"] === "string" ? req.headers["x-speech-session-token"] : "";
      const result = await appendTranscript(transcriptId, token, { text, partial, streamId, createdAt: now });
      if (result.status !== "ok") return mutationError(res, result.status);
      return json(res, 202, { accepted: true, cursor: result.session.cursor });
    } catch (error) {
      return json(res, 400, { error: error.message || "invalid json" });
    }
  }

  return serveStatic(pathname, res);
}

function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.resolve(PUBLIC, `.${requested}`);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "not found" });
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

export { json, storageMode, validSession };
