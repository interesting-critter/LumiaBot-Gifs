import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Tests for the profile-aware prompt loader in `src/services/prompts.ts`.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * A *profile* is a named, per-file overlay on top of the default prompt tree:
 *
 *   prompt_storage/                 ← profile `default`
 *   prompt_storage/profiles/<id>/…  ← profile `<id>`
 *
 * Resolution is per file: a profile supplies only the files it has and inherits
 * the rest from the default root. The bytes that are read are then cached under
 * the **resolved absolute path**, which is what keeps two profiles from sharing
 * one cache entry for the same relative path.
 *
 * WHY THE FIXTURES ARE COPIES
 * ---------------------------
 * `PROMPT_STORAGE_DIR` is derived from `import.meta.dir` at module load, so it
 * cannot be redirected with an env var the way `DATA_DIR` can (`paths.ts` exposes
 * `DATA_DIR`'s override but `PROMPT_STORAGE_DIR` has none, and `paths.ts` is not
 * this file's to change). Every test here therefore drives the module against a
 * **temporary** root:
 *
 *   - `../../utils/paths` is replaced with `mock.module` — the same pattern
 *     `parser-guild-scope.test.ts` uses to swap a service singleton — and the
 *     module is then re-imported under a distinct specifier query so each test
 *     gets its own module instance. Without the query, `prompts.ts` would keep
 *     the single instance some other test file happened to load first, along
 *     with its `PROMPT_PROFILES_DIR` and its already-populated prompt cache.
 *   - Nothing is ever written under the real `prompt_storage/`. That directory
 *     is operator-private (gitignored) and does not exist on a fresh checkout.
 *   - The backward-compatibility assertions read their *expected* values from
 *     the checked-in `prompt_storage.example/` fixture, never from the copy, so
 *     they pin the real files rather than the copy.
 *
 * A `mock.module` is permanent for the process: re-mocking with the real exports
 * does **not** put the original module back (verified), and `mock.module` also
 * mutates the live namespace it replaced. So the real storage path is captured
 * before any mocking, and the last test in this file installs it again — which is
 * also what makes the "the default profile has not moved" assertion possible.
 */

import * as pathsNamespace from '../../utils/paths';

/**
 * Plain snapshot, taken before anything is mocked.
 *
 * Spreading the namespace detaches this object from the live binding: Bun's
 * `mock.module` writes through to the namespace it replaces, so `import *`
 * would hand back the *mocked* value by the end of the file.
 */
const actualPaths = { ...pathsNamespace };
const { REPO_ROOT } = actualPaths;

/**
 * The real prompt root, captured before any mock is installed.
 *
 * Derived independently of `PROMPT_STORAGE_DIR` so that test (f) cannot pass by
 * comparing a redirected constant against itself.
 */
const REAL_PROMPT_STORAGE_DIR = join(REPO_ROOT, 'prompt_storage');

/** The checked-in fixture whose layout a real install mirrors. */
const EXAMPLE_DIR = resolve(REPO_ROOT, 'prompt_storage.example');

type PromptsModule = typeof import('../prompts');

let instanceCounter = 0;

/**
 * Point `PROMPT_STORAGE_DIR` at `root` and return a **fresh** `prompts`
 * instance, so module state (`activePromptProfileId`, `promptCache`,
 * `PROMPT_PROFILES_DIR`) cannot leak between tests.
 *
 * The query string is load-bearing: it is what makes the re-import a distinct
 * module instead of the cached instance.
 */
async function freshPrompts(root: string): Promise<PromptsModule> {
  mock.module('../../utils/paths', () => ({ ...actualPaths, PROMPT_STORAGE_DIR: root }));
  instanceCounter += 1;
  const specifier = `../prompts.ts?prompt-profiles-test=${instanceCounter}`;
  return (await import(specifier)) as PromptsModule;
}

/** Read a file out of a root, asserting it exists — a typo here should not read as "missing". */
function readRootFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf-8');
}

