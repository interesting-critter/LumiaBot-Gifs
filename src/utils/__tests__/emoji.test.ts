import { describe, expect, test } from 'bun:test';

import {
  rendersWithoutLookup,
  resolveEmoji,
  resolveEmojiContent,
  toEmojiContentForm,
  toEmojiReactionForm,
  type EmojiCollectionLike,
  type EmojiLike,
  type EmojiLookupContext,
} from '../emoji';

/** Stand-in for the `Message['guild']` argument the legacy code took. */
type GuildWrapper = { emojis: { cache: EmojiCollectionLike } };

/**
 * `src/utils/emoji.ts` is the single source of custom-emoji markup for both
 * output forms the bot needs, and they are not interchangeable:
 *
 * - **reaction form** `name:id` — what the Reactions API path-segments on.
 * - **content form** `<:name:id>` / `<a:name:id>` — what Discord's message
 *   content parser matches.
 *
 * The regression this file exists for: `/dryrun` used to interpolate the
 * `DRY_RUN_EMOJI` config string straight into message `content`, bypassing the
 * resolver that makes every other bot-owned emoji work. Application emoji were
 * then written in the static `<:…>` form, which does not reliably render.
 *
 * These are pure string tests over hand-built caches — no Discord, no gateway.
 */

/** A stand-in for a discord.js `Collection<Snowflake, Emoji>`. */
function cache(emojis: readonly EmojiLike[]): EmojiCollectionLike {
  return {
    find: (predicate) => emojis.find(predicate),
  };
}

/** No emoji anywhere — the "typo in an env var" case. */
const EMPTY: EmojiLookupContext = {};

/**
 * The real `zak_yap`, as it exists: an application-owned emoji on this bot.
 *
 * `animated: true` because the Discord CDN serves a 156 KB GIF for this id
 * while a known-static emoji answers `.gif` with HTTP 415.
 */
const ZAK_YAP: EmojiLike = { id: '1552379447246852146', name: 'zak_yap', animated: true };

function appContext(...emojis: readonly EmojiLike[]): EmojiLookupContext {
  return { applicationEmojis: cache(emojis) };
}

describe('reaction form — regression guard on the extracted logic', () => {
  // These cases are the exact behaviour of the private `resolveEmojiReaction`
  // in `src/bot/client.ts` before the extraction. If any of them changes, the
  // refactor has altered a path that was working and must be reverted.

  test('full <:name:id> markup collapses to name:id, animated flag discarded', () => {
    // The reaction path never used `animated`, and the API does not accept it.
    expect(toEmojiReactionForm(resolveEmoji('<:myapp:123>', EMPTY))).toBe('myapp:123');
    expect(toEmojiReactionForm(resolveEmoji('<a:myapp:123>', EMPTY))).toBe('myapp:123');
  });

  test('a bare name resolves through the application emoji cache', () => {
    expect(toEmojiReactionForm(resolveEmoji('zak_yap', appContext(ZAK_YAP)))).toBe(
      'zak_yap:1552379447246852146'
    );
  });

  test('a bare snowflake resolves, and matches case-insensitively by name', () => {
    expect(toEmojiReactionForm(resolveEmoji('1552379447246852146', appContext(ZAK_YAP)))).toBe(
      'zak_yap:1552379447246852146'
    );
    expect(toEmojiReactionForm(resolveEmoji(':ZAK_YAP:', appContext(ZAK_YAP)))).toBe(
      'zak_yap:1552379447246852146'
    );
  });

  test('an unknown input falls back to the trimmed raw string', () => {
    expect(toEmojiReactionForm(resolveEmoji('  🔥  ', EMPTY))).toBe('🔥');
    expect(toEmojiReactionForm(resolveEmoji('not_a_real_emoji', EMPTY))).toBe('not_a_real_emoji');
  });

  test('the application cache is searched before the guild cache', () => {
    // Same name, different ids. Application emoji win because they are the only
    // ones that render outside the guild that owns them.
    const context: EmojiLookupContext = {
      applicationEmojis: cache([{ id: '111', name: 'shared', animated: false }]),
      guildEmojis: cache([{ id: '222', name: 'shared', animated: false }]),
    };
    expect(toEmojiReactionForm(resolveEmoji('shared', context))).toBe('shared:111');
  });

  test('the guild cache is searched before the global cache', () => {
    const context: EmojiLookupContext = {
      guildEmojis: cache([{ id: '333', name: 'solo', animated: false }]),
      globalEmojis: cache([{ id: '444', name: 'solo', animated: false }]),
    };
    expect(toEmojiReactionForm(resolveEmoji('solo', context))).toBe('solo:333');
  });
});

