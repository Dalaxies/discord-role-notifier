import { createServer } from 'node:http';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger, getRecentLogs, subscribeLogs } from '../logger.js';
import { readMessageTemplate } from '../lib/message.js';
import { getSettings, updateSettings } from '../settings.js';
import * as auth from './auth.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const MESSAGE_LIMIT = 2000;
const MAX_BODY_BYTES = 64 * 1024;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' https://cdn.discordapp.com data:",
      "connect-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function redirect(res, location, cookies = []) {
  const headers = { location, 'cache-control': 'no-store' };
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function isSecure(req, web) {
  return Boolean(web.cookieSecure) || req.headers['x-forwarded-proto'] === 'https';
}

function currentSession(req) {
  return auth.getSession(auth.readSessionId(req));
}

function requireSession(req) {
  const session = currentSession(req);
  if (!session) throw new HttpError(401, 'Sign in with Discord to continue.');
  return session;
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;

  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Invalid request origin.');
  }

  if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
}

function assertCsrf(req, session) {
  assertSameOrigin(req);

  const token = req.headers['x-csrf-token'];
  if (typeof token !== 'string' || token !== session.csrf) {
    throw new HttpError(403, 'Invalid CSRF token. Reload the page and try again.');
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function avatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  }

  const index = Number(BigInt(user.id) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.global_name || user.username,
    avatarUrl: avatarUrl(user),
  };
}

async function serveStatic(res, path) {
  const [file, type] = STATIC_FILES.get(path);

  try {
    const data = await readFile(resolve(WEB_ROOT, file));
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    throw new HttpError(404, 'Not found.');
  }
}

function handleLogStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  res.write('retry: 3000\n\n');

  const unsubscribe = subscribeLogs((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };

  req.on('close', close);
  res.on('close', close);
}

async function handleLogin(req, res, options) {
  const web = options.config.web;

  if (!auth.isLoginConfigured(web)) {
    return redirect(res, '/?error=not_configured');
  }

  const clientId = web.clientId || options.getClient()?.user?.id;
  if (!clientId) return redirect(res, '/?error=not_configured');

  const { state, url } = auth.createLogin(web, clientId);
  return redirect(res, url, [auth.stateCookie(state, isSecure(req, web))]);
}

async function handleCallback(req, res, options, url) {
  const web = options.config.web;
  const secure = isSecure(req, web);
  const cookies = [auth.clearStateCookie(secure)];

  const denied = url.searchParams.get('error');
  if (denied) return redirect(res, `/?error=${encodeURIComponent(denied)}`, cookies);

  const state = url.searchParams.get('state');
  const cookieState = auth.readStateCookie(req);

  // The cookie binds the state to this browser, so a stolen code cannot be
  // replayed from elsewhere.
  if (!state || !cookieState || state !== cookieState || !auth.consumeState(state)) {
    return redirect(res, '/?error=state', cookies);
  }

  const code = url.searchParams.get('code');
  if (!code) return redirect(res, '/?error=access_denied', cookies);

  try {
    const clientId = web.clientId || options.getClient()?.user?.id;
    const token = await auth.exchangeCode(web, clientId, code);
    const { user, guilds } = await auth.fetchIdentity(token);

    if (!auth.isGuildAdmin(guilds, options.config.guildId, web.adminIds, user.id)) {
      logger.warn(
        `Dashboard login denied for ${user.username} (${user.id}): no Manage Server permission.`,
      );
      return redirect(res, '/?error=not_admin', cookies);
    }

    const ttlMs = web.sessionTtlHours * 3600 * 1000;
    const id = auth.createSession({ user, guilds }, ttlMs);
    cookies.push(auth.sessionCookie(id, web.sessionTtlHours * 3600, secure));

    logger.info(`Dashboard login: ${user.username} (${user.id}).`);
    return redirect(res, '/', cookies);
  } catch (error) {
    logger.error(`Dashboard login failed: ${error.message}`);
    return redirect(res, '/?error=login_failed', cookies);
  }
}

async function handleLogout(req, res, options) {
  const session = currentSession(req);

  if (session) {
    assertCsrf(req, session);
    auth.destroySession(session.id);
    logger.info(`Dashboard logout: ${session.user.username} (${session.user.id}).`);
  }

  res.writeHead(204, {
    'set-cookie': auth.clearSessionCookie(isSecure(req, options.config.web)),
    'cache-control': 'no-store',
  });
  res.end();
}

function sessionPayload(session, options) {
  const client = options.getClient();
  const guild = options.getGuild();

  return {
    configured: auth.isLoginConfigured(options.config.web),
    authenticated: Boolean(session),
    csrf: session?.csrf ?? null,
    user: session ? publicUser(session.user) : null,
    bot: session && client?.user ? { tag: client.user.tag, id: client.user.id } : null,
    guild: session && guild ? { id: guild.id, name: guild.name } : null,
  };
}