const tempDirs: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Write `content` at `relativePath` inside `root`, creating parent directories. */
function writeFile(root: string, relativePath: string, content: string): string {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Fixture 1 — a copy of the checked-in `prompt_storage.example/` tree.
 *
 * This is the "no profiles configured" install: the layout an existing operator
 * already has, with nothing under `profiles/`.
 * ═══════════════════════════════════════════════════════════════════════════ */

const exampleRoot = makeTempRoot('lumia-prompt-profiles-example-');
cpSync(EXAMPLE_DIR, exampleRoot, { recursive: true });

/* ═══════════════════════════════════════════════════════════════════════════
 * Fixture 2 — a hand-built default tree plus profile overlays.
 *
 * Layout:
 *   persona/identity.txt                    DEFAULT IDENTITY
 *   persona/sfw_guidelines.txt              DEFAULT SFW GUIDELINES
 *   persona/reinforcement.txt               DEFAULT REINFORCEMENT
 *   config/triggers.json                    default triggers
 *   profiles/alpha/persona/identity.txt     ALPHA IDENTITY
 *   profiles/alpha/config/triggers.json     alpha triggers
 *   profiles/beta/persona/identity.txt      BETA IDENTITY
 *   profiles/beta/config/triggers.json      beta triggers
 *   profiles/partial/persona/identity.txt   PARTIAL IDENTITY      ← one file only
 *   profiles/partial/instructions/only-in-overlay.txt
 *   profiles/zeta/                           (empty directory)
 *   profiles/default/                        (must never be listed twice)
 *   profiles/not-a-profile.txt               (stray file, must be ignored)
 *   profiles/bad name/                       (unselectable id, must be filtered)
 * ═══════════════════════════════════════════════════════════════════════════ */

const overlayRoot = makeTempRoot('lumia-prompt-profiles-overlay-');

writeFile(overlayRoot, 'persona/identity.txt', 'DEFAULT IDENTITY');
writeFile(overlayRoot, 'persona/sfw_guidelines.txt', 'DEFAULT SFW GUIDELINES');
writeFile(overlayRoot, 'persona/reinforcement.txt', 'DEFAULT REINFORCEMENT');
writeFile(overlayRoot, 'config/triggers.json', JSON.stringify({
  triggers: {
    bot_mention: ['default-mention'],
    search_intent: ['default-search'],
    knowledge_intent: ['default-knowledge'],
  },
}));

writeFile(overlayRoot, 'profiles/alpha/persona/identity.txt', 'ALPHA IDENTITY');
writeFile(overlayRoot, 'profiles/alpha/config/triggers.json', JSON.stringify({
  triggers: {
    bot_mention: ['alpha-mention'],
    search_intent: ['alpha-search'],
    knowledge_intent: ['alpha-knowledge'],
  },
}));

writeFile(overlayRoot, 'profiles/beta/persona/identity.txt', 'BETA IDENTITY');
writeFile(overlayRoot, 'profiles/beta/config/triggers.json', JSON.stringify({
  triggers: {
    bot_mention: ['beta-mention'],
    search_intent: ['beta-search'],
    knowledge_intent: ['beta-knowledge'],
  },
}));

// Exactly one file: everything else must be inherited from the default root.
writeFile(overlayRoot, 'profiles/partial/persona/identity.txt', 'PARTIAL IDENTITY');
// Only in the overlay and in neither root — the union-of-shapes case.
writeFile(overlayRoot, 'profiles/partial/instructions/only-in-overlay.txt', 'OVERLAY ONLY');

// A directory with no files at all must still be a listed, selectable profile.
mkdirSync(join(overlayRoot, 'profiles/zeta'), { recursive: true });
// `default` is reserved and must not be listed twice or shadow the real root.
mkdirSync(join(overlayRoot, 'profiles/default'), { recursive: true });
// A stray file is not a profile.
writeFile(overlayRoot, 'profiles/not-a-profile.txt', 'stray');
// A directory whose name could never be selected: filtered out of the listing
// rather than advertised as a profile that throws when chosen.
mkdirSync(join(overlayRoot, 'profiles/bad name'), { recursive: true });

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort, matching `setup.ts`: never let cleanup take down a run.
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════ */

describe('backward compatibility: an install with no profiles configured', () => {
  test('the default profile is the storage root, and nothing else is active', async () => {
    const prompts = await freshPrompts(exampleRoot);

    expect(prompts.getActivePromptProfileId()).toBe('default');
    expect(prompts.getPromptProfileRoot('default')).toBe(exampleRoot);
    // No `profiles/` directory in the fixture: listing must not throw, and
    // `default` is still selectable because it needs no folder of its own.
    expect(prompts.listPromptProfiles()).toEqual(['default']);
  });

  test('resolvePromptPath resolves straight into the root, with no overlay hop', async () => {
    const prompts = await freshPrompts(exampleRoot);

    expect(prompts.resolvePromptPath('persona/identity.txt')).toBe(
      join(exampleRoot, 'persona/identity.txt'),
    );
    expect(prompts.resolvePromptPath('config/triggers.json')).toBe(
      join(exampleRoot, 'config/triggers.json'),
    );
  });

  test('loadTextFile returns the checked-in fixture bytes unchanged', async () => {
    const prompts = await freshPrompts(exampleRoot);

    // Expected values are read from the real `prompt_storage.example/` tree,
    // not from the temp copy, so this pins the shipped fixture itself. The
    // pre-feature loader trimmed the file and returned it; that is the contract.
    expect(prompts.loadTextFile('persona/identity.txt')).toBe(
      readRootFile(EXAMPLE_DIR, 'persona/identity.txt').trim(),
    );
    expect(prompts.loadTextFile('persona/sfw_guidelines.txt')).toBe(
      readRootFile(EXAMPLE_DIR, 'persona/sfw_guidelines.txt').trim(),
    );
    expect(prompts.loadTextFile('persona/reinforcement.txt')).toBe(
      readRootFile(EXAMPLE_DIR, 'persona/reinforcement.txt').trim(),
    );
    expect(prompts.loadTextFile('instructions/gif_reaction.txt')).toBe(
      readRootFile(EXAMPLE_DIR, 'instructions/gif_reaction.txt').trim(),
    );
  });

  test('loadJsonFile parses the checked-in fixture unchanged', async () => {
    const prompts = await freshPrompts(exampleRoot);

    const expected = JSON.parse(readRootFile(EXAMPLE_DIR, 'config/triggers.json'));
    expect(prompts.loadJsonFile('config/triggers.json')).toEqual(expected);
  });

  test('getBotIdentity keeps its council-profile stripping and substitution', async () => {
    const prompts = await freshPrompts(exampleRoot);
    const identity = prompts.getBotIdentity();

    expect(identity.startsWith('### IDENTITY')).toBe(true);
    // `{botName}` was substituted by the template variables…
    expect(identity).toContain('You are Bad Kitty, a helpful and friendly Discord assistant.');
    // …and the council block was stripped out, as it always was.
    expect(identity).not.toContain('council-profile');
    expect(identity).not.toContain('{botName}');
    // Trailing whitespace normalised, so the output is not the raw file.
    expect(identity).toBe(identity.trim());
  });

  test('getBotCouncilProfile still extracts the council block', async () => {
    const prompts = await freshPrompts(exampleRoot);
    const council = prompts.getBotCouncilProfile();

    expect(council).toContain('Name: Bad Kitty');
    expect(council).toContain('Appearance: Describe the visible traits other council bots can use when addressing you.');
    expect(council.length).toBeLessThanOrEqual(2000);
  });

  test('getSfwGuidelines and getPersonaReinforcement match the fixture', async () => {
    const prompts = await freshPrompts(exampleRoot);

    // The SFW file has no template variables, so this is byte-for-byte.
    expect(prompts.getSfwGuidelines()).toBe(
      readRootFile(EXAMPLE_DIR, 'persona/sfw_guidelines.txt').trim(),
    );
    // Reinforcement has one `{botName}`, so the only difference is substitution.
    expect(prompts.getPersonaReinforcement()).toBe(
      readRootFile(EXAMPLE_DIR, 'persona/reinforcement.txt').trim().replace(/\{botName\}/g, 'Bad Kitty'),
    );
  });

  test('getTriggerKeywords maps the fixture keys, renames them, and substitutes', async () => {
    const prompts = await freshPrompts(exampleRoot);
    const triggers = JSON.parse(readRootFile(EXAMPLE_DIR, 'config/triggers.json')).triggers;

    // `{botName}` IS substituted, exactly as in its siblings `getBoredomMessages`,
    // `getErrorTemplates` and `getCommandResponses`. It used not to be, which left
    // the bot's own name as the one trigger that could never fire — and failed
    // silently, because `message-handler.ts` wraps each keyword in `\b…\b` and `{`
    // is a non-word character, so the raw `"{botName}"` matched neither the
    // configured name nor a user typing the placeholder literally. Substitution is
    // the only difference from the raw fixture, derived from it rather than
    // hard-coded, so this keeps holding if the fixture changes.
    const botName = String(prompts.getTemplateVariables().botName ?? 'Bad Kitty');
    const render = (list: string[]) => list.map((entry) => entry.replace(/\{botName\}/g, botName));

    expect(prompts.getTriggerKeywords()).toEqual({
      botMention: render(triggers.bot_mention),
      searchIntent: render(triggers.search_intent),
      knowledgeIntent: render(triggers.knowledge_intent),
    });
    expect(prompts.getTriggerKeywords().botMention).toContain(botName);
    expect(prompts.getTriggerKeywords().botMention).not.toContain('{botName}');
  });

  test('the error/command message getters read the fixture, not the built-in fallbacks', async () => {
    const prompts = await freshPrompts(exampleRoot);
    const errorTemplates = JSON.parse(readRootFile(EXAMPLE_DIR, 'persona/error_templates.json'));

    // Distinct from the hard-coded fallbacks, so this really came from disk.
    expect(prompts.getErrorMessage('generic_error')).toBe(errorTemplates.generic_error);
    expect(prompts.getErrorMessage('guild_only_error')).toBe(errorTemplates.guild_only_error);
    expect(Object.keys(prompts.getErrorTemplates()).sort()).toEqual(Object.keys(errorTemplates).sort());
  });

  test('command responses fall back to {} because the shipped example file is not valid JSON', async () => {
    const prompts = await freshPrompts(exampleRoot);
    const text = readRootFile(EXAMPLE_DIR, 'persona/command_responses.json');

    // `prompt_storage.example/persona/command_responses.json` is two JSON
    // objects concatenated (`},` then `{`), so `loadJsonFile` cannot parse it
    // and the getter must degrade to the empty fallback instead of throwing.
    // Derived from the file rather than hard-coded, so this keeps holding if
    // the fixture is ever repaired — at which point it starts asserting the
    // real values. Reported to the owning agent.
    let parsed: { [key: string]: string } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    expect(prompts.getCommandResponses()).toEqual(parsed ?? {});
    expect(prompts.getCommandResponse('search_no_results')).toEqual(parsed?.['search_no_results'] ?? null);
  });

  test('getReplyContextTemplate substitutes both template layers', async () => {
    const prompts = await freshPrompts(exampleRoot);

    const rendered = prompts.getReplyContextTemplate('reply_to_bot', {
      originalContent: 'THE ORIGINAL',
      timestamp: 'THE TIMESTAMP',
    });

    expect(rendered).toContain('THE ORIGINAL');
    expect(rendered).toContain('THE TIMESTAMP');
    expect(rendered).toContain('<reply-context type="direct">');
    expect(rendered).not.toContain('{originalContent}');
    expect(rendered).not.toContain('{timestamp}');
  });

  test('a missing file still returns null rather than throwing', async () => {
    const prompts = await freshPrompts(exampleRoot);

    expect(prompts.loadTextFile('persona/definitely-not-a-real-file.txt')).toBeNull();
    expect(prompts.loadJsonFile('config/definitely-not-a-real-file.json')).toBeNull();
  });
});

describe('cache isolation between profiles', () => {
  test('the same relative path reads different bytes under each profile', async () => {
    const prompts = await freshPrompts(overlayRoot);

    prompts.setActivePromptProfileId('alpha');
    expect(prompts.getActivePromptProfileId()).toBe('alpha');
    const asAlpha = prompts.loadTextFile('persona/identity.txt');

    prompts.setActivePromptProfileId('beta');
    expect(prompts.getActivePromptProfileId()).toBe('beta');
    const asBeta = prompts.loadTextFile('persona/identity.txt');

    expect(asAlpha).toBe('ALPHA IDENTITY');
    expect(asBeta).toBe('BETA IDENTITY');
    expect(asAlpha).not.toBe(asBeta);

    // Round-tripping back is the sharper statement: with one shared cache entry
    // keyed on the *relative* path, alpha's second read would hand back beta's
    // bytes. Each physical file must have its own entry.
    prompts.setActivePromptProfileId('alpha');
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('ALPHA IDENTITY');
  });

  test('JSON loaders are isolated per profile too', async () => {
    const prompts = await freshPrompts(overlayRoot);

    prompts.setActivePromptProfileId('alpha');
    expect(prompts.getTriggerKeywords().botMention).toEqual(['alpha-mention']);

    prompts.setActivePromptProfileId('beta');
    expect(prompts.getTriggerKeywords().botMention).toEqual(['beta-mention']);

    // Neither profile overrides the file, so both inherit the default root's.
    prompts.setActivePromptProfileId('alpha');
    expect(prompts.loadTextFile('persona/sfw_guidelines.txt')).toBe('DEFAULT SFW GUIDELINES');
  });

  test('clearCache still forces a re-read after an on-disk edit', async () => {
    const prompts = await freshPrompts(overlayRoot);
    const alphaIdentity = join(overlayRoot, 'profiles/alpha/persona/identity.txt');

    prompts.setActivePromptProfileId('alpha');
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('ALPHA IDENTITY');

    // Edit behind the cache's back: the cached entry must win…
    writeFileSync(alphaIdentity, 'ALPHA IDENTITY (edited)', 'utf-8');
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('ALPHA IDENTITY');
    // …until it is invalidated, which proves invalidation still works now that
    // the key is the resolved absolute path rather than the relative path.
    prompts.clearCache();
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('ALPHA IDENTITY (edited)');

    writeFileSync(alphaIdentity, 'ALPHA IDENTITY', 'utf-8');
  });

  test('useCache=false bypasses the cache without disturbing it', async () => {
    const prompts = await freshPrompts(overlayRoot);
    const alphaIdentity = join(overlayRoot, 'profiles/alpha/persona/identity.txt');

    prompts.setActivePromptProfileId('alpha');
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('ALPHA IDENTITY');

    writeFileSync(alphaIdentity, 'ALPHA IDENTITY (edited)', 'utf-8');
    expect(prompts.loadTextFile('persona/identity.txt', false)).toBe('ALPHA IDENTITY (edited)');
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('ALPHA IDENTITY');

    writeFileSync(alphaIdentity, 'ALPHA IDENTITY', 'utf-8');
  });

  test('getPromptCacheGeneration increments, which is what swarmui.ts watches', async () => {
    const prompts = await freshPrompts(overlayRoot);

    const start = prompts.getPromptCacheGeneration();
    prompts.clearCache();
    expect(prompts.getPromptCacheGeneration()).toBe(start + 1);

    // A profile switch bumps it too — that is what makes a switch take effect
    // for consumers that cache `config/swarm_cfg.json` outside this module.
    prompts.setActivePromptProfileId('alpha');
    const afterSwitch = prompts.getPromptCacheGeneration();
    expect(afterSwitch).toBeGreaterThan(start + 1);

    prompts.setActivePromptProfileId('default');
    expect(prompts.getPromptCacheGeneration()).toBe(afterSwitch + 1);
  });
});

describe('per-file fallback to the default root', () => {
  test('a profile holding one file overrides that file and inherits the rest', async () => {
    const prompts = await freshPrompts(overlayRoot);
    prompts.setActivePromptProfileId('partial');

    // Present in the profile → the profile's copy wins.
    expect(prompts.resolvePromptPath('persona/identity.txt')).toBe(
      join(overlayRoot, 'profiles/partial/persona/identity.txt'),
    );
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('PARTIAL IDENTITY');

    // Absent from the profile → the default root's copy is used, both for text
    // and for JSON, even though the profile directory exists.
    expect(prompts.resolvePromptPath('persona/sfw_guidelines.txt')).toBe(
      join(overlayRoot, 'persona/sfw_guidelines.txt'),
    );
    expect(prompts.loadTextFile('persona/sfw_guidelines.txt')).toBe('DEFAULT SFW GUIDELINES');
    expect(prompts.getSfwGuidelines()).toBe('DEFAULT SFW GUIDELINES');

    expect(prompts.resolvePromptPath('config/triggers.json')).toBe(
      join(overlayRoot, 'config/triggers.json'),
    );
    expect(prompts.loadJsonFile('config/triggers.json')).toEqual(
      JSON.parse(readRootFile(overlayRoot, 'config/triggers.json')),
    );
  });

  test('a file present only in the overlay resolves to the overlay (union of shapes)', async () => {
    const prompts = await freshPrompts(overlayRoot);
    prompts.setActivePromptProfileId('partial');

    expect(prompts.resolvePromptPath('instructions/only-in-overlay.txt')).toBe(
      join(overlayRoot, 'profiles/partial/instructions/only-in-overlay.txt'),
    );
    expect(prompts.loadTextFile('instructions/only-in-overlay.txt')).toBe('OVERLAY ONLY');

    // Switching to `default` proves the file really is absent from the root, so
    // the assertion above is not just the fallback path returning a coincidence.
    prompts.setActivePromptProfileId('default');
    expect(prompts.loadTextFile('instructions/only-in-overlay.txt')).toBeNull();
  });

  test('a file absent everywhere resolves to the default path, not the profile path', async () => {
    const prompts = await freshPrompts(overlayRoot);
    prompts.setActivePromptProfileId('partial');

    // The documented behaviour: a "file not found" warning should name the
    // operator's canonical location, not a profile path that does not exist.
    expect(prompts.resolvePromptPath('persona/nowhere.txt')).toBe(
      join(overlayRoot, 'persona/nowhere.txt'),
    );
    expect(prompts.loadTextFile('persona/nowhere.txt')).toBeNull();
  });

  test('an empty profile directory inherits absolutely everything', async () => {
    const prompts = await freshPrompts(overlayRoot);
    prompts.setActivePromptProfileId('zeta');

    expect(prompts.resolvePromptPath('persona/identity.txt')).toBe(
      join(overlayRoot, 'persona/identity.txt'),
    );
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('DEFAULT IDENTITY');
    expect(prompts.getTriggerKeywords().botMention).toEqual(['default-mention']);
  });

  test('resolution never escapes the storage root', async () => {
    const prompts = await freshPrompts(overlayRoot);
    prompts.setActivePromptProfileId('alpha');

    expect(() => prompts.resolvePromptPath('../../escape.txt')).toThrow(/resolves outside/);
    expect(() => prompts.resolvePromptPath('persona/\0evil.txt')).toThrow(/null byte/);
    expect(() => prompts.resolvePromptPath('')).toThrow(/non-empty relative path/);
  });
});

describe('listPromptProfiles', () => {
  test('lists default first, then only selectable directories, sorted', async () => {
    const prompts = await freshPrompts(overlayRoot);

    // Excluded: `not-a-profile.txt` (a file), `bad name` (unselectable id) and
    // the reserved `default` directory.
    expect(prompts.listPromptProfiles()).toEqual(['default', 'alpha', 'beta', 'partial', 'zeta']);
  });

  test('default is always the first element', async () => {
    const prompts = await freshPrompts(overlayRoot);

    expect(prompts.listPromptProfiles()[0]).toBe('default');
  });

  test('returns ["default"] when the profiles directory does not exist', async () => {
    const prompts = await freshPrompts(exampleRoot);

    // The example fixture has no `profiles/` directory; this must be a list, not
    // an exception, because `default` is selectable without a folder.
    expect(prompts.listPromptProfiles()).toEqual(['default']);
    expect(() => prompts.setActivePromptProfileId('default')).not.toThrow();
    expect(prompts.getActivePromptProfileId()).toBe('default');
  });

  test('every listed id other than default is selectable', async () => {
    const prompts = await freshPrompts(overlayRoot);

    for (const id of prompts.listPromptProfiles()) {
      if (id === 'default') continue;
      expect(prompts.getPromptProfileRoot(id)).toBe(join(overlayRoot, 'profiles', id));
    }
  });

  test('ordering is stable across calls', async () => {
    const prompts = await freshPrompts(overlayRoot);

    expect(prompts.listPromptProfiles()).toEqual(prompts.listPromptProfiles());
  });
});

describe('setActivePromptProfileId fails closed', () => {
  const hostileIds: ReadonlyArray<readonly [string, RegExp]> = [
    ['../escape', /path (traversal|separators)/],
    ['..', /path traversal/],
    ['a/b', /path separators/],
    ['a\\b', /path separators/],
    ['bad\0name', /null byte/],
    ['.', /only letters/],
    ['', /non-empty string/],
    ['x'.repeat(65), /longer than 64/],
    ['has spaces', /only letters/],
    ['-leading-dash', /only letters/],
    ['missing-profile', /Unknown prompt profile/],
  ];

  test('every hostile id throws from both the setter and the root lookup', async () => {
    const prompts = await freshPrompts(overlayRoot);

    for (const [id, message] of hostileIds) {
      expect(() => prompts.getPromptProfileRoot(id)).toThrow(message);
      expect(() => prompts.setActivePromptProfileId(id)).toThrow(message);
    }
  });

  test('a rejected id leaves the previously active profile in place', async () => {
    const prompts = await freshPrompts(overlayRoot);

    prompts.setActivePromptProfileId('alpha');
    expect(prompts.getActivePromptProfileId()).toBe('alpha');

    for (const [id] of hostileIds) {
      expect(() => prompts.setActivePromptProfileId(id)).toThrow();
      expect(prompts.getActivePromptProfileId()).toBe('alpha');
    }

    // The resolver is still pointing at a profile that exists, not at one that
    // does not — which is the whole point of validating before assigning.
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('ALPHA IDENTITY');
  });

  test('a rejected id does not invalidate the cache', async () => {
    const prompts = await freshPrompts(overlayRoot);

    prompts.setActivePromptProfileId('alpha');
    const generation = prompts.getPromptCacheGeneration();

    expect(() => prompts.setActivePromptProfileId('../escape')).toThrow();
    expect(prompts.getPromptCacheGeneration()).toBe(generation);
  });

  test('a well-formed but unknown id is rejected by name, listing the real choices', async () => {
    const prompts = await freshPrompts(overlayRoot);

    expect(() => prompts.setActivePromptProfileId('ghost')).toThrow(/ghost.*alpha, beta, partial, zeta/s);
  });

  test('a valid switch still takes effect and resets to default cleanly', async () => {
    const prompts = await freshPrompts(overlayRoot);

    prompts.setActivePromptProfileId('partial');
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('PARTIAL IDENTITY');

    prompts.setActivePromptProfileId('default');
    expect(prompts.loadTextFile('persona/identity.txt')).toBe('DEFAULT IDENTITY');
    expect(prompts.resolvePromptPath('persona/identity.txt')).toBe(
      join(overlayRoot, 'persona/identity.txt'),
    );
  });
});

/**
 * Declared last on purpose.
 *
 * This is both test (f) — the default profile must still be the storage root —
 * and the teardown for the `mock.module` installed above: it points
 * `PROMPT_STORAGE_DIR` back at the real path so the rest of the suite, and any
 * later import of `prompts.ts`, is not left reading a deleted temp directory.
 */
describe('the default profile is the real storage root', () => {
  test('getPromptProfileRoot("default") is PROMPT_STORAGE_DIR, and has not moved', async () => {
    const prompts = await freshPrompts(REAL_PROMPT_STORAGE_DIR);

    expect(prompts.getPromptProfileRoot('default')).toBe(REAL_PROMPT_STORAGE_DIR);
    // Captured before any mocking, and derived independently of the constant.
    expect(REAL_PROMPT_STORAGE_DIR).toBe(join(REPO_ROOT, 'prompt_storage'));
    // The live export now agrees, which is only true if the restore happened.
    expect(pathsNamespace.PROMPT_STORAGE_DIR).toBe(REAL_PROMPT_STORAGE_DIR);
    expect(prompts.PROMPT_PROFILES_DIR).toBe(join(REAL_PROMPT_STORAGE_DIR, 'profiles'));

    // And it is the root the resolver reads from, so a refactor cannot relocate
    // the default profile without breaking these.
    expect(prompts.resolvePromptPath('persona/identity.txt')).toBe(
      join(REAL_PROMPT_STORAGE_DIR, 'persona/identity.txt'),
    );
    expect(prompts.resolvePromptPath('config/triggers.json')).toBe(
      join(REAL_PROMPT_STORAGE_DIR, 'config/triggers.json'),
    );
    expect(prompts.getActivePromptProfileId()).toBe('default');
  });
});