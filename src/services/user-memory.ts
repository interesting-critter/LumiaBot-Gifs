import { Database } from 'bun:sqlite';
import { dbPath } from '../utils/paths';
import { config } from '../utils/config';

export const PRONOUN_FALLBACK = 'No pronouns on record — use gender-neutral they/them when referring to this user.';

/**
 * Guild scope assigned to rows written before memories were guild-scoped, and
 * the scope used by callers that cannot supply a Discord guild id (DMs, scripts,
 * and any call site that has not been threaded yet).
 *
 * WHY A SENTINEL AND NOT "EVERY GUILD"
 * ------------------------------------
 * Reads that do not know their guild must NOT fall back to a global view: that
 * was the cross-server leak this schema change exists to close (one member of
 * any guild could ask the bot what it "knew" about a person it had only ever
 * seen in a different server, including third-party gossip). A sentinel is a
 * real, isolated bucket: an unthreaded caller sees pre-migration rows and
 * nothing written for an actual guild. That fails closed — the safe direction.
 */
export const LEGACY_GUILD_SCOPE = 'legacy';

/**
 * Internal marker meaning "do not filter by guild at all".
 *
 * Only the owner-facing surfaces (dashboard, wipe script, aggregate stats) are
 * allowed to use it. Everything the model can see is guild-scoped.
 */
const ANY_GUILD = '*';

/** Discord snowflakes: 17-20 digits today, wider bounds kept for safety. */
const DISCORD_ID_PATTERN = /^\d{5,32}$/;

export interface UserSearchResult {
  userId: string;
  username: string;
  pronouns: string | null;
  sentiment: string;
  opinionSnippet: string;
  matchScore: number;
}

/**
 * Resolve a caller-supplied guild id to a storage scope.
 *
 * Blank/undefined/absent guild context collapses to {@link LEGACY_GUILD_SCOPE}
 * rather than to a global view. Callers that hold a real Discord guild id
 * should pass it; every method below takes one as an optional trailing
 * argument for exactly that reason.
 */
export function resolveGuildScope(guildId?: string | null): string {
  const trimmed = guildId?.trim();
  return trimmed ? trimmed : LEGACY_GUILD_SCOPE;
}

/**
 * Splits a username on _, -, whitespace, and camelCase/digit boundaries.
 * "nanotech42" → ["nanotech", "42"]
 * "nano_plays" → ["nano", "plays"]
 * "NanoTech"   → ["nano", "tech"]
 */
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → split
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')    // letter→digit boundary
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')    // digit→letter boundary
    .split(/[_\-\s]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 0);
}

/**
 * Standard Levenshtein edit distance, O(min(m,n)) space.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length > b.length) [a, b] = [b, a];
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let curr = new Array(m + 1);

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i]! + 1,       // deletion
        curr[i - 1]! + 1,   // insertion
        prev[i - 1]! + cost  // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m]!;
}

/**
 * Compute a fuzzy match score (0-100) between a search query and a candidate username.
 *
 * Tier 1: Exact match (case-insensitive)         → 100
 * Tier 2: Query is prefix of candidate            → 70-100
 * Tier 3: Query is substring of candidate         → 50-70
 * Tier 4: Query matches a token exactly/prefix    → 60-75
 * Tier 5: Multi-token query partial matches       → 40-65
 * Tier 6: Edit distance similarity >= 60%         → 18-35
 *
 * Tiers 1-5 are all expressible as `LIKE` predicates against the precomputed
 * `username_norm` column, so {@link UserMemoryService.searchUsers} only runs
 * this function over an already-narrowed candidate set. Tier 6 is the only
 * expensive tier and is bounded separately.
 */
function computeFuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  // Tier 1: Exact match
  if (q === c) return 100;

  // Tier 2: Query is prefix
  if (c.startsWith(q)) {
    const ratio = q.length / c.length;
    return 70 + Math.round(ratio * 30);
  }

  // Tier 3: Query is substring
  if (c.includes(q)) {
    const ratio = q.length / c.length;
    return 50 + Math.round(ratio * 20);
  }

  // Tier 4 & 5: Token-based matching
  const candidateTokens = tokenize(candidate);
  const queryTokens = tokenize(query);

  if (queryTokens.length === 1) {
    // Tier 4: Single query token — check against each candidate token
    for (const ct of candidateTokens) {
      if (ct === q) return 75;
      if (ct.startsWith(q)) {
        const ratio = q.length / ct.length;
        return 60 + Math.round(ratio * 15);
      }
    }
  } else if (queryTokens.length > 1) {
    // Tier 5: Multi-token — count how many query tokens match a candidate token
    let matched = 0;
    for (const qt of queryTokens) {
      for (const ct of candidateTokens) {
        if (ct === qt || ct.startsWith(qt)) {
          matched++;
          break;
        }
      }
    }
    if (matched > 0) {
      const ratio = matched / queryTokens.length;
      return 40 + Math.round(ratio * 25);
    }
  }

  // Tier 6: Edit distance fallback
  const dist = levenshteinDistance(q, c);
  const maxLen = Math.max(q.length, c.length);
  const similarity = 1 - dist / maxLen;
  if (similarity >= 0.6) {
    return 18 + Math.round(similarity * 17);
  }

  return 0;
}

