import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import { dbPath } from '../utils/paths';
import type { APIInteractionGuildMember, GuildMember } from 'discord.js';

/**
 * A slash command's `interaction.member` is a `GuildMember` when the guild is
 * cached, but an `APIInteractionGuildMember` when it is not — and the latter
 * carries `roles` as a plain `string[]` of snowflakes with no role names.
 * Both shapes have to be accepted or the trusted-role gate fails silently.
 */
export type RoleHolder = GuildMember | APIInteractionGuildMember | null | undefined;

/**
 * Shared with `model-selector`, which creates the same table.
 *
 * Resolved through {@link dbPath} rather than used as a bare relative name: a
 * CWD-relative `new Database('dashboard_settings.db')` silently opens a *new,
 * empty* file when the process is started from anywhere other than the repo
 * root, which would reset the persisted `/ratelimit set` window with no error.
 */
const SETTINGS_DB = 'dashboard_settings.db';
const RATE_LIMIT_SECONDS_KEY = 'rate_limit_seconds';

/**
 * Only sweep once the map gets this big, so the common path stays a single
 * Map lookup with no iteration at all.
 */
const PRUNE_THRESHOLD = 10_000;

export class RateLimiterService {
  private lastRequestTimes: Map<string, number> = new Map();
  private rateLimitSeconds: number;
  private db: Database;

