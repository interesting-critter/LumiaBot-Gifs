import { AttachmentBuilder, Client, Collection, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel, GuildMember, StickerFormatType, userMention, type Channel } from 'discord.js';
import { buildResponseCard } from '../utils/response-card';
import { config } from '../utils/config';
import { shouldTriggerBot, extractMessageContent, handleMessage, extractTriggerKeywords } from '../services/message-handler';
import { boredomService } from '../services/boredom';
import { channelHistoryService } from '../services/channel-history';
import { getBotCouncilProfile, getErrorMessage, getTriggerKeywords, runWithPromptContext } from '../services/prompts';
import { userActivityService } from '../services/user-activity';
import { userMemoryService } from '../services/user-memory';
import { pageExtractorService } from '../services/page-extractor';
import { knowledgeGraphService } from '../services/knowledge-graph';
import { formatDiscordResponseText } from '../utils/discord-markdown';
import type { ChatInputCommandInteraction } from 'discord.js';
import { LumiaBotIntegration } from '../services/orchestrator';
import { orchestratorTurnJournal } from '../services/orchestrator/turn-journal';
import type { MessageContext, ReplyContext, MediaAttachment, TextAttachment, ResponseRequestPayload, CollectiveKnowledgeResultPayload } from '../services/orchestrator/types';
import type { ResolvedUserMention, ResolveUserMention } from '../services/user-mention-resolver';
import type { GeneratedImageAttachment } from '../services/swarmui';
import { navidromeService } from '../services/navidrome';
import { rateLimiterService } from '../services/rate-limiter';
import { buildAllowedMentions } from '../utils/permissions';
import { assertPublicUrl, safeFetchText } from '../utils/safe-fetch';
import { mediaAllowedHosts } from '../utils/media-allowlist';
import { emojiLookupContext, resolveEmoji, toEmojiReactionForm } from '../utils/emoji';
import type { InteractionSource } from '../services/dashboard-logger';

export interface Command {
  data: {
    name: string;
    description: string;
    toJSON: () => unknown;
  };
  ownerOnly?: boolean;
  ownerOnlySubcommands?: readonly string[];
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

interface OrchestratorQueuedInfo {
  message: Message;
  replyContext?: ReplyContext;
  imageUrls: string[];
  videoUrls: MediaAttachment[];
  textAttachments: TextAttachment[];
}

/**
 * The reply context a triggered message carries from `onMessageCreate` into the
 * queued turn.
 *
 * Named so the turn's entry-point wrapper and its body can share one
 * declaration: `processTriggeredMessage` exists only to open the guild's prompt
 * context, and duplicating this shape across both signatures would be the one
 * place the two could drift.
 */
interface TriggeredMessageReplyContext {
  isReply: boolean;
  isReplyToLumia: boolean;
  originalContent?: string;
  originalTimestamp?: string;
  originalAuthor?: string;
  embeddedContent?: {
    images: string[];
    videos: { url: string; mimeType?: string }[];
  };
}

/**
 * Categorize stickers on a Discord message for the AI pipeline.
 * PNG/APNG stickers go to image inputs (APNG only renders frame 1 in vision models, but
 * the sticker name covers the animation intent). GIF stickers go to the video pipeline
 * so they hit the same GIF→WebM conversion path as regular GIF attachments. Lottie
 * stickers are JSON vector animations — nothing rasterizes them server-side, so we fall
 * back to a text hint using the sticker name. Every sticker also contributes a name hint
 * so the bot has context even when the media can't be ingested.
 */
function extractStickerMedia(
  message: Message,
  logPrefix: string,
  silent: boolean = false,
): {
  imageUrls: string[];
  videoUrls: { url: string; mimeType?: string }[];
  stickerHints: string[];
} {
  const imageUrls: string[] = [];
  const videoUrls: { url: string; mimeType?: string }[] = [];
  const stickerHints: string[] = [];

  if (message.stickers.size === 0) {
    return { imageUrls, videoUrls, stickerHints };
  }

  for (const sticker of message.stickers.values()) {
    const name = sticker.name || 'unnamed';
    switch (sticker.format) {
      case StickerFormatType.GIF:
        videoUrls.push({ url: sticker.url, mimeType: 'image/gif' });
        stickerHints.push(`[Animated sticker: ${name}]`);
        if (!silent) console.log(`🎬 [${logPrefix}] GIF sticker: ${name} (${sticker.url})`);
        break;
      case StickerFormatType.APNG:
        imageUrls.push(sticker.url);
        stickerHints.push(`[Animated sticker: ${name}]`);
        if (!silent) console.log(`🖼️  [${logPrefix}] APNG sticker: ${name} (${sticker.url})`);
        break;
      case StickerFormatType.PNG:
        imageUrls.push(sticker.url);
        stickerHints.push(`[Sticker: ${name}]`);
        if (!silent) console.log(`🖼️  [${logPrefix}] PNG sticker: ${name} (${sticker.url})`);
        break;
      case StickerFormatType.Lottie:
        stickerHints.push(`[Lottie sticker: ${name}]`);
        if (!silent) console.log(`✨ [${logPrefix}] Lottie sticker (name-only, no raster): ${name}`);
        break;
      default:
        stickerHints.push(`[Sticker: ${name}]`);
        if (!silent) console.log(`❓ [${logPrefix}] Unknown sticker format (${sticker.format}): ${name}`);
    }
  }

  return { imageUrls, videoUrls, stickerHints };
}

/**
 * Extract custom emoji CDN URLs from message content so the AI model can see them.
 * Custom emojis appear as <:name:id> (static) or <a:name:id> (animated).
 */
function extractCustomEmojiUrls(content: string, logPrefix: string, silent: boolean = false): string[] {
  const emojiRegex = /<(a?):(\w+):(\d+)>/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = emojiRegex.exec(content)) !== null) {
    const animated = match[1] === 'a';
    const name = match[2];
    const id = match[3];
    const ext = animated ? 'gif' : 'png';
    const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=96&quality=lossless`;
    urls.push(url);
    if (!silent) console.log(`😀 [${logPrefix}] Custom emoji: :${name}: (${url})`);
  }

  return urls;
}

/**
 * Format time ago from a date
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

function isReplyReferenceFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: number | string;
    message?: string;
    rawError?: { code?: number | string; message?: string };
  };

  const code = typeof candidate.code === 'number'
    ? candidate.code
    : typeof candidate.rawError?.code === 'number'
      ? candidate.rawError.code
      : undefined;

  const message = `${candidate.message || ''} ${candidate.rawError?.message || ''}`;

  return code === 10008 || message.includes('Unknown Message');
}

function getMessageAuthorDisplayName(message: Message): string {
  return message.member?.displayName || message.author.displayName || message.author.username;
}

function getMentionedUserDisplayMap(message: Message): Map<string, string> {
  const mentionedUsers = new Map<string, string>();

  if (message.mentions.members && message.mentions.members.size > 0) {
    message.mentions.members.forEach((member) => {
      mentionedUsers.set(member.id, member.displayName || member.user.displayName || member.user.username);
    });
  }

  message.mentions.users.forEach((user) => {
    if (!mentionedUsers.has(user.id)) {
      mentionedUsers.set(user.id, user.displayName || user.username);
    }
  });

  return mentionedUsers;
}

export function buildDiscordImageFiles(attachments: GeneratedImageAttachment[]): AttachmentBuilder[] {
  return attachments.map((attachment) => new AttachmentBuilder(attachment.data, {
    name: attachment.name,
  }));
}

function isDiscordNsfwChannel(channel: Message['channel'] | Channel | null | undefined): boolean {
  if (!channel) {
    return false;
  }

  if ('nsfw' in channel && channel.nsfw === true) {
    return true;
  }

  if (channel instanceof ThreadChannel && channel.parent && 'nsfw' in channel.parent) {
    return channel.parent.nsfw === true;
  }

  return false;
}

/**
 * Classify why the bot woke up, for the dashboard's activity log.
 * Priority: explicit reply to the bot > direct mention > keyword trigger.
 */
function resolveInteractionSource(
  content: string,
  botId: string,
  isReplyToBot: boolean,
): InteractionSource {
  if (isReplyToBot) {
    return 'reply';
  }
  if (getBotMentionPattern(botId).test(content)) {
    return 'mention';
  }
  return 'keyword';
}

/**
 * Best-effort human-readable channel name. Threads report their parent channel
 * so the log groups activity by the space users actually think of.
 */
function getChannelDisplayName(channel: Message['channel'] | null | undefined): string | undefined {
  if (!channel) {
    return undefined;
  }
  if (channel instanceof ThreadChannel) {
    return channel.parent?.name ?? channel.name;
  }
  if ('name' in channel && typeof channel.name === 'string') {
    return channel.name;
  }
  return undefined;
}

function canUserRequestNsfwImages(channel: Message['channel'], userId?: string): boolean {
  // NSFW image generation always requires an NSFW-marked channel.
  if (!isDiscordNsfwChannel(channel)) {
    return false;
  }

  // When the bot is globally locked to NSFW channels, the channel gate alone is
  // sufficient — every responder is already in an age-restricted space, so any
  // user may request NSFW image generation (no owner check needed).
  if (config.bot.nsfwOnly) {
    return true;
  }

  // Otherwise, NSFW image generation stays owner-only.
  return !!userId && userId === config.bot.ownerId;
}

// ---------------------------------------------------------------------------
// Pure helpers (no Discord objects) — unit-tested in `__tests__/generation-guard.test.ts`
// ---------------------------------------------------------------------------

/**
 * The hosts this bot is willing to fetch media from server-side.
 *
 * Discord allows `embed.image.url` / `embed.thumbnail.url` / `embed.video.url` to
 * be an **arbitrary http(s) URL on any host** — there is no Discord-CDN
 * restriction at the API level. Those URLs are fetched by the server and
 * base64-inlined into a request to an external model vendor, so an unfiltered
 * list is both an SSRF sink (`http://127.0.0.1:4533/rest/getCoverArt.view`,
 * `http://127.0.0.1:3001/api/persona`, `http://169.254.169.254/…`) and an
 * exfiltration channel: the fetched bytes leave to the model vendor and the
 * model frequently narrates them back into the channel.
 *
 * The list itself lives in `utils/media-allowlist.ts` and is operator
 * configurable via `DISCORD_MEDIA_ALLOWED_HOSTS`, because a Discord-only list
 * also drops real Tenor/Giphy `gifv` embeds whose `video.url` is
 * `media.tenor.com`. Matching still goes through `utils/safe-fetch.ts`, so this
 * is one allowlist, not two. See `media-allowlist.ts` for the trust argument.
 */

/** Wall-clock budget for a single server-side media fetch. */
const DISCORD_MEDIA_TIMEOUT_MS = 15_000;

/**
 * Is this URL one this bot is willing to fetch server-side on behalf of a
 * Discord-supplied reference?
 *
 * Fails **closed** (a rejected URL is dropped, not fetched) because the input is
 * attacker-controlled by any member of any guild.
 */