describe('reaction form — differential test against the pre-extraction implementation', () => {
  /**
   * The literal body of the private `resolveEmojiReaction` in
   * `src/bot/client.ts` as it was before this change, transcribed verbatim so
   * the two implementations can be run side by side over a matrix of inputs.
   *
   * This is the strongest available parity evidence: it is not a handful of
   * hand-picked assertions, it is every combination of input shape and cache
   * state, and it fails loudly on the first divergence.
   *
   * If a future change legitimately alters reaction behaviour, this test is the
   * thing that must be updated in the same commit — deliberately, with the
   * reason — rather than discovered later.
   */
  function legacyResolveEmojiReaction(
    emojiInput: string,
    client: {
      application?: { emojis: { cache: EmojiCollectionLike } } | null;
      emojis: { cache: EmojiCollectionLike };
    },
    guild?: { emojis: { cache: EmojiCollectionLike } } | null,
  ): string {
    const raw = emojiInput.trim();

    const customMatch = raw.match(/^<a?:(\w+):(\d+)>$/);
    if (customMatch) {
      return `${customMatch[1]}:${customMatch[2]}`;
    }

    const cleanName = raw.replace(/^:|:$/g, '').toLowerCase();

    const appEmoji = client.application?.emojis.cache.find(
      (e) => e.name?.toLowerCase() === cleanName || e.id === raw
    );
    if (appEmoji) {
      return `${appEmoji.name}:${appEmoji.id}`;
    }

    if (guild) {
      const guildEmoji = guild.emojis.cache.find(
        (e) => e.name?.toLowerCase() === cleanName || e.id === raw
      );
      if (guildEmoji) {
        return `${guildEmoji.name}:${guildEmoji.id}`;
      }
    }

    const globalEmoji = client.emojis.cache.find(
      (e) => e.name?.toLowerCase() === cleanName || e.id === raw
    );
    if (globalEmoji) {
      return `${globalEmoji.name}:${globalEmoji.id}`;
    }

    return raw;
  }

  const APP: readonly EmojiLike[] = [
    ZAK_YAP,
    { id: '111', name: 'shared', animated: false },
    { id: '112', name: 'Upper_Case', animated: true },
  ];
  const GUILD: readonly EmojiLike[] = [
    { id: '222', name: 'shared', animated: false },
    { id: '333', name: 'solo', animated: true },
  ];
  const GLOBAL: readonly EmojiLike[] = [
    { id: '444', name: 'solo', animated: false },
    { id: '445', name: 'elsewhere', animated: true },
  ];

  const cacheStates: Array<{
    label: string;
    context: EmojiLookupContext;
    guild: GuildWrapper | undefined;
  }> = [];
  // Built explicitly rather than in a loop so a failure names the state that
  // diverged.
  const emptyWrapper: GuildWrapper = { emojis: { cache: cache([]) } };
  cacheStates.push(
    { label: 'no caches at all', context: {}, guild: undefined },
    { label: 'empty caches', context: { applicationEmojis: cache([]), guildEmojis: cache([]), globalEmojis: cache([]) }, guild: emptyWrapper },
    { label: 'application only', context: { applicationEmojis: cache(APP) }, guild: undefined },
    { label: 'guild only', context: { guildEmojis: cache(GUILD) }, guild: { emojis: { cache: cache(GUILD) } } },
    { label: 'global only', context: { globalEmojis: cache(GLOBAL) }, guild: undefined },
    {
      label: 'all three',
      context: { applicationEmojis: cache(APP), guildEmojis: cache(GUILD), globalEmojis: cache(GLOBAL) },
      guild: { emojis: { cache: cache(GUILD) } },
    },
  );

  const inputs = [
    '<:myapp:123>',
    '<a:myapp:123>',
    '<:zak_yap:1552379447246852146>',
    '<a:zak_yap:1552379447246852146>',
    'zak_yap',
    '  zak_yap  ',
    ':zak_yap:',
    ':ZAK_YAP:',
    'ZAK_YAP',
    'Upper_Case',
    'upper_case',
    ':upper_case:',
    '1552379447246852146',
    'shared',
    'solo',
    'elsewhere',
    '🔥',
    '  🔥  ',
    'not_a_real_emoji',
    '',
    '   ',
    ':leading_colon',
    'trailing_colon:',
    '<:bad-name:123>',
    '<:123>',
    'wat',
  ] as const;

  test('every input resolves identically under the old and new implementations', () => {
    for (const state of cacheStates) {
      // `application` is optional on the legacy signature too, so an absent
      // cache models the pre-READY state rather than being special-cased.
      const legacyClient = {
        application: state.context.applicationEmojis ? { emojis: { cache: state.context.applicationEmojis } } : undefined,
        emojis: { cache: state.context.globalEmojis ?? cache([]) },
      };

      for (const input of inputs) {
        const legacy = legacyResolveEmojiReaction(input, legacyClient, state.guild);
        const current = toEmojiReactionForm(resolveEmoji(input, state.context));
        expect(`${state.label} :: ${JSON.stringify(input)} => ${current}`).toBe(
          `${state.label} :: ${JSON.stringify(input)} => ${legacy}`
        );
      }
    }
  });

  test('the matrix actually exercised a non-trivial number of distinct outcomes', () => {
    // Guards against the parity test silently passing because every input took
    // the same trivial path.
    const context: EmojiLookupContext = {
      applicationEmojis: cache(APP),
      guildEmojis: cache(GUILD),
      globalEmojis: cache(GLOBAL),
    };
    const outcomes = new Set(inputs.map((i) => toEmojiReactionForm(resolveEmoji(i, context))));
    expect(outcomes.size).toBeGreaterThan(10);
  });
});

