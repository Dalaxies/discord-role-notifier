import { ChannelType, PermissionFlagsBits } from 'discord.js';

// Log entries are embeds, so the bot needs Embed Links as well as Send Messages.
const LOG_CHANNEL_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
];

const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/**
 * Returns the channel the bot posts its admin log to, or null when logging is
 * disabled (LOG_CHANNEL_ID was emptied).
 */
export async function resolveLogChannel(guild, channelId) {
  if (!channelId) return null;

  const cached = guild.channels.cache.get(channelId);
  const channel = cached ?? (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel) {
    throw new Error(`LOG_CHANNEL_ID ${channelId} was not found in "${guild.name}".`);
  }

  if (!TEXT_CHANNEL_TYPES.has(channel.type)) {
    throw new Error(
      `Channel ${channelId} is not a standard text channel. Use a text or announcement channel.`,
    );
  }

  return channel;
}

/** Returns a list of human-readable permissions the bot is missing. */
export function checkLogChannelPermissions(channel, botMember) {
  if (!botMember) return ['bot is not a member of the server'];

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return ['channel permissions could not be calculated'];

  return LOG_CHANNEL_PERMISSIONS.filter(([bit]) => !permissions.has(bit)).map(([, name]) => name);
}