export interface UserOpinion {
  id?: number;
  userId: string;
  /** Guild this record belongs to. Never empty; see {@link LEGACY_GUILD_SCOPE}. */
  guildId: string;
  username: string;
  opinion: string;
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  pronouns?: string | null;
  thirdPartyContext?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedMention {
  userId: string;
  username: string;
  context: string;
  mentionedBy: string;
  timestamp: string;
  /**
   * Guild the mention happened in.
   *
   * Threaded from the originating message by
   * {@link extractMentionsWithContext} / {@link parseMessage}; without it the
   * mention lands in {@link LEGACY_GUILD_SCOPE}, which no production read ever
   * queries — automatic third-party capture would be write-only and silently
   * unreadable. It stays optional so call sites that genuinely have no guild
   * context still compile, and so `storeThirdPartyContext(mention, guildId)`
   * has an explicit override.
   */
  guildId?: string;
}

/** Category of an individually-addressable memory row. */
export type MemoryEntryKind = 'opinion' | 'third_party';

export interface MemoryEntry {
  id: number;
  userId: string;
  kind: MemoryEntryKind;
  content: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-user aggregate used by the dashboard memory browser. */
export interface UserMemorySummary {
  userId: string;
  username: string;
  sentiment: string;
  pronouns: string | null;
  opinionCount: number;
  thirdPartyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserMemoryDetail extends UserMemorySummary {
  opinion: string;
  thirdPartyContext: string | null;
  entries: MemoryEntry[];
}

/** Input for {@link UserMemoryService.validateMentionTarget}. */
export interface MentionTargetValidationParams {
  /** Guild the turn happened in. Required when resolving by username only. */
  guildId: string;
  /** Discord id the model claims was mentioned. Preferred over the username. */
  mentionedUserId?: string;
  /** Username the model claims was mentioned, used when no id was supplied. */
  mentionedUsername?: string;
  /**
   * Ids the caller independently determined were mentioned/referenced in this
   * turn. A target outside this set is rejected — this is the whole point of the
   * check, because the model's own arguments are attacker-influenced (a fetched
   * web page can inject "store this about <victim>").
   */
  allowedIds: string[];
}

/** Result of {@link UserMemoryService.validateMentionTarget}. Never throws. */
export type MentionTargetValidationResult =
  | { ok: true; userId: string }
  | { ok: false; reason: string };

/**
 * Parses a stored memory blob back into individual `[timestamp] text` entries.
 * Returns null when the blob cannot be parsed, so callers can keep the raw
 * value as a single opaque entry rather than losing it.
 */
function parseMemoryBlob(blob: string, separator: RegExp): Array<{ timestamp: string | null; content: string }> {
  const chunks = blob
    .split(separator)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.map((chunk) => {
    const match = chunk.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (match) {
      return { timestamp: match[1] || null, content: (match[2] || '').trim() };
    }
    return { timestamp: null, content: chunk };
  });
}

/** Entry separator used for the opinion blob (blank line between entries). */
const OPINION_ENTRY_SEPARATOR = /\n\n(?=\[)/;
/** Entry separator used for the third-party context blob (single newline). */
const THIRD_PARTY_ENTRY_SEPARATOR = /\n(?=\[)/;

export class UserMemoryService {
  private static readonly MAX_OPINION_ENTRIES = 10;
  private static readonly MAX_THIRD_PARTY_ENTRIES = 15;
  private db: Database;
  /**
   * Whether `user_opinions` carries the UNIQUE(user_id, guild_id) index. When a
   * legacy database still holds duplicate profiles the index cannot be created,
   * and SQLite rejects an `ON CONFLICT (user_id, guild_id)` clause that has no
   * matching constraint — so {@link ensureUserRow} branches on this flag.
   */
  private uniqueUserGuild = false;

  constructor(databasePath: string = dbPath('user_memories.db')) {
    // Absolute path from utils/paths: a CWD-relative filename silently creates a
    // brand-new empty database when the bot is started from another directory.
    this.db = new Database(databasePath);
    this.applyPragmas();
    this.initDatabase();
  }

  private applyPragmas(): void {
    try {
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA busy_timeout = 5000');
    } catch (error) {
      console.warn('💾 [USER MEMORY] Could not enable WAL/busy_timeout:', error);
    }
  }

  private transactionDepth = 0;

  /**
   * Run `work` inside a transaction, reusing the outer one when nested.
   *
   * `ensureUserRow` falls back to a SELECT-then-INSERT transaction when the
   * UNIQUE index is unavailable, and it is itself called from transactional
   * writers — a nested `BEGIN` would throw "cannot start a transaction within
   * a transaction" and abort the write.
   */
  private transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) {
      return work();
    }

    this.db.run('BEGIN');
    this.transactionDepth++;
    try {
      const result = work();
      this.db.run('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Ignore rollback failures; the original error is what matters.
      }
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  private initDatabase(): void {
    // Create table if it doesn't exist
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL DEFAULT 'legacy',
        username TEXT NOT NULL,
        username_norm TEXT NOT NULL DEFAULT '',
        opinion TEXT NOT NULL,
        sentiment TEXT NOT NULL,
        pronouns TEXT,
        third_party_context TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create index for faster lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_id ON user_opinions(user_id)
    `);

    // Migration: Add missing columns if table exists but columns don't
    this.migrateAddColumn('user_opinions', 'pronouns', 'TEXT');
    this.migrateAddColumn('user_opinions', 'third_party_context', 'TEXT');

    this.initEntriesTable();
    this.migrateGuildScope();
    this.migrateBlobsToEntries();

    console.log('💾 [USER MEMORY] Database initialized');
  }

  private initEntriesTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL DEFAULT 'legacy',
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_entries_user_kind ON user_memory_entries(user_id, kind)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
  }

  private hasMigration(name: string): boolean {
    const row = this.db
      .query('SELECT COUNT(*) as count FROM schema_migrations WHERE name = ?')
      .get(name) as { count: number };
    return row.count > 0;
  }

  private markMigration(name: string): void {
    this.db.run(
      'INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      [name, new Date().toISOString()]
    );
  }

  /**
   * Add a column when `PRAGMA table_info` reports it missing. Idempotent: the
   * existence check is the guard, so this is safe on every startup.
   */
  private migrateAddColumn(
    table: string,
    columnName: string,
    columnType: string,
    defaultValue?: string,
  ): void {
    try {
      const result = this.db.query(
        `SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name = ?`
      ).get(table, columnName) as { count: number };

      if (result.count === 0) {
        const suffix = defaultValue === undefined ? '' : ` NOT NULL DEFAULT '${defaultValue}'`;
        this.db.run(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${columnType}${suffix}`);
        console.log(`💾 [USER MEMORY] Migration: Added column '${table}.${columnName}'`);
      }
    } catch (error) {
      console.error(`💾 [USER MEMORY] Migration failed for column '${table}.${columnName}':`, error);
    }
  }

  /**
   * Guild-scoping migration.
   *
   * Runs on every startup and is idempotent:
   *   1. `guild_id` is added to `user_opinions` and `user_memory_entries` when
   *      absent, defaulting existing rows to the {@link LEGACY_GUILD_SCOPE}
   *      sentinel — no rows are dropped or rewritten.
   *   2. `username_norm` (lowercased username) is added and backfilled, so the
   *      cheap search tiers are index-backed instead of a table scan.
   *   3. Duplicate profiles that predate the UNIQUE constraint are merged into
   *      the most recently updated row (the duplicates only ever existed because
   *      of an unguarded SELECT-then-INSERT; the memory content itself lives in
   *      `user_memory_entries` and is untouched).
   *   4. UNIQUE(user_id, guild_id) and the (user, guild, kind, created_at)
   *      index are created.
   */
  private migrateGuildScope(): void {
    this.migrateAddColumn('user_opinions', 'guild_id', 'TEXT', LEGACY_GUILD_SCOPE);
    this.migrateAddColumn('user_memory_entries', 'guild_id', 'TEXT', LEGACY_GUILD_SCOPE);
    this.migrateAddColumn('user_opinions', 'username_norm', 'TEXT', '');

    const MIGRATION = 'guild_scope_v1';

    try {
      // Belt and braces: the ALTER default already fills these, but a database
      // written by an intermediate build could hold NULL/'' values.
      this.db.run(
        `UPDATE user_opinions SET guild_id = ? WHERE guild_id IS NULL OR guild_id = ''`,
        [LEGACY_GUILD_SCOPE]
      );
      this.db.run(
        `UPDATE user_memory_entries SET guild_id = ? WHERE guild_id IS NULL OR guild_id = ''`,
        [LEGACY_GUILD_SCOPE]
      );
      this.db.run(
        `UPDATE user_opinions SET username_norm = LOWER(username)
         WHERE username_norm IS NULL OR username_norm = '' OR username_norm <> LOWER(username)`
      );

      if (!this.hasMigration(MIGRATION)) {
        this.mergeDuplicateProfiles();
        this.markMigration(MIGRATION);
      }

      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_entries_user_guild_kind
        ON user_memory_entries(user_id, guild_id, kind, created_at DESC, id DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_opinions_guild ON user_opinions(guild_id, updated_at DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_opinions_username_norm ON user_opinions(username_norm)
      `);

      try {
        this.db.run(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_user_guild_unique
          ON user_opinions(user_id, guild_id)
        `);
        this.uniqueUserGuild = true;
      } catch (error) {
        // mergeDuplicateProfiles() should have cleared the way; if it could not
        // (locked DB, concurrent writer), fall back to the transactional
        // SELECT-then-INSERT path in ensureUserRow instead of failing to boot.
        this.uniqueUserGuild = false;
        console.error('💾 [USER MEMORY] Could not create UNIQUE(user_id, guild_id) index:', error);
      }
    } catch (error) {
      this.uniqueUserGuild = false;
      console.error('💾 [USER MEMORY] Guild-scope migration failed:', error);
    }
  }

