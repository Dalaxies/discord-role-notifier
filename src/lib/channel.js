import { ChannelType, PermissionFlagsBits } from 'discord.js';

const REQUIRED_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
];

const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/**
 * Returns the channel configured in CHANNEL_ID, or the server's system channel
 * when CHANNEL_ID is empty.
 */
export async function resolveNotificationChannel(guild, channelId) {
  if (channelId) {
    const cached = guild.channels.cache.get(channelId);
    const channel = cached ?? (await guild.channels.fetch(channelId).catch(() => null));

    if (!channel) {
      throw new Error(`CHANNEL_ID ${channelId} was not found in "${guild.name}".`);
    }

    if (!TEXT_CHANNEL_TYPES.has(channel.type)) {
      throw new Error(
        `Channel ${channelId} is not a standard text channel. Use a text or announcement channel.`,
      );
    }

    return channel;
  }

  if (guild.systemChannel) return guild.systemChannel;

  throw new Error(
    'CHANNEL_ID is not set and this server has no system channel. Set CHANNEL_ID in .env.',
  );
}

/** Returns a list of human-readable permissions the bot is missing. */
export function checkChannelPermissions(channel, botMember) {
  if (!botMember) return ['bot is not a member of the server'];

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return ['channel permissions could not be calculated'];

  return REQUIRED_PERMISSIONS.filter(([bit]) => !permissions.has(bit)).map(([, name]) => name);
}
