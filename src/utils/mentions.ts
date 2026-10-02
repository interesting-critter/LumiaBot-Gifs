/**
 * Defanging Discord mention syntax in untrusted text.
 *
 * Companion to `buildAllowedMentions()` in `./permissions`, and deliberately a
 * *separate* mechanism: `allowedMentions` tells Discord not to parse mentions,
 * while this changes the text so there is nothing to parse. Keeping both means a
 * reply stays inert if one layer is later dropped by accident.
 *
 * WHAT NEEDS IT
 * -------------
 * Anything that reaches a `content` string and did not come from this codebase:
 * a Spotify playlist title (chosen by whoever owns the playlist), a search term
 * a member typed, an LLM completion, an upstream exception message that quotes
 * one of the above. Embed fields do not need it — Discord never renders a ping
 * out of embed content — but `content` does, and it does so by default.
 *
 * The concrete bug this closes: `/music delete` interpolated a playlist name into
 * its confirmation prompt, so a playlist named `@everyone` produced
 * `⚠️ Are you sure you want to delete "@everyone"?` and pinged a whole server.
 */

/** ZERO WIDTH SPACE, U+200B. Invisible, and enough to break the mention syntax. */
const ZWSP = '\u200b';

/**
 * Characters that cannot be part of a mention token.
 *
 * Anything outside this set (letters, digits) means the `@` sits inside a word,
 * which Discord does not parse as a mention and neither do we — mangling
 * `someone@example.com` would corrupt ordinary output for no security gain.
 */
const MENTION_TOKEN_BREAK = new Set([
  ' ', '\t', '\n', '\r', '\f', '\v',
  '(', ')', '[', ']', '{', '}', '<', '>',
  '"', "'", '`', '|', '*', '_', '-', '\\', '/',
  '@', // err towards neutralising: `@@everyone` may or may not parse
]);

/**
 * Break any Discord mention syntax inside `text` without visibly changing it.
 *
 * Handles the three real forms:
 *   - `@everyone` and `@here`, in any casing, at a token boundary.
 *   - `<@123456789012345678>` and `<@!123456789012345678>` — user mentions.
 *   - The `@everyone`/`@here` variants Discord also accepts with a `&` or role
 *     form are not bare-text parseable, so they are left alone.
 *
 * The output is not a valid mention token any more, so it renders as ordinary
 * text: `@everyone` looks like `@everyone`.
 *
 * @example
 * neutralizeMentions('Are you sure you want to delete "@everyone"?');
 * // 'Are you sure you want to delete "@\u200beveryone"?'
 */
export function neutralizeMentions(text: string): string {
  return text
    // `<@123...>` / `<@!123...>`: break the token so it is not a user mention.
    // The whole `<@id>` token is consumed by the pattern, so the whole thing is
    // replaced.
    .replace(/<@!?(\d{15,25})>/g, `<@${ZWSP}!$1`)
    // `@everyone` / `@here`, any casing, only at a token boundary.
    //
    // The pattern matches the `@` ONLY, so the replacement must be the `@` and
    // nothing else — the `everyone` that follows is left in place by `replace`
    // and must not be re-emitted here, or the output reads `@everyoneeveryone`.
    .replace(/@/g, (match: string, offset: number, whole: string) => {
      const before = offset === 0 ? '' : whole.charAt(offset - 1);
      if (before && !MENTION_TOKEN_BREAK.has(before)) return match;

      const isBroadcast = /^(everyone|here)\b/i.test(whole.slice(offset + 1));
      return isBroadcast ? `@${ZWSP}` : match;
    });
}