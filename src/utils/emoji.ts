/**
 * The ONE place custom-emoji markup is produced.
 *
 * There are two output forms and they are **not** interchangeable, which is
 * why they are two separate functions rather than one with a flag:
 *
 * - {@link toEmojiReactionForm} → `name:id`. What the **Reactions API**
 *   (`PUT .../reactions/{emoji}/@me`) path-segments on. Brackets and the
 *   leading `a` are not part of it; the API rejects them.
 * - {@link toEmojiContentForm} → `<:name:id>` / `<a:name:id>`. What Discord's
 *   **message content** parser matches. This is the only form that renders
 *   inside a message.
 *
 * Getting these confused produces a message that shows literal `:name:` text,
 * or a reaction call that 404s, with nothing in the logs to explain either.
 *
 * ## Why application-owned emoji always get the `<a:>` form
 *
 * `resolveEmoji` records *where* an emoji was found (`source`), and
 * {@link toEmojiContentForm} uses it:
 *
 * - **application-owned** → always `<a:name:id>`.
 * - **guild/global** → `<a:name:id>` if the emoji is animated, else
 *   `<:name:id>`.
 *
 * For application emoji the `a` flag is forced on even when `animated` is
 * false. Two reasons, both load-bearing:
 *
 * 1. It cannot break anything. The Discord client fetches emoji as WebP
 *    (`Emoji Formats`, Emoji Resource docs: "The Discord client uses WebP for
 *    all emoji displayed in-app"), and it requests the animated variant by
 *    appending `?animated=true` — which Discord serves for *every* emoji,
 *    static ones included. Verified against the live CDN: a known-static
 *    guild emoji (`687755198579343374`) returns HTTP 200 for
 *    `/emojis/<id>.webp?animated=true`. So `<a:>` is always safe.
 * 2. `<:` has actually shipped broken for app emoji. Two bug reports on
 *    `discord/discord-api-docs` — #7024 ("App emojis don't render when using
 *    components with user apps") and #8171 ("Application Emojis fail to render
 *    in Voice Channel Status") — both reproduce with `<:name:id>` markup
 *    against an application emoji id, and Discord staff triaged #8171 as a bug
 *    and shipped a fix. The markup Discord's own Developer Portal shows for an
 *    app emoji is not a reliable guide to what renders.
 *
 * Emitting the static form for an app emoji is therefore strictly worse: at
 * best it renders, at worst it silently degrades to literal text.
 */

import type { Client, Guild } from 'discord.js';

/**
 * The structural slice of a discord.js emoji this module needs.
 *
 * Deliberately not `Emoji`: the resolution logic is worth testing without a
 * gateway connection, so the tests hand in plain objects. Every discord.js
 * emoji (`ApplicationEmoji`, `GuildEmoji`) satisfies this shape.
 */
export interface EmojiLike {
  readonly id: string;
  readonly name: string | null;
  readonly animated?: boolean | null;
}

/**
 * The structural slice of a discord.js `Collection<Snowflake, Emoji>` we use.
 * `.find` is the only method `resolveEmoji` needs.
 */
export interface EmojiCollectionLike {
  find(predicate: (emoji: EmojiLike) => boolean): EmojiLike | undefined;
}

/**
 * Where to look for an emoji, and in what order.
 *
 * The order is part of the contract: an emoji name may exist both as a guild
 * emoji and as one of this application's own, and the application's own wins.
 * Application emoji are also the only ones usable outside the guild that owns
 * the id, so preferring them keeps a configured name rendering in DM.
 */
export interface EmojiLookupContext {
  /** `client.application?.emojis.cache` — emoji owned by this bot. */
  readonly applicationEmojis?: EmojiCollectionLike | null;
  /** `guild.emojis.cache` — emoji owned by the guild the event came from. */
  readonly guildEmojis?: EmojiCollectionLike | null;
  /** `client.emojis.cache` — emoji from every guild the bot can see. */
  readonly globalEmojis?: EmojiCollectionLike | null;
}

/** Which cache an emoji was found in. Drives the content-markup rules. */
export type EmojiSource = 'application' | 'guild' | 'global';

