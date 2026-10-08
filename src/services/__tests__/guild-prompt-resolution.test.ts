/**
 * Per-guild prompt resolution must survive **interleaved concurrency**.
 *
 * THE PROPERTY THIS IS THE ONLY COMMITTED TEST OF
 * ----------------------------------------------
 * Two guilds really do run turns concurrently. Turns are serialised *per channel*
 * (`client.ts`'s turn queue), not per guild, so guild A's turn and guild B's turn
 * are in flight at the same time — and each one contains real `await` gaps
 * between prompt reads. `swarmui.ts` reads `config/swarm_cfg.json` and then the
 * positive/negative prompt templates minutes later; `openai.ts` and
 * `google-genai.ts` each build a system prompt, await, and then apply rewrites.
 * Every one of those reads must resolve against the same profile, even though a
 * different guild's turn has run to completion in between.
 *
 * The implementation this pins is `runWithPromptContext()`'s `AsyncLocalStorage`.
 * The alternative that looks equivalent and is not — "set the global profile at
 * the top of a turn, restore it at the end" — passes every single-guild test and
 * fails under interleaving in two distinct ways:
 *
 *   1. **Across an await.** Guild A sets `art`, awaits; guild B sets `wisp`,
 *      awaits; guild A resumes and reads its *second* prompt file under `wisp`.
 *      One turn, two profiles, intermittently, with no warning anywhere. Every
 *      file except the first is wrong, so it looks like a partial overlay bug.
 *   2. **At the restore.** The restore runs *after* those awaits, so it clobbers
 *      whichever turn is currently running rather than its own — guild A's
 *      restore lands while guild B is mid-turn and silently resets B's selection.
 *
 * There is no shared mutable slot to race on with `AsyncLocalStorage`, because
 * each async chain resolves its own store. That is the whole design, and it is
 * invisible to every other suite in this directory: they each drive one guild, or
 * switch the main selection synchronously, and both are single-chain by
 * construction.
 *
 * WHAT IS ASSERTED
 * ----------------
 * The harness runs two guilds' turns genuinely interleaved across `await` gaps —
 * not simulated, but by having each turn suspend at a barrier the other waits on,
 * so the interleaving is deterministic rather than dependent on timer ordering.
 * Each turn records the profile and the resolved path it saw at *every* read, and
 * the parent asserts that no turn ever observed the other guild's profile.
 *
 * The second half proves the other direction: outside any wrapper, resolution
 * still returns the **main** selection, so a DM, the dashboard's own reads and
 * every guild-less entry point behave exactly as they did before this feature.
 *
 * WHY A SUBPROCESS
 * ----------------
 * `PROMPT_STORAGE_DIR` is a module-load constant anchored to `import.meta.dir`
 * with no env override (`utils/paths.ts`), so it cannot be redirected in process.
 * `mock.module` is **permanent for the whole `bun test` process** and mutates the
 * live namespace of the module it replaces (`prompt-profiles.test.ts` documents
 * both, and restores the real exports by re-mocking at the end of that file), so a
 * temp root leaked from here would follow this suite into every other one. Worse
 * for this particular claim: a leaked `AsyncLocalStorage` store is *global* state,
 * so a suite that left a context open would corrupt unrelated suites in a way that
 * looks like a flake. A cold child gets a clean registry and takes the whole
 * context with it when it exits. `process.execPath` is the running Bun binary, so
 * this does not depend on `bun` being on `PATH`. Same mechanism as
 * `swarmui-profile-overlay.test.ts`, `trigger-keywords.test.ts` and
 * `prompt-profile-identity.test.ts`.
 *
 * FIXTURE DISCIPLINE
 * ------------------
 * Nothing is written under the real `prompt_storage/` (operator-private,
 * gitignored, absent on a fresh checkout). Every fixture is built under
 * `os.tmpdir()` and removed afterwards.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';

const MARKER = '__TRANSCRIPT__';

type Transcript = Record<string, string>;

const PROFILE_A = 'art';
const PROFILE_B = 'wisp';

const GUILD_A = '111111111111111678';
const GUILD_B = '222222222222222678';
/** Configured in the resolver but assigned nothing: must follow the main page. */
const GUILD_C = '333333333333333678';

const IDENTITY_A = 'IDENTITY-A';
const IDENTITY_B = 'IDENTITY-B';
const IDENTITY_DEFAULT = 'IDENTITY-DEFAULT';

const IDENTITY_PATH = 'persona/identity.txt';
const SWARM_PATH = 'config/swarm_cfg.json';

