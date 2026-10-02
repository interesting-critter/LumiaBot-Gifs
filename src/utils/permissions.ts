import { config } from './config';
import type { RoleHolder } from '../services/rate-limiter';

/**
 * Authorisation for the privileged mod commands (`/ratelimit`, `/boredom`).
 *
 * WHY THIS IS A SEPARATE LIST FROM `RATE_LIMIT_EXEMPT_ROLES`
 * ---------------------------------------------------------
 * Those two commands write **global** bot state: `/boredom interval` and
 * `/boredom enable|disable|trigger` change (and spend money on) chatter in the
 * operator's configured channels across *every* server, and `/ratelimit set`
 * rewrites the window used by all of them. Guild-scoped permissions cannot
 * authorise global writes, and neither can a role *name*: role names are
 * chosen by each guild's own admins, so a name match lets an admin of any
 * server the bot is in mint a role called `Moderator`, hand it to a friend,
 * and that member can then force an LLM call every minute. That is a cheap
 * financial denial-of-service against the operator.
 *
 * So authorisation is snowflake-ID-only, from `TRUSTED_ROLE_IDS`:
 *
 *   - The role ID is minted by the operator (in their own server) and is
 *     globally unique, so holding it is a deliberate grant and not something a
 *     third-party admin can conjure.
 *   - Names stay in `RATE_LIMIT_EXEMPT_ROLES` where they are harmless: that
 *     list only grants a member more of their own chat quota. See
 *     `rateLimiterService.hasExemptRole`.
 *
 * Both lists are still honoured for numeric IDs, so an operator who already
 * put trusted role IDs in `RATE_LIMIT_EXEMPT_ROLES` keeps working without
 * editing anything. Name entries in that legacy list are reported once at boot
 * and stop granting the privileged commands.
 */

/** Comma-separated Discord role **snowflakes** that may run privileged commands. */
const TRUSTED_ROLE_IDS_ENV = 'TRUSTED_ROLE_IDS';

/** A Discord snowflake is digits only. Anything else is a typo, not a role. */
const SNOWFLAKE_PATTERN = /^\d+$/;

/**
 * Parse `TRUSTED_ROLE_IDS` into role snowflakes.
 *
 * Fails closed: any entry that is not a bare run of digits is **rejected and
 * named in a warning** rather than dropped silently, because the failure mode
 * being guarded against is subtle — a mistyped entry leaves the operator
 * wondering why "my trusted role lost access", and a name pasted here would
 * otherwise be matched by name, which is the vulnerability this list exists to
 * close.
 *
 * Length is deliberately not constrained beyond "digits": Discord snowflakes
 * have grown over time and a future id length should not silently drop a valid
 * role. Entries that are numeric but too short to be a real snowflake simply
 * never match a real role, which is the safe direction.
 *
 * @param raw the raw env value; `undefined`/blank means "not configured"
 * @param onWarning receives one message per rejected entry (defaults to console)
 */
export function parseTrustedRoleIds(
  raw: string | undefined,
  onWarning: (message: string) => void = (message) => console.warn(message)
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (!SNOWFLAKE_PATTERN.test(trimmed)) {
      onWarning(
        `🚨 [PERMISSIONS] Ignoring ${TRUSTED_ROLE_IDS_ENV} entry "${trimmed}": it is not a Discord role ID. ` +
          'That variable accepts role snowflakes ONLY (digits). Role names are not accepted here because any ' +
          'guild admin can create a role with any name, which would let them grant privileged mod commands. ' +
          'Names still work in RATE_LIMIT_EXEMPT_ROLES for the rate-limit bypass.',
      );
      continue;
    }

    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }

  return ids;
}

let trustedRoleIdsCache: { raw: string | undefined; ids: string[] } | null = null;
let authorisedRoleIdsCache: { raw: string | undefined; exemptKey: string; ids: string[] } | null = null;
let legacyNameWarningShown = false;

/**
 * The role snowflakes that may run privileged commands, from `TRUSTED_ROLE_IDS`.
 *
 * Read lazily (and re-read when the raw env value changes) rather than frozen at
 * import, so the parse stays testable and the warning fires where it is useful.
 */
export function getTrustedRoleIds(): string[] {
  const raw = process.env[TRUSTED_ROLE_IDS_ENV];
  if (trustedRoleIdsCache && trustedRoleIdsCache.raw === raw) {
    return trustedRoleIdsCache.ids;
  }
  const ids = parseTrustedRoleIds(raw);
  trustedRoleIdsCache = { raw, ids };
  return ids;
}

/**
 * The full authorisation set: `TRUSTED_ROLE_IDS` plus every numeric entry of the
 * legacy `RATE_LIMIT_EXEMPT_ROLES` list, so upgrading does not silently lock
 * legitimate moderators out of `/boredom` and `/ratelimit`.
 */
