import { randomBytes } from 'node:crypto';

const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20n;
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_COOKIE = 'ascend_session';
const STATE_COOKIE = 'ascend_oauth_state';

const sessions = new Map();
const pendingStates = new Map();

/** Login is possible once a client secret is configured. */
export function isLoginConfigured(web) {
  return Boolean(web.clientSecret);
}

function pruneStates() {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(state);
  }
}

/**
 * Builds the Discord authorize URL and remembers the state value so the
 * callback can reject forged logins.
 */
export function createLogin(web, clientId) {
  pruneStates();

  const state = randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: web.redirectUri,
    scope: 'identify guilds',
    state,
    prompt: 'none',
  });

  return { state, url: `https://discord.com/oauth2/authorize?${params.toString()}` };
}

export function consumeState(state) {
  if (typeof state !== 'string' || state === '') return false;

  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);

  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

/** True when the user may manage the watched server. */
export function isGuildAdmin(guilds, guildId, adminIds, userId) {
  if (Array.isArray(adminIds) && adminIds.includes(userId)) return true;

  const guild = guilds.find((entry) => entry.id === guildId);
  if (!guild) return false;
  if (guild.owner) return true;

  try {
    return (BigInt(guild.permissions ?? '0') & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

async function discordJson(path, accessToken) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Discord API ${path} returned ${response.status}.`);
  }

  return response.json();
}

/** Exchanges the OAuth2 code for an access token. */
export async function exchangeCode(web, clientId, code) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: web.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: web.redirectUri,
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Discord rejected the login (${response.status}). Check the client secret and redirect URI. ${detail.slice(0, 200)}`.trim(),
    );
  }

  const data = await response.json();
  if (!data.access_token) throw new Error('Discord did not return an access token.');

  return data.access_token;
}

/** Fetches the signed-in user and their guild list. */
export async function fetchIdentity(accessToken) {
  const [user, guilds] = await Promise.all([
    discordJson('/users/@me', accessToken),
    discordJson('/users/@me/guilds', accessToken),
  ]);

  return { user, guilds };
}

export function createSession({ user, guilds }, ttlMs) {
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();

  for (const [key, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(key);
  }

  sessions.set(id, {
    id,
    user,
    guilds,
    csrf: randomBytes(16).toString('hex'),
    createdAt: now,
    expiresAt: now + ttlMs,
  });

  return id;
}

export function getSession(id) {
  if (typeof id !== 'string' || id === '') return null;

  const session = sessions.get(id);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }

  return session;
}

export function destroySession(id) {
  if (typeof id === 'string') sessions.delete(id);
}

export function sessionCookie(id, maxAgeSeconds, secure) {
  return [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearSessionCookie(secure) {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export function stateCookie(state, secure) {
  return [
    `${STATE_COOKIE}=${state}`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(STATE_TTL_MS / 1000)}`,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearStateCookie(secure) {
  return [
    `${STATE_COOKIE}=`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return null;

  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }

  return null;
}

export function readSessionId(req) {
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

export function readStateCookie(req) {
  return readCookie(req.headers.cookie, STATE_COOKIE);
}
