import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Deterministic locations for on-disk state.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every SQLite database used to be opened with a CWD-relative filename
 * (`new Database('music.db')`). That is a silent data-loss trap: run the bot
 * from the wrong directory and Bun happily creates a brand-new empty
 * `music.db`, which then becomes the database the bot uses — with no error,
 * no warning, and no obvious symptom except "my memories are gone".
 *
 * Everything here is anchored to `import.meta.dir` instead of
 * `process.cwd()`, so the paths are identical no matter where the process was
 * started from.
 *
 * THE UPGRADE PROBLEM THIS CREATES
 * --------------------------------
 * Anchoring the paths fixes every *future* run, but it does nothing for the
 * run that happens right after someone pulls this commit: their databases are
 * already on disk at the old CWD-relative location, and the bot now looks in a
 * different directory. SQLite does not complain — `new Database(path)` creates
 * a fresh empty file — so the upgrade appears to succeed and the operator is
 * left with an empty memory store and an empty knowledge base.
 *
 * {@link LEGACY_DB_FILENAMES} plus {@link warnAboutLegacyDatabases} exist to
 * turn that silent failure into a loud, actionable message on the one run where
 * it can still be prevented. Nothing is moved automatically: a file the
 * operator deliberately kept at the root would be silently clobbered.
 */

/** Absolute path to the repository root (this file is at `src/utils/paths.ts`). */
export const REPO_ROOT: string = resolve(import.meta.dir, '..', '..');

/**
 * Where the `*.db` files live. Defaults to `<repo>/data`; override with the
 * `DATA_DIR` env var (relative values are resolved against the repo root, not
 * the CWD, so the override stays deterministic too).
 */
export const DATA_DIR: string = process.env.DATA_DIR
  ? isAbsolute(process.env.DATA_DIR)
    ? process.env.DATA_DIR
    : join(REPO_ROOT, process.env.DATA_DIR)
  : join(REPO_ROOT, 'data');

/**
 * Every database filename the bot opens through {@link dbPath}.
 *
 * Kept in sync with the `dbPath('…')` call sites in `src/` — `grep -rn "dbPath('"
 * src/` is the source of truth. Adding a database means adding it here too,
 * otherwise the upgrade warning silently skips it.
 *
 * `dashboard_settings.db` is reached indirectly: `rate-limiter.ts` holds it in
 * a local `SETTINGS_DB` constant and passes that to `dbPath()`.
 */
export const LEGACY_DB_FILENAMES: readonly string[] = [
  'api_usage.db',
  'boredom.db',
  'conversations.db',
  'dashboard_logs.db',
  'dashboard_settings.db',
  'gif_settings.db',
  'guild_memories.db',
  'knowledge_graph.db',
  'music.db',
  'orchestrator_turns.db',
  'user_memories.db',
];

// `new Database(path)` throws when the parent directory does not exist, so the
// data directory is created once at module load rather than at every open.
let dataDirEnsured = false;

/**
 * Where the pre-`paths.ts` code would have looked for `filename`: next to the
 * process CWD. Exported for the upgrade check and for tests.
 */
export function legacyDbPath(filename: string): string {
  return resolve(process.cwd(), filename);
}

/**
 * Warn once, on the first database open, about any database left behind at the
 * old CWD-relative location.
 *
 * Fires when a file is present at the legacy path **and** absent from
 * {@link DATA_DIR} — i.e. exactly the upgrade case where the bot would go on to
 * create an empty replacement. A file that exists in both places is a
 * deliberate copy, not an oversight, and is left alone.
 *
 * Deliberately warns rather than moves: an automatic move could overwrite a
 * copy the operator kept on purpose, and a wrong automatic move is worse than
 * a loud message.
 *
 * @returns the legacy paths that were reported, so tests can assert on them.
 */
export function warnAboutLegacyDatabases(): string[] {
  const orphans: string[] = [];

  for (const filename of LEGACY_DB_FILENAMES) {
    const legacy = legacyDbPath(filename);
    if (legacy === join(DATA_DIR, filename)) continue;
    if (!existsSync(legacy)) continue;
    if (existsSync(join(DATA_DIR, filename))) continue;
    orphans.push(legacy);
  }

  if (orphans.length === 0) {
    return orphans;
  }

  console.error(
    [
      '',
      '='.repeat(72),
      '  UPGRADE WARNING: existing database(s) found at the OLD location.',
      '='.repeat(72),
      '',
      '  These databases are no longer being read. Every path in the bot is now',
      '  anchored to the repository instead of the current working directory:',
      '',
      `      old: ${process.cwd()}`,
      `      new: ${DATA_DIR}`,
      '',
      '  Found at the old location:',
      ...orphans.map((p) => `      - ${p}`),
      '',
      '  SQLite creates a new empty file when one is missing, so this upgrade will',
      '  NOT fail — it will look like every memory and every knowledge document',
      '  has vanished. Fix it before trusting the bot with anything important.',
      '',
      '  WHAT TO DO (pick one):',
      '',
      '    1. Move the files into the new directory, then start the bot:',
      ...orphans.map((p) => `         mv "${p}" "${DATA_DIR}/"`),
      '',
      '    2. Or leave them where they are and point DATA_DIR at their parent so',
      '       the bot reads them in place (see .env.example):',
      `         DATA_DIR=${process.cwd()}`,
      '',
      '  Nothing has been moved or deleted. Re-running this check is harmless.',
      '='.repeat(72),
      '',
    ].join('\n'),
  );

  return orphans;
}

let legacyCheckDone = false;

function ensureDataDir(): void {
  if (dataDirEnsured) return;
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  dataDirEnsured = true;
}

/**
 * Resolve a database filename inside {@link DATA_DIR}, creating the data
 * directory on first use.
 *
 * The first call also runs {@link warnAboutLegacyDatabases}, which is why the
 * upgrade warning surfaces at startup even though nothing here logs on import.
 *
 * Usage (one-line swap in any service):
 *
 *     import { dbPath } from '../utils/paths';
 *     this.db = new Database(dbPath('music.db'));
 */
export function dbPath(filename: string): string {
  ensureDataDir();

  if (!legacyCheckDone) {
    legacyCheckDone = true;
    try {
      warnAboutLegacyDatabases();
    } catch (error) {
      // A diagnostic must never be the reason the bot fails to boot.
      console.error('[paths] legacy database check failed:', error);
    }
  }

  return join(DATA_DIR, filename);
}

/**
 * Persona / prompt template directory: `<repo>/prompt_storage`.
 *
 * Consumed by `src/server/dashboard.ts`, which imports this constant rather
 * than rebuilding the path.
 */
export const PROMPT_STORAGE_DIR: string = join(REPO_ROOT, 'prompt_storage');

/**
 * Knowledge base markdown directory: `<repo>/knowledge_documents`.
 *
 * Also imported by `src/server/dashboard.ts`, so the dashboard reads the same
 * directory whether the process was started from the repo root or anywhere
 * else.
 */
export const KNOWLEDGE_DOCUMENTS_DIR: string = join(REPO_ROOT, 'knowledge_documents');