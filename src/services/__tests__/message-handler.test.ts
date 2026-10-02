import { afterAll, describe, expect, mock, test } from 'bun:test';

/**
 * Fix the trigger list so these tests do not depend on whatever
 * `prompt_storage/config/triggers.json` happens to hold on the machine running
 * them (the repo ships `prompt_storage.example/`, not `prompt_storage/`).
 *
 * The mock spreads the real module so every other consumer of `./prompts` still
 * gets its real exports; only `getTriggerKeywords` is replaced.
 */
const actualPrompts = await import('../prompts');

let botMention: string[] = ['kitty', 'cutesy'];
const triggers = {
  botMention: () => botMention,
  searchIntent: () => ['search'],
  knowledgeIntent: () => ['remember'],
};

mock.module('../prompts', () => ({
  ...actualPrompts,
  getTriggerKeywords: () => ({
    botMention: triggers.botMention(),
    searchIntent: triggers.searchIntent(),
    knowledgeIntent: triggers.knowledgeIntent(),
  }),
}));

// Imported after the mock is registered so the module graph picks it up.
const {
  COLLECTIVE_KNOWLEDGE_PREFETCH_BUDGET_MS,
  extractMessageContent,
  extractTriggerKeywords,
  prefetchCollectiveKnowledge,
  reloadTriggers,
  shouldTriggerBot,
} = await import('../message-handler');

const { detectThirdPersonReference, extractMentionsWithContext, extractPronouns, parseMessage } =
  await import('../message-parser');

const BOT_ID = '999888777666555444';

afterAll(() => {
  botMention = ['kitty', 'cutesy'];
});

describe('collective knowledge prefetch', () => {
  test('returns the result when it arrives inside the budget', async () => {
    const result = await prefetchCollectiveKnowledge(async () => '<collective-knowledge>hi</collective-knowledge>', 'q', 500);
    expect(result).toBe('<collective-knowledge>hi</collective-knowledge>');
  });

  test('gives up at the budget instead of stalling the turn', async () => {
    // A request that never settles: previously this blocked the whole turn for
    // the orchestrator's own 10s timeout before the main LLM call even began.
    const started = Date.now();
    const result = await prefetchCollectiveKnowledge(() => new Promise<string>(() => {}), 'q', 60);
    const elapsed = Date.now() - started;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);
  });

  test('an empty or whitespace result is not injected at all', async () => {
    expect(await prefetchCollectiveKnowledge(async () => '', 'q', 500)).toBeUndefined();
    expect(await prefetchCollectiveKnowledge(async () => '   \n\t ', 'q', 500)).toBeUndefined();
  });

  test('a rejection never escapes into the caller error path', async () => {
    // Previously this rejection landed in the generic catch of handleMessage
    // and the user got "Something went wrong" instead of an answer.
    const result = await prefetchCollectiveKnowledge(async () => {
      throw new Error('orchestrator exploded');
    }, 'q', 500);

    expect(result).toBeUndefined();
  });

  test('an abandoned request that rejects later is not an unhandled rejection', async () => {
    let rejectLater: (reason: Error) => void = () => {};
    const pending = new Promise<string>((_resolve, reject) => {
      rejectLater = reject;
    });

    const result = await prefetchCollectiveKnowledge(() => pending, 'q', 30);
    expect(result).toBeUndefined();

    // If the race loser had no handler, this would surface as an unhandled
    // rejection and can terminate the process.
    rejectLater(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(true).toBe(true);
  });

  test('a slow-but-in-time result still wins the race', async () => {
    const result = await prefetchCollectiveKnowledge(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow but fine'), 20)),
      'q',
      500
    );
    expect(result).toBe('slow but fine');
  });

  test('the default budget is a small fraction of the orchestrator timeout', () => {
    expect(COLLECTIVE_KNOWLEDGE_PREFETCH_BUDGET_MS).toBeGreaterThan(0);
    expect(COLLECTIVE_KNOWLEDGE_PREFETCH_BUDGET_MS).toBeLessThanOrEqual(3_000);
  });
});

describe('shouldTriggerBot', () => {
  test('a direct mention triggers regardless of keywords', () => {
    expect(shouldTriggerBot(`<@${BOT_ID}> hello`, BOT_ID)).toBe(true);
    expect(shouldTriggerBot(`<@!${BOT_ID}> hello`, BOT_ID)).toBe(true);
  });

  test('a mention of a different user does not trigger', () => {
    expect(shouldTriggerBot('<@111222333444555666> hello', BOT_ID)).toBe(false);
  });

  test('a configured keyword triggers as a whole word', () => {
    expect(shouldTriggerBot('hey kitty, what is up', BOT_ID)).toBe(true);
    expect(shouldTriggerBot('CUTESY time', BOT_ID)).toBe(true);
  });

  test('a partial word does not trigger', () => {
    expect(shouldTriggerBot('kittens are cute', BOT_ID)).toBe(false);
    expect(shouldTriggerBot('cutesier', BOT_ID)).toBe(false);
  });

  test('a keyword inside a URL does not trigger', () => {
    expect(shouldTriggerBot('look at https://example.invalid/kitty/page', BOT_ID)).toBe(false);
    // Markdown link *text* is deliberately kept (only the URL is stripped), so
    // use non-keyword text here and assert the URL itself is ignored.
    expect(shouldTriggerBot('look at [read this](https://example.invalid/kitty)', BOT_ID)).toBe(false);
  });

  test('regex metacharacters in a keyword are escaped, not interpreted', () => {
    try {
      botMention = ['a.b', 'x+y'];
      // `a.b` must not match "axb", and `x+y` must not match "xay".
      expect(shouldTriggerBot('axb time', BOT_ID)).toBe(false);
      expect(shouldTriggerBot('xay time', BOT_ID)).toBe(false);
      expect(shouldTriggerBot('a.b time', BOT_ID)).toBe(true);
      expect(shouldTriggerBot('x+y time', BOT_ID)).toBe(true);
    } finally {
      botMention = ['kitty', 'cutesy'];
    }
  });
});

