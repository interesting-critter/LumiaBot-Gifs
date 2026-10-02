import { describe, expect, test } from 'bun:test';
import {
  escapeDiscordMarkdown,
  formatDiscordResponseText,
  stripReactionTags,
  stripUnhandledGifTags,
} from '../discord-markdown';

/**
 * The regression these tests pin down: truncation used to be
 *
 *     `${formatted.slice(0, maxLength)}... (message truncated)`
 *
 * `slice` counts UTF-16 code units, so a boundary that lands between the two
 * halves of an emoji leaves a lone surrogate in the string. Discord's API
 * rejects that with 400 MALFORMED_CONTENT, so `message.reply` throws and a
 * reply that generated perfectly surfaces to the user as "Something went
 * wrong".
 *
 * `encodeURIComponent` throws `URIError` on exactly the same condition Discord
 * rejects, which makes it a good assertion without re-implementing the check.
 */
function assertWellFormed(value: string): void {
  expect(() => encodeURIComponent(value)).not.toThrow();
  // Belt and braces: no unpaired surrogate of either half.
  expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(value).not.toMatch(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
}

const SUFFIX = '... (message truncated)';
const DEFAULT_MAX = 1950;

describe('formatDiscordResponseText truncation', () => {
  test('leaves text at or under the limit untouched', () => {
    const short = 'a'.repeat(DEFAULT_MAX);
    expect(formatDiscordResponseText(short)).toBe(short);
    assertWellFormed(short);
  });

  test('never exceeds the limit, with or without truncation', () => {
    for (const body of [
      'a'.repeat(DEFAULT_MAX),
      'a'.repeat(DEFAULT_MAX + 1),
      'a'.repeat(DEFAULT_MAX * 3),
    ]) {
      const result = formatDiscordResponseText(body);
      expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
      assertWellFormed(result);
    }
  });

  test('drops the whole emoji when the boundary splits a surrogate pair', () => {
    // budget = 1950 - SUFFIX.length = 1928 code units of head.
    // 1927 'a' + the emoji's high surrogate lands exactly on the cut.
    const body = `${'a'.repeat(1927)}😀${'b'.repeat(200)}`;

    // Sanity check that the raw slice really would break the pair.
    const naive = body.slice(0, 1928);
    expect(() => encodeURIComponent(naive)).toThrow(URIError);

    const result = formatDiscordResponseText(body);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
    expect(result.endsWith(SUFFIX)).toBe(true);
    assertWellFormed(result);
    // The emoji is either fully present or fully gone — never half.
    expect(result.includes('😀')).toBe(false);
  });

  test('keeps an emoji that fits entirely inside the limit', () => {
    const body = `${'a'.repeat(1000)}😀${'b'.repeat(2000)}`;
    const result = formatDiscordResponseText(body);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
    expect(result).toContain('😀');
    assertWellFormed(result);
  });

  test('truncation never splits a run of emoji', () => {
    const body = '😀'.repeat(2000);
    const result = formatDiscordResponseText(body);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
    assertWellFormed(result);
    // The run was cut on an emoji boundary: the head is a whole number of
    // complete emoji, not an odd number of code units.
    const head = result.slice(0, result.length - SUFFIX.length);
    expect(head.length % 2).toBe(0);
    expect(head).toBe('😀'.repeat(head.length / 2));
  });

  test('handles a flag emoji (ZWJ sequence) and other astral characters', () => {
    const body = `${'x'.repeat(1920)}🏳️‍🌈${'y'.repeat(100)}`;
    const result = formatDiscordResponseText(body);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
    assertWellFormed(result);
  });

  test('counts the truncation suffix inside the limit', () => {
    const result = formatDiscordResponseText('a'.repeat(DEFAULT_MAX + 500));
    expect(result.length).toBe(SUFFIX.length + (DEFAULT_MAX - SUFFIX.length));
    expect(result.length).toBe(DEFAULT_MAX);
    expect(result.endsWith(SUFFIX)).toBe(true);
  });

  test('CJK is measured in code units and stays within the limit', () => {
    // Each CJK ideograph is one UTF-16 code unit, so the cut is clean here —
    // the point is that the result still honours the budget and stays valid.
    const body = 'あ'.repeat(4000);
    const result = formatDiscordResponseText(body);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
    expect(result.endsWith(SUFFIX)).toBe(true);
    assertWellFormed(result);
  });

  test('CJK followed by an emoji still cannot leave a lone surrogate', () => {
    const body = 'あ'.repeat(1927) + '😀' + 'い'.repeat(500);
    const result = formatDiscordResponseText(body);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
    assertWellFormed(result);
  });

  test('a limit smaller than the suffix still truncates safely', () => {
    const body = 'a'.repeat(100);
    const result = formatDiscordResponseText(body, 10);
    expect(result.length).toBe(10);
    expect(result).not.toContain(SUFFIX);
    assertWellFormed(result);
  });

  test('a tiny limit landing inside an emoji is still well formed', () => {
    const result = formatDiscordResponseText(`${'a'.repeat(5)}😀${'b'.repeat(50)}`, 6);
    expect(result.length).toBeLessThanOrEqual(6);
    assertWellFormed(result);
  });

  test('an emoji exactly on the boundary of a small limit is kept whole or dropped', () => {
    // maxLength 5 is below the 22-char suffix, so the head is the whole budget.
    const result = formatDiscordResponseText('aaaa😀bbbb', 5);
    expect(result.length).toBeLessThanOrEqual(5);
    assertWellFormed(result);
  });
});

describe('tag stripping', () => {
  test('strips reaction tags and collapses blank runs', () => {
    expect(stripReactionTags('hi [REACT: 😺] there\n\n\n\nbye')).toBe('hi  there\n\nbye');
  });

  test('strips full-width reaction tags', () => {
    expect(stripReactionTags('hi ［REACT: 😺］ there')).toBe('hi  there');
  });

  test('repeated calls are independent (no carried regex state)', () => {
    // The patterns are `g`-flagged. A shared module-level object would keep a
    // stale `lastIndex` if anything ever moved from `replace` to `test`/`exec`.
    for (let i = 0; i < 5; i++) {
      expect(stripReactionTags('a [REACT: 😺] b [REACT: 😸] c')).toBe('a  b  c');
      expect(stripReactionTags('no tags here')).toBe('no tags here');
    }
  });

  test('strips leftover gif tags in every accepted dialect', () => {
    expect(stripUnhandledGifTags('x <gif>query</gif> y')).toBe('x  y');
    expect(stripUnhandledGifTags('x <gif_query>q</gif_query> y')).toBe('x  y');
    expect(stripUnhandledGifTags('x [gif]q[/gif] y')).toBe('x  y');
  });

  test('repeated gif-tag calls are independent', () => {
    for (let i = 0; i < 5; i++) {
      expect(stripUnhandledGifTags('a <gif>q</gif> b')).toBe('a  b');
      expect(stripUnhandledGifTags('plain text')).toBe('plain text');
    }
  });

  test('formatting still runs before truncation', () => {
    const result = formatDiscordResponseText(`# Heading\n[REACT: 😺]${'x'.repeat(DEFAULT_MAX)}`);
    expect(result).toContain('\\# Heading');
    expect(result).not.toContain('REACT:');
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX);
  });
});

describe('escapeDiscordMarkdown', () => {
  test('escapes formatting characters but leaves URLs alone', () => {
    expect(escapeDiscordMarkdown('**bold** _it_')).toBe('\\*\\*bold\\*\\* \\_it\\_');
    expect(escapeDiscordMarkdown('see https://example.com/a_b')).toBe('see https://example.com/a_b');
  });

  test('is stable across calls (URL_PATTERN is g-flagged)', () => {
    for (let i = 0; i < 5; i++) {
      expect(escapeDiscordMarkdown('*a* https://x.dev/y *b*')).toBe('\\*a\\* https://x.dev/y \\*b\\*');
    }
  });
});
