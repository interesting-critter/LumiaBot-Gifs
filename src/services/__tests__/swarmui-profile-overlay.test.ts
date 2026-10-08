/**
 * `swarmui.ts` must resolve all three of its config files through the active
 * prompt profile, exactly as `prompts.ts` does.
 *
 * THE BUG THIS PINS
 * -----------------
 * `SwarmUIService.getConfig()` guarded its loader with an existence pre-check:
 *
 *     if (existsSync(join(PROMPT_STORAGE_DIR, CONFIG_PATH))) {
 *       value = loadJsonFile<SwarmConfig>(CONFIG_PATH);
 *     }
 *
 * `PROMPT_STORAGE_DIR` is the **default** root. The line under it is
 * `loadJsonFile`, which *is* profile-aware (it resolves through
 * `resolvePromptPath`). So the guard and the load disagreed about which file
 * they were talking about:
 *
 *   1. operator writes `config/swarm_cfg.json` under a profile;
 *   2. operator selects that profile;
 *   3. `isConfigured()` reports **false** — SwarmUI silently absent, the
 *      `generate_selfie` tool never offered — while the very next statement
 *      would have resolved and read that exact file.
 *
 * It is a one-line, self-contradicting defect: the guard proves the file's
 * absence in a directory the loader was never going to ask. It hid because the
 * common install has the file at the default root, where both paths agree.
 *
 * The other two files (`config/image_prompt_pos.txt`,
 * `config/image_prompt_neg.txt`) go through `loadTextFile`, which is already
 * profile-aware. They are asserted here anyway, because "already correct" is
 * exactly the kind of thing a future refactor silently regresses when the
 * surrounding code is re-derived from `PROMPT_STORAGE_DIR`.
 *
 * WHAT IS NOT ASSERTED
 * --------------------
 * Scenario `override` reads `isConfigured()` immediately after each switch, which
 * is only correct if the cache's `(profile, generation)` invalidation still
 * happens — a fix that dropped the cache would still pass, and one that broke the
 * generation key would not.
 *
 * Scenario `perGuild` is a separate pin: the same 30s cache, but with two guilds
 * on two different profiles alternating *inside a single window*. That is the
 * cross-talk the `(profile, generation)` key exists to prevent, and it is
 * invisible to any test that only ever switches the main selection, because a
 * switch also moves the generation.
 *
 * WHY A SUBPROCESS
 * ----------------
 * `PROMPT_STORAGE_DIR` is a module-load constant anchored to `import.meta.dir`
 * with no env override (`utils/paths.ts`), so it cannot be redirected in
 * process. `mock.module` would work but is **permanent for the whole `bun test`
 * process** and mutates the live namespace of the module it replaces
 * (`prompt-profiles.test.ts` documents both, and restores the real exports by
 * re-mocking at the end of that file) — so a leaked temp directory would follow
 * this suite into every other one. A cold child gets a clean registry, proves
 * the real cold-start path end to end, and leaves nothing behind.
 * `process.execPath` is the running Bun binary, so this does not depend on
 * `bun` being on `PATH`. Same mechanism as `prompt-profile-identity.test.ts`
 * and `example-fixtures.test.ts`.
 *
 * FIXTURE DISCIPLINE
 * ------------------
 * Nothing is written under the real `prompt_storage/` (operator-private,
 * gitignored, absent on a fresh checkout). Every fixture is built under
 * `os.tmpdir()` and removed afterwards. `prompt_storage.example/` is read, never
 * written.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';

/** Profile id used by every fixture; valid per `prompts.ts`'s own rules. */
const PROFILE = 'art';

const MARKER = '__TRANSCRIPT__';

type Transcript = Record<string, string>;

const CONFIG_PATH = 'config/swarm_cfg.json';
const POS_PATH = 'config/image_prompt_pos.txt';
const NEG_PATH = 'config/image_prompt_neg.txt';

const PROFILE_BASE_URL = 'http://art.invalid:7801';
const DEFAULT_BASE_URL = 'http://default.invalid:7801';
const PROFILE_B_BASE_URL = 'http://wisp.invalid:7801';

/**
 * The harness, run as a cold `bun` process.
 *
 * `root` is the prompt storage directory it resolves against. Every value it
 * emits is the output of a real read, recorded under a label naming the step,
 * so a diverging assertion says *which* step went wrong.
 *
 * Written inline rather than kept as a committed fixture so the sequence under
 * test — cold start under `default`, read, switch, read, switch back — reads top
 * to bottom in one place.
 */
