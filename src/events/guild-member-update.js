import { EmbedBuilder } from 'discord.js';
import { logger } from '../logger.js';
import { renderTemplate } from '../lib/template.js';
import { readMessageTemplate } from '../lib/message.js';
import { checkChannelPermissions, resolveNotificationChannel } from '../lib/channel.js';
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
  } catch (error) {
    // 50007 = Cannot send messages to this user (DMs disabled / no shared server).
    if (error.code === 50007) {
      logger.warn(
        `Could not DM ${member.user.username} (${member.id}): they do not accept direct messages from server members.`,
      );
    } else {
      logger.error(`Failed to DM ${member.user.username} (${member.id}): ${error.message}`);
    }
  }
}

async function sendChannelMessage(channel, member, content, embed, config) {
  try {
    await channel.send({
      content: content || undefined,
      embeds: embed ? [embed] : [],
      allowedMentions: {
        parse: [],
        users: config.mentionMember ? [member.id] : [],
      },
    });
    logger.info(`Channel notification sent to #${channel.name} (${channel.id}).`);
  } catch (error) {
    logger.error(`Failed to post in #${channel.name} (${channel.id}): ${error.message}`);
  }
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
      const wantsDm = config.delivery === 'dm' || config.delivery === 'both';
      const wantsChannel = config.delivery === 'channel' || config.delivery === 'both';

      // Resolve the channel up front, but never let a channel problem block the DM.
      let channel = null;
      if (wantsChannel) {
        try {
          channel = await resolveNotificationChannel(guild, config.channelId);
          const issues = checkChannelPermissions(channel, guild.members.me);

          if (issues.length > 0) {
            logger.error(`Cannot post in #${channel.name}: missing ${issues.join(', ')}.`);
            channel = null;
          }
        } catch (error) {
          logger.error(error.message);
          channel = null;
        }
      }

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

        // In a DM the "Member" field would just repeat the recipient.
        if (wantsChannel) {
          embed.addFields({
            name: 'Member',
            value: `${newMember} (${newMember.user.username})`,
            inline: true,
          });
        }

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
        const targets = [
          wantsDm ? `DM to ${newMember.user.username}` : null,
          channel ? `#${channel.name}` : null,
        ].filter(Boolean);

        logger.warn(
          `[DRY_RUN] Would send to ${targets.length > 0 ? targets.join(' and ') : 'no valid target'}: ${content || '(embed only)'}`,
        );
        return;
      }

      if (wantsDm) await sendDirectMessage(newMember, content, embed);
      if (channel) await sendChannelMessage(channel, newMember, content, embed, config);
    } catch (error) {
      logger.error(`Failed to handle role assignment: ${error.message}`, error);
    }
  };
}
