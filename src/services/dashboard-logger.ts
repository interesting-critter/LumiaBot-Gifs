import { randomUUID } from 'node:crypto';
import { config } from '../utils/config';

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
  prompt: string;
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

  constructor() {
    this.windowMs = Math.max(1, config.dashboard.logWindowHours) * 60 * 60 * 1000;
    this.maxEntries = Math.max(10, config.dashboard.logMaxEntries);
    console.log(
      `📝 [DASHBOARD LOG] Rolling log initialized (${config.dashboard.logWindowHours}h window, max ${this.maxEntries} entries)`
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
    console.log(`📝 [DASHBOARD LOG] Cleared ${cleared} entr${cleared === 1 ? 'y' : 'ies'}`);
    return cleared;
  }
}

export const dashboardLoggerService = new DashboardLoggerService();