function harnessSource(root: string, scenario: string): string {
  return `
import { mock } from 'bun:test';
import { join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const ROOT = ${JSON.stringify(root)};
const SCENARIO = ${JSON.stringify(scenario)};
const PROFILE = ${JSON.stringify(PROFILE)};
const PROFILE_B = ${JSON.stringify(PROFILE_B)};
const GUILD_A = ${JSON.stringify(GUILD_A)};
const GUILD_B = ${JSON.stringify(GUILD_B)};
const MARKER = ${JSON.stringify(MARKER)};
const CONFIG_PATH = ${JSON.stringify(CONFIG_PATH)};
const POS_PATH = ${JSON.stringify(POS_PATH)};
const NEG_PATH = ${JSON.stringify(NEG_PATH)};

const t = {};

// Same substitution a fresh operator performs: point the prompt root at the
// fixture before either module is ever evaluated. \`swarmui.ts\` imports
// \`PROMPT_STORAGE_DIR\` from this file, so the defect under test sees the mock.
mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: ROOT,
  DATA_DIR: ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(REPO, 'knowledge_documents'),
  dbPath: (name) => join(ROOT, name),
}));

const prompts = await import(join(REPO, 'src/services/prompts.ts'));
const { swarmUIService } = await import(join(REPO, 'src/services/swarmui.ts'));

function read(label, fn) {
  t[label] = String(fn());
  return t[label];
}

// \`loadTextFile\` warns on a missing file; report that as a value, not a crash.
function text(relativePath) {
  const value = prompts.loadTextFile(relativePath);
  return value === null ? '(null)' : value;
}

read('profile.atStart', () => prompts.getActivePromptProfileId());

// ── Cold start under \`default\`. Whatever the fixture's default root holds is
//    what the bot sees before any profile is selected.
const genAtStart = prompts.getPromptCacheGeneration();
read('generation.atStart', () => genAtStart);
read('resolved.cfg.default', () => prompts.resolvePromptPath(CONFIG_PATH));
read('configured.default', () => swarmUIService.isConfigured());
read('pos.default', () => text(POS_PATH));
read('neg.default', () => text(NEG_PATH));

// ── The switch. \`setActivePromptProfileId\` clears the prompt cache, which bumps
//    the generation — the invalidation the swarmui config cache keys on.
prompts.setActivePromptProfileId(PROFILE);
read('profile.afterSwitch', () => prompts.getActivePromptProfileId());

read('generation.afterSwitch', () => prompts.getPromptCacheGeneration());
read('resolved.cfg.profile', () => prompts.resolvePromptPath(CONFIG_PATH));
read('resolved.pos.profile', () => prompts.resolvePromptPath(POS_PATH));
read('resolved.neg.profile', () => prompts.resolvePromptPath(NEG_PATH));

// THE REGRESSION. Against the unfixed code this is \`false\` under both fixtures:
// the pre-check probes the default root, finds nothing there, and never asks
// the resolver which file it would actually have read.
read('configured.profile', () => swarmUIService.isConfigured());
read('pos.profile', () => text(POS_PATH));
read('neg.profile', () => text(NEG_PATH));

// ── Back to \`default\`: a fix that only ever *adds* the profile's config would
//    pass the switch above and fail here.
prompts.setActivePromptProfileId('default');
read('profile.afterSwitchBack', () => prompts.getActivePromptProfileId());
read('configured.afterSwitchBack', () => swarmUIService.isConfigured());

read('generationMoved', () => prompts.getPromptCacheGeneration() > genAtStart);

if (SCENARIO === 'perGuild') {
  // ══ PER-GUILD CROSS-TALK ═══════════════════════════════════════════════════
  // The guild→profile lookup is injected rather than imported (\`prompts.ts\` is a
  // leaf module; see its DEPENDENCY DIRECTION note), so the harness stands one in
  // exactly as the composition root does.
  prompts.setGuildProfileResolver((guildId) =>
    guildId === GUILD_A ? PROFILE : guildId === GUILD_B ? PROFILE_B : 'default');

  // The apiUrl the *loader* actually opened, which is stronger evidence than
  // a boolean: it names the file the value came from.
  function apiUrlOf() {
    // \`getConfig()\` is private, and it should stay that way: the only thing
    // under test is what a *public* caller sees through the cache, and a
    // test-only accessor would be a second thing to keep correct. Bracket
    // access is how this harness reads the one thing \`isConfigured()\` hides.
    const cfg = swarmUIService['getConfig']();
    return cfg === null ? '(null)' : String(cfg.apiUrl ?? '(none)');
  }

  const genBefore = prompts.getPromptCacheGeneration();

  read('configured.default', () => swarmUIService.isConfigured());

  // ── Round one, alternating. Nothing here moves the generation counter or the
  //    main selection, so the profile half of the cache key is all there is.
  read('profile.guildA', () => prompts.runWithPromptContext(GUILD_A, () =>
    prompts.getEffectivePromptProfileId()));
  read('configured.guildA.1', () => prompts.runWithPromptContext(GUILD_A, () =>
    swarmUIService.isConfigured()));
  read('apiUrl.guildA', () => prompts.runWithPromptContext(GUILD_A, apiUrlOf));

  read('profile.guildB', () => prompts.runWithPromptContext(GUILD_B, () =>
    prompts.getEffectivePromptProfileId()));
  read('configured.guildB.1', () => prompts.runWithPromptContext(GUILD_B, () =>
    swarmUIService.isConfigured()));
  read('apiUrl.guildB', () => prompts.runWithPromptContext(GUILD_B, apiUrlOf));

  // ── Round two, same order.
  read('configured.guildA.2', () => prompts.runWithPromptContext(GUILD_A, () =>
    swarmUIService.isConfigured()));
  read('apiUrl.guildA.2', () => prompts.runWithPromptContext(GUILD_A, apiUrlOf));
  read('configured.guildB.2', () => prompts.runWithPromptContext(GUILD_B, () =>
    swarmUIService.isConfigured()));

  // ── Round three, reversed: the ordering a shared single slot gets wrong in
  //    the other direction.
  read('configured.guildB.3', () => prompts.runWithPromptContext(GUILD_B, () =>
    swarmUIService.isConfigured()));
  read('configured.guildA.3', () => prompts.runWithPromptContext(GUILD_A, () =>
    swarmUIService.isConfigured()));

  // Proves the two halves of the key really are both required: if the profile
  // half were absent the reads above would have been served from one entry, and
  // if the generation half were absent this could not be true either.
  read('generationHeld', () => prompts.getPromptCacheGeneration() === genBefore);

  // ── Outside any wrapper: back to the main selection. A guild-less caller must
  //    not inherit whichever guild happened to run last.
  read('effective.outsideAnyWrapper', () => prompts.getEffectivePromptProfileId());
  read('configured.outsideAnyWrapper', () => swarmUIService.isConfigured());
}

console.log(MARKER + JSON.stringify(t));
`;
}

