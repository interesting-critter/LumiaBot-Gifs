import { EmbedBuilder } from 'discord.js';
import { config } from './config';
import { formatDiscordResponseText } from './discord-markdown';

/**
 * Discord's own limit for an embed **description** is 4096 characters. Kept
 * slightly under so the truncation marker added by
 * {@link formatDiscordResponseText} always fits inside the same budget rather
 * than pushing the payload one character over the API's ceiling.
 */
export const EMBED_DESCRIPTION_MAX = 4000;

/** Discord's limit for an embed author name. */
const EMBED_AUTHOR_MAX = 256;

/** Discord's limit for embed footer text. */
const EMBED_FOOTER_MAX = 2048;

/**
 * Build the "response card" the bot posts instead of a bare text message.
 *
 * WHY A CARD AT ALL
 * -----------------
 * Replies used to be sent as two messages — the LLM text, then the GIF URL as a
 * bare link in its own message — purely so the GIF rendered without exposing the
 * link. Discord renders a GIF posted as a bare message content, but renders a GIF
 * URL placed in `embeds[0].image.url` inside a card, which is what this builds:
 * the link is never printed, the text is not fragmented across messages, and the
 * whole turn reads as one unit.
 *
 * WHAT IS TRUSTED HERE
 * --------------------
 * `text` is model output and `gifUrl` is scraped from Tenor, so neither is
 * sanitised for mentions here — they are **embed** fields, which Discord never
 * resolves mentions in (unlike `content`), so there is nothing to escape. The
 * caller still has to pass `buildAllowedMentions()` for the `content` it sends
 * alongside, and this module never sets `content` itself.
 */
export interface ResponseCardOptions {
  /** The LLM reply body. May be empty when the turn is GIF-only. */
  text: string;
  /** Resolved GIF to use as the card's banner image, if any. */
  gifUrl?: string;
  /** Overrides the configured author line (used by tests and the orchestrator). */
  authorName?: string;
  /** Overrides the configured accent colour. */
  color?: number;
}

/**
 * The rendered author line, e.g. `⋆˖⁺‧₊☽Bad Kitty☾₊‧⁺˖⋆`.
 *
 * The `{botName}` placeholder is resolved here rather than baked into config so
 * a template can be edited in `.env` without losing the bot's display name.
 * A template with no placeholder is used verbatim, which is how an operator
 * pins the card to a name the bot does not otherwise use.
 */
function renderAuthorTemplate(template: string, botName: string): string {
  return template.includes('{botName}')
    ? template.replace(/\{botName\}/g, botName)
    : template;
}

/**
 * Clip to Discord's per-field ceilings without ever splitting a surrogate pair.
 *
 * Same failure mode as {@link formatDiscordResponseText}'s truncation: slicing
 * an author name or footer between the high and low half of an emoji produces
 * invalid UTF-16 that Discord rejects with 400 MALFORMED_CONTENT, losing the
 * whole card.
 */
function clip(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let head = text.slice(0, maxLength - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/**
 * Render one turn as a single embed: accent sidebar, author block, the reply as
 * the description, the GIF as the banner image, and a footer flourish.
 *
 * Returns `null` when there is nothing to show (no text and no GIF) so callers
 * can skip the send instead of posting an empty card — Discord renders such an
 * embed as a bare coloured bar with no body.
 */
export function buildResponseCard(options: ResponseCardOptions): EmbedBuilder | null {
  const { text, gifUrl, authorName, color } = options;

  const description = formatDiscordResponseText(text, EMBED_DESCRIPTION_MAX);
  if (!description && !gifUrl) return null;

  const embed = new EmbedBuilder()
    .setColor(color ?? config.bot.embed.color)
    .setAuthor({
      name: clip(
        authorName ?? renderAuthorTemplate(config.bot.embed.authorTemplate, config.bot.name),
        EMBED_AUTHOR_MAX,
      ),
    })
    .setFooter({ text: clip(config.bot.embed.footer, EMBED_FOOTER_MAX) });

  // A GIF-only turn leaves the description unset: an empty description is not
  // the same as an absent one to Discord, and it renders a blank gap above the
  // image.
  if (description) embed.setDescription(description);
  if (gifUrl) embed.setImage(gifUrl);

  return embed;
}