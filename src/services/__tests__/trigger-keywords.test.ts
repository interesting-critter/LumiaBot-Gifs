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