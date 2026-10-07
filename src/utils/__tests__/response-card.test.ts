import { describe, expect, test } from 'bun:test';
import { buildResponseCard, EMBED_DESCRIPTION_MAX } from '../response-card';
import { config } from '../config';

/**
 * The card replaces two messages (text, then a bare GIF link) with one embed.
 * These tests pin the parts Discord actually rejects or renders wrongly, rather
 * than snapshotting the whole object.
 */
describe('buildResponseCard', () => {
  test('renders text as the description and the GIF as the banner image', () => {
    const embed = buildResponseCard({ text: 'hello there', gifUrl: 'https://tenor.com/a.gif' });
    const data = embed!.toJSON();

    expect(data.description).toBe('hello there');
    expect(data.image?.url).toBe('https://tenor.com/a.gif');
  });

  test('uses the configured accent colour as the sidebar', () => {
    const embed = buildResponseCard({ text: 'x', color: 0x00ff00 });
    expect(embed!.toJSON().color).toBe(0x00ff00);

    const fallback = buildResponseCard({ text: 'x' });
    expect(fallback!.toJSON().color).toBe(config.bot.embed.color);
  });

  test('substitutes {botName} into the author line and always sets a footer', () => {
    const data = buildResponseCard({ text: 'x' })!.toJSON();

    expect(data.author?.name).toContain(config.bot.name);
    expect(data.author?.name).not.toContain('{botName}');
    expect(data.footer?.text).toBe(config.bot.embed.footer);
  });

  test('uses an explicit author override verbatim', () => {
    const data = buildResponseCard({ text: 'x', authorName: 'Someone Else' })!.toJSON();
    expect(data.author?.name).toBe('Someone Else');
  });

  test('omits the description for a GIF-only turn rather than sending it blank', () => {
    const data = buildResponseCard({ text: '   ', gifUrl: 'https://tenor.com/a.gif' })!.toJSON();

    expect(data.description).toBeUndefined();
    expect(data.image?.url).toBe('https://tenor.com/a.gif');
  });

  test('returns null when there is nothing to show, so the caller skips the send', () => {
    expect(buildResponseCard({ text: '' })).toBeNull();
    expect(buildResponseCard({ text: '   \n  ' })).toBeNull();
  });

  test('strips leftover GIF and reaction tags from the description', () => {
    const data = buildResponseCard({
      text: 'answer [REACT: 😺]',
      gifUrl: 'https://tenor.com/a.gif',
    })!.toJSON();

    expect(data.description).toBe('answer');
  });

  test('truncates an over-long description to Discord embed limits', () => {
    const data = buildResponseCard({ text: 'a'.repeat(EMBED_DESCRIPTION_MAX + 500) })!.toJSON();

    expect(data.description!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
    expect(data.description).toContain('truncated');
  });

  test('never ends the description on half a surrogate pair', () => {
    // A long run of a repeated emoji: a naive slice lands between the halves of
    // one pair, and Discord rejects the whole payload with 400 MALFORMED_CONTENT.
    const data = buildResponseCard({ text: '😀'.repeat(4000) })!.toJSON();

    expect(/[\uD800-\uDBFF]$/.test(data.description!)).toBe(false);
    expect(data.description!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
  });
});