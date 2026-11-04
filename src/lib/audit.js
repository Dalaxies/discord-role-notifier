import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { logger } from '../logger.js';

const CACHE_TTL_MS = 3_000;
const EVENT_WINDOW_MS = 20_000;

/** guildId -> { at, entries } */
const cache = new Map();

async function recentRoleChanges(guild) {
  const cached = cache.get(guild.id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;

  const result = await guild.fetchAuditLogs({
    type: AuditLogEvent.MemberRoleUpdate,
    limit: 10,
  });
  const entries = [...result.entries.values()];

  cache.set(guild.id, { at: Date.now(), entries });
  return entries;
}

function addedRole(entry, roleId) {
  return entry.changes.some(
    (change) =>
      change.key === '$add' &&
      Array.isArray(change.new) &&
      change.new.some((role) => (typeof role === 'string' ? role : role?.id) === roleId),
  );
}

/**
 * Best-effort lookup of who assigned the role. Returns a User or null.
 * Never throws: a missing permission or a rate limit just means "unknown".
 */
export async function findRoleAssignment(guild, memberId, roleId) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

  try {
    const entries = await recentRoleChanges(guild);
    const cutoff = Date.now() - EVENT_WINDOW_MS;

    const match = entries.find(
      (entry) =>
        entry.targetId === memberId &&
        entry.createdTimestamp >= cutoff &&
        addedRole(entry, roleId),
    );

    return match?.executor ?? null;
  } catch (error) {
    logger.debug(`Audit log lookup failed: ${error.message}`);
    return null;
  }
}
