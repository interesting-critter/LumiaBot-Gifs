import { describe, expect, test } from 'bun:test';

import { neutralizeMentions } from '../mentions';

/**
 * `neutralizeMentions` is the string-level half of the mention hardening; the
 * other half is `allowedMentions: buildAllowedMentions()`, which tells Discord
 * not to parse mentions at all.
 *
 * The bug it exists for is concrete: `/music delete` interpolated a Spotify
 * playlist title — chosen by whoever owns the playlist — into the `content` of
 * its confirmation prompt, so a playlist named `@everyone` produced
 *
 *     ⚠️ Are you sure you want to delete "@everyone"?
 *
 * and pinged the whole server. `/music list` is not owner-gated, so any member
 * could reach it.
 *
 * These are pure string tests: no Discord, no network.
 */

const ZWSP = '\u200b';

/** Discord's own mention syntax, for asserting "this is not a mention any more". */
function isLiveMention(text: string): boolean {
  return /(^|[^\w@])@(everyone|here)\b/i.test(text) || /<@!?\d{15,25}>/.test(text);
}

describe('neutralizeMentions — the /music delete exploit', () => {
  test('a playlist named "@everyone" no longer parses as a mention', () => {
    const playlistName = '@everyone';
    const content = `⚠️ Are you sure you want to delete "${neutralizeMentions(playlistName)}"?`;

    expect(content).toContain(`@${ZWSP}everyone`);
    expect(isLiveMention(content)).toBe(false);
  });

  test('the neutralised text still reads as the original to a human', () => {
    // Only a zero-width space was inserted, so stripping it must give back the
    // operator's playlist name exactly.
    const neutralised = neutralizeMentions('@everyone');
    expect(neutralised.replace(new RegExp(ZWSP, 'g'), '')).toBe('@everyone');
  });

  test('a realistic playlist name keeps its innocent characters intact', () => {
    expect(neutralizeMentions('Chill Vibes 🎧')).toBe('Chill Vibes 🎧');
    expect(neutralizeMentions('lo-fi @ 2am')).toBe('lo-fi @ 2am');
  });

  test('the word after a defused @ is not duplicated or truncated', () => {
    // A replacement that re-emits the matched word produces "@everyoneeveryone";
    // one that drops it produces "@". Both are wrong, and both are easy to write.
    expect(neutralizeMentions('@everyone')).toBe(`@${ZWSP}everyone`);
    expect(neutralizeMentions('@here')).toBe(`@${ZWSP}here`);
    expect(neutralizeMentions('a @everyone b')).toBe(`a @${ZWSP}everyone b`);
  });
});

describe('neutralizeMentions — broadcast tokens', () => {
  test('@everyone and @here are defanged', () => {
    expect(isLiveMention(neutralizeMentions('@everyone'))).toBe(false);
    expect(isLiveMention(neutralizeMentions('@here'))).toBe(false);
  });

  test('casing variants are defanged (Discord parses them too)', () => {
    for (const variant of ['@EVERYONE', '@EveryOne', '@eVeRyOnE', '@HERE', '@Here']) {
      expect(isLiveMention(neutralizeMentions(variant))).toBe(false);
    }
  });

  test('a broadcast ping buried in a sentence is defanged', () => {
    const out = neutralizeMentions('hey @everyone please listen to this');
    expect(isLiveMention(out)).toBe(false);
    expect(out).toContain('hey');
    expect(out).toContain('please listen to this');
  });

  test('every occurrence is defanged, not just the first', () => {
    const out = neutralizeMentions('@everyone @here @everyone');
    expect(isLiveMention(out)).toBe(false);
    expect(out.split(`@${ZWSP}`).length - 1).toBe(3);
  });

  test('a mention at the very start of the string is caught', () => {
    // Offset 0: there is no preceding character to test, which is the easy case
    // to get wrong with a lookbehind that requires one.
    expect(isLiveMention(neutralizeMentions('@everyone stop'))).toBe(false);
  });

  test('punctuation and bracket boundaries are handled', () => {
    for (const text of ['(@everyone)', '[@here]', '{"@everyone":1}', '-@everyone-', '"@here"']) {
      expect(isLiveMention(neutralizeMentions(text))).toBe(false);
    }
  });
});

describe('neutralizeMentions — user mentions', () => {
  test('a snowflake mention is defanged', () => {
    const out = neutralizeMentions('<@123456789012345678>');
    expect(isLiveMention(out)).toBe(false);
    // The digits must survive: it is still a readable reference, just inert.
    expect(out).toContain('123456789012345678');
  });

  test('the nickname form <@!id> is defanged', () => {
    const out = neutralizeMentions('<@!123456789012345678>');
    expect(isLiveMention(out)).toBe(false);
    expect(out).toContain('123456789012345678');
  });

  test('several mentions in one string are all defanged', () => {
    const out = neutralizeMentions('<@111111111111111111> and <@222222222222222222>');
    expect(isLiveMention(out)).toBe(false);
  });
});

describe('neutralizeMentions — what it must NOT touch', () => {
  test('an email address is left alone', () => {
    // Mangling this would corrupt ordinary output for no security gain: Discord
    // does not parse `someone@example.com` as a mention.
    expect(neutralizeMentions('someone@example.com')).toBe('someone@example.com');
    expect(neutralizeMentions('mail me at a.b+tag@sub.domain.co.uk')).toBe('mail me at a.b+tag@sub.domain.co.uk');
  });

  test('an @midword is left alone', () => {
    expect(neutralizeMentions('user@host')).toBe('user@host');
    expect(neutralizeMentions('C@de')).toBe('C@de');
  });

  test('a bare @ is left alone', () => {
    expect(neutralizeMentions('@')).toBe('@');
    expect(neutralizeMentions('what @ me')).toBe('what @ me');
  });

  test('an unknown handle is left alone', () => {
    // Discord has no text mention for a bare display name; only <@id> pings.
    expect(neutralizeMentions('@someone')).toBe('@someone');
  });

  test('ordinary text is returned unchanged, including newlines and emoji', () => {
    const text = 'Chill Vibes 🎧\nsecond line\t— "quoted" \'text\' <angle> [bracket]';
    expect(neutralizeMentions(text)).toBe(text);
  });

  test('the empty string does not throw', () => {
    expect(neutralizeMentions('')).toBe('');
  });

  test('is idempotent — double neutralising changes nothing further', () => {
    const once = neutralizeMentions('@everyone <@123456789012345678>');
    expect(neutralizeMentions(once)).toBe(once);
  });

  test('never changes the length except by inserting zero-width spaces', () => {
    // Guards against a future edit that starts truncating or stripping.
    const text = '@everyone and <@123456789012345678> and me@example.com';
    const out = neutralizeMentions(text);
    expect(out.replace(new RegExp(ZWSP, 'g'), '').length).toBeGreaterThanOrEqual(text.length);
    expect(out).toContain('me@example.com');
  });
});