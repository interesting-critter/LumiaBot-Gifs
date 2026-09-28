import { Database } from 'bun:sqlite';
import { config } from '../utils/config';

export const PRONOUN_FALLBACK = 'No pronouns on record — use gender-neutral they/them when referring to this user.';

export interface UserSearchResult {
  userId: string;
  username: string;
  pronouns: string | null;
  sentiment: string;
  opinionSnippet: string;
  matchScore: number;
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

  constructor() {
    // Use SQLite for user memory storage
    this.db = new Database('user_memories.db');
    this.initDatabase();
  }

  private initDatabase(): void {
    // Create table if it doesn't exist
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
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
    this.migrateAddColumn('pronouns', 'TEXT');
    this.migrateAddColumn('third_party_context', 'TEXT');

    this.initEntriesTable();
    this.migrateBlobsToEntries();

    console.log('💾 [USER MEMORY] Database initialized');
  }

  private initEntriesTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
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
      this.db.run('BEGIN');
      const rows = this.db
        .query('SELECT user_id, opinion, third_party_context FROM user_opinions')
        .all() as Array<{ user_id: string; opinion: string; third_party_context: string | null }>;

      let migrated = 0;

      for (const row of rows) {
        if (row.opinion) {
          for (const entry of parseMemoryBlob(row.opinion, OPINION_ENTRY_SEPARATOR)) {
            if (!entry.content) continue;
            this.db.run(
              `INSERT INTO user_memory_entries (user_id, kind, content, source, created_at, updated_at)
               VALUES (?, 'opinion', ?, 'legacy-migration', ?, ?)`,
              [row.user_id, entry.content, entry.timestamp || new Date().toISOString(), new Date().toISOString()]
            );
            migrated++;
          }
        }

        if (row.third_party_context) {
          for (const entry of parseMemoryBlob(row.third_party_context, THIRD_PARTY_ENTRY_SEPARATOR)) {
            if (!entry.content) continue;
            this.db.run(
              `INSERT INTO user_memory_entries (user_id, kind, content, source, created_at, updated_at)
               VALUES (?, 'third_party', ?, 'legacy-migration', ?, ?)`,
              [row.user_id, entry.content, entry.timestamp || new Date().toISOString(), new Date().toISOString()]
            );
            migrated++;
          }
        }
      }

