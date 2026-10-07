import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel, ThreadChannel, NewsChannel, VoiceChannel, StageChannel, DMChannel } from 'discord.js';
import { getAIService } from '../services/google-genai';
import { getErrorMessage } from '../services/prompts';
import { gifService } from '../services/gif';
import { formatDiscordResponseText } from '../utils/discord-markdown';
import { buildResponseCard } from '../utils/response-card';
import { config } from '../utils/config';
import { buildAllowedMentions } from '../utils/permissions';
import { channelHistoryService } from '../services/channel-history';
import { conversationHistoryService } from '../services/conversation-history';
import type { ChatMessage } from '../services/openai';
import type { Command } from '../bot/client';

/**
 * Recent channel turns for context, or `undefined` when there are none to give.
 *
 * Never throws: history is an enrichment, and a channel the bot cannot read
 * (missing permissions, or a channel type with no text messages) must still get
 * an answer — just one without surrounding context. The same degradation
 * already exists on the mention path, which wraps its own fetch in try/catch.
 *
 * The instanceof chain is what narrows `interaction.channel` to the union
 * `fetchChannelHistory` accepts; the cast is only to satisfy discord.js's
 * `ThreadChannel<boolean>` vs. thread-literal generic split, which is erased
 * at runtime and cannot change which branch was taken.
 */
async function fetchChannelTurns(interaction: ChatInputCommandInteraction): Promise<ChatMessage[] | undefined> {
  const channel = interaction.channel;
  if (!(
    channel instanceof TextChannel
    || channel instanceof ThreadChannel
    || channel instanceof NewsChannel
    || channel instanceof VoiceChannel
    || channel instanceof StageChannel
    || channel instanceof DMChannel
  )) {
    return undefined;
  }

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
      const isGifEnabled = gifService.isGifEnabled(guildId);
      const userId = interaction.user.id;
      const username = interaction.user.username;

      // Recent channel turns, so `/chat what did she just say?` has the same
      // grounding a mention-triggered reply has.
      const channelTurns = await fetchChannelTurns(interaction);

      // Per-user summary of past interactions, injected into the system prompt.
      // The mention path gets this from `handleMessage`; `/chat` used to pass
      // nothing, so the two paths disagreed about how much they remembered.
      const conversationSummary = conversationHistoryService.formatHistoryForPrompt(userId, guildId);

      // Store the question before generating, and the answer only after the model
      // actually produced one — the same ordering `handleMessage` uses, so a
      // failed turn leaves a user message with no dangling reply rather than
      // committing a half-conversation.
      conversationHistoryService.addMessage(userId, guildId, username, 'user', message);

      const aiService = getAIService();
      const response = await aiService.createChatCompletion({
        messages: [
          ...(channelTurns || []),
          {
            role: 'user',
            content: message,
          },
        ],
        enableSearch: enableSearch === null ? undefined : enableSearch,
        images: imageUrls,
        videos: videoUrls,
        userId,
        username,
        guildId,
        isNsfwChannel,
        isGifEnabled,
        conversationSummary: conversationSummary || undefined,
      });

      const { text: textWithoutGif, gifUrl } = isGifEnabled
        ? await gifService.extractAndResolveGif(response)
        : { text: response, gifUrl: undefined };

      // Only now that there is a real reply to record. `handleMessage` stores the
      // same post-success, for the same reason: a turn that ends in "Something
      // went wrong" must not enter the user's memory as something they said.
      conversationHistoryService.addMessage(userId, guildId, username, 'assistant', textWithoutGif);

      // One card per turn, same shape as the mention path: the reply is the
      // description and the GIF is the banner image, so the GIF never appears as
      // a bare link and no second message is needed.
      const card = config.bot.embed.enabled
        ? buildResponseCard({ text: textWithoutGif, gifUrl })
        : null;
      const formatted = card ? '' : formatDiscordResponseText(textWithoutGif);

      // Model output is attacker-influenceable: the prompt can carry a
      // web-search result or a quoted message containing `@everyone`, and
      // `editReply` with no allowedMentions falls back to discord.js's default
      // of parsing mentions. `parse: []` is the hardened form the mention
      // path already uses.
      await interaction.editReply({
        content: formatted || (card ? undefined : '...'),
        embeds: card ? [card] : undefined,
        allowedMentions: buildAllowedMentions(),
      });

      // Pre-card layout only: with the card the GIF is already rendered as the
      // embed image, and following up would show it twice.
      if (!card && gifUrl) {
        await interaction.followUp({ content: gifUrl, allowedMentions: buildAllowedMentions() });
      }
    } catch (error) {
      console.error('Chat command error:', error);
      await interaction.editReply({ content: getErrorMessage('generic_error'), allowedMentions: buildAllowedMentions() });
    }
  },
};

export default command;
