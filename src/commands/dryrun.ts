import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { getErrorMessage } from '../services/prompts';
import { config } from '../utils/config';
import { buildAllowedMentions } from '../utils/permissions';
import { emojiLookupContext, resolveEmojiContent } from '../utils/emoji';
import { handleMessage } from '../services/message-handler';
// The same shared helper `/chat` uses (see `src/utils/channel-turns.ts`), so a
// dry run and a real `/chat` in the same channel resolve surrounding context
// identically. A preview that resolved history differently from a real turn would
// be worse than no preview at all.
import { fetchChannelTurns } from '../utils/channel-turns';
import { pageExtractorService } from '../services/page-extractor';
import type { Command } from '../bot/client';

/**
 * Stand-in text used when the operator runs `/dryrun` with no `message`.
 *
 * Deliberately obvious rather than an empty string: the dashboard log's `prompt`
 * column is what the operator reads first, and a blank cell there is
 * indistinguishable from a rendering bug. This string has to survive every
 * downstream stage (the `<current-user>` block, the turn, the dashboard) as an
 * obvious "there was no real input here".
 */
const NO_INPUT_PLACEHOLDER = '[dry run: no message supplied — this text is a placeholder, not real input]';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('dryrun')
    .setDescription('Run the whole message pipeline with no model request, and log the exact prompt (owner only)')
    // Optional, unlike `/chat`: the operator often wants to see what the
    // prompt looks like for a bare turn — empty history, no attachments, nothing
    // but the system prompt and the persona — and being forced to invent text to
    // ask that question defeats the purpose.
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Message to run through the pipeline. Omit to dry-run with no text at all')
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName('search')
        .setDescription('Enable web search for better answers')
        .setRequired(false)
    )
    // Attachments are accepted for the same reason `/chat` accepts them: this
    // command exists to answer "what would the prompt have looked like", and
    // whether an attachment is threaded into the payload is part of that
    // answer. They are passed through as URLs only — see the note on the vision
    // call in `handleMessage`.
    .addAttachmentOption((option) =>
      option
        .setName('image')
        .setDescription('Attach an image (included in the prompt as a URL; never analysed)')
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName('video')
        .setDescription('Attach a video (included in the prompt as a URL; never analysed)')
        .setRequired(false)
    ) as SlashCommandBuilder,

  // Authorisation is the dispatcher's, not ours: `bot/client.ts` compares
  // `interaction.user.id` against `config.bot.ownerId` before `execute` is
  // reached. Re-checking here would be a second gate that can only ever agree
  // with the first — and a place for the two to drift apart.
  ownerOnly: true,

  async execute(interaction: ChatInputCommandInteraction) {
    const rawMessage = interaction.options.getString('message');
    const enableSearch = interaction.options.getBoolean('search');
    const imageAttachment = interaction.options.getAttachment('image');
    const videoAttachment = interaction.options.getAttachment('video');

    // A whitespace-only option is treated as "no text supplied": Discord accepts
    // `"   "` as a perfectly valid string, and silently dry-running an empty
    // prompt because of trailing spaces would be a confusing thing to debug.
    const message = rawMessage && rawMessage.trim() !== '' ? rawMessage : NO_INPUT_PLACEHOLDER;
    const usedPlaceholder = message === NO_INPUT_PLACEHOLDER;

    const channel = interaction.channel;
    const isNsfwChannel = channel && 'nsfw' in channel ? Boolean(channel.nsfw) : false;

    const imageUrls: string[] = [];
    if (imageAttachment && imageAttachment.contentType?.startsWith('image/')) {
      imageUrls.push(imageAttachment.url);
      console.log(`🖼️  [DRY RUN] Image attached: ${imageAttachment.name} (${imageAttachment.contentType})`);
    }

    const videoUrls: { url: string; mimeType?: string }[] = [];
    if (videoAttachment && videoAttachment.contentType?.startsWith('video/')) {
      videoUrls.push({
        url: videoAttachment.url,
        mimeType: videoAttachment.contentType,
      });
      console.log(`🎥 [DRY RUN] Video attached: ${videoAttachment.name} (${videoAttachment.contentType})`);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guildId = interaction.guildId || 'dm';
      const channelTurns = await fetchChannelTurns(interaction, 'DRY RUN');

      // Page extraction is kept: it is a fetch, not a model call, and it is one
      // of the stages whose output ends up in the prompt, so excluding it would
      // make the captured payload a lie about what a real turn contains.
      const pageContents = config.pageExtraction.enabled
        ? await pageExtractorService.extractPagesFromMessage(message)
        : [];

      // Routed through `handleMessage` with `dryRun`, not assembled by hand, for
      // the same reason `/chat` goes through it: the whole point is that this is
      // the real pipeline with one step removed. Building a bespoke "preview"
      // here would drift from the code it is supposed to be previewing on the
      // first change to either.
      await handleMessage({
        content: message,
        enableSearch: enableSearch === null ? undefined : enableSearch,
        imageUrls,
        videoUrls,
        pageContents: pageContents.length > 0 ? pageContents : undefined,
        // The REAL user id, so the history entries land in the owner's properly
        // guild-scoped bucket. `handleMessage` files them under the literal
        // "dry run" name itself; passing that in here would also rewrite the
        // `<current-user>` block in the prompt, which is the one thing the
        // operator most wants to see unchanged.
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
        source: 'dry-run',
        channelId: interaction.channelId,
        channelName: channel && 'name' in channel ? channel.name ?? undefined : undefined,
        guildName: interaction.guild?.name,
        dryRun: true,
      });

      // The prompt is in the dashboard log's full-prompt view for this entry
      // (`source: dry-run` filters straight to it). Posting it into the channel
      // would be both enormous — it is several kilobytes — and pointless, since
      // nobody but the operator asked for it.
      //
      // Ephemeral: this is a debugging tool, and a visible "zakyap" in a live
      // channel is noise the channel's occupants did not ask for.
      //
      // The emoji goes through the same resolution the reaction path uses, so a
      // bare name, a bare snowflake, or full `<:…>`/`<a:…>` markup in
      // `DRY_RUN_EMOJI` all work, and an application-owned emoji is emitted in
      // the `<a:…>` form the client actually renders. Interpolating the raw
      // config string here was the bug: it bypassed that lookup entirely and
      // posted unrenderable markup.
      const emoji = resolveEmojiContent(config.dryRun.emoji, emojiLookupContext(interaction.client, interaction.guild));
      if (!emoji.resolved) {
        // Honest failure beats a silent one. An unresolved value means no emoji
        // cache this bot can see holds that emoji, so whatever we posted would
        // render as literal text — which looks identical to the bug this
        // replaced. The offending value is quoted inside an inline-code span,
        // which Discord does not parse as emoji markup, so this reports the
        // problem instead of half-reproducing it.
        console.warn(
          `⚠️ [DRY RUN] Could not resolve DRY_RUN_EMOJI ("${config.dryRun.emoji}") against any emoji cache; reporting that instead of posting unrenderable markup.`
        );
      }
      const replyEmoji = emoji.resolved
        ? emoji.markup
        : `⚠️ *(could not resolve \`DRY_RUN_EMOJI\` = \`${config.dryRun.emoji}\` — no matching app or guild emoji)*`;

      await interaction.editReply({
        content: usedPlaceholder
          ? `${replyEmoji}\n*(no message supplied — ran with the placeholder instead)*`
          : replyEmoji,
        allowedMentions: buildAllowedMentions(),
      });
    } catch (error) {
      console.error('Dry run command error:', error);

      // Same reasoning as `/chat`: a failed `editReply` on an expired token must
      // not be the end of the reporting, and the fallback must not throw either.
      const message_ = getErrorMessage('generic_error');
      try {
        await interaction.editReply({ content: message_, allowedMentions: buildAllowedMentions() });
      } catch (replyError) {
        console.warn('⚠️ [DRY RUN] editReply failed; falling back to a followUp:', replyError);
        try {
          await interaction.followUp({ content: message_, flags: MessageFlags.Ephemeral });
        } catch (followUpError) {
          console.error('❌ [DRY RUN] Could not deliver the error message at all:', followUpError);
        }
      }
    }
  },
};

export default command;
