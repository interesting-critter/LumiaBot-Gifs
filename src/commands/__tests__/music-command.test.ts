import { describe, expect, test } from 'bun:test';

// `src/commands/music.ts` (and the services it imports) build singletons at
// module load, and `MusicService` opens a real database file. That isolation is
// now guaranteed globally by `bunfig.toml` → `[test] preload` →
// `src/__tests__/setup.ts`, which redirects `DATA_DIR` before any test module is
// evaluated.
//
// The per-file override that used to live here was never a reliable guard on its
// own: `bun test` evaluates every test file in one process, so this assignment
// only won if `src/commands/…` happened to be evaluated before `src/bot/…` and
// `src/services/…` had already loaded `utils/paths.ts`. It is removed because a
// test that looks like it protects the real databases while depending on file
// order is worse than no guard at all. `test-isolation.test.ts` asserts the
// invariant instead.

const { parseLrcLyrics, clampPageIndex, capEmbedDescription } = await import('../music');

describe('parseLrcLyrics', () => {
  test('empty input yields no lines', () => {
    expect(parseLrcLyrics('')).toEqual([]);
    expect(parseLrcLyrics(null)).toEqual([]);
    expect(parseLrcLyrics(undefined)).toEqual([]);
    expect(parseLrcLyrics('   \n\n  \n')).toEqual([]);
  });

  test('single [m:ss] timestamp', () => {
    expect(parseLrcLyrics('[00:12]Hello')).toEqual([{ timeMs: 12_000, text: 'Hello' }]);
  });

  test('fraction widths: none, one, two and three digits', () => {
    expect(parseLrcLyrics('[01:02]a')).toEqual([{ timeMs: 62_000, text: 'a' }]);
    // A single leading digit is legal: [1:02.3]
    expect(parseLrcLyrics('[1:02.3]a')).toEqual([{ timeMs: 62_300, text: 'a' }]);
    // Two digits are hundredths
    expect(parseLrcLyrics('[01:02.34]a')).toEqual([{ timeMs: 62_340, text: 'a' }]);
    // Three digits are milliseconds
    expect(parseLrcLyrics('[01:02.345]a')).toEqual([{ timeMs: 62_345, text: 'a' }]);
  });

  test('hour form [h:mm:ss.xx]', () => {
    expect(parseLrcLyrics('[01:02:03.50]a')).toEqual([{ timeMs: 3_723_500, text: 'a' }]);
  });

  test('multiple timestamps on one line each produce their own entry', () => {
    // The old `replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '')` produced "ChorusChorus"
    // on a single line. A repeated chorus is two events at two times.
    const parsed = parseLrcLyrics('[00:01.00][00:05.00]Chorus');
    expect(parsed).toEqual([
      { timeMs: 1000, text: 'Chorus' },
      { timeMs: 5000, text: 'Chorus' },
    ]);
  });

  test('strips ID tags and honours a positive offset', () => {
    const raw = [
      '[ar:Some Artist]',
      '[ti:Some Title]',
      '[al:Some Album]',
      '[by:nobody]',
      '[offset:+500]',
      '[00:10.00]First',
      '[00:20.00]Second',
    ].join('\n');
    expect(parseLrcLyrics(raw)).toEqual([
      { timeMs: 9_500, text: 'First' },
      { timeMs: 19_500, text: 'Second' },
    ]);
  });

  test('honours a negative offset (lyrics appear later)', () => {
    const raw = ['[offset:-750]', '[00:10.00]First'].join('\n');
    expect(parseLrcLyrics(raw)).toEqual([{ timeMs: 10_750, text: 'First' }]);
  });

  test('sorts unsorted input by time, stably', () => {
    const raw = ['[00:30.00]third', '[00:10.00]first', '[00:20.00]second'].join('\n');
    expect(parseLrcLyrics(raw).map((l) => l.text)).toEqual(['first', 'second', 'third']);
  });

  test('equal timestamps keep source order', () => {
    const raw = ['[00:10.00]a', '[00:10.00]b', '[00:10.00]c'].join('\n');
    expect(parseLrcLyrics(raw).map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  test('a line with no timestamp is kept in plain-text lyrics', () => {
    // Navidrome usually returns untimed lyrics; dropping them would blank the embed.
    expect(parseLrcLyrics('First line\nSecond line')).toEqual([
      { timeMs: 0, text: 'First line' },
      { timeMs: 0, text: 'Second line' },
    ]);
  });

  test('an untimestamped line is dropped once the file has timestamps', () => {
    const raw = ['[Verse 1]', '[00:10.00]First'].join('\n');
    expect(parseLrcLyrics(raw)).toEqual([{ timeMs: 10_000, text: 'First' }]);
  });

  test('a timestamp with no text (instrumental gap) yields nothing', () => {
    expect(parseLrcLyrics('[00:10.00]')).toEqual([]);
  });

  test('handles CRLF line endings', () => {
    expect(parseLrcLyrics('[00:01.00]a\r\n[00:02.00]b')).toEqual([
      { timeMs: 1000, text: 'a' },
      { timeMs: 2000, text: 'b' },
    ]);
  });
});

describe('clampPageIndex', () => {
  test('keeps a valid index', () => {
    expect(clampPageIndex(0, 3)).toBe(0);
    expect(clampPageIndex(2, 3)).toBe(2);
  });

  test('clamps at length - 1', () => {
    expect(clampPageIndex(2, 2)).toBe(1);
    expect(clampPageIndex(1, 1)).toBe(0);
  });

  test('clamps below 0', () => {
    expect(clampPageIndex(-1, 3)).toBe(0);
    expect(clampPageIndex(-50, 3)).toBe(0);
  });

  test('clamps above length - 1 (the double-click crash)', () => {
    expect(clampPageIndex(3, 2)).toBe(1);
    expect(clampPageIndex(99, 5)).toBe(4);
  });

  test('an empty page list cannot produce a negative or NaN index', () => {
    expect(clampPageIndex(5, 0)).toBe(0);
  });

  test('a non-finite index degrades to the first page', () => {
    expect(clampPageIndex(Number.NaN, 3)).toBe(0);
    expect(clampPageIndex(Number.POSITIVE_INFINITY, 3)).toBe(0);
    expect(clampPageIndex(Number.NEGATIVE_INFINITY, 3)).toBe(0);
  });

  test('fractional indices are truncated, not rounded', () => {
    expect(clampPageIndex(1.9, 3)).toBe(1);
  });
});

describe('capEmbedDescription', () => {
  test('leaves short text alone', () => {
    expect(capEmbedDescription('hello', 100)).toBe('hello');
    expect(capEmbedDescription('hello')).toBe('hello');
  });

  test('caps at the limit', () => {
    const capped = capEmbedDescription('x'.repeat(5000));
    expect(capped.length).toBeLessThanOrEqual(4096);
  });

  test('never splits a surrogate pair', () => {
    // Each emoji is two UTF-16 code units; slicing at an arbitrary index can cut
    // one in half and produce a lone surrogate.
    const text = '🎵'.repeat(4000);
    const capped = capEmbedDescription(text);
    expect(capped.length).toBeLessThanOrEqual(4096);
    for (const char of capped) {
      expect(char).not.toBe('\uFFFD');
    }
    // Well-formed: round-trips through UTF-8 without replacement characters.
    expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
  });

  test('never ends on a dangling markdown escape', () => {
    const text = `${'a'.repeat(4090)}\\`;
    const capped = capEmbedDescription(text);
    expect(capped.endsWith('\\…')).toBe(false);
    expect(capped.length).toBeLessThanOrEqual(4096);
  });

  test('closes an unterminated code fence', () => {
    const text = `\`\`\`\n${'a'.repeat(5000)}`;
    const capped = capEmbedDescription(text);
    expect((capped.match(/```/g) || []).length % 2).toBe(0);
  });
});
