/**
 * `getTriggerKeywords()` must render template variables before handing the
 * list to the matcher.
 *
 * THE BUG THIS PINS
 * -----------------
 * `config/triggers.json` ships `"{botName}"` as the **first** `bot_mention`
 * entry, and `prompts.ts` returns `config.triggers.bot_mention` verbatim. Every
 * other string getter in that module runs `substituteVariables` —
 * `getBotIdentity`, `getBoredomMessages`, `getErrorTemplates`,
 * `getCommandResponses`, `getReplyContextTemplate`, `getVideoReactionInstructions`
 * — and `getTriggerKeywords` was the sole exception.
 *
 * The consequence is that the operator's own bot name is the one trigger that
 * cannot fire. `message-handler.ts` wraps each keyword in `\b…\b`, and `{` is a
 * non-word character, so the literal braces act as word boundaries and the
 * un-substituted entry matches *neither* `"hey Bad Kitty"` nor a user who
 * literally types `"hey {botName}"`. Empirically, on the shipped fixture:
 *
 *     "hey Bad Kitty"    → no match
 *     "hey bot"          → match   (the generic fallback next to it)
 *     "hey assistant"    → match   (ditto)
 *     "hey {botName}"    → no match
 *
 * `botName` is set from `config.bot.name` at `src/index.ts:143` before any
 * message is handled, so the value was always available. This is a bug, not a
 * deliberate refusal to template trigger keywords: the fixture advertises
 * `{botName}` as a supported variable, the sibling getters all substitute, and
 * the only way to make the configured name work was for an operator to retype
 * it into the JSON by hand — which the template then told them not to do.
 *
 * WHY THE MATCHING IS RE-DERIVED HERE
 * -----------------------------------
 * `compileTriggers()` is module-private in `message-handler.ts`. Re-deriving it
 * from the source rather than importing it keeps this suite honest about *what
 * the matcher does with the list* (the `\b` anchoring is the whole reason a
 * raw `{botName}` fails), and avoids importing `message-handler.ts`, which
 * pulls in the AI, database and gif services for a pure string test.
 *
 * WHY A SUBPROCESS
 * ----------------
 * `PROMPT_STORAGE_DIR` is a module-load constant with no env override
 * (`utils/paths.ts`), so it cannot be redirected in process; `mock.module` is
 * permanent for the whole `bun test` process and mutates the namespace it
 * replaces (`prompt-profiles.test.ts` documents both and restores the real
 * exports by re-mocking at the end of that file). A cold child process gets a
 * clean registry and leaves nothing behind. `process.execPath` is the running
 * Bun binary, so this does not depend on `bun` being on `PATH`. Same mechanism
 * as `prompt-profile-identity.test.ts` and `swarmui-profile-overlay.test.ts`.
 *
 * FIXTURE DISCIPLINE
 * ------------------
 * Every fixture is built under `os.tmpdir()` and removed afterwards. Nothing is
 * written under the real `prompt_storage/` or `prompt_storage.example/`.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';

/** The checked-in fixture whose `{botName}` usage this suite is about. */
const EXAMPLE_DIR = resolve(REPO_ROOT, 'prompt_storage.example');

const MARKER = '__TRANSCRIPT__';

type Transcript = Record<string, string>;

const BOT_NAME = 'Bad Kitty';

/**
 * The harness, run as a cold `bun` process.
 *
 * `root` is the prompt storage directory it resolves against; `botName` is what
 * `setTemplateVariables()` is given before the getters are read. Every value it
 * emits is the output of a real read or a real regex test, recorded under a
 * label naming the step.
 */
