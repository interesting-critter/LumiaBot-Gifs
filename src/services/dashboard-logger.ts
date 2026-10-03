import { randomUUID } from 'node:crypto';
import { config } from '../utils/config';
import { intEnv } from '../utils/env';

export type InteractionSource =
  | 'mention'
  | 'keyword'
  | 'reply'
  | 'orchestrator'
  | 'boredom'
  | 'slash-command'
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
   * from turn to turn; storing a copy per entry would bloat both memory and
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
 * In-memory rolling log of every bot activation, used by the dashboard.
 *
 * Deliberately not persisted: this is a debugging/observability feed, it can be
 * large (full prompts and responses), and losing it on restart is acceptable.
 * Entries older than the window are pruned on write and on read, and the buffer
 * is hard-capped so a pathological burst cannot exhaust memory.
 */
export class DashboardLoggerService {
  private entries: LoggedInteraction[] = [];
  private windowMs: number;
  private maxEntries: number;
  private startedAt = Date.now();

  /**
   * Distinct full prompts, keyed and content-addressed. Turn-to-turn the system
   * prompt is usually identical, so identical payloads share one entry. Bounded
   * so a persona edit or a memory change every turn cannot grow it without
   * limit; the oldest distinct prompt is dropped first.
   */
  private readonly fullPrompts = new Map<string, string>();
  private fullPromptCounter = 0;
  private lastFullPromptKey: string | null = null;
  private static readonly MAX_FULL_PROMPTS = 24;

  /** Upper bound on the rolling window, so the prune can never be a no-op. */
  private static readonly MAX_WINDOW_HOURS = 24 * 30;
  /** Upper bound on the hard entry cap. */
  private static readonly MAX_ENTRIES = 100_000;