async function isPermittedDiscordMediaUrl(url: string): Promise<boolean> {
  try {
    await assertPublicUrl(url, { allowHosts: mediaAllowedHosts() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop every URL that is not on the configured media allowlist.
 *
 * Called on the image/video lists immediately before they are handed to
 * `handleMessage`, which is what ultimately performs the server-side fetch.
 */
async function filterDiscordMediaUrls(urls: string[], logPrefix: string): Promise<string[]> {
  if (urls.length === 0) {
    return urls;
  }
  const permitted = await Promise.all(urls.map(isPermittedDiscordMediaUrl));
  const kept = urls.filter((_, index) => permitted[index] === true);
  if (kept.length !== urls.length) {
    for (let i = 0; i < urls.length; i++) {
      if (permitted[i] !== true) {
        // Log the host only. A full URL can carry a signature/token in its query.
        let host = 'unparseable';
        try {
          host = new URL(urls[i] as string).host;
        } catch {
          // keep the placeholder
        }
        console.warn(`🛡️  [${logPrefix}] Dropped media URL outside the configured allowlist (host: ${host})`);
      }
    }
  }
  return kept;
}

/** {@link filterDiscordMediaUrls} for `{ url, mimeType }` attachments. */
async function filterDiscordMediaAttachments(
  media: { url: string; mimeType?: string }[],
  logPrefix: string,
): Promise<{ url: string; mimeType?: string }[]> {
  if (media.length === 0) {
    return media;
  }
  const permitted = await Promise.all(media.map((entry) => isPermittedDiscordMediaUrl(entry.url)));
  const kept = media.filter((_, index) => permitted[index] === true);
  if (kept.length !== media.length) {
    console.warn(
      `🛡️  [${logPrefix}] Dropped ${media.length - kept.length} media attachment(s) outside the configured allowlist`,
    );
  }
  return kept;
}

/**
 * Did the user summon the bot without saying anything?
 *
 * Extracted so the "start typing" call can be placed strictly *after* this
 * check. The empty-content branch replies and returns, so any typing started
 * before it leaked an 8-second interval per channel that only ever self-heals
 * when `sendTyping()` throws — which it does not for a healthy channel.
 */
export function isEmptyTriggeredTurn(
  hasTrigger: boolean,
  cleanedContent: string,
  stickerHintCount: number,
): boolean {
  return hasTrigger && cleanedContent.trim().length === 0 && stickerHintCount === 0;
}

/**
 * A held generation key.
 *
 * The point of the object is that {@link GenerationKeyGuard.release} accepts
 * *only* a lease it issued. A caller that lost the `begin` race has `null`, and
 * `release(null)` is a no-op — so a duplicate-suppressed turn can no longer
 * delete the key that the in-flight generation is still using.
 */
export class GenerationLease {
  private released = false;

  constructor(
    private readonly guard: GenerationKeyGuard,
    readonly key: string,
  ) {}

  get isReleased(): boolean {
    return this.released;
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.guard.endGeneration(this.key);
  }
}

/**
 * In-flight generation guard.
 *
 * Two layers, because they defend against different things:
 *
 *   - `active` is the *correctness* lock. It is released only by the holder,
 *     via its lease. A generation that runs longer than the recent-TTL (a
 *     10-round tool loop plus retries makes that entirely plausible) keeps its
 *     lock indefinitely; the recent layer below exists purely to suppress
 *     near-simultaneous duplicates, not to enforce mutual exclusion.
 *   - `recent` is a 120s suppression window so a retry of the *same* Discord
 *     message does not regenerate. It is TTL'd precisely because it must not
 *     outlive the work.
 *
 * The bug this replaces: `endGeneration(key)` took a bare key, so the `finally`
 * of a turn whose `beginGeneration` had returned `false` deleted the key held
 * by the real, still-running generation. `recent` masked it for 120s; past that
 * two generations for one message ran concurrently.
 */
export class GenerationKeyGuard {
  private readonly active = new Map<string, GenerationLease>();
  private readonly recent = new Set<string>();
  private readonly recentTimers = new Map<string, Timer>();

  constructor(private readonly recentTtlMs: number = 120_000) {}

  /**
   * Try to take the lock for `key`.
   * @returns a lease the caller **must** release, or `null` when the key is
   *          already in flight or was in flight within the recent window.
   */
  begin(key: string): GenerationLease | null {
    if (this.active.has(key) || this.recent.has(key)) {
      return null;
    }

    const lease = new GenerationLease(this, key);
    this.active.set(key, lease);
    this.recent.add(key);

    const timer = setTimeout(() => {
      this.recent.delete(key);
      this.recentTimers.delete(key);
    }, this.recentTtlMs);
    // Never let a suppression timer hold the process open.
    timer.unref?.();
    this.recentTimers.set(key, timer);

    return lease;
  }

  /**
   * Release a lease. A `null` lease (the caller lost the `begin` race) and an
   * already-released or superseded lease are both no-ops.
   */
  release(lease: GenerationLease | null | undefined): void {
    if (!lease || lease.isReleased) {
      return;
    }
    lease.release();
  }

  /** @internal called by {@link GenerationLease.release} */
  endGeneration(key: string): void {
    this.active.delete(key);
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  isRecent(key: string): boolean {
    return this.recent.has(key);
  }

  /** Drop all state and cancel suppression timers. Used on shutdown and in tests. */
  clear(): void {
    for (const timer of this.recentTimers.values()) {
      clearTimeout(timer);
    }
    this.recentTimers.clear();
    this.active.clear();
    this.recent.clear();
  }
}

/** A live typing ticker: the interval handle plus the channel it pings. */
interface TypingTicker {
  interval: Timer;
  channelId: string;
}

/**
 * Holder token for orchestrator-driven typing.
 *
 * The orchestrator signals typing as a boolean per channel rather than per turn,
 * so its token is a constant. Direct-path turns use `turn:<messageId>` instead.
 */
const ORCHESTRATOR_TYPING_HOLDER = 'orchestrator';

/** Holder token for a single direct-path turn. */
function directTypingHolder(messageId: string): string {
  return `turn:${messageId}`;
}

/** The Discord channel shapes that expose `sendTyping()`. */
type TypeableChannel =
  | TextChannel
  | ThreadChannel
  | NewsChannel
  | VoiceChannel
  | StageChannel
  | DMChannel;

/**
 * Ref-counted typing indicators, one live interval per channel.
 *
 * The old map was keyed by channel with no reference counting, and `startTyping`
 * called `stopTyping` first. Two concurrent turns in one channel therefore fought:
 * turn B's start cancelled turn A's interval, and A's `stopTyping` then killed B's,
 * so the indicator vanished mid-generation — exactly when the queue is deepest and
 * the user most needs the feedback. Holders are per-turn tokens and the interval
 * only stops when the last holder releases.
 */
export class TypingIndicatorRegistry<THandle = unknown> {
  private readonly holders = new Map<string, Set<string>>();
  private readonly handles = new Map<string, THandle>();

  constructor(
    private readonly beginTicking: (channelId: string, onFailure: () => void) => THandle,
    private readonly endTicking: (handle: THandle) => void,
  ) {}

  /**
   * Register `holder` (a per-turn token) as wanting a typing indicator in
   * `channelId`. Idempotent per holder: acquiring the same token twice does not
   * double-count, so a retried turn cannot pin the indicator open.
   */
  acquire(channelId: string, holder: string): void {
    let set = this.holders.get(channelId);
    if (!set) {
      set = new Set<string>();
      this.holders.set(channelId, set);
    }
    if (set.has(holder)) {
      return;
    }
    set.add(holder);

    if (this.handles.has(channelId)) {
      return;
    }

    try {
      const handle = this.beginTicking(channelId, () => this.releaseChannel(channelId));
      this.handles.set(channelId, handle);
    } catch (error) {
      // A failed start must not leave a phantom holder behind.
      this.release(channelId, holder);
      throw error;
    }
  }

  /** Release one holder. The interval stops only when the last one leaves. */
  release(channelId: string, holder: string): void {
    const set = this.holders.get(channelId);
    if (!set) {
      return;
    }
    set.delete(holder);
    if (set.size === 0) {
      this.holders.delete(channelId);
      this.stopHandle(channelId);
    }
  }

  /** Force-stop a channel regardless of holders (channel lost, shutdown, REST failure). */
  releaseChannel(channelId: string): void {
    this.holders.delete(channelId);
    this.stopHandle(channelId);
  }

  releaseAll(): void {
    for (const channelId of Array.from(this.holders.keys())) {
      this.releaseChannel(channelId);
    }
    for (const channelId of Array.from(this.handles.keys())) {
      this.stopHandle(channelId);
    }
  }

  /** Number of channels with a live indicator. */
  get size(): number {
    return this.handles.size;
  }

  /** Number of channels with at least one holder, exposed so leaks are assertable in tests. */
  get trackedChannels(): number {
    return this.holders.size;
  }

  /** Every channel that currently has at least one holder. */
  trackedChannelsKeys(): IterableIterator<string> {
    return this.holders.keys();
  }

  holderCount(channelId: string): number {
    return this.holders.get(channelId)?.size ?? 0;
  }

  isActive(channelId: string): boolean {
    return this.handles.has(channelId);
  }

  private stopHandle(channelId: string): void {
    const handle = this.handles.get(channelId);
    if (handle === undefined) {
      return;
    }
    this.handles.delete(channelId);
    this.endTicking(handle);
  }
}

/**
 * Log a failure from the message-handling loop with enough context to find the
 * offending turn, and nothing that should not be logged.
 *
 * Deliberately excluded: `message.content` (arbitrary user text — it can contain
 * a secret the user pasted, and log aggregators are frequently a wider audience
 * than the channel) and anything token-shaped. Included: guild, channel, author
 * and message ids, which are enough to locate the message with one API call.
 */
function logMessageHandlerFailure(
  source: string,
  message: Pick<Message, 'id' | 'channelId' | 'guildId' | 'author'> | undefined,
  error: unknown,
  extra?: { channelId?: string; messageId?: string },
): void {
  const reason = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);

  console.error(`❌ [CLIENT/${source}] Unhandled message-handling failure`, {
    reason,
    stack: error instanceof Error ? error.stack : undefined,
    guildId: message?.guildId,
    channelId: message?.channelId ?? extra?.channelId,
    messageId: message?.id ?? extra?.messageId,
    userId: message?.author?.id,
    username: message?.author?.username,
  });
}

/**
 * `<@123>` / `<@!123>` pattern for one bot id, compiled once.
 *
 * `resolveInteractionSource` runs on every triggered message and the old code
 * compiled a fresh `RegExp` each call. The pattern is cached by id because the
 * id is only known after login, but it never changes for the life of the client.
 */
let mentionPatternCache: { botId: string; pattern: RegExp } | null = null;

function getBotMentionPattern(botId: string): RegExp {
  if (!mentionPatternCache || mentionPatternCache.botId !== botId) {
    mentionPatternCache = { botId, pattern: new RegExp(`<@!?${botId}>`) };
  }
  return mentionPatternCache.pattern;
}

export class DiscordBot {
  public client: Client;
  public commands: Collection<string, Command>;
  private typingIndicators: TypingIndicatorRegistry<TypingTicker>;
  private typingChannels: Map<string, TypeableChannel>;
  private generationGuard: GenerationKeyGuard;
  private orchestrator?: LumiaBotIntegration;
  private orchestratorQueue: Map<string, OrchestratorQueuedInfo>; // eventId -> message info
  private queuedMessageChannels: Map<string, string>; // eventId -> channelId this bot queued for
  private orchestratorSweepInterval?: Timer;
  private channelProcessingQueue: Map<string, Promise<void>>; // per-channel sequential processing
  private processedMessageIds: Set<string>; // duplicate event guard
  private processedMessageTimers: Map<string, Timer>; // TTL cleanup for processedMessageIds
  private repliedMessageIds: Set<string>; // cross-path guard: prevents double replies regardless of trigger path
  private repliedMessageTimers: Map<string, Timer>; // TTL cleanup for repliedMessageIds

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
      ],
    });

    this.commands = new Collection();
    this.generationGuard = new GenerationKeyGuard();
    this.typingChannels = new Map();
    this.typingIndicators = new TypingIndicatorRegistry<TypingTicker>(
      (channelId, onFailure) => this.startTypingTicker(channelId, onFailure),
      (ticker) => {
        clearInterval(ticker.interval);
        this.typingChannels.delete(ticker.channelId);
      },
    );
    this.orchestratorQueue = new Map();
    this.queuedMessageChannels = new Map();
    this.channelProcessingQueue = new Map();
    this.processedMessageIds = new Set();
    this.processedMessageTimers = new Map();
    this.repliedMessageIds = new Set();
    this.repliedMessageTimers = new Map();
    this.setupEventHandlers();
    this.setupOrchestrator();
  }

  private buildOrchestratorContextNote(context: MessageContext): string | undefined {
    const lines: string[] = [];
    const councilName = context.councilFamilyName || config.orchestrator.councilName || config.orchestrator.familyName;

    if (councilName) {
      lines.push(`You are participating in the ${councilName} council. Cooperate with other council members as distinct bots with complementary perspectives, not necessarily as family or siblings.`);
    }

    if (context.sessionMode) {
      lines.push(`Session mode: ${context.sessionMode}.`);
    }

    if (context.sessionPhase) {
      lines.push(`Session phase: ${context.sessionPhase}.`);
    }

    lines.push(`You are on turn ${context.turnCount + 1} of up to ${context.maxTurns}.`);

    if (context.replyingToBotName) {
      lines.push(`You are directly replying to ${context.replyingToBotName}.`);
      lines.push(`Treat this as bot-to-bot dialogue first: address ${context.replyingToBotName}'s point before circling back to any human.`);
    }

    if (context.nearbyBots && context.nearbyBots.length > 0) {
      const botNames = context.nearbyBots.filter((bot) => bot.isOnline).map((bot) => bot.botName);
      if (botNames.length > 0) {
        lines.push(`${councilName ? `Other active ${councilName} council members nearby` : 'Other active bots nearby'}: ${botNames.join(', ')}.`);
      }

      const profileLines = context.nearbyBots
        .filter((bot) => bot.isOnline && bot.councilProfile)
        .map((bot) => `${bot.botName}: ${bot.councilProfile}`);
      if (profileLines.length > 0) {
        lines.push(`Council member profiles for appearance and address context:\n${profileLines.join('\n\n')}`);
      }
    }

    if (context.sessionSummary) {
      lines.push(`Session summary: ${context.sessionSummary}`);
    }

    if (context.shouldWrapUp) {
      lines.push('The orchestrator thinks this exchange is approaching a natural ending, so wrap cleanly unless there is a strong new hook.');
    }

    lines.push(`Do not repeat or closely paraphrase an earlier ${councilName || 'bot'} message. Add a fresh angle, disagreement, synthesis, or question.`);

    if (context.scratchpad) {
      lines.push(`Your scratchpad: turnsTaken=${context.scratchpad.turnsTaken}, suppressedResponses=${context.scratchpad.suppressedResponses}, unansweredQuestionsSeen=${context.scratchpad.unansweredQuestionsSeen}, noveltyPressure=${context.scratchpad.noveltyPressure.toFixed(2)}.`);
      if (context.scratchpad.privateNotes.length > 0) {
        lines.push(`Private notes: ${context.scratchpad.privateNotes.join(' ')}`);
      }
      if (context.scratchpad.lastNoveltyReasons.length > 0) {
        lines.push(`Novelty check: ${context.scratchpad.lastNoveltyReasons.join('; ')}.`);
      }
      if (context.scratchpad.lastImpulseReasons.length > 0) {
        lines.push(`Why you were in the running to speak: ${context.scratchpad.lastImpulseReasons.join('; ')}.`);
      }
    }

    if (context.recentImpulses && context.recentImpulses.length > 0) {
      const impulseSummary = context.recentImpulses
        .slice(0, 3)
        .map((impulse) => `${impulse.botName}=${impulse.score.toFixed(2)}${impulse.reasons.length > 0 ? ` (${impulse.reasons.join(', ')})` : ''}`)
        .join(' | ');
      lines.push(`Latest impulse ranking: ${impulseSummary}`);
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private buildUserMentionResolver(
    message: Message,
    allowedMentionUserIds: Set<string>,
  ): ResolveUserMention | undefined {
    const guild = message.guild;
    if (!guild) {
      return undefined;
    }

    const addResult = (
      results: ResolvedUserMention[],
      seen: Set<string>,
      member: GuildMember,
      source: ResolvedUserMention['source'],
      matchScore?: number,
    ) => {
      if (seen.has(member.id)) return;

      seen.add(member.id);
      allowedMentionUserIds.add(member.id);
      results.push({
        userId: member.id,
        username: member.user.username,
        displayName: member.displayName || member.user.displayName || member.user.username,
        mention: userMention(member.id),
        source,
        matchScore,
      });
    };

    return async (query: string, maxResults: number = 5) => {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) {
        return [];
      }

      const limit = Math.max(1, Math.min(maxResults || 5, 10));
      const results: ResolvedUserMention[] = [];
      const seen = new Set<string>();

      if (message.mentions.members) {
        message.mentions.members.forEach((member) => {
          const displayName = member.displayName.toLowerCase();
          const username = member.user.username.toLowerCase();
          if (displayName.includes(normalizedQuery) || username.includes(normalizedQuery)) {
            addResult(results, seen, member, 'current-message');
          }
        });
      }

      // Scope the memory lookup to this guild. Without the guild id every
      // resolveUserMention call searched the `legacy` bucket only, so the model
      // could never resolve a user it had met in the current server.
      const memoryMatches = userMemoryService.searchUsers(query, limit, guild.id);
      for (const match of memoryMatches) {
        if (results.length >= limit) break;
        try {
          const member = await guild.members.fetch(match.userId);
          addResult(results, seen, member, 'memory', match.matchScore);
        } catch {
          // The bot may remember users who are no longer in this guild.
        }
      }

      if (results.length < limit) {
        try {
          const guildMatches = await guild.members.fetch({ query, limit });
          guildMatches.forEach((member) => {
            if (results.length < limit) {
              addResult(results, seen, member, 'guild-search');
            }
          });
        } catch (error) {
          console.warn(`👥 [CLIENT] Guild member search failed for "${query}":`, error);
        }
      }

      return results;
    };
  }

  private normalizeOrchestratorResponse(text: string): string {
    return text
      .toLowerCase()
      .replace(/<[^>]+>/g, ' ')
      .replace(/[`*_~>#]/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isDuplicateOrchestratorResponse(text: string, context: MessageContext): boolean {
    const normalized = this.normalizeOrchestratorResponse(text);
    if (!normalized) {
      return false;
    }

    return context.previousMessages.some((message) => {
      if (!message.isBot) {
        return false;
      }

      return this.normalizeOrchestratorResponse(message.content) === normalized;
    });
  }

  private formatCollectiveKnowledgeResult(result: CollectiveKnowledgeResultPayload): string {
    if (result.queriedBotIds.length === 0) {
      return 'Collective knowledge is unavailable because neither the orchestrator knowledge graph nor any other connected bots were available to query.';
    }

    if (result.results.length === 0) {
      return `No matching collective knowledge was returned from the orchestrator-backed pool for "${result.query}". Queried sources: ${result.queriedBotIds.join(', ')}. Responded sources: ${result.respondedBotIds.join(', ') || 'none'}.`;
    }

    const sections = result.results.map((entry, index) => {
      const matchedKeywords = entry.matchedKeywords.length > 0 ? entry.matchedKeywords.join(', ') : 'none';
      const urlLine = entry.url ? `\nURL: ${entry.url}` : '';
      return `${index + 1}. ${entry.title}\nSource bot: ${entry.sourceBotName} (${entry.sourceBotId})\nTopic: ${entry.topic}\nType: ${entry.type}\nMatched keywords: ${matchedKeywords}\nRelevance: ${entry.relevanceScore.toFixed(2)}${urlLine}\nPreview: ${entry.preview}\nExcerpt: ${entry.excerpt}`;
    });

    return `<collective-knowledge>
Results returned from the orchestrator knowledge graph and other connected bots via the orchestrator.
Original query: ${result.query}
Queried sources: ${result.queriedBotIds.join(', ')}
Responded sources: ${result.respondedBotIds.join(', ') || 'none'}

${sections.join('\n\n')}
</collective-knowledge>`;
  }

  private canUseCollectiveKnowledge(): boolean {
    return !!this.orchestrator
      && this.orchestrator.isConnectedToOrchestrator();
  }

  private buildCollectiveKnowledgeRequester(eventId: string, turnId: string, guildId?: string): ((query: string, maxResults?: number) => Promise<string>) | undefined {
    const orchestrator = this.orchestrator;
    if (!this.canUseCollectiveKnowledge() || !orchestrator) {
      return undefined;
    }

    return async (query: string, maxResults?: number) => this.formatCollectiveKnowledgeResult(
      await orchestrator.requestCollectiveKnowledge(eventId, turnId, query, maxResults, guildId)
    );
  }

  /**
   * Setup orchestrator integration if enabled
   */
  private setupOrchestrator(): void {
    if (!config.orchestrator.enabled) {
      console.log('[Orchestrator] Integration disabled');
      return;
    }

    console.log('[Orchestrator] Initializing integration...');

    this.orchestrator = new LumiaBotIntegration({
      orchestratorUrl: config.orchestrator.url,
      apiKey: config.orchestrator.apiKey,
      botId: config.orchestrator.botId,
      botName: config.orchestrator.botName,
      token: config.discord.token,
      guilds: [],
      metadata: {
        triggerKeywords: getTriggerKeywords().botMention,
        botFamilyName: config.bot.familyName || undefined,
        councilName: config.orchestrator.councilName || undefined,
        councilFamilyName: config.orchestrator.councilName || undefined,
        participatesInCouncil: config.orchestrator.councilParticipant,
        councilProfile: getBotCouncilProfile() || undefined,
      },
      reconnectIntervalMs: config.orchestrator.reconnectIntervalMs,
      maxReconnectAttempts: config.orchestrator.maxReconnectAttempts,
    });

    // Set up response handler for orchestrator
    //
    // Wrapped because an orchestrated turn is a full turn that starts here, not
    // at `handleMessage`: the orchestrator grants this bot a turn seconds or
    // minutes after the mention, in its own async chain, driven by a WebSocket
    // frame. Nothing else in that chain carries the guild, so without this the
    // whole turn would fall back to the main-page selection. The wrapper covers
    // the entire handler so prompt reads before and after `handleMessage` — the
    // journal replay, the duplicate-response check, the media allowlisting — all
    // resolve against the same guild, and so a concurrent turn in another guild
    // cannot interleave into a mixed profile.
    //
    // `payload.guildId` is optional (and is the literal `'dm'` for a guild-less
    // channel, per `notifyMention`), so it is a best-effort answer here;
    // `handleOrchestratorResponse` re-enters the context with the resolved
    // Discord message's own `guildId`, which is authoritative. Both resolve to
    // the main selection when the guild is a DM, which is the intended fallback.
    this.orchestrator.setResponseHandler(async (payload: ResponseRequestPayload) => {
      return runWithPromptContext(payload.guildId ?? null, () =>
        this.handleOrchestratorResponse(payload),
      );
    });

    this.orchestrator.setCollectiveKnowledgeHandler(async (payload) => {
      return knowledgeGraphService.findCollectiveKnowledgeCandidates(payload.query, payload.maxResults);
    });

    // Set up callback for when orchestrator says we should respond.
    // Note: Response is now sent directly in handleOrchestratorResponse.
    // We do NOT delete the queue entry here because follow-up turns may
    // reuse the same eventId and need the original Discord message object.
    // Queue entries are cleaned up by the periodic stale-entry sweep below.
    this.orchestrator.setResponseReadyCallback((eventId: string, response: string) => {
      console.log(`[Orchestrator] Response ready callback for event ${eventId} (response length: ${response.length})`);
    });

    // Periodically clean up stale orchestrator queue entries (older than 5 minutes).
    // This prevents memory leaks from events that never completed or had no follow-ups.
    //
    // The handle is retained so shutdown can clear it, and `unref()`'d so this
    // housekeeping timer can never be the reason the process stays alive.
    this.orchestratorSweepInterval = setInterval(() => {
      const staleThreshold = Date.now() - 5 * 60 * 1000;
      for (const [eventId, info] of this.orchestratorQueue.entries()) {
        if (info.message.createdTimestamp < staleThreshold) {
          this.orchestratorQueue.delete(eventId);
          // Drop the same event from the queued-message index so it cannot be
          // used to authorise a later snapshot reconstruction.
          this.queuedMessageChannels.delete(eventId);
          console.log(`[Orchestrator] Cleaned up stale queue entry for event ${eventId}`);
        }
      }
    }, 60_000);
    this.orchestratorSweepInterval.unref?.();

    // Set up typing callback for orchestrated responses
    this.orchestrator.setTypingCallback((channelId: string, guildId: string, isTyping: boolean) => {
      this.handleOrchestratorTyping(channelId, guildId, isTyping);
    });

    // Set up onConnect callback to send guilds when connected
    this.orchestrator.setOnConnect(() => {
      console.log('[Orchestrator] Connection established, sending guilds...');
      this.updateOrchestratorGuilds();
    });

    // Connect to orchestrator
    this.orchestrator.connect().then(() => {
      console.log('[Orchestrator] Connected successfully');
    }).catch((error) => {
      console.error('[Orchestrator] Failed to connect:', error);
      console.log('[Orchestrator] Continuing without orchestration...');
    });
  }

  /**
   * Handle orchestrator response request - generates actual response and sends it
   *
   * WHY THE TURN IS SPLIT IN TWO HERE
   * ---------------------------------
   * The guild is only knowable once the queued (or snapshot-reconstructed) message
   * is resolved, and resolution happens *after* the payload arrives. So this
   * method resolves the message first and then hands the whole turn to
   * {@link runOrchestratorTurn} inside the guild's prompt context.
   *
   * The wrapper is around the entire turn, not around the `handleMessage` call
   * alone, because prompt reads in this path are spread across many awaits —
   * mention resolution, media allowlisting, page extraction, history conversion,
   * then the system-prompt assembly and the rewrite pass. Wrapping only the
   * generation call would leave the earlier reads on whatever profile was
   * ambient, which is exactly the cross-guild cross-talk the ambient context
   * exists to make impossible. Because the context is established once around
   * the whole chain, a concurrent turn in a different guild cannot interleave
   * into this one, and no signature below changes.
   *
   * `message.guildId` is null for a DM, which resolves to the main-page
   * selection — the correct fallback.
   */
  private async handleOrchestratorResponse(payload: ResponseRequestPayload): Promise<string> {
    const { context, eventId, turnId } = payload;
    console.log('[Orchestrator] Generating response for event', {
      eventId,
      turnId,
      turnCount: context.turnCount,
      maxTurns: context.maxTurns,
      isBanter: context.isBanter,
    });

    const queuedInfo = await this.resolveOrchestratorQueuedInfo(payload);
    if (!queuedInfo) {
      console.error(`[Orchestrator] No queued or reconstructable message found for event ${eventId}`);
      return '';
    }

    // The live `Message` is authoritative for the guild, unlike `payload.guildId`
    // (optional, and the literal `'dm'` for a guild-less channel), and it is the
    // same value every later read in the turn would derive anyway.
    return runWithPromptContext(queuedInfo.message.guildId, () =>
      this.runOrchestratorTurn(payload, queuedInfo),
    );
  }

  /**
   * The body of an orchestrated turn, run inside the resolved message's guild
   * prompt context. Extracted only so {@link handleOrchestratorResponse} can open
   * that context around the whole turn; it has no other caller and takes no guild
   * argument, because the ambient context already carries it.
   */
  private async runOrchestratorTurn(
    payload: ResponseRequestPayload,
    queuedInfo: OrchestratorQueuedInfo,
  ): Promise<string> {
    const { context, eventId, turnId } = payload;

    const { message, replyContext, imageUrls, videoUrls, textAttachments } = queuedInfo;

    // NSFW-only mode: never generate an orchestrated response outside an NSFW channel,
    // even if the orchestrator grants this bot a turn (e.g. via a banter session).
    if (config.bot.nsfwOnly && !isDiscordNsfwChannel(message.channel)) {
      console.log(`🔞 [Orchestrator] NSFW-only mode: declining turn in non-NSFW channel ${message.channelId}`);
      return '';
    }

    const instanceId = this.orchestrator?.getInstanceId() ?? 'unknown';
    const generationKey = !context.replyToMessageId ? `root:${message.id}` : undefined;

    const journalTurn = orchestratorTurnJournal.getTurn(turnId);
    if (journalTurn?.responseText) {
      if (journalTurn.state === 'discord_sent' || journalTurn.state === 'completion_sent' || journalTurn.state === 'acknowledged') {
        console.log(`[Orchestrator] Reusing cached response for turn ${turnId} without regenerating`);
        return journalTurn.responseText;
      }

      if (journalTurn.state === 'generated') {
        console.log(`[Orchestrator] Replaying cached generated response for turn ${turnId}`);
        const replayedMessage = await this.sendOrchestratorResponseToDiscord(
          message,
          context,
          journalTurn.responseText,
          eventId,
          turnId,
          getMentionedUserDisplayMap(message).keys(),
        );
        if (!replayedMessage) {
          orchestratorTurnJournal.markGenerated(turnId, eventId, instanceId, '', payload);
          return '';
        }
        return journalTurn.responseText;
      }
    }

    // The last message must be resolved BEFORE the generation lock is taken.
    //
    // It used to be checked after `beginGeneration` but before the `try`, so the
    // `return ''` skipped the `finally` and the key stayed in `activeGenerationKeys`
    // forever (unlike `recentGenerationKeys`, which is TTL'd). That conversation
    // slot was permanently dead: the bot could never generate a root response for
    // that message again for the life of the process.
    const lastMessage = context.previousMessages[context.previousMessages.length - 1];
    if (!lastMessage) {
      console.error('[Orchestrator] No last message in context');
      return '';
    }

    // Rate limiting belongs HERE, not at notify time.
    //
    // `handleOrchestratedMention` used to stamp the limiter's window and then
    // return immediately; the real LLM generation happens later, driven by an
    // inbound `response_request` over the WebSocket. Neither that turn nor any
    // follow-up turn was ever limited, so the user's window was charged for a
    // *notification* instead of for the work — the limiter was effectively
    // bypassed for every orchestrated conversation. Enforcing it at the point
    // the generation actually happens also charges exactly once: the notify path
    // no longer stamps at all, so there is no double charge.
    //
    // Keyed on the human author of the turn being answered. A bot-authored turn
    // is council chatter, not a user request, so it is not charged to anyone.
    const isBotAuthoredTurn = lastMessage.isBot;
    if (!isBotAuthoredTurn && rateLimiterService.isRateLimited(lastMessage.authorId, message.member)) {
      console.warn(
        `⏳ [Orchestrator] Rate limited turn ${turnId} for user ${lastMessage.authorId} (event ${eventId}); declining`,
      );
      try {
        const resolvedEmoji = this.resolveEmojiReaction(config.rateLimit.emoji, message.guild ?? undefined);
        await message.react(resolvedEmoji);
      } catch (err) {
        console.warn(`⚠️ [Orchestrator] Failed to add rate limit reaction:`, err);
      }
      return '';
    }

    // Lease-based guard. `null` means a generation for this key is already in
    // flight and this turn must not run; the suppressed turn holds no lease, so
    // it cannot release the in-flight generation's lock in the `finally` below.
    const generationLease = generationKey ? this.generationGuard.begin(generationKey) : null;
    if (generationKey && !generationLease) {
      console.warn(`⚠️ [Orchestrator] Suppressing duplicate generation for message ${message.id} (event ${eventId}, turn ${turnId})`);
      return '';
    }

    try {
      orchestratorTurnJournal.markGenerating(turnId, eventId, instanceId, payload);

      const allowNsfwImageGeneration = canUserRequestNsfwImages(
        message.channel,
        isBotAuthoredTurn ? undefined : lastMessage.authorId,
      );
      if (allowNsfwImageGeneration) {
        console.log(`🔞 [Orchestrator] NSFW image generation enabled in NSFW channel ${message.channelId}`);
      }

      // Extract mentioned users from the original Discord message.
      // In orchestrator mode the message content contains raw <@id> patterns;
      // resolving them here gives the AI system prompt the "USERS MENTIONED"
      // section and enables user-related tools (opinions, pronouns, etc.).
      const mentionedUsers = getMentionedUserDisplayMap(message);
      const allowedMentionUserIds = new Set<string>(mentionedUsers.keys());
      const resolveUserMention = this.buildUserMentionResolver(message, allowedMentionUserIds);
      if (mentionedUsers.size > 0) {
        mentionedUsers.forEach((name, id) => {
          console.log(`👥 [Orchestrator] User mentioned: ${name} (${id})`);
        });
      }

      // Also scan previousMessages for <@id> patterns that we can resolve
      // from the guild member cache (e.g. if another bot mentioned a user).
      if (message.guild) {
        const mentionPattern = /<@!?(\d+)>/g;
        for (const prevMsg of context.previousMessages) {
          let match: RegExpExecArray | null;
          while ((match = mentionPattern.exec(prevMsg.content)) !== null) {
            const userId = match[1];
            if (userId && !mentionedUsers.has(userId)) {
              try {
                const member = message.guild.members.cache.get(userId);
                if (member) {
                  mentionedUsers.set(userId, member.displayName || member.user.displayName || member.user.username);
                  allowedMentionUserIds.add(userId);
                  console.log(`👥 [Orchestrator] Resolved mention from context: ${member.displayName} (${userId})`);
                }
              } catch {
                // Silently skip unresolvable mentions
              }
            }
          }
        }
      }

      // Convert orchestrator context messages into chat turns
      const historyMessages = context.previousMessages.filter(m => m.id !== lastMessage.id);
      let orchestratorTurns = channelHistoryService.convertOrchestratorToTurns(
        historyMessages,
        config.orchestrator.botId
      );

      const orchestratorContextNote = this.buildOrchestratorContextNote(context);
      const requestCollectiveKnowledge = this.buildCollectiveKnowledgeRequester(eventId, turnId, message.guildId || undefined);

      // Create a working getUserListeningActivity callback using the guild
      // from the original Discord message, matching the non-orchestrator path.
      const getUserListeningActivity = async (targetUserId: string) => {
        try {
          if (message.guild) {
            try {
              const member = await message.guild.members.fetch({
                user: targetUserId,
                withPresences: true,
              });
              if (member) {
                const discordActivity = userActivityService.getMusicActivity(member);
                if (discordActivity) return discordActivity;
              }
            } catch {
              // Continue to Navidrome
            }
          }

          if (targetUserId === config.bot.ownerId && navidromeService.isAvailable()) {
            return await navidromeService.getListeningActivity();
          }

          return null;
        } catch (error) {
          console.error(`[Orchestrator] Failed to get listening activity for ${targetUserId}:`, error);
          return null;
        }
      };

      // Extract web page content from URLs in orchestrator message
      const orchestratorPageContents = config.pageExtraction.enabled
        ? await pageExtractorService.extractPagesFromMessage(lastMessage.content)
        : [];

      // In orchestrator mode, if another bot just spoke, strongly frame this as a reply to that bot.
      const effectiveReplyContext = context.replyingToBotName
        ? {
            isReply: true,
            isReplyToLumia: false,
            originalContent: historyMessages.length > 0 ? historyMessages[historyMessages.length - 1]!.content : undefined,
            originalAuthor: context.replyingToBotName,
          }
        : replyContext
          ? {
              isReply: replyContext.isReply,
              isReplyToLumia: replyContext.isReplyToLumia,
              originalContent: replyContext.originalContent,
              originalTimestamp: replyContext.originalTimestamp,
              originalAuthor: replyContext.originalAuthor,
            }
          : undefined;

      const isNsfwChannel = isDiscordNsfwChannel(message.channel);

      // Enforce the Discord-CDN allowlist on every media URL before anything
      // fetches them server-side. These lists came from the orchestrator's
      // snapshot of a user-authored message, so their hosts are attacker-chosen.
      const safeImageUrls = await filterDiscordMediaUrls(imageUrls, 'ORCH-MEDIA');
      const safeVideoUrls = await filterDiscordMediaAttachments(videoUrls, 'ORCH-MEDIA');

      // Generate response using the existing message handler
      let response = await handleMessage({
        content: lastMessage.content,
        imageUrls: safeImageUrls,
        videoUrls: safeVideoUrls,
        textAttachments,
        pageContents: orchestratorPageContents.length > 0 ? orchestratorPageContents : undefined,
        userId: isBotAuthoredTurn ? undefined : lastMessage.authorId,
        username: isBotAuthoredTurn ? undefined : lastMessage.authorName,
        guildId: message.guildId || 'dm',
        mentionedUsers,
        replyContext: effectiveReplyContext,
        channelMessages: orchestratorTurns.length > 0 ? orchestratorTurns : undefined,
        orchestratorContextNote,
        currentMessageSpeaker: {
          authorId: lastMessage.authorId,
          authorName: lastMessage.authorName,
          isBot: lastMessage.isBot,
          format: 'orchestrator',
          currentBotId: this.client.user?.id,
        },
        getUserListeningActivity,
        resolveUserMention,
        isNsfwChannel,
        allowNsfwImageGeneration,
        // Orchestrator follow-up support: allow the LLM to request another turn
        orchestratorEventId: eventId,
        orchestratorTurnId: turnId,
        requestFollowUp: this.orchestrator
          ? (evtId, currentTurnId, targetBotId, reason) => this.orchestrator!.requestFollowUp(evtId, currentTurnId, targetBotId, reason)
          : undefined,
        requestCollectiveKnowledge,
        source: 'orchestrator',
        channelId: message.channelId,
        channelName: getChannelDisplayName(message.channel),
        guildName: message.guild?.name,
      });

      if (response.text && this.isDuplicateOrchestratorResponse(response.text, context)) {
        console.warn(`[Orchestrator] Duplicate-looking response detected for turn ${turnId}; retrying with anti-repeat note`);

        response = await handleMessage({
          content: lastMessage.content,
          imageUrls: safeImageUrls,
          videoUrls: safeVideoUrls,
          textAttachments,
          pageContents: orchestratorPageContents.length > 0 ? orchestratorPageContents : undefined,
          userId: isBotAuthoredTurn ? undefined : lastMessage.authorId,
          username: isBotAuthoredTurn ? undefined : lastMessage.authorName,
          guildId: message.guildId || 'dm',
          mentionedUsers,
          replyContext: effectiveReplyContext,
          channelMessages: orchestratorTurns.length > 0 ? orchestratorTurns : undefined,
          orchestratorContextNote: `${orchestratorContextNote || ''}\nYour previous draft matched an earlier ${(config.orchestrator.familyName || config.bot.familyName || 'bot')} response too closely. Reply in a meaningfully different way, grounded in the live chat context, without repeating earlier wording or explaining that you cannot respond.`.trim(),
          currentMessageSpeaker: {
            authorId: lastMessage.authorId,
            authorName: lastMessage.authorName,
            isBot: lastMessage.isBot,
            format: 'orchestrator',
            currentBotId: this.client.user?.id,
          },
          getUserListeningActivity,
          resolveUserMention,
          allowNsfwImageGeneration,
          orchestratorEventId: eventId,
          orchestratorTurnId: turnId,
          requestFollowUp: this.orchestrator
            ? (evtId, currentTurnId, targetBotId, reason) => this.orchestrator!.requestFollowUp(evtId, currentTurnId, targetBotId, reason)
            : undefined,
          requestCollectiveKnowledge,
          source: 'orchestrator',
          channelId: message.channelId,
          channelName: getChannelDisplayName(message.channel),
          guildName: message.guild?.name,
        });
      }

      if (response.text && this.isDuplicateOrchestratorResponse(response.text, context)) {
        console.warn(`[Orchestrator] Suppressing repeated response for turn ${turnId} after retry`);
        response.text = '';
      }

      orchestratorTurnJournal.markGenerated(turnId, eventId, instanceId, response.text, payload);

      // Send the response directly to Discord
      // A GIF-only turn produces a perfectly valid card (image + footer), so
        // `gifUrl` counts as sendable content here — without it, `response.text`
        // being empty would silently drop the GIF.
        if ((response.text && response.text.trim()) || response.attachments.length > 0 || response.gifUrl) {
        const sentMessage = await this.sendOrchestratorResponseToDiscord(message, context, response.text, eventId, turnId, allowedMentionUserIds, response.attachments, response.gifUrl);
        if (!sentMessage) {
          orchestratorTurnJournal.markGenerated(turnId, eventId, instanceId, '', payload);
          return '';
        }

        // Add emoji reactions in orchestrator mode
        if (response.reactions && response.reactions.length > 0) {
          for (const emoji of response.reactions) {
            try {
              const resolved = this.resolveEmojiReaction(emoji, message.guild ?? undefined);
              await message.react(resolved);
              console.log(`😀 [Orchestrator] Added reaction: ${resolved} (raw: ${emoji})`);
            } catch (reactError) {
              console.error(`❌ [Orchestrator] Failed to add reaction "${emoji}":`, reactError);
            }
          }
        }
      }

      return response.text;
    } catch (error) {
      console.error('[Orchestrator] Failed to generate or send response:', error);
      orchestratorTurnJournal.markFailed(turnId, eventId, instanceId, error instanceof Error ? error.message : String(error), payload);
      return '';
    } finally {
      // Release only a lease this turn actually holds. `release(null)` is a no-op,
      // so a suppressed turn can never free the in-flight generation's lock.
      this.generationGuard.release(generationLease);
    }
  }

  private async resolveOrchestratorQueuedInfo(payload: ResponseRequestPayload): Promise<OrchestratorQueuedInfo | undefined> {
    const queuedInfo = this.orchestratorQueue.get(payload.eventId);
    if (queuedInfo) {
      return queuedInfo;
    }

    if (!payload.eventSnapshot) {
      return undefined;
    }

    // PIN THE SNAPSHOT TO A CHANNEL THIS BOT ACTUALLY QUEUED FOR.
    //
    // The orchestrator-side `authorizeTurn()` pins the orchestrator's *claim*
    // about the channel against the mention this bot sent, and rejects turns whose
    // event id it never observed. But the snapshot itself is what this client then
    // acts on: it supplies `channelId` and `messageId`, and those are used to
    // reconstruct a `Message` and to aim the reply. Without the check below, a
    // peer that knows the shared API key could pair an authorised `eventId` with a
    // snapshot naming any message in any channel the bot can read, and steer the
    // reply there — the last piece of an authenticated-but-unverified peer being
    // able to post into arbitrary channels.
    //
    // So: the snapshot's channel must be one this bot announced a mention for, and
    // the turn's own declared channel (when present) must agree with it. If nothing
    // is queued for this event, we refuse rather than fall back to the snapshot.
    const queuedChannelId = this.queuedMessageChannels.get(payload.eventId);
    const snapshot = payload.eventSnapshot;

    if (!queuedChannelId) {
      console.warn(
        `🚨 [Orchestrator] Refusing snapshot reconstruction for event ${payload.eventId}: this bot never queued a mention for it.`,
      );
      return undefined;
    }

    if (snapshot.channelId !== queuedChannelId) {
      console.warn(
        `🚨 [Orchestrator] Refusing snapshot for event ${payload.eventId}: snapshot names channel ${snapshot.channelId} but this bot queued for ${queuedChannelId}.`,
      );
      return undefined;
    }

    if (payload.channelId && payload.channelId !== queuedChannelId) {
      console.warn(
        `🚨 [Orchestrator] Refusing turn ${payload.turnId}: turn names channel ${payload.channelId} but this bot queued for ${queuedChannelId}.`,
      );
      return undefined;
    }

    if (payload.guildId && snapshot.guildId && payload.guildId !== snapshot.guildId) {
      console.warn(
        `🚨 [Orchestrator] Refusing turn ${payload.turnId}: turn names guild ${payload.guildId} but event ${payload.eventId} was queued in ${snapshot.guildId}.`,
      );
      return undefined;
    }

    const message = await this.fetchOrchestratorMessageFromSnapshot(snapshot);
    if (!message) {
      return undefined;
    }

    // The reconstructed message must actually live in the channel we authorised.
    // `channels.fetch` is keyed by the snapshot's own channelId, but the message
    // itself is the object we later reply through, so verify it directly.
    if (message.channelId !== queuedChannelId) {
      console.warn(
        `🚨 [Orchestrator] Refusing reconstructed message ${message.id}: it is in channel ${message.channelId}, not the queued channel ${queuedChannelId}.`,
      );
      return undefined;
    }

    // The snapshot's media is user-influenced, so it gets the same Discord-CDN
    // allowlist as the direct path. Filtered here rather than at the `handleMessage`
    // call so both the first and the anti-duplicate retry see the same list.
    const snapshotImageUrls = await filterDiscordMediaUrls(snapshot.imageUrls || [], 'ORCH-SNAPSHOT');
    const snapshotVideoUrls = await filterDiscordMediaAttachments(snapshot.videoUrls || [], 'ORCH-SNAPSHOT');

    return {
      message,
      replyContext: snapshot.replyContext,
      imageUrls: snapshotImageUrls,
      videoUrls: snapshotVideoUrls,
      textAttachments: snapshot.textAttachments || [],
    };
  }

  private async fetchOrchestratorMessageFromSnapshot(snapshot: NonNullable<ResponseRequestPayload['eventSnapshot']>): Promise<Message | null> {
    try {
      const channel = await this.client.channels.fetch(snapshot.channelId);
      if (!channel || !('messages' in channel)) {
        console.warn(`[Orchestrator] Cannot reconstruct message ${snapshot.messageId} - channel missing message manager`);
        return null;
      }

      const fetchedMessage = await channel.messages.fetch(snapshot.messageId);
      return fetchedMessage;
    } catch (error) {
      console.error(`[Orchestrator] Failed to reconstruct message ${snapshot.messageId}:`, error);
      return null;
    }
  }

  private async sendOrchestratorResponseToDiscord(
    message: Message,
    context: MessageContext,
    responseText: string,
    eventId: string,
    turnId: string,
    allowedMentionUserIds: Iterable<string> = [],
    attachments: GeneratedImageAttachment[] = [],
    gifUrl?: string,
  ): Promise<Message | null> {
    if (!context.replyToMessageId && this.hasAlreadyReplied(message.id)) {
      console.warn(`⚠️ [Orchestrator] Suppressing duplicate reply for message ${message.id} (orchestrator path blocked by cross-path guard)`);
      return null;
    }

    console.log(`[Orchestrator] Sending response to Discord for event ${eventId}, turn ${turnId}`);

    // Same card as the direct path, so a reply reads identically whether it came
    // from an orchestrated turn or a plain mention. The turn journal only
    // replays `responseText`, so a replayed turn arrives here with no `gifUrl`
    // and degrades to a text-only card rather than inventing one.
    const card = config.bot.embed.enabled
      ? buildResponseCard({ text: responseText, gifUrl })
      : null;
    const formattedResponseText = card ? '' : formatDiscordResponseText(responseText);
    const allowedMentions = buildAllowedMentions(allowedMentionUserIds);
    const files = buildDiscordImageFiles(attachments);

    let sentMessage;
    if (context.replyToMessageId && 'send' in message.channel) {
      sentMessage = await message.channel.send({
        content: formattedResponseText || undefined,
        embeds: card ? [card] : undefined,
        allowedMentions,
        files,
        reply: { messageReference: context.replyToMessageId, failIfNotExists: false },
      });
    } else {
      sentMessage = await message.reply({
        content: formattedResponseText || undefined,
        embeds: card ? [card] : undefined,
        allowedMentions,
        files,
        failIfNotExists: false,
      });
    }

    if (sentMessage && this.orchestrator) {
      console.log(`[Orchestrator] Sent Discord reply for turn ${turnId}: ${sentMessage.id}`);
      this.orchestrator.setResponseMessageId(turnId, sentMessage.id);
      orchestratorTurnJournal.markDiscordSent(
        turnId,
        eventId,
        this.orchestrator.getInstanceId(),
        responseText,
        sentMessage.id,
      );
    }

    return sentMessage;
  }

  /**
   * Check if orchestrator is active and should handle this mention
   */
  private shouldUseOrchestrator(message: Message): boolean {
    if (!this.orchestrator?.isConnectedToOrchestrator()) {
      return false;
    }

    const botId = this.client.user?.id;
    if (!botId) return false;

    // Check if multiple bots are @mentioned
    const mentionedBots = message.mentions.users.filter(user => user.bot);

    // If multiple bots are @mentioned, use orchestrator
    if (mentionedBots.size > 1) {
      return true;
    }

    // If this bot is the only @mentioned bot, handle directly.
    // The user explicitly targeted this bot, so orchestrator coordination
    // is unnecessary and can cause double replies via race conditions
    // (another keyword-triggered bot could create a banter session).
    if (mentionedBots.size === 1 && mentionedBots.has(botId)) {
      return false;
    }

    // Check for trigger keywords
    const triggerKeywords = extractTriggerKeywords(message.content);
    const hasTriggerWords = triggerKeywords.length > 0;

    // If this bot is triggered by keywords AND there are other bots in the guild,
    // use orchestrator to coordinate (in case other bots also have trigger words)
    if (hasTriggerWords && message.guild) {
      // Count other bots in the guild (excluding self)
      const otherBots = message.guild.members.cache.filter(
        member => member.user.bot && member.user.id !== botId
      );

      // If there are other bots in the guild, use orchestrator
      // The orchestrator will determine if they should respond
      if (otherBots.size > 0) {
        console.log(`🎭 [Orchestrator] Trigger words detected with ${otherBots.size} other bots in guild, using orchestrator`);
        return true;
      }
    }

    // If it's a reply to a message with bot mentions, use orchestrator
    if (message.reference && mentionedBots.size > 0) {
      return true;
    }

    return false;
  }

  /**
   * Cross-path reply guard: returns true if we've already replied to this message.
   * Prevents double replies regardless of which trigger path (direct/orchestrator) runs.
   */
  private hasAlreadyReplied(messageId: string): boolean {
    if (this.repliedMessageIds.has(messageId)) {
      return true;
    }
    this.repliedMessageIds.add(messageId);
    // Auto-cleanup after 2 minutes. The handle is retained so `destroy()` can
    // clear it, and `unref()`'d so a suppression timer can never be the reason
    // the process stays alive.
    const cleanupTimer = setTimeout(() => {
      this.repliedMessageIds.delete(messageId);
      this.repliedMessageTimers.delete(messageId);
    }, 120_000);
    cleanupTimer.unref?.();
    this.repliedMessageTimers.set(messageId, cleanupTimer);
    return false;
  }

  /**
   * Resolves a raw emoji tag (name, :name:, <:name:id>, or unicode)
   * to a valid Discord.js reaction identifier (supports Developer Dashboard Application Emojis).
   *
   * A thin wrapper over {@link resolveEmoji} + {@link toEmojiReactionForm} in
   * `src/utils/emoji.ts`. The lookup and its cache ordering live there so that
   * message-content callers (which need `<a:name:id>`, a different output
   * shape entirely) share one implementation with this reaction path instead
   * of re-deriving it and drifting. Behaviour is unchanged.
   */
  private resolveEmojiReaction(emojiInput: string, guild?: Message['guild']): string {
    return toEmojiReactionForm(
      resolveEmoji(emojiInput, emojiLookupContext(this.client, guild))
    );
  }

  /**
   * Create the 8-second keep-alive ticker for one channel.
   *
   * Split out of {@link startTyping} so {@link TypingIndicatorRegistry} owns all
   * of the start/stop bookkeeping: it decides *whether* a ticker should exist,
   * this method only creates one. `onFailure` is invoked when `sendTyping()`
   * throws, which is the one case where a live channel stops being typeable
   * (deleted channel, lost permission) and every holder must be dropped.
   *
   * `unref()`'d so a stray ticker can never be the reason the process stays up.
   */
  private startTypingTicker(channelId: string, onFailure: () => void): TypingTicker {
    // The registry calls this once per channel, so the ticker is the sole owner
    // of the channel reference for as long as the indicator is live. Re-resolving
    // through the cache each tick would work too, but a deleted channel then
    // throws on every tick instead of failing once.
    const channel = this.typingChannels.get(channelId);
    if (!channel) {
      throw new Error(`cannot start typing indicator: channel ${channelId} is not tracked`);
    }

    const sendPing = async (): Promise<void> => {
      await channel.sendTyping();
    };

    // Fire-and-forget initial ping. Errors here are not fatal: the interval's
    // first tick hits the same failure and tears the ticker down.
    void sendPing().catch(() => {});

    const interval = setInterval(() => {
      void sendPing().catch(() => {
        // Channel deleted, or the bot lost Send Messages / Typing permission.
        onFailure();
      });
    }, 8000);
    // Never let a stray ticker keep the process alive on its own.
    interval.unref?.();

    console.log(`⌨️ [TYPING] Started typing indicator in channel ${channelId}`);
    return { interval, channelId };
  }

  /**
   * Start (or join) the typing indicator for a channel.
   *
   * `holder` is a per-turn token. Holders are reference-counted, so a second
   * concurrent turn in the same channel joins the existing ticker instead of
   * cancelling it — the old code called `stopTyping` first, which meant turn B's
   * start killed turn A's interval and A's stop then killed B's, so the
   * indicator flickered off mid-generation, exactly when the queue is deepest.
   */
  private startTyping(channel: TypeableChannel, holder: string): void {
    // Registered before `acquire`, because `acquire` may synchronously construct
    // the ticker, and the ticker needs the channel to ping.
    this.typingChannels.set(channel.id, channel);
    try {
      this.typingIndicators.acquire(channel.id, holder);
    } catch (error) {
      console.warn(`⚠️ [TYPING] Failed to start typing indicator in ${channel.id}:`, error);
      this.typingChannels.delete(channel.id);
    }
  }

  /**
   * Stop the typing indicator for one holder in a channel. The ticker only stops
   * when the last holder releases.
   */
  private stopTyping(channelId: string, holder: string): void {
    this.typingIndicators.release(channelId, holder);
  }

  /**
   * Stop all typing indicators (useful for shutdown)
   */
  private stopAllTyping(): void {
    for (const channelId of Array.from(this.typingIndicators.trackedChannelsKeys())) {
      console.log(`⌨️ [TYPING] Stopped typing indicator in channel ${channelId}`);
    }
    this.typingIndicators.releaseAll();
  }

  /**
   * Handle typing indicator for orchestrated responses
   * Called by the orchestrator when it's this bot's turn to respond
   */
  private async handleOrchestratorTyping(channelId: string, guildId: string, isTyping: boolean): Promise<void> {
    console.log(`⌨️ [Orchestrator-Typing] handleOrchestratorTyping called:`, {
      channelId,
      guildId,
      isTyping,
      clientReady: this.client.isReady(),
    });
    
    try {
      if (isTyping) {
        console.log(`⌨️ [Orchestrator-Typing] Attempting to fetch channel ${channelId}`);
        
        // Fetch the channel
        const channel = await this.client.channels.fetch(channelId);
        if (!channel) {
          console.warn(`[Orchestrator-Typing] Channel ${channelId} not found for typing`);
          return;
        }
        
        console.log(`⌨️ [Orchestrator-Typing] Channel found: ${channel.constructor.name}`);

        // Check if it's a text-based channel
        if (
          channel instanceof TextChannel ||
          channel instanceof ThreadChannel ||
          channel instanceof NewsChannel ||
          channel instanceof VoiceChannel ||
          channel instanceof StageChannel ||
          channel instanceof DMChannel
        ) {
          // The orchestrator drives typing as a boolean per channel, so its holder
          // token is fixed. `acquire` is idempotent per holder, so repeated
          // `isTyping: true` frames cannot inflate the reference count and pin
          // the indicator open after the orchestrator has sent `false`.
          this.startTyping(channel, ORCHESTRATOR_TYPING_HOLDER);
          console.log(`⌨️ [Orchestrator-Typing] ✅ Started typing in channel ${channelId}`);
        } else {
          console.warn(`[Orchestrator-Typing] Channel ${channelId} is not text-based (${channel.constructor.name})`);
        }
      } else {
        // Stop typing for the orchestrator's holder only. A direct-path turn
        // running concurrently in the same channel keeps its own holder, so the
        // indicator correctly stays up.
        this.stopTyping(channelId, ORCHESTRATOR_TYPING_HOLDER);
        console.log(`⌨️ [Orchestrator-Typing] ✅ Stopped typing in channel ${channelId}`);
      }
    } catch (error) {
      console.error(`[Orchestrator-Typing] Failed to handle typing indicator:`, error);
    }
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, async (readyClient) => {
      console.log(`Ready! Logged in as ${readyClient.user.tag}`);
      try {
        await readyClient.application?.emojis.fetch();
        console.log(`😀 [CLIENT] Cached ${readyClient.application?.emojis.cache.size ?? 0} application emoji(s) from developer dashboard`);
      } catch (err) {
        console.warn('⚠️ [CLIENT] Failed to fetch application emojis:', err);
      }
      boredomService.start(this.client);
    });

    // Client-level error handlers.
    //
    // These are not optional. `Client` is an EventEmitter, and an `'error'`
    // event with no listener is not ignored — Node (and Bun) throw it. So a
    // single transient gateway blip, one failed heartbeat, or one REST fault
    // escalated into an uncaught exception and killed the whole process. The
    // `'warn'` and `'shardError'` handlers are here for the same reason: they
    // are the only signal that a shard is degrading before it hard-fails.
    this.client.on(Events.Error, (error) => {
      console.error('❌ [DISCORD] Client error (continuing):', error);
    });

    this.client.on(Events.Warn, (message) => {
      console.warn(`⚠️ [DISCORD] Client warning: ${message}`);
    });

    this.client.on(Events.ShardError, (error, shardId) => {
      console.error(`❌ [DISCORD] Shard ${shardId} error (continuing):`, error);
    });

    this.client.on(Events.ShardDisconnect, (_event, shardId) => {
      console.warn(`⚠️ [DISCORD] Shard ${shardId} disconnected (will reconnect)`);
    });

    // NOTE: SIGINT/SIGTERM are handled once, in `src/index.ts`, which also owns
    // the dashboard. They used to be registered here as well, so both handlers
    // ran on one signal: two concurrent `destroy()` calls and two `process.exit(0)`
    // calls, racing each other. Single owner now.

    // The whole dispatch is wrapped, not just `command.execute`, because a slash
    // command is a full turn of its own: `/chat` and `/persona` read prompts, and
    // anything they do asynchronously after replying must still see the same
    // profile. Two guilds running commands concurrently would otherwise be free
    // to read each other's prompt text, and a wrapper around only the innermost
    // call would leave the awaits before it unwrapped.
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      await runWithPromptContext(interaction.guildId, async () => {
        const command = this.commands.get(interaction.commandName);

        if (!command) {
          console.error(`No command matching ${interaction.commandName} was found.`);
          return;
        }

        try {
          // NSFW-only mode: commands are usable only in channels marked NSFW.
          if (config.bot.nsfwOnly && !isDiscordNsfwChannel(interaction.channel)) {
            await interaction.reply({
              content: 'I can only be used in age-restricted (NSFW) channels.',
              ephemeral: true,
            });
            return;
          }

          const subcommand = interaction.options.getSubcommand(false);
          const ownerOnly = command.ownerOnly ||
            (subcommand !== null && command.ownerOnlySubcommands?.includes(subcommand));

          if (ownerOnly && interaction.user.id !== config.bot.ownerId) {
            await interaction.reply({
              content: 'This command is only available to the bot owner.',
              ephemeral: true,
            });
            return;
          }

          await command.execute(interaction);
        } catch (error) {
          console.error(error);
          const errorMessage = {
            content: 'There was an error while executing this command!',
            ephemeral: true,
          };

          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorMessage);
          } else {
            await interaction.reply(errorMessage);
          }
        }
      });
    });

    // Handle message mentions and keyword triggers.
    //
    // Registered as a *synchronous* wrapper on purpose. `client.on()` does not
    // await an async listener, so every `await` inside it runs outside any
    // handler the emitter controls: a throw from `handleOrchestratedMention(...)`
    // or from `message.fetchReference()` produced an unhandled promise rejection.
    // Bun treats unhandled rejections as fatal by default, so one malformed
    // message could take the entire bot offline with no stack trace pointing at
    // the cause. The body therefore lives in `onMessageCreate`, whose entire
    // surface is a top-level try/catch.
    this.client.on(Events.MessageCreate, (message: Message) => {
      void this.onMessageCreate(message);
    });
  }

  /**
   * Body of the `MessageCreate` listener, with a crash guard around all of it.
   *
   * Never throws and never rejects. Logging is deliberately limited to
   * identifiers: the message *text* is user content (it can contain anything,
   * including something the operator would not want in a log aggregator) and no
   * token or auth header is ever included.
   */
  private async onMessageCreate(message: Message): Promise<void> {
    try {
      // Ignore messages from bots (including self)
      if (message.author.bot) return;

      // Ignore webhook messages (they don't have author.bot=true but have webhookId)
      if (message.webhookId) {
        console.log(`🤖 [CLIENT] Ignoring webhook message from: ${message.author.username}`);
        return;
      }

      // Ignore empty messages
      if (!message.content.trim()) return;

      // Duplicate event guard — Discord may deliver the same event twice
      if (this.processedMessageIds.has(message.id)) return;
      this.processedMessageIds.add(message.id);
      // Auto-cleanup after 60s to prevent unbounded growth
      const cleanupTimer = setTimeout(() => {
        this.processedMessageIds.delete(message.id);
        this.processedMessageTimers.delete(message.id);
      }, 60_000);
      cleanupTimer.unref?.();
      this.processedMessageTimers.set(message.id, cleanupTimer);

      const botId = this.client.user?.id;
      if (!botId) return;

      // Check early if the message content mentions or keywords trigger the bot
      const hasTrigger = shouldTriggerBot(message.content, botId);

      // Check if this message is a reply to someone
      let replyContext: { 
        isReply: boolean; 
        isReplyToLumia: boolean;
        originalContent?: string; 
        originalTimestamp?: string;
        originalAuthor?: string;
        embeddedContent?: {
          images: string[];
          videos: { url: string; mimeType?: string }[];
        };
      } | undefined;

      if (message.reference && message.reference.messageId) {
        let shouldLog = hasTrigger;
        try {
          // Fetch the referenced message
          const referencedMessage = await message.fetchReference();
          
          // Check if the referenced message is from Lumia (the bot)
          const isReplyToLumia = referencedMessage.author.id === botId;
          shouldLog = isReplyToLumia || hasTrigger;

          // Check if this is a forwarded message (type 1) vs a regular reply (type 0)
          const isForward = message.reference.type === 1;
          if (isForward && shouldLog) {
            console.log(`📨 [CLIENT] Forwarded message detected - fetching reference with caution`);
          }
          
          const referencedAuthorName = getMessageAuthorDisplayName(referencedMessage);
          if (shouldLog) {
            console.log(`💬 [CLIENT] Reply detected to ${isReplyToLumia ? 'Lumia' : referencedAuthorName}: "${referencedMessage.content.slice(0, 100)}..."`);
          }
          
          // Extract embedded content from referenced message
          const embeddedImages: string[] = [];
          const embeddedVideos: { url: string; mimeType?: string }[] = [];
          
          // Extract attachments from referenced message
          if (referencedMessage.attachments.size > 0) {
            referencedMessage.attachments.forEach((attachment) => {
              if (attachment.contentType?.startsWith('image/gif')) {
                embeddedVideos.push({
                  url: attachment.url,
                  mimeType: attachment.contentType,
                });
                if (shouldLog) console.log(`🎬 [CLIENT] Referenced GIF attachment: ${attachment.name}`);
              } else if (attachment.contentType?.startsWith('image/')) {
                embeddedImages.push(attachment.url);
                if (shouldLog) console.log(`🖼️  [CLIENT] Referenced image attachment: ${attachment.name}`);
              } else if (attachment.contentType?.startsWith('video/')) {
                embeddedVideos.push({
                  url: attachment.url,
                  mimeType: attachment.contentType,
                });
                if (shouldLog) console.log(`🎥 [CLIENT] Referenced video attachment: ${attachment.name}`);
              }
            });
          }

          // Extract embeds from referenced message (Tenor GIFs, link previews, video embeds, etc.)
          if (referencedMessage.embeds.length > 0) {
            for (const embed of referencedMessage.embeds) {
              const embedType = embed.data?.type;

              // GIFV embeds (Tenor, Giphy, etc.)
              if (embedType === 'gifv' && embed.video?.url) {
                embeddedVideos.push({
                  url: embed.video.url,
                  mimeType: 'image/gif',
                });
                if (shouldLog) console.log(`🎬 [CLIENT] Referenced GIFV embed: ${embed.url || embed.video.url}`);
              }
              // Video embeds (YouTube, etc.)
              else if (embedType === 'video' && embed.video?.url) {
                embeddedVideos.push({
                  url: embed.video.proxyURL || embed.video.url,
                  mimeType: 'video/mp4',
                });
                if (shouldLog) console.log(`🎥 [CLIENT] Referenced video embed: ${embed.url || embed.video.url}`);
              }
              // Image embeds
              else if (embedType === 'image' && embed.image?.url) {
                embeddedImages.push(embed.image.proxyURL || embed.image.url);
                if (shouldLog) console.log(`🖼️  [CLIENT] Referenced image embed: ${embed.image.url}`);
              }
              // Rich embeds with images or thumbnails (link previews, etc.)
              else if (embedType === 'rich' || embedType === 'article' || embedType === 'link') {
                if (embed.image?.url) {
                  embeddedImages.push(embed.image.proxyURL || embed.image.url);
                  if (shouldLog) console.log(`🖼️  [CLIENT] Referenced rich embed image: ${embed.image.url}`);
                }
                if (embed.thumbnail?.url) {
                  embeddedImages.push(embed.thumbnail.proxyURL || embed.thumbnail.url);
                  if (shouldLog) console.log(`🖼️  [CLIENT] Referenced rich embed thumbnail: ${embed.thumbnail.url}`);
                }
              }
            }
          }
          
          // Extract stickers from the referenced message
          const referencedStickerMedia = extractStickerMedia(referencedMessage, 'CLIENT', !shouldLog);
          embeddedImages.push(...referencedStickerMedia.imageUrls);
          embeddedVideos.push(...referencedStickerMedia.videoUrls);

          // Extract custom emoji images from the referenced message
          embeddedImages.push(...extractCustomEmojiUrls(referencedMessage.content, 'CLIENT', !shouldLog));

          const originalContentWithStickers = referencedStickerMedia.stickerHints.length > 0
            ? (referencedMessage.content
                ? `${referencedMessage.content} ${referencedStickerMedia.stickerHints.join(' ')}`
                : referencedStickerMedia.stickerHints.join(' '))
            : referencedMessage.content;

          replyContext = {
            isReply: true,
            isReplyToLumia,
            originalContent: originalContentWithStickers,
            originalTimestamp: formatTimeAgo(referencedMessage.createdAt),
            originalAuthor: referencedAuthorName,
            embeddedContent: {
              images: embeddedImages,
              videos: embeddedVideos,
            },
          };
        } catch (error: any) {
          if (shouldLog) {
            if (error.code === 10008 || error.message?.includes('Unknown Message')) {
              console.warn(`⚠️ [CLIENT] Referenced message not found (deleted or inaccessible): ${message.reference.messageId}`);
            } else if (error.code === 50001 || error.message?.includes('Missing Access')) {
              console.warn(`⚠️ [CLIENT] No access to referenced message in channel: ${message.reference.channelId}`);
            } else {
              console.error('❌ [CLIENT] Failed to fetch referenced message:', error);
            }
          }
          // Continue without reply context if we can't fetch it
        }
      }

      // Check if message should trigger the bot
      const isReplyToLumia = replyContext?.isReplyToLumia === true;
      
      // Trigger if: has keyword/mention OR is reply to Lumia OR is reply with mention
      const shouldTrigger = hasTrigger || isReplyToLumia || (replyContext?.isReply && hasTrigger);

      // NSFW-only mode: the bot may only respond in channels marked NSFW.
      // Reuses the same age-gating used for NSFW image generation, so DMs and
      // non-NSFW channels are silently ignored regardless of trigger.
      if (shouldTrigger && config.bot.nsfwOnly && !isDiscordNsfwChannel(message.channel)) {
        console.log(`🔞 [CLIENT] NSFW-only mode: ignoring trigger in non-NSFW channel ${message.channelId}`);
        return;
      }

      if (shouldTrigger) {
        // Check if orchestrator should handle this mention.
        //
        // This is tested BEFORE the rate limiter on purpose. `isRateLimited` both
        // checks and *stamps* the window, and it used to run first, so the
        // orchestrated path charged the user's window for a notification and then
        // returned — while the actual LLM generation arrived later as an inbound
        // `response_request` that no limiter ever saw, along with every follow-up
        // turn. The net effect was that the limiter was bypassed for every
        // orchestrated conversation while the user's quota was spent on a
        // notification. The limiter is now enforced where the generation actually
        // happens (`handleOrchestratorResponse`), so this branch must not stamp.
        if (this.shouldUseOrchestrator(message)) {
          await this.handleOrchestratedMention(message, replyContext);
          return;
        }

        if (rateLimiterService.isRateLimited(message.author.id, message.member)) {
          try {
            const resolvedEmoji = this.resolveEmojiReaction(config.rateLimit.emoji, message.guild ?? undefined);
            await message.react(resolvedEmoji);
          } catch (err) {
            console.warn(`⚠️ [CLIENT] Failed to add rate limit reaction:`, err);
          }
          return;
        }

        // Per-channel queue: serialize message processing within each channel
        // so the bot's reply to message A is visible in channel history for message B.
        // Different channels remain fully parallel.
        const channelId = message.channelId;
        const previousTask = this.channelProcessingQueue.get(channelId) ?? Promise.resolve();

        const currentTask = previousTask
          .catch(() => {}) // don't let a previous failure break the chain
          .then(() => this.processTriggeredMessage(message, botId, hasTrigger, replyContext));

        this.channelProcessingQueue.set(channelId, currentTask);

        // Clean up the map entry once this task settles, but only if it's still the latest.
        //
        // `currentTask.finally(...)` used to be a floating expression. `.finally()`
        // does NOT swallow a rejection: it *derives a new promise that also rejects*,
        // and that derived promise was discarded, so `processTriggeredMessage`
        // throwing produced a SECOND unhandled rejection on top of the first. One
        // rejected turn was therefore enough to terminate the process (verified in
        // Bun 1.4.2: a discarded `.finally()` on a rejected promise exits 1). This
        // is the mechanism that turned a single bad turn into a permanent outage.
        //
        // The fix is `.then(onSettled, onSettled)`: a two-argument `then` handles
        // the rejection, and the derived promise resolves either way, so there is
        // nothing left floating.
        void currentTask.then(
          () => {
            if (this.channelProcessingQueue.get(channelId) === currentTask) {
              this.channelProcessingQueue.delete(channelId);
            }
          },
          (error) => {
            if (this.channelProcessingQueue.get(channelId) === currentTask) {
              this.channelProcessingQueue.delete(channelId);
            }
            // `processTriggeredMessage` has its own catch, so reaching here means
            // something outside it threw. Log and keep the bot alive.
            logMessageHandlerFailure('channel-task', undefined, error, {
              channelId,
              messageId: message.id,
            });
          },
        );
      }
    } catch (error) {
      logMessageHandlerFailure('message', message, error);
    }
  }

  /**
   * Process a triggered message (extracted for per-channel queuing)
   *
   * WHY THE ENTIRE TURN IS WRAPPED, NOT JUST THE PROMPT READS
   * --------------------------------------------------------
   * `runWithPromptContext` opens an `AsyncLocalStorage` scope for the guild this
   * message came from, and it has to enclose the *whole* turn — the first
   * trigger-keyword read to the last dashboard log write.
   *
   * The reason is that prompt reads are spread across many `await`s inside one
   * turn: page extraction, media filtering, vision, knowledge prefetch, the
   * SwarmUI config read, then the system-prompt assembly and the rewrite pass
   * seconds later. Two of those reads MUST agree, or the bot mixes a `swarm_cfg`
   * from one profile with prompt text from another.
   *
   * A wrapper around only part of the turn would therefore reintroduce exactly
   * the cross-guild cross-talk this design exists to prevent — and it would do so
   * only intermittently, which is the worst possible failure mode. The context
   * carries the guild id down the whole async chain, so no downstream signature
   * changes and no restore step can clobber a concurrent turn in another guild.
   *
   * `message.guildId` is null for a DM, which resolves to the main-page
   * selection — the correct and intended behaviour.
   */
  private async processTriggeredMessage(
    message: Message,
    botId: string,
    hasTrigger: boolean,
    replyContext: TriggeredMessageReplyContext | undefined,
  ): Promise<void> {
    return runWithPromptContext(message.guildId, () =>
      this.runTriggeredMessageTurn(message, botId, hasTrigger, replyContext),
    );
  }

  /**
   * The body of a triggered-message turn, run inside the guild's prompt context.
   *
   * Split out from {@link processTriggeredMessage} purely so the wrapper can
   * enclose the whole turn without re-indenting several hundred lines; it has no
   * other caller and takes no guild argument, because the ambient context
   * already carries it.
   */
  private async runTriggeredMessageTurn(
    message: Message,
    botId: string,
    hasTrigger: boolean,
    replyContext: TriggeredMessageReplyContext | undefined,
  ): Promise<void> {
    const generationKey = `root:${message.id}`;
    const typingHolder = directTypingHolder(message.id);

    // Check if channel supports typing indicator
    const canType = (
      message.channel instanceof TextChannel ||
      message.channel instanceof ThreadChannel ||
      message.channel instanceof NewsChannel ||
      message.channel instanceof VoiceChannel ||
      message.channel instanceof StageChannel ||
      message.channel instanceof DMChannel
    );

    // Extract the actual message content (remove triggers if present)
    const cleanedContent = hasTrigger ? extractMessageContent(message.content, botId) : message.content;

    // Categorize any stickers up front so the content guard can count them as "content"
    // and the media arrays below can absorb them alongside regular attachments.
    const stickerMedia = extractStickerMedia(message, 'CLIENT');
    const contentWithStickers = stickerMedia.stickerHints.length > 0
      ? (cleanedContent.trim()
          ? `${cleanedContent} ${stickerMedia.stickerHints.join(' ')}`
          : stickerMedia.stickerHints.join(' '))
      : cleanedContent;

    // Don't respond if there's no actual content after removing triggers (only for explicit triggers)
    //
    // This check is deliberately BEFORE `startTyping`. It used to run after, and
    // the branch returned without stopping the indicator: the 8-second interval
    // only self-terminated when `sendTyping()` threw, which it does not for a
    // healthy channel. So every bare "hey Lumia" left a permanent REST ping per
    // affected channel and grew `typingIntervals` by one entry per channel, forever.
    if (isEmptyTriggeredTurn(hasTrigger, cleanedContent, stickerMedia.stickerHints.length)) {
      // Check if channel is still available (bot may have been kicked)
      if (!message.channel) {
        console.warn('⚠️ [CLIENT] Cannot reply - channel no longer available (bot may have been kicked)');
        return;
      }
      await message.reply('You summoned me but forgot to say what you wanted! How can I help you?');
      return;
    }

    // Start typing indicator for this specific channel, once we know there is
    // actual work to indicate.
    if (canType) {
      this.startTyping(message.channel, typingHolder);
    }

    // Lease-based guard, taken BEFORE the `try` on purpose — the old code took
    // the lock *inside* the try and unconditionally released it in the `finally`.
    // A duplicate-suppressed turn therefore ran the `finally` and deleted the key
    // held by the real, still-running generation. The 120s `recent` window masked
    // this, but any generation exceeding 120s (entirely plausible with a 10-round
    // tool loop plus retries) lost its guard entirely and two generations for the
    // same message ran concurrently.
    const generationLease = this.generationGuard.begin(generationKey);
    if (!generationLease) {
      console.warn(`⚠️ [CLIENT] Suppressing duplicate generation for message ${message.id}`);
      if (canType) {
        this.stopTyping(message.channelId, typingHolder);
      }
      return;
    }

    try {
      // Extract image and video URLs from attachments
      const imageUrls: string[] = [];
      const videoUrls: { url: string; mimeType?: string }[] = [];
      const textAttachments: { name: string; content: string }[] = [];

      if (message.attachments.size > 0) {
        for (const attachment of message.attachments.values()) {
          if (attachment.contentType?.startsWith('image/gif')) {
            videoUrls.push({
              url: attachment.url,
              mimeType: attachment.contentType,
            });
            console.log(`🎬 [CLIENT] GIF found in message (will convert to WebM): ${attachment.name} (${attachment.contentType})`);
          } else if (attachment.contentType?.startsWith('image/')) {
            imageUrls.push(attachment.url);
            console.log(`🖼️  [CLIENT] Image found in message: ${attachment.name} (${attachment.contentType})`);
          } else if (attachment.contentType?.startsWith('video/')) {
            videoUrls.push({
              url: attachment.url,
              mimeType: attachment.contentType,
            });
            console.log(`🎥 [CLIENT] Video found in message: ${attachment.name} (${attachment.contentType})`);
          } else if (attachment.contentType?.startsWith('text/') ||
                    attachment.name.match(/\.(txt|md|json|csv|log|xml|yaml|yml|js|ts|jsx|tsx|py|rb|java|c|cpp|h|hpp|cs|go|rs|php|html|css|scss|sass|less|sql)$/i)) {
            // Text file detected - check size and read content
            const maxSizeBytes = config.attachments.maxTextFileSizeKB * 1024;

            // Check file size before downloading
            if (attachment.size > maxSizeBytes) {
              console.log(`📄 [CLIENT] Text file too large: ${attachment.name} (${(attachment.size / 1024).toFixed(1)}KB > ${config.attachments.maxTextFileSizeKB}KB limit)`);
              textAttachments.push({
                name: attachment.name,
                content: `[File too large: ${(attachment.size / 1024).toFixed(1)}KB. Maximum size is ${config.attachments.maxTextFileSizeKB}KB]`,
              });
              continue;
            }

            try {
              console.log(`📄 [CLIENT] Text file detected: ${attachment.name} (${attachment.contentType || 'unknown type'}, ${(attachment.size / 1024).toFixed(1)}KB)`);
              // `safeFetchText`, not a bare `fetch`. Discord's own attachment host
              // is pinned by `allowHosts`, and every redirect hop is re-validated,
              // so this cannot be steered at an internal service even if the
              // attachment URL is attacker-influenced. The `maxBytes` cap is
              // enforced while streaming, so a hostile body cannot exhaust memory
              // before the limit is consulted.
              const { text: textContent } = await safeFetchText(attachment.url, {
                allowHosts: mediaAllowedHosts(),
                maxBytes: maxSizeBytes,
                timeoutMs: DISCORD_MEDIA_TIMEOUT_MS,
              });
              // Limit text content to prevent token overflow
              const maxChars = maxSizeBytes;
              const truncatedContent = textContent.length > maxChars
                ? textContent.substring(0, maxChars) + '\n... [content truncated]'
                : textContent;
              textAttachments.push({
                name: attachment.name,
                content: truncatedContent,
              });
              console.log(`📄 [CLIENT] Read text file: ${attachment.name} (${truncatedContent.length} chars)`);
            } catch (error) {
              console.error(`❌ [CLIENT] Error reading text file ${attachment.name}:`, error);
            }
          }
        }
      }

      // Merge sticker-derived media into the main arrays so downstream handling is identical.
      imageUrls.push(...stickerMedia.imageUrls);
      videoUrls.push(...stickerMedia.videoUrls);

      // Extract custom emoji images from message content so the model can see them.
      imageUrls.push(...extractCustomEmojiUrls(message.content, 'CLIENT'));

      // Identify URLs that will be scraped for page content, so we can skip their embed images
      const scrapedUrls = config.pageExtraction.enabled
        ? pageExtractorService.extractUrls(cleanedContent)
        : [];

      // Helper: check if an embed's source URL matches any URL we're scraping
      const isFromScrapedLink = (embedUrl: string | null): boolean => {
        if (!embedUrl || scrapedUrls.length === 0) return false;
        return scrapedUrls.some(scraped =>
          embedUrl === scraped || embedUrl.startsWith(scraped) || scraped.startsWith(embedUrl)
        );
      };

      // Extract embeds from current message (forwarded messages, etc.)
      if (message.embeds.length > 0) {
        for (const embed of message.embeds) {
          const embedType = embed.data?.type;
          const isScrapedLink = isFromScrapedLink(embed.url);

          if (isScrapedLink) {
            console.log(`🌐 [CLIENT] Skipping embed for scraped URL: ${embed.url} (type: ${embedType})`);
            continue;
          }

          if (embedType === 'gifv' && embed.video?.url) {
            videoUrls.push({ url: embed.video.url, mimeType: 'image/gif' });
            console.log(`🎬 [CLIENT] GIFV embed in message: ${embed.url || embed.video.url}`);
          } else if (embedType === 'video' && embed.video?.url) {
            videoUrls.push({ url: embed.video.proxyURL || embed.video.url, mimeType: 'video/mp4' });
            console.log(`🎥 [CLIENT] Video embed in message: ${embed.url || embed.video.url}`);
          } else if (embedType === 'image' && embed.image?.url) {
            imageUrls.push(embed.image.proxyURL || embed.image.url);
            console.log(`🖼️  [CLIENT] Image embed in message: ${embed.image.url}`);
          } else if (embedType === 'rich' || embedType === 'article' || embedType === 'link') {
            if (embed.image?.url) {
              imageUrls.push(embed.image.proxyURL || embed.image.url);
              console.log(`🖼️  [CLIENT] Rich embed image in message: ${embed.image.url}`);
            }
            if (embed.thumbnail?.url) {
              imageUrls.push(embed.thumbnail.proxyURL || embed.thumbnail.url);
              console.log(`🖼️  [CLIENT] Rich embed thumbnail in message: ${embed.thumbnail.url}`);
            }
          }
        }
      }

      // Add embedded content from reply context
      if (replyContext?.embeddedContent) {
        imageUrls.push(...replyContext.embeddedContent.images);
        videoUrls.push(...replyContext.embeddedContent.videos);
      }

      // Enforce the Discord-CDN allowlist on every collected media URL.
      //
      // This is the SSRF/exfiltration fix. `embed.image.url`,
      // `embed.thumbnail.url` and `embed.video.url` may be ANY http(s) URL on
      // ANY host — Discord imposes no CDN restriction on them — and any member of
      // any guild controls them. Downstream (`convertImageUrlToBase64`,
      // `videoService.processVideo`) fetches them server-side, base64-inlines the
      // bytes and sends them to the external OpenAI/Gemini endpoint. So a message
      // whose embed image is `http://127.0.0.1:4533/rest/getCoverArt.view`,
      // `http://127.0.0.1:3001/api/persona` or `http://169.254.169.254/latest/meta-data/`
      // made the bot fetch it and forward it to the model vendor, which is both an
      // internal-network read and an attacker-visible side channel (the model
      // frequently narrates the content back into the channel).
      //
      // Attachment-derived URLs (the loop above), sticker URLs, custom-emoji URLs
      // and the referenced message's embeds all flow through these same two
      // arrays, so this single filter covers the attachment path as well as the
      // embed path.
      const permittedImageUrls = await filterDiscordMediaUrls(imageUrls, 'CLIENT-MEDIA');
      const permittedVideoUrls = await filterDiscordMediaAttachments(videoUrls, 'CLIENT-MEDIA');

      // Extract mentioned users for context parsing, using guild display names when available.
      const mentionedUsers = getMentionedUserDisplayMap(message);
      const allowedMentionUserIds = new Set<string>(mentionedUsers.keys());
      const resolveUserMention = this.buildUserMentionResolver(message, allowedMentionUserIds);
      const authorDisplayName = getMessageAuthorDisplayName(message);
      if (mentionedUsers.size > 0) {
        mentionedUsers.forEach((name, id) => {
          console.log(`👥 [CLIENT] User mentioned: ${name} (${id})`);
        });
      }

      // Fetch recent channel history and convert to chat turns
      let channelTurns: import('../services/openai').ChatMessage[] | undefined;
      if (canType) {
        try {
          const channelMessages = await channelHistoryService.fetchChannelHistory(message.channel as TextChannel | ThreadChannel | NewsChannel | VoiceChannel | StageChannel | DMChannel, message.id);
          if (channelMessages.length > 0) {
            channelTurns = channelHistoryService.convertToTurns(channelMessages, this.client.user?.id);
            console.log(`📜 [CLIENT] Converted ${channelMessages.length} channel messages to ${channelTurns.length} chat turns`);
          }
        } catch (error) {
          console.warn('📜 [CLIENT] Failed to fetch channel history:', error);
        }
      }

      // Create callback to check user's listening activity (Discord presence + Navidrome fallback)
      const getUserListeningActivity = async (targetUserId: string) => {
        try {
          // 1. First check Discord presence (Spotify desktop/mobile app)
          if (message.guild) {
            try {
              const member = await message.guild.members.fetch({
                user: targetUserId,
                withPresences: true,
              });
              if (member) {
                const discordActivity = userActivityService.getMusicActivity(member);
                if (discordActivity) {
                  return discordActivity;
                }
              }
            } catch {
              // Member fetch failed or no presence, continue
            }
          }

          // 2. If no Discord presence and target user is the bot owner, check Navidrome
          if (targetUserId === config.bot.ownerId && navidromeService.isAvailable()) {
            const navidromeActivity = await navidromeService.getListeningActivity();
            if (navidromeActivity) {
              console.log(`🎧 [CLIENT] Found active Navidrome playback for owner`);
              return navidromeActivity;
            }
          }

          return null;
        } catch (error) {
          console.error(`❌ [CLIENT] Failed to get listening activity for ${targetUserId}:`, error);
          return null;
        }
      };

      // Extract web page content from URLs in message
      const pageContents = config.pageExtraction.enabled
        ? await pageExtractorService.extractPagesFromMessage(cleanedContent)
        : [];

      const requestCollectiveKnowledge = this.buildCollectiveKnowledgeRequester(
        `direct-${message.id}`,
        `direct-${message.id}`,
        message.guildId || undefined,
      );
      const allowNsfwImageGeneration = canUserRequestNsfwImages(message.channel, message.author.id);
      if (allowNsfwImageGeneration) {
        console.log(`🔞 [CLIENT] NSFW image generation enabled in NSFW channel ${message.channelId}`);
      }

      const isNsfwChannel = isDiscordNsfwChannel(message.channel);

      // Generate response with tool availability attached for model-directed use
      const response = await handleMessage({
        content: contentWithStickers,
        imageUrls: permittedImageUrls,
        videoUrls: permittedVideoUrls,
        textAttachments,
        pageContents: pageContents.length > 0 ? pageContents : undefined,
        userId: message.author.id,
        username: authorDisplayName,
        guildId: message.guildId || 'dm',
        mentionedUsers,
        replyContext: replyContext ? {
          isReply: replyContext.isReply,
          isReplyToLumia: replyContext.isReplyToLumia,
          originalContent: replyContext.originalContent,
          originalTimestamp: replyContext.originalTimestamp,
          originalAuthor: replyContext.originalAuthor,
        } : undefined,
        channelMessages: channelTurns,
        getUserListeningActivity,
        resolveUserMention,
        isNsfwChannel,
        allowNsfwImageGeneration,
        requestCollectiveKnowledge,
        source: resolveInteractionSource(message.content, botId, replyContext?.isReplyToLumia === true),
        channelId: message.channelId,
        channelName: getChannelDisplayName(message.channel),
        guildName: message.guild?.name,
      });

      // Clear typing indicator before sending response
      if (canType) {
        this.stopTyping(message.channelId, typingHolder);
      }

      // Cross-path reply guard: prevent double replies if the orchestrator path
      // also processed this message (or any other duplicate trigger).
      if (this.hasAlreadyReplied(message.id)) {
        console.warn(`⚠️ [CLIENT] Suppressing duplicate reply for message ${message.id} (direct path blocked by cross-path guard)`);
        return;
      }

      const allowedMentions = buildAllowedMentions(allowedMentionUserIds);

      // One card per turn: the reply text as the description and the GIF as the
      // banner image. Previously the text went out as message content and the
      // GIF followed as a bare link in a second message, purely to keep the link
      // out of view; an embed image does that without a second message.
      //
      // `card` being null is the escape hatch back to that old layout
      // (EMBED_ENABLED=false), and also the "nothing to say" case.
      const card = config.bot.embed.enabled
        ? buildResponseCard({ text: response.text, gifUrl: response.gifUrl })
        : null;

      // Discord has a 2000 character limit for messages; escape before truncating
      // because inserted Markdown backslashes count toward that limit. Unused when
      // the card carries the text, so it is only computed in the text layout.
      const formattedResponse = card ? '' : formatDiscordResponseText(response.text);

      // Check if channel is still available before sending (bot may have been kicked)
      if (!message.channel) {
        console.warn('⚠️ [CLIENT] Cannot send message - channel no longer available (bot may have been kicked)');
        return;
      }

      // Send the text response and any generated image attachments
      // Use failIfNotExists: false to handle cases where the message being replied to
      // is a forwarded message or has been deleted
      let sentMessage;
      const files = buildDiscordImageFiles(response.attachments);
      try {
        sentMessage = await message.reply({
          content: formattedResponse || undefined,
          embeds: card ? [card] : undefined,
          allowedMentions,
          files,
          failIfNotExists: false,
        });
      } catch (replyError) {
        // Only fall back when the reply target is genuinely unavailable.
        // For generic failures, rethrow so we don't risk posting the same reply twice.
        if (!isReplyReferenceFailure(replyError)) {
          throw replyError;
        }

        console.warn('⚠️ [CLIENT] Reply target unavailable, sending as regular message:', replyError);
        if (message.channel instanceof TextChannel ||
            message.channel instanceof ThreadChannel ||
            message.channel instanceof NewsChannel ||
            message.channel instanceof VoiceChannel ||
            message.channel instanceof StageChannel ||
            message.channel instanceof DMChannel) {
          sentMessage = await message.channel.send({
            content: formattedResponse ? `${message.author} ${formattedResponse}` : `${message.author}`,
            embeds: card ? [card] : undefined,
            allowedMentions: buildAllowedMentions([...allowedMentionUserIds, message.author.id]),
            files,
          });
        } else {
          throw replyError;
        }
      }

      // Fallback only: when the card is in use the GIF is already rendered as the
      // embed's image, so posting it again would duplicate the GIF in chat. This
      // branch is the pre-card layout (EMBED_ENABLED=false), where the GIF had no
      // other way to render without exposing its link.
      if (!card && response.gifUrl && 'send' in message.channel) {
        try {
          await message.channel.send(response.gifUrl);
          console.log(`🎬 [CLIENT] Sent GIF in separate message: ${response.gifUrl}`);
        } catch (gifError) {
          console.error(`❌ [CLIENT] Failed to send GIF message:`, gifError);
        }
      }

      // Add reactions if any were specified
      if (response.reactions.length > 0) {
        for (const emoji of response.reactions) {
          try {
            const resolved = this.resolveEmojiReaction(emoji, message.guild ?? undefined);
            await message.react(resolved);
            console.log(`😀 [CLIENT] Added reaction: ${resolved} (raw: ${emoji})`);
          } catch (reactError) {
            console.error(`❌ [CLIENT] Failed to add reaction "${emoji}":`, reactError);
          }
        }
      }
    } catch (error) {
      // Clear typing indicator on error too
      if (canType) {
        this.stopTyping(message.channelId, typingHolder);
      }
      console.error('Message response error:', error);
      // Check if channel is still available before trying to send error message
      if (!message.channel) {
        console.warn('⚠️ [CLIENT] Cannot send error message - channel no longer available (bot may have been kicked)');
        return;
      }
      try {
        await message.reply(getErrorMessage('generic_error'));
      } catch (replyError) {
        console.error('❌ [CLIENT] Failed to send error reply:', replyError);
      }
    } finally {
      // Release only the lease this turn actually holds. A `null` lease (the turn
      // lost the `begin` race) is a no-op, so a suppressed turn can never free the
      // in-flight generation's key.
      this.generationGuard.release(generationLease);
    }
  }

  /**
   * Handle an orchestrated mention
   */
  private async handleOrchestratedMention(
    message: Message,
    replyContext?: ReplyContext
  ): Promise<void> {
    if (!this.orchestrator) return;

    console.log(`🎭 [Orchestrator] Handling orchestrated mention - NOTIFYING ONLY`);

    const eventId = `evt-${message.id}`;
    const botId = this.client.user?.id;

    // Determine which bot IDs to include in the orchestrator mention.
    // If this bot is directly @mentioned, include all @mentioned bots (multi-bot coordination).
    // If this bot is only triggered by keywords, include only itself — don't drag
    // @mentioned bots into a banter session they may already be handling directly.
    const mentionedBots = message.mentions.users.filter(user => user.bot);
    const isSelfMentioned = botId ? mentionedBots.has(botId) : false;
    let mentionedBotIds: string[];

    if (isSelfMentioned) {
      // Bot was @mentioned — include all mentioned bots for coordination
      mentionedBotIds = mentionedBots.map(user => user.id);
    } else {
      // Bot was triggered by keywords only — only include itself
      mentionedBotIds = botId ? [botId] : [];
    }

    // Extract trigger keywords that matched for this bot
    const triggerKeywords = extractTriggerKeywords(message.content);

    // Extract modal content (images, videos, text files) from the message
    const imageUrls: string[] = [];
    const videoUrls: MediaAttachment[] = [];
    const textAttachments: TextAttachment[] = [];

    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('image/gif')) {
          videoUrls.push({
            url: attachment.url,
            mimeType: attachment.contentType,
          });
          console.log(`🎬 [Orchestrator] GIF found in message (will convert to WebM): ${attachment.name} (${attachment.contentType})`);
        } else if (attachment.contentType?.startsWith('image/')) {
          imageUrls.push(attachment.url);
          console.log(`🖼️  [Orchestrator] Image found in message: ${attachment.name} (${attachment.contentType})`);
        } else if (attachment.contentType?.startsWith('video/')) {
          videoUrls.push({
            url: attachment.url,
            mimeType: attachment.contentType,
          });
          console.log(`🎥 [Orchestrator] Video found in message: ${attachment.name} (${attachment.contentType})`);
        } else if (attachment.contentType?.startsWith('text/') || 
                  attachment.name.match(/\.(txt|md|json|csv|log|xml|yaml|yml|js|ts|jsx|tsx|py|rb|java|c|cpp|h|hpp|cs|go|rs|php|html|css|scss|sass|less|sql)$/i)) {
          // Text file detected - check size and read content
          const maxSizeBytes = config.attachments.maxTextFileSizeKB * 1024;
          
          // Check file size before downloading
          if (attachment.size > maxSizeBytes) {
            console.log(`📄 [Orchestrator] Text file too large: ${attachment.name} (${(attachment.size / 1024).toFixed(1)}KB > ${config.attachments.maxTextFileSizeKB}KB limit)`);
            textAttachments.push({
              name: attachment.name,
              content: `[File too large: ${(attachment.size / 1024).toFixed(1)}KB. Maximum size is ${config.attachments.maxTextFileSizeKB}KB]`,
            });
            continue;
          }
          
          try {
            console.log(`📄 [Orchestrator] Text file detected: ${attachment.name} (${attachment.contentType || 'unknown type'}, ${(attachment.size / 1024).toFixed(1)}KB)`);
            // `safeFetchText`, not a bare `fetch` — same reasoning as the direct
            // path: the Discord host is pinned by `allowHosts`, every redirect hop
            // is re-validated, and `maxBytes` is enforced while streaming.
            const { text: textContent } = await safeFetchText(attachment.url, {
              allowHosts: mediaAllowedHosts(),
              maxBytes: maxSizeBytes,
              timeoutMs: DISCORD_MEDIA_TIMEOUT_MS,
            });
            // Limit text content to prevent token overflow
            const maxChars = maxSizeBytes;
            const truncatedContent = textContent.length > maxChars
              ? textContent.substring(0, maxChars) + '\n... [content truncated]'
              : textContent;
            textAttachments.push({
              name: attachment.name,
              content: truncatedContent,
            });
            console.log(`📄 [Orchestrator] Read text file: ${attachment.name} (${truncatedContent.length} chars)`);
          } catch (error) {
            console.error(`❌ [Orchestrator] Error reading text file ${attachment.name}:`, error);
          }
        }
      }
    }

    // Extract embeds from current message (Tenor GIFs, link previews, etc.)
    if (message.embeds.length > 0) {
      for (const embed of message.embeds) {
        const embedType = embed.data?.type;

        if (embedType === 'gifv' && embed.video?.url) {
          videoUrls.push({ url: embed.video.url, mimeType: 'image/gif' });
          console.log(`🎬 [Orchestrator] GIFV embed in message: ${embed.url || embed.video.url}`);
        } else if (embedType === 'video' && embed.video?.url) {
          videoUrls.push({ url: embed.video.proxyURL || embed.video.url, mimeType: 'video/mp4' });
          console.log(`🎥 [Orchestrator] Video embed in message: ${embed.url || embed.video.url}`);
        } else if (embedType === 'image' && embed.image?.url) {
          imageUrls.push(embed.image.proxyURL || embed.image.url);
          console.log(`🖼️  [Orchestrator] Image embed in message: ${embed.image.url}`);
        } else if (embedType === 'rich' || embedType === 'article' || embedType === 'link') {
          if (embed.image?.url) {
            imageUrls.push(embed.image.proxyURL || embed.image.url);
            console.log(`🖼️  [Orchestrator] Rich embed image in message: ${embed.image.url}`);
          }
          if (embed.thumbnail?.url) {
            imageUrls.push(embed.thumbnail.proxyURL || embed.thumbnail.url);
            console.log(`🖼️  [Orchestrator] Rich embed thumbnail in message: ${embed.thumbnail.url}`);
          }
        }
      }
    }

    // Merge stickers on the triggering message into the media arrays and content.
    const stickerMedia = extractStickerMedia(message, 'Orchestrator');
    imageUrls.push(...stickerMedia.imageUrls);
    videoUrls.push(...stickerMedia.videoUrls);

    // Extract custom emoji images from message content so the model can see them.
    imageUrls.push(...extractCustomEmojiUrls(message.content, 'Orchestrator'));

    const notifyContent = stickerMedia.stickerHints.length > 0
      ? (message.content
          ? `${message.content} ${stickerMedia.stickerHints.join(' ')}`
          : stickerMedia.stickerHints.join(' '))
      : message.content;

    // Add embedded content from reply context
    if (replyContext?.embeddedContent) {
      imageUrls.push(...replyContext.embeddedContent.images);
      videoUrls.push(...replyContext.embeddedContent.videos);
    }

    // Enforce the Discord-CDN allowlist before this bot stores or transmits the
    // media list. Same SSRF/exfiltration reasoning as the direct path: embed
    // image/thumbnail/video URLs are attacker-chosen and would otherwise be
    // fetched server-side and forwarded to the model vendor. Filtering here (and
    // again in `handleOrchestratorResponse`, for snapshot-supplied lists) means
    // neither the queue nor the notify payload can carry a non-Discord URL.
    const permittedImageUrls = await filterDiscordMediaUrls(imageUrls, 'ORCH-NOTIFY');
    const permittedVideoUrls = await filterDiscordMediaAttachments(videoUrls, 'ORCH-NOTIFY');

    // Store the message info and modal content so we can reply when orchestrator asks us to
    this.orchestratorQueue!.set(eventId, {
      message,
      replyContext,
      imageUrls: permittedImageUrls,
      videoUrls: permittedVideoUrls,
      textAttachments,
    });

    // Record which channel this bot announced a mention for.
    //
    // This is the client-side half of the orchestrator authorisation story. The
    // orchestrator's `authorizeTurn()` pins its own claim about the channel, but
    // the *snapshot* it sends back is what `resolveOrchestratorQueuedInfo` acts
    // on when the live queue entry is gone. Without this index, a peer holding
    // the shared API key could pair an authorised `eventId` with a snapshot
    // naming any message in any channel this bot can read. With it, a snapshot is
    // only honoured when its channel matches the one we queued for.
    this.queuedMessageChannels.set(eventId, message.channelId);

    // Notify orchestrator about the mention (fire and forget)
    this.orchestrator.notifyMention({
      eventId,
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId || 'dm',
      authorId: message.author.id,
      authorName: message.author.username,
      content: notifyContent,
      mentionedBotIds,
      timestamp: message.createdAt,
      triggerKeywords: triggerKeywords.length > 0 ? triggerKeywords : undefined,
      replyContext,
      imageUrls: permittedImageUrls,
      videoUrls: permittedVideoUrls,
      textAttachments,
    });

    console.log(`🎭 [Orchestrator] Mention notification sent, returning immediately`);
    // Return immediately - don't wait for orchestrator
    // The orchestrator will send response_request when it's this bot's turn
  }

  async login(): Promise<void> {
    await this.client.login(config.discord.token);
  }

  async destroy(): Promise<void> {
    this.stopAllTyping();

    // Clear the retained interval and timeout handles. These were previously
    // registered with a bare `setInterval`/`setTimeout` and never cleared, which
    // was harmless only because `process.exit(0)` fired immediately after; any
    // graceful-restart path that awaited real teardown would hang on them. They
    // are `unref()`'d too, so they can never be the reason the process stays
    // alive.
    if (this.orchestratorSweepInterval) {
      clearInterval(this.orchestratorSweepInterval);
      this.orchestratorSweepInterval = undefined;
    }
    for (const timer of this.processedMessageTimers.values()) {
      clearTimeout(timer);
    }
    this.processedMessageTimers.clear();
    this.processedMessageIds.clear();
    for (const timer of this.repliedMessageTimers.values()) {
      clearTimeout(timer);
    }
    this.repliedMessageTimers.clear();
    this.repliedMessageIds.clear();
    this.typingChannels.clear();
    this.orchestratorQueue.clear();
    this.queuedMessageChannels.clear();
    this.generationGuard.clear();

    boredomService.stop();
    if (this.orchestrator) {
      this.orchestrator.disconnect();
    }
    await this.client.destroy();
  }

  /**
   * Update orchestrator with current guilds (call this after bot is ready)
   */
  updateOrchestratorGuilds(): void {
    if (this.orchestrator) {
      const guilds = Array.from(this.client.guilds.cache.keys());
      const status = this.orchestrator.getConnectionStatus();
      
      console.log(`[Orchestrator] Updating guilds: ${guilds.length} guilds (connected: ${status.isConnected})`);
      
      // Use forceGuildUpdate to ensure it gets sent even if not connected yet
      this.orchestrator.forceGuildUpdate(guilds);
    }
  }

  /**
   * Get orchestrator connection status
   */
  getOrchestratorStatus(): { isConnected: boolean; hasPendingGuildUpdate: boolean; pendingGuildCount: number } | null {
    if (!this.orchestrator) return null;
    return this.orchestrator.getConnectionStatus();
  }
}

export const bot = new DiscordBot();
