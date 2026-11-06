import { ChannelType, PermissionFlagsBits } from 'discord.js';

// Log entries are embeds, so the bot needs Embed Links as well as Send Messages.
const LOG_CHANNEL_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
];

// The onboarding prompt is an embed with buttons. Reacting to the original
// message needs Add Reactions, and fetching it after a restart needs Read
// Message History.
const ONBOARDING_CHANNEL_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
  [PermissionFlagsBits.AddReactions, 'Add Reactions'],
];

const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

async function resolveTextChannel(guild, channelId, label) {
  const cached = guild.channels.cache.get(channelId);
  const channel = cached ?? (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel) {
    throw new Error(`${label} ${channelId} was not found in "${guild.name}".`);
  }

  if (!TEXT_CHANNEL_TYPES.has(channel.type)) {
    throw new Error(
      `Channel ${channelId} is not a standard text channel. Use a text or announcement channel.`,
    );
  }

  return channel;
}

/**
 * Returns the channel the bot posts its admin log to, or null when logging is
 * disabled (LOG_CHANNEL_ID was emptied).
 */
export async function resolveLogChannel(guild, channelId) {
  if (!channelId) return null;
  return resolveTextChannel(guild, channelId, 'LOG_CHANNEL_ID');
}

/**
 * Returns the channel where onboarding review prompts are posted, or null when
 * onboarding approvals are disabled.
 */
export async function resolveOnboardingChannel(guild, channelId) {
  if (!channelId) return null;
  return resolveTextChannel(guild, channelId, 'ONBOARDING_CHANNEL_ID');
}

function missingPermissions(channel, botMember, required) {
  if (!botMember) return ['bot is not a member of the server'];

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return ['channel permissions could not be calculated'];

  return required.filter(([bit]) => !permissions.has(bit)).map(([, name]) => name);
}

/** Returns a list of human-readable permissions the bot is missing. */
export function checkLogChannelPermissions(channel, botMember) {
  return missingPermissions(channel, botMember, LOG_CHANNEL_PERMISSIONS);
}

/** Returns a list of human-readable permissions the bot is missing. */
export function checkOnboardingChannelPermissions(channel, botMember) {
  return missingPermissions(channel, botMember, ONBOARDING_CHANNEL_PERMISSIONS);
}
