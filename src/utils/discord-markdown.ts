const MARKDOWN_CHARS = new Set(['*', '_', '~', '`', '|', '>', '[', ']', '(', ')', '#']);
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const FENCE_PATTERN = /^\s*```/;

/**
 * `Intl.Segmenter` is expensive to construct (it builds locale data) and
 * {@link protectKaomojis} runs once per reply, so it is created once here
 * instead of per call.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * A trailing lone high surrogate: the first half of a surrogate pair that was
 * cut in half by a length-based slice. `JSON.stringify` renders it as
 * `"\ud83d"`, which Discord rejects with 400 MALFORMED_CONTENT — so a reply
 * that was generated perfectly fails to send and the user sees "Something went
 * wrong" instead.
 */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

function hasOddBackslashPrefix(text: string, index: number): boolean {
  let count = 0;

  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    count++;
  }

  return count % 2 === 1;
}

function escapeMarkdownSegment(segment: string): string {
  let escaped = '';

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (char && MARKDOWN_CHARS.has(char) && !hasOddBackslashPrefix(segment, i)) {
      escaped += '\\';
    }

    escaped += char;
  }

  return escaped;
}

/**
 * Escape Discord Markdown formatting in unsafe dynamic text, such as usernames.
 * Bare URLs are left intact so Discord can still auto-link them.
 */
export function escapeDiscordMarkdown(text: string): string {
  let escaped = '';
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    const index = match.index ?? 0;

    escaped += escapeMarkdownSegment(text.slice(lastIndex, index));
    escaped += url;
    lastIndex = index + url.length;
  }

  escaped += escapeMarkdownSegment(text.slice(lastIndex));
  return escaped;
}

/**
 * The tag-stripping patterns are built per call instead of being module-level
 * constants, even though they never change.
 *
 * They are `g`-flagged, and a `g` regex object carries a mutable `lastIndex`.
 * `String.replace` happens to reset it, so a shared constant is safe *today* —
 * but the first `.test()` or `.exec()` added later (or a `matchAll` that bails
 * early) would resume from a stale offset and silently match the wrong span on
 * some calls and not others. A fresh literal per call is the same cost
 * (`replace` compiles the pattern anyway) and cannot carry state.
 */
function reactionTagRegex(): RegExp {
  return /[\[［]REACT:\s*[^\]］]+[\]］]/gi;
}

function unhandledGifTagRegex(): RegExp {
  return /<gif\s*>[\s\S]*?<\/gif\s*>|<(?:gif[_-]?query|tenor)\s*>[\s\S]*?<\/(?:gif[_-]?query|tenor)\s*>|\[gif\][\s\S]*?\[\/gif\]/gi;
}

/**
 * Remove [REACT: ...] tags (including full-width bracket variants) from model output.
 */
export function stripReactionTags(text: string): string {
  return text.replace(reactionTagRegex(), '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Strip leftover raw <gif> tags if GIF generation is disabled or extraction failed.
 */
export function stripUnhandledGifTags(text: string): string {
  return text.replace(unhandledGifTagRegex(), '').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeDiscordHeaders(text: string): string {
  const lines = text.split('\n');
  let inFence = false;

  return lines.map((line) => {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    // Discord renders leading # markers as headers. Keep regular markdown,
    // but neutralize headers because they are too visually loud for bot replies.
    return line.replace(/^(\s{0,3})(#{1,6})(?=\s)/, '$1\\$2');
  }).join('\n');
}

/**
 * Replaces spaces inside ±...± with non-breaking spaces and glues characters
 * with word joiners (\u2060) so Discord doesn't split kaomojis across lines.
 */
function protectKaomojis(text: string): string {
  return text.replace(/±(.*?)±/gs, (_, content: string) => {
    const withNbsp = content.replace(/ /g, '\u00A0');
    const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(withNbsp), (s) => s.segment);
    return graphemes.join('\u2060');
  });
}

/** Suffix appended when a reply is cut to fit Discord's 2000-character limit. */
const TRUNCATION_SUFFIX = '... (message truncated)';

/**
 * Cut `text` to at most `maxLength` UTF-16 code units without ever ending on a
 * half of a surrogate pair, then append `suffix` (counted inside the budget).
 *
 * `String.slice` counts code units, so cutting a string that ends in an emoji
 * (`'a'.repeat(1949) + '😀'`) can land between the high and low surrogate. The
 * result is not valid Unicode, `JSON.stringify` emits an escaped lone surrogate,
 * and Discord rejects the whole message with 400 MALFORMED_CONTENT.
 */
function truncateForDiscord(text: string, maxLength: number, suffix: string): string {
  if (maxLength <= suffix.length) {
    // No room for the marker; still must not emit a half surrogate.
    return text.slice(0, maxLength).replace(TRAILING_HIGH_SURROGATE, '');
  }

  let head = text.slice(0, maxLength - suffix.length);
  // A single drop is enough: dropping one code unit turns a valid pair back
  // into a complete pair, and a lone *low* surrogate cannot be left over.
  head = head.replace(TRAILING_HIGH_SURROGATE, '');
  return head + suffix;
}

export function formatDiscordResponseText(text: string, maxLength = 1950): string {
  const cleaned = stripUnhandledGifTags(stripReactionTags(text));
  const protectedText = protectKaomojis(cleaned);
  const formatted = escapeDiscordHeaders(protectedText);

  return formatted.length > maxLength
    ? truncateForDiscord(formatted, maxLength, TRUNCATION_SUFFIX)
    : formatted;
}