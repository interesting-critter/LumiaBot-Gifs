import { config } from './config';
import { rateLimiterService, type RoleHolder } from '../services/rate-limiter';

/**
 * Whether this user may run a privileged mod command (`/ratelimit`, `/boredom`).
 *
 * The gate is deliberately narrow: the bot owner, or a member of a trusted role
 * from `RATE_LIMIT_EXEMPT_ROLES`. It used to also accept a guild's owner and
 * anyone with `BanMembers`/`Administrator`, but the commands these guard write
 * **global** bot state — `/boredom interval` and `/boredom trigger` affect every
 * server, and `/ratelimit set` changes the window for all of them — so a guild
 * admin could reach configuration belonging to every other server the bot is
 * in. Guild-scoped permissions cannot authorise global writes.
 *
 * Both commands share this one function so the trusted set is interpreted in a
 * single place; see the note on `config.rateLimit.exemptRoles`.
 */
export function canRunPrivilegedCommand(userId: string, member: RoleHolder): boolean {
  if (userId === config.bot.ownerId) {
    return true;
  }
  return rateLimiterService.hasExemptRole(member);
}
