import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import type { APIInteractionGuildMember, GuildMember } from 'discord.js';

/**
 * A slash command's `interaction.member` is a `GuildMember` when the guild is
 * cached, but an `APIInteractionGuildMember` when it is not — and the latter
 * carries `roles` as a plain `string[]` of snowflakes with no role names.
 * Both shapes have to be accepted or the trusted-role gate fails silently.
 */
export type RoleHolder = GuildMember | APIInteractionGuildMember | null | undefined;

/** Shared with `model-selector`, which creates the same table. */
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
    this.db = new Database(SETTINGS_DB);
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
   * Whether this member holds one of the trusted roles in
   * `RATE_LIMIT_EXEMPT_ROLES`, matched by snowflake ID or by exact name
   * (case-insensitive). That list doubles as the privileged-command allowlist,
   * so this is the single place the trusted set is interpreted.
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
    const lastTime = this.lastRequestTimes.get(userId) || 0;

    if (now - lastTime < windowMs) {
      return true; // Rate limited
    }

    this.pruneIfNeeded(now, windowMs);
    this.lastRequestTimes.set(userId, now);
    return false;
  }

  public getExemptRoles(): string[] {
    return config.rateLimit.exemptRoles;
  }
}

export const rateLimiterService = new RateLimiterService();
