import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SNOWFLAKE_RE = /^\d{17,20}$/;

const DEFAULT_GUILD_ID = '1499114258007588914';
const DEFAULT_ROLE_ID = '1555015410112270458';
const DEFAULT_LOG_CHANNEL_ID = '1499140628817379459';
const DEFAULT_TEMPLATE_FILE = 'templates/welcome.md';
const DEFAULT_DM_TEMPLATE = 'You were assigned the **{role}** role in **{server}**.';
const DEFAULT_EMBED_COLOR = 0x57f287;

function envText(name) {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

function envOr(name, fallback) {
  const value = envText(name);
  return value === undefined || value === '' ? fallback : value;
}

function parseBoolean(errors, name, fallback) {
  const value = envText(name);
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;

  errors.push(`${name} must be true or false (got "${value}").`);
  return fallback;
}

function parseColor(errors, name, fallback) {
  const value = envText(name);
  if (!value) return fallback;

  const hex = value.replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    errors.push(`${name} must be a hex colour such as #57F287 (got "${value}").`);
    return fallback;
  }

  return Number.parseInt(hex, 16);
}

function parseInteger(errors, name, fallback, min, max) {
  const value = envText(name);
  if (value === undefined || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${name} must be a whole number between ${min} and ${max} (got "${value}").`);
    return fallback;
  }

  return parsed;
}

/**
 * Reads and validates configuration from the environment / .env file.
 * Throws a single, readable error listing every problem it found.
 */
export function loadConfig() {
  const errors = [];

  // Discord occasionally shows tokens wrapped in quotes in the portal; strip those.
  const token = (envText('DISCORD_TOKEN') ?? '').replace(/^["']|["']$/g, '');
  if (!token) {
    errors.push(
      'DISCORD_TOKEN is missing. Copy it from the Discord Developer Portal (Bot -> Reset Token).',
    );
  } else if (/\s/.test(token)) {
    errors.push('DISCORD_TOKEN contains whitespace. Paste it again without line breaks or quotes.');
  }

  const guildId = envOr('GUILD_ID', DEFAULT_GUILD_ID);
  if (!SNOWFLAKE_RE.test(guildId)) {
    errors.push(`GUILD_ID must be a Discord server ID (17-20 digits), got "${guildId}".`);
  }

  const roleId = envOr('ROLE_ID', DEFAULT_ROLE_ID);
  if (!SNOWFLAKE_RE.test(roleId)) {
    errors.push(`ROLE_ID must be a Discord role ID (17-20 digits), got "${roleId}".`);
  }

  const logChannelId = envText('LOG_CHANNEL_ID') ?? DEFAULT_LOG_CHANNEL_ID;
  if (logChannelId !== '' && !SNOWFLAKE_RE.test(logChannelId)) {
    errors.push(`LOG_CHANNEL_ID must be a channel ID (17-20 digits) or empty, got "${logChannelId}".`);
  }

  const embedEnabled = parseBoolean(errors, 'EMBED_ENABLED', true);

  // Message precedence: MESSAGE_TEMPLATE_FILE > MESSAGE_TEMPLATE > bundled file.
  // The bundled templates/welcome.md is the default, so a fresh install sends
  // the full welcome message with no configuration.
  const configuredFile = envText('MESSAGE_TEMPLATE_FILE') ?? '';
  const rawTemplate = process.env.MESSAGE_TEMPLATE;

  // An explicit MESSAGE_TEMPLATE (including an empty one, which means "embed
  // only") opts out of the bundled file, matching the documented precedence.
  const templateFile =
    configuredFile !== '' ? configuredFile : rawTemplate !== undefined ? '' : DEFAULT_TEMPLATE_FILE;

  let fileTemplate;

  if (templateFile) {
    const absolute = resolve(process.cwd(), templateFile);
    try {
      fileTemplate = readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '');
    } catch (error) {
      // A missing file that was named explicitly is a configuration mistake;
      // a missing bundled default just means fall back to the built-in text.
      if (configuredFile !== '') {
        errors.push(`MESSAGE_TEMPLATE_FILE could not be read (${absolute}): ${error.message}`);
      }
    }
  }

  const defaultTemplate = DEFAULT_DM_TEMPLATE;

  let messageTemplate;
  if (fileTemplate !== undefined) {
    messageTemplate = fileTemplate.trim();
  } else if (rawTemplate !== undefined) {
    messageTemplate = rawTemplate.trim();
  } else {
    messageTemplate = defaultTemplate;
  }

  // Discord's hard limit for message content is 2000 characters.
  if (messageTemplate.length > 2000) {
    errors.push(
      `The message template is ${messageTemplate.length} characters; Discord allows at most 2000.`,
    );
  }

  if (messageTemplate.length === 0 && !embedEnabled) {
    errors.push('The message template is empty and EMBED_ENABLED=false, so nothing would be sent.');
  }

  const embedTitle = envOr('EMBED_TITLE', 'Role assigned');
  if (embedTitle.length > 256) {
    errors.push('EMBED_TITLE must be 256 characters or fewer.');
  }

  // Web dashboard -----------------------------------------------------------
  const webEnabled = parseBoolean(errors, 'WEB_ENABLED', false);
  const webHost = envOr('WEB_HOST', '127.0.0.1');
  const webPort = parseInteger(errors, 'WEB_PORT', 3000, 1, 65535);

  const webClientId = envText('DISCORD_CLIENT_ID') ?? '';
  if (webClientId !== '' && !SNOWFLAKE_RE.test(webClientId)) {
    errors.push(`DISCORD_CLIENT_ID must be a Discord application ID (17-20 digits), got "${webClientId}".`);
  }

  const webClientSecret = (envText('DISCORD_CLIENT_SECRET') ?? '').replace(/^["']|["']$/g, '');
  if (/\s/.test(webClientSecret)) {
    errors.push('DISCORD_CLIENT_SECRET contains whitespace. Paste it again without line breaks.');
  }

  const redirectUri = envOr('OAUTH_REDIRECT_URI', `http://localhost:${webPort}/auth/callback`);
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    errors.push(`OAUTH_REDIRECT_URI must be a valid http(s) URL, got "${redirectUri}".`);
  }

  const adminIds = (envText('WEB_ADMIN_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  for (const id of adminIds) {
    if (!SNOWFLAKE_RE.test(id)) {
      errors.push(`WEB_ADMIN_IDS contains an invalid user ID: "${id}".`);
    }
  }

  const config = {
    token,
    guildId,
    roleId,
    logChannelId,
    messageTemplate,
    messageTemplateFile: fileTemplate === undefined ? null : templateFile,
    embedEnabled,
    embedTitle,
    embedColor: parseColor(errors, 'EMBED_COLOR', DEFAULT_EMBED_COLOR),
    ignoreBots: parseBoolean(errors, 'IGNORE_BOTS', true),
    lookupAuditLog: parseBoolean(errors, 'LOOKUP_AUDIT_LOG', true),
    dryRun: parseBoolean(errors, 'DRY_RUN', false),
    web: {
      enabled: webEnabled,
      host: webHost,
      port: webPort,
      clientId: webClientId,
      clientSecret: webClientSecret,
      redirectUri,
      sessionTtlHours: parseInteger(errors, 'SESSION_TTL_HOURS', 12, 1, 168),
      adminIds,
      cookieSecure: parseBoolean(errors, 'WEB_COOKIE_SECURE', false),
    },
  };

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map((line) => `  - ${line}`).join('\n')}`);
  }

  return Object.freeze(config);
}

export const DEFAULTS = Object.freeze({
  guildId: DEFAULT_GUILD_ID,
  roleId: DEFAULT_ROLE_ID,
  logChannelId: DEFAULT_LOG_CHANNEL_ID,
  dmTemplate: DEFAULT_DM_TEMPLATE,
  embedColor: DEFAULT_EMBED_COLOR,
});
