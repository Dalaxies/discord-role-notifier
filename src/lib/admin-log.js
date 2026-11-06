import { logger } from '../logger.js';
import { checkLogChannelPermissions, resolveLogChannel } from './channel.js';

/**
 * Posts an embed to the configured admin channel. Channel problems are logged
 * but never thrown, so they cannot affect the action being audited.
 *
 * @returns {Promise<boolean>} true when the entry was delivered
 */
export async function postAdminLog(guild, logChannelId, embed) {
  if (!logChannelId) return false;

  try {
    const channel = await resolveLogChannel(guild, logChannelId);
    if (!channel) return false;

    const issues = checkLogChannelPermissions(channel, guild.members.me);

    if (issues.length > 0) {
      logger.error(`Cannot post in admin log #${channel.name}: missing ${issues.join(', ')}.`);
      return false;
    }

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    logger.info(`Admin log posted in #${channel.name} (${channel.id}).`);
    return true;
  } catch (error) {
    logger.error(`Failed to post admin log: ${error.message}`);
    return false;
  }
}
