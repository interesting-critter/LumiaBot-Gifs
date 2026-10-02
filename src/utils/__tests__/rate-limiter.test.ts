import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../config';
import { RateLimiterService, rateLimiterService, type RoleHolder } from '../../services/rate-limiter';
import {
  canRunPrivilegedCommand,
  getAuthorisedRoleIds,
  getTrustedRoleIds,
  memberHasAnyRoleId,
  memberRoleIds,
  parseTrustedRoleIds,
} from '../permissions';

/**
 * Two different capabilities are under test here, and keeping them apart is the
 * whole point:
 *
 *   1. AUTHORISATION (`canRunPrivilegedCommand`) decides who may run
 *      `/ratelimit set` and `/boredom interval|enable|disable|trigger`, all of
 *      which write global bot state. It is snowflake-ID-only. Matching a role by
 *      *name* here let an admin of any guild the bot is in mint a role called
 *      `Moderator` and drive an LLM call every minute in the operator's
 *      channels on every other server — a cheap financial DoS.
 *
 *   2. RATE-LIMIT BYPASS (`hasExemptRole`) only grants the holder more of their
 *      own quota, so name matching stays there.
 */

const TRUSTED_ID = '111111111111111111';
const ROLE_NAME = 'Moderator';

const OTHER_ID = '222222222222222222';

/** Cached-member shape: `roles.cache` behaves like a discord.js Collection. */
function cachedMember(roleIds: readonly string[], roleNames: readonly string[] = []): RoleHolder {
  const roles = new Map<string, { id: string; name: string }>();
  roleIds.forEach((id, index) => {
    roles.set(id, { id, name: roleNames[index] ?? `role-${index}` });
  });
  return {
    roles: {
      cache: {
        keys: () => roles.keys(),
        some: (predicate: (role: { id: string; name: string }) => boolean) => {
          for (const role of roles.values()) {
            if (predicate(role)) return true;
          }
          return false;
        },
      },
    },
  } as unknown as RoleHolder;
}

/** Uncached-member shape: `roles` is a plain string[] of snowflakes. */
function apiMember(roleIds: readonly string[]): RoleHolder {
  return { roles: [...roleIds] } as unknown as RoleHolder;
}

/** The limiter's private timestamp map, for bound assertions. */
function trackedMap(service: RateLimiterService): Map<string, number> {
  return (service as unknown as { lastRequestTimes: Map<string, number> }).lastRequestTimes;
}

let originalExemptRoles: string[];
let originalTrustedRoleIds: string | undefined;
let originalOwnerId: string;
let originalOwnerIdSet: boolean;

beforeEach(() => {
  originalExemptRoles = config.rateLimit.exemptRoles;
  originalTrustedRoleIds = process.env.TRUSTED_ROLE_IDS;
  originalOwnerId = config.bot.ownerId;
  originalOwnerIdSet = config.bot.ownerIdSet;
});

afterEach(() => {
  config.rateLimit.exemptRoles = originalExemptRoles;
  if (originalTrustedRoleIds === undefined) {
    delete process.env.TRUSTED_ROLE_IDS;
  } else {
    process.env.TRUSTED_ROLE_IDS = originalTrustedRoleIds;
  }
  config.bot.ownerId = originalOwnerId;
  config.bot.ownerIdSet = originalOwnerIdSet;
});

describe('parseTrustedRoleIds', () => {
  test('accepts numeric snowflakes and trims them', () => {
    expect(parseTrustedRoleIds(` ${TRUSTED_ID} , ${OTHER_ID} `)).toEqual([TRUSTED_ID, OTHER_ID]);
  });

  test('fails closed on a role name and names the offending entry', () => {
    const warnings: string[] = [];
    const ids = parseTrustedRoleIds(`${TRUSTED_ID},${ROLE_NAME}`, (m) => warnings.push(m));

    expect(ids).toEqual([TRUSTED_ID]);
    expect(warnings).toHaveLength(1);
    // The warning must name the bad entry, or the operator cannot tell which
    // one to fix.
    expect(warnings[0]).toContain(ROLE_NAME);
    expect(warnings[0]).toContain('TRUSTED_ROLE_IDS');
  });

  test('rejects every other non-numeric shape', () => {
    const warnings: string[] = [];
    const ids = parseTrustedRoleIds(
      `${ROLE_NAME},<@&${TRUSTED_ID}>,#channel,12 34,,1.5,0x10`,
      (m) => warnings.push(m)
    );
    expect(ids).toEqual([]);
    // 6 real entries, the empty one is skipped without a warning.
    expect(warnings).toHaveLength(6);
  });

  test('unset, blank and undefined all mean "not configured"', () => {
    expect(parseTrustedRoleIds(undefined)).toEqual([]);
    expect(parseTrustedRoleIds('')).toEqual([]);
    expect(parseTrustedRoleIds('   ')).toEqual([]);
    expect(parseTrustedRoleIds(',,')).toEqual([]);
  });

  test('de-duplicates repeated ids', () => {
    expect(parseTrustedRoleIds(`${TRUSTED_ID},${TRUSTED_ID}`)).toEqual([TRUSTED_ID]);
  });
});

