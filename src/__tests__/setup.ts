/**
 * Test bootstrap. Loaded via `bunfig.toml` → `[test] preload`, which Bun
 * evaluates **before any test module**, so this is the only place that can
 * guarantee `DATA_DIR` is already redirected when the first service module is
 * imported.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Several services build their database at *module load*: `gif.ts` has a
 * top-level `new Database(dbPath('gif_settings.db'))`, `user-memory.ts` and
 * `conversation-history.ts` construct and migrate on import, and the
 * orchestrator's turn journal opens its file and runs a retention `DELETE`.
 * Any test file that imports one of those — directly or transitively —
 * therefore writes to the operator's real databases just by being collected.
 *
 * On a checkout where the bot has never booted those writes are not no-ops:
 * the migrations run for the first time (including the one that rewrites
 * `user_opinions.opinion`) and the retention sweep deletes real journal rows.
 * On a checkout where it has booted they still churn the WAL and leave
 * `-wal`/`-shm` files behind. Neither belongs in `bun test`.
 *
 * A test file cannot prevent this by setting `process.env.DATA_DIR` itself:
 * `bun test` evaluates every test file in one process, so whether that
 * assignment lands before or after the first service import is a function of
 * alphabetical file order. Setting it here, ahead of all of them, removes the
 * ordering dependency entirely.
 *
 * The directory is unique per process (`os.tmpdir()` + pid) so parallel or
 * sharded runs cannot collide, and it is removed once the run finishes. It is
 * overwritten unconditionally — an operator who has `DATA_DIR` exported in
 * their shell still gets a throwaway directory for the duration of the run.
 */

import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), `lumia-test-data-${process.pid}-`));
process.env.DATA_DIR = dataDir;

// `afterAll`, not `process.on('exit')`: the test runner tears the process down
// without running exit handlers, so an exit-based hook silently never fires and
// every run leaks a directory. `afterAll` is reliable on a green run; on a run
// with failures Bun can tear down before the hook lands, which leaves one
// stray `lumia-test-data-*` in the system temp dir. That is accepted — it only
// happens when the suite is already red, and an empty temp directory is
// harmless. Never let cleanup failing take down a run that is already failing.
afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
});