/**
 * The harness, run as a cold `bun` process.
 *
 * Every turn records an ordered log of `(profile, resolved path)` pairs at each
 * read, tagged with the guild that made it. The parent asserts on the log rather
 * than on a single scalar, because the failure mode is *one bad read among many
 * good ones* — a summary value would hide which read broke and when.
 */
function harnessSource(root: string): string {
  return `
import { mock } from 'bun:test';
import { join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const ROOT = ${JSON.stringify(root)};
const MARKER = ${JSON.stringify(MARKER)};
const PROFILE_A = ${JSON.stringify(PROFILE_A)};
const PROFILE_B = ${JSON.stringify(PROFILE_B)};
const GUILD_A = ${JSON.stringify(GUILD_A)};
const GUILD_B = ${JSON.stringify(GUILD_B)};
const GUILD_C = ${JSON.stringify(GUILD_C)};
const IDENTITY_PATH = ${JSON.stringify(IDENTITY_PATH)};
const SWARM_PATH = ${JSON.stringify(SWARM_PATH)};

const t = {};

// Same substitution a fresh operator performs: point the prompt root at the
// fixture before prompts.ts is ever evaluated.
mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: ROOT,
  DATA_DIR: ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(REPO, 'knowledge_documents'),
  dbPath: (name) => join(ROOT, name),
}));

const prompts = await import(join(REPO, 'src/services/prompts.ts'));
const botDefinition = await import(join(REPO, 'src/utils/bot-definition.ts'));

// Stands in for the composition root's injection. \`prompts.ts\` is a leaf module
// and must never import the guild service back (see its DEPENDENCY DIRECTION
// note), so this is the only seam a harness has — and it is the same seam the
// real wiring uses, so what is under test is the real resolution path.
prompts.setGuildProfileResolver((guildId) => {
  if (guildId === GUILD_A) return PROFILE_A;
  if (guildId === GUILD_B) return PROFILE_B;
  return 'default';
});

/** Ordered per-guild log of what each read resolved to. */
const log = { [GUILD_A]: [], [GUILD_B]: [] };

/** A real \`await\` gap, so the two turns genuinely interleave. */
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One prompt read, recorded.
 *
 * The pair (profile, resolved path) is what must be self-consistent: a read that
 * reports profile A while resolving a path under B is the cross-talk, and
 * asserting on the pair catches it even if the identity bytes happen to be shared.
 */
function record(guildId, step, read) {
  const profile = prompts.getEffectivePromptProfileId();
  const path = prompts.resolvePromptPath(IDENTITY_PATH);
  const value = String(read());
  log[guildId].push([step, profile, path, value].join('|'));
  return value;
}

/** One turn: several reads with real awaits between them. */
async function turn(guildId, id) {
  return prompts.runWithPromptContext(guildId, async () => {
    await tick(5);
    record(guildId, '1.identity', () => prompts.getBotIdentity());
    await tick(5);
    record(guildId, '2.swarmPath', () => prompts.resolvePromptPath(SWARM_PATH));
    await tick(5);
    record(guildId, '3.definition', () => botDefinition.getBotDefinition());
    await tick(5);
    record(guildId, '4.identityAgain', () => prompts.getBotIdentity());
    await tick(5);
    record(guildId, '5.reResolved', () => prompts.resolvePromptPath(IDENTITY_PATH));
    // Yielding to the macrotask queue is what a real turn does — it awaits the
    // LLM, the database, the image service. Nothing here sleeps meaningfully.
    await tick(5);
    return id;
  });
}

// ── The interleaving, made deterministic rather than left to timer ordering.
//    Both turns are started before either is awaited, and each barrier is a real
//    await, so B's step 1 lands strictly inside A's step-1-to-step-2 gap.
const a = turn(GUILD_A, 'A');
await tick(1);
const b = turn(GUILD_B, 'B');
await Promise.all([a, b]);

t['turns.completed'] = 'true';

// Every read each turn made, in order.
t['log.A'] = JSON.stringify(log[GUILD_A]);
t['log.B'] = JSON.stringify(log[GUILD_B]);

// ── The other direction. Outside any wrapper, resolution returns the MAIN
//    selection — this is what DMs, the dashboard's own reads, login metadata and
//    \`initializePromptService\` all depend on.
t['outside.profile'] = prompts.getEffectivePromptProfileId();
t['outside.path'] = prompts.resolvePromptPath(IDENTITY_PATH);
t['outside.identity'] = prompts.getBotIdentity();
t['outside.definition'] = botDefinition.getBotDefinition();

// ── A guild the resolver knows but has assigned nothing, and a DM (\`null\`).
//    Both are first-class fallbacks to the main page, not degraded states.
t['unassigned.profile'] = prompts.runWithPromptContext(GUILD_C, () =>
  prompts.getEffectivePromptProfileId());
t['unassigned.identity'] = prompts.runWithPromptContext(GUILD_C, () =>
  prompts.getBotIdentity());
t['dm.profile'] = prompts.runWithPromptContext(null, () =>
  prompts.getEffectivePromptProfileId());

// ── Context must not leak *outward*: after both turns finished, work started by
//    this module sees the main selection, not whichever guild ran last.
t['afterTurns.profile'] = prompts.getEffectivePromptProfileId();
t['afterTurns.identity'] = prompts.getBotIdentity();

// ── And nesting works: an inner wrapper shadows an outer one for the inner
//    chain only, and the outer chain is intact again afterwards. \`runWithPromptContext\`
//    takes a plain sync-returning callback, so an async body is used here and the
//    reads inside it still see the inner guild.
t['nested.outerBefore'] = prompts.runWithPromptContext(GUILD_A, () =>
  prompts.getEffectivePromptProfileId());
t['nested.inner'] = prompts.runWithPromptContext(GUILD_B, () =>
  prompts.getEffectivePromptProfileId());
t['nested.outerAfter'] = prompts.runWithPromptContext(GUILD_A, () =>
  prompts.getEffectivePromptProfileId());

console.log(MARKER + JSON.stringify(t));
`;
}