describe('content form — application-owned emoji', () => {
  test('an application emoji emits the animated <a:name:id> markup', () => {
    // This is the /dryrun bug. The configured value was `<:zak_yap:1552379447246852146>`
    // and it did not render; the animated form is what the client wants.
    expect(toEmojiContentForm(resolveEmoji('<:zak_yap:1552379447246852146>', appContext(ZAK_YAP)))).toBe(
      '<a:zak_yap:1552379447246852146>'
    );
  });

  test('a bare name and a bare snowflake both reach the same markup', () => {
    const expected = '<a:zak_yap:1552379447246852146>';
    expect(toEmojiContentForm(resolveEmoji('zak_yap', appContext(ZAK_YAP)))).toBe(expected);
    expect(toEmojiContentForm(resolveEmoji('1552379447246852146', appContext(ZAK_YAP)))).toBe(expected);
    expect(toEmojiContentForm(resolveEmoji(':zak_yap:', appContext(ZAK_YAP)))).toBe(expected);
  });

  test('a STATIC application emoji still gets <a:>, because that cannot hurt', () => {
    // The Discord client fetches emoji as WebP and asks for the animated
    // variant with `?animated=true`, which Discord serves for static emoji too.
    // Forcing `a` on app emoji is therefore one-directional: it fixes the
    // silent-degradation failure mode and introduces no new one.
    const staticApp: EmojiLike = { id: '555', name: 'static_app', animated: false };
    expect(toEmojiContentForm(resolveEmoji('static_app', appContext(staticApp)))).toBe(
      '<a:static_app:555>'
    );
  });

  test('an application emoji that is in no cache keeps the caller’s own flag', () => {
    // Nothing is known about it, so the resolver must not invent an `a`.
    // Reporting unresolvable is /dryrun's job, not this function's.
    expect(toEmojiContentForm(resolveEmoji('<a:mystery:999>', EMPTY))).toBe('<a:mystery:999>');
    expect(toEmojiContentForm(resolveEmoji('<:mystery:999>', EMPTY))).toBe('<:mystery:999>');
  });
});

describe('content form — guild and global emoji follow their real animated flag', () => {
  test('a static guild emoji emits <:name:id>', () => {
    const context: EmojiLookupContext = {
      guildEmojis: cache([{ id: '666', name: 'blobs', animated: false }]),
    };
    expect(toEmojiContentForm(resolveEmoji('blobs', context))).toBe('<:blobs:666>');
  });

  test('an animated guild emoji emits <a:name:id>', () => {
    const context: EmojiLookupContext = {
      guildEmojis: cache([{ id: '777', name: 'spin', animated: true }]),
    };
    expect(toEmojiContentForm(resolveEmoji('spin', context))).toBe('<a:spin:777>');
  });

  test('an animated emoji from the global cache emits <a:name:id>', () => {
    const context: EmojiLookupContext = {
      globalEmojis: cache([{ id: '888', name: 'elsewhere', animated: true }]),
    };
    expect(toEmojiContentForm(resolveEmoji('elsewhere', context))).toBe('<a:elsewhere:888>');
  });

  test('guild emoji are not promoted to <a: just for being guild emoji', () => {
    // The forcing rule is scoped to application-owned emoji on purpose. A static
    // guild emoji must stay static so the two output forms stay predictable.
    const context: EmojiLookupContext = {
      guildEmojis: cache([{ id: '999', name: 'plain', animated: false }]),
      globalEmojis: cache([{ id: '999', name: 'plain', animated: false }]),
    };
    expect(toEmojiContentForm(resolveEmoji('plain', context))).toBe('<:plain:999>');
  });
});

