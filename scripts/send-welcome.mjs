import { Client, GatewayIntentBits } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { renderTemplate } from '../src/lib/template.js';
import { readMessageTemplate } from '../src/lib/message.js';
import { waitForGuild } from '../src/lib/guild.js';
import { logger } from '../src/logger.js';

/**
 * Sends the configured welcome message to specific users, on demand.
 *
 *   npm run send-welcome -- 121531556564172802 133054172231761921
 *   npm run send-welcome -- --dry-run 121531556564172802
 *
 * This is an admin tool: it does not wait for role changes. It sends the same
 * message text the bot would send (MESSAGE_TEMPLATE_FILE or MESSAGE_TEMPLATE).
 * Discord still refuses DMs when the user does not share the server or has
 * "Direct messages from server members" disabled (error 50007).
 */

const USER_ID_RE = /^\d{17,20}$/;

function parseArgs(argv) {
  const ids = [];
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else if (USER_ID_RE.test(arg)) {
      ids.push(arg);
    } else {
      throw new Error(`Not a user ID: "${arg}" (expected 17-20 digits).`);
    }
  }

  if (ids.length === 0) {
    throw new Error('No user IDs given. Example: npm run send-welcome -- 123456789012345678');
  }

  return { ids: [...new Set(ids)], dryRun };
}

async function main() {
  let config;
  let ids;
  let dryRun;

  try {
    config = loadConfig();
    ({ ids, dryRun } = parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  try {
    await client.login(config.token);
  } catch (error) {
    console.error(`Could not log in: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const messageTemplate = readMessageTemplate(config);

  console.log(`\nBot        : ${client.user.tag} (${client.user.id})`);
  console.log(`Message    : ${messageTemplate.length} characters`);
  console.log(`Recipients : ${ids.join(', ')}${dryRun ? '  [DRY RUN]' : ''}\n`);

  const guild = await waitForGuild(client, config.guildId);
  if (guild) {
    console.log(`Server     : "${guild.name}" (${guild.id})`);
  } else {
    console.log(`Server     : ${config.guildId} (could not be fetched)`);
  }

  let sent = 0;
  let failed = 0;

  for (const id of ids) {
    const member = guild
      ? await guild.members.fetch(id).catch(() => null)
      : null;

    if (guild && !member) {
      console.log(`\n✖ ${id}: not a member of "${guild.name}". Discord will reject the DM (50007).`);
      failed += 1;
      continue;
    }

    const user = member?.user ?? (await client.users.fetch(id).catch(() => null));
    if (!user) {
      console.log(`\n✖ ${id}: no such Discord user.`);
      failed += 1;
      continue;
    }

    const content = renderTemplate(messageTemplate, {
      user: `<@${id}>`,
      username: user.username,
      displayName: member?.displayName ?? user.username,
      server: guild?.name ?? '',
      role: `<@&${config.roleId}>`,
      roleName: config.roleId,
      userId: id,
    });

    if (dryRun) {
      console.log(`\n• ${user.username} (${id}) — would send ${content.length} characters.`);
      sent += 1;
      continue;
    }

    try {
      await user.send({
        content: content || undefined,
        allowedMentions: { parse: [] },
      });
      console.log(`\n✔ ${user.username} (${id}): sent ${content.length} characters.`);
      sent += 1;
    } catch (error) {
      if (error.code === 50007) {
        console.log(
          `\n✖ ${user.username} (${id}): cannot receive DMs (privacy setting or no shared server).`,
        );
      } else {
        console.log(`\n✖ ${user.username} (${id}): ${error.message}`);
      }
      failed += 1;
    }
  }

  console.log(`\n${sent} sent, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;

  await client.destroy();
}

main().catch((error) => {
  logger.error(error.message);
  process.exit(1);
});