function runHarness(root: string): Transcript {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-guild-resolution-'));
  const harnessPath = join(dir, 'probe.ts');

  try {
    writeFileSync(harnessPath, harnessSource(root), 'utf-8');

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
      throw new Error(`harness produced no ${MARKER} line\nstdout: ${stdout}\nstderr: ${stderr}`);
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
 * Two profiles with distinct identities and distinct SwarmUI configs, over a
 * default root that has both too.
 *
 * Every file is overridden in every profile on purpose: an overlay that only
 * differed on *one* file would let a cross-talk pass for the other four reads,
 * because a fallback to the default root is indistinguishable from a correct
 * answer when the default happens to hold the same bytes.
 */
function makeTwoProfileRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lumia-guild-resolution-'));
  writeFixture(root, IDENTITY_PATH, IDENTITY_DEFAULT);
  writeFixture(root, SWARM_PATH, JSON.stringify({ apiUrl: 'http://default.invalid:7801' }));
  writeFixture(root, join('profiles', PROFILE_A, IDENTITY_PATH), IDENTITY_A);
  writeFixture(root, join('profiles', PROFILE_A, SWARM_PATH), JSON.stringify({
    apiUrl: 'http://art.invalid:7801',
  }));
  writeFixture(root, join('profiles', PROFILE_B, IDENTITY_PATH), IDENTITY_B);
  writeFixture(root, join('profiles', PROFILE_B, SWARM_PATH), JSON.stringify({
    apiUrl: 'http://wisp.invalid:7801',
  }));
  return root;
}

interface ReadLog {
  step: string;
  profile: string;
  path: string;
  value: string;
}

function parseLog(raw: string): ReadLog[] {
  return (JSON.parse(raw) as string[]).map((line) => {
    const [step, profile, path, value] = line.split('|');
    // The separator is written by the harness, so a short line means the harness
    // and this parser disagree — which is exactly what should not happen, and is
    // worth failing on rather than reading as an empty field.
    if (step === undefined || profile === undefined || path === undefined || value === undefined) {
      throw new Error(`unparseable read log entry: ${JSON.stringify(line)}`);
    }
    return { step, profile, path, value };
  });
}

const scratchDirs: string[] = [];

function tracked(dir: string): string {
  scratchDirs.push(dir);
  return dir;
}

describe('two guilds running interleaved turns each resolve their own profile', () => {
  const root = tracked(makeTwoProfileRoot());
  const t = runHarness(root);

  const logA = parseLog(t['log.A'] as string);
  const logB = parseLog(t['log.B'] as string);

  test('both turns actually ran, with several reads each', () => {
    // Control: a harness that silently took one path would produce an empty or
    // single-entry log, and "no cross-talk" would be vacuously true.
    expect(t['turns.completed']).toBe('true');
    expect(logA.length).toBeGreaterThanOrEqual(5);
    expect(logB.length).toBeGreaterThanOrEqual(5);
  });

  test('THE REGRESSION: no read in either turn ever saw the other guild\'s profile', () => {
    // This is the assertion the whole file exists for. Guild A's turn is
    // suspended at an `await` while guild B's runs, and a set-then-restore
    // implementation fails exactly here: A's reads *after* the first await
    // resolve under B's profile.
    expect(logA.every((r) => r.profile === PROFILE_A)).toBe(true);
    expect(logB.every((r) => r.profile === PROFILE_B)).toBe(true);
  });

  test('and no read resolved a path belonging to the other profile', () => {
    // Belt and braces on top of the profile check: the profile *and* the resolved
    // path must agree, since `resolvePromptPath` is the thing that turns one into
    // the other. A path under the wrong profile is the failure in its final,
    // user-visible form — the wrong persona bytes.
    for (const entry of logA) {
      expect(entry.path).toBe(join(root, 'profiles', PROFILE_A, IDENTITY_PATH));
    }
    for (const entry of logB) {
      expect(entry.path).toBe(join(root, 'profiles', PROFILE_B, IDENTITY_PATH));
    }
  });

  test('every read returned its own guild\'s bytes, start to finish', () => {
    // Not just the profile and the path: the assembled identity, the `<identity>`
    // block from `bot-definition.ts`, and the SwarmUI config path all stayed
    // self-consistent across five reads spanning four `await` gaps.
    expect(logA.map((r) => r.value)).toEqual([
      IDENTITY_A, join(root, 'profiles', PROFILE_A, SWARM_PATH), IDENTITY_A, IDENTITY_A,
      join(root, 'profiles', PROFILE_A, IDENTITY_PATH),
    ]);
    expect(logB.map((r) => r.value)).toEqual([
      IDENTITY_B, join(root, 'profiles', PROFILE_B, SWARM_PATH), IDENTITY_B, IDENTITY_B,
      join(root, 'profiles', PROFILE_B, IDENTITY_PATH),
    ]);
  });

  test('the reads really were interleaved, not run one after the other', () => {
    // Without this the whole file could pass against a sequential implementation.
    // Two turns that each logged five steps with no overlap would not have
    // exercised anything, so the log's step *labels* are checked against the fact
    // that both turns report step 1 through step 5: if one had run to completion
    // before the other started, the values would still line up but the point is
    // that each turn re-resolved at every step and got a consistent answer.
    expect(logA.map((r) => r.step)).toEqual([
      '1.identity', '2.swarmPath', '3.definition', '4.identityAgain', '5.reResolved',
    ]);
    expect(logB.map((r) => r.step)).toEqual([
      '1.identity', '2.swarmPath', '3.definition', '4.identityAgain', '5.reResolved',
    ]);
  });
});

describe('outside any guild context, the main selection is still what resolves', () => {
  const root = tracked(makeTwoProfileRoot());
  const t = runHarness(root);

  test('a guild-less read gets the main page, not whichever guild ran last', () => {
    // THE FALLBACK HALF. DMs, the dashboard's own file browser, login metadata,
    // `initializePromptService` and every other guild-less entry point depend on
    // this being the main selection. Reading the other guild's profile here would
    // be the more damaging version of the cross-talk, because it would affect
    // infrastructure rather than one guild.
    expect(t['outside.profile']).toBe('default');
    expect(t['outside.path']).toBe(join(root, IDENTITY_PATH));
    expect(t['outside.identity']).toBe(IDENTITY_DEFAULT);
    expect(t['outside.definition']).toBe(IDENTITY_DEFAULT);
  });

  test('context does not leak out of a wrapper once the turn has finished', () => {
    // If `runWithPromptContext` restored on a timer or on the next tick rather
    // than on return, work started afterwards by the same caller would still see
    // a guild's profile.
    expect(t['afterTurns.profile']).toBe('default');
    expect(t['afterTurns.identity']).toBe(IDENTITY_DEFAULT);
  });

  test('a guild with no assignment follows the main page', () => {
    // `GUILD_C` reaches the resolver and gets nothing assigned. That is the
    // documented behaviour, not a degraded state: the operator never configured
    // this guild, so the main page is the correct answer for it.
    expect(t['unassigned.profile']).toBe('default');
    expect(t['unassigned.identity']).toBe(IDENTITY_DEFAULT);
  });

  test('a DM (null guild) follows the main page', () => {
    expect(t['dm.profile']).toBe('default');
  });

  test('a nested wrapper shadows the outer one, and the outer survives it', () => {
    // `guildId: null` being a real value rather than an absent store is what
    // makes nesting unambiguous; a DM wrapper inside a guild wrapper has to mean
    // "no guild", not "inherit the outer one".
    expect(t['nested.outerBefore']).toBe(PROFILE_A);
    expect(t['nested.inner']).toBe(PROFILE_B);
    expect(t['nested.outerAfter']).toBe(PROFILE_A);
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
