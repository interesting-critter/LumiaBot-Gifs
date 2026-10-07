import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  ThreadChannel,
  NewsChannel,
  VoiceChannel,
  StageChannel,
  DMChannel,
} from 'discord.js';
import { getErrorMessage } from '../services/prompts';
import { formatDiscordResponseText } from '../utils/discord-markdown';
import { buildResponseCard } from '../utils/response-card';
import { config } from '../utils/config';
import { buildAllowedMentions } from '../utils/permissions';
import { channelHistoryService } from '../services/channel-history';
import { handleMessage } from '../services/message-handler';
import { buildDiscordImageFiles } from '../bot/client';
import type { ChatMessage } from '../services/openai';
import type { Command } from '../bot/client';

/** Channel types `fetchChannelHistory` can read a message history from. */
type HistoryCapableChannel =
  | TextChannel
  | ThreadChannel
  | NewsChannel
  | VoiceChannel
  | StageChannel
  | DMChannel;

function isHistoryCapable(channel: unknown): channel is HistoryCapableChannel {
  return channel instanceof TextChannel
    || channel instanceof ThreadChannel
    || channel instanceof NewsChannel
    || channel instanceof VoiceChannel
    || channel instanceof StageChannel
    || channel instanceof DMChannel;
}

/**
 * Resolve the interaction's channel to something with a readable history.
 *
 * WHY THIS FETCHES INSTEAD OF READING `interaction.channel`
 * --------------------------------------------------------
 * `interaction.channel` is typed `Channel | null` and is **cache-only** — it
 * resolves the channel id against the client's cache and yields `null` when the
 * channel is not in it. That is not hypothetical: an uncached channel made
 * `/chat` silently answer with no context at all, because an earlier version of
 * this helper treated a `null` channel as "no history available" and returned
 * without a word. The user got a confident reply to "what did she just say?"
 * from a model that had never seen the channel.
 *
 * So: prefer the cache, fall back to an API fetch, and only then give up — and
 * say so, rather than degrading to a silent blank.
 */
async function resolveHistoryChannel(interaction: ChatInputCommandInteraction): Promise<HistoryCapableChannel | null> {
  const cached = interaction.channel;
  if (isHistoryCapable(cached)) return cached;

  if (!interaction.channelId) return null;

  try {
    const fetched = await interaction.client.channels.fetch(interaction.channelId);
    if (isHistoryCapable(fetched)) return fetched;
    console.warn(`📜 [CHAT COMMAND] Channel ${interaction.channelId} is ${fetched?.constructor.name ?? 'unavailable'}, which has no message history`);
    return null;
  } catch (error) {
    // Usually a permissions problem (no Read Message History). Worth saying out
    // loud: the difference between "no history exists" and "cannot read history"
    // is the difference between a correct answer and a confidently wrong one.
    console.warn(`📜 [CHAT COMMAND] Could not resolve channel ${interaction.channelId} for history:`, error);
    return null;
  }
}

/**
 * Recent channel turns for context, or `undefined` when there are none to give.
 *
 * Never throws: history is an enrichment, and a channel the bot cannot read must
 * still get an answer — just one without surrounding context.
 */
