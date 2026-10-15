import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import { intEnv } from '../utils/env';
import { dbPath } from '../utils/paths';

export type InteractionSource =
  | 'mention'
  | 'keyword'
  | 'reply'
  | 'orchestrator'
  | 'boredom'
  | 'slash-command'
  /**
   * `/dryrun` (owner-only): the whole message pipeline ran, but no request was
   * made to any model. Its own source value rather than a reuse of
   * `'slash-command'`, because a dry run is the one entry in this log whose
   * `response` is *not* something the model said — filtering the two apart is
   * the whole point of having the value.
   */
  | 'dry-run'
  | 'unknown';

export interface LoggedInteraction {
  id: string;
  timestamp: string;
  epochMs: number;
  source: InteractionSource;
  userId?: string;
  username?: string;
  channelId?: string;
  channelName?: string;
  guildId?: string;
  guildName?: string;
  /** The user's own message, which is what most people want to read here. */
  prompt: string;
  /**
   * Key into the service's full-prompt store, holding everything actually sent
   * to the model (system prompt plus the turns). It is a key rather than the
   * text because that payload is several kilobytes and is nearly identical
   * from turn to turn; storing a copy per entry would bloat both storage and
   * every `/api/log` response.
   */
  fullPromptId?: string;
  response: string;
  durationMs: number;
  error?: string;
  imageCount: number;
  videoCount: number;
  attachmentCount: number;
  reactions: string[];
  gifUrl?: string;
  searchEnabled?: boolean;
  knowledgeEnabled?: boolean;
}

/**
 * Renders a request payload as the readable transcript that was sent, for the
 * dashboard's "full prompt" view. Deliberately separate from `prompt`, which
 * stays the bare user message.
 */
export function formatPromptForLog(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
): string {
  const parts: string[] = [];
  if (systemPrompt.trim()) {
    parts.push(`[system]\n${systemPrompt.trim()}`);
  }
  for (const message of messages) {
    // The system prompt is already emitted from the first argument, so a
    // `system` entry in `messages` is that same text a second time and must be
    // dropped. The OpenAI path hands us `enhancedMessages`, whose element [0] IS
    // the system message it sends, so without this the transcript showed the
    // system prompt back to back. The model was never affected: the real request
    // carries one system message.
    if (message.role === 'system') continue;
    const label = message.role === 'assistant' ? 'assistant' : message.role;
    parts.push(`[${label}]\n${message.content}`);
  }
  return parts.join('\n\n');
}

export interface LogQuery {
  limit?: number;
  /** Case-insensitive substring match against prompt and response. */
  q?: string;
  userId?: string;
  source?: InteractionSource;
  guildId?: string;
  sinceEpochMs?: number;
}

export interface LogSummary {
  windowHours: number;
  total: number;
  /** Oldest / newest entry timestamps inside the window. */
  windowStart: string | null;
  windowEnd: string | null;
  bySource: Record<string, number>;
  uniqueUsers: number;
  errors: number;
  avgDurationMs: number;
  /** Distinct users ranked by interaction count, most active first. */
  topUsers: Array<{ userId: string; username: string; count: number }>;
}

export interface LogInteractionInput {
  source: InteractionSource;
  prompt: string;
  /** The complete payload sent to the model, for the dashboard's full view. */
  fullPrompt?: string;
  response: string;
  durationMs?: number;
  userId?: string;
  username?: string;
  channelId?: string;
  channelName?: string;
  guildId?: string;
  guildName?: string;
  error?: string;
  imageCount?: number;
  videoCount?: number;
  attachmentCount?: number;
  reactions?: string[];
  gifUrl?: string;
  searchEnabled?: boolean;
  knowledgeEnabled?: boolean;
}

/** Latency distribution over the window, in milliseconds. */
export interface LatencyStats {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
}

export interface HourOfDayBucket {
  /**
   * 0-23 in UTC.
   *
   * UTC rather than server-local on purpose: `api-usage.ts` buckets its hourly
   * usage chart by UTC, so the activity heatmap and the usage panel describe
   * the same axis. They used to disagree (local `getHours()` here vs UTC there),
   * which made the two panels impossible to read together.
   */
  hour: number;
  count: number;
  errors: number;
}

