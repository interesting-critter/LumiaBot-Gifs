/**
 * Prompt profiles must switch the **identity** — the first thing in the system
 * prompt — not just the files `prompts.ts` resolves on every call.
 *
 * THE BUG THIS PINS
 * -----------------
 * `utils/bot-definition.ts` assembled the persona once and memoised it in a bare
 * `string | null` whose only invalidation point was `reloadBotDefinition()`. The
 * profile system made `getBotIdentity()` a function of the active profile but
 * left that memo alone, so:
 *
 *   1. a turn is served under `default` → the definition is memoised;
 *   2. the operator selects profile `creative` → `prompts.ts` switches and
 *      `clearCache()` runs;
 *   3. `getBotIdentity()` correctly returns the creative persona, but
 *      `getBotDefinition()` — which `openai.ts:812` and `google-genai.ts:293,445`
 *      read for the `<identity>` block — still returns the default persona.
 *
 * Every other prompt file (reinforcement, guidelines, the untrusted-data clause)
 * followed the switch, which made it read as a half-wired feature rather than a
 * broken one: a profile containing only `persona/identity.txt` overrode nothing.
 * It self-healed only if the operator later saved a persona file through the
 * dashboard, because that path incidentally calls `reloadBotDefinition()`.
 *
 * WHAT IS ASSERTED
 * ----------------
 * A cold child process runs the real modules against a temporary prompt root and
 * emits a labelled transcript of every read. The parent asserts on that
 * transcript, so a failure names the exact step that diverged. Scenario
 * `overlay` covers the switch itself; scenario `example` covers an install with
 * no `profiles/` directory at all.
 *
 * WHY A SUBPROCESS
 * ----------------
 * `PROMPT_STORAGE_DIR` is a module-load constant anchored to `import.meta.dir`
 * and has no env override (`utils/paths.ts`), so it cannot be redirected in
 * process — only `mock.module` can, and a `mock.module` is **permanent for the
 * whole `bun test` process** and mutates the live namespace of the module it
 * replaces (`prompt-profiles.test.ts` documents both, and restores the real
 * exports by re-mocking at the end of that file). Redirecting the prompt root
 * from here would therefore leak a temp directory into every other suite, and
 * `bot-definition.ts` importing `'../services/prompts'` (no query string) would
 * resolve to a *different* `prompts` instance than any re-import this file could
 * make — so the memo under test and the resolver feeding it could not be the
 * same module pair. A child process gets a cold registry, proves the real
 * cold-start path end to end, and leaves nothing behind. `process.execPath` is
 * the running Bun binary, so this does not depend on `bun` being on `PATH`.
 * This is the same mechanism `example-fixtures.test.ts` and
 * `test-isolation.test.ts` already use for this exact constraint.
 *
 * FIXTURE DISCIPLINE
 * ------------------
 * Nothing is written under the real `prompt_storage/` (which is operator-private,
 * gitignored, and absent on a fresh checkout). Every fixture is built under
 * `os.tmpdir()` and removed afterwards; the only repository file read is
 * `prompt_storage.example/`, which is copied rather than modified.
 */

import { describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';

const EXAMPLE_DIR = resolve(REPO_ROOT, 'prompt_storage.example');

/** Profile id used by the overlay fixture; valid per `prompts.ts`' own rules. */
const PROFILE = 'creative';

const DEFAULT_IDENTITY = 'DEFAULT IDENTITY — you are the stock persona.';
const CREATIVE_IDENTITY = 'CREATIVE IDENTITY — you are the profile persona.';
const EDITED_IDENTITY = 'EDITED IDENTITY — written through the dashboard path.';

/** Pull the payload line out of stderr/stdout noise and parse it. */
const MARKER = '__TRANSCRIPT__';

type Transcript = Record<string, string>;

/**
 * The harness, run as a cold `bun` process.
 *
 * `root` is the prompt storage directory it should resolve against. Every value
 * it emits is the output of a **read**, recorded under a label that names the
 * step — so a diverging assertion in the parent can say which step went wrong
 * instead of only that two strings differ.
 *
 * Written inline rather than kept as a committed fixture so the sequence under
 * test — cache under `default`, switch, read, switch back, loop, edit, reload —
 * reads top to bottom in one place.
 */
function harnessSource(root: string, scenario: string): string {
  return `
import { mock } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const ROOT = ${JSON.stringify(root)};
const SCENARIO = ${JSON.stringify(scenario)};
const PROFILE = ${JSON.stringify(PROFILE)};
const MARKER = ${JSON.stringify(MARKER)};

const t = {};

// Same substitution a fresh operator performs: point the prompt root at the
// fixture before prompts.ts is ever evaluated. Everything downstream — including
// bot-definition.ts, which is imported through prompts.ts — picks this up.
mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: ROOT,
  DATA_DIR: ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(REPO, 'knowledge_documents'),
  dbPath: (name) => join(ROOT, name),
}));

const botDefinition = await import(join(REPO, 'src/utils/bot-definition.ts'));
const prompts = await import(join(REPO, 'src/services/prompts.ts'));

/** Record one read. Every assertion below is about the output of a read. */
function read(label, fn) {
  t[label] = String(fn());
  return t[label];
}

if (SCENARIO === 'overlay') {
  // ── 1. A turn served under \`default\`. This is what populates the definition
  //       cache in the first place, and it is the step whose absence made the
  //       original bug intermittent.
  read('profile.atStart', () => prompts.getActivePromptProfileId());
  read('def.default.cold', () => botDefinition.getBotDefinition());
  read('identity.default.cold', () => prompts.getBotIdentity());

  // ── 2. One profile switch. No \`reloadBotDefinition()\`, no dashboard save, no
  //       restart — exactly the operator sequence that used to leave the
  //       identity stale.
  prompts.setActivePromptProfileId(PROFILE);
  read('profile.afterSwitch', () => prompts.getActivePromptProfileId());

  // The resolver underneath switched, and the prompt cache was invalidated …
  read('identity.afterSwitch', () => prompts.getBotIdentity());
  // … so the control is unambiguous: if these two disagree, the defect is in the
  // definition memo, not in profile resolution.
  read('def.afterSwitch', () => botDefinition.getBotDefinition());

  // ── 3. Back to \`default\`: the definition must follow there too. A fix that
  //       only ever *adds* the new profile's text would pass the switch test and
  //       fail here.
  prompts.setActivePromptProfileId('default');
  read('profile.afterSwitchBack', () => prompts.getActivePromptProfileId());
  read('def.afterSwitchBack', () => botDefinition.getBotDefinition());

  // ── 4. Repeated switching. Each read must match the profile active at that
  //       moment, with no drift accumulating across cycles.
  for (let i = 0; i < 3; i++) {
    prompts.setActivePromptProfileId(PROFILE);
    read('loop.' + i + '.profile', () => botDefinition.getBotDefinition());
    prompts.setActivePromptProfileId('default');
    read('loop.' + i + '.default', () => botDefinition.getBotDefinition());
  }

  // ── 5. The \`PUT /api/persona\` path must not regress. The dashboard writes the
  //       file and calls \`reloadBotDefinition()\`; here that is done by hand.
  //       First: edit behind the cache's back and read WITHOUT reloading. This
  //       asserts the cache still exists — it is a deliberate per-turn saving,
  //       not an oversight — and that it is now keyed on something that moves.
  const identityPath = join(ROOT, 'persona/identity.txt');
  const before = readFileSync(identityPath, 'utf-8');
  writeFileSync(identityPath, ${JSON.stringify(EDITED_IDENTITY)}, 'utf-8');
  read('def.afterDiskEditNoReload', () => botDefinition.getBotDefinition());

  // Then the dashboard's own call, which must produce the new bytes immediately.
  read('def.afterReloadBotDefinition', () => botDefinition.reloadBotDefinition());

  // Same for the profile's copy, so the reload path is not default-only. The
  // switch happens *first* and a baseline is read, otherwise the switch's own
  // invalidation would make the un-reloaded read look like it had re-read disk.
  const profileIdentityPath = join(ROOT, 'profiles', PROFILE, 'persona/identity.txt');
  const profileBefore = readFileSync(profileIdentityPath, 'utf-8');
  prompts.setActivePromptProfileId(PROFILE);
  read('def.profile.baseline', () => botDefinition.getBotDefinition());
  writeFileSync(profileIdentityPath, 'CREATIVE IDENTITY — edited.', 'utf-8');
  read('def.profile.afterDiskEditNoReload', () => botDefinition.getBotDefinition());
  read('def.profile.afterReloadBotDefinition', () => botDefinition.reloadBotDefinition());

  // Hand the files back before the parent inspects nothing, and so the fixture
  // is consistent with whatever the transcript claims about it.
  writeFileSync(identityPath, before, 'utf-8');
  writeFileSync(profileIdentityPath, profileBefore, 'utf-8');
} else if (SCENARIO === 'example') {
  // An install with no \`profiles/\` directory: the pre-feature layout.
  read('profile.atStart', () => prompts.getActivePromptProfileId());
  read('profiles.listed', () => JSON.stringify(prompts.listPromptProfiles()));
  read('def.first', () => botDefinition.getBotDefinition());
  read('def.second', () => botDefinition.getBotDefinition());
  read('identity.first', () => prompts.getBotIdentity());
  // Selecting the reserved id must be a no-op that still works.
  prompts.setActivePromptProfileId('default');
  read('def.afterReselectDefault', () => botDefinition.getBotDefinition());
  read('def.afterReload', () => botDefinition.reloadBotDefinition());
} else {
  throw new Error('unknown scenario ' + SCENARIO);
}

console.log(MARKER + JSON.stringify(t));
`;
}

/** Run the harness in a cold process and return its transcript. */
function runHarness(root: string, scenario: string): Transcript {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-def-harness-'));
  const harnessPath = join(dir, 'probe.ts');

  try {
    writeFileSync(harnessPath, harnessSource(root, scenario), 'utf-8');

    const proc = Bun.spawnSync([process.execPath, 'run', harnessPath], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();

    if (proc.exitCode !== 0) {
      throw new Error(
        `harness (${scenario}) exited ${proc.exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }

    const line = stdout.split('\n').find((l) => l.startsWith(MARKER));
    if (line === undefined) {
      throw new Error(
        `harness (${scenario}) produced no ${MARKER} line\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }

    return JSON.parse(line.slice(MARKER.length)) as Transcript;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write `content` at `relativePath` inside `root`, creating parent directories. */
function writeFixture(root: string, relativePath: string, content: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

/**
 * Root with a `default` tree plus one profile that overrides exactly one file —
 * the documented shape, and the one that silently did nothing before the fix.
 */
function makeOverlayRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-def-overlay-'));
  writeFixture(root, 'persona/identity.txt', DEFAULT_IDENTITY);
  writeFixture(root, 'persona/reinforcement.txt', 'DEFAULT REINFORCEMENT');
  writeFixture(root, join('profiles', PROFILE, 'persona/identity.txt'), CREATIVE_IDENTITY);
  return root;
}

/** A copy of the shipped example tree, which has no `profiles/` directory. */
function makeExampleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-def-example-'));
  cpSync(EXAMPLE_DIR, root, { recursive: true });
  return root;
}

const scratchDirs: string[] = [];

function tracked(dir: string): string {
  scratchDirs.push(dir);
  return dir;
}

describe('an active profile switch changes the cached bot definition', () => {
  const root = tracked(makeOverlayRoot());
  const t = runHarness(root, 'overlay');

  test('the definition cache is populated under the default profile', () => {
    expect(t['profile.atStart']).toBe('default');
    expect(t['def.default.cold']).toBe(DEFAULT_IDENTITY);
    expect(t['identity.default.cold']).toBe(DEFAULT_IDENTITY);
  });

  test('one switch is enough: the definition follows, with no reload and no restart', () => {
    // THE REGRESSION. Against the unfixed code `def.afterSwitch` is
    // DEFAULT_IDENTITY while `identity.afterSwitch` is CREATIVE_IDENTITY: the
    // resolver moved and the memo did not.
    expect(t['profile.afterSwitch']).toBe(PROFILE);
    expect(t['identity.afterSwitch']).toBe(CREATIVE_IDENTITY);
    expect(t['def.afterSwitch']).toBe(CREATIVE_IDENTITY);
  });

  test('switching back to default restores the default definition', () => {
    expect(t['profile.afterSwitchBack']).toBe('default');
    expect(t['def.afterSwitchBack']).toBe(DEFAULT_IDENTITY);
  });

  test('repeated switches never accumulate stale state', () => {
    for (let i = 0; i < 3; i++) {
      expect(t[`loop.${i}.profile`]).toBe(CREATIVE_IDENTITY);
      expect(t[`loop.${i}.default`]).toBe(DEFAULT_IDENTITY);
    }
  });

  test('the cache still caches: a disk edit is invisible until it is invalidated', () => {
    // If this ever becomes "sees the edit", the per-turn saving has been lost
    // and the fix worked by deleting the cache — which is not the fix.
    expect(t['def.afterDiskEditNoReload']).toBe(DEFAULT_IDENTITY);
  });

  test('PUT /api/persona still works: reloadBotDefinition() applies the edit at once', () => {
    expect(t['def.afterReloadBotDefinition']).toBe(EDITED_IDENTITY);
  });

  test('the same reload path works under a profile, not only under default', () => {
    expect(t['def.profile.baseline']).toBe(CREATIVE_IDENTITY);
    expect(t['def.profile.afterDiskEditNoReload']).toBe(CREATIVE_IDENTITY);
    expect(t['def.profile.afterReloadBotDefinition']).toBe('CREATIVE IDENTITY — edited.');
  });
});

describe('an install with no profiles configured behaves exactly as before', () => {
  const root = tracked(makeExampleRoot());
  const t = runHarness(root, 'example');

  test('default is the only profile and the definition matches the shipped fixture', () => {
    expect(t['profile.atStart']).toBe('default');
    expect(t['profiles.listed']).toBe('["default"]');

    // Expected bytes are read from the checked-in `prompt_storage.example/`
    // tree, not from the temp copy, so this pins the shipped fixture itself.
    const expected = readFileSync(join(EXAMPLE_DIR, 'persona/identity.txt'), 'utf-8')
      .trim()
      // `{botName}` is substituted by the default template variables …
      .replace(/\{botName\}/g, 'Bad Kitty')
      // … and the council block is stripped, as `getBotIdentity()` always has.
      .replace(/<council-profile>[\s\S]*?<\/council-profile>/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    expect(t['identity.first']).toBe(expected);
    expect(t['def.first']).toBe(expected);
  });

  test('repeated reads are stable, and reloading changes nothing', () => {
    expect(t['def.second']).toBe(t['def.first']);
    expect(t['def.afterReselectDefault']).toBe(t['def.first']);
    expect(t['def.afterReload']).toBe(t['def.first']);
  });
});

describe('fixture hygiene', () => {
  test('no fixture was written under the repository prompt tree', () => {
    // `prompt_storage/` is operator-private and gitignored; it must not appear
    // because of this suite.
    expect(existsSync(join(REPO_ROOT, 'prompt_storage'))).toBe(false);
  });

  test('the harness left no scratch directories behind', () => {
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(scratchDirs.every((d) => !existsSync(d))).toBe(true);
  });
});