  /**
   * Collapse duplicate `user_opinions` rows for the same (user, guild) into the
   * most recently updated one, carrying over a pronoun/blob value when the
   * survivor does not have one. Memory rows in `user_memory_entries` are keyed
   * by user and kind, so nothing is lost by removing a duplicate profile.
   */
  private mergeDuplicateProfiles(): void {
    const duplicates = this.db
      .query(
        `SELECT user_id, guild_id, COUNT(*) as count
         FROM user_opinions
         GROUP BY user_id, guild_id
         HAVING count > 1`
      )
      .all() as Array<{ user_id: string; guild_id: string; count: number }>;

    if (duplicates.length === 0) {
      return;
    }

    let removed = 0;

    this.transaction(() => {
      for (const group of duplicates) {
        const rows = this.db
          .query(
            `SELECT id, username, username_norm, opinion, pronouns, third_party_context, updated_at
             FROM user_opinions
             WHERE user_id = ? AND guild_id = ?
             ORDER BY updated_at DESC, id DESC`
          )
          .all(group.user_id, group.guild_id) as Array<{
            id: number;
            username: string;
            username_norm: string;
            opinion: string;
            pronouns: string | null;
            third_party_context: string | null;
            updated_at: string;
          }>;

        const keeper = rows[0];
        if (!keeper) continue;

        const pronouns = keeper.pronouns ?? rows.map(r => r.pronouns).find(Boolean) ?? null;
        const opinion = keeper.opinion || rows.map(r => r.opinion).find(Boolean) || '';
        const thirdParty =
          keeper.third_party_context ?? rows.map(r => r.third_party_context).find(Boolean) ?? null;
        const usernameNorm = keeper.username_norm || keeper.username.toLowerCase();

        for (const row of rows.slice(1)) {
          this.db.run('DELETE FROM user_opinions WHERE id = ?', [row.id]);
          removed++;
        }

        this.db.run(
          `UPDATE user_opinions
           SET username = ?, username_norm = ?, opinion = ?, pronouns = ?, third_party_context = ?
           WHERE id = ?`,
          [keeper.username, usernameNorm, opinion, pronouns, thirdParty, keeper.id]
        );
      }
    });

    console.log(`💾 [USER MEMORY] Merged ${removed} duplicate user profile row(s)`);
  }

  /**
   * One-time migration: split the legacy `user_opinions.opinion` and
   * `third_party_context` text blobs into individually-addressable rows so the
   * dashboard can edit/delete single memories instead of rewriting the blob.
   *
   * The blobs are cleared afterwards so `getOpinion` has a single source of
   * truth. Guarded by schema_migrations so it never runs twice.
   */
  private migrateBlobsToEntries(): void {
    const MIGRATION = 'user_memory_entries_v1';

    if (this.hasMigration(MIGRATION)) {
      return;
    }

    try {
      this.transaction(() => {
        const rows = this.db
          .query('SELECT user_id, guild_id, opinion, third_party_context FROM user_opinions')
          .all() as Array<{
            user_id: string;
            guild_id: string;
            opinion: string;
            third_party_context: string | null;
          }>;

        let migrated = 0;

        for (const row of rows) {
          const guildId = row.guild_id || LEGACY_GUILD_SCOPE;

          if (row.opinion) {
            for (const entry of parseMemoryBlob(row.opinion, OPINION_ENTRY_SEPARATOR)) {
              if (!entry.content) continue;
              this.db.run(
                `INSERT INTO user_memory_entries (user_id, guild_id, kind, content, source, created_at, updated_at)
                 VALUES (?, ?, 'opinion', ?, 'legacy-migration', ?, ?)`,
                [row.user_id, guildId, entry.content, entry.timestamp || new Date().toISOString(), new Date().toISOString()]
              );
              migrated++;
            }
          }

          if (row.third_party_context) {
            for (const entry of parseMemoryBlob(row.third_party_context, THIRD_PARTY_ENTRY_SEPARATOR)) {
              if (!entry.content) continue;
              this.db.run(
                `INSERT INTO user_memory_entries (user_id, guild_id, kind, content, source, created_at, updated_at)
                 VALUES (?, ?, 'third_party', ?, 'legacy-migration', ?, ?)`,
                [row.user_id, guildId, entry.content, entry.timestamp || new Date().toISOString(), new Date().toISOString()]
              );
              migrated++;
            }
          }
        }

        // Blobs are now redundant; clear them so reads come from the entries table.
        this.db.run(`UPDATE user_opinions SET opinion = '', third_party_context = NULL`);
        this.markMigration(MIGRATION);
        console.log(`💾 [USER MEMORY] Migrated ${migrated} legacy memory entr${migrated === 1 ? 'y' : 'ies'} to user_memory_entries`);
      });
    } catch (error) {
      console.error('💾 [USER MEMORY] Legacy blob migration failed (will retry on next start):', error);
    }
  }

  /** SQL fragment + params restricting a query to one guild scope (or all). */
  private scopeClause(scope: string | null, column: string = 'guild_id'): { sql: string; params: string[] } {
    if (scope === ANY_GUILD || scope === null) {
      return { sql: '', params: [] };
    }
    return { sql: ` AND ${column} = ?`, params: [scope] };
  }

