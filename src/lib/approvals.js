/**
 * A short-lived link between a role the bot grants from an onboarding approval
 * and the moderator who clicked the button.
 *
 * Discord's audit log credits the bot for the role change, which would make the
 * welcome-log entry say "Assigned by Unknown". The guildMemberUpdate handler
 * takes this context instead, so the log names the person who approved it.
 */
const TTL_MS = 30_000;

/** key -> { approverId, approverName, messageId, channelId, at } */
const contexts = new Map();

function keyFor(guildId, memberId) {
  return `${guildId}:${memberId}`;
}

function prune() {
  const cutoff = Date.now() - TTL_MS;

  for (const [key, context] of contexts) {
    if (context.at < cutoff) contexts.delete(key);
  }
}

export function rememberApproval(guildId, memberId, context) {
  prune();
  contexts.set(keyFor(guildId, memberId), { ...context, at: Date.now() });
}

/** Returns and removes the pending approval for this member, if any. */
export function takeApproval(guildId, memberId) {
  const key = keyFor(guildId, memberId);
  const context = contexts.get(key);
  if (!context) return null;

  contexts.delete(key);

  if (Date.now() - context.at > TTL_MS) return null;
  return context;
}

/** Drops a pending approval when the role change failed. */
export function forgetApproval(guildId, memberId) {
  contexts.delete(keyFor(guildId, memberId));
}
