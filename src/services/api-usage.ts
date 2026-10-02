import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import { intEnv } from '../utils/env';
import { dbPath } from '../utils/paths';

/**
 * Tracks every outbound LLM API request so the dashboard can show how many
 * requests have been made inside a rolling window (the user tracks a requests-
 * per-day, not per-token, quota).
 *
 * Storage is SQLite rather than an in-memory counter so restarts do not reset
 * the tally mid-window. Rows older than the window are pruned on every insert,
 * which keeps the table bounded at a few hundred rows for typical bot volume.
 *
 * TIMEZONE: every bucket and label here is UTC. `dashboard-logger.ts` was moved
 * from local `getHours()` to UTC to match, so a single request cannot appear in
 * one hour bucket on the usage panel and a different one on the activity
 * heatmap.
 */
export interface ApiUsageStats {
  windowHours: number;
  callsInWindow: number;
  dailyLimit: number;
  remaining: number | null;
  usedPercent: number | null;
  /** ISO timestamp of the oldest call still inside the window, or null if none. */
  windowStart: string | null;
  /** ISO timestamp when the current window entry expires. */
  resetsAt: string | null;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  /** Calls per hour, oldest first, covering the window. Hour keys are UTC. */
  hourly: Array<{ hour: string; calls: number }>;
  /** UTC hour with the highest call count inside the window. */
  peakHour: { hour: string; calls: number } | null;
  totalRecorded: number;
}

export interface ApiCallRecord {
  timestamp: string;
  provider: string;
  model: string;
}

export class ApiUsageService {
  private db: Database;
  private windowHours: number;
  private insertedCount = 0;

  /**
   * Upper bound on the rolling window. 30 days keeps `DASHBOARD_USAGE_WINDOW_HOURS`
   * from being set to something absurd that silently turns the prune into a
   * no-op and lets the table grow without bound.
   */
  private static readonly MAX_WINDOW_HOURS = 24 * 30;

  constructor() {
    this.db = new Database(dbPath('api_usage.db'));
    this.windowHours = intEnv('DASHBOARD_USAGE_WINDOW_HOURS', config.dashboard.usageWindowHours, {
      min: 1,
      max: ApiUsageService.MAX_WINDOW_HOURS,
    });
    this.initDatabase();
    console.log(
      `📊 [API USAGE] Tracker initialized (${this.windowHours}h rolling window, UTC buckets, db: api_usage.db)`
    );
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS api_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        epoch_ms INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_api_calls_epoch ON api_calls(epoch_ms)
    `);
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowHours * 60 * 60 * 1000;
    this.db.run('DELETE FROM api_calls WHERE epoch_ms < ?', [cutoff]);
  }

  /**
   * Record a single outbound LLM request. Never throws — telemetry must not
   * be able to break a chat turn.
   */
  recordCall(provider: string, model: string): void {
    try {
      const now = Date.now();
      this.db.run(
        'INSERT INTO api_calls (created_at, epoch_ms, provider, model) VALUES (?, ?, ?, ?)',
        [new Date(now).toISOString(), now, provider || 'unknown', model || 'unknown']
      );
      this.insertedCount++;
      // Prune on every 10th write to avoid a DELETE on the hot path.
      if (this.insertedCount % 10 === 0) {
        this.prune();
      }
    } catch (error) {
      console.error('📊 [API USAGE] Failed to record call:', error);
    }
  }

  getStats(): ApiUsageStats {
    const windowMs = this.windowHours * 60 * 60 * 1000;
    const now = Date.now();
    const cutoff = now - windowMs;

    const rows = this.db
      .query('SELECT epoch_ms, provider, model FROM api_calls WHERE epoch_ms >= ?')
      .all(cutoff) as Array<{ epoch_ms: number; provider: string; model: string }>;

    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const hourBuckets = new Map<string, number>();
    let oldest = Number.POSITIVE_INFINITY;

    for (const row of rows) {
      byProvider[row.provider] = (byProvider[row.provider] || 0) + 1;
      byModel[row.model] = (byModel[row.model] || 0) + 1;
      // Floor to the hour for a stable bucketing key. UTC on purpose: this is
      // the timezone `dashboard-logger.ts` also uses.
      const hourKey = new Date(Math.floor(row.epoch_ms / 3_600_000) * 3_600_000).toISOString();
      hourBuckets.set(hourKey, (hourBuckets.get(hourKey) || 0) + 1);
      if (row.epoch_ms < oldest) {
        oldest = row.epoch_ms;
      }
    }

    const hourly = Array.from(hourBuckets.entries())
      .map(([hour, calls]) => ({ hour, calls }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    const peakHour = hourly.reduce<{ hour: string; calls: number } | null>((peak, entry) => {
      if (!peak || entry.calls > peak.calls) {
        return entry;
      }
      return peak;
    }, null);

    const callsInWindow = rows.length;
    const dailyLimit = config.dashboard.dailyRequestLimit;
    const hasLimit = dailyLimit > 0;

    // The window rolls per-request, so expose the reset time of the single
    // oldest surviving call: that is when one slot frees up.
    const resetsAt = Number.isFinite(oldest) ? new Date(oldest + windowMs).toISOString() : null;

    const totalRow = this.db.query('SELECT COUNT(*) as count FROM api_calls').get() as { count: number };

    return {
      windowHours: this.windowHours,
      callsInWindow,
      dailyLimit,
      remaining: hasLimit ? Math.max(0, dailyLimit - callsInWindow) : null,
      usedPercent: hasLimit
        ? Math.min(100, Math.round((callsInWindow / dailyLimit) * 1000) / 10)
        : null,
      windowStart: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
      resetsAt,
      byProvider,
      byModel,
      hourly,
      peakHour,
      totalRecorded: totalRow.count,
    };
  }

  getRecentCalls(limit: number = 50): ApiCallRecord[] {
    const capped = Math.max(1, Math.min(limit, 500));
    return this.db
      .query('SELECT created_at, provider, model FROM api_calls ORDER BY epoch_ms DESC LIMIT ?')
      .all(capped) as ApiCallRecord[];
  }

  /**
   * Drop every recorded call. Used by the dashboard "reset counter" action and
   * by the wipe-memories maintenance script.
   */
  clear(): number {
    const result = this.db.run('DELETE FROM api_calls');
    console.log(`📊 [API USAGE] Cleared ${result.changes} recorded call(s)`);
    return result.changes;
  }

  setWindowHours(hours: number): void {
    // A dashboard-supplied value can be NaN (e.g. an unparseable query string).
    // `Math.max(1, NaN)` is NaN, and every later `epoch_ms < cutoff` comparison is
    // false — which silently disables the prune entirely.
    const parsed = Math.trunc(hours);
    this.windowHours = Number.isFinite(parsed)
      ? Math.min(Math.max(1, parsed), ApiUsageService.MAX_WINDOW_HOURS)
      : intEnv('DASHBOARD_USAGE_WINDOW_HOURS', config.dashboard.usageWindowHours, {
          min: 1,
          max: ApiUsageService.MAX_WINDOW_HOURS,
        });
    this.prune();
  }
}

export const apiUsageService = new ApiUsageService();
