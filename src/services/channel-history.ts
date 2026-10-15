import type { APIEmbed, Message, TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel } from 'discord.js';
import { EmbedType } from 'discord.js';
import { config } from '../utils/config';
import type { ChatMessage } from './openai';
import type { ContextMessage } from './orchestrator/types';

export interface ChannelMessage {
  id: string;
  authorId: string;
  authorUsername: string;
  content: string;
  timestamp: Date;
  isBot: boolean;
}

type TurnFormat = 'default' | 'orchestrator';

interface PromptTurn {
  role: 'user' | 'assistant';
  content: string;
  speakerKey: string;
}

/** Marker used for an embed that carries media but no text of its own. */
const EMBED_IMAGE_MARKER = '[image]';
const EMBED_VIDEO_MARKER = '[video]';

/**
 * Reduce one embed to the text a reader would actually have to read, in the
 * order Discord renders it: description, then title, then fields.
 *
 * WHY NOT author.name AND footer.text
 * -----------------------------------
 * Those two are deliberately dropped. On this bot's own response card they are
 * pure decorative chrome — `⋆˖⁺‧₊☽Name☾₊‧⁺˖⋆` and `૮₍ ˃ ⤙ ˂ ₎ა arf.` — and the card
 * is posted once per turn, so re-injecting them would repeat the same two lines
 * of noise in every prompt forever. They also carry no information the message
 * author is not already tagged with (`buildPromptTurn` prefixes every non-bot
 * message with `[displayName]:`, and embeds are posted by someone who is in the
 * channel under that name).
 *
 * A human embed's author/footer is occasionally informative, but the cost is
 * paid on every turn of a long channel, which outweighs the rare gain. If that
 * ever turns out to matter, the right place to add it is here — not in the
 * send path — so every read path picks it up at once.
 */
function extractEmbedText(embed: APIEmbed): string[] {
  // Discord auto-generates a `link` embed for ANY message containing a URL, so
  // a plain "https://…" from a human arrives here as an embed. Left unhandled
  // it would dump the page title and scraped description into the prompt; two
  // reasons that is not simply free text:
  //
  //   1. Provenance. The title is *not* something the author typed, and pasting
  //      it unlabelled invites the model to treat scraped page text as something
  //      a person in the channel said (and scraped page text is the cheapest
  //      prompt-injection vector available). The `[link preview: …]` label keeps
  //      the provenance visible.
  //   2. Budget. The URL itself is already in `message.content`, so the preview
  //      adds no new *reference* — only the one thing that makes the link
  //      intelligible, which is its title. The preview description is scraped
  //      ad-copy, frequently the longest part of the payload, and would crowd
  //      out the message the person actually wrote.
  //
  // So: keep the title, label it, drop the rest. A link preview with no title
  // (Discord sends those for some redirects) contributes nothing — the URL in
  // `message.content` is still there.
  if (embed.type === EmbedType.Link) {
    const title = embed.title?.trim();
    return title ? [`[link preview: ${title}]`] : [];
  }

  const parts: string[] = [];

  const description = embed.description?.trim();
  if (description) parts.push(description);

  const title = embed.title?.trim();
  if (title) parts.push(title);

  // A field-only embed (no description, or no title either) is common: status
  // embeds, build notices, and every embed that never sets a description.
  for (const field of embed.fields ?? []) {
    const name = field.name?.trim();
    const value = field.value?.trim();
    if (name && value) parts.push(`${name}: ${value}`);
    else if (value) parts.push(value);
    else if (name) parts.push(name);
  }

  return parts;
}

/**
 * Fallback marker for an embed with media but no text.
 *
 * `embed.image.url` / `embed.video.url` are URLs and URLs stay out of the
 * prompt: the bot's card hides its GIF *behind* an embed image precisely so the
 * link is never printed, and echoing it here would undo that from the read
 * side. But a bare card with no description (a GIF-only turn) would otherwise
 * be indistinguishable from a message that never rendered, so it gets the same
 * `[image]` token an attachment would get.
 *
 * Deliberately NOT emitted when the embed also has text: a card that says
 * something and carries a GIF is just a reply, and an extra `[image]` on the
 * bot's own past turns would teach the model to claim it posted pictures. The
 * marker stands in for missing text, it is not a description of the message.
 */
function extractEmbedMediaMarker(embed: APIEmbed): string[] {
  if (extractEmbedText(embed).length > 0) return [];
  if (embed.video?.url || embed.type === EmbedType.GIFV || embed.type === EmbedType.Video) {
    return [EMBED_VIDEO_MARKER];
  }
  if (embed.image?.url || embed.thumbnail?.url || embed.type === EmbedType.Image) {
    return [EMBED_IMAGE_MARKER];
  }
  return [];
}