function harnessSource(root: string, botName: string): string {
  return `
import { mock } from 'bun:test';
import { join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const ROOT = ${JSON.stringify(root)};
const BOT_NAME = ${JSON.stringify(botName)};
const MARKER = ${JSON.stringify(MARKER)};

const t = {};

// Point the prompt root at the fixture before \`prompts.ts\` is ever evaluated —
// the same substitution a fresh operator performs.
mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: ROOT,
  DATA_DIR: ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(REPO, 'knowledge_documents'),
  dbPath: (name) => join(ROOT, name),
}));

const prompts = await import(join(REPO, 'src/services/prompts.ts'));

/**
 * \`compileTriggers()\` from \`src/services/message-handler.ts\`, copied rather
 * than imported: it is module-private, and this suite is specifically about the
 * \`\\\\b\` anchoring that makes a raw \`{botName}\` unmatchable.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

function compileTriggers(keywords) {
  const usable = keywords.filter(
    (keyword) => typeof keyword === 'string' && keyword.trim() !== '',
  );
  return {
    source: keywords,
    keywords: usable,
    wholeWord: usable.map((keyword) => new RegExp('\\\\b' + escapeRegExp(keyword) + '\\\\b', 'i')),
    stripLeading: usable.map((keyword) => new RegExp('^' + escapeRegExp(keyword) + '[,!]?\\\\s*', 'i')),
  };
}

function read(label, fn) {
  t[label] = String(fn());
  return t[label];
}

/** Exactly what \`ensureTriggersFresh()\` does on the hot path. */
function triggersOf(message) {
  return compileTriggers(prompts.getTriggerKeywords().botMention).wholeWord.some(
    (pattern) => pattern.test(message),
  );
}

function matches(label, message) {
  t[label] = triggersOf(message) ? 'match' : 'no match';
}

read('profile.atStart', () => prompts.getActivePromptProfileId());
read('raw.bot_mention', () => JSON.stringify(
  (prompts.loadJsonFile('config/triggers.json') || {}).triggers?.bot_mention ?? null,
));

// \`src/index.ts:143\` does this from \`config.bot.name\` before any message is
// handled. Without it \`{botName}\` would render as \`{botName}\`.
prompts.setTemplateVariables({ botName: BOT_NAME });

const triggers = prompts.getTriggerKeywords();
read('botMention.json', () => JSON.stringify(triggers.botMention));
read('searchIntent.json', () => JSON.stringify(triggers.searchIntent));
read('knowledgeIntent.json', () => JSON.stringify(triggers.knowledgeIntent));

// THE REGRESSION, end to end through the real matcher.
matches('match.configuredName', 'hey ' + BOT_NAME);
matches('match.literalPlaceholder', 'hey {botName}');
matches('match.genericBot', 'hey bot');
matches('match.genericAssistant', 'hey assistant');
matches('match.nameWithPunctuation', BOT_NAME + ', draw me something');

// Stability of the array *object*, which is the hot-path cache key in
// \`ensureTriggersFresh()\`: it recompiles only when the reference moves.
const first = prompts.getTriggerKeywords().botMention;
const second = prompts.getTriggerKeywords().botMention;
read('sameArrayObject', () => first === second);

// And that the rendered value tracks a changed variable, not just the first one.
prompts.setTemplateVariables({ botName: 'Lumia Prime' });
read('botMention.afterRename', () => JSON.stringify(prompts.getTriggerKeywords().botMention));
matches('match.renamed', 'hey Lumia Prime');
matches('match.oldNameAfterRename', 'hey ' + BOT_NAME);

console.log(MARKER + JSON.stringify(t));
`;
}

/** A second harness that reports the **no-file** branch instead. */
function fallbackHarnessSource(root: string): string {
  return `
import { mock } from 'bun:test';
import { join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const ROOT = ${JSON.stringify(root)};
const MARKER = ${JSON.stringify(MARKER)};

const t = {};

mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: ROOT,
  DATA_DIR: ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(REPO, 'knowledge_documents'),
  dbPath: (name) => join(ROOT, name),
}));

const prompts = await import(join(REPO, 'src/services/prompts.ts'));

function read(label, fn) {
  t[label] = String(fn());
  return t[label];
}

read('config.triggers.json', () => prompts.loadJsonFile('config/triggers.json'));
read('botMention.json', () => JSON.stringify(prompts.getTriggerKeywords().botMention));
read('searchIntent.json', () => JSON.stringify(prompts.getTriggerKeywords().searchIntent));
read('knowledgeIntent.json', () => JSON.stringify(prompts.getTriggerKeywords().knowledgeIntent));

console.log(MARKER + JSON.stringify(t));
`;
}

/**
 * The **per-profile memoisation** harness.
 *
 * The two harnesses above re-derive `compileTriggers()` from the source, which
 * is right for them (this suite is about the `\b` anchoring) and wrong for this
 * one: the claim under test is a claim about the *real* memo in
 * `message-handler.ts`, so the real module is imported. `mock.module` on
 * `utils/paths.ts` is what redirects the prompt root, and it is registered
 * before either `prompts.ts` or `message-handler.ts` is evaluated, so both see
 * the same `prompts` instance — which is the whole point: the resolver and the
 * memo that consumes it must be the same module pair (`bot-definition.ts`'s
 * suite documents why that goes wrong in-process).
 *
 * `ensureTriggersFresh()` announces each compile on stdout, so the harness
 * counts those lines instead of adding any production-side hook. That is what
 * makes this a memoisation test rather than a correctness test: correctness
 * holds for both a Map and a single slot, but only the Map compiles once.
 */
