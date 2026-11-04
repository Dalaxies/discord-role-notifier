import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../logger.js';

const MAX_LENGTH = 2000;
const lastGoodByPath = new Map();

/**
 * Returns the message text to send right now.
 *
 * When MESSAGE_TEMPLATE_FILE is configured the file is re-read on every call,
 * so edits take effect without restarting the bot. If the file is missing,
 * empty or too long, the last known good version is used and a warning is
 * logged; a broken edit never stops notifications.
 */
export function readMessageTemplate(config) {
  if (!config.messageTemplateFile) return config.messageTemplate;

  const absolute = resolve(process.cwd(), config.messageTemplateFile);
  const previous = lastGoodByPath.get(absolute) ?? config.messageTemplate;

  try {
    const template = readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '').trim();

    if (template.length === 0) {
      throw new Error('the file is empty');
    }

    if (template.length > MAX_LENGTH) {
      throw new Error(
        `${template.length} characters; Discord allows at most ${MAX_LENGTH}`,
      );
    }

    lastGoodByPath.set(absolute, template);

    if (template !== previous) {
      logger.info(`Reloaded ${config.messageTemplateFile} (${template.length} characters).`);
    }

    return template;
  } catch (error) {
    logger.warn(
      `Could not read ${config.messageTemplateFile}: ${error.message}. Using the previous message.`,
    );
    return previous;
  }
}
