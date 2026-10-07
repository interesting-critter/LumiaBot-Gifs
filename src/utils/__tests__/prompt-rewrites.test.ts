import { describe, expect, test } from 'bun:test';

import {
  applyCompiledPromptRewrites,
  applyPromptRewrites,
  compilePromptRewriteRule,
  compilePromptRewriteRules,
  escapeRegExpLiteral,
  escapeRegExpReplacement,
  normalizePromptRewriteRules,
  rewriteGeminiContents,
  rewriteOpenAIMessages,
  type PromptRewriteRule,
} from '../prompt-rewrites';

/**
 * Prompt rewrite rules — the pure matcher.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * `config/rewrites.json` holds an ordered list of substitutions applied to the
 * final outbound prompt, so an operator can have the model call them by a chosen
 * name instead of their Discord username or display name. The behaviour that
 * matters is the *boundary*: a rule must fire on the whole name, including
 * inside a possessive, and must NOT fire inside a longer word.
 *
 * WHY THE TEST DATA IS THE OPERATOR'S ACTUAL CASE
 * ----------------------------------------------
 * The username (`dumb.critter`) and display name
 * (`⋆˖⁺‧₊☽𝕔𝕣𝕚𝕥𝕥𝕖𝕣☾₊‧⁺˖⋆`) are the real strings the feature was built for, and
 * between them they exercise every branch that matters:
 *
 *   - the username contains a `.`, which must be matched literally and must not
 *     act as a regex wildcard;
 *   - the display name *starts with a decorative symbol*, so it has no `\w`
 *     boundary at its start. This is the case that rules out `\b`: `\b` is
 *     defined against `[A-Za-z0-9_]`, `⋆` is not a word character, so `\b` would
 *     simply never match this name. The explicit-lookaround implementation does,
 *     and the test asserts it directly rather than asserting "no crash".
 *
 * WHY THE PLURAL CASE IS PINNED AS "UNCHANGED"
 * --------------------------------------------
 * It is a judgement call, so it is a test rather than a comment: rewriting
 * `"critters"` to `"Critics"` would silently turn a person's nickname into an
 * insult in every message, unattended. If that decision is ever revisited, this
 * test is the thing that must be changed on purpose.
 *
 * NO FILE I/O HERE
 * ----------------
 * These are pure functions. The file loading, profile overlay and caching live
 * in `src/services/prompts.ts` and are covered against temp dirs by
 * `src/services/__tests__/prompt-profiles.test.ts`; re-testing them here would
 * need `mock.module` on `utils/paths`, which is permanent for the whole `bun test`
 * process and would leak into other suites.
 */

/** The operator's Discord username — contains a `.` that must stay literal. */
const USERNAME = 'dumb.critter';

/** The operator's display name — begins with a non-word symbol. */
const DISPLAY_NAME = '⋆˖⁺‧₊☽𝕔𝕣𝕚𝕥𝕥𝕖𝕣☾₊‧⁺˖⋆';

/** The name the model should use instead. */
const CANONICAL = 'Critter';