/** Run the harness in a cold process and return its transcript. */
function runHarness(root: string, scenario: string): Transcript {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-swarmui-harness-'));
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
 * Fixture A — the exact shape the defect needs: the default root has **no**
 * `config/swarm_cfg.json`, the profile has one.
 *
 * The positive/negative prompt templates are split the same way, so the second
 * pair of files is exercised under the identical conditions.
 */
function makeProfileOnlyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-swarmui-profile-only-'));
  // Deliberately absent from the default root: `config/swarm_cfg.json`,
  // `config/image_prompt_pos.txt`, `config/image_prompt_neg.txt`.
  writeFixture(root, join('profiles', PROFILE, CONFIG_PATH), JSON.stringify({
    apiUrl: PROFILE_BASE_URL,
  }));
  writeFixture(root, join('profiles', PROFILE, POS_PATH), 'PROFILE POSITIVE');
  writeFixture(root, join('profiles', PROFILE, NEG_PATH), 'PROFILE NEGATIVE');
  return root;
}

/**
 * Fixture B — both roots have a config, and they disagree.
 *
 * This is what proves *provenance*: `true` under the profile cannot be explained
 * by "some file was found somewhere", because the default root's own file says
 * `enabled: false`.
 */
function makeOverrideRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-swarmui-override-'));
  writeFixture(root, CONFIG_PATH, JSON.stringify({ enabled: false, apiUrl: DEFAULT_BASE_URL }));
  writeFixture(root, POS_PATH, 'DEFAULT POSITIVE');
  writeFixture(root, NEG_PATH, 'DEFAULT NEGATIVE');
  writeFixture(root, join('profiles', PROFILE, CONFIG_PATH), JSON.stringify({
    enabled: true,
    apiUrl: PROFILE_BASE_URL,
  }));
  writeFixture(root, join('profiles', PROFILE, POS_PATH), 'PROFILE POSITIVE');
  writeFixture(root, join('profiles', PROFILE, NEG_PATH), 'PROFILE NEGATIVE');
  return root;
}