  /**
   * Insert a single memory row and enforce the rolling-window cap by deleting
   * the oldest rows beyond `maxEntries` for that (user, guild, kind) triple.
   *
   * Scoping the cap per guild matters: with a per-(user, kind) cap, a user who
   * was very active in one server would silently evict everything the bot
   * remembered about them in another.
   */
  private insertEntry(
    userId: string,
    guildId: string,
    kind: MemoryEntryKind,
    content: string,
    maxEntries: number,
    source: string | null = null,
    createdAt: string = new Date().toISOString(),
  ): number {
    const result = this.db.run(
      `INSERT INTO user_memory_entries (user_id, guild_id, kind, content, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, guildId, kind, content, source, createdAt, createdAt]
    );

    this.db.run(
      `DELETE FROM user_memory_entries
       WHERE user_id = ? AND guild_id = ? AND kind = ? AND id NOT IN (
         SELECT id FROM user_memory_entries
         WHERE user_id = ? AND guild_id = ? AND kind = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )`,
      [userId, guildId, kind, userId, guildId, kind, maxEntries]
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Ensure a `user_opinions` row exists so the user appears in listings.
   *
   * Single-statement upsert: with UNIQUE(user_id, guild_id) in place this can
   * no longer race with itself, and it cannot leave duplicate rows behind even
   * if a future refactor introduces an `await` between statements. When the
   * index is unavailable (a legacy database that still has duplicates), the
   * guarded transaction below provides the same guarantee.
   */
  private ensureUserRow(userId: string, guildId: string, username: string): void {
    const now = new Date().toISOString();
    const norm = username.toLowerCase();

    if (this.uniqueUserGuild) {
      this.db.run(
        `INSERT INTO user_opinions (user_id, guild_id, username, username_norm, opinion, sentiment, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 'neutral', ?, ?)
         ON CONFLICT(user_id, guild_id) DO NOTHING`,
        [userId, guildId, username, norm, now, now]
      );
      this.db.run(
        'UPDATE user_opinions SET username = ?, username_norm = ? WHERE user_id = ? AND guild_id = ?',
        [username, norm, userId, guildId]
      );
      return;
    }

    this.transaction(() => {
      const existing = this.db
        .query('SELECT id FROM user_opinions WHERE user_id = ? AND guild_id = ? LIMIT 1')
        .get(userId, guildId) as { id: number } | undefined;

      if (existing) {
        this.db.run('UPDATE user_opinions SET username = ?, username_norm = ? WHERE id = ?', [
          username,
          norm,
          existing.id,
        ]);
        return;
      }

      this.db.run(
        `INSERT INTO user_opinions (user_id, guild_id, username, username_norm, opinion, sentiment, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 'neutral', ?, ?)`,
        [userId, guildId, username, norm, now, now]
      );
    });
  }

  /**
   * Store a new opinion about a user.
   *
   * `guildId` is optional for backwards compatibility with call sites that have
   * not been threaded yet; when omitted the memory is stored under
   * {@link LEGACY_GUILD_SCOPE} and will not be visible to a guild-scoped read.
   */
  storeOpinion(
    userId: string,
    username: string,
    opinion: string,
    sentiment: UserOpinion['sentiment'],
    guildId?: string,
  ): void {
    const scope = resolveGuildScope(guildId);
    const now = new Date().toISOString();
    const isNewUser = !this.hasOpinion(userId, scope);

    this.transaction(() => {
      this.ensureUserRow(userId, scope, username);

      // The blob column is kept empty; entries are the source of truth.
      this.db.run(
        `UPDATE user_opinions SET sentiment = ?, updated_at = ? WHERE user_id = ? AND guild_id = ?`,
        [sentiment, now, userId, scope]
      );

      this.insertEntry(userId, scope, 'opinion', opinion, UserMemoryService.MAX_OPINION_ENTRIES, 'store_user_opinion');
    });

    const count = this.getEntryCount(userId, 'opinion', scope);
    console.log(
      `💾 [USER MEMORY] ${isNewUser ? 'Stored new' : 'Updated'} opinion for ${username} in guild ${scope} (${sentiment}, ${count} entries)`
    );
  }

  /**
   * Store or update user's pronouns.
   */
  storePronouns(userId: string, username: string, pronouns: string, guildId?: string): void {
    const scope = resolveGuildScope(guildId);
    const now = new Date().toISOString();
    const isNewUser = !this.hasOpinion(userId, scope);

    this.transaction(() => {
      this.ensureUserRow(userId, scope, username);
      this.db.run(
        `UPDATE user_opinions SET pronouns = ?, updated_at = ? WHERE user_id = ? AND guild_id = ?`,
        [pronouns, now, userId, scope]
      );

      if (isNewUser) {
        this.insertEntry(userId, scope, 'opinion', 'First interaction', UserMemoryService.MAX_OPINION_ENTRIES, 'store_pronouns');
      }
    });

    console.log(
      `💾 [USER MEMORY] ${isNewUser ? 'Stored new user' : 'Updated pronouns for'} ${username} in guild ${scope}: ${pronouns}`
    );
  }

  /**
   * Store third-party context about a user (what others say about them).
   *
   * The guild comes from the explicit `guildId` argument, falling back to
   * `mention.guildId` and then to {@link LEGACY_GUILD_SCOPE}. Callers MUST
   * validate the target with {@link validateMentionTarget} first: this method
   * writes whatever it is handed, and it is reachable from an LLM tool.
   */
  storeThirdPartyContext(mention: ExtractedMention, guildId?: string): void {
    const scope = resolveGuildScope(guildId ?? mention.guildId);
    const now = new Date().toISOString();
    const isNewUser = !this.hasOpinion(mention.userId, scope);

    this.transaction(() => {
      this.ensureUserRow(mention.userId, scope, mention.username);
      this.db.run(
        `UPDATE user_opinions SET updated_at = ? WHERE user_id = ? AND guild_id = ?`,
        [now, mention.userId, scope]
      );

      if (isNewUser) {
        this.insertEntry(
          mention.userId,
          scope,
          'opinion',
          `Mentioned by ${mention.mentionedBy}`,
          UserMemoryService.MAX_OPINION_ENTRIES,
          'store_third_party_context'
        );
      }

      const content = `${mention.mentionedBy} mentioned: "${mention.context}"`;
      this.insertEntry(
        mention.userId,
        scope,
        'third_party',
        content,
        UserMemoryService.MAX_THIRD_PARTY_ENTRIES,
        'store_third_party_context'
      );
    });

    const count = this.getEntryCount(mention.userId, 'third_party', scope);
    console.log(`💾 [USER MEMORY] Added third-party context for ${mention.username} in guild ${scope} (${count} entries)`);
  }

  /**
   * Validate a mention target supplied by an LLM tool call.
   *
   * The model chooses `mentionedUserId` / `mentionedUsername` from its own
   * context, which includes fetched web pages — i.e. it is attacker-controlled
   * input. Without this check, a prompt injection could make the bot append
   * fabricated "what others said about X" to any user's record, which is then
   * replayed back to them in every later conversation.
   *
   * Semantics:
   *   - Blank/unknown ids are rejected.
   *   - An id outside `allowedIds` — the users the caller independently saw
   *     referenced in this turn — is rejected. This is the security boundary.
   *   - When only a username is supplied, it is resolved against this guild's
   *     stored profiles and the resolved id must also be in `allowedIds`.
   *   - Never throws; failures come back as `{ ok: false, reason }`.
   */
  async validateMentionTarget(
    params: MentionTargetValidationParams,
  ): Promise<MentionTargetValidationResult> {
    try {
      const allowed = Array.isArray(params?.allowedIds)
        ? new Set(params.allowedIds.map(id => id.trim()).filter(Boolean))
        : new Set<string>();

      if (allowed.size === 0) {
        return { ok: false, reason: 'No users were mentioned in this turn, so no mention target can be validated.' };
      }

      const candidateId = params?.mentionedUserId?.trim();

      if (candidateId) {
        if (!DISCORD_ID_PATTERN.test(candidateId)) {
          return { ok: false, reason: `"${candidateId}" is not a valid Discord user id.` };
        }
        if (!allowed.has(candidateId)) {
          return {
            ok: false,
            reason: `User ${candidateId} was not mentioned or referenced in this turn; refusing to write memory about them.`,
          };
        }
        return { ok: true, userId: candidateId };
      }

      const username = params?.mentionedUsername?.trim();
      if (!username) {
        return { ok: false, reason: 'No mention target supplied.' };
      }

      const guildId = params?.guildId?.trim();
      if (!guildId) {
        return { ok: false, reason: 'Guild context is required to resolve a mention by username.' };
      }

      const known = this.getOpinionByUsername(username, guildId);
      if (!known || !DISCORD_ID_PATTERN.test(known.userId)) {
        return { ok: false, reason: `No user named "${username}" is known in this guild.` };
      }
      if (!allowed.has(known.userId)) {
        return {
          ok: false,
          reason: `User ${known.userId} was not mentioned or referenced in this turn; refusing to write memory about them.`,
        };
      }

      return { ok: true, userId: known.userId };
    } catch (error) {
      console.error('💾 [USER MEMORY] validateMentionTarget failed:', error);
      return { ok: false, reason: 'Mention validation failed.' };
    }
  }

  /**
   * Sync the stored username with the current Discord username.
   * Prevents stale/incorrect usernames from being injected into the system prompt.
   */
  syncUsername(userId: string, currentUsername: string, guildId?: string): void {
    const scope = resolveGuildScope(guildId);
    const existing = this.db.query(
      'SELECT username FROM user_opinions WHERE user_id = ? AND guild_id = ? LIMIT 1'
    ).get(userId, scope) as { username: string } | undefined;

    if (existing && existing.username !== currentUsername) {
      this.db.run(
        'UPDATE user_opinions SET username = ?, username_norm = ? WHERE user_id = ? AND guild_id = ?',
        [currentUsername, currentUsername.toLowerCase(), userId, scope]
      );
      console.log(`💾 [USER MEMORY] Synced username for ${userId}: "${existing.username}" → "${currentUsername}"`);
    }
  }

  /**
   * Count memory rows for a user in one guild scope, optionally restricted to
   * one kind.
   */
  getEntryCount(userId: string, kind?: MemoryEntryKind, guildId?: string): number {
    const scope = resolveGuildScope(guildId);
    const { sql, params } = this.scopeClause(scope);
    const row = kind
      ? (this.db
          .query(`SELECT COUNT(*) as count FROM user_memory_entries WHERE user_id = ?${sql} AND kind = ?`)
          .get(userId, ...params, kind) as { count: number })
      : (this.db
          .query(`SELECT COUNT(*) as count FROM user_memory_entries WHERE user_id = ?${sql}`)
          .get(userId, ...params) as { count: number });
    return row.count;
  }

  /**
   * List a user's memory rows in one guild scope, newest first.
   */
  listEntries(userId: string, kind?: MemoryEntryKind, guildId?: string): MemoryEntry[] {
    const scope = resolveGuildScope(guildId);
    const { sql, params } = this.scopeClause(scope);
    const kindSql = kind ? ' AND kind = ?' : '';

    const rows = this.db
      .query(
        `SELECT id, user_id, kind, content, source, created_at, updated_at
         FROM user_memory_entries
         WHERE user_id = ?${sql}${kindSql}
         ORDER BY created_at DESC, id DESC`
      )
      .all(userId, ...params, ...(kind ? [kind] : [])) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as number,
      userId: row.user_id as string,
      kind: row.kind as MemoryEntryKind,
      content: row.content as string,
      source: (row.source as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  /**
   * Rebuild the prompt-facing blob strings from the entries table.
   * Entries are stored oldest-first here so the `[timestamp] text` shape the
   * system prompt expects is preserved.
   */
  private buildBlob(userId: string, guildId: string, kind: MemoryEntryKind, separator: string): string {
    const rows = this.db
      .query(
        `SELECT content, created_at FROM user_memory_entries
         WHERE user_id = ? AND guild_id = ? AND kind = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(userId, guildId, kind) as Array<{ content: string; created_at: string }>;

    return rows
      .reverse()
      .map((row) => `[${row.created_at}] ${row.content}`)
      .join(separator);
  }

  /**
   * Map a `user_opinions` row to the camelCase `UserOpinion` shape.
   *
   * SQLite returns raw snake_case column names, so this must be an explicit
   * projection — a bare `SELECT *` cast to `UserOpinion` silently leaves
   * userId/createdAt/updatedAt/thirdPartyContext undefined.
   */
  private rowToOpinion(row: Record<string, unknown> | undefined): UserOpinion | null {
    if (!row) {
      return null;
    }

    const userId = row.user_id as string;
    const guildId = (row.guild_id as string) || LEGACY_GUILD_SCOPE;
    const opinion = this.buildBlob(userId, guildId, 'opinion', '\n\n');
    const thirdParty = this.buildBlob(userId, guildId, 'third_party', '\n');

    return {
      id: row.id as number,
      userId,
      guildId,
      username: row.username as string,
      opinion,
      sentiment: row.sentiment as UserOpinion['sentiment'],
      pronouns: (row.pronouns as string | null) ?? null,
      thirdPartyContext: thirdParty || null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private static readonly OPINION_COLUMNS =
    'id, user_id, guild_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at';

  /**
   * Get opinion for a specific user in one guild scope.
   *
   * With no `guildId` this reads only the {@link LEGACY_GUILD_SCOPE} bucket —
   * never every guild's data.
   */
  getOpinion(userId: string, guildId?: string): UserOpinion | null {
    const scope = resolveGuildScope(guildId);
    const row = this.db
      .query(
        `SELECT ${UserMemoryService.OPINION_COLUMNS}
         FROM user_opinions WHERE user_id = ? AND guild_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(userId, scope) as Record<string, unknown> | undefined;

    const result = this.rowToOpinion(row);

    if (result) {
      console.log(`💾 [USER MEMORY] Retrieved opinion for user ${result.username} in guild ${scope}`);
    }

    return result;
  }

  /**
   * Get opinion by username (case insensitive) within one guild scope.
   */
  getOpinionByUsername(username: string, guildId?: string): UserOpinion | null {
    const scope = resolveGuildScope(guildId);
    const row = this.db
      .query(
        `SELECT ${UserMemoryService.OPINION_COLUMNS}
         FROM user_opinions WHERE guild_id = ? AND username_norm = LOWER(?)
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(scope, username) as Record<string, unknown> | undefined;

    const result = this.rowToOpinion(row);

    if (result) {
      console.log(`💾 [USER MEMORY] Retrieved opinion by username: ${result.username} in guild ${scope}`);
    }

    return result;
  }

  /**
   * List users Lumia has opinions about, in one guild scope.
   */
  listUsers(guildId?: string): Array<{ userId: string; username: string; sentiment: string; updatedAt: string }> {
    const scope = resolveGuildScope(guildId);
    const results = this.db.query(
      `SELECT user_id, username, sentiment, updated_at
       FROM user_opinions
       WHERE guild_id = ?
       ORDER BY updated_at DESC`
    ).all(scope) as Array<{ user_id: string; username: string; sentiment: string; updated_at: string }>;

    console.log(`💾 [USER MEMORY] Listed ${results.length} users with opinions in guild ${scope}`);

    return results.map(r => ({
      userId: r.user_id,
      username: r.username,
      sentiment: r.sentiment,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Delete a user's opinion, along with their memory rows.
   *
   * Erasure is deliberately the one operation that defaults to every guild: an
   * incomplete delete is a privacy failure, and the callers are the owner-only
   * dashboard, the wipe script, and the owner-only `/memories clear-user`. Pass
   * an explicit `guildId` to delete within a single server.
   */
  deleteOpinion(userId: string, guildId?: string): number {
    const scope = guildId === undefined ? ANY_GUILD : resolveGuildScope(guildId);
    const { sql, params } = this.scopeClause(scope);
    const entries = this.db.run(`DELETE FROM user_memory_entries WHERE user_id = ?${sql}`, [userId, ...params]);
    const result = this.db.run(`DELETE FROM user_opinions WHERE user_id = ?${sql}`, [userId, ...params]);
    console.log(
      `💾 [USER MEMORY] Deleted ${result.changes} opinion row(s) and ${entries.changes} memory entr(ies) for user ${userId} (scope ${scope})`
    );
    return result.changes;
  }

  /**
   * Get opinion context string for system prompt.
   */
  getOpinionContext(userId: string, guildId?: string): string {
    const opinion = this.getOpinion(userId, guildId);

    if (!opinion) {
      return '';
    }

    let context = `
<user-memories>
Username: ${opinion.username}
Sentiment: ${opinion.sentiment}
Your thoughts: ${opinion.opinion}
`;

    // Pronouns are displayed in the CURRENT USER CONTEXT section of the system prompt
    // so they are intentionally not duplicated here

    // Add third-party context if exists
    if (opinion.thirdPartyContext) {
      context += `\nWhat others have said:\n${opinion.thirdPartyContext}\n`;
    }

    context += `
Use naturally — don't mention you're "recalling" anything.
</user-memories>`;

    return context;
  }

  /**
   * Get user identity context (username + pronouns) for system prompt
   * This is separate from opinion context and always available
   */
  getUserIdentityContext(userId: string, guildId?: string): string {
    const opinion = this.getOpinion(userId, guildId);

    if (!opinion) {
      return '';
    }

    let context = `**Username:** ${opinion.username}`;

    if (opinion.pronouns) {
      context += `\n**Pronouns:** ${opinion.pronouns}`;
    }

    return context;
  }

  /**
   * Check if a user has any memory in the given scope.
   *
   * With no `guildId` this checks every guild: it is only a boolean, it backs
   * the owner-facing wipe script and dashboard, and a false negative there
   * would silently skip an erasure.
   */
  hasOpinion(userId: string, guildId?: string): boolean {
    const scope = guildId === undefined ? ANY_GUILD : resolveGuildScope(guildId);
    const { sql, params } = this.scopeClause(scope);
    const result = this.db.query(
      `SELECT COUNT(*) as count FROM user_opinions WHERE user_id = ?${sql}`
    ).get(userId, ...params) as { count: number };

    return result.count > 0;
  }

  /**
   * Get pronouns for a user in one guild scope, or null if not set.
   */
  getPronouns(userId: string, guildId?: string): string | null {
    const scope = resolveGuildScope(guildId);
    const result = this.db.query(
      'SELECT pronouns FROM user_opinions WHERE user_id = ? AND guild_id = ? LIMIT 1'
    ).get(userId, scope) as { pronouns: string | null } | undefined;

    return result?.pronouns || null;
  }

  /**
   * The most recent `limit` opinion memories per user, keyed by `user_id|guild`.
   *
   * `user_opinions.opinion` is no longer written — `user_memory_entries` is the
   * single source of truth since the blob migration — so a snippet has to be
   * built from the entries table.
   *
   * The `LIMIT` is a hard safety bound: this used to materialise every opinion
   * row in the database on every `searchUsers` call, and `resolveUserMention`
   * is exposed as a tool the model may call several times per turn.
   */
  private recentOpinionSnippets(limit: number): Map<string, string> {
    const rowCap = Math.max(1, Math.min(limit * 50, 1000));
    const rows = this.db
      .query(
        `SELECT user_id, guild_id, content
         FROM user_memory_entries
         WHERE kind = 'opinion'
         ORDER BY user_id, guild_id, created_at DESC, id DESC
         LIMIT ?`
      )
      .all(rowCap) as Array<{ user_id: string; guild_id: string; content: string }>;

    const perUser = new Map<string, string[]>();
    for (const row of rows) {
      const key = `${row.guild_id}\u241F${row.user_id}`;
      const existing = perUser.get(key);
      if (!existing) {
        perUser.set(key, [row.content]);
      } else if (existing.length < limit) {
        existing.push(row.content);
      }
    }

    const snippets = new Map<string, string>();
    for (const [key, newest] of perUser) {
      snippets.set(key, newest.reverse().join(' | '));
    }
    return snippets;
  }

  /**
   * Fuzzy-search users by partial/informal name within one guild scope.
   *
   * The cheap tiers (exact / prefix / substring / token prefix) run as indexed
   * `LIKE` predicates against `username_norm`, so the full table is never
   * scored in JS. Levenshtein is the expensive tier and is only computed over a
   * bounded recent candidate pool, and only when the cheap tiers did not fill
   * `maxResults`.
   */
  searchUsers(query: string, maxResults: number = 5, guildId?: string): UserSearchResult[] {
    const scope = resolveGuildScope(guildId);
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return [];
    }

    const tokens = tokenize(query);

    // Every predicate is a bound parameter; only the fixed clause *shape* is
    // built by string concatenation. Interpolating the needle here used to be a
    // live injection sink (`x') OR 1=1 --` / `x' UNION SELECT ...` both parsed),
    // reachable from the model-facing `search_users` tool and from
    // `resolveUserMention`. Order matters: these params are consumed in the
    // order the clauses appear below.
    //
    // The equality tier binds the *raw* needle on purpose: `=` has no ESCAPE
    // clause, so escaping `%`/`_` there would make a username containing one
    // impossible to match exactly. Only the LIKE tiers escape.
    const exactNeedle = needle;
    const prefix = `${escapeLike(needle)}%`;
    const contains = `%${escapeLike(needle)}%`;
    const clauseParams: string[] = [exactNeedle, prefix, contains];
    const tokenClauses: string[] = [];

    for (const token of tokens) {
      const escaped = escapeLike(token);
      tokenClauses.push(`username_norm LIKE ? ESCAPE '\\'`);
      tokenClauses.push(`username_norm LIKE ? ESCAPE '\\'`);
      clauseParams.push(`${escaped}%`, `%${escaped}%`);
    }

    const clauses = [
      `username_norm = ?`,
      `username_norm LIKE ? ESCAPE '\\'`,
      `username_norm LIKE ? ESCAPE '\\'`,
      ...tokenClauses,
    ];

    // Candidate cap: the cheap tiers are an index-backed narrowing, so a
    // generous limit keeps recall while bounding the work.
    const candidateLimit = Math.max(25, Math.min(maxResults * 10, 100));

    const rows = this.db.query(
      `SELECT user_id, guild_id, username, pronouns, sentiment
       FROM user_opinions
       WHERE guild_id = ? AND (${clauses.join(' OR ')})
       ORDER BY updated_at DESC
       LIMIT ?`
    ).all(scope, ...clauseParams, candidateLimit) as Array<{
      user_id: string;
      guild_id: string;
      username: string;
      pronouns: string | null;
      sentiment: string;
    }>;

    const scored: UserSearchResult[] = [];

    for (const row of rows) {
      const score = computeFuzzyScore(query, row.username);
      if (score > 0) {
        scored.push({
          userId: row.user_id,
          username: row.username,
          pronouns: row.pronouns,
          sentiment: row.sentiment,
          opinionSnippet: '',
          matchScore: score,
        });
      }
    }

    // Tier 6 (edit distance) is O(n·m) per row, so it runs last and only over a
    // bounded, most-recently-active pool — and only if there is room left.
    if (scored.length < maxResults) {
      const seen = new Set(rows.map(r => r.user_id));
      const fuzzyRows = this.db.query(
        `SELECT user_id, username, pronouns, sentiment
         FROM user_opinions
         WHERE guild_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      ).all(scope, UserMemoryService.FUZZY_CANDIDATE_LIMIT) as Array<{
        user_id: string;
        username: string;
        pronouns: string | null;
        sentiment: string;
      }>;

      for (const row of fuzzyRows) {
        if (seen.has(row.user_id)) continue;
        const score = computeFuzzyScore(query, row.username);
        if (score > 0) {
          seen.add(row.user_id);
          scored.push({
            userId: row.user_id,
            username: row.username,
            pronouns: row.pronouns,
            sentiment: row.sentiment,
            opinionSnippet: '',
            matchScore: score,
          });
        }
      }
    }

    scored.sort((a, b) => b.matchScore - a.matchScore);
    const results = scored.slice(0, maxResults);

    if (results.length > 0) {
      const snippets = this.recentOpinionSnippets(3);
      for (const result of results) {
        const snippet = snippets.get(`${scope}\u241F${result.userId}`) ?? '';
        result.opinionSnippet = snippet.length > 150 ? snippet.slice(0, 150) + '...' : snippet;
      }
    }

    console.log(`💾 [USER MEMORY] Search for "${query}" in guild ${scope} returned ${results.length} results`);
    return results;
  }

  /**
   * Upper bound on rows scored with Levenshtein in one `searchUsers` call.
   */
  private static readonly FUZZY_CANDIDATE_LIMIT = 200;

  // ---------------------------------------------------------------------------
  // Dashboard-facing memory management
  //
  // These are owner-only surfaces (HTTP Basic auth on the dashboard). They
  // default to every guild so the owner sees the whole picture, and accept an
  // explicit `guildId` to narrow.
  //
  // Two caveats, both real and both easy to assume away:
  //   - "every guild" means one ROW PER (user, guild). A user active in three
  //     servers appears three times in listMemorySummaries, and the summary
  //     shape carries no guildId, so those rows are indistinguishable.
  //   - Writers are the exception: addMemoryEntry needs a concrete scope, so an
  //     omitted `guildId` writes to LEGACY_GUILD_SCOPE instead of "all guilds".
  // ---------------------------------------------------------------------------

  /**
   * Per-user aggregate (including memory-row counts) for the dashboard browser.
   * `q` filters on username or user ID.
   */
  listMemorySummaries(q?: string, limit: number = 500, guildId?: string): UserMemorySummary[] {
    const capped = Math.max(1, Math.min(limit, 2000));
    const needle = q?.trim().toLowerCase();
    const { sql, params } = this.scopeClause(guildId === undefined ? ANY_GUILD : resolveGuildScope(guildId));

    const rows = this.db
      .query(
        `SELECT o.user_id            AS user_id,
                o.guild_id           AS guild_id,
                o.username           AS username,
                o.sentiment          AS sentiment,
                o.pronouns           AS pronouns,
                o.created_at         AS created_at,
                o.updated_at         AS updated_at,
                (SELECT COUNT(*) FROM user_memory_entries e
                  WHERE e.user_id = o.user_id AND e.guild_id = o.guild_id AND e.kind = 'opinion')     AS opinion_count,
                (SELECT COUNT(*) FROM user_memory_entries e
                  WHERE e.user_id = o.user_id AND e.guild_id = o.guild_id AND e.kind = 'third_party') AS third_party_count
         FROM user_opinions o
         WHERE 1 = 1${sql}
         ORDER BY o.updated_at DESC
         LIMIT ?`
      )
      .all(...params, capped) as Array<{
        user_id: string;
        guild_id: string;
        username: string;
        sentiment: string;
        pronouns: string | null;
        created_at: string;
        updated_at: string;
        opinion_count: number;
        third_party_count: number;
      }>;

    return rows
      .filter((row) => {
        if (!needle) return true;
        return (
          row.username.toLowerCase().includes(needle) || row.user_id.toLowerCase().includes(needle)
        );
      })
      .map((row) => ({
        userId: row.user_id,
        username: row.username,
        sentiment: row.sentiment,
        pronouns: row.pronouns ?? null,
        opinionCount: row.opinion_count,
        thirdPartyCount: row.third_party_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  /**
   * Full memory record for one user, including every individual memory row.
   * Returns null when the user is unknown.
   *
   * With no `guildId` this does NOT span every guild: it picks the single most
   * recently updated row across all guilds, then scopes the counts, the blob and
   * the entries to *that row's* guild via `entryScope`. So the returned record
   * is always one guild's memory — a user active in three servers shows only
   * whichever guild spoke last. This is deliberate on an owner surface (a
   * coherent single-guild view beats a franken-record) but callers must not read
   * it as "all of this user's data".
   */
  getMemoryDetail(userId: string, guildId?: string): UserMemoryDetail | null {
    const scope = guildId === undefined ? ANY_GUILD : resolveGuildScope(guildId);

    const row = scope === ANY_GUILD
      ? (this.db.query(
          `SELECT ${UserMemoryService.OPINION_COLUMNS}
           FROM user_opinions WHERE user_id = ?
           ORDER BY updated_at DESC, id DESC LIMIT 1`
        ).get(userId) as Record<string, unknown> | undefined)
      : (this.db.query(
          `SELECT ${UserMemoryService.OPINION_COLUMNS}
           FROM user_opinions WHERE user_id = ? AND guild_id = ?
           ORDER BY updated_at DESC, id DESC LIMIT 1`
        ).get(userId, scope) as Record<string, unknown> | undefined);

    const base = this.rowToOpinion(row);
    if (!base) {
      return null;
    }

    const entryScope = scope === ANY_GUILD ? base.guildId : scope;

    return {
      userId: base.userId,
      username: base.username,
      sentiment: base.sentiment,
      pronouns: base.pronouns ?? null,
      opinionCount: this.getEntryCount(base.userId, 'opinion', entryScope),
      thirdPartyCount: this.getEntryCount(base.userId, 'third_party', entryScope),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      opinion: base.opinion,
      thirdPartyContext: base.thirdPartyContext ?? null,
      entries: this.listEntries(base.userId, undefined, entryScope),
    };
  }

  /**
   * Add a single memory row via the dashboard.
   * `username` is required when the user has no `user_opinions` record yet.
   *
   * Writes always need a concrete scope, so an omitted `guildId` lands in
   * {@link LEGACY_GUILD_SCOPE}.
   */
  addMemoryEntry(
    userId: string,
    kind: MemoryEntryKind,
    content: string,
    username?: string,
    source: string = 'dashboard',
    guildId?: string,
  ): MemoryEntry {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Memory content cannot be empty');
    }

    const scope = resolveGuildScope(guildId);

    const existing = this.db
      .query('SELECT username FROM user_opinions WHERE user_id = ? AND guild_id = ? LIMIT 1')
      .get(userId, scope) as { username: string } | undefined;

    const displayName = username?.trim() || existing?.username || userId;

    const id = this.transaction(() => {
      this.ensureUserRow(userId, scope, displayName);

      const maxEntries =
        kind === 'opinion'
          ? UserMemoryService.MAX_OPINION_ENTRIES
          : UserMemoryService.MAX_THIRD_PARTY_ENTRIES;

      const entryId = this.insertEntry(userId, scope, kind, trimmed, maxEntries, source);
      this.db.run('UPDATE user_opinions SET updated_at = ? WHERE user_id = ? AND guild_id = ?', [
        new Date().toISOString(),
        userId,
        scope,
      ]);
      return entryId;
    });

    console.log(`💾 [USER MEMORY] Dashboard added ${kind} memory for ${displayName} in guild ${scope} (entry #${id})`);

    return this.listEntries(userId, kind, scope).find((entry) => entry.id === id)!;
  }

  /**
   * Rewrite the text of a single memory row.
   */
  updateMemoryEntry(entryId: number, content: string): MemoryEntry | null {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Memory content cannot be empty');
    }

    const existing = this.db.query(
      'SELECT user_id, guild_id, kind FROM user_memory_entries WHERE id = ?'
    ).get(entryId) as { user_id: string; guild_id: string; kind: MemoryEntryKind } | undefined;

    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();

    this.transaction(() => {
      this.db.run('UPDATE user_memory_entries SET content = ?, updated_at = ? WHERE id = ?', [
        trimmed,
        now,
        entryId,
      ]);
      this.db.run('UPDATE user_opinions SET updated_at = ? WHERE user_id = ? AND guild_id = ?', [
        now,
        existing.user_id,
        existing.guild_id || LEGACY_GUILD_SCOPE,
      ]);
    });

    console.log(`💾 [USER MEMORY] Dashboard updated memory #${entryId} for ${existing.user_id}`);
    return this.listEntries(existing.user_id, undefined, existing.guild_id).find((entry) => entry.id === entryId) ?? null;
  }

  /**
   * Delete a single memory row.
   */
  deleteMemoryEntry(entryId: number): { userId: string; kind: MemoryEntryKind } | null {
    const existing = this.db.query(
      'SELECT user_id, guild_id, kind FROM user_memory_entries WHERE id = ?'
    ).get(entryId) as { user_id: string; guild_id: string; kind: MemoryEntryKind } | undefined;

    if (!existing) {
      return null;
    }

    const scope = existing.guild_id || LEGACY_GUILD_SCOPE;

    this.transaction(() => {
      this.db.run('DELETE FROM user_memory_entries WHERE id = ?', [entryId]);

      // Drop the parent row too if it no longer holds any memories, so the user
      // stops showing up as "known" in the system prompt.
      if (this.getEntryCount(existing.user_id, undefined, scope) === 0) {
        this.db.run('DELETE FROM user_opinions WHERE user_id = ? AND guild_id = ?', [existing.user_id, scope]);
        console.log(
          `💾 [USER MEMORY] Last memory for ${existing.user_id} removed; pruned profile row`
        );
      } else {
        this.db.run('UPDATE user_opinions SET updated_at = ? WHERE user_id = ? AND guild_id = ?', [
          new Date().toISOString(),
          existing.user_id,
          scope,
        ]);
      }
    });

    console.log(`💾 [USER MEMORY] Dashboard deleted memory #${entryId} for ${existing.user_id}`);
    return { userId: existing.user_id, kind: existing.kind };
  }

  /**
   * Update the profile-level fields shown in the system prompt.
   *
   * With no `guildId` this writes EVERY guild's row for that user (no scope
   * clause at all), whereas {@link getMemoryDetail} with no `guildId` only
   * reports the most recently updated one. So an unscoped dashboard edit
   * propagates a username/pronouns correction across all servers — intended on
   * an owner surface, but callers must not read the pair as symmetric.
   */
  updateMemoryProfile(
    userId: string,
    updates: { username?: string; pronouns?: string | null; sentiment?: UserOpinion['sentiment'] },
    guildId?: string,
  ): UserMemoryDetail | null {
    const scope = guildId === undefined ? ANY_GUILD : resolveGuildScope(guildId);

    if (!this.hasOpinion(userId, guildId === undefined ? undefined : scope)) {
      return null;
    }

    const sets: string[] = [];
    const params: (string | null)[] = [];
    const { sql, params: scopeParams } = this.scopeClause(scope);

    if (typeof updates.username === 'string' && updates.username.trim()) {
      sets.push('username = ?');
      params.push(updates.username.trim());
      sets.push('username_norm = ?');
      params.push(updates.username.trim().toLowerCase());
    }
    if (updates.pronouns !== undefined) {
      sets.push('pronouns = ?');
      params.push(updates.pronouns?.trim() || null);
    }
    if (updates.sentiment !== undefined) {
      sets.push('sentiment = ?');
      params.push(updates.sentiment);
    }

    if (sets.length === 0) {
      return this.getMemoryDetail(userId, guildId);
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());

    this.db.run(
      `UPDATE user_opinions SET ${sets.join(', ')} WHERE user_id = ?${sql}`,
      [...params, userId, ...scopeParams]
    );
    console.log(`💾 [USER MEMORY] Dashboard updated profile for ${userId}`);

    return this.getMemoryDetail(userId, guildId);
  }

  /** Close the underlying handle. Used by tests and maintenance scripts. */
  close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.warn('💾 [USER MEMORY] Failed to close database:', error);
    }
  }

  /** Total number of users and memory rows, for the dashboard overview. */
  getMemoryStats(): { users: number; entries: number; opinionEntries: number; thirdPartyEntries: number } {
    const users = this.db.query('SELECT COUNT(*) as count FROM user_opinions').get() as { count: number };
    const entries = this.db.query('SELECT COUNT(*) as count FROM user_memory_entries').get() as { count: number };
    const byKind = this.db
      .query('SELECT kind, COUNT(*) as count FROM user_memory_entries GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;

    const opinionEntries = byKind.find((r) => r.kind === 'opinion')?.count ?? 0;
    const thirdPartyEntries = byKind.find((r) => r.kind === 'third_party')?.count ?? 0;

    return {
      users: users.count,
      entries: entries.count,
      opinionEntries,
      thirdPartyEntries,
    };
  }
}

/**
 * Escape LIKE wildcards so a user-supplied name cannot act as a pattern.
 *
 * The quote is escaped as well, even though every predicate that uses this is
 * now a bound parameter (so no quoting can be broken). It is defence in depth:
 * this helper is exactly the sort of function a future edit is tempted to drop
 * back into string interpolation, and `escapeLike` not covering `'` is how the
 * original injection sink looked "already handled".
 *
 * Note the escape character is `\` here, so a caller must pair this with
 * `ESCAPE '\'` and must not additionally quote the result.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_']/g, (char) => `\\${char}`);
}

export const userMemoryService = new UserMemoryService();