/** Build a normalised rule with the file's defaults filled in. */
function rule(overrides: Partial<PromptRewriteRule> & { match: string }): PromptRewriteRule {
  return {
    replace: CANONICAL,
    regex: false,
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

/** Compile and run in one step — the shape a caller uses on a cold path. */
function run(rules: PromptRewriteRule[], text: string): string {
  return applyCompiledPromptRewrites(text, compilePromptRewriteRules(rules));
}

describe('literal whole-word matching', () => {
  test('a possessive is a boundary, so it is preserved rather than destroyed', () => {
    expect(run([rule({ match: USERNAME })], `${USERNAME}'s idea`)).toBe(`${CANONICAL}'s idea`);
  });

  test('the curly possessive is a boundary too', () => {
    expect(run([rule({ match: USERNAME })], `${USERNAME}’s idea`)).toBe(`${CANONICAL}’s idea`);
  });

  test('a trailing plural s does NOT match, and is not rewritten', () => {
    // The deliberate decision: this must stay `critters`, because
    // `Critter` → `Critics` would corrupt an unrelated word. See the file header.
    expect(run([rule({ match: USERNAME })], `${USERNAME}s`)).toBe(`${USERNAME}s`);
    expect(run([rule({ match: USERNAME })], `the ${USERNAME}s were there`)).toBe(`the ${USERNAME}s were there`);
  });

  test('a preceding word character does NOT match', () => {
    expect(run([rule({ match: USERNAME })], `x${USERNAME}`)).toBe(`x${USERNAME}`);
  });

  test('a following word character does NOT match, so suffixes are safe', () => {
    expect(run([rule({ match: USERNAME })], `${USERNAME}foo`)).toBe(`${USERNAME}foo`);
    expect(run([rule({ match: USERNAME })], `${USERNAME}_alt`)).toBe(`${USERNAME}_alt`);
    expect(run([rule({ match: USERNAME })], `${USERNAME}2`)).toBe(`${USERNAME}2`);
  });

  test('an underscore counts as a word character, as in every regex flavour', () => {
    // `\p{L}\p{N}` exclude `_`, so it is added by hand. Without that, a rule
    // would rewrite the tail of an identifier like `user_dumb.critter`.
    expect(run([rule({ match: USERNAME })], `user_${USERNAME}`)).toBe(`user_${USERNAME}`);
  });

  test('sentence punctuation is a boundary on both sides', () => {
    expect(run([rule({ match: USERNAME })], `(${USERNAME})`)).toBe(`(${CANONICAL})`);
    expect(run([rule({ match: USERNAME })], `[${USERNAME}],`)).toBe(`[${CANONICAL}],`);
    expect(run([rule({ match: USERNAME })], `${USERNAME}.`)).toBe(`${CANONICAL}.`);
  });

  test('every occurrence in one string is replaced, not just the first', () => {
    expect(run([rule({ match: USERNAME })], `${USERNAME} and ${USERNAME}`)).toBe(
      `${CANONICAL} and ${CANONICAL}`,
    );
  });
});

describe('the `.` in a literal rule is a dot, not a wildcard', () => {
  test('an arbitrary character in its place does not match', () => {
    expect(run([rule({ match: USERNAME })], 'dumbXcritter')).toBe('dumbXcritter');
    expect(run([rule({ match: USERNAME })], 'dumb-critter')).toBe('dumb-critter');
    expect(run([rule({ match: USERNAME })], 'dumb critter')).toBe('dumb critter');
  });

  test('other regex metacharacters in the match are literal too', () => {
    // `escapeRegExpLiteral` has to cover the full set, not just `.` — a handle
    // containing `+` or `(` would otherwise compile into a broken or wildly
    // different pattern.
    expect(run([rule({ match: 'a+b(c)', replace: 'hello' })], 'a+b(c) here')).toBe('hello here');
    expect(run([rule({ match: 'a+b(c)', replace: 'hello' })], 'aab(c) here')).toBe('aab(c) here');
    expect(run([rule({ match: 'price$5', replace: 'hello' })], 'price$5')).toBe('hello');
    expect(run([rule({ match: 'a|b', replace: 'hello' })], 'a|b')).toBe('hello');
    expect(run([rule({ match: 'a[0-9]b', replace: 'hello' })], 'a[0-9]b')).toBe('hello');
  });

  test('a hyphen or slash in the match compiles rather than throwing', () => {
    // Regression: escaping `-` and `/` looks harmless but is fatal here. The
    // patterns compile with the `u` flag, under which `\-` and `\/` are invalid
    // identity escapes, so a rule for a hyphenated handle (`my-critter`) or a
    // slash-containing one would fail to compile — silently doing nothing,
    // because a rule that will not compile is dropped rather than thrown.
    expect(run([rule({ match: 'my-critter', replace: 'hello' })], 'my-critter here')).toBe('hello here');
    expect(run([rule({ match: 'critter/alt', replace: 'hello' })], 'critter/alt here')).toBe('hello here');
    // And the hyphen must not become a range operator.
    expect(run([rule({ match: 'a-c', replace: 'hello' })], 'abc')).toBe('abc');
    expect(escapeRegExpLiteral('a-c')).toBe('a-c');
  });

  test('escapeRegExpLiteral escapes every metacharacter and nothing else', () => {
    expect(escapeRegExpLiteral('dumb.critter')).toBe('dumb\\.critter');
    // A space and letters must pass through untouched, or the literal would no
    // longer match the text the operator wrote.
    expect(escapeRegExpLiteral('hello world')).toBe('hello world');
  });
});

describe('replacement text is literal in literal mode', () => {
  test('`$&` is inserted verbatim rather than expanding to the match', () => {
    // In literal mode there are no capture groups, so an unescaped `$&` would
    // expand to the matched text and `$1` to the empty string. Both are silent
    // corruptions of the operator's own text.
    expect(run([rule({ match: USERNAME, replace: '<<$&>>' })], USERNAME)).toBe('<<$&>>');
  });

  test('`$1` is inserted verbatim rather than expanding to empty', () => {
    expect(run([rule({ match: USERNAME, replace: '[$1]' })], USERNAME)).toBe('[$1]');
  });

  test('escapeRegExpReplacement doubles each dollar sign', () => {
    // `$` → `$$`, which is the form `String.replace` requires to emit one
    // literal `$`. Two dollars in, two doubled dollars out.
    expect(escapeRegExpReplacement('$1')).toBe('$$1');
    expect(escapeRegExpReplacement('$$')).toBe('$$$$');
    expect(escapeRegExpReplacement('plain')).toBe('plain');
  });

  test('an empty replacement deletes the match', () => {
    // An omitted `replace` normalises to `''`, which is a legitimate rule shape
    // (redact a handle) rather than a malformed entry.
    expect(run([rule({ match: USERNAME, replace: '' })], `about ${USERNAME} here`)).toBe('about  here');
    expect(applyPromptRewrites(`about ${USERNAME} here`, { rewrites: [{ match: USERNAME }] })).toBe(
      'about  here',
    );
  });
});

describe('a decorative display name matches — proof that \\b is not used', () => {
  test('the name matches standalone', () => {
    expect(run([rule({ match: DISPLAY_NAME })], DISPLAY_NAME)).toBe(CANONICAL);
  });

  test('the name matches with no boundary character on either side at all', () => {
    // This is the assertion that pins the implementation choice. With `\b`, the
    // leading `⋆` is not a word character, so no boundary exists and the match
    // would fail on the very string this rule exists for.
    expect(run([rule({ match: DISPLAY_NAME })], `hi ${DISPLAY_NAME} there`)).toBe(`hi ${CANONICAL} there`);
  });

  test('the name still matches before sentence punctuation', () => {
    expect(run([rule({ match: DISPLAY_NAME })], `${DISPLAY_NAME}, hello`)).toBe(`${CANONICAL}, hello`);
    expect(run([rule({ match: DISPLAY_NAME })], `${DISPLAY_NAME}.`)).toBe(`${CANONICAL}.`);
    expect(run([rule({ match: DISPLAY_NAME })], `(${DISPLAY_NAME})`)).toBe(`(${CANONICAL})`);
  });

  test('the name still matches with a possessive', () => {
    expect(run([rule({ match: DISPLAY_NAME })], `${DISPLAY_NAME}'s`)).toBe(`${CANONICAL}'s`);
  });

  test('the name does NOT match inside a longer run of decorative symbols', () => {
    // A leading `⋆⋆` gives the rule a left neighbour that is a symbol, not a
    // word character — so by the documented boundary rule this DOES match. The
    // assertion is here to make the behaviour explicit rather than accidental:
    // the boundary is defined on word characters, not on "not exactly my first
    // character".
    expect(run([rule({ match: DISPLAY_NAME })], `⋆⋆${DISPLAY_NAME}⋆⋆`)).toBe(`⋆⋆${CANONICAL}⋆⋆`);
  });

  test('a leading word character still blocks the match', () => {
    expect(run([rule({ match: DISPLAY_NAME })], `x${DISPLAY_NAME}`)).toBe(`x${DISPLAY_NAME}`);
  });
});

describe('case sensitivity', () => {
  test('is off by default, so a differently-cased spelling still matches', () => {
    expect(run([rule({ match: USERNAME })], 'DUMB.CRitter said so')).toBe(`${CANONICAL} said so`);
    expect(run([rule({ match: USERNAME })], USERNAME.toUpperCase())).toBe(CANONICAL);
  });

  test('can be turned on per rule', () => {
    expect(run([rule({ match: USERNAME, caseSensitive: true })], USERNAME)).toBe(CANONICAL);
    expect(run([rule({ match: USERNAME, caseSensitive: true })], USERNAME.toUpperCase())).toBe(
      USERNAME.toUpperCase(),
    );
  });
});

describe('rules are applied in order, and order is load-bearing', () => {
  test('a later rule sees the earlier rule output', () => {
    // The whole reason the file is an ordered array rather than a map.
    const rules = [
      rule({ match: USERNAME, replace: 'Critter' }),
      rule({ match: 'Critter', replace: 'Cat' }),
    ];
    expect(run(rules, `${USERNAME} is here`)).toBe('Cat is here');
  });

  test('a chain of three rules collapses a name all the way down', () => {
    const rules = [
      rule({ match: USERNAME, replace: 'Critter' }),
      rule({ match: 'Critter', replace: 'Cat' }),
      rule({ match: 'Cat', replace: 'Kitten' }),
    ];
    expect(run(rules, USERNAME)).toBe('Kitten');
  });

  test('reversing the order produces a different result, which is the point', () => {
    const forwards = [rule({ match: USERNAME, replace: 'Critter' }), rule({ match: 'Critter', replace: 'Cat' })];
    const backwards = [rule({ match: 'Critter', replace: 'Cat' }), rule({ match: USERNAME, replace: 'Critter' })];

    // Forwards: rule 1 rewrites the username to `Critter`, then rule 2 rewrites
    // that output to `Cat`. Both rules fire.
    expect(run(forwards, USERNAME)).toBe('Cat');
    // Backwards: rule 1 fires FIRST, and `Critter` matches inside
    // `dumb.critter` — the `.` is a boundary, because a boundary is defined on
    // word characters and `.` is not one. So rule 1 rewrites the tail to
    // `dumb.Cat` and rule 2 then has nothing left to match.
    expect(run(backwards, USERNAME)).toBe('dumb.Cat');
  });

  test('a bare canonical-name rule DOES match inside the username, via the dot', () => {
    // A real operator footgun, pinned deliberately.
    //
    // `dumb.critter` contains `critter`, and the `.` before it is a non-word
    // character, so the left boundary holds and the match is legitimate as far
    // as the matcher is concerned. An operator who writes only
    // `{"match": "Critter", "replace": "..."}` and forgets the username rule
    // will therefore still get a partial rewrite — `dumb.Critter`, not `Critter`.
    //
    // This is not a defect to be papered over: the rule that stops it is the
    // whole reason the feature exists, and an operator who wants `dumb.critter`
    // gone should list it. Pinned so the behaviour is documented rather than
    // discovered.
    expect(run([rule({ match: CANONICAL })], USERNAME)).toBe('dumb.Critter');
  });

  test('listing the username FIRST is what makes the full name go away', () => {
    // The shipped example ordering: rewrite the specific spelling to the
    // canonical one, then let any canonical-name rule act on the result.
    const rules = [rule({ match: USERNAME, replace: CANONICAL }), rule({ match: CANONICAL, replace: 'Kitten' })];
    expect(run(rules, USERNAME)).toBe('Kitten');
  });

  test('an earlier rule does not re-match its own output (no rewrite loop)', () => {
    // `replace` is not `match`, so a rule cannot feed itself. Verified because a
    // self-feeding rule would either loop or need an explicit depth limit.
    const rules = [rule({ match: 'a', replace: 'aa' })];
    expect(run(rules, 'a')).toBe('aa');
  });

  test('two rules for the two spellings of the same person both fire', () => {
    // The motivating configuration, exactly as it would be written in the file.
    const rules = [
      rule({ match: USERNAME, replace: CANONICAL }),
      rule({ match: DISPLAY_NAME, replace: CANONICAL }),
    ];
    expect(run(rules, `[${DISPLAY_NAME}]: ${USERNAME} is here`)).toBe(`[${CANONICAL}]: ${CANONICAL} is here`);
  });
});

describe('regex opt-in', () => {
  test('a raw pattern is used verbatim when regex is true', () => {
    expect(run([rule({ match: 'critter\\d+', replace: 'Critter', regex: true })], 'critter42 hi')).toBe(
      'Critter hi',
    );
  });

  test('a regex rule gets no automatic word boundaries', () => {
    // Documented behaviour: the operator owns anchoring. A boundary assertion
    // wrapped around a pattern would silently change its meaning (and would
    // break `^`/`$` anchors outright).
    expect(run([rule({ match: 'critter', regex: true })], 'supercritter')).toBe('superCritter');
  });

  test('a regex replacement still expands $1, because that is the point of opting in', () => {
    expect(run([rule({ match: '(\\w+) critter', replace: '$1 Critter', regex: true })], 'dumb critter')).toBe(
      'dumb Critter',
    );
  });

  test('an invalid pattern disables that one rule instead of throwing', () => {
    const bad = rule({ match: '([unclosed', regex: true });
    const good = rule({ match: USERNAME });
    const compiled = compilePromptRewriteRules([bad, good]);

    expect(compiled).toHaveLength(1);
    expect(applyCompiledPromptRewrites(USERNAME, compiled)).toBe(CANONICAL);
  });

  test('an invalid pattern throws nothing out of the caller', () => {
    expect(() => compilePromptRewriteRule(rule({ match: '([unclosed', regex: true }))).not.toThrow();
    expect(compilePromptRewriteRule(rule({ match: '([unclosed', regex: true }))).toBeNull();
  });
});

describe('a malformed rules file degrades to no rewrites, never to a throw', () => {
  const badInputs: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'rewrites'],
    ['a number', 42],
    ['an array of strings', ['dumb.critter']],
    ['an object with no rewrites key', { rules: [{ match: USERNAME }] }],
    ['rewrites that is not an array', { rewrites: { match: USERNAME } }],
    ['an empty object', {}],
    ['an empty array', []],
  ];

  for (const [label, input] of badInputs) {
    test(`${label} applies no rewrites and does not throw`, () => {
      expect(() => normalizePromptRewriteRules(input)).not.toThrow();
      expect(normalizePromptRewriteRules(input)).toEqual([]);
      expect(applyPromptRewrites(`${USERNAME} text`, input)).toBe(`${USERNAME} text`);
    });
  }

  test('individual malformed entries are dropped and the good ones still run', () => {
    // The contract is "fewer rewrites", never "no replies": a single typo in
    // rule 3 must not disable rules 1 and 2.
    const compiled = compilePromptRewriteRules(
      normalizePromptRewriteRules({
        rewrites: [
          { match: USERNAME, replace: CANONICAL },
          null,
          'not an object',
          { replace: 'no match key' },
          { match: '', replace: 'x' },
          { match: DISPLAY_NAME, replace: CANONICAL },
        ],
      }),
    );

    expect(applyCompiledPromptRewrites(`${USERNAME} and ${DISPLAY_NAME}`, compiled)).toBe(
      `${CANONICAL} and ${CANONICAL}`,
    );
  });

  test('a non-string replace is dropped rather than coerced', () => {
    expect(normalizePromptRewriteRules({ rewrites: [{ match: USERNAME, replace: 42 }] })).toEqual([]);
  });

  test('a boolean field left as a non-boolean is treated as absent, not truthy', () => {
    const [normalized] = normalizePromptRewriteRules({
      rewrites: [{ match: USERNAME, regex: 'yes', caseSensitive: 1 }],
    });

    // `"yes"` and `1` are both truthy, so a naive `!!value` would silently switch
    // both defaults. Only a literal `true` opts in.
    expect(normalized?.regex).toBe(false);
    expect(normalized?.caseSensitive).toBe(false);
  });

  test('an omitted replace is a deletion, not a malformed entry', () => {
    expect(normalizePromptRewriteRules({ rewrites: [{ match: USERNAME }] })).toEqual([
      { match: USERNAME, replace: '', regex: false, caseSensitive: false, enabled: true },
    ]);
  });

  test('enabled: false parks a rule without removing it from the file', () => {
    const parsed = normalizePromptRewriteRules({
      rewrites: [{ match: USERNAME, replace: CANONICAL, enabled: false }],
    });

    // Normalisation keeps it, so the dashboard still shows the operator's rule…
    expect(parsed).toHaveLength(1);
    // …but compilation skips it, so it does not run.
    expect(compilePromptRewriteRules(parsed)).toHaveLength(0);
    expect(applyPromptRewrites(USERNAME, { rewrites: [{ match: USERNAME, replace: CANONICAL, enabled: false }] })).toBe(
      USERNAME,
    );
  });

  test('a bare top-level array is accepted as well as the documented shape', () => {
    // An operator writing a list of lists should not have to know which shape we
    // parse; both are documented.
    expect(applyPromptRewrites(USERNAME, [{ match: USERNAME, replace: CANONICAL }])).toBe(CANONICAL);
    expect(applyPromptRewrites(USERNAME, { rewrites: [{ match: USERNAME, replace: CANONICAL }] })).toBe(CANONICAL);
  });

  test('empty and non-string input strings are returned unchanged', () => {
    const compiled = compilePromptRewriteRules(normalizePromptRewriteRules({ rewrites: [{ match: USERNAME }] }));

    expect(applyCompiledPromptRewrites('', compiled)).toBe('');
    expect(applyPromptRewrites('', { rewrites: [{ match: USERNAME }] })).toBe('');
  });

  test('a rule whose match is empty is refused, because it would rewrite everywhere', () => {
    // `String.replace` would not loop forever, but the result would be
    // unrecoverable — the operator's text interleaved with itself at every
    // position. Refused outright instead.
    expect(compilePromptRewriteRule({ match: '', replace: 'x', regex: false, caseSensitive: false, enabled: true })).toBeNull();
  });
});