/**
 * Fixture C — the shape the per-guild scenario needs, and the one that makes a
 * shared cache entry impossible to confuse for a correct answer.
 *
 * Three different answers are reachable:
 *
 *   default        → no file at all              → `isConfigured() === false`
 *   `art` (A)      → `{ enabled: true }`         → `isConfigured() === true`
 *   `wisp` (B)     → `{ enabled: false }`        → `isConfigured() === false`
 *
 * `wisp` writing an explicit `enabled: false` is deliberate. It distinguishes
 * "profile B's config says no" from "no config was found", and it makes the
 * cross-talk regression *detectable in the opposite direction* too: a cache that
 * latched onto A's `true` entry fails on B, and one that latched onto `default`'s
 * `null` fails on A.
 */
function makePerGuildRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-swarmui-per-guild-'));
  writeFixture(root, join('profiles', PROFILE, CONFIG_PATH), JSON.stringify({
    enabled: true,
    apiUrl: PROFILE_BASE_URL,
  }));
  writeFixture(root, join('profiles', PROFILE_B, CONFIG_PATH), JSON.stringify({
    enabled: false,
    apiUrl: PROFILE_B_BASE_URL,
  }));
  return root;
}

const scratchDirs: string[] = [];

function tracked(dir: string): string {
  scratchDirs.push(dir);
  return dir;
}

describe('SwarmUI honours the active prompt profile for config/swarm_cfg.json', () => {
  const root = tracked(makeProfileOnlyRoot());
  const t = runHarness(root, 'profileOnly');

  test('the default root genuinely has no config, so "false" there is correct', () => {
    // Control: without this, `configured.default === false` could just be a
    // fixture that was built wrong.
    expect(t['profile.atStart']).toBe('default');
    expect(t['resolved.cfg.default']).toBe(join(root, CONFIG_PATH));
    expect(t['configured.default']).toBe('false');
  });

  test('THE REGRESSION: selecting the profile makes SwarmUI configured', () => {
    // The resolver points at the profile's file …
    expect(t['profile.afterSwitch']).toBe(PROFILE);
    expect(t['resolved.cfg.profile']).toBe(join(root, 'profiles', PROFILE, CONFIG_PATH));
    // … so the existence pre-check must agree, and report configured.
    // Unfixed: `false`, because it probed `join(root, CONFIG_PATH)` — a path the
    // loader was never going to read.
    expect(t['configured.profile']).toBe('true');
  });

  test('switching back to default un-configures it again', () => {
    // A fix that only ever *adds* a profile's config would pass the test above
    // and fail here.
    expect(t['profile.afterSwitchBack']).toBe('default');
    expect(t['configured.afterSwitchBack']).toBe('false');
  });

  test('the profile switch still invalidates the swarmui config cache', () => {
    // The cache is keyed on `(profile, generation)`, so reading
    // `isConfigured()` immediately after a switch cannot be served from the
    // previous profile's entry. Deliberately unchanged by the fix.
    expect(t['generationMoved']).toBe('true');
  });
});

/**
 * THE PER-GUILD CROSS-TALK PIN
 * ---------------------------
 * Every other scenario here drives the *main* selection, which means it also
 * moves `getPromptCacheGeneration()` — so those scenarios pass even against a
 * cache keyed on the generation alone. They therefore prove nothing about two
 * guilds, and this one exists for that.
 *
 * The scenario below runs two guilds on two profiles through
 * `runWithPromptContext()` and reads `isConfigured()` on each, repeatedly and
 * with no switch in between — so the generation counter is provably constant for
 * the whole sequence and the *only* thing that can keep the two apart is the
 * profile half of the cache key. Against the previous single-slot
 * `(expiresAt, generation)` cache, whichever guild read first wins for the next
 * 30 seconds: guild A reports SwarmUI's status from guild B's `swarm_cfg.json`.
 */
const PROFILE_B = 'wisp';
const GUILD_A = '111111111111111678';
const GUILD_B = '222222222222222678';

