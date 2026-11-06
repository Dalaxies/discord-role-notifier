import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

import { logger } from '../logger.js';
import { postAdminLog } from '../lib/admin-log.js';
import { rememberApproval, forgetApproval } from '../lib/approvals.js';
import {
  checkOnboardingChannelPermissions,
  resolveOnboardingChannel,
} from '../lib/channel.js';

const ACCEPT_PREFIX = 'onboarding:accept:';
const REJECT_PREFIX = 'onboarding:reject:';
const CUSTOM_ID_RE = /^onboarding:(accept|reject):(\d{17,20}):(\d{17,20})$/;

// Guards against two moderators clicking at the same moment.
const DECIDING = new Set();

const DECISION_STYLES = {
  accepted: { color: 0x57f287, title: '\u2705 Onboarding accepted' },
  rejected: { color: 0xed4245, title: '\u274c Onboarding rejected' },
  already: { color: 0x99aab5, title: '\u2139\ufe0f Already onboarded' },
  failed: { color: 0xfaa61a, title: '\u26a0\ufe0f Approval failed' },
  missing: { color: 0x99aab5, title: '\u2139\ufe0f Member unavailable' },
};

function describeMember(member, userId) {
  const id = member?.id ?? userId;
  const username = member?.user?.username;
  const avatar = member?.displayAvatarURL?.();

  return {
    id,
    label: username ? `${username} (${id})` : `Member ${id}`,
    avatar: avatar || null,
  };
}

function applyAuthor(embed, member, userId) {
  const { label, avatar } = describeMember(member, userId);
  const author = { name: label };
  if (avatar) author.iconURL = avatar;

  return embed.setAuthor(author);
}

function customId(action, userId, messageId) {
  return `${action === 'accept' ? ACCEPT_PREFIX : REJECT_PREFIX}${userId}:${messageId}`;
}

function actionRow(userId, messageId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId('accept', userId, messageId))
      .setLabel('Accept')
      .setEmoji('\u2705')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(customId('reject', userId, messageId))
      .setLabel('Reject')
      .setEmoji('\u274c')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function promptEmbed(member, role) {
  return applyAuthor(
    new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('Onboarding review')
      .setDescription(
        `<@${member.id}> does not have ${role} yet.\n\n` +
          'A member with **Manage Roles** can accept or reject them.',
      )
      .setFooter({ text: 'Role notifier \u00b7 onboarding' })
      .setTimestamp(),
    member,
  );
}

function decisionEmbed(member, actor, outcome, description, userId) {
  const style = DECISION_STYLES[outcome] ?? DECISION_STYLES.failed;

  return applyAuthor(
    new EmbedBuilder()
      .setColor(style.color)
      .setTitle(style.title)
      .setDescription(description)
      .setFooter({ text: 'Role notifier \u00b7 onboarding' })
      .setTimestamp(),
    member,
    userId,
  );
}

function rejectionLogEmbed(member, role, roleId, reviewer, guildId, channelId, messageId, userId) {
  const { id, label, avatar } = describeMember(member, userId);
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('\u274c Onboarding rejected')
    .setDescription(`<@${reviewer.id}> rejected <@${id}>. The welcome role was not added.`)
    .addFields(
      { name: 'Member', value: `<@${id}>`, inline: true },
      { name: 'Role', value: role ? `${role}` : `<@&${roleId}>`, inline: true },
      { name: 'Reviewed by', value: `<@${reviewer.id}>`, inline: true },
      {
        name: 'Message',
        value: `[Jump to message](https://discord.com/channels/${guildId}/${channelId}/${messageId})`,
        inline: false,
      },
    )
    .setFooter({ text: 'Role notifier \u00b7 admin log' })
    .setTimestamp();

  if (avatar) embed.setAuthor({ name: label, iconURL: avatar });

  return embed;
}

function canReview(interaction) {
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return true;

  return Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageRoles));
}

async function resolveRole(guild, roleId) {
  return guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
}

async function fetchMember(guild, userId) {
  const cached = guild.members.cache?.get(userId);
  if (cached) return cached;

  return guild.members.fetch(userId).catch(() => null);
}

async function reactToOriginal(interaction, messageId, emoji) {
  try {
    const channel =
      interaction.channel ??
      (await interaction.guild.channels.fetch(interaction.channelId).catch(() => null));

    if (!channel?.messages) throw new Error('the channel does not support messages');

    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
    return true;
  } catch (error) {
    logger.warn(`Could not react to onboarding message ${messageId}: ${error.message}`);
    return false;
  }
}

/**
 * Watches the onboarding channel. Every message from a member who does not yet
 * have the welcome role gets an Accept/Reject prompt as a reply.
 */
export function createOnboardingMessageHandler(configOrGetter) {
  const getConfig =
    typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter;

  return async function handleMessageCreate(message) {
    const config = getConfig();

    try {
      if (!config.onboardingChannelId) return;
      if (!message.guild || message.guild.id !== config.guildId) return;
      if (message.channelId !== config.onboardingChannelId) return;
      if (!message.author) return;
      if (message.author.bot) return;
      if (message.system) return;

      const member =
        message.member ??
        (await message.guild.members.fetch(message.author.id).catch(() => null));

      if (!member) return;
      if (member.roles.cache.has(config.roleId)) return;

      if (config.dryRun) {
        logger.warn(
          `[DRY_RUN] Would post an onboarding review for ${message.author.username} (${message.author.id}).`,
        );
        return;
      }

      const channel =
        (await resolveOnboardingChannel(message.guild, config.onboardingChannelId).catch(() => null)) ??
        message.channel;

      const botMember =
        message.guild.members.me ??
        (await message.guild.members.fetchMe?.().catch(() => null));

      const issues = checkOnboardingChannelPermissions(channel, botMember);
      if (issues.length > 0) {
        logger.error(
          `Cannot post an onboarding review in #${channel.name ?? channel.id}: missing ${issues.join(', ')}.`,
        );
        return;
      }

      const role = await resolveRole(message.guild, config.roleId);
      if (!role) {
        logger.error(
          `Cannot post an onboarding review: role ${config.roleId} was not found in "${message.guild.name}".`,
        );
        return;
      }

      await message.reply({
        embeds: [promptEmbed(member, role)],
        components: [actionRow(message.author.id, message.id)],
        allowedMentions: { parse: [], repliedUser: false },
      });

      logger.info(
        `Onboarding review posted for ${message.author.username} (${message.author.id}) in #${channel.name ?? channel.id}.`,
      );
    } catch (error) {
      logger.error(`Failed to post an onboarding review: ${error.message}`);
    }
  };
}