describe('member role extraction (snowflakes only)', () => {
  test('reads ids from a cached Collection', () => {
    expect(memberRoleIds(cachedMember([TRUSTED_ID, OTHER_ID]))).toEqual([TRUSTED_ID, OTHER_ID]);
  });

  test('reads ids from the raw API string[] shape', () => {
    expect(memberRoleIds(apiMember([TRUSTED_ID]))).toEqual([TRUSTED_ID]);
  });

  test('fails closed on a missing member or an unrecognised shape', () => {
    expect(memberRoleIds(null)).toEqual([]);
    expect(memberRoleIds(undefined)).toEqual([]);
    expect(memberRoleIds({} as RoleHolder)).toEqual([]);
    expect(memberHasAnyRoleId(null, [TRUSTED_ID])).toBe(false);
  });

  test('never leaks role names out of the cached shape', () => {
    const member = cachedMember([TRUSTED_ID], [ROLE_NAME]);
    expect(memberRoleIds(member)).toEqual([TRUSTED_ID]);
    expect(memberRoleIds(member)).not.toContain(ROLE_NAME);
  });
});

describe('authorisation matching', () => {
  test('accepts a snowflake-ID match', () => {
    process.env.TRUSTED_ROLE_IDS = TRUSTED_ID;
    expect(getTrustedRoleIds()).toEqual([TRUSTED_ID]);
    expect(memberHasAnyRoleId(cachedMember([OTHER_ID, TRUSTED_ID]), getAuthorisedRoleIds())).toBe(true);
    expect(memberHasAnyRoleId(apiMember([TRUSTED_ID]), getAuthorisedRoleIds())).toBe(true);
  });

  test('rejects a name-only match for authorisation', () => {
    process.env.TRUSTED_ROLE_IDS = TRUSTED_ID;
    // The member holds a role whose *name* is the configured one, but whose id
    // is not the configured one.
    const impostor = cachedMember([OTHER_ID], [ROLE_NAME]);

    expect(memberHasAnyRoleId(impostor, getAuthorisedRoleIds())).toBe(false);
    expect(canRunPrivilegedCommand(OTHER_ID, impostor)).toBe(false);
  });

  test('a configured name in RATE_LIMIT_EXEMPT_ROLES does not authorise', () => {
    delete process.env.TRUSTED_ROLE_IDS;
    config.rateLimit.exemptRoles = [ROLE_NAME];

    expect(canRunPrivilegedCommand(OTHER_ID, cachedMember([OTHER_ID], [ROLE_NAME]))).toBe(false);
    // ...but it does still bypass the rate limit; see the bypass suite below.
    expect(getAuthorisedRoleIds()).toEqual([]);
  });

  test('a numeric entry in RATE_LIMIT_EXEMPT_ROLES still authorises (no surprise lockout)', () => {
    delete process.env.TRUSTED_ROLE_IDS;
    config.rateLimit.exemptRoles = [`Moderator`, TRUSTED_ID];

    expect(canRunPrivilegedCommand(OTHER_ID, cachedMember([TRUSTED_ID], ['nope']))).toBe(true);
    expect(getAuthorisedRoleIds()).toEqual([TRUSTED_ID]);
  });

  test('fails closed when a configured entry is malformed', () => {
    process.env.TRUSTED_ROLE_IDS = `${ROLE_NAME},,,#chan`;
    expect(getAuthorisedRoleIds()).toEqual([]);
    expect(canRunPrivilegedCommand(OTHER_ID, cachedMember([OTHER_ID], [ROLE_NAME]))).toBe(false);
  });

  test('fails closed for the owner check when no owner is configured', () => {
    delete process.env.TRUSTED_ROLE_IDS;
    config.rateLimit.exemptRoles = [];
    config.bot.ownerId = '';
    config.bot.ownerIdSet = false;

    // An empty owner id must never match, including against itself.
    expect(canRunPrivilegedCommand('', null)).toBe(false);
    expect(canRunPrivilegedCommand('999', null)).toBe(false);
  });

  test('an id match alone is not enough when the owner is unconfigured', () => {
    delete process.env.TRUSTED_ROLE_IDS;
    config.rateLimit.exemptRoles = [];
    config.bot.ownerId = '424242424242424242';
    config.bot.ownerIdSet = false;

    // No hardcoded fallback sneaked in: the id is present but unconfigured.
    expect(canRunPrivilegedCommand('424242424242424242', null)).toBe(false);
  });

  test('the configured owner always passes', () => {
    delete process.env.TRUSTED_ROLE_IDS;
    config.rateLimit.exemptRoles = [];
    config.bot.ownerId = '424242424242424242';
    config.bot.ownerIdSet = true;

    expect(canRunPrivilegedCommand('424242424242424242', null)).toBe(true);
    expect(canRunPrivilegedCommand('424242424242424243', null)).toBe(false);
  });

  test('an untrusted member with no roles is denied', () => {
    delete process.env.TRUSTED_ROLE_IDS;
    config.rateLimit.exemptRoles = [TRUSTED_ID];
    expect(canRunPrivilegedCommand(OTHER_ID, cachedMember([]))).toBe(false);
    expect(canRunPrivilegedCommand(OTHER_ID, null)).toBe(false);
  });
});