/**
 * Flatten every embed on a message into one block of plain text.
 *
 * Discord permits up to 10 embeds per message, and they are rendered as separate
 * cards, so each is considered on its own and the blocks are kept apart rather
 * than concatenated — otherwise the tail of the last field of the first embed
 * would read as continuous with the description of the second.
 */
export function extractEmbedContent(embeds: readonly APIEmbed[]): string[] {
  const blocks: string[] = [];

  for (const embed of embeds) {
    const text = extractEmbedText(embed);
    if (text.length > 0) {
      blocks.push(text.join('\n'));
      continue;
    }
    blocks.push(...extractEmbedMediaMarker(embed));
  }

  return blocks.filter((block) => block.trim().length > 0);
}

export class ChannelHistoryService {
  private readonly maxMessages: number;
  private readonly maxMessageLength: number;

  constructor() {
    this.maxMessages = config.channel.maxHistoryLength;
    this.maxMessageLength = 200; // Truncate long messages
  }

  private escapeAttribute(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Clip one piece of a message to `maxMessageLength`, marking that it was cut.
   *
   * Never splits a surrogate pair: slicing between the high and low half of an
   * emoji leaves invalid UTF-16, which is exactly the class of bug
   * `response-card.ts` already had to work around on the send side.
   */
  private truncate(text: string): string {
    if (text.length <= this.maxMessageLength) return text;
    let head = text.slice(0, this.maxMessageLength);
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return `${head}...`;
  }

  private buildPromptTurn(message: ChannelMessage, currentBotId?: string, format: TurnFormat = 'default'): PromptTurn {
    const isCurrentBot = message.isBot && message.authorId === currentBotId;

    if (isCurrentBot) {
      return {
        role: 'assistant',
        content: message.content,
        speakerKey: `assistant:${message.authorId}`,
      };
    }

    if (format === 'orchestrator') {
      const tagName = message.isBot ? 'orchestrator-bot-message' : 'orchestrator-user-message';
      const speaker = this.escapeAttribute(message.authorUsername || (message.isBot ? 'Unknown Bot' : 'Unknown User'));

      return {
        role: 'user',
        content: `<${tagName} speaker="${speaker}" authorId="${message.authorId}">\n${message.content}\n</${tagName}>`,
        speakerKey: `user:${message.isBot ? 'bot' : 'human'}:${message.authorId}`,
      };
    }

    let displayName = message.authorUsername;
    if (message.isBot && message.authorId !== currentBotId) {
      displayName = displayName.replace(/\s*Lumia\s*/gi, '').trim() || 'Other Bot';
    }

    return {
      role: 'user',
      content: `[${displayName}]: ${message.content}`,
      speakerKey: `user:${message.isBot ? 'bot' : 'human'}:${message.authorId}`,
    };
  }

  private mergePromptTurns(turns: PromptTurn[]): ChatMessage[] {
    const merged: Array<ChatMessage & { speakerKey: string }> = [];

    for (const turn of turns) {
      const last = merged[merged.length - 1];
      if (last && last.role === turn.role && last.speakerKey === turn.speakerKey && typeof last.content === 'string') {
        last.content += '\n\n' + turn.content;
      } else {
        merged.push({ role: turn.role, content: turn.content, speakerKey: turn.speakerKey });
      }
    }

    return merged.map(({ speakerKey: _speakerKey, ...message }) => message);
  }

  /**
   * Fetch recent messages from a Discord channel
   * Returns messages in chronological order (oldest first)
   */
  async fetchChannelHistory(
    channel: TextChannel | ThreadChannel | NewsChannel | VoiceChannel | StageChannel | DMChannel,
    beforeMessageId?: string
  ): Promise<ChannelMessage[]> {
    try {
      const fetchOptions: { limit: number; before?: string } = {
        limit: this.maxMessages + 5, // Fetch a few extra to account for filtering
      };

      if (beforeMessageId) {
        fetchOptions.before = beforeMessageId;
      }

      console.log(`📜 [CHANNEL] Fetching last ${this.maxMessages} messages from channel ${channel.id}`);
      
      const messages = await channel.messages.fetch(fetchOptions);
      
      // Convert to array and filter/process
      const processedMessages: ChannelMessage[] = [];
      
      messages.forEach((message: Message) => {
        // Skip the current message (if we're fetching before a specific message)
        if (beforeMessageId && message.id === beforeMessageId) {
          return;
        }

        // Read the embeds before deciding whether this message is empty.
        //
        // THIS IS THE FIX FOR THE RESPONSE CARD. The bot replies with an embed
        // (see `utils/response-card.ts`) and sends no `content` alongside it, so
        // a card has `content === ''`, no attachments and no stickers. The old
        // filter below discarded exactly those messages, which meant the bot
        // could not read back its own replies and lost all self-continuity in
        // channel context. Anything else a human posts as a rich embed was
        // invisible for the same reason.
        //
        // This is deliberately fixed on the READ side: the card stays one
        // message with no exposed GIF link, and every read path (`/chat`,
        // `/dryrun`, mentions, boredom, the orchestrator) is fixed at once
        // because they all funnel through this method.
        const embedBlocks = extractEmbedContent(message.embeds.map((embed) => embed.data));

        // Skip empty messages — an embed now counts as content.
        if (
          !message.content.trim() &&
          embedBlocks.length === 0 &&
          message.attachments.size === 0 &&
          message.stickers.size === 0
        ) {
          return;
        }

        const annotations: string[] = [];
        if (message.attachments.size > 0) {
          annotations.push(...message.attachments.map(att => {
            if (att.contentType?.startsWith('image/')) return '[image]';
            if (att.contentType?.startsWith('video/')) return '[video]';
            return '[file]';
          }));
        }
        if (message.stickers.size > 0) {
          annotations.push(...message.stickers.map(s => `[sticker: ${s.name}]`));
        }
        // Truncate very long messages.
        //
        // Done per source — the author's words and the flattened embed text each
        // get their own full `maxMessageLength` budget — rather than on the
        // combined string. A single shared cut would be actively misleading now:
        // a 180-char message followed by a 400-char link preview would leave
        // `[link preview: Some very long page ti...`, i.e. visible text that is a
        // fragment saying nothing true about the message. Per-source, each piece
        // is either complete or clearly marked `...`, and nothing that was there
        // can silently evict something else.
        let content = this.truncate(message.content);
        const embedText = this.truncate(embedBlocks.join('\n\n'));
        if (embedText) {
          content = content ? `${content}\n\n${embedText}` : embedText;
        }

        // Annotations go on last and are never truncated: they are the shortest
        // and the most load-bearing part (`[image]` is the only trace of a
        // GIF-only turn), so a long body must not be able to cut them off.
        if (annotations.length > 0) {
          content = content ? `${content} ${annotations.join(' ')}` : annotations.join(' ');
        }

        processedMessages.push({
          id: message.id,
          authorId: message.author.id,
          authorUsername: message.member?.displayName || message.author.displayName || message.author.username,
          content: content,
          timestamp: message.createdAt,
          isBot: message.author.bot,
        });
      });

      // Reverse to get chronological order (oldest first)
      processedMessages.reverse();

      // Take only the last maxMessages
      const result = processedMessages.slice(-this.maxMessages);

      console.log(`📜 [CHANNEL] Retrieved ${result.length} messages from channel history`);
      return result;

    } catch (error) {
      console.error('📜 [CHANNEL] Failed to fetch channel history:', error);
      return [];
    }
  }

  /**
   * Convert channel messages into ChatMessage[] turns for the LLM.
   * - Messages from the current bot become assistant role
   * - All other messages (users + other bots) become user role with [displayName]: prefix
   * - Consecutive same-role messages are merged to avoid API errors
   */
  convertToTurns(messages: ChannelMessage[], currentBotId?: string): ChatMessage[] {
    if (messages.length === 0) {
      return [];
    }

    const rawTurns = messages.map((message) => this.buildPromptTurn(message, currentBotId, 'default'));
    return this.mergePromptTurns(rawTurns);
  }

  /**
   * Convert orchestrator ContextMessage[] into ChatMessage[] turns.
   * Maps ContextMessage fields to ChannelMessage and delegates to convertToTurns().
   */
  convertOrchestratorToTurns(messages: ContextMessage[], currentBotId?: string): ChatMessage[] {
    const channelMessages: ChannelMessage[] = messages.map(m => ({
      id: m.id,
      authorId: m.authorId,
      authorUsername: m.authorName,
      content: m.content,
      timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
      isBot: m.isBot,
    }));

    const rawTurns = channelMessages.map((message) => this.buildPromptTurn(message, currentBotId, 'orchestrator'));
    return this.mergePromptTurns(rawTurns);
  }

  convertMessageToTurn(
    message: Pick<ChannelMessage, 'id' | 'authorId' | 'authorUsername' | 'content' | 'timestamp' | 'isBot'>,
    currentBotId?: string,
    format: TurnFormat = 'default'
  ): ChatMessage {
    const channelMessage: ChannelMessage = {
      id: message.id,
      authorId: message.authorId,
      authorUsername: message.authorUsername,
      content: message.content,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      isBot: message.isBot,
    };

    const { role, content } = this.buildPromptTurn(channelMessage, currentBotId, format);
    return { role, content };
  }

  convertOrchestratorMessageToTurn(message: ContextMessage, currentBotId?: string): ChatMessage {
    const { role, content } = this.buildPromptTurn({
      id: message.id,
      authorId: message.authorId,
      authorUsername: message.authorName,
      content: message.content,
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      isBot: message.isBot,
    }, currentBotId, 'orchestrator');
    return { role, content };
  }
}

// Singleton instance - uses CHANNEL_MAX_HISTORY from environment
export const channelHistoryService = new ChannelHistoryService();
