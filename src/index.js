import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createGuildMemberUpdateHandler } from './events/guild-member-update.js';
import { checkLogChannelPermissions, resolveLogChannel } from './lib/channel.js';
import { resolveBotMember, waitForGuild } from './lib/guild.js';
import { getSettings, loadSettings } from './settings.js';
import { startWebServer } from './web/server.js';

const INVITE_PERMISSIONS = '85120';

function inviteUrl(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${INVITE_PERMISSIONS}&scope=bot`;
}

async function main() {
  const config = loadConfig();
  const settings = loadSettings(config.roleId, config.logChannelId);

  // DELIVERY and CHANNEL_ID configured channel copies of the welcome message,
  // which no longer exist. Say so once instead of silently ignoring them.
  const legacyDelivery = process.env.DELIVERY?.trim().toLowerCase();
  if (legacyDelivery && legacyDelivery !== 'dm') {
    logger.warn(
      `DELIVERY=${legacyDelivery} is no longer supported: welcome messages are always sent as DMs. Remove DELIVERY from .env.`,
    );
  }

  if (process.env.CHANNEL_ID?.trim()) {
    logger.warn(
      'CHANNEL_ID no longer receives welcome messages. Set the admin log channel in the dashboard or via LOG_CHANNEL_ID.',
    );
  }

  // The dashboard can change the role and log channel at runtime, so the
  // handler asks for the current configuration on every event instead of
  // capturing it once.
  const currentConfig = () => ({
    ...config,
    roleId: getSettings().roleId,
    logChannelId: getSettings().logChannelId,
  });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.on(Events.GuildMemberUpdate, createGuildMemberUpdateHandler(currentConfig));
  client.on(Events.Warn, (message) => logger.warn(message));
  client.on(Events.Error, (error) => logger.error(`Gateway error: ${error.message}`, error));

  let webServer = null;

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag} (${readyClient.user.id})`);

    // READY only lists guild IDs; the real guild data arrives just after it.
    const guild = await waitForGuild(readyClient, config.guildId);
    if (!guild) {
      logger.error(
        `The bot is not a member of server ${config.guildId}. Invite it with: ${inviteUrl(readyClient.user.id)}`,
      );
      return;
    }

    logger.info(`Watching server "${guild.name}" (${guild.id}) for role ${settings.roleId}`);

    const cachedRole = guild.roles.cache.get(settings.roleId);
    if (cachedRole) {
      logger.info(`Role "${cachedRole.name}" resolved.`);
    } else {
      const role = await guild.roles.fetch(settings.roleId).catch(() => null);
      if (role) logger.info(`Role "${role.name}" resolved.`);
      else logger.error(`Role ${settings.roleId} was not found in "${guild.name}". Check ROLE_ID.`);
    }

    if (config.messageTemplateFile) {
      logger.info(
        `Message template: ${config.messageTemplateFile} (${config.messageTemplate.length} characters, re-read on every notification)`,
      );
    }

    logger.info('Notifications will be sent as direct messages to the member.');
    logger.info('Members must share this server and allow "Direct messages from server members".');

    if (settings.logChannelId) {
      try {
        const channel = await resolveLogChannel(guild, settings.logChannelId);
        const issues = checkLogChannelPermissions(channel, await resolveBotMember(guild));

        if (issues.length > 0) {
          logger.error(`Missing permissions in admin log #${channel.name}: ${issues.join(', ')}`);
        } else {
          logger.info(`Admin log will be posted in #${channel.name} (${channel.id}).`);
        }
      } catch (error) {
        logger.error(error.message);
      }
    } else {
      logger.warn('No admin log channel is configured; DMs will not be recorded in a channel.');
    }

    if (config.dryRun) {
      logger.warn('DRY_RUN is enabled: events are logged but no messages are sent.');
    }

    if (config.web.enabled) {
      try {
        webServer = await startWebServer({
          config,
          getClient: () => readyClient,
          getGuild: () => guild,
        });
      } catch (error) {
        logger.error(`Dashboard failed to start: ${error.message}`);
      }
    } else {
      logger.info('Dashboard is disabled (set WEB_ENABLED=true to enable it).');
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down.`);

    if (webServer) {
      webServer.closeAllConnections?.();
      await new Promise((resolve) => webServer.close(() => resolve()));
    }

    await client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection:', reason));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  try {
    await client.login(config.token);
  } catch (error) {
    if (/disallowed intents/i.test(error.message)) {
      logger.error(
        'Login refused: enable "Server Members Intent" under Bot -> Privileged Gateway Intents in the Discord Developer Portal.',
      );
    } else if (/invalid token/i.test(error.message)) {
      logger.error('Login failed: DISCORD_TOKEN is invalid. Reset it in the portal and update .env.');
    } else {
      logger.error(`Login failed: ${error.message}`);
    }

    process.exit(1);
  }
}

main().catch((error) => {
  logger.error(error.message);
  process.exit(1);
});
