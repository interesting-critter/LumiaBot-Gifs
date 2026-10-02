/**
 * Test-isolation invariants.
 *
 * These are regression guards for a real, silent data-loss bug: several
 * services open (and migrate, and sweep) a SQLite file as a **module-load side
 * effect**, so collecting a test file that imports them was enough to write to
 * the operator's live databases. `bun test` evaluates every file in one
 * process, so a per-file `process.env.DATA_DIR = …` guard depended on
 * alphabetical file order rather than on anything the code guaranteed.
 *
 * Two things now hold that did not before:
 *   1. `DATA_DIR` is redirected to a throwaway directory before any test module
 *      is evaluated (`bunfig.toml` → `[test] preload` → `./setup.ts`).
 *   2. Importing `turn-journal` no longer constructs the journal, so it cannot
 *      run a retention `DELETE` just by being linked.
 *
 * Each is asserted in a **fresh child process** rather than in-process, because
 * the in-process module registry is shared: by the time this file runs, other
 * test files may already have loaded `utils/paths.ts`, which freezes `DATA_DIR`
 * at whatever the preload set. A subprocess is the only way to observe what a
 * cold start actually does.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DATA_DIR, LEGACY_DB_FILENAMES, REPO_ROOT } from '../utils/paths';

const PATHS_MODULE = join(REPO_ROOT, 'src', 'utils', 'paths.ts');
const CLIENT_MODULE = join(REPO_ROOT, 'src', 'bot', 'client.ts');
const TURN_JOURNAL_MODULE = join(REPO_ROOT, 'src', 'services', 'orchestrator', 'turn-journal.ts');

/**
 * Result marker. Importing these modules logs freely to stdout (`[Orchestrator]
 * Turn journal retention: …`, rate-limit banners), so the payload cannot just be
 * "everything on stdout" — it has to be pulled out of the noise.
 */
const MARKER = '__RESULT__';

/**
 * Run `code` in a cold Bun process and return the JSON it assigns to
 * `globalThis.__r`.
 */
function runInColdProcess<T>(code: string, opts: { cwd?: string; env?: Record<string, string> } = {}): T {
  const wrapped =
    `${code}\nconsole.log(${JSON.stringify(MARKER)} + JSON.stringify(globalThis.__r ?? null));`;

  const result = Bun.spawnSync({
    cmd: ['bun', '--eval', wrapped],
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
  });

  const stdout = result.stdout.toString();

  if (result.exitCode !== 0) {
    throw new Error(
      `child process failed (exit ${result.exitCode})\n` +
        `stdout: ${stdout}\n` +
        `stderr: ${result.stderr.toString()}`,
    );
  }

  const line = stdout.split('\n').find((l) => l.startsWith(MARKER));
  if (line === undefined) {
    throw new Error(`child process produced no ${MARKER} line\nstdout: ${stdout}`);
  }

  return JSON.parse(line.slice(MARKER.length)) as T;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'lumia-isolation-'));
}