      // Blobs are now redundant; clear them so reads come from the entries table.
      this.db.run(`UPDATE user_opinions SET opinion = '', third_party_context = NULL`);
      this.markMigration(MIGRATION);
      this.db.run('COMMIT');
      console.log(`💾 [USER MEMORY] Migrated ${migrated} legacy memory entr${migrated === 1 ? 'y' : 'ies'} to user_memory_entries`);
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Ignore rollback failures; the migration simply retries next boot.
      }
      console.error('💾 [USER MEMORY] Legacy blob migration failed (will retry on next start):', error);
    }
  }

  private migrateAddColumn(columnName: string, columnType: string): void {
    try {
      // Check if column exists
      const result = this.db.query(
        `SELECT COUNT(*) as count FROM pragma_table_info('user_opinions') WHERE name = ?`
      ).get(columnName) as { count: number };

      if (result.count === 0) {
        // Column doesn't exist, add it
        this.db.run(`ALTER TABLE user_opinions ADD COLUMN ${columnName} ${columnType}`);
        console.log(`💾 [USER MEMORY] Migration: Added column '${columnName}'`);
      }
    } catch (error) {
      console.error(`💾 [USER MEMORY] Migration failed for column '${columnName}':`, error);
    }
  }

  /**
   * Insert a single memory row and enforce the rolling-window cap by deleting
   * the oldest rows beyond `maxEntries` for that (user, kind) pair.
   */
  private insertEntry(
    userId: string,
    kind: MemoryEntryKind,
    content: string,
    maxEntries: number,
    source: string | null = null,
    createdAt: string = new Date().toISOString(),
  ): number {
    const result = this.db.run(
      `INSERT INTO user_memory_entries (user_id, kind, content, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, kind, content, source, createdAt, createdAt]
    );

    this.db.run(
      `DELETE FROM user_memory_entries
       WHERE user_id = ? AND kind = ? AND id NOT IN (
         SELECT id FROM user_memory_entries
         WHERE user_id = ? AND kind = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )`,
      [userId, kind, userId, kind, maxEntries]
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Ensure a `user_opinions` row exists so the user appears in listings.
   *
   * `user_id` has no UNIQUE constraint (legacy DBs may hold duplicates), so
   * this does an explicit existence check rather than an upsert.
   */
  private ensureUserRow(userId: string, username: string): void {
    const existing = this.db
      .query('SELECT id FROM user_opinions WHERE user_id = ? LIMIT 1')
      .get(userId) as { id: number } | undefined;

    const now = new Date().toISOString();

    if (existing) {
      this.db.run('UPDATE user_opinions SET username = ? WHERE id = ?', [username, existing.id]);
      return;
    }

    this.db.run(
      `INSERT INTO user_opinions (user_id, username, opinion, sentiment, created_at, updated_at)
       VALUES (?, ?, '', 'neutral', ?, ?)`,
      [userId, username, now, now]
    );
  }

  /**
   * Store a new opinion about a user
   */
  storeOpinion(userId: string, username: string, opinion: string, sentiment: UserOpinion['sentiment']): void {
    const now = new Date().toISOString();
    const isNewUser = !this.hasOpinion(userId);

    this.ensureUserRow(userId, username);

    // The blob column is kept empty; entries are the source of truth.
    this.db.run(
      `UPDATE user_opinions SET sentiment = ?, updated_at = ? WHERE user_id = ?`,
      [sentiment, now, userId]
    );

    this.insertEntry(userId, 'opinion', opinion, UserMemoryService.MAX_OPINION_ENTRIES, 'store_user_opinion');

    const count = this.getEntryCount(userId, 'opinion');
    console.log(
      `💾 [USER MEMORY] ${isNewUser ? 'Stored new' : 'Updated'} opinion for ${username} (${sentiment}, ${count} entries)`
    );
  }

  /**
   * Store or update user's pronouns
   */
  storePronouns(userId: string, username: string, pronouns: string): void {
    const now = new Date().toISOString();
    const isNewUser = !this.hasOpinion(userId);

    this.ensureUserRow(userId, username);
    this.db.run(
      `UPDATE user_opinions SET pronouns = ?, updated_at = ? WHERE user_id = ?`,
      [pronouns, now, userId]
    );

    if (isNewUser) {
      this.insertEntry(userId, 'opinion', 'First interaction', UserMemoryService.MAX_OPINION_ENTRIES, 'store_pronouns');
    }

    console.log(
      `💾 [USER MEMORY] ${isNewUser ? 'Stored new user' : 'Updated pronouns for'} ${username}: ${pronouns}`
    );
  }

  /**
   * Store third-party context about a user (what others say about them)
   */
  storeThirdPartyContext(mention: ExtractedMention): void {
    const now = new Date().toISOString();
    const isNewUser = !this.hasOpinion(mention.userId);

    this.ensureUserRow(mention.userId, mention.username);
    this.db.run(
      `UPDATE user_opinions SET updated_at = ? WHERE user_id = ?`,
      [now, mention.userId]
    );

    if (isNewUser) {
      this.insertEntry(
        mention.userId,
        'opinion',
        `Mentioned by ${mention.mentionedBy}`,
        UserMemoryService.MAX_OPINION_ENTRIES,
        'store_third_party_context'
      );
    }

    const content = `${mention.mentionedBy} mentioned: "${mention.context}"`;
    this.insertEntry(
      mention.userId,
      'third_party',
      content,
      UserMemoryService.MAX_THIRD_PARTY_ENTRIES,
      'store_third_party_context'
    );

    const count = this.getEntryCount(mention.userId, 'third_party');
    console.log(`💾 [USER MEMORY] Added third-party context for ${mention.username} (${count} entries)`);
  }

  /**
   * Sync the stored username with the current Discord username.
   * Prevents stale/incorrect usernames from being injected into the system prompt.
   */
  syncUsername(userId: string, currentUsername: string): void {
    const existing = this.db.query(
      'SELECT username FROM user_opinions WHERE user_id = ? LIMIT 1'
    ).get(userId) as { username: string } | undefined;

    if (existing && existing.username !== currentUsername) {
      this.db.run(
        'UPDATE user_opinions SET username = ? WHERE user_id = ?',
        [currentUsername, userId]
      );
      console.log(`💾 [USER MEMORY] Synced username for ${userId}: "${existing.username}" → "${currentUsername}"`);
    }
  }

  /**
   * Count memory rows for a user, optionally restricted to one kind.
   */
  getEntryCount(userId: string, kind?: MemoryEntryKind): number {
    const row = kind
      ? (this.db
          .query('SELECT COUNT(*) as count FROM user_memory_entries WHERE user_id = ? AND kind = ?')
          .get(userId, kind) as { count: number })
      : (this.db
          .query('SELECT COUNT(*) as count FROM user_memory_entries WHERE user_id = ?')
          .get(userId) as { count: number });
    return row.count;
  }

  /**
   * List a user's memory rows, newest first.
   */
  listEntries(userId: string, kind?: MemoryEntryKind): MemoryEntry[] {
    const rows = kind
      ? this.db
          .query(
            `SELECT id, user_id, kind, content, source, created_at, updated_at
             FROM user_memory_entries
             WHERE user_id = ? AND kind = ?
             ORDER BY created_at DESC, id DESC`
          )
          .all(userId, kind)
      : this.db
          .query(
            `SELECT id, user_id, kind, content, source, created_at, updated_at
             FROM user_memory_entries
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC`
          )
          .all(userId);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
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
  private buildBlob(userId: string, kind: MemoryEntryKind, separator: string): string {
    const rows = this.db
      .query(
        `SELECT content, created_at FROM user_memory_entries
         WHERE user_id = ? AND kind = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(userId, kind) as Array<{ content: string; created_at: string }>;

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
    const opinion = this.buildBlob(userId, 'opinion', '\n\n');
    const thirdParty = this.buildBlob(userId, 'third_party', '\n');

    return {
      id: row.id as number,
      userId,
      username: row.username as string,
      opinion,
      sentiment: row.sentiment as UserOpinion['sentiment'],
      pronouns: (row.pronouns as string | null) ?? null,
      thirdPartyContext: thirdParty || null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  /**
   * Get opinion for a specific user
   */
  getOpinion(userId: string): UserOpinion | null {
    const row = this.db
      .query(
        `SELECT id, user_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at
         FROM user_opinions WHERE user_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(userId) as Record<string, unknown> | undefined;

    const result = this.rowToOpinion(row);

    if (result) {
      console.log(`💾 [USER MEMORY] Retrieved opinion for user ${result.username}`);
    }

    return result;
  }

  /**
   * Get opinion by username (case insensitive)
   */
  getOpinionByUsername(username: string): UserOpinion | null {
    const row = this.db
      .query(
        `SELECT id, user_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at
         FROM user_opinions WHERE LOWER(username) = LOWER(?)
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(username) as Record<string, unknown> | undefined;

    const result = this.rowToOpinion(row);

    if (result) {
      console.log(`💾 [USER MEMORY] Retrieved opinion by username: ${result.username}`);
    }

    return result;
  }

  /**
   * List all users Lumia has opinions about
   */
  listUsers(): Array<{ userId: string; username: string; sentiment: string; updatedAt: string }> {
    const results = this.db.query(
      `SELECT user_id, username, sentiment, updated_at
       FROM user_opinions
       ORDER BY updated_at DESC`
    ).all() as Array<{ user_id: string; username: string; sentiment: string; updated_at: string }>;

    console.log(`💾 [USER MEMORY] Listed ${results.length} users with opinions`);

    return results.map(r => ({
      userId: r.user_id,
      username: r.username,
      sentiment: r.sentiment,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Delete a user's opinion, along with their memory rows.
   */
  deleteOpinion(userId: string): number {
    const entries = this.db.run('DELETE FROM user_memory_entries WHERE user_id = ?', [userId]);
    const result = this.db.run('DELETE FROM user_opinions WHERE user_id = ?', [userId]);
    console.log(
      `💾 [USER MEMORY] Deleted ${result.changes} opinion row(s) and ${entries.changes} memory entr(ies) for user ${userId}`
    );
    return result.changes;
  }

  /**
   * Get opinion context string for system prompt
   */
  getOpinionContext(userId: string): string {
    const opinion = this.getOpinion(userId);
    
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
  getUserIdentityContext(userId: string): string {
    const opinion = this.getOpinion(userId);
    
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
   * Check if user exists in memory
   */
  hasOpinion(userId: string): boolean {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM user_opinions WHERE user_id = ?'
    ).get(userId) as { count: number };
    
    return result.count > 0;
  }

  /**
   * Get pronouns for a user, or return null if not set
   */
  getPronouns(userId: string): string | null {
    const result = this.db.query(
      'SELECT pronouns FROM user_opinions WHERE user_id = ?'
    ).get(userId) as { pronouns: string | null } | undefined;

    return result?.pronouns || null;
  }

  /**
   * Fuzzy-search users by partial/informal name.
   * Full-scans user_opinions (typically < 1000 rows — instant) and scores each via computeFuzzyScore().
   */
  searchUsers(query: string, maxResults: number = 5): UserSearchResult[] {
    const rows = this.db.query(
      'SELECT user_id, username, pronouns, sentiment, opinion FROM user_opinions'
    ).all() as Array<{
      user_id: string;
      username: string;
      pronouns: string | null;
      sentiment: string;
      opinion: string;
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
          opinionSnippet: row.opinion.length > 150 ? row.opinion.slice(0, 150) + '...' : row.opinion,
          matchScore: score,
        });
      }
    }

    scored.sort((a, b) => b.matchScore - a.matchScore);

    const results = scored.slice(0, maxResults);
    console.log(`💾 [USER MEMORY] Search for "${query}" returned ${results.length} results`);
    return results;
  }

  // ---------------------------------------------------------------------------
  // Dashboard-facing memory management
  // ---------------------------------------------------------------------------

  /**
   * Per-user aggregate (including memory-row counts) for the dashboard browser.
   * `q` filters on username or user ID.
   */
  listMemorySummaries(q?: string, limit: number = 500): UserMemorySummary[] {
    const capped = Math.max(1, Math.min(limit, 2000));
    const needle = q?.trim().toLowerCase();

    const rows = this.db
      .query(
        `SELECT o.user_id            AS user_id,
                o.username           AS username,
                o.sentiment          AS sentiment,
                o.pronouns           AS pronouns,
                o.created_at         AS created_at,
                o.updated_at         AS updated_at,
                (SELECT COUNT(*) FROM user_memory_entries e
                  WHERE e.user_id = o.user_id AND e.kind = 'opinion')     AS opinion_count,
                (SELECT COUNT(*) FROM user_memory_entries e
                  WHERE e.user_id = o.user_id AND e.kind = 'third_party') AS third_party_count
         FROM user_opinions o
         ORDER BY o.updated_at DESC
         LIMIT ?`
      )
      .all(capped) as Array<{
        user_id: string;
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
   */
  getMemoryDetail(userId: string): UserMemoryDetail | null {
    const base = this.getOpinion(userId);
    if (!base) {
      return null;
    }

    return {
      userId: base.userId,
      username: base.username,
      sentiment: base.sentiment,
      pronouns: base.pronouns ?? null,
      opinionCount: this.getEntryCount(userId, 'opinion'),
      thirdPartyCount: this.getEntryCount(userId, 'third_party'),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      opinion: base.opinion,
      thirdPartyContext: base.thirdPartyContext ?? null,
      entries: this.listEntries(userId),
    };
  }

  /**
   * Add a single memory row via the dashboard.
   * `username` is required when the user has no `user_opinions` record yet.
   */
  addMemoryEntry(
    userId: string,
    kind: MemoryEntryKind,
    content: string,
    username?: string,
    source: string = 'dashboard',
  ): MemoryEntry {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Memory content cannot be empty');
    }

    const existing = this.db
      .query('SELECT username FROM user_opinions WHERE user_id = ? LIMIT 1')
      .get(userId) as { username: string } | undefined;

    const displayName = username?.trim() || existing?.username || userId;
    this.ensureUserRow(userId, displayName);

    const maxEntries =
      kind === 'opinion'
        ? UserMemoryService.MAX_OPINION_ENTRIES
        : UserMemoryService.MAX_THIRD_PARTY_ENTRIES;

    const id = this.insertEntry(userId, kind, trimmed, maxEntries, source);
    this.db.run('UPDATE user_opinions SET updated_at = ? WHERE user_id = ?', [
      new Date().toISOString(),
      userId,
    ]);

    console.log(`💾 [USER MEMORY] Dashboard added ${kind} memory for ${displayName} (entry #${id})`);

    return this.listEntries(userId, kind).find((entry) => entry.id === id)!;
  }

  /**
   * Rewrite the text of a single memory row.
   */
  updateMemoryEntry(entryId: number, content: string): MemoryEntry | null {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Memory content cannot be empty');
    }

    const existing = this.db
      .query('SELECT user_id, kind FROM user_memory_entries WHERE id = ?')
      .get(entryId) as { user_id: string; kind: MemoryEntryKind } | undefined;

    if (!existing) {
      return null;
    }

    this.db.run('UPDATE user_memory_entries SET content = ?, updated_at = ? WHERE id = ?', [
      trimmed,
      new Date().toISOString(),
      entryId,
    ]);
    this.db.run('UPDATE user_opinions SET updated_at = ? WHERE user_id = ?', [
      new Date().toISOString(),
      existing.user_id,
    ]);

    console.log(`💾 [USER MEMORY] Dashboard updated memory #${entryId} for ${existing.user_id}`);
    return this.listEntries(existing.user_id).find((entry) => entry.id === entryId) ?? null;
  }

  /**
   * Delete a single memory row.
   */
  deleteMemoryEntry(entryId: number): { userId: string; kind: MemoryEntryKind } | null {
    const existing = this.db
      .query('SELECT user_id, kind FROM user_memory_entries WHERE id = ?')
      .get(entryId) as { user_id: string; kind: MemoryEntryKind } | undefined;

    if (!existing) {
      return null;
    }

    this.db.run('DELETE FROM user_memory_entries WHERE id = ?', [entryId]);

    // Drop the parent row too if it no longer holds any memories, so the user
    // stops showing up as "known" in the system prompt.
    if (this.getEntryCount(existing.user_id) === 0) {
      this.db.run('DELETE FROM user_opinions WHERE user_id = ?', [existing.user_id]);
      console.log(
        `💾 [USER MEMORY] Last memory for ${existing.user_id} removed; pruned profile row`
      );
    } else {
      this.db.run('UPDATE user_opinions SET updated_at = ? WHERE user_id = ?', [
        new Date().toISOString(),
        existing.user_id,
      ]);
    }

    console.log(`💾 [USER MEMORY] Dashboard deleted memory #${entryId} for ${existing.user_id}`);
    return { userId: existing.user_id, kind: existing.kind };
  }

  /**
   * Update the profile-level fields shown in the system prompt.
   */
  updateMemoryProfile(
    userId: string,
    updates: { username?: string; pronouns?: string | null; sentiment?: UserOpinion['sentiment'] },
  ): UserMemoryDetail | null {
    if (!this.hasOpinion(userId)) {
      return null;
    }

    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (typeof updates.username === 'string' && updates.username.trim()) {
      sets.push('username = ?');
      params.push(updates.username.trim());
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
      return this.getMemoryDetail(userId);
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(userId);

    this.db.run(`UPDATE user_opinions SET ${sets.join(', ')} WHERE user_id = ?`, params);
    console.log(`💾 [USER MEMORY] Dashboard updated profile for ${userId}`);

    return this.getMemoryDetail(userId);
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

export const userMemoryService = new UserMemoryService();