  constructor() {
    this.windowMs =
      intEnv('DASHBOARD_LOG_WINDOW_HOURS', config.dashboard.logWindowHours, {
        min: 1,
        max: DashboardLoggerService.MAX_WINDOW_HOURS,
      }) * 60 * 60 * 1000;
    // `Math.max(10, NaN)` is NaN, which made `entries.length > NaN` false and so
    // the hard cap below never fired: the buffer grew without limit, holding
    // every prompt and response ever produced.
    this.maxEntries = intEnv('DASHBOARD_LOG_MAX_ENTRIES', config.dashboard.logMaxEntries, {
      min: 10,
      max: DashboardLoggerService.MAX_ENTRIES,
    });
    console.log(
      `📝 [DASHBOARD LOG] Rolling log initialized (${this.windowMs / 3_600_000}h window, max ${this.maxEntries} entries, UTC buckets)`
    );
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    if (this.entries.length === 0) {
      return;
    }
    // Entries are appended in chronological order, so drop from the front.
    let dropCount = 0;
    while (dropCount < this.entries.length && this.entries[dropCount]!.epochMs < cutoff) {
      dropCount++;
    }
    if (dropCount > 0) {
      this.entries.splice(0, dropCount);
    }
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  log(input: LogInteractionInput): LoggedInteraction | null {
    try {
      const now = Date.now();
      let fullPromptId: string | undefined;
      if (input.fullPrompt) {
        // Reuse the last key when the payload is unchanged, so a stable persona
        // costs exactly one stored copy.
        const lastKey = this.lastFullPromptKey;
        if (lastKey && this.fullPrompts.get(lastKey) === input.fullPrompt) {
          fullPromptId = lastKey;
        } else {
          fullPromptId = `fp${++this.fullPromptCounter}`;
          this.fullPrompts.set(fullPromptId, input.fullPrompt);
          this.lastFullPromptKey = fullPromptId;
          while (this.fullPrompts.size > DashboardLoggerService.MAX_FULL_PROMPTS) {
            const oldest = this.fullPrompts.keys().next().value;
            if (oldest === undefined) break;
            this.fullPrompts.delete(oldest);
          }
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

      this.entries.push(entry);
      this.prune();
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
    const out: Record<string, string> = {};
    for (const entry of entries) {
      if (!entry.fullPromptId || out[entry.fullPromptId] !== undefined) continue;
      const text = this.fullPrompts.get(entry.fullPromptId);
      if (text !== undefined) out[entry.fullPromptId] = text;
    }
    return out;
  }

  list(query: LogQuery = {}): LoggedInteraction[] {
    this.prune();

    const limit = Math.max(1, Math.min(query.limit ?? 100, this.maxEntries));
    const needle = query.q?.trim().toLowerCase();
    const since = query.sinceEpochMs;

    const matches = this.entries.filter((entry) => {
      if (query.userId && entry.userId !== query.userId) return false;
      if (query.guildId && entry.guildId !== query.guildId) return false;
      if (query.source && entry.source !== query.source) return false;
      if (since !== undefined && entry.epochMs < since) return false;
      if (needle) {
        const haystack = `${entry.prompt}\n${entry.response}\n${entry.username || ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    // Newest first.
    return matches.slice(-limit).reverse();
  }

  getSummary(): LogSummary {
    this.prune();

    const bySource: Record<string, number> = {};
    const userCounts = new Map<string, { userId: string; username: string; count: number }>();
    let errors = 0;
    let totalDuration = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const entry of this.entries) {
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
      if (entry.error) {
        errors++;
      }
      totalDuration += entry.durationMs;
      if (oldest === null || entry.epochMs < oldest) {
        oldest = entry.epochMs;
      }
      if (newest === null || entry.epochMs > newest) {
        newest = entry.epochMs;
      }

      if (entry.userId) {
        const existing = userCounts.get(entry.userId);
        if (existing) {
          existing.count++;
        } else {
          userCounts.set(entry.userId, {
            userId: entry.userId,
            username: entry.username || entry.userId,
            count: 1,
          });
        }
      }
    }

    const total = this.entries.length;
    const topUsers = Array.from(userCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      windowHours: Math.round(this.windowMs / 3_600_000),
      total,
      windowStart: oldest !== null ? new Date(oldest).toISOString() : null,
      windowEnd: newest !== null ? new Date(newest).toISOString() : null,
      bySource,
      uniqueUsers: userCounts.size,
      errors,
      avgDurationMs: total > 0 ? Math.round(totalDuration / total) : 0,
      topUsers,
    };
  }

  /** Uptime in seconds since the log service was constructed. */
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  clear(): number {
    const cleared = this.entries.length;
    this.entries = [];
    this.fullPrompts.clear();
    this.lastFullPromptKey = null;
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
   */
  getAnalytics(): LogAnalytics {
    this.prune();

    const durations: number[] = [];
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, errors: 0 }));
    const hourLatencyTotal = new Array(24).fill(0);
    const hourLatencyCount = new Array(24).fill(0);

    const userRows = new Map<string, UserLeaderboardRow & { durationSum: number; durationSamples: number }>();
    const channelRows = new Map<string, ChannelLeaderboardRow>();

    for (const entry of this.entries) {
      // A turn that never produced a response has no meaningful latency.
      const timed = entry.durationMs > 0;
      // getUTCHours(), matching api-usage.ts's UTC hour buckets.
      const hourOfDay = new Date(entry.epochMs).getUTCHours();
      if (timed) {
        durations.push(entry.durationMs);
        hourLatencyTotal[hourOfDay]! += entry.durationMs;
        hourLatencyCount[hourOfDay]! += 1;
      }

      hours[hourOfDay]!.count += 1;
      if (entry.error) {
        hours[hourOfDay]!.errors += 1;
      }

      if (entry.userId) {
        const existing = userRows.get(entry.userId);
        if (existing) {
          existing.count += 1;
          if (entry.error) existing.errors += 1;
          if (timed) {
            existing.durationSum += entry.durationMs;
            existing.durationSamples += 1;
          }
          // Prefer the most recent non-empty name, since Discord users rename.
          if (entry.username) existing.username = entry.username;
        } else {
          userRows.set(entry.userId, {
            userId: entry.userId,
            username: entry.username || entry.userId,
            count: 1,
            errors: entry.error ? 1 : 0,
            avgDurationMs: 0,
            durationSum: timed ? entry.durationMs : 0,
            durationSamples: timed ? 1 : 0,
          });
        }
      }

      if (entry.channelId) {
        const existing = channelRows.get(entry.channelId);
        if (existing) {
          existing.count += 1;
        } else {
          channelRows.set(entry.channelId, {
            channelId: entry.channelId,
            channelName: entry.channelName || entry.channelId,
            guildName: entry.guildName || 'direct message',
            count: 1,
          });
        }
      }
    }

    return {
      windowHours: Math.round(this.windowMs / 3_600_000),
      samples: durations.length,
      latency: percentileStats(durations),
      byHourOfDay: hours,
      users: Array.from(userRows.values())
        .map(({ durationSum, durationSamples, ...row }) => ({
          ...row,
          avgDurationMs: durationSamples ? Math.round(durationSum / durationSamples) : 0,
        }))
        .sort((a, b) => b.count - a.count),
      channels: Array.from(channelRows.values()).sort((a, b) => b.count - a.count),
      hourlyLatency: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        avg: hourLatencyCount[hour] ? Math.round(hourLatencyTotal[hour]! / hourLatencyCount[hour]!) : 0,
      })),
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