describe('rate-limit bypass matching (weaker capability, names allowed)', () => {
  test('matches a name (documented as safe: it only grants own quota)', () => {
    config.rateLimit.exemptRoles = [ROLE_NAME];
    expect(rateLimiterService.hasExemptRole(cachedMember([OTHER_ID], [ROLE_NAME]))).toBe(true);
  });

  test('matches a name case-insensitively', () => {
    config.rateLimit.exemptRoles = ['mOdErAtOr'];
    expect(rateLimiterService.hasExemptRole(cachedMember([OTHER_ID], ['Moderator']))).toBe(true);
  });

  test('matches an id in either member shape', () => {
    config.rateLimit.exemptRoles = [TRUSTED_ID];
    expect(rateLimiterService.hasExemptRole(cachedMember([TRUSTED_ID], ['whatever']))).toBe(true);
    expect(rateLimiterService.hasExemptRole(apiMember([TRUSTED_ID]))).toBe(true);
  });

  test('an uncached guild can only match on id, never on name', () => {
    config.rateLimit.exemptRoles = [ROLE_NAME];
    expect(rateLimiterService.hasExemptRole(apiMember([TRUSTED_ID]))).toBe(false);
  });

  test('denies with an empty list or no member', () => {
    config.rateLimit.exemptRoles = [];
    expect(rateLimiterService.hasExemptRole(cachedMember([TRUSTED_ID], [ROLE_NAME]))).toBe(false);
    config.rateLimit.exemptRoles = [TRUSTED_ID];
    expect(rateLimiterService.hasExemptRole(null)).toBe(false);
  });

  test('the bypass never lets anyone past a configured id they do not hold', () => {
    config.rateLimit.exemptRoles = [TRUSTED_ID];
    expect(rateLimiterService.hasExemptRole(cachedMember([OTHER_ID], ['some-other-role']))).toBe(false);
  });
});