export function getAuthorisedRoleIds(): string[] {
  const raw = process.env[TRUSTED_ROLE_IDS_ENV];
  const exempt = config.rateLimit.exemptRoles;
  const exemptKey = exempt.join(',');
  if (
    authorisedRoleIdsCache
    && authorisedRoleIdsCache.raw === raw
    && authorisedRoleIdsCache.exemptKey === exemptKey
  ) {
    return authorisedRoleIdsCache.ids;
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of getTrustedRoleIds()) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  const legacyNames: string[] = [];
  for (const entry of exempt) {
    if (SNOWFLAKE_PATTERN.test(entry)) {
      if (!seen.has(entry)) {
        seen.add(entry);
        ids.push(entry);
      }
    } else {
      legacyNames.push(entry);
    }
  }

  if (legacyNames.length > 0 && !legacyNameWarningShown) {
    legacyNameWarningShown = true;
    console.warn(
      `🚨 [PERMISSIONS] RATE_LIMIT_EXEMPT_ROLES contains role name(s): ${legacyNames.join(', ')}.\n` +
        '     They still bypass rate limiting, but they NO LONGER grant /ratelimit or /boredom —\n' +
        `     those commands write global state, and a guild admin can create a role with any name.\n` +
        `     Put the role's numeric ID in ${TRUSTED_ROLE_IDS_ENV} to restore access.`,
    );
  }

  authorisedRoleIdsCache = { raw, exemptKey, ids };
  return ids;
}

/**
 * Whether this user may run a privileged mod command (`/ratelimit`, `/boredom`).
 *
 * The gate is deliberately narrow: the bot owner, or the holder of a role whose
 * snowflake is in the trusted list. It used to also accept a guild's owner and
 * anyone with `BanMembers`/`Administrator`, and then any role whose *name* was
 * configured; see the note at the top of this file for why guild-scoped and
 * name-scoped authority cannot reach global state.
 */
export function canRunPrivilegedCommand(userId: string, member: RoleHolder): boolean {
  // `ownerIdSet` is checked explicitly rather than relying on the empty-string
  // sentinel: this reads as "the operator configured an owner" instead of
  // "somebody's id happened to equal ''".
  if (config.bot.ownerIdSet && userId === config.bot.ownerId) {
    return true;
  }

  const roleIds = getAuthorisedRoleIds();
  if (roleIds.length === 0 || !member) {
    return false;
  }

  // Snowflake-only. Deliberately does not fall back to role names.
  return memberHasAnyRoleId(member, roleIds);
}

/**
 * The role snowflakes a member holds, in either the cached or the raw shape.
 *
 * Exported because it is the one place that knows discord.js hands us
 * `string[]` for an uncached guild and a `Collection<Role>` for a cached one.
 * Never returns role names — callers that authorise anything must not be able
 * to reach a name by accident.
 */
export function memberRoleIds(member: RoleHolder): string[] {
  if (!member) return [];

  // `GuildMember.roles` is a plain `string[]` of snowflakes (no names available).
  const apiRoles = (member as { roles?: unknown }).roles;
  if (Array.isArray(apiRoles)) {
    return apiRoles.filter((id): id is string => typeof id === 'string' && SNOWFLAKE_PATTERN.test(id));
  }

  // `APIInteractionGuildMember.roles` may instead be a Collection keyed by id.
  // The discriminator is the runtime type, not any cache state.
  const cache = (member as { roles?: { cache?: { keys?: () => IterableIterator<string> } } }).roles?.cache;
  if (!cache?.keys) return [];
  return Array.from(cache.keys()).filter((id) => typeof id === 'string' && SNOWFLAKE_PATTERN.test(id));
}

/**
 * Whether the member holds any of `roleIds`. Snowflakes only — see
 * {@link memberRoleIds}. Fails closed: no member, no ids, or an unrecognised
 * member shape all mean "not trusted".
 */
export function memberHasAnyRoleId(member: RoleHolder, roleIds: readonly string[]): boolean {
  if (!member || roleIds.length === 0) return false;
  const held = memberRoleIds(member);
  if (held.length === 0) return false;
  const wanted = new Set(roleIds);
  return held.some((id) => wanted.has(id));
}

/**
 * `allowedMentions` for replies whose text is not fully trusted.
 *
 * `parse: []` is the hardened form: it stops Discord from turning `@everyone`,
 * `@here` or a role ping that appears inside the text into an actual ping.
 * Without it, `reply`/`editReply` fall back to the discord.js default, which
 * parses mentions — so a model that copies a `@everyone` out of a web page, or
 * a search result whose title contains one, would ping a whole server.
 *
 * `users` is an explicit opt-in allowlist and `repliedUser: false` keeps the
 * automatic reply ping off. Pass the ids you *do* want pingable (the message
 * mentions the bot can legitimately name); omit it to allow none.
 *
 * Shared helper: `src/bot/client.ts` imports and uses this on every reply path,
 * so the mention-trigger and orchestrator paths cannot drift apart.
 */
export function buildAllowedMentions(userIds: Iterable<string> = []) {
  return {
    parse: [],
    users: Array.from(new Set(userIds)),
    repliedUser: false,
  };
}
