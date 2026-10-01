import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "..", "public");
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SERVER_KEY = process.env.SPEECH_PORTAL_KEY || "dev-only-change-me";
const CODE_TTL_MS = Number(process.env.CODE_TTL_MS || 15 * 60 * 1000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 60 * 60 * 1000);
const MAX_TEXT = 1000;
const sessions = new Map();

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

function makeCode() {
  let code = randomCode();
  while ([...sessions.values()].some((s) => s.code === code && s.expiresAt > Date.now())) code = randomCode();
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

function findSession(id) {
  const session = sessions.get(id);
  if (!validSession(session)) {
    if (session) sessions.delete(id);
    return null;
  }
  return session;
}

function routeParam(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length).split("/")[0];
  return value ? decodeURIComponent(value) : null;
}

export async function handle(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, PUBLIC_URL);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/v1/health") return json(res, 200, { ok: true, service: "speech-portal" });

  if (req.method === "POST" && pathname === "/api/v1/game/sessions") {
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });
    try {
      const body = await readBody(req);
      if (!Number.isInteger(Number(body.userId)) || Number(body.userId) <= 0) return json(res, 400, { error: "userId is required" });
      const now = Date.now();
      const session = {
        id: crypto.randomUUID(),
        code: makeCode(),
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
      };
      sessions.set(session.id, session);
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
      const session = [...sessions.values()].find((candidate) => candidate.code === code && candidate.codeExpiresAt > Date.now());
      if (!session || !validSession(session)) return json(res, 404, { error: "pairing code expired or not found" });
      session.browserToken = crypto.randomBytes(32).toString("base64url");
      return json(res, 200, { ...publicSession(session), browserToken: session.browserToken });
    } catch (error) {
      return json(res, 400, { error: error.message || "invalid json" });
    }
  }

  const gameId = routeParam(pathname, "/api/v1/game/sessions/");
  if (gameId) {
    const session = findSession(gameId);
    if (!session || !auth(req) || !sessionAuth(req, session)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && pathname.endsWith("/transcripts")) {
      const after = Math.max(0, Number(url.searchParams.get("after") || 0));
      const events = session.events.filter((event) => event.cursor > after).slice(0, 8);
      return json(res, 200, { events, nextCursor: events.length ? events[events.length - 1].cursor : after, expiresAt: session.expiresAt, attached: Boolean(session.browserToken) });
    }
    if (req.method === "GET") return json(res, 200, publicSession(session));
    if (req.method === "DELETE") {
      sessions.delete(gameId);
      return json(res, 200, { ok: true });
    }
  }

  const transcriptId = routeParam(pathname, "/api/v1/sessions/");
  if (transcriptId && pathname.endsWith("/transcripts") && req.method === "POST") {
    const session = findSession(transcriptId);
    if (!session || !session.browserToken || !sameSecret(req.headers["x-speech-session-token"], session.browserToken)) return json(res, 401, { error: "not attached" });
    if (Date.now() - session.lastPostAt < 250) return json(res, 429, { error: "slow down" });
    try {
      const body = await readBody(req);
      const text = String(body.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT);
      if (!text) return json(res, 400, { error: "text is required" });
      session.lastPostAt = Date.now();
      session.cursor += 1;
      session.events.push({ cursor: session.cursor, text, createdAt: Date.now() });
      if (session.events.length > 40) session.events.splice(0, session.events.length - 40);
      return json(res, 202, { accepted: true, cursor: session.cursor });
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

export { json, sessions, validSession };