describe('extractTriggerKeywords', () => {
  test('returns the matched keywords in configured order', () => {
    expect(extractTriggerKeywords('cutesy kitty')).toEqual(['kitty', 'cutesy']);
  });

  test('returns nothing when nothing matches', () => {
    expect(extractTriggerKeywords('just chatting')).toEqual([]);
  });

  test('ignores keywords inside links', () => {
    expect(extractTriggerKeywords('https://example.invalid/kitty')).toEqual([]);
  });

  test('agrees with shouldTriggerBot', () => {
    const content = 'hey kitty look at https://example.invalid/cutesy';
    expect(extractTriggerKeywords(content).length > 0).toBe(shouldTriggerBot(content, BOT_ID));
  });
});

describe('extractMessageContent', () => {
  test('strips the bot mention', () => {
    expect(extractMessageContent(`<@${BOT_ID}> hello there`, BOT_ID)).toBe('hello there');
    expect(extractMessageContent(`<@!${BOT_ID}> hello there`, BOT_ID)).toBe('hello there');
  });

  test('strips a leading trigger keyword with punctuation', () => {
    expect(extractMessageContent('kitty, hello', BOT_ID)).toBe('hello');
    expect(extractMessageContent('kitty! hello', BOT_ID)).toBe('hello');
    expect(extractMessageContent('kitty hello', BOT_ID)).toBe('hello');
  });

  test('leaves a keyword that is not at the start', () => {
    expect(extractMessageContent('hello kitty', BOT_ID)).toBe('hello kitty');
  });

  test('mention stripping is stable across repeated calls', () => {
    // The mention pattern is `g`-flagged; a stale lastIndex would make the
    // second call leave the mention behind.
    for (let i = 0; i < 5; i++) {
      expect(extractMessageContent(`<@${BOT_ID}> a <@${BOT_ID}> b`, BOT_ID)).toBe('a  b');
    }
  });
});

describe('trigger recompilation on config change', () => {
  test('a new keyword list is picked up without a restart', () => {
    // The old code snapshotted the list at module load, so editing
    // triggers.json on the dashboard did nothing until the process restarted.
    expect(shouldTriggerBot('zorp time', BOT_ID)).toBe(false);

    botMention = ['zorp'];
    expect(shouldTriggerBot('zorp time', BOT_ID)).toBe(true);
    // ...and the removed keyword stops working.
    expect(shouldTriggerBot('kitty time', BOT_ID)).toBe(false);

    botMention = ['kitty', 'cutesy'];
    expect(shouldTriggerBot('kitty time', BOT_ID)).toBe(true);
  });

  test('reloadTriggers forces a fresh read', () => {
    expect(() => reloadTriggers()).not.toThrow();
    expect(shouldTriggerBot('kitty time', BOT_ID)).toBe(true);
  });
});

describe('message-parser pure helpers', () => {
  test('detects pronoun declarations', () => {
    expect(extractPronouns('i go by she/her')).toBe('she/her');
    expect(extractPronouns('my pronouns are they/them')).toBe('they/them');
    expect(extractPronouns('pronouns: he/him')).toBe('he/him');
  });

  test('returns null when no pronouns are declared', () => {
    expect(extractPronouns('just a normal sentence')).toBeNull();
  });

  test('extracts mention context and replaces the raw mention with a name', () => {
    const mentioned = new Map([['123456789', 'ada']]);
    const result = extractMentionsWithContext(
      'I was talking with <@123456789> about the project today.',
      mentioned,
      'lin'
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.username).toBe('ada');
    expect(result[0]?.mentionedBy).toBe('lin');
    expect(result[0]?.context).toContain('ada');
    expect(result[0]?.context).not.toContain('<@123456789>');
  });

  test('skips mentions that are not in the provided map', () => {
    const result = extractMentionsWithContext('hey <@999> you', new Map(), 'lin');
    expect(result).toEqual([]);
  });

  test('parseMessage reports pronouns and mentions together', () => {
    const parsed = parseMessage(
      'my pronouns are she/her and I like <@123456789> a lot',
      new Map([['123456789', 'ada']]),
      'lin'
    );

    expect(parsed.pronouns).toBe('she/her');
    expect(parsed.hasMentions).toBe(true);
    expect(parsed.mentions).toHaveLength(1);
  });

  test('parseMessage on a plain message yields nothing to store', () => {
    const parsed = parseMessage('good morning everyone', new Map(), 'lin');
    expect(parsed.pronouns).toBeNull();
    expect(parsed.hasMentions).toBe(false);
    expect(parsed.mentions).toEqual([]);
  });

  test('detects third-person references', () => {
    expect(detectThirdPersonReference('she said that was nice')).toBe(true);
    expect(detectThirdPersonReference('good morning everyone')).toBe(false);
  });
});