describe('isRateLimited', () => {
  test('the owner and exempt members are never limited', () => {
    config.rateLimit.exemptRoles = [TRUSTED_ID];
    const owner = '424242424242424242';
    config.bot.ownerId = owner;
    config.bot.ownerIdSet = true;

    expect(rateLimiterService.isRateLimited(owner, null)).toBe(false);
    expect(rateLimiterService.isRateLimited(OTHER_ID, cachedMember([TRUSTED_ID]))).toBe(false);
  });

  test('a rejected request does not push the window forward', () => {
    // Documented decision: the window is anchored to the last *allowed*
    // request, so a client that retries cannot extend its own lockout.
    const service = new RateLimiterService();
    const map = trackedMap(service);
    const windowMs = service.getLimitSeconds() * 1000;

    expect(service.isRateLimited(OTHER_ID, null)).toBe(false);
    const first = map.get(OTHER_ID);
    expect(first).toBeDefined();

    map.set(OTHER_ID, Date.now() - windowMs + 5_000);
    expect(service.isRateLimited(OTHER_ID, null)).toBe(true);
    // Unchanged: a rejected attempt does not refresh the timestamp.
    expect(map.get(OTHER_ID)).toBe(Date.now() - windowMs + 5_000);
  });

  test('an allowed request refreshes the window', () => {
    const service = new RateLimiterService();
    const map = trackedMap(service);
    const windowMs = service.getLimitSeconds() * 1000;

    service.isRateLimited(OTHER_ID, null);
    map.set(OTHER_ID, Date.now() - windowMs - 1_000);
    expect(service.isRateLimited(OTHER_ID, null)).toBe(false);
    expect(map.get(OTHER_ID)!).toBeGreaterThan(Date.now() - 1_000);
  });
});

/**
 * The map is the limiter's entire state. `pruneIfNeeded` used to run only on the
 * allow path, so a burst of *rejected* requests from many distinct ids never
 * swept it and the map grew past its documented bound under exactly the traffic
 * shape that most needs the sweep.
 */
describe('in-memory map bound under flood', () => {
  test('sweeps expired entries on the REJECT path', () => {
    const service = new RateLimiterService();
    const map = trackedMap(service);
    const windowMs = service.getLimitSeconds() * 1000;
    const longExpired = Date.now() - windowMs - 60_000;

    // 25k ids from a previous window, plus one id that is inside the window.
    for (let i = 0; i < 25_000; i++) {
      map.set(`stale-${i}`, longExpired);
    }
    map.set(TRUSTED_ID, Date.now());
    expect(map.size).toBe(25_001);

    // Rejected request: the user is inside their window.
    expect(service.isRateLimited(TRUSTED_ID, null)).toBe(true);

    // Every expired entry is gone. Before the fix the early return skipped the
    // sweep and all 25k stayed put.
    expect(service.getTrackedUserCount()).toBe(1);
    expect(map.has('stale-0')).toBe(false);
  });

  test('sweeps expired entries on the ALLOW path too', () => {
    const service = new RateLimiterService();
    const map = trackedMap(service);
    const windowMs = service.getLimitSeconds() * 1000;

    for (let i = 0; i < 25_000; i++) {
      map.set(`stale-${i}`, Date.now() - windowMs - 60_000);
    }

    expect(service.isRateLimited(TRUSTED_ID, null)).toBe(false);
    expect(service.getTrackedUserCount()).toBe(1);
  });

  test('stays bounded across a flood of rejected requests from many ids', () => {
    const service = new RateLimiterService();
    const map = trackedMap(service);
    const windowMs = service.getLimitSeconds() * 1000;
    const now = Date.now();

    // Seed past the prune threshold with entries from a previous window, then
    // flood with ids that are all already inside the current window.
    for (let i = 0; i < 20_000; i++) {
      map.set(`stale-${i}`, now - windowMs - 60_000);
    }
    const flooders = 5_000;
    for (let i = 0; i < flooders; i++) {
      map.set(`flood-${i}`, now);
    }

    // Every one of these is rejected; the sweep must still run each time.
    for (let i = 0; i < flooders; i++) {
      expect(service.isRateLimited(`flood-${i}`, null)).toBe(true);
    }

    // Bound holds: the stale entries are gone and only the genuinely-active
    // window remains. Nothing accumulates for the rejected ids beyond their own
    // single entry.
    expect(service.getTrackedUserCount()).toBe(flooders);
    expect(map.has('stale-0')).toBe(false);
  });

  test('a rejected id is not given an extra entry', () => {
    const service = new RateLimiterService();
    const map = trackedMap(service);
    const windowMs = service.getLimitSeconds() * 1000;
    const now = Date.now();

    for (let i = 0; i < 20_000; i++) {
      map.set(`stale-${i}`, now - windowMs - 60_000);
    }
    map.set(TRUSTED_ID, now);
    const before = map.get(TRUSTED_ID);

    for (let i = 0; i < 100; i++) {
      expect(service.isRateLimited(TRUSTED_ID, null)).toBe(true);
    }

    expect(map.get(TRUSTED_ID)).toBe(before);
    expect(service.getTrackedUserCount()).toBe(1);
  });
});