export interface UserLeaderboardRow {
  userId: string;
  username: string;
  count: number;
  errors: number;
  avgDurationMs: number;
}

export interface ChannelLeaderboardRow {
  channelId: string;
  channelName: string;
  guildName: string;
  count: number;
}

export interface LogAnalytics {
  windowHours: number;
  samples: number;
  latency: LatencyStats;
  /** Always 24 entries, hour 0 first, so the heatmap is a stable grid. */
  byHourOfDay: HourOfDayBucket[];
  users: UserLeaderboardRow[];
  channels: ChannelLeaderboardRow[];
  /** Latency percentiles bucketed by hour of day, for the heatmap. */
  hourlyLatency: Array<{ hour: number; avg: number }>;
}

/**
 * Raw shape of a `log_interactions` row as returned by `bun:sqlite`. Column
 * names are snake_case because that is what SQLite stores; the row mapper
 * {@link rowToLoggedInteraction} converts them to the camelCase
 * {@link LoggedInteraction} shape the rest of the bot speaks.
 *
 * Nullable columns are `string | null` rather than `string | undefined`
 * because that is what `bun:sqlite` returns for SQL NULL — the mapper does the
 * `null → undefined` coercion so callers keep seeing the optionality they
 * always have.
 */
interface LogInteractionRow {
  id: string;
  timestamp: string;
  epoch_ms: number;
  source: string;
  user_id: string | null;
  username: string | null;
  channel_id: string | null;
  channel_name: string | null;
  guild_id: string | null;
  guild_name: string | null;
  prompt: string;
  full_prompt_id: string | null;
  response: string;
  duration_ms: number;
  error: string | null;
  image_count: number;
  video_count: number;
  attachment_count: number;
  reactions: string | null;
  gif_url: string | null;
  search_enabled: number | null;
  knowledge_enabled: number | null;
}

function rowToLoggedInteraction(row: LogInteractionRow): LoggedInteraction {
  return {
    id: row.id,
    timestamp: row.timestamp,
    epochMs: row.epoch_ms,
    source: row.source as InteractionSource,
    userId: row.user_id ?? undefined,
    username: row.username ?? undefined,
    channelId: row.channel_id ?? undefined,
    channelName: row.channel_name ?? undefined,
    guildId: row.guild_id ?? undefined,
    guildName: row.guild_name ?? undefined,
    prompt: row.prompt,
    fullPromptId: row.full_prompt_id ?? undefined,
    response: row.response,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
    imageCount: row.image_count,
    videoCount: row.video_count,
    attachmentCount: row.attachment_count,
    // An empty array is stored as NULL rather than `'[]'` to keep the hot path
    // cheap; the absence of a value maps back to `[]` because nothing ever
    // observes `reactions === undefined` for a logged interaction.
    reactions: row.reactions ? (JSON.parse(row.reactions) as string[]) : [],
    gifUrl: row.gif_url ?? undefined,
    // SQLite has no native BOOL: stored as 0/1, with NULL preserving the
    // "field was never set" distinction that `undefined` carries in JS.
    searchEnabled: row.search_enabled === null ? undefined : row.search_enabled === 1,
    knowledgeEnabled: row.knowledge_enabled === null ? undefined : row.knowledge_enabled === 1,
  };
}

/**
 * Persistent rolling log of every bot activation, used by the dashboard.
 *
 * Backed by SQLite (`<DATA_DIR>/dashboard_logs.db`) so a restart no longer
 * wipes the in-window tally. This mirrors the storage strategy already used by
 * `api-usage.ts`: same `bun:sqlite` Database, same `dbPath(...)` anchor, same
 * WAL + `synchronous = NORMAL` trade-off, same "prune on every Nth write"
 * cadence. Public method shapes are unchanged from the in-memory version this
 * replaces, so neither the dashboard routes nor the existing tests need to
 * move.
 *
 * Entries older than the window are pruned on write and on read, and the table
 * is hard-capped so a pathological burst cannot exhaust disk any more than it
 * could exhaust memory before.
 */
export class DashboardLoggerService {
  private readonly db: Database;
  private windowMs: number;
  private maxEntries: number;
  private startedAt = Date.now();