export interface ResolvedCustomEmoji {
  readonly kind: 'custom';
  readonly name: string;
  readonly id: string;
  /**
   * `null` when the input already carried full `<:name:id>` / `<a:name:id>`
   * markup but no cache holds that id. Callers must fall back to the input's
   * own flag rather than guessing.
   */
  readonly animated: boolean | null;
  readonly source: EmojiSource | null;
}

/** Not a custom emoji: a unicode emoji, or a string that resolved to nothing. */
export interface ResolvedLiteral {
  readonly kind: 'literal';
  readonly value: string;
}

export type EmojiResolution = ResolvedCustomEmoji | ResolvedLiteral;

/**
 * Full custom-emoji markup, e.g. `<a:zak_yap:1552379447246852146>`.
 *
 * `@discordjs/formatters.formatEmoji` builds the same shape, but it takes
 * `{ animated, id, name }` and knows nothing about ownership, so it cannot
 * express the application-owned rule above. Hand-rolling it here keeps one
 * implementation for both output forms.
 */
const CUSTOM_MARKUP = /^<a?:(\w+):(\d+)>$/;

function findEmoji(
  cache: EmojiCollectionLike | null | undefined,
  cleanName: string,
  raw: string,
): EmojiLike | undefined {
  if (!cache) return undefined;
  return cache.find((e) => e.name?.toLowerCase() === cleanName || e.id === raw);
}

/**
 * Resolve a raw emoji string to a structured result.
 *
 * Accepts every form an operator or a config file might reasonably contain:
 * a bare name (`zak_yap`), a `:wrapped:` name (`:zak_yap:`), a bare snowflake
 * (`1552379447246852146`), or full markup (`<:zak_yap:1552379447246852146>` /
 * `<a:zak_yap:1552379447246852146>`). Unicode emoji pass through untouched.
 *
 * Never throws: an unrecognised string comes back as `kind: 'literal'` with
 * the trimmed input as its value, which is what the reaction path has always
 * done for `🔥` and what keeps a typo in an env var from taking down a
 * command.
 */
export function resolveEmoji(input: string, context: EmojiLookupContext): EmojiResolution {
  const raw = input.trim();

  // 1. Full `<:name:id>` / `<a:name:id>` markup. The name and id are taken as
  //    authoritative even if no cache holds them, because that is what the
  //    caller wrote and the reaction path has always honoured it verbatim.
  const customMatch = raw.match(CUSTOM_MARKUP);
  if (customMatch) {
    const name = customMatch[1]!;
    const id = customMatch[2]!;
    const inputSaysAnimated = raw.startsWith('<a:');

    // Still look the id up: it is the only way to learn whether this is an
    // application emoji, which decides the content markup. A miss just leaves
    // `animated` to the input's own flag.
    const cached =
      findEmoji(context.applicationEmojis, name.toLowerCase(), id) ??
      findEmoji(context.guildEmojis, name.toLowerCase(), id) ??
      findEmoji(context.globalEmojis, name.toLowerCase(), id);

    return {
      kind: 'custom',
      name,
      id,
      animated: cached ? Boolean(cached.animated) : inputSaysAnimated,
      source: sourceOf(cached, context),
    };
  }

  // 2. Strip surrounding colons (`:my_emoji:` -> `my_emoji`) and lowercase for
  //    the name comparison. Emoji names are case-insensitive in markup.
  const cleanName = raw.replace(/^:|:$/g, '').toLowerCase();

  // 3. Application emoji, then the event's guild, then every guild.
  const cached =
    findEmoji(context.applicationEmojis, cleanName, raw) ??
    (context.guildEmojis ? findEmoji(context.guildEmojis, cleanName, raw) : undefined) ??
    findEmoji(context.globalEmojis, cleanName, raw);

  if (cached) {
    return {
      kind: 'custom',
      name: cached.name ?? cleanName,
      id: cached.id,
      animated: Boolean(cached.animated),
      source: sourceOf(cached, context),
    };
  }

  // 4. Fallback: unicode emoji (`🔥`), a typo, or a name whose cache has not
  //    been populated yet.
  return { kind: 'literal', value: raw };
}