describe('unknown emoji fall back predictably and never throw', () => {
  test('a unicode emoji passes through byte-for-byte in both forms', () => {
    expect(toEmojiContentForm(resolveEmoji('🔥', EMPTY))).toBe('🔥');
    expect(toEmojiReactionForm(resolveEmoji('🔥', EMPTY))).toBe('🔥');
  });

  test('an unresolvable config value is returned as-is, not as broken markup', () => {
    // The caller decides what to do about this (see /dryrun). The util's job is
    // to never invent markup for an emoji it could not find.
    const resolution = resolveEmoji('totally_made_up', EMPTY);
    expect(resolution.kind).toBe('literal');
    expect(toEmojiContentForm(resolution)).toBe('totally_made_up');
    expect(toEmojiReactionForm(resolution)).toBe('totally_made_up');
  });

  test('empty and whitespace-only input does not throw', () => {
    for (const input of ['', '   ', '\t\n']) {
      expect(() => resolveEmoji(input, EMPTY)).not.toThrow();
      expect(toEmojiContentForm(resolveEmoji(input, EMPTY))).toBe('');
    }
  });

  test('missing caches are treated as empty rather than dereferenced', () => {
    // `client.application` is null until READY and `guild` is null in a DM, so
    // this is a normal runtime state, not a malformed input.
    expect(toEmojiContentForm(resolveEmoji('anything', { applicationEmojis: null }))).toBe(
      'anything'
    );
    expect(toEmojiContentForm(resolveEmoji('anything', {}))).toBe('anything');
  });

  test('markup with a name containing non-word characters is not treated as markup', () => {
    // `\w+` excludes `-` and `.`, so this falls through to the literal path
    // rather than being partially parsed.
    expect(toEmojiContentForm(resolveEmoji('<:bad-name:123>', EMPTY))).toBe('<:bad-name:123>');
  });

  test('an emoji object with a null name still yields usable markup', () => {
    // Reaction emoji objects can have `name: null`; that must not become the
    // string "null" in a message.
    const context: EmojiLookupContext = {
      globalEmojis: cache([{ id: '101010', name: null, animated: false }]),
    };
    expect(toEmojiContentForm(resolveEmoji('101010', context))).toBe('<:101010:101010>');
  });
});

describe('resolveEmojiContent — "will this actually render?"', () => {
  test('a unicode emoji counts as resolved, because it needs no cache', () => {
    // This is the distinction that matters: a unicode emoji renders identically
    // everywhere with no lookup at all, so flagging it as unresolvable would
    // make `/dryrun` replace a perfectly good configured value with a warning.
    expect(resolveEmojiContent('🔥', EMPTY)).toEqual({ markup: '🔥', resolved: true });
    expect(resolveEmojiContent('👍🏽', EMPTY)).toEqual({ markup: '👍🏽', resolved: true });
  });

  test('a custom emoji that resolved counts as resolved', () => {
    expect(resolveEmojiContent('zak_yap', appContext(ZAK_YAP))).toEqual({
      markup: '<a:zak_yap:1552379447246852146>',
      resolved: true,
    });
  });

  test('an ASCII name that matched nothing counts as UNresolved', () => {
    expect(resolveEmojiContent('totally_made_up', EMPTY)).toEqual({
      markup: 'totally_made_up',
      resolved: false,
    });
  });

  test('full markup that no cache holds counts as UNresolved', () => {
    // This is the case the /dryrun bug actually lives in: the configured value
    // is `<:zak_yap:1552379447246852146>`, and if that id is not in any of the
    // three caches we have no idea whether it renders. Reporting that is the
    // whole point — posting it verbatim is the bug.
    //
    // Note `resolveEmoji` still returns it as a custom emoji, faithfully; only
    // this "will it render?" wrapper is strict about provenance.
    expect(resolveEmoji('<:zak_yap:1552379447246852146>', EMPTY)).toMatchObject({
      kind: 'custom',
      source: null,
    });
    expect(resolveEmojiContent('<:zak_yap:1552379447246852146>', EMPTY).resolved).toBe(false);
  });

  test('the same markup IS resolved once a cache holds the id', () => {
    expect(resolveEmojiContent('<:zak_yap:1552379447246852146>', appContext(ZAK_YAP))).toEqual({
      markup: '<a:zak_yap:1552379447246852146>',
      resolved: true,
    });
  });

  test('rendersWithoutLookup separates unicode from an unresolvable name', () => {
    expect(rendersWithoutLookup('🔥')).toBe(true);
    expect(rendersWithoutLookup('wat')).toBe(false);
    expect(rendersWithoutLookup('')).toBe(false);
    expect(rendersWithoutLookup('1552379447246852146')).toBe(false);
  });
});