async function statePayload(options) {
  const guild = options.getGuild();
  const settings = getSettings();
  const role = guild?.roles.cache.get(settings.roleId) ?? null;

  const roles = guild
    ? [...guild.roles.cache.values()]
        .filter((entry) => entry.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          managed: entry.managed,
          color: entry.hexColor,
        }))
    : [];

  return {
    role: { id: settings.roleId, name: role?.name ?? null },
    roles,
    message: readMessageTemplate(options.config),
    messageFile: options.config.messageTemplateFile,
    messageLimit: MESSAGE_LIMIT,
    delivery: options.config.delivery,
    embedEnabled: options.config.embedEnabled,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    guild: guild ? { id: guild.id, name: guild.name, memberCount: guild.memberCount } : null,
  };
}

async function updateRole(req, res, options, session) {
  assertCsrf(req, session);

  const body = await readJson(req);
  const roleId = String(body.roleId ?? '').trim();

  if (!roleId) throw new HttpError(400, 'Pick a role first.');

  const guild = options.getGuild();
  if (!guild) throw new HttpError(503, 'The bot is not connected to the server yet.');

  const role =
    guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));

  if (!role) throw new HttpError(400, 'That role does not exist in this server.');
  if (role.id === guild.id) throw new HttpError(400, 'Pick a role other than @everyone.');
  if (role.managed) {
    throw new HttpError(400, 'That role is managed by a Discord integration and cannot be assigned by hand.');
  }

  updateSettings({ roleId: role.id }, { actor: session.user.username });
  logger.info(`Welcome role changed to "${role.name}" (${role.id}) by ${session.user.username}.`);

  sendJson(res, 200, { ok: true, role: { id: role.id, name: role.name } });
}

async function updateMessage(req, res, options, session) {
  assertCsrf(req, session);

  if (!options.config.messageTemplateFile) {
    throw new HttpError(
      400,
      'Set MESSAGE_TEMPLATE_FILE in .env first, then restart the bot once. Editing here writes to that file.',
    );
  }

  const body = await readJson(req);
  if (typeof body.message !== 'string') throw new HttpError(400, 'Message must be text.');

  const message = body.message.replace(/\r\n/g, '\n').trim();

  if (message.length === 0) throw new HttpError(400, 'The message cannot be empty.');
  if (message.length > MESSAGE_LIMIT) {
    throw new HttpError(400, `The message is ${message.length} characters; the limit is ${MESSAGE_LIMIT}.`);
  }

  const file = resolve(process.cwd(), options.config.messageTemplateFile);
  const temporary = `${file}.tmp`;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, `${message}\n`, 'utf8');
  renameSync(temporary, file);

  logger.info(`Welcome message updated by ${session.user.username} (${message.length} characters).`);

  sendJson(res, 200, { ok: true, length: message.length });
}

async function handleApi(req, res, options, url, path) {
  const session = currentSession(req);

  if (path === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, sessionPayload(session, options));
  }

  if (!session) throw new HttpError(401, 'Sign in with Discord to continue.');

  if (path === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, await statePayload(options));
  }

  if (path === '/api/role' && req.method === 'PUT') {
    return updateRole(req, res, options, session);
  }

  if (path === '/api/message' && req.method === 'PUT') {
    return updateMessage(req, res, options, session);
  }

  if (path === '/api/logs' && req.method === 'GET') {
    const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
    const entries = getRecentLogs({
      since: Number.isFinite(since) ? since : 0,
      limit: Number.isFinite(limit) ? limit : 200,
    });

    return sendJson(res, 200, {
      entries,
      lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : since,
    });
  }

  if (path === '/api/logs/stream' && req.method === 'GET') {
    return handleLogStream(req, res);
  }

  throw new HttpError(404, 'Not found.');
}

async function route(req, res, options) {
  securityHeaders(res);

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && STATIC_FILES.has(path)) return serveStatic(res, path);
  if (req.method === 'GET' && path === '/auth/login') return handleLogin(req, res, options);
  if (req.method === 'GET' && path === '/auth/callback') return handleCallback(req, res, options, url);
  if (req.method === 'POST' && path === '/auth/logout') return handleLogout(req, res, options);
  if (path.startsWith('/api/')) return handleApi(req, res, options, url, path);

  throw new HttpError(404, 'Not found.');
}

export function createWebServer(options) {
  return createServer((req, res) => {
    route(req, res, options).catch((error) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendJson(res, error.status, { error: error.message });
        else res.end();
        return;
      }

      logger.error(`Web request failed: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
      else res.end();
    });
  });
}

/** Starts the dashboard. Returns the listening http.Server. */
export async function startWebServer(options) {
  const { host, port } = options.config.web;
  const server = createWebServer(options);

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });

  logger.info(`Dashboard listening on http://${host}:${port}`);

  if (!auth.isLoginConfigured(options.config.web)) {
    logger.warn(
      'Dashboard login is disabled: set DISCORD_CLIENT_SECRET in .env (Developer Portal -> OAuth2 -> Client Secret).',
    );
  }

  if (host === '127.0.0.1' || host === 'localhost') {
    logger.info('Dashboard is local-only. Reach it with: ssh -L 3000:localhost:3000 <user>@<server>');
  }

  return server;
}
