import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getAIService } from '../services/google-genai';
import { getErrorMessage } from '../services/prompts';
import { gifService } from '../services/gif';
import { formatDiscordResponseText } from '../utils/discord-markdown';
import { buildResponseCard } from '../utils/response-card';
import { config } from '../utils/config';
import { buildAllowedMentions } from '../utils/permissions';
import type { Command } from '../bot/client';

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

      const aiService = getAIService();
      const response = await aiService.createChatCompletion({
        messages: [
          {
            role: 'user',
            content: message,
          },
        ],
        enableSearch: enableSearch === null ? undefined : enableSearch,
        images: imageUrls,
        videos: videoUrls,
        userId: interaction.user.id,
        username: interaction.user.username,
        guildId,
        isNsfwChannel,
        isGifEnabled,
      });

      const { text: textWithoutGif, gifUrl } = isGifEnabled
        ? await gifService.extractAndResolveGif(response)
        : { text: response, gifUrl: undefined };

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
