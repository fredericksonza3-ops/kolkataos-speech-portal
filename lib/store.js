const memorySessions = new Map();

// Upstash's REST API works from Vercel Functions without a long-lived Redis
// connection. The KV names are supported too for older Vercel integrations.
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const redisEnabled = Boolean(redisUrl && redisToken);
const PREFIX = "speech-portal:";

async function redisCommand(command, ...args) {
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${redisToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify([command, ...args]),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Redis request failed (${response.status})`);
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

function sessionKey(id) { return `${PREFIX}session:${id}`; }
function codeKey(code) { return `${PREFIX}code:${code}`; }
function ttlSeconds(expiresAt) { return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)); }

export function storageMode() { return redisEnabled ? "redis" : "memory"; }
export function storageReady() { return redisEnabled || process.env.VERCEL !== "1"; }

export async function codeExists(code) {
  if (redisEnabled) return Boolean(await redisCommand("EXISTS", codeKey(code)));
  return [...memorySessions.values()].some((session) => session.code === code && session.codeExpiresAt > Date.now());
}

export async function saveSession(session) {
  if (redisEnabled) {
    await redisCommand("SET", sessionKey(session.id), JSON.stringify(session), "EX", String(ttlSeconds(session.expiresAt)));
    await redisCommand("SET", codeKey(session.code), session.id, "EX", String(ttlSeconds(session.codeExpiresAt)));
    return;
  }
  memorySessions.set(session.id, session);
}

export async function getSession(id) {
  if (redisEnabled) {
    const raw = await redisCommand("GET", sessionKey(id));
    if (!raw) return null;
    try {
      const session = JSON.parse(raw);
      // Redis Lua cjson represents empty tables as objects.
      if (!Array.isArray(session.events)) session.events = [];
      return session;
    } catch { return null; }
  }
  return memorySessions.get(id) || null;
}

export async function getSessionByCode(code) {
  if (redisEnabled) {
    const id = await redisCommand("GET", codeKey(code));
    return id ? getSession(id) : null;
  }
  return [...memorySessions.values()].find((session) => session.code === code) || null;
}

export async function deleteSession(session) {
  if (redisEnabled) {
    await redisCommand("DEL", sessionKey(session.id), codeKey(session.code));
    return;
  }
  memorySessions.delete(session.id);
}

// Redis executes the whole script atomically. Never GET, modify and SET session
// JSON for an attachment or transcript: concurrent requests can undo each other.
const MUTATE_SESSION = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({status = 'session_missing'}) end
local session = cjson.decode(raw)
local now = tonumber(ARGV[2])
if session.expiresAt <= now then return cjson.encode({status = 'session_expired'}) end
if ARGV[1] == 'attach' then
  if session.codeExpiresAt <= now then return cjson.encode({status = 'code_expired'}) end
  if session.browserToken == nil or session.browserToken == cjson.null then
    session.browserToken = ARGV[3]
  end
elseif ARGV[1] == 'append' then
  if session.browserToken == nil or session.browserToken == cjson.null then
    return cjson.encode({status = 'attachment_missing'})
  end
  if session.browserToken ~= ARGV[3] then return cjson.encode({status = 'token_invalid'}) end
  local event = cjson.decode(ARGV[4])
  local field = event.partial and 'lastPartialAt' or 'lastPostAt'
  if now - (session[field] or 0) < 250 then return cjson.encode({status = 'rate_limited'}) end
  session[field] = now
  session.cursor = session.cursor + 1
  event.cursor = session.cursor
  table.insert(session.events, event)
  while #session.events > 40 do table.remove(session.events, 1) end
else
  return cjson.encode({status = 'invalid_action'})
end
redis.call('SET', KEYS[1], cjson.encode(session), 'KEEPTTL')
return cjson.encode({status = 'ok', session = session})
`;

async function mutateSession(id, action, token, event = null) {
  const now = Date.now();
  if (redisEnabled) {
    const raw = await redisCommand("EVAL", MUTATE_SESSION, "1", sessionKey(id), action, String(now), token, JSON.stringify(event));
    return JSON.parse(raw);
  }
  // No await between reading and mutating: same atomic operation for local dev.
  const session = memorySessions.get(id);
  if (!session) return { status: "session_missing" };
  if (session.expiresAt <= now) return { status: "session_expired" };
  if (action === "attach") {
    if (session.codeExpiresAt <= now) return { status: "code_expired" };
    session.browserToken ||= token;
  } else {
    if (!session.browserToken) return { status: "attachment_missing" };
    if (session.browserToken !== token) return { status: "token_invalid" };
    const field = event.partial ? "lastPartialAt" : "lastPostAt";
    if (now - (session[field] || 0) < 250) return { status: "rate_limited" };
    session[field] = now;
    session.cursor += 1;
    session.events.push({ ...event, cursor: session.cursor });
    if (session.events.length > 40) session.events.splice(0, session.events.length - 40);
  }
  return { status: "ok", session };
}

export function attachSession(id, token) { return mutateSession(id, "attach", token); }
export function appendTranscript(id, token, event) { return mutateSession(id, "append", token, event); }