  /**
   * Distinct full prompts, keyed and content-addressed. Turn-to-turn the system
   * prompt is usually identical, so identical payloads share one entry. Bounded
   * so a persona edit or a memory change every turn cannot grow it without
   * limit; the oldest distinct prompt is dropped first.
   *
   * The counter is seeded from any rows already on disk at startup so a restart
   * cannot collide with existing `fpN` ids — `fp25` after `fp24`, never `fp1`
   * again.
   */
  private fullPromptCounter = 0;
  private lastFullPromptKey: string | null = null;
  private static readonly MAX_FULL_PROMPTS = 24;

  /** Upper bound on the rolling window, so the prune can never be a no-op. */
  private static readonly MAX_WINDOW_HOURS = 24 * 30;
  /** Upper bound on the hard entry cap. */
  private static readonly MAX_ENTRIES = 100_000;
  /**
   * Pruning runs every Nth insert, not on every write. Same cadence as
   * `api-usage.ts`: the prune is a `DELETE ... WHERE epoch_ms < ?` plus an
   * orphan sweep on `full_prompts`, and running it per-turn on a busy bot is
   * needless churn.
   */
  private static readonly PRUNE_EVERY_N_WRITES = 10;
  private insertedSinceLastPrune = 0;

  constructor() {
    this.windowMs =
      intEnv('DASHBOARD_LOG_WINDOW_HOURS', config.dashboard.logWindowHours, {
        min: 1,
        max: DashboardLoggerService.MAX_WINDOW_HOURS,
      }) * 60 * 60 * 1000;
    // `Math.max(10, NaN)` is NaN, which made `entries.length > NaN` false and so
    // the hard cap below never fired: the buffer grew without limit, holding
    // every prompt and response ever produced. The same trap is closed here for
    // the SQL cap.
    this.maxEntries = intEnv('DASHBOARD_LOG_MAX_ENTRIES', config.dashboard.logMaxEntries, {
      min: 10,
      max: DashboardLoggerService.MAX_ENTRIES,
    });

    this.db = new Database(dbPath('dashboard_logs.db'));
    // WAL so dashboard reads do not block the bot's writes, and
    // `synchronous = NORMAL` so a per-turn fsync is not paid on every INSERT.
    // `busy_timeout` covers the rare overlap when a prune and a dashboard poll
    // collide on the same page.
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA busy_timeout = 5000');
    this.initDatabase();
    this.seedFullPromptCounter();

    console.log(
      `📝 [DASHBOARD LOG] Persistent log initialized (${this.windowMs / 3_600_000}h window, max ${this.maxEntries} entries, UTC buckets, db: dashboard_logs.db)`
    );
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS log_interactions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        epoch_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        user_id TEXT,
        username TEXT,
        channel_id TEXT,
        channel_name TEXT,
        guild_id TEXT,
        guild_name TEXT,
        prompt TEXT NOT NULL,
        full_prompt_id TEXT,
        response TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        error TEXT,
        image_count INTEGER NOT NULL,
        video_count INTEGER NOT NULL,
        attachment_count INTEGER NOT NULL,
        reactions TEXT,
        gif_url TEXT,
        search_enabled INTEGER,
        knowledge_enabled INTEGER
      )
    `);

    // The epoch index backs both the window prune (`WHERE epoch_ms < ?`) and
    // every range query (`WHERE epoch_ms >= ?`); the others back the filter
    // parameters `/api/log?source=...&userId=...&guildId=...` advertises.
    this.db.run('CREATE INDEX IF NOT EXISTS idx_log_epoch ON log_interactions(epoch_ms)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_log_source ON log_interactions(source)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_log_user ON log_interactions(user_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_log_guild ON log_interactions(guild_id)');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS full_prompts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        last_used_ms INTEGER NOT NULL
      )
    `);
  }

  /**
   * Seed {@link fullPromptCounter} from any rows that survived the last
   * process, so the next `fpN` id is strictly greater than anything already on
   * disk. Without this, a restart would silently reset the counter to 0 and
   * the second-ever distinct prompt would collide with the first one's id,
   * failing the INSERT and dropping the entry.
   */
  private seedFullPromptCounter(): void {
    const rows = this.db
      .query("SELECT id FROM full_prompts WHERE id LIKE 'fp%'")
      .all() as Array<{ id: string }>;
    let max = 0;
    for (const row of rows) {
      const n = Number.parseInt(row.id.slice(2), 10);
      if (Number.isFinite(n) && n > max) {
        max = n;
      }
    }
    this.fullPromptCounter = max;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.db.run('DELETE FROM log_interactions WHERE epoch_ms < ?', [cutoff]);

    // Hard cap on rows, mirroring the old in-memory `splice(0, length - max)`.
    // The window prune above already keeps growth bounded in steady state, but
    // a burst shorter than the window (a spike inside the rolling window) can
    // still push the table past `maxEntries`; this trims the oldest surplus.
    const countRow = this.db.query('SELECT COUNT(*) AS count FROM log_interactions').get() as
      | { count: number }
      | null;
    const rowCount = countRow?.count ?? 0;
    if (rowCount > this.maxEntries) {
      const excess = rowCount - this.maxEntries;
      this.db.run(
        `DELETE FROM log_interactions
         WHERE id IN (
           SELECT id FROM log_interactions ORDER BY epoch_ms ASC LIMIT ?
         )`,
        [excess],
      );
    }

    // Orphaned full-prompt rows: those whose referencing log entries have aged
    // out (or were trimmed above). `NOT EXISTS` rather than `NOT IN` because
    // `NOT IN` against a subquery containing NULL behaves counter-intuitively
    // and would silently match nothing.
    this.db.run(`
      DELETE FROM full_prompts
      WHERE NOT EXISTS (
        SELECT 1 FROM log_interactions WHERE full_prompt_id = full_prompts.id
      )
    `);

    // Cap distinct full prompts, oldest-inserted first. `last_used_ms` is set
    // once at first insert and never updated on reuse, so ordering by it here
    // matches the original Map's insertion-order eviction exactly.
    const fpCountRow = this.db.query('SELECT COUNT(*) AS count FROM full_prompts').get() as
      | { count: number }
      | null;
    const fpCount = fpCountRow?.count ?? 0;
    if (fpCount > DashboardLoggerService.MAX_FULL_PROMPTS) {
      const excess = fpCount - DashboardLoggerService.MAX_FULL_PROMPTS;
      this.db.run(
        `DELETE FROM full_prompts
         WHERE id IN (
           SELECT id FROM full_prompts ORDER BY last_used_ms ASC LIMIT ?
         )`,
        [excess],
      );
    }
  }

  private maybePrune(): void {
    this.insertedSinceLastPrune++;
    if (this.insertedSinceLastPrune >= DashboardLoggerService.PRUNE_EVERY_N_WRITES) {
      this.insertedSinceLastPrune = 0;
      this.prune();
    }
  }

  /** Reads the content of one full-prompt row, or `undefined` if it has been evicted. */
  private getFullPromptContent(id: string): string | undefined {
    const row = this.db.query('SELECT content FROM full_prompts WHERE id = ?').get(id) as
      | { content: string }
      | null;
    return row?.content;
  }

  log(input: LogInteractionInput): LoggedInteraction | null {
    try {
      const now = Date.now();
      let fullPromptId: string | undefined;
      if (input.fullPrompt) {
        // Reuse the last key when the payload is unchanged, so a stable persona
        // costs exactly one stored copy. The row is left untouched on reuse:
        // `last_used_ms` is not bumped, matching the original Map semantics
        // where a `.get()` did not reorder the entry.
        const lastKey = this.lastFullPromptKey;
        if (lastKey && this.getFullPromptContent(lastKey) === input.fullPrompt) {
          fullPromptId = lastKey;
        } else {
          fullPromptId = `fp${++this.fullPromptCounter}`;
          this.db.run(
            'INSERT INTO full_prompts (id, content, last_used_ms) VALUES (?, ?, ?)',
            [fullPromptId, input.fullPrompt, now],
          );
          this.lastFullPromptKey = fullPromptId;
        }
      }

      const entry: LoggedInteraction = {
        id: randomUUID(),
        timestamp: new Date(now).toISOString(),
        epochMs: now,
        source: input.source,
        userId: input.userId,
        username: input.username,
        channelId: input.channelId,
        channelName: input.channelName,
        guildId: input.guildId,
        guildName: input.guildName,
        prompt: input.prompt || '',
        fullPromptId,
        response: input.response || '',
        durationMs: input.durationMs ?? 0,
        error: input.error,
        imageCount: input.imageCount || 0,
        videoCount: input.videoCount || 0,
        attachmentCount: input.attachmentCount || 0,
        reactions: input.reactions || [],
        gifUrl: input.gifUrl,
        searchEnabled: input.searchEnabled,
        knowledgeEnabled: input.knowledgeEnabled,
      };

      this.db.run(
        `INSERT INTO log_interactions (
           id, timestamp, epoch_ms, source, user_id, username, channel_id,
           channel_name, guild_id, guild_name, prompt, full_prompt_id, response,
           duration_ms, error, image_count, video_count, attachment_count,
           reactions, gif_url, search_enabled, knowledge_enabled
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.timestamp,
          entry.epochMs,
          entry.source,
          entry.userId ?? null,
          entry.username ?? null,
          entry.channelId ?? null,
          entry.channelName ?? null,
          entry.guildId ?? null,
          entry.guildName ?? null,
          entry.prompt,
          entry.fullPromptId ?? null,
          entry.response,
          entry.durationMs,
          entry.error ?? null,
          entry.imageCount,
          entry.videoCount,
          entry.attachmentCount,
          // NULL rather than `'[]'` so the hot path skips a `JSON.stringify`
          // for the common no-reactions case; the row mapper turns NULL back
          // into `[]` for callers.
          entry.reactions.length > 0 ? JSON.stringify(entry.reactions) : null,
          entry.gifUrl ?? null,
          entry.searchEnabled === undefined ? null : entry.searchEnabled ? 1 : 0,
          entry.knowledgeEnabled === undefined ? null : entry.knowledgeEnabled ? 1 : 0,
        ],
      );

      this.maybePrune();
      return entry;
    } catch (error) {
      console.error('📝 [DASHBOARD LOG] Failed to record interaction:', error);
      return null;
    }
  }

  /**
   * Resolves the full-prompt texts for a set of entries, so `/api/log` ships
   * each distinct prompt once instead of repeating it on every entry.
   */
  getFullPrompts(entries: LoggedInteraction[]): Record<string, string> {
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.fullPromptId && !ids.includes(entry.fullPromptId)) {
        ids.push(entry.fullPromptId);
      }
    }
    if (ids.length === 0) {
      return {};
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT id, content FROM full_prompts WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string; content: string }>;
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.id] = row.content;
    }
    return out;
  }

  list(query: LogQuery = {}): LoggedInteraction[] {
    // Run the window prune on read too, so a dashboard opened after a long idle
    // period does not see entries that have aged out while nobody was polling.
    // Resetting the write counter here avoids a redundant prune on the next
    // batch of inserts — the prune we are about to run already did the work.
    this.insertedSinceLastPrune = 0;
    this.prune();

    const limit = Math.max(1, Math.min(query.limit ?? 100, this.maxEntries));
    const needle = query.q?.trim().toLowerCase();
    const since = query.sinceEpochMs;

    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (query.userId) {
      conditions.push('user_id = ?');
      params.push(query.userId);
    }
    if (query.guildId) {
      conditions.push('guild_id = ?');
      params.push(query.guildId);
    }
    if (query.source) {
      conditions.push('source = ?');
      params.push(query.source);
    }
    if (since !== undefined) {
      conditions.push('epoch_ms >= ?');
      params.push(since);
    }
    if (needle) {
      // Substring match across the same three fields the in-memory version
      // concatenated: prompt, response and username. `LIKE` is case-insensitive
      // for ASCII in SQLite; the needle is already lowercased so non-ASCII
      // characters fall back to a literal comparison, matching the original
      // `toLowerCase().includes()` behaviour closely enough that the dashboard
      // search box feels identical.
      conditions.push(
        "(LOWER(prompt) || ' ' || LOWER(response) || ' ' || LOWER(COALESCE(username, ''))) LIKE ?",
      );
      params.push(`%${needle}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM log_interactions ${where} ORDER BY epoch_ms DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as LogInteractionRow[];
    // Newest first — preserved by `ORDER BY epoch_ms DESC` in the query, so
    // no in-memory reversal is needed.
    return rows.map(rowToLoggedInteraction);
  }

  getSummary(): LogSummary {
    this.prune();
    const cutoff = Date.now() - this.windowMs;

    const agg = this.db
      .query(
        `SELECT
           COUNT(*) AS total,
           COUNT(DISTINCT user_id) AS uniqueUsers,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
           AVG(duration_ms) AS avgDuration,
           MIN(epoch_ms) AS oldest,
           MAX(epoch_ms) AS newest
         FROM log_interactions
         WHERE epoch_ms >= ?`,
      )
      .get(cutoff) as {
      total: number;
      uniqueUsers: number;
      errors: number;
      avgDuration: number | null;
      oldest: number | null;
      newest: number | null;
    };

    const bySourceRows = this.db
      .query(
        `SELECT source, COUNT(*) AS count
         FROM log_interactions
         WHERE epoch_ms >= ?
         GROUP BY source`,
      )
      .all(cutoff) as Array<{ source: string; count: number }>;
    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) {
      bySource[row.source] = row.count;
    }

    // Most-recent non-empty username wins, matching the in-memory version's
    // "Discord users rename" handling exactly. The correlated subquery is
    // bounded by the (small) number of distinct users in the window.
    const topUserRows = this.db
      .query(
        `SELECT
           t1.user_id AS userId,
           COALESCE(
             (SELECT t2.username FROM log_interactions t2
              WHERE t2.user_id = t1.user_id
                AND t2.username IS NOT NULL
                AND t2.username <> ''
              ORDER BY t2.epoch_ms DESC
              LIMIT 1),
             t1.user_id
           ) AS username,
           COUNT(*) AS count
         FROM log_interactions t1
         WHERE epoch_ms >= ? AND user_id IS NOT NULL
         GROUP BY user_id
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all(cutoff) as Array<{ userId: string; username: string; count: number }>;

    return {
      windowHours: Math.round(this.windowMs / 3_600_000),
      total: agg.total,
      windowStart: agg.oldest !== null ? new Date(agg.oldest).toISOString() : null,
      windowEnd: agg.newest !== null ? new Date(agg.newest).toISOString() : null,
      bySource,
      uniqueUsers: agg.uniqueUsers,
      errors: agg.errors,
      avgDurationMs: agg.avgDuration !== null ? Math.round(agg.avgDuration) : 0,
      topUsers: topUserRows,
    };
  }

  /** Uptime in seconds since the log service was constructed. */
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  clear(): number {
    const result = this.db.run('DELETE FROM log_interactions');
    this.db.run('DELETE FROM full_prompts');
    this.lastFullPromptKey = null;
    const cleared = result.changes;
    console.log(`📝 [DASHBOARD LOG] Cleared ${cleared} entr${cleared === 1 ? 'y' : 'ies'}`);
    return cleared;
  }

  /**
   * Latency percentiles, an hour-of-day profile, and full leaderboards.
   *
   * `getSummary()` is deliberately cheap and only carries the mean plus a
   * top-10 user list, because it is re-computed on every auto-refresh poll.
   * This is the heavier, explicitly-requested view: it is called once when the
   * log tab's analytics section is opened, not on the overview refresh cycle.
   *
   * The hour-of-day, user-leaderboard and channel-leaderboard projections are
   * pushed into SQL so a 100k-row window does not have to be shipped across the
   * JS boundary on every call. The percentile array still has to come back as
   * numbers — SQL has no nearest-rank primitive — but it is a single column
   * (`duration_ms`), not the whole row.
   */
  getAnalytics(): LogAnalytics {
    this.prune();
    const cutoff = Date.now() - this.windowMs;

    const durations = this.db
      .query('SELECT duration_ms FROM log_interactions WHERE epoch_ms >= ? AND duration_ms > 0')
      .all(cutoff) as Array<{ duration_ms: number }>;
    const durationSamples = durations.map((r) => r.duration_ms);

    // Hour-of-day. `(epoch_ms / 3_600_000) % 24` is the UTC hour-of-day because
    // the Unix epoch is itself midnight UTC, so integer-dividing by an hour and
    // modding by 24 reproduces `new Date(epochMs).getUTCHours()` exactly. The
    // 24-row result is filled in to a stable grid below.
    const hourRows = this.db
      .query(
        `SELECT
           (epoch_ms / 3600000) % 24 AS hour,
           COUNT(*) AS count,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM log_interactions
         WHERE epoch_ms >= ?
         GROUP BY hour`,
      )
      .all(cutoff) as Array<{ hour: number; count: number; errors: number }>;
    const hours: HourOfDayBucket[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: 0,
      errors: 0,
    }));
    for (const row of hourRows) {
      if (row.hour >= 0 && row.hour < 24) {
        hours[row.hour]!.count = row.count;
        hours[row.hour]!.errors = row.errors;
      }
    }

    // Per-hour average latency, only over timed entries. The original code
    // produced 0 for hours with no timed samples; the COALESCE here keeps that
    // shape so the heatmap does not render NULL-shaped gaps.
    const hourLatencyRows = this.db
      .query(
        `SELECT
           (epoch_ms / 3600000) % 24 AS hour,
           AVG(duration_ms) AS avg
         FROM log_interactions
         WHERE epoch_ms >= ? AND duration_ms > 0
         GROUP BY hour`,
      )
      .all(cutoff) as Array<{ hour: number; avg: number | null }>;
    const hourLatency = new Array(24).fill(0);
    for (const row of hourLatencyRows) {
      if (row.hour >= 0 && row.hour < 24) {
        hourLatency[row.hour] = row.avg !== null ? Math.round(row.avg) : 0;
      }
    }

    const userRows = this.db
      .query(
        `SELECT
           t1.user_id AS userId,
           COALESCE(
             (SELECT t2.username FROM log_interactions t2
              WHERE t2.user_id = t1.user_id
                AND t2.username IS NOT NULL
                AND t2.username <> ''
              ORDER BY t2.epoch_ms DESC
              LIMIT 1),
             t1.user_id
           ) AS username,
           COUNT(*) AS count,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
           SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS durationSum,
           SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS durationSamples
         FROM log_interactions t1
         WHERE epoch_ms >= ? AND user_id IS NOT NULL
         GROUP BY user_id
         ORDER BY count DESC`,
      )
      .all(cutoff) as Array<{
      userId: string;
      username: string;
      count: number;
      errors: number;
      durationSum: number;
      durationSamples: number;
    }>;
    const users: UserLeaderboardRow[] = userRows.map((row) => ({
      userId: row.userId,
      username: row.username,
      count: row.count,
      errors: row.errors,
      avgDurationMs: row.durationSamples > 0 ? Math.round(row.durationSum / row.durationSamples) : 0,
    }));

    const channelRows = this.db
      .query(
        `SELECT
           t1.channel_id AS channelId,
           COALESCE(
             (SELECT t2.channel_name FROM log_interactions t2
              WHERE t2.channel_id = t1.channel_id
                AND t2.channel_name IS NOT NULL
                AND t2.channel_name <> ''
              ORDER BY t2.epoch_ms DESC
              LIMIT 1),
             t1.channel_id
           ) AS channelName,
           COALESCE(
             (SELECT t2.guild_name FROM log_interactions t2
              WHERE t2.channel_id = t1.channel_id
                AND t2.guild_name IS NOT NULL
                AND t2.guild_name <> ''
              ORDER BY t2.epoch_ms DESC
              LIMIT 1),
             'direct message'
           ) AS guildName,
           COUNT(*) AS count
         FROM log_interactions t1
         WHERE epoch_ms >= ? AND channel_id IS NOT NULL
         GROUP BY channel_id
         ORDER BY count DESC`,
      )
      .all(cutoff) as Array<ChannelLeaderboardRow>;

    return {
      windowHours: Math.round(this.windowMs / 3_600_000),
      samples: durationSamples.length,
      latency: percentileStats(durationSamples),
      byHourOfDay: hours,
      users,
      channels: channelRows,
      hourlyLatency: Array.from({ length: 24 }, (_, hour) => ({ hour, avg: hourLatency[hour]! })),
    };
  }
}

/** Nearest-rank percentile over a copy of the sample, leaving the input untouched. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function percentileStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { samples: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, n) => sum + n, 0);
  return {
    samples: samples.length,
    min: sorted[0]!,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
    avg: Math.round(total / samples.length),
  };
}

export const dashboardLoggerService = new DashboardLoggerService();