function sourceOf(cached: EmojiLike | undefined, context: EmojiLookupContext): EmojiSource | null {
  if (!cached) return null;
  if (context.applicationEmojis?.find((e) => e.id === cached.id)) return 'application';
  if (context.guildEmojis?.find((e) => e.id === cached.id)) return 'guild';
  if (context.globalEmojis?.find((e) => e.id === cached.id)) return 'global';
  return null;
}

/**
 * Build the lookup context from a live client and optional guild.
 *
 * Callers inside a command already hold both (`interaction.client`,
 * `interaction.guild`); this exists so nobody has to remember which three
 * caches are in play and in what order.
 */
export function emojiLookupContext(
  client: Pick<Client, 'application' | 'emojis'>,
  guild?: Pick<Guild, 'emojis'> | null,
): EmojiLookupContext {
  return {
    applicationEmojis: client.application?.emojis.cache,
    guildEmojis: guild?.emojis.cache,
    globalEmojis: client.emojis.cache,
  };
}

/**
 * The Reactions API form: `name:id`, or the input untouched.
 *
 * This is the exact output the reaction path produced before the resolution
 * logic moved here, and the regression tests pin it. Note that it carries no
 * `animated` information at all — the API does not want any — which is exactly
 * why it cannot be reused for message content.
 */
export function toEmojiReactionForm(resolution: EmojiResolution): string {
  if (resolution.kind === 'literal') return resolution.value;
  return `${resolution.name}:${resolution.id}`;
}

/**
 * The message-content form: `<:name:id>` / `<a:name:id>`, or the input
 * untouched (so a unicode emoji is passed through as-is).
 *
 * See the module comment for why application-owned emoji are forced to the
 * animated form. Guild and global emoji follow their real `animated` flag,
 * because getting that wrong there *is* a visible difference: a static guild
 * emoji written as `<a:…>` is still fine (see the CDN note above), but an
 * animated guild emoji written as `<:…>` is the original bug this whole
 * change exists to fix.
 */
export function toEmojiContentForm(resolution: EmojiResolution): string {
  if (resolution.kind === 'literal') return resolution.value;
  const animated = resolution.source === 'application' ? true : resolution.animated === true;
  return `<${animated ? 'a' : ''}:${resolution.name}:${resolution.id}>`;
}

/**
 * Does this pass-through value render on its own, without any lookup?
 *
 * A unicode emoji (`🔥`) needs no cache entry — the client has it built in —
 * so it is a perfectly good answer and must never be reported as a failure.
 * A bare ASCII word that matched no emoji (`totally_made_up`) does not render,
 * and reporting it as broken markup is the whole point of the check.
 *
 * Emoji names are ASCII letters, digits and underscores by Discord's own rule
 * (support.discord.com: "Emoji names must be at least 2 characters long and can
 * only contain alphanumeric characters and underscores"), so "contains a
 * non-ASCII code point" separates the two cases cleanly.
 */
export function rendersWithoutLookup(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

/**
 * Resolve and render in one call, for callers that only want the content form.
 * `/dryrun` uses this.
 *
 * `resolved` answers "will this actually render?", which is deliberately not
 * the same question as "did a cache entry match?". Three cases count as
 * resolved:
 *
 * 1. a custom emoji found in one of the three caches — we know its name, id,
 *    `animated` flag and owner, so the markup is right;
 * 2. a unicode emoji, which the client has built in and needs no lookup;
 * 3. nothing else.
 *
 * Full `<:name:id>` markup that matches **no** cache is case 3, and this is the
 * important one. `resolveEmoji` still returns it faithfully — the reaction path
 * has always honoured caller-supplied markup verbatim, and changing that would
 * change working behaviour — but "we could not find this id anywhere" means we
 * do not know whether it renders. Posting it anyway is the exact failure this
 * whole change exists to eliminate, so the caller is told to report instead.
 */
export function resolveEmojiContent(
  input: string,
  context: EmojiLookupContext,
): { readonly markup: string; readonly resolved: boolean } {
  const resolution = resolveEmoji(input, context);
  return {
    markup: toEmojiContentForm(resolution),
    resolved:
      (resolution.kind === 'custom' && resolution.source !== null) ||
      (resolution.kind === 'literal' && rendersWithoutLookup(resolution.value)),
  };
}