describe('outbound payload helpers copy rather than mutate', () => {
  const compiled = compilePromptRewriteRules(
    normalizePromptRewriteRules({
      rewrites: [
        { match: USERNAME, replace: CANONICAL },
        { match: DISPLAY_NAME, replace: CANONICAL },
      ],
    }),
  );

  test('an OpenAI message array is rewritten, including the system message', () => {
    // The system message is where `<current-user name="…">` and
    // `<mentioned-users>` live, so it is the most important one to cover.
    const messages = [
      { role: 'system', content: `<current-user name="${USERNAME}">` },
      { role: 'user', content: `[${DISPLAY_NAME}]: hi` },
    ];

    expect(rewriteOpenAIMessages(messages, compiled)).toEqual([
      { role: 'system', content: `<current-user name="${CANONICAL}">` },
      { role: 'user', content: `[${CANONICAL}]: hi` },
    ]);
  });

  test('the caller\'s messages are left untouched, so an earlier log capture keeps the originals', () => {
    const messages = [{ role: 'user' as const, content: `${USERNAME} hi` }];
    const rewritten = rewriteOpenAIMessages(messages, compiled);

    expect(messages[0]?.content).toBe(`${USERNAME} hi`);
    expect(rewritten[0]?.content).toBe(`${CANONICAL} hi`);
    // A distinct object, not an in-place edit.
    expect(rewritten[0]).not.toBe(messages[0]);
  });

  test('multimodal text parts are rewritten and media parts are passed through by reference', () => {
    // Copying a base64 image blob to rewrite one word of text would be absurd.
    const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: `${USERNAME} what is this` },
          imagePart,
        ],
      },
    ];

    const rewritten = rewriteOpenAIMessages(messages, compiled);

    expect(rewritten[0]?.content).toEqual([
      { type: 'text', text: `${CANONICAL} what is this` },
      imagePart,
    ]);
    // Original text part object untouched. `noUncheckedIndexedAccess` widens the
    // element access, so the guard here is the assertion's own precondition.
    expect(messages[0]?.content[0]).toEqual({ type: 'text', text: `${USERNAME} what is this` });
  });

  test('Gemini contents are rewritten and their media parts survive', () => {
    const contents = [
      {
        role: 'user',
        parts: [{ text: `[${DISPLAY_NAME}]: hi` }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
      },
    ];

    expect(rewriteGeminiContents(contents, compiled)).toEqual([
      {
        role: 'user',
        parts: [{ text: `[${CANONICAL}]: hi` }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
      },
    ]);
    expect(contents[0]?.parts?.[0]).toEqual({ text: `[${DISPLAY_NAME}]: hi` });
  });

  test('an empty rule list is a cheap pass-through on both shapes', () => {
    const messages = [{ role: 'user', content: `${USERNAME} hi` }];
    const rewritten = rewriteOpenAIMessages(messages, []);

    expect(rewritten).toEqual(messages);
    // Still a copy: callers rely on being able to hold the original.
    expect(rewritten).not.toBe(messages);

    const contents = [{ role: 'user', parts: [{ text: USERNAME }] }];
    expect(rewriteGeminiContents(contents, [])).toEqual(contents);
  });

  test('a message with an unexpected shape is passed through rather than crashing the turn', () => {
    // `enhancedMessages` is typed, but the payload also crosses provider
    // proxies. A turn must not die on a shape this feature did not expect.
    const odd = [
      { role: 'user', content: null },
      { role: 'user', content: 42 },
      { role: 'user' },
      { role: 'user', content: `${USERNAME} hi` },
    ];

    expect(() => rewriteOpenAIMessages(odd, compiled)).not.toThrow();
    expect(rewriteOpenAIMessages(odd, compiled)[3]?.content).toBe(`${CANONICAL} hi`);
    // A Gemini entry with no `parts` at all.
    expect(() => rewriteGeminiContents([{ role: 'model' }], compiled)).not.toThrow();
  });
});