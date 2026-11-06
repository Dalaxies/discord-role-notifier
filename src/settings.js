import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from './logger.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const DEFAULT_FILE = 'data/settings.json';

let state = null;

function settingsFile() {
  return resolve(process.cwd(), process.env.SETTINGS_FILE ?? DEFAULT_FILE);
}

function persist() {
  const file = settingsFile();
  const temporary = `${file}.tmp`;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

/**
 * Loads dashboard-managed settings, falling back to the .env values.
 * Call once at startup.
 */
export function loadSettings(fallbackRoleId, fallbackLogChannelId = '', fallbackOnboardingChannelId = '') {
  if (state) return state;

  const file = settingsFile();
  let stored = {};

  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      logger.warn(`Could not read ${file}: ${error.message}. Falling back to .env settings.`);
    }
  }

  const roleId =
    typeof stored.roleId === 'string' && SNOWFLAKE_RE.test(stored.roleId)
      ? stored.roleId
      : fallbackRoleId;

  const logChannelId =
    typeof stored.logChannelId === 'string' &&
    (stored.logChannelId === '' || SNOWFLAKE_RE.test(stored.logChannelId))
      ? stored.logChannelId
      : fallbackLogChannelId;

  const onboardingChannelId =
    typeof stored.onboardingChannelId === 'string' &&
    (stored.onboardingChannelId === '' || SNOWFLAKE_RE.test(stored.onboardingChannelId))
      ? stored.onboardingChannelId
      : fallbackOnboardingChannelId;

  state = {
    roleId,
    logChannelId,
    onboardingChannelId,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
  };

  return state;
}

export function getSettings() {
  if (!state) throw new Error('Settings were not loaded. Call loadSettings() first.');
  return state;
}

/**
 * Persists a change made from the dashboard and applies it to the running bot
 * immediately (the role is read from here for every event).
 */
export function updateSettings(patch, { actor = 'dashboard' } = {}) {
  const current = getSettings();
  const next = { ...current };

  if (patch.roleId !== undefined) {
    const roleId = String(patch.roleId).trim();
    if (!SNOWFLAKE_RE.test(roleId)) {
      throw new Error('Role ID must be a Discord role ID (17-20 digits).');
    }
    next.roleId = roleId;
  }

  if (patch.logChannelId !== undefined) {
    const logChannelId = String(patch.logChannelId).trim();
    if (!SNOWFLAKE_RE.test(logChannelId)) {
      throw new Error('Log channel ID must be a Discord channel ID (17-20 digits).');
    }
    next.logChannelId = logChannelId;
  }

  if (patch.onboardingChannelId !== undefined) {
    const onboardingChannelId = String(patch.onboardingChannelId).trim();
    if (onboardingChannelId !== '' && !SNOWFLAKE_RE.test(onboardingChannelId)) {
      throw new Error('Onboarding channel ID must be a Discord channel ID (17-20 digits) or empty.');
    }
    next.onboardingChannelId = onboardingChannelId;
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = actor;

  state = next;
  persist();

  return state;
}
