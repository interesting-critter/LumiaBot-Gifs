import { Database } from 'bun:sqlite';
import {
  Client,
  TextChannel,
  ThreadChannel,
  NewsChannel,
  VoiceChannel,
  StageChannel,
  ChannelType,
  PermissionFlagsBits,
  type GuildTextBasedChannel,
} from 'discord.js';
import { config } from '../utils/config';
import { dbPath } from '../utils/paths';
import { buildAllowedMentions } from '../utils/permissions';
import { channelHistoryService } from './channel-history';
import { getAIService } from './google-genai';
import { gifService } from './gif';
import { formatDiscordResponseText } from '../utils/discord-markdown';
import { dashboardLoggerService } from './dashboard-logger';

interface BoredomState {
  enabled: boolean;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export class BoredomService {
  private db: Database;
  private client: Client | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isExecuting = false;

  constructor() {
    this.db = new Database(dbPath('boredom.db'));
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS boredom_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Default to disabled on first run until toggled via /boredom enable
    const existing = this.db.query('SELECT value FROM boredom_state WHERE key = ?').get('enabled') as { value: string } | undefined;
    if (!existing) {
      this.db.run('INSERT INTO boredom_state (key, value) VALUES (?, ?)', ['enabled', '0']);
    }
  }

  private getStateValue(key: string): string | null {
    const row = this.db.query('SELECT value FROM boredom_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private setStateValue(key: string, value: string): void {
    this.db.run(
      `INSERT INTO boredom_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }

  public getState(): BoredomState {
    const enabledRaw = this.getStateValue('enabled');
    const minRaw = this.getStateValue('min_interval_minutes');
    const maxRaw = this.getStateValue('max_interval_minutes');

    return {
      enabled: enabledRaw === '1',
      minIntervalMinutes: minRaw ? parseInt(minRaw, 10) : config.boredom.minIntervalMinutes,
      maxIntervalMinutes: maxRaw ? parseInt(maxRaw, 10) : config.boredom.maxIntervalMinutes,
      lastRunAt: this.getStateValue('last_run_at'),
      nextRunAt: this.getStateValue('next_run_at'),
    };
  }

  public setIntervals(minMinutes: number, maxMinutes: number): void {
    this.setStateValue('min_interval_minutes', minMinutes.toString());
    this.setStateValue('max_interval_minutes', maxMinutes.toString());
    console.log(`😴 [BOREDOM] Updated interval: ${minMinutes} - ${maxMinutes} minutes.`);

    // Reschedule next execution if currently enabled
    const state = this.getState();
    if (state.enabled) {
      this.scheduleNext();
    }
  }

  public setEnabled(enabled: boolean): void {
    this.setStateValue('enabled', enabled ? '1' : '0');
    if (enabled) {
      this.scheduleNext();
    } else {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.setStateValue('next_run_at', '');
      console.log('😴 [BOREDOM] Spontaneous chatter disabled.');
    }
  }

  public start(client: Client): void {
    this.client = client;
    const state = this.getState();

    if (!state.enabled) {
      console.log('😴 [BOREDOM] Spontaneous chatter is currently disabled (use /boredom enable).');
      return;
    }

    const now = Date.now();
    const lastRunTime = state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
    const minIntervalMs = state.minIntervalMinutes * 60 * 1000;

    if (lastRunTime && now - lastRunTime < minIntervalMs) {
      // Offline duration was less than minimum interval; schedule remaining or random delay
      const remaining = minIntervalMs - (now - lastRunTime);
      this.scheduleNext(remaining);
    } else if (lastRunTime && now - lastRunTime >= minIntervalMs) {
      // Missed an execution while offline: warm up for 2-5 minutes before first trigger
      const jitterMs = Math.floor(Math.random() * (5 - 2 + 1) + 2) * 60 * 1000;
      console.log(`😴 [BOREDOM] Offline longer than interval. Scheduling initial chatter in ${Math.round(jitterMs / 60000)} minutes.`);
      this.scheduleNext(jitterMs);
    } else {
      this.scheduleNext();
    }
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('😴 [BOREDOM] Spontaneous chatter stopped.');
  }

  public scheduleNext(customDelayMs?: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const state = this.getState();
    if (!state.enabled) return;

    let delayMs = customDelayMs;
    if (delayMs === undefined) {
      const minMs = state.minIntervalMinutes * 60 * 1000;
      const maxMs = state.maxIntervalMinutes * 60 * 1000;
      delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }

    const nextRun = new Date(Date.now() + delayMs);
    this.setStateValue('next_run_at', nextRun.toISOString());

    console.log(`😴 [BOREDOM] Next spontaneous chat scheduled in ${Math.round(delayMs / 60000)} minutes (at ${nextRun.toLocaleTimeString()})`);

    this.timer = setTimeout(async () => {
      if (this.client) {
        await this.executeSpontaneousChat(this.client);
      }
    }, delayMs);
  }

  public async executeSpontaneousChat(client: Client): Promise<boolean> {
    if (this.isExecuting) return false;
    this.isExecuting = true;

    try {
      if (config.boredom.channelIds.length === 0) {
        console.warn('⚠️ [BOREDOM] No channels configured in BOREDOM_CHANNELS.');
        return false;
      }

      const validChannels: GuildTextBasedChannel[] = [];

      for (const channelId of config.boredom.channelIds) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased()) continue;

          // Exclude DMs, only allow server guild text-based channels
          if (!('guild' in channel) || !channel.guild) continue;

          if (config.bot.nsfwOnly) {
            const isNsfw = 'nsfw' in channel && channel.nsfw === true;
            const parentIsNsfw = channel.isThread() && channel.parent && 'nsfw' in channel.parent && channel.parent.nsfw === true;
            if (!isNsfw && !parentIsNsfw) continue;
          }

          const me = channel.guild.members.me;
          if (!me) continue;

          const perms = channel.permissionsFor(me);
          if (
            perms?.has(PermissionFlagsBits.ViewChannel) &&
            perms?.has(PermissionFlagsBits.SendMessages) &&
            perms?.has(PermissionFlagsBits.ReadMessageHistory)
          ) {
            validChannels.push(channel as GuildTextBasedChannel);
          }
        } catch (err) {
          console.warn(`⚠️ [BOREDOM] Could not access channel ${channelId}:`, err);
        }
      }

      if (validChannels.length === 0) {
        console.warn('⚠️ [BOREDOM] No accessible or eligible channels found in BOREDOM_CHANNELS pool.');
        return false;
      }

      const channel = validChannels[Math.floor(Math.random() * validChannels.length)]!;
      console.log(`😴 [BOREDOM] Selected channel #${channel.name} (${channel.id}) in ${channel.guild.name}`);

      const turnStartedAt = Date.now();

      // fetchChannelHistory takes only (channel, beforeMessageId) and applies
      // its own CHANNEL_MAX_HISTORY limit, so the previous third argument was
      // silently ignored. config.boredom.historyLimit has never affected this.
      const rawMessages = await channelHistoryService.fetchChannelHistory(channel);
      const turns = channelHistoryService.convertToTurns(rawMessages, client.user?.id);

      const isGifEnabled = channel.guildId ? gifService.isGifEnabled(channel.guildId) : false;

      const spontaneousInstructions = [
        'You are popping into the channel spontaneously. Read the recent chat history to see what was being talked about.',
        'Either chime in with a quick, funny, or chaotic observation about their recent conversation, or bring up a random thought fitting your persona if chat has been quiet.',
        'Do not ping anyone or say "hey guys", just speak naturally into the room.',
        'Keep it short (1-3 sentences).',
        'Do not include [REACT: ...] tags or emoji reaction directives.',
      ].join(' ');

      if (config.boredom.showTyping) {
        try {
          await channel.sendTyping();
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch {}
      }

      const aiService = getAIService();
      // A boredom turn has no user prompt, so the payload the service built is
      // the only record of what was actually sent. Worth capturing.
      let fullPrompt: string | undefined;
      const response = await aiService.createChatCompletion({
        messages: turns,
        systemPromptOverride: spontaneousInstructions,
        enableSearch: false,
        enableKnowledgeGraph: false,
        isGifEnabled,
        guildId: channel.guildId,
        onFullPrompt: (captured: string) => { fullPrompt = captured; },
      });

      const { text: textWithoutGif, gifUrl } = isGifEnabled
        ? await gifService.extractAndResolveGif(response)
        : { text: response, gifUrl: undefined };

      const formatted = formatDiscordResponseText(textWithoutGif);
      if (!formatted.trim() && !gifUrl) {
        console.warn('⚠️ [BOREDOM] Generated empty message, skipping output.');
        return false;
      }

      if (formatted.trim()) {
        // The text is model output over whatever the channel was talking about, so
        // it can contain anything the prompt did — including a `@everyone`
        // copied out of a linked page. `buildAllowedMentions` is the shared form
        // every other untrusted-text path now uses.
        //
        // NOTE for the next reader: the helper also sets `repliedUser: false`,
        // which is a no-op here (a `channel.send` has no replied message to
        // suppress), so this is behaviourally identical to the inline
        // `{ parse: [] }` it replaces. The semantics deliberately match; the
        // consolidation is what is being bought here, so please do not "fix"
        // this back into a private shape.
        await channel.send({
          content: formatted,
          allowedMentions: buildAllowedMentions(),
        });
      }

      if (gifUrl) {
        await channel.send(gifUrl);
      }

      const now = new Date().toISOString();
      this.setStateValue('last_run_at', now);
      console.log(`😴 [BOREDOM] Spontaneous message sent to #${channel.name}`);

      dashboardLoggerService.log({
        source: 'boredom',
        prompt: '[spontaneous chatter — no user prompt]',
        fullPrompt,
        response: formatted,
        durationMs: Date.now() - turnStartedAt,
        channelId: channel.id,
        channelName: channel.name,
        guildId: channel.guildId || undefined,
        guildName: channel.guild?.name,
        gifUrl,
        searchEnabled: false,
        knowledgeEnabled: false,
      });

      return true;
    } catch (error) {
      console.error('❌ [BOREDOM] Error executing spontaneous chat:', error);
      return false;
    } finally {
      this.isExecuting = false;
      this.scheduleNext();
    }
  }
}

export const boredomService = new BoredomService();