function perProfileHarnessSource(root: string): string {
  return `
import { mock } from 'bun:test';
import { join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const ROOT = ${JSON.stringify(root)};
const MARKER = ${JSON.stringify(MARKER)};
const GUILD_A = ${JSON.stringify(GUILD_A)};
const GUILD_B = ${JSON.stringify(GUILD_B)};
const PROFILE_A = ${JSON.stringify(PROFILE_A)};
const PROFILE_B = ${JSON.stringify(PROFILE_B)};

const t = {};

mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: ROOT,
  DATA_DIR: ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(REPO, 'knowledge_documents'),
  dbPath: (name) => join(ROOT, name),
}));

// Imported before message-handler so the resolver is installed in the same
// instance the memo reads from.
const prompts = await import(join(REPO, 'src/services/prompts.ts'));
const handler = await import(join(REPO, 'src/services/message-handler.ts'));

// Count compiles without touching production code. \`ensureTriggersFresh()\`
// logs one line per compile, naming the profile it compiled for — which doubles
// as the per-profile assertion: a single global slot would only ever log the
// profile that happened to be compiled last, and would log it far more often.
const compiles = [];
const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('[HANDLER] Compiled')) {
    compiles.push(args.join(' '));
    return;
  }
  realLog(...args);
};

const PROMPTS = {
  [GUILD_A]: PROFILE_A,
  [GUILD_B]: PROFILE_B,
};

prompts.setGuildProfileResolver((guildId) => PROMPTS[guildId] ?? 'default');

function read(label, fn) {
  t[label] = String(fn());
  return t[label];
}

/** Run one message through the real matcher under a guild's profile. */
function asGuild(guildId, message) {
  return prompts.runWithPromptContext(guildId, () =>
    handler.shouldTriggerBot(message, BOT_ID));
}

function compilesAfter(label, since) {
  read(label, () => compiles.length - since);
  return compiles.length;
}

const BOT_ID = '999888777666555444';
const A = GUILD_A;
const B = GUILD_B;

// ── Control: the two profiles really do carry disjoint keyword lists.
read('keywords.A', () => JSON.stringify(prompts.runWithPromptContext(A, () =>
  prompts.getTriggerKeywords().botMention)));
read('keywords.B', () => JSON.stringify(prompts.runWithPromptContext(B, () =>
  prompts.getTriggerKeywords().botMention)));

// ── Round one, alternating. Each guild must compile exactly once, for its own
//    profile: one slot cannot hold both lists at once.
let mark = compiles.length;
read('trigger.A.alphaUnderA', () => asGuild(A, 'alpha are you there'));
compilesAfter('compiles.A.1', mark);

mark = compiles.length;
read('trigger.B.alphaUnderB', () => asGuild(B, 'alpha are you there'));
read('trigger.B.betaUnderB', () => asGuild(B, 'beta are you there'));
compilesAfter('compiles.B.1', mark);

mark = compiles.length;
read('trigger.A.betaUnderA', () => asGuild(A, 'beta are you there'));
compilesAfter('compiles.A.2', mark);

// ── Round two, same order. Nothing may recompile: this is the memo, and a
//    single global slot would report 1 compile here for every guild.
mark = compiles.length;
read('trigger.A.alphaUnderA.2', () => asGuild(A, 'alpha are you there'));
read('trigger.B.alphaUnderB.2', () => asGuild(B, 'alpha are you there'));
read('trigger.A.betaUnderA.2', () => asGuild(A, 'beta are you there'));
read('trigger.B.betaUnderB.2', () => asGuild(B, 'beta are you there'));
compilesAfter('compiles.round2', mark);

// ── And the extracted keywords, which is the user-visible form of the same
//    claim: each guild sees only its own list.
read('extract.A.alpha', () => JSON.stringify(prompts.runWithPromptContext(A, () =>
  handler.extractTriggerKeywords('alpha and beta'))));
read('extract.B.alpha', () => JSON.stringify(prompts.runWithPromptContext(B, () =>
  handler.extractTriggerKeywords('alpha and beta'))));

// ── Returning to a profile already seen must reuse its slot: A's slot holds
//    patterns compiled from A's own array, so the answer is still correct and
//    nothing is recompiled. This is the case a "the map must be dropped so every
//    profile gets a new array" argument gets wrong.
mark = compiles.length;
read('trigger.A.alphaUnderA.3', () => asGuild(A, 'alpha are you there'));
read('trigger.A.betaUnderA.3', () => asGuild(A, 'beta are you there'));
compilesAfter('compiles.returnToA', mark);

// Everything above — both guilds, both rounds, plus the return to A — cost
// exactly two compiles, one per profile.
read('compiles.total', () => compiles.length);
read('compiles.log', () => JSON.stringify(compiles));

// ── Outside any wrapper: the main selection, not whichever guild ran last.
read('effective.outside', () => prompts.getEffectivePromptProfileId());
read('trigger.outside.alpha', () => handler.shouldTriggerBot('alpha are you there', BOT_ID));
read('trigger.outside.beta', () => handler.shouldTriggerBot('beta are you there', BOT_ID));

// These two DO recompile, and that is pre-existing behaviour rather than
// anything about profiles: \`default\` has no \`triggers.json\` here, so
// \`getTriggerKeywords()\` takes its hardcoded fallback branch, which builds a
// fresh array on every call. The reference check in \`ensureTriggersFresh()\`
// cannot hit on a value that is new each time. Recorded so the total above is
// not mistaken for a leak in the per-profile map.
read('compiles.afterOutside', () => compiles.length);

console.log = realLog;
console.log(MARKER + JSON.stringify(t));
`;
}

