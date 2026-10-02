import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mediaAllowedHosts, parseMediaAllowedHosts, resetMediaAllowlistWarnings } from '../media-allowlist';
import { assertPublicUrl } from '../safe-fetch';

/**
 * `media-allowlist.ts` exists because closing the SSRF hole by pinning Discord's
 * CDN alone was a functional regression: a Tenor or Giphy `gifv` embed points
 * `video.url` at `media.tenor.com` / `media.giphy.com`, not at a Discord host, so
 * those embeds stopped being understood by the bot at all.
 *
 * The fix has to be an *operator-configurable* list, which means the thing under
 * test is a trust boundary, not a convenience. The two failure modes that
 * matter and are asserted below:
 *
 *   1. The list must not become a way to fetch anything at all — a malformed
 *      operator value (a scheme, a port, a path) has to be dropped, not treated
 *      as a prefix.
 *   2. It must not become a second, weaker matcher. Everything goes through
 *      `assertPublicUrl`, so the wildcard/dot-boundary/private-suffix rules are
 *      still the ones in `safe-fetch.ts`. That is asserted by feeding entries
 *      straight to `assertPublicUrl` and checking a host that *looks* related
 *      still fails.
 */

const ENV_KEY = 'DISCORD_MEDIA_ALLOWED_HOSTS';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  resetMediaAllowlistWarnings();
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
  resetMediaAllowlistWarnings();
});

describe('mediaAllowedHosts — defaults', () => {
  test('unset falls back to the Discord CDN wildcards', () => {
    expect(mediaAllowedHosts()).toEqual(['*.discordapp.com', '*.discordapp.net']);
  });

  test('blank and whitespace-only are treated as unset, not as an empty list', () => {
    // An empty list would fail *closed* against everything and silently drop
    // every attachment, so blank must mean "use the defaults", not "allow
    // nothing".
    process.env[ENV_KEY] = '   ';
    expect(mediaAllowedHosts()).toEqual(['*.discordapp.com', '*.discordapp.net']);
  });
});

describe('parseMediaAllowedHosts — operator input', () => {
  test('accepts hosts and wildcards, trims, lowercases and de-duplicates', () => {
    expect(parseMediaAllowedHosts(' Media.Tenor.com , *.giphy.com ,media.tenor.com')).toEqual([
      'media.tenor.com',
      '*.giphy.com',
    ]);
  });

  test('drops empty entries produced by stray commas', () => {
    expect(parseMediaAllowedHosts(',,media.tenor.com,,')).toEqual(['media.tenor.com']);
  });

  test.each([
    ['https://media.tenor.com', 'a scheme'],
    ['media.tenor.com:443', 'a port'],
    ['media.tenor.com/path', 'a path'],
    ['*.', 'a wildcard with no base'],
    ['*', 'a bare star'],
    ['*.*.tenor.com', 'an inner wildcard'],
    ['-media.tenor.com', 'a leading hyphen'],
    ['media..tenor.com', 'an empty label'],
  ])('rejects %s (%s)', (entry) => {
    expect(parseMediaAllowedHosts(entry)).toEqual([]);
  });

  test('reports each unusable entry so the operator finds out', () => {
    const dropped: string[] = [];
    parseMediaAllowedHosts('media.tenor.com,https://evil.test', (entry) => dropped.push(entry));
    expect(dropped).toEqual(['https://evil.test']);
  });
});

describe('mediaAllowedHosts — still routed through safe-fetch matching', () => {
  test('an extended list permits a non-Discord embed host', async () => {
    process.env[ENV_KEY] = '*.discordapp.com,*.discordapp.net,media.tenor.com';

    await expect(
      assertPublicUrl('https://media.tenor.com/view/abc/AAA/video.mp4', { allowHosts: mediaAllowedHosts() }),
    ).resolves.toBeDefined();
  });

  test('the same host is refused by default — that is the regression being fixed', async () => {
    await expect(
      assertPublicUrl('https://media.tenor.com/view/abc/AAA/video.mp4', { allowHosts: mediaAllowedHosts() }),
    ).rejects.toThrow(/allowlist/i);
  });

  test('extending the list does not extend it to look-alikes', async () => {
    process.env[ENV_KEY] = '*.discordapp.com,*.discordapp.net,media.tenor.com';

    for (const url of [
      'https://media.tenor.com.evil.test/x',
      'https://notmedia.tenor.com/x',
      'https://tenor.com/x',
    ]) {
      await expect(assertPublicUrl(url, { allowHosts: mediaAllowedHosts() })).rejects.toThrow(/allowlist/i);
    }
  });

  test('a configured host still cannot use a non-http scheme or embed credentials', async () => {
    process.env[ENV_KEY] = '*.discordapp.com,*.discordapp.net,media.tenor.com';

    await expect(
      assertPublicUrl('file://media.tenor.com/etc/passwd', { allowHosts: mediaAllowedHosts() }),
    ).rejects.toThrow(/scheme/i);
    await expect(
      assertPublicUrl('https://user:pass@media.tenor.com/x', { allowHosts: mediaAllowedHosts() }),
    ).rejects.toThrow(/credential/i);
  });

  test('a configured host still cannot carry a split-horizon suffix', async () => {
    // `hostMatches` is bypassed for a pinned host, but the private-suffix rule
    // is applied before that. Asserted so "the operator vouched for it" can
    // never quietly become "the operator vouched for anything".
    process.env[ENV_KEY] = '*.discordapp.com,*.discordapp.net,metadata.internal';

    await expect(
      assertPublicUrl('http://metadata.internal/latest/meta-data/', { allowHosts: mediaAllowedHosts() }),
    ).rejects.toThrow(/private hostname/i);
  });

  test('setting the variable replaces the defaults rather than adding to them', async () => {
    // Documented behaviour, and the footgun worth pinning: an operator who
    // writes only `media.tenor.com` stops getting Discord attachments.
    process.env[ENV_KEY] = 'media.tenor.com';
    expect(mediaAllowedHosts()).toEqual(['media.tenor.com']);

    await expect(
      assertPublicUrl('https://cdn.discordapp.com/attachments/1/2/a.png', { allowHosts: mediaAllowedHosts() }),
    ).rejects.toThrow(/allowlist/i);
  });
});