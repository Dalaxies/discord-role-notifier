import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { loadConfig } from './config.js';
import { checkLogChannelPermissions, resolveLogChannel } from './lib/channel.js';
import { resolveBotMember, waitForGuild } from './lib/guild.js';
import { loadSettings } from './settings.js';

const INVITE_PERMISSIONS = '85120';

function inviteUrl(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${INVITE_PERMISSIONS}&scope=bot`;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

/**
 * Preflight check: logs in, then verifies the server, role, admin log channel
 * and permissions.
 *
 *   npm run doctor
 *   npm run doctor -- --send-test
 *   npm run doctor -- --send-test --user 123456789012345678
 */
async function main() {
  const sendTest = process.argv.includes('--send-test');
  const dmTargetArgument = argumentValue('--user');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  const settings = loadSettings(config.roleId, config.logChannelId);

  let failures = 0;
  const pass = (message) => console.log(`  \u2714 ${message}`);
  const fail = (message) => {
    failures += 1;
    console.log(`  \u2716 ${message}`);
  };
  const note = (message) => console.log(`    ${message}`);

  try {
    await client.login(config.token);
  } catch (error) {
    console.error('\nCould not log in.');
    if (/disallowed intents/i.test(error.message)) {
      console.error(
        'Enable "Server Members Intent" under Bot -> Privileged Gateway Intents in the Discord Developer Portal.',
      );
    } else if (/invalid token/i.test(error.message)) {
      console.error('DISCORD_TOKEN is invalid. Reset it in the portal and paste the new token into .env.');
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nBot account : ${client.user.tag} (${client.user.id})`);
  console.log(`Delivery    : direct message (DM)`);
  console.log(`Invite URL  : ${inviteUrl(client.user.id)}\n`);
  console.log('Checks:');

  pass(`Logged in as ${client.user.tag}`);
  pass('Server Members intent is enabled (Discord accepted the connection)');

  const guild = await waitForGuild(client, config.guildId);
  const botMember = guild ? await resolveBotMember(guild) : null;

  let logChannel = null;

  if (!guild) {
    fail(`Bot is not a member of server ${config.guildId}`);
    note(`Invite it with: ${inviteUrl(client.user.id)}`);
  } else {
    pass(`Bot is in server "${guild.name}" (${guild.id})`);

    const role =
      guild.roles.cache.get(settings.roleId) ??
      (await guild.roles.fetch(settings.roleId).catch(() => null));

    if (!role) {
      fail(`Role ${settings.roleId} does not exist in "${guild.name}"`);
    } else {
      const managed = role.managed ? ' (managed by an integration)' : '';
      pass(`Watching role "${role.name}" (${role.id})${managed}`);
    }

    if (settings.logChannelId) {
      try {
        logChannel = await resolveLogChannel(guild, settings.logChannelId);
        pass(`Admin log channel: #${logChannel.name} (${logChannel.id})`);
      } catch (error) {
        fail(error.message);
      }

      if (logChannel) {
        const issues = checkLogChannelPermissions(logChannel, botMember);
        if (issues.length > 0) {
          fail(`Missing log channel permissions: ${issues.join(', ')}`);
        } else {
          pass('Bot can View Channel and Send Messages there');
        }
      }
    } else {
      fail('No admin log channel is configured (set LOG_CHANNEL_ID or use the dashboard)');
    }

    pass('Delivery is set to direct message (DM)');
    note('DMs require that the member shares this server and has "Direct messages from server members" enabled.');

    if (config.web.enabled) {
      note(`Dashboard: http://${config.web.host}:${config.web.port} (Discord login)`);
      if (!config.web.clientSecret) {
        note('Dashboard sign-in is disabled until DISCORD_CLIENT_SECRET is set.');
      }
    }

    if (config.lookupAuditLog) {
      if (botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
        pass('Bot can read the audit log (assigner will be shown)');
      } else {
        fail('Bot cannot read the audit log (add View Audit Log, or set LOOKUP_AUDIT_LOG=false)');
      }
    }

    if (sendTest) {
      if (logChannel) {
        try {
          await logChannel.send({
            content: `\u2705 Test from **${client.user.username}**: admin log channel is configured correctly.`,
            allowedMentions: { parse: [] },
          });
          pass('Test log entry sent to the admin channel');
        } catch (error) {
          fail(`Test log entry failed: ${error.message}`);
        }
      }

      let targetId = dmTargetArgument;

      if (!targetId) {
        targetId = guild.ownerId;
        note(`No --user given, so the test DM goes to the server owner (${targetId}).`);
      }

      try {
        const target = await client.users.fetch(targetId);
        await target.send({
          content: `\u2705 Test from **${client.user.username}**: DM delivery works.`,
          allowedMentions: { parse: [] },
        });
        pass(`Test DM sent to ${target.username} (${target.id})`);
      } catch (error) {
        if (error.code === 50007) {
          fail(
            `Could not DM ${targetId}: that account has "Direct messages from server members" disabled, or does not share a server with the bot`,
          );
        } else {
          fail(`Test DM failed: ${error.message}`);
        }
      }
    }
  }

  if (config.dryRun) {
    note('DRY_RUN is enabled: the bot will log notifications without sending them.');
  }

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check(s) failed. Fix the items marked with \u2716 above.\n`,
  );

  if (failures > 0) process.exitCode = 1;

  client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