function run(source: string): Transcript {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-triggers-harness-'));
  const harnessPath = join(dir, 'probe.ts');

  try {
    writeFileSync(harnessPath, source, 'utf-8');

    const proc = Bun.spawnSync([process.execPath, 'run', harnessPath], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();

    if (proc.exitCode !== 0) {
      throw new Error(`harness exited ${proc.exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
    }

    const line = stdout.split('\n').find((l) => l.startsWith(MARKER));
    if (line === undefined) {
      throw new Error(
        `harness produced no ${MARKER} line\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }

    return JSON.parse(line.slice(MARKER.length)) as Transcript;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

/**
 * A prompt root whose `config/triggers.json` is the checked-in fixture, verbatim
 * — the same `{botName}` entry every install ships.
 */
function makeExampleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-triggers-example-'));
  writeFixture(
    root,
    'config/triggers.json',
    readFileSync(join(EXAMPLE_DIR, 'config/triggers.json'), 'utf-8'),
  );
  return root;
}

/** A prompt root with no `config/triggers.json` at all. */
function makeBareRoot(): string {
  return mkdtempSync(join(tmpdir(), 'lumia-triggers-bare-'));
}

const PROFILE_A = 'art';
const PROFILE_B = 'wisp';
const GUILD_A = '111111111111111678';
const GUILD_B = '222222222222222678';

/** A triggers file whose `bot_mention` list is exactly `keywords`. */
function triggersFile(keywords: string[]): string {
  return JSON.stringify({
    triggers: {
      bot_mention: keywords,
      search_intent: ['search'],
      knowledge_intent: ['remember'],
    },
  });
}

/**
 * Two profiles with **disjoint** trigger lists, and nothing at the default root.
 *
 * Disjoint is the whole design: if A's and B's lists shared a keyword, "guild B
 * triggered on A's keyword" would be indistinguishable from correct behaviour and
 * the whole scenario would be unfalsifiable. The default root is left empty so
 * the fallback branch (`['bad kitty', 'lumia']`) is *not* what a guild sees —
 * if a guild ever resolved to `default` instead of its profile, neither keyword
 * would fire and the failure would be obvious rather than subtle.
 */
function makePerProfileRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-triggers-per-profile-'));
  writeFixture(root, join('profiles', PROFILE_A, 'config/triggers.json'), triggersFile(['alpha']));
  writeFixture(root, join('profiles', PROFILE_B, 'config/triggers.json'), triggersFile(['beta']));
  return root;
}

const scratchDirs: string[] = [];

function tracked(dir: string): string {
  scratchDirs.push(dir);
  return dir;
}

describe('the bot\'s own name is a trigger', () => {
  const root = tracked(makeExampleRoot());
  const t = run(harnessSource(root, BOT_NAME));

  test('the fixture really does ship {botName}, so this is not a no-file install', () => {
    expect(t['profile.atStart']).toBe('default');
    expect(JSON.parse(t['raw.bot_mention'] as string)).toContain('{botName}');
  });

  test('THE REGRESSION: {botName} is rendered before the list is returned', () => {
    const botMention = JSON.parse(t['botMention.json'] as string) as string[];

    expect(botMention).toContain(BOT_NAME);
    expect(botMention).not.toContain('{botName}');
    expect(botMention.join(' ')).not.toContain('{botName}');
    // The generic fallbacks next to it are untouched.
    expect(botMention).toContain('bot');
    expect(botMention).toContain('assistant');
    // Position is preserved: `{botName}` was first, so the rendered name is too.
    expect(botMention[0]).toBe(BOT_NAME);
  });

  test('end to end: "hey Bad Kitty" matches and the literal placeholder does not', () => {
    // What \`compileTriggers\` produces from the returned list.
    expect(t['match.configuredName']).toBe('match');
    // The braces act as word boundaries, so even a user typing the placeholder
    // verbatim gets nothing — this is why the failure was silent.
    expect(t['match.literalPlaceholder']).toBe('no match');
    // The generic entries alongside it keep working.
    expect(t['match.genericBot']).toBe('match');
    expect(t['match.genericAssistant']).toBe('match');
    // \`stripLeading\`'s first pattern must tolerate the trailing comma, exactly as
    // \`stripLeading\` in the handler does.
    expect(t['match.nameWithPunctuation']).toBe('match');
  });

  test('the rendered name tracks the template variable, not a hardcoded default', () => {
    // \`setTemplateVariables\` clears the prompt cache, so the next read re-renders.
    expect(JSON.parse(t['botMention.afterRename'] as string)).toContain('Lumia Prime');
    expect(t['match.renamed']).toBe('match');
    expect(t['match.oldNameAfterRename']).toBe('no match');
  });

  test('the returned array object is stable while the variables are unchanged', () => {
    // \`ensureTriggersFresh()\` recompiles every keyword into a \`RegExp\` only when
    // this array reference moves. Returning a freshly-built array on each call
    // would turn that hot-path cache off for every message in every guild, so the
    // substitution has to be memoised on the source array it came from.
    expect(t['sameArrayObject']).toBe('true');
  });
});

describe('the other two keyword lists substitute too', () => {
  const root = tracked(makeExampleRoot());
  const t = run(harnessSource(root, BOT_NAME));

  test('searchIntent is rendered', () => {
    expect(JSON.parse(t['searchIntent.json'] as string)).toEqual([
      'search', 'look up', 'find out', 'google', 'search the web', 'check online',
      'look online', 'on the internet', 'on the web', 'online', 'research',
      'find information', 'what is', 'who is', 'tell me about',
    ]);
  });

  test('knowledgeIntent is rendered', () => {
    expect(JSON.parse(t['knowledgeIntent.json'] as string)).toEqual([
      'remember', 'what did we talk about', 'last time', 'previously',
    ]);
  });
});

describe('an install with no config/triggers.json still gets the hardcoded fallback', () => {
  const root = tracked(makeBareRoot());
  const t = run(fallbackHarnessSource(root));

  test('the loader really has nothing to read', () => {
    expect(t['config.triggers.json']).toBe('null');
  });

  test('the fallback branch is reachable and still returns the built-in keywords', () => {
    // `loadJsonFile` returns null, so this getter takes the fallback. Pinned
    // deliberately: it is dead only for installs that have the file, and it is
    // what keeps a bot with no prompt storage from having zero triggers.
    expect(JSON.parse(t['botMention.json'] as string)).toEqual(['bad kitty', 'lumia']);
    expect(JSON.parse(t['searchIntent.json'] as string)).toEqual([
      'search', 'look up', 'find out', 'google',
    ]);
    expect(JSON.parse(t['knowledgeIntent.json'] as string)).toEqual([
      'loom', 'lucid loom',
    ]);
  });
});

describe('compiled trigger patterns are memoised per profile, not globally', () => {
  const root = tracked(makePerProfileRoot());
  const t = run(perProfileHarnessSource(root));

  test('the two profiles really do carry disjoint keyword lists', () => {
    // Control. Without this, "guild B did not trigger on A's keyword" could be
    // explained by a fixture where neither list contained it.
    expect(JSON.parse(t['keywords.A'] as string)).toEqual(['alpha']);
    expect(JSON.parse(t['keywords.B'] as string)).toEqual(['beta']);
  });

  test('THE REGRESSION: one guild\'s keywords do not trigger another', () => {
    expect(t['trigger.A.alphaUnderA']).toBe('true');
    // THE REGRESSION. A single global slot would answer `true` here, because the
    // last guild to arrive would have overwritten the only compiled list.
    expect(t['trigger.B.alphaUnderB']).toBe('false');
    expect(t['trigger.B.betaUnderB']).toBe('true');
    expect(t['trigger.A.betaUnderA']).toBe('false');
  });

  test('the memo actually memoises: each profile compiles exactly once', () => {
    // This is what a single slot cannot do. It cannot hold two lists, so every
    // message from the *other* guild changes `current.source` and recompiles all
    // of that profile's regexes. Cost-only — correctness holds either way — which
    // is why the comment in `message-handler.ts` calls it a regression that is
    // invisible in a single-guild test.
    expect(t['compiles.A.1']).toBe('1');
    expect(t['compiles.B.1']).toBe('1');
    // A's list was already compiled by now, so this must add nothing.
    expect(t['compiles.A.2']).toBe('0');
  });

  test('alternating guilds recompile nothing: the hot-path cache is intact', () => {
    expect(t['compiles.round2']).toBe('0');
    // Every message so far — six guild-scoped reads across two profiles, plus
    // the extracted-keyword reads — cost two compiles.
    expect(t['compiles.total']).toBe('2');
    // And the compiles that did happen each named their own profile, which is
    // only possible if the map is keyed on the effective (guild-aware) profile
    // rather than the main selection.
    const log = JSON.parse(t['compiles.log'] as string) as string[];
    expect(log.some((line) => line.includes(`profile ${PROFILE_A}`))).toBe(true);
    expect(log.some((line) => line.includes(`profile ${PROFILE_B}`))).toBe(true);
  });

  test('the extracted keywords are per profile too, not just the boolean', () => {
    // The user-visible form of the same claim: guild A is told "alpha" matched,
    // guild B is told "beta" matched. A shared list would give both guilds both
    // keywords, or the wrong one.
    expect(JSON.parse(t['extract.A.alpha'] as string)).toEqual(['alpha']);
    expect(JSON.parse(t['extract.B.alpha'] as string)).toEqual(['beta']);
  });

  test('returning to a profile already seen reuses its slot and stays correct', () => {
    // The case the "must drop the cache so every profile gets a new array"
    // argument gets wrong: A's slot holds patterns compiled from A's own array,
    // so the hit is both free and correct. Nothing recompiles.
    expect(t['compiles.returnToA']).toBe('0');
    expect(t['trigger.A.alphaUnderA.3']).toBe('true');
    expect(t['trigger.A.betaUnderA.3']).toBe('false');
  });

  test('outside any wrapper the main selection is used, not the last guild', () => {
    expect(t['effective.outside']).toBe('default');
    // The default root has no `triggers.json`, so the hardcoded fallback
    // `['bad kitty', 'lumia']` applies and neither fixture keyword fires.
    expect(t['trigger.outside.alpha']).toBe('false');
    expect(t['trigger.outside.beta']).toBe('false');
    // Two more compiles here, and correctly so: the fallback branch hands back a
    // fresh array every call, so there is nothing stable to memoise against. This
    // is why the per-profile compiles are counted *before* this block rather
    // than after it — otherwise a pre-existing property of the no-file branch
    // would read as a leak in the map.
    expect(t['compiles.afterOutside']).toBe('4');
  });
});

describe('fixture hygiene', () => {
  test('every fixture lived under os.tmpdir(), never under the repository', () => {
    expect(scratchDirs.length).toBeGreaterThan(0);
    expect(scratchDirs.every((dir) => dir.startsWith(tmpdir()))).toBe(true);
    // `prompt_storage/` is operator-private and gitignored; it must not appear
    // because of this suite.
    expect(existsSync(resolve(REPO_ROOT, 'prompt_storage'))).toBe(false);
  });

  test('the harness left no scratch directories behind', () => {
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    // `rmSync` above has already removed anything it is going to; a surviving
    // path means cleanup failed.
    expect(scratchDirs.some((dir) => existsSync(dir))).toBe(false);
  });
});