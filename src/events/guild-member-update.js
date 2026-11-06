import { EmbedBuilder } from 'discord.js';
import { logger } from '../logger.js';
import { renderTemplate } from '../lib/template.js';
import { readMessageTemplate } from '../lib/message.js';
import { checkLogChannelPermissions, resolveLogChannel } from '../lib/channel.js';
import { findRoleAssignment } from '../lib/audit.js';

const DEDUPE_WINDOW_MS = 15_000;
const recentNotifications = new Map();

function isDuplicate(key) {
  const now = Date.now();

  for (const [entryKey, timestamp] of recentNotifications) {
    if (now - timestamp > DEDUPE_WINDOW_MS) recentNotifications.delete(entryKey);
  }

  if (recentNotifications.has(key)) return true;
  recentNotifications.set(key, now);
  return false;
}

function unix(date) {
  return Math.floor(date.getTime() / 1000);
}

async function sendDirectMessage(member, content, embed) {
  try {
    await member.send({
      content: content || undefined,
      embeds: embed ? [embed] : [],
      allowedMentions: { parse: [] },
    });
    logger.info(`DM sent to ${member.user.username} (${member.id}).`);
    return { ok: true };
  } catch (error) {
    // 50007 = Cannot send messages to this user (DMs disabled / no shared server).
    if (error.code === 50007) {
      const reason = 'they do not accept direct messages from server members';
      logger.warn(`Could not DM ${member.user.username} (${member.id}): ${reason}.`);
      return { ok: false, reason };
    }

    logger.error(`Failed to DM ${member.user.username} (${member.id}): ${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/**
 * Posts a short audit entry to the configured admin channel. Channel problems
 * are logged but never allowed to affect the DM, which has already been sent.
 */
async function postAdminLog(guild, config, content) {
  if (!config.logChannelId) return;

  try {
    const channel = await resolveLogChannel(guild, config.logChannelId);
    const issues = checkLogChannelPermissions(channel, guild.members.me);

    if (issues.length > 0) {
      logger.error(`Cannot post in admin log #${channel.name}: missing ${issues.join(', ')}.`);
      return;
    }

    await channel.send({
      content: content.slice(0, 2000),
      allowedMentions: { parse: [] },
    });
    logger.info(`Admin log posted in #${channel.name} (${channel.id}).`);
  } catch (error) {
    logger.error(`Failed to post admin log: ${error.message}`);
  }
}

function describeOutcome(member, roleId, roleName, assignedBy, dm) {
  const who = `${member.user.username} (${member.id})`;
  const role = roleName ? `"${roleName}" (<@&${roleId}>)` : `<@&${roleId}>`;
  const assigner = assignedBy ? `<@${assignedBy.id}>` : 'Unknown';

  if (dm.ok) {
    return `\u2705 Welcome DM sent to **${who}** for role ${role}. Assigned by ${assigner}.`;
  }

  return `\u26a0\ufe0f Welcome DM **failed** for **${who}** (role ${role}): ${dm.reason}. Assigned by ${assigner}.`;
}

export function createGuildMemberUpdateHandler(configOrGetter) {
  const getConfig =
    typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter;

  return async function handleGuildMemberUpdate(oldMember, newMember) {
    const config = getConfig();

    try {
      if (newMember.guild.id !== config.guildId) return;

      const hadRole = oldMember.roles.cache.has(config.roleId);
      const hasRole = newMember.roles.cache.has(config.roleId);

      // We only care about the moment the role is newly added.
      if (hadRole || !hasRole) return;

      if (config.ignoreBots && newMember.user.bot) {
        logger.debug(`Skipping bot account ${newMember.user.username} (${newMember.id}).`);
        return;
      }

      if (isDuplicate(`${newMember.guild.id}:${newMember.id}`)) {
        logger.debug(`Skipping duplicate guildMemberUpdate for ${newMember.id}.`);
        return;
      }

      logger.info(
        `Role ${config.roleId} assigned to ${newMember.user.username} (${newMember.id}) in "${newMember.guild.name}".`,
      );

      const guild = newMember.guild;

      const role =
        guild.roles.cache.get(config.roleId) ?? (await guild.roles.fetch(config.roleId).catch(() => null));
      const assignedBy = config.lookupAuditLog
        ? await findRoleAssignment(guild, newMember.id, config.roleId)
        : null;

      const values = {
        user: `<@${newMember.id}>`,
        username: newMember.user.username,
        displayName: newMember.displayName,
        server: guild.name,
        role: `<@&${config.roleId}>`,
        roleName: role?.name ?? config.roleId,
        memberCount: guild.memberCount,
        assignedBy: assignedBy ? `<@${assignedBy.id}>` : 'Unknown',
        userId: newMember.id,
      };

      const content = renderTemplate(readMessageTemplate(config), values);

      let embed = null;

      if (config.embedEnabled) {
        embed = new EmbedBuilder()
          .setColor(config.embedColor)
          .setAuthor({
            name: newMember.user.username,
            iconURL: newMember.displayAvatarURL(),
          })
          .setTitle(config.embedTitle)
          .setThumbnail(newMember.displayAvatarURL())
          .setFooter({ text: `User ID: ${newMember.id}` })
          .setTimestamp();

        embed.addFields({
          name: 'Role',
          value: role ? `${role}` : `<@&${config.roleId}>`,
          inline: true,
        });

        if (assignedBy) {
          embed.addFields({ name: 'Assigned by', value: `${assignedBy}`, inline: true });
        }

        embed.addFields(
          {
            name: 'Account created',
            value: `<t:${unix(newMember.user.createdAt)}:R>`,
            inline: true,
          },
          {
            name: 'Joined server',
            value: newMember.joinedAt ? `<t:${unix(newMember.joinedAt)}:R>` : 'Unknown',
            inline: true,
          },
        );
      }

      if (!content && !embed) {
        logger.error('Nothing to send: the message template is empty and the embed is disabled.');
        return;
      }

      if (config.dryRun) {
        const logTarget = config.logChannelId ? ` and log to channel ${config.logChannelId}` : '';
        logger.warn(
          `[DRY_RUN] Would DM ${newMember.user.username} (${newMember.id})${logTarget}: ${content || '(embed only)'}`,
        );
        return;
      }

      const dm = await sendDirectMessage(newMember, content, embed);
      await postAdminLog(
        guild,
        config,
        describeOutcome(newMember, config.roleId, role?.name, assignedBy, dm),
      );
    } catch (error) {
      logger.error(`Failed to handle role assignment: ${error.message}`, error);
    }
  };
}
