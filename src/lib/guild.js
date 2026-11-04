import { Events } from 'discord.js';

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Returns the bot's guild object once its data has actually arrived.
 *
 * Right after READY, Discord lists the bot's guilds as "unavailable"
 * placeholders and sends the real GUILD_CREATE payload afterwards. During that
 * window `client.guilds.fetch(id)` returns the empty placeholder from cache
 * instead of calling the API, so `guild.name` is undefined and the channel and
 * role caches are empty.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<import('discord.js').Guild|null>}
 */
export async function waitForGuild(client, guildId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cached = () => client.guilds.cache.get(guildId);

  if (cached()?.available) return cached();

  const fromGateway = await new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.off(Events.GuildAvailable, onAvailable);
      client.off(Events.GuildCreate, onAvailable);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    function onAvailable(guild) {
      if (guild.id !== guildId || !guild.available) return;
      cleanup();
      resolve(guild);
    }

    client.on(Events.GuildAvailable, onAvailable);
    client.on(Events.GuildCreate, onAvailable);

    // The event can fire between the cache check above and attaching the listener.
    if (cached()?.available) onAvailable(cached());
  });

  if (fromGateway) return fromGateway;

  // Still unavailable: the bot is probably not a member, or the gateway is
  // slow. Ask the REST API so callers get something usable either way.
  return client.guilds.fetch({ guild: guildId, force: true }).catch(() => null);
}

/**
 * The bot's own member object, which carries its guild-level permissions.
 * `guild.members.me` is only populated from GUILD_CREATE, so it can be missing
 * if the guild data was fetched over REST.
 *
 * @param {import('discord.js').Guild} guild
 */
export async function resolveBotMember(guild) {
  return guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
}