/**
 * Handles the Accept/Reject buttons. Discord cannot hide components per role, so
 * anyone can see them; the Manage Roles check happens here before anything is
 * changed.
 */
export function createOnboardingInteractionHandler(configOrGetter) {
  const getConfig =
    typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter;

  return async function handleInteractionCreate(interaction) {
    if (!interaction.isButton()) return;

    const parsed = CUSTOM_ID_RE.exec(interaction.customId);
    if (!parsed) return;

    const config = getConfig();
    const guild = interaction.guild;

    if (!guild || guild.id !== config.guildId) return;

    if (!canReview(interaction)) {
      await interaction.reply({
        content: 'You need the **Manage Roles** permission to review onboarding.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (config.dryRun) {
      await interaction.reply({
        content: 'DRY_RUN is enabled, so no role changes were made.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const action = parsed[1];
    const userId = parsed[2];
    const messageId = parsed[3];
    const lockKey = `${userId}:${messageId}`;

    if (DECIDING.has(lockKey)) {
      await interaction.reply({
        content: 'This onboarding message is already being processed.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    DECIDING.add(lockKey);
    let deferred = false;

    try {
      await interaction.deferUpdate();
      deferred = true;

      const member = await fetchMember(guild, userId);
      const role = await resolveRole(guild, config.roleId);

      if (action === 'accept' && !member) {
        await interaction.editReply({
          embeds: [
            decisionEmbed(
              null,
              interaction.user,
              'missing',
              `<@${userId}> is no longer in the server, so the welcome role was not added.`,
              userId,
            ),
          ],
          components: [actionRow(userId, messageId, true)],
        });
        await interaction
          .followUp({
            content: 'That member is no longer in the server.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }

      if (action === 'accept' && !role) {
        const detail = `The configured welcome role (<@&${config.roleId}>) no longer exists.`;
        await interaction.editReply({
          embeds: [decisionEmbed(member, interaction.user, 'failed', detail, userId)],
          components: [actionRow(userId, messageId, true)],
        });
        await interaction
          .followUp({ content: detail, flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return;
      }

      if (action === 'accept') {
        if (member.roles.cache.has(config.roleId)) {
          await interaction.editReply({
            embeds: [
              decisionEmbed(
                member,
                interaction.user,
                'already',
                `<@${member.id}> already has ${role}.`,
                userId,
              ),
            ],
            components: [actionRow(userId, messageId, true)],
          });
          await interaction
            .followUp({
              content: 'That member already has the welcome role.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }

        rememberApproval(guild.id, member.id, {
          approverId: interaction.user.id,
          approverName: interaction.user.username,
          messageId,
          channelId: interaction.channelId,
        });

        try {
          await member.roles.add(role, `Onboarding approved by ${interaction.user.username}`);
        } catch (error) {
          forgetApproval(guild.id, member.id);
          logger.error(
            `Could not add role ${config.roleId} to ${member.user.username} (${member.id}): ${error.message}`,
          );

          const detail = `Could not add ${role} to <@${member.id}>: ${error.message}`;
          await interaction.editReply({
            embeds: [decisionEmbed(member, interaction.user, 'failed', detail, userId)],
            components: [actionRow(userId, messageId)],
          });
          await interaction
            .followUp({
              content:
                'The role could not be added. Check that the bot has **Manage Roles** and that its highest role is above the welcome role.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }

        await reactToOriginal(interaction, messageId, '\u{1F44D}');

        await interaction.editReply({
          embeds: [
            decisionEmbed(
              member,
              interaction.user,
              'accepted',
              `<@${interaction.user.id}> accepted <@${member.id}>; the welcome DM has been triggered.`,
              userId,
            ),
          ],
          components: [actionRow(userId, messageId, true)],
        });

        logger.info(
          `Onboarding accepted for ${member.user.username} (${member.id}) by ${interaction.user.username}.`,
        );
        return;
      }

      await reactToOriginal(interaction, messageId, '\u{1F44E}');

      await interaction.editReply({
        embeds: [
          decisionEmbed(
            member,
            interaction.user,
            'rejected',
            `<@${interaction.user.id}> rejected ${member ? `<@${member.id}>` : `<@${userId}>`}. The welcome role was not added.`,
            userId,
          ),
        ],
        components: [actionRow(userId, messageId, true)],
      });

      logger.info(`Onboarding rejected for ${userId} by ${interaction.user.username}.`);

      await postAdminLog(
        guild,
        config.logChannelId,
        rejectionLogEmbed(
          member,
          role,
          config.roleId,
          interaction.user,
          guild.id,
          interaction.channelId,
          messageId,
          userId,
        ),
      );
    } catch (error) {
      logger.error(`Onboarding ${action} failed: ${error.message}`, error);

      if (deferred) {
        await interaction
          .followUp({
            content: 'Something went wrong while processing this review. Check the bot logs.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    } finally {
      DECIDING.delete(lockKey);
    }
  };
}