async function fetchChannelTurns(interaction: ChatInputCommandInteraction): Promise<ChatMessage[] | undefined> {
  const channel = await resolveHistoryChannel(interaction);
  if (!channel) return undefined;

  try {
    const history = await channelHistoryService.fetchChannelHistory(
      channel as Parameters<typeof channelHistoryService.fetchChannelHistory>[0],
    );
    if (history.length === 0) return undefined;
    const turns = channelHistoryService.convertToTurns(history, interaction.client.user?.id);
    console.log(`📜 [CHAT COMMAND] Converted ${history.length} channel messages to ${turns.length} chat turns`);
    return turns;
  } catch (error) {
    console.warn('📜 [CHAT COMMAND] Failed to fetch channel history:', error);
    return undefined;
  }
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat with the AI assistant')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Your message to the AI')
        .setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName('search')
        .setDescription('Enable web search for better answers')
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName('image')
        .setDescription('Attach an image for the AI to analyze')
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName('video')
        .setDescription('Attach a video for the AI to watch (Gemini 3 models only)')
        .setRequired(false)
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const message = interaction.options.getString('message', true);
    const enableSearch = interaction.options.getBoolean('search');
    const imageAttachment = interaction.options.getAttachment('image');
    const videoAttachment = interaction.options.getAttachment('video');

    // Check if channel is NSFW
    const channel = interaction.channel;
    const isNsfwChannel = channel && 'nsfw' in channel ? Boolean(channel.nsfw) : false;

    // Extract image URL if attachment is provided
    const imageUrls: string[] = [];
    if (imageAttachment && imageAttachment.contentType?.startsWith('image/')) {
      imageUrls.push(imageAttachment.url);
      console.log(`🖼️  [CHAT COMMAND] Image attached: ${imageAttachment.name} (${imageAttachment.contentType})`);
    }

    // Extract video URL if attachment is provided
    const videoUrls: { url: string; mimeType?: string }[] = [];
    if (videoAttachment && videoAttachment.contentType?.startsWith('video/')) {
      videoUrls.push({
        url: videoAttachment.url,
        mimeType: videoAttachment.contentType,
      });
      console.log(`🎥 [CHAT COMMAND] Video attached: ${videoAttachment.name} (${videoAttachment.contentType})`);
    }

    await interaction.deferReply();

    try {
      const guildId = interaction.guildId || 'dm';
      const channelTurns = await fetchChannelTurns(interaction);

      // Routed through `handleMessage` rather than calling the AI service
      // directly, so `/chat` and a mention go through the identical pipeline:
      // conversation-history read/write, pronoun and third-party parsing, GIF
      // extraction, reaction-tag stripping, generated-image collection, error
      // templates and dashboard logging. Calling `createChatCompletion` here
      // bypassed all of it, which is why `/chat` used to remember nothing and
      // never appeared in the activity log.
      const response = await handleMessage({
        content: message,
        enableSearch: enableSearch === null ? undefined : enableSearch,
        imageUrls,
        videoUrls,
        userId: interaction.user.id,
        username: interaction.user.username,
        guildId,
        channelMessages: channelTurns,
        currentMessageSpeaker: {
          authorId: interaction.user.id,
          authorName: interaction.user.username,
          isBot: false,
        },
        isNsfwChannel,
        source: 'slash-command',
        channelId: interaction.channelId,
        channelName: channel && 'name' in channel ? channel.name ?? undefined : undefined,
        guildName: interaction.guild?.name,
      });

      // One card per turn, same shape as the mention path: the reply is the
      // description and the GIF is the banner image, so the GIF never appears as
      // a bare link and no second message is needed.
      const card = config.bot.embed.enabled
        ? buildResponseCard({ text: response.text, gifUrl: response.gifUrl })
        : null;
      const formatted = card ? '' : formatDiscordResponseText(response.text);

      // Model output is attacker-influenceable: the prompt can carry a
      // web-search result or a quoted message containing `@everyone`, and
      // `editReply` with no allowedMentions falls back to discord.js's default
      // of parsing mentions. `parse: []` is the hardened form the mention
      // path already uses.
      await interaction.editReply({
        content: formatted || (card ? undefined : '...'),
        embeds: card ? [card] : undefined,
        files: buildDiscordImageFiles(response.attachments),
        allowedMentions: buildAllowedMentions(),
      });

      // Pre-card layout only: with the card the GIF is already rendered as the
      // embed image, and following up would show it twice.
      if (!card && response.gifUrl) {
        await interaction.followUp({ content: response.gifUrl, allowedMentions: buildAllowedMentions() });
      }
    } catch (error) {
      console.error('Chat command error:', error);

      // `editReply` on an expired interaction token fails with 10062
      // "Unknown interaction", so the obvious recovery is to post into the
      // channel instead. That reply is only possible while the channel is still
      // resolvable, and it must not itself throw — an error handler that throws
      // turns one failed turn into an unhandled rejection that the outer
      // command dispatcher cannot report either.
      const message_ = getErrorMessage('generic_error');
      try {
        await interaction.editReply({ content: message_, allowedMentions: buildAllowedMentions() });
      } catch (replyError) {
        console.warn('⚠️ [CHAT COMMAND] editReply failed; falling back to a channel message:', replyError);
        try {
          if (interaction.channel && 'send' in interaction.channel) {
            await interaction.channel.send({ content: message_, allowedMentions: buildAllowedMentions() });
          }
        } catch (sendError) {
          console.error('❌ [CHAT COMMAND] Could not deliver the error message at all:', sendError);
        }
      }
    }
  },
};

export default command;