  constructor() {
    this.db = new Database(dbPath(SETTINGS_DB));
    this.initDatabase();

    const persisted = this.loadPersistedSeconds();
    this.rateLimitSeconds = persisted ?? config.rateLimit.seconds;

    if (persisted !== null && persisted !== config.rateLimit.seconds) {
      console.log(
        `⏱️ [RATE LIMIT] Window is ${this.rateLimitSeconds}s (set via /ratelimit; RATE_LIMIT_SECONDS=${config.rateLimit.seconds})`
      );
    } else {
      console.log(`⏱️ [RATE LIMIT] Window is ${this.rateLimitSeconds}s (from RATE_LIMIT_SECONDS)`);
    }
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /**
   * The window last set with `/ratelimit set`, or null when it has never been
   * set or the stored value is unusable. Survives a restart, so the command is
   * not silently undone by a redeploy.
   */
  private loadPersistedSeconds(): number | null {
    try {
      const row = this.db
        .query('SELECT value FROM settings WHERE key = ?')
        .get(RATE_LIMIT_SECONDS_KEY) as { value: string } | undefined;
      if (!row) return null;
      const parsed = Number.parseInt(row.value, 10);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
    } catch (error) {
      console.error('⏱️ [RATE LIMIT] Failed to read persisted window:', error);
      return null;
    }
  }

  private persistSeconds(seconds: number): void {
    try {
      this.db.run(
        'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        [RATE_LIMIT_SECONDS_KEY, String(seconds), new Date().toISOString()]
      );
    } catch (error) {
      // The in-memory value is already applied; failing to persist only means
      // the setting is lost on the next restart.
      console.error('⏱️ [RATE LIMIT] Failed to persist window:', error);
    }
  }

  public setLimitSeconds(seconds: number): void {
    this.rateLimitSeconds = Math.max(1, seconds);
    this.persistSeconds(this.rateLimitSeconds);
  }

  public getLimitSeconds(): number {
    return this.rateLimitSeconds;
  }

  /**
   * Whether this member holds one of the roles in `RATE_LIMIT_EXEMPT_ROLES`,
   * matched by snowflake ID **or** by exact name (case-insensitive).
   *
   * THIS IS A RATE-LIMIT BYPASS ONLY — it is not an authorisation check.
   *
   * Matching a role by name looks unsafe, and for a permission gate it is:
   * role names are not unique and not operator-controlled, so any guild admin
   * anywhere can mint a role called `Moderator` and hand it to their own
   * member. That is why {@link canRunPrivilegedCommand} in
   * `utils/permissions.ts` does **not** use this method, and instead matches
   * snowflake IDs from `TRUSTED_ROLE_IDS`.
   *
   * It is acceptable here because the granted capability is strictly
   * self-limiting: a bypass grants the holder more of *their own* chat quota
   * in the current guild. It cannot write bot configuration, cannot reach
   * another guild's state, and cannot affect any other user. The worst outcome
   * of a name collision is that one member of one guild is not rate limited.
   *
   * Name matching only works for a cached `GuildMember`: the raw API shape
   * carries snowflakes alone, so an uncached guild can only match on ID.
   */
  public hasExemptRole(member: RoleHolder): boolean {
    const exempt = config.rateLimit.exemptRoles;
    if (exempt.length === 0 || !member) {
      return false;
    }

    // Uncached guild: roles is string[] of snowflakes.
    const apiRoles = (member as APIInteractionGuildMember).roles;
    if (Array.isArray(apiRoles)) {
      return apiRoles.some((id) => typeof id === 'string' && exempt.includes(id));
    }

    // Cached guild: roles is a Collection, so names are available too.
    const cached = member as GuildMember;
    if (!cached.roles?.cache) {
      return false;
    }
    return cached.roles.cache.some(
      (role) =>
        exempt.includes(role.id) ||
        exempt.some((configured) => configured.toLowerCase() === role.name.toLowerCase())
    );
  }

  /**
   * Drop expired entries once the map grows past the threshold. Entries are
   * never removed otherwise, so without this the map — the limiter's entire
   * state — would grow monotonically for the life of the process.
   *
   * Called from both the allow and the reject path (see `isRateLimited`), so
   * the sweep is not skipped by a burst of over-limit traffic. The size of the
   * map is bounded by the threshold plus the number of ids that are genuinely
   * inside the current window; ids outside the window are always removed on the
   * next request.
   */
  private pruneIfNeeded(now: number, windowMs: number): void {
    if (this.lastRequestTimes.size <= PRUNE_THRESHOLD) {
      return;
    }
    const cutoff = now - windowMs;
    for (const [userId, at] of this.lastRequestTimes) {
      if (at < cutoff) {
        this.lastRequestTimes.delete(userId);
      }
    }
  }

  public isRateLimited(userId: string, member: RoleHolder): boolean {
    // 1. Owner is always exempt
    if (userId === config.bot.ownerId) {
      return false;
    }

    // 2. Trusted roles are always exempt
    if (this.hasExemptRole(member)) {
      return false;
    }

    const now = Date.now();
    const windowMs = this.rateLimitSeconds * 1000;

    // Prune BEFORE the early return, not after it.
    //
    // When this ran only on the allow path, a burst of *rejected* requests never
    // swept the map, so entries accumulated without bound under exactly the
    // traffic shape (many distinct ids, all over their limit) that most needs
    // the sweep. Sweeping on every path makes the map track "ids active within
    // the current window" instead of "ids ever seen since the last allow".
    this.pruneIfNeeded(now, windowMs);

    const lastTime = this.lastRequestTimes.get(userId) || 0;

    if (now - lastTime < windowMs) {
      // The timestamp is deliberately NOT refreshed on a rejected attempt.
      //
      // Refreshing would make the limit stricter (a user who keeps trying
      // cannot retry at all until they go quiet for a full window), but it
      // also converts every accidental double-tap or client retry into a full
      // window lockout: the user cannot escape it by waiting, only by stopping
      // entirely. Keeping the window anchored to the last *allowed* request is
      // the standard fixed-window behaviour, is self-healing, and cannot be
      // used to permanently deny anyone — including yourself.
      return true; // Rate limited
    }

    this.lastRequestTimes.set(userId, now);
    return false;
  }

  /**
   * Number of tracked ids. Exposed for tests and diagnostics that assert the
   * in-memory map stays bounded; not part of any command's behaviour.
   */
  public getTrackedUserCount(): number {
    return this.lastRequestTimes.size;
  }

  /**
   * The configured rate-limit bypass list (`RATE_LIMIT_EXEMPT_ROLES`), which
   * may contain names as well as snowflakes. See {@link hasExemptRole} for why
   * name entries are safe in *this* list and must never authorise a command.
   */
  public getExemptRoles(): string[] {
    return config.rateLimit.exemptRoles;
  }
}

export const rateLimiterService = new RateLimiterService();