describe('DATA_DIR is redirected for the whole test run', () => {
  test('DATA_DIR is set and is a throwaway directory', () => {
    expect(process.env.DATA_DIR).toBeDefined();
    expect(DATA_DIR.length).toBeGreaterThan(0);
    expect(resolve(DATA_DIR)).not.toBe(resolve(REPO_ROOT, 'data'));
    // Absolute, so `paths.ts` does not re-anchor it to the repo root.
    expect(DATA_DIR.startsWith(tmpdir())).toBe(true);
  });

  test('a cold import of the bot client redirects its databases into DATA_DIR', () => {
    // `src/bot/client.ts` is the heaviest import in the suite: it transitively
    // instantiates `userMemoryService`, `gif.ts`'s module-level Database, the
    // rate limiter, the model selector and the knowledge graph. Importing it
    // used to be enough to create and migrate a dozen live files. Asserting
    // they land in the throwaway directory is the end-to-end proof that the
    // preload actually intercepts the side effects rather than merely setting
    // an env var nobody reads.
    const dataDir = scratch();
    const control = scratch();
    // A CWD with no legacy files, so the upgrade warning has nothing to report
    // and cannot muddy the assertion below.
    const cwd = scratch();
    try {
      const created = runInColdProcess<string[]>(
        `await import(${JSON.stringify(CLIENT_MODULE)});` +
          `const { readdirSync } = await import('node:fs');` +
          `globalThis.__r = readdirSync(process.env.DATA_DIR).sort();`,
        { cwd, env: { DATA_DIR: dataDir } },
      );

      expect(created.length).toBeGreaterThan(0);
      expect(created).toContain('user_memories.db');
      expect(created).toContain('gif_settings.db');
      // Nothing leaked into a directory nobody pointed at.
      expect(readdirSync(control)).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(control, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('importing turn-journal has no side effects', () => {
  test('a cold import does not create orchestrator_turns.db', () => {
    const dataDir = scratch();
    try {
      runInColdProcess(
        `await import(${JSON.stringify(TURN_JOURNAL_MODULE)});`,
        { cwd: scratch(), env: { DATA_DIR: dataDir } },
      );

      // The hazard: module load used to construct the journal, which opens the
      // file, runs CREATE TABLE, and immediately issues a retention DELETE.
      expect(existsSync(join(dataDir, 'orchestrator_turns.db'))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('asking for the journal explicitly does create it, exactly once', () => {
    const dataDir = scratch();
    try {
      const same = runInColdProcess<boolean>(
        `const m = await import(${JSON.stringify(TURN_JOURNAL_MODULE)});` +
          `const a = m.getOrchestratorTurnJournal();` +
          `const b = m.getOrchestratorTurnJournal();` +
          `globalThis.__r = a === b;`,
        { cwd: scratch(), env: { DATA_DIR: dataDir } },
      );

      // Lazy must not mean "broken": the accessor works and returns one
      // instance, so the retention sweep is scheduled exactly once per process.
      expect(same).toBe(true);
      expect(existsSync(join(dataDir, 'orchestrator_turns.db'))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('the exported singleton is a working lazy alias, not a dead stub', () => {
    const dataDir = scratch();
    try {
      const result = runInColdProcess<{ state: string | null; viaAccessor: boolean }>(
        `const m = await import(${JSON.stringify(TURN_JOURNAL_MODULE)});` +
          `m.orchestratorTurnJournal.markReceived({ turnId: 't1', eventId: 'e1' }, 'inst-1');` +
          `const rec = m.getOrchestratorTurnJournal().getTurn('t1');` +
          `globalThis.__r = { state: rec ? rec.state : null, viaAccessor: rec !== undefined };`,
        { cwd: scratch(), env: { DATA_DIR: dataDir } },
      );

      // Method calls through the proxy must land on the same underlying journal
      // the accessor returns, or writes would be silently discarded.
      expect(result).toEqual({ state: 'received', viaAccessor: true });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('legacy database upgrade warning', () => {
  const LEGACY_FIXTURE = 'user_memories.db';

  /** Run the check with the CWD pointed at `cwd`, which is what makes a path "legacy". */
  function checkFrom(cwd: string, dataDir: string): string[] {
    return runInColdProcess<string[]>(
      `const m = await import(${JSON.stringify(PATHS_MODULE)});` +
        `globalThis.__r = m.warnAboutLegacyDatabases();`,
      { cwd, env: { DATA_DIR: dataDir } },
    );
  }

  test('reports a database left at the old CWD-relative location', () => {
    const cwd = scratch();
    const dataDir = scratch();
    try {
      writeFileSync(join(cwd, LEGACY_FIXTURE), 'legacy');

      expect(checkFrom(cwd, dataDir)).toEqual([resolve(cwd, LEGACY_FIXTURE)]);
      // The whole point: warn, never move.
      expect(existsSync(join(cwd, LEGACY_FIXTURE))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('stays silent when the database is already in DATA_DIR', () => {
    const cwd = scratch();
    const dataDir = scratch();
    try {
      // Present in both places: a deliberate copy, not an orphaned upgrade.
      writeFileSync(join(cwd, LEGACY_FIXTURE), 'legacy');
      writeFileSync(join(dataDir, LEGACY_FIXTURE), 'current');

      expect(checkFrom(cwd, dataDir)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('stays silent when there is nothing at the old location', () => {
    const cwd = scratch();
    const dataDir = scratch();
    try {
      expect(checkFrom(cwd, dataDir)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('the known-filename list is de-duplicated and covers the indirect call sites', () => {
    // Keep `LEGACY_DB_FILENAMES` honest. `rate-limiter.ts` reaches
    // `dashboard_settings.db` through a local constant, so it is listed here
    // even though no literal `dbPath('dashboard_settings.db')` exists.
    expect(LEGACY_DB_FILENAMES).toContain('dashboard_settings.db');
    expect(LEGACY_DB_FILENAMES).toContain('user_memories.db');
    expect(new Set(LEGACY_DB_FILENAMES).size).toBe(LEGACY_DB_FILENAMES.length);
  });
});