describe('two guilds on two profiles do not share the 30s swarm_cfg.json cache', () => {
  // Default root: no config at all. Profile A: configured. Profile B:
  // explicitly NOT configured. So `true`/`false`/`true` is a three-way answer
  // that can only come from three distinct reads.
  const root = tracked(makePerGuildRoot());
  const t = runHarness(root, 'perGuild');

  test('the fixture really has three different answers to give', () => {
    // Control, so a wrongly-built fixture cannot make the assertions below pass
    // or fail for the wrong reason.
    expect(t['resolved.cfg.default']).toBe(join(root, CONFIG_PATH));
    expect(existsSync(join(root, CONFIG_PATH))).toBe(false);
    expect(t['configured.default']).toBe('false');
  });

  test('THE REGRESSION: interleaved guilds each read their own profile', () => {
    expect(t['generationHeld']).toBe('true');
    expect(t['profile.guildA']).toBe(PROFILE);
    expect(t['profile.guildB']).toBe(PROFILE_B);

    expect(t['configured.guildA.1']).toBe('true');
    expect(t['configured.guildB.1']).toBe('false');

    // Round two, same order again. If the cache were keyed on the generation
    // alone these would repeat round one's answers.
    expect(t['configured.guildA.2']).toBe('true');
    expect(t['configured.guildB.2']).toBe('false');

    // And reversed order, which is the ordering a shared slot gets wrong in the
    // other direction.
    expect(t['configured.guildB.3']).toBe('false');
    expect(t['configured.guildA.3']).toBe('true');
  });

  test('each guild\'s config really did resolve to its own profile\'s file', () => {
    // Provenance, not just "an answer came back": the apiUrl is read out of
    // whichever file the loader opened, so this cannot be satisfied by any
    // single cached entry.
    expect(t['apiUrl.guildA']).toBe(PROFILE_BASE_URL);
    expect(t['apiUrl.guildB']).toBe(PROFILE_B_BASE_URL);
    expect(t['apiUrl.guildA.2']).toBe(PROFILE_BASE_URL);
  });

  test('a guild-less read still gets the main selection, not whichever guild ran last', () => {
    expect(t['effective.outsideAnyWrapper']).toBe('default');
    expect(t['configured.outsideAnyWrapper']).toBe('false');
  });
});

describe('a profile config overrides the default root rather than merging into it', () => {
  const root = tracked(makeOverrideRoot());
  const t = runHarness(root, 'override');

  test('the value that is loaded is the profile\'s, not merely "a" config', () => {
    expect(t['profile.atStart']).toBe('default');
    expect(t['resolved.cfg.default']).toBe(join(root, CONFIG_PATH));
    // Default says `enabled: false`.
    expect(t['configured.default']).toBe('false');

    // The profile says `enabled: true`. If the loader had kept reading the
    // default root this would still be `false`.
    expect(t['profile.afterSwitch']).toBe(PROFILE);
    expect(t['resolved.cfg.profile']).toBe(join(root, 'profiles', PROFILE, CONFIG_PATH));
    expect(t['configured.profile']).toBe('true');
  });

  test('and it is not a one-way latch: default is restored on the way back', () => {
    expect(t['configured.afterSwitchBack']).toBe('false');
  });
});

describe('the image prompt templates resolve through the profile too', () => {
  test('a profile-only template is found, and the default root falls back to null', () => {
    const root = tracked(makeProfileOnlyRoot());
    const t = runHarness(root, 'profileOnly');

    expect(t['pos.default']).toBe('(null)');
    expect(t['neg.default']).toBe('(null)');

    expect(t['resolved.pos.profile']).toBe(join(root, 'profiles', PROFILE, POS_PATH));
    expect(t['resolved.neg.profile']).toBe(join(root, 'profiles', PROFILE, NEG_PATH));
    expect(t['pos.profile']).toBe('PROFILE POSITIVE');
    expect(t['neg.profile']).toBe('PROFILE NEGATIVE');
  });

  test('an override is per file, so each template can come from a different root', () => {
    const root = tracked(makeOverrideRoot());
    const t = runHarness(root, 'override');

    expect(t['pos.default']).toBe('DEFAULT POSITIVE');
    expect(t['pos.profile']).toBe('PROFILE POSITIVE');
    expect(t['neg.default']).toBe('DEFAULT NEGATIVE');
    expect(t['neg.profile']).toBe('PROFILE NEGATIVE');
  });
});

describe('fixture hygiene', () => {
  test('no fixture was written under the repository prompt tree', () => {
    // `prompt_storage/` is operator-private and gitignored; it must not appear
    // because of this suite.
    expect(existsSync(resolve(REPO_ROOT, 'prompt_storage'))).toBe(false);
  });

  test('the harness left no scratch directories behind', () => {
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(scratchDirs.some((d) => existsSync(d))).toBe(false);
  });
});