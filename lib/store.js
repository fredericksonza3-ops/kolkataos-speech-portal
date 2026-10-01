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
    try { return JSON.parse(raw); } catch { return null; }
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
