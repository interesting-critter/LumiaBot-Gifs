import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { config } from '../../utils/config';
import { PROMPT_STORAGE_DIR, REPO_ROOT } from '../../utils/paths';
import { modelSelectorService } from '../../services/model-selector';
import { promptSelectorService } from '../../services/prompt-selector';
import {
  GuildPromptProfileService,
  guildPromptProfileService,
} from '../../services/guild-prompt-profiles';
import {
  clearCache,
  getActivePromptProfileId,
  setActivePromptProfileId,
} from '../../services/prompts';
import { resetAuthFailuresForTests, startDashboardServer } from '../dashboard';

/**
 * The prompt-profile HTTP surface, and the one thing that genuinely breaks if it
 * is wrong: **which file a persona save lands in.**
 *
 * The dashboard is exercised over a real socket through the real handler, the
 * way `dashboard-auth.test.ts` does it, because everything interesting here is
 * in the layer the service-level unit tests never reach — the auth gate, the
 * Host allowlist, the CSRF check, and the path the write ends up at. No Discord
 * client is involved: `/api/persona` never touches one, and
 * `reloadBotDefinition()` only re-reads prompt files.
 *
 * FIXTURE DISCIPLINE
 * ------------------
 * Two things leak out of this file unless they are put back, and both are worse
 * than a failing test:
 *
 *   1. `config` is a module-level singleton shared with every other suite, and
 *      `prompt-selector`/`model-selector` read it lazily on every call. Saving
 *      and restoring the slices touched here is the only isolation available.
 *   2. `PROMPT_STORAGE_DIR` is anchored to the **repository**, not to the
 *      throwaway `DATA_DIR` `bunfig.toml` redirects, so a persona write in a test
 *      really does land in the operator's prompt tree. `ensureDir` and
 *      `writeFixture` therefore record the outermost directory and every file
 *      they create, and `afterAll` removes exactly those — nothing that existed
 *      before the suite ran is ever deleted.
 */

type DashboardConfig = typeof config.dashboard;

const PASSWORD = 'a-long-random-password';
const USERNAME = 'admin';
const DEFAULT_ID = 'default';

/** A valid profile id per `prompts.ts`, and unlikely to collide with a real one. */
const PROFILE_ID = 'test-rpd';

/** Pretended to be the live model, and the one bound to a profile. */
const TEST_MODEL = 'test-model-rpd';

/** A second model, bound to a *different* profile, for the binding assertions. */
const OTHER_MODEL = 'test-model-unbound';

const PROFILE_ROOT = join(PROMPT_STORAGE_DIR, 'profiles', PROFILE_ID);

/** Two prompt files, so an inherited save is distinguishable from an overridden one. */
const IDENTITY = 'persona/identity.txt';
const REINFORCEMENT = 'persona/reinforcement.txt';

const DEFAULT_IDENTITY = 'default identity text';
const PROFILE_IDENTITY = 'profile identity text';
const DEFAULT_REINFORCEMENT = 'default reinforcement text';
const PROFILE_REINFORCEMENT = 'profile reinforcement text';

const defaultIdentityPath = join(PROMPT_STORAGE_DIR, IDENTITY);
const profileIdentityPath = join(PROFILE_ROOT, IDENTITY);
const defaultReinforcementPath = join(PROMPT_STORAGE_DIR, REINFORCEMENT);
const profileReinforcementPath = join(PROFILE_ROOT, REINFORCEMENT);

let savedDashboard: DashboardConfig;
let savedAvailable: string[];
let savedByModel: Record<string, string>;
let savedModelAlias: string | undefined;
let savedModelOptions: string[];
let savedMaxGuilds: number;

/** Top-most directories this file created, for exact cleanup. */
const createdDirs: string[] = [];
/**
 * Contents this file overwrote, keyed by path. `null` means "the file did not
 * exist, so remove it"; a string means "put this back".
 *
 * Needed because several tests deliberately change a file that may be the
 * operator's real persona. `PROMPT_STORAGE_DIR` is anchored to the repository and
 * cannot be redirected (that is the point of `paths.ts`), so a fixture that
 * assumed it owned those files would silently destroy the operator's prompts.
 */
const originalContents = new Map<string, string | null>();

/**
 * Temp roots for the guild service's own fixtures (database + profile folders).
 *
 * Tracked separately from {@link createdDirs} because those are created by the
 * *server* writing into the operator's tree and must be removed only if this
 * file created them, whereas these are ours outright and always removed.
 */
const scratchDirs: string[] = [];

/** Live spies on the guild service singleton, restored after every test. */
const guildSpies: Array<{ mockRestore: () => void }> = [];

/**
 * `mkdir -p`, recording the **outermost** directory it had to create.
 *
 * Removing that one with `recursive: true` takes the whole chain with it, and
 * because it is the outermost directory that did not exist beforehand, it cannot
 * reach anything the operator had. Recording an intermediate link instead would
 * leave the ancestors behind — `prompt_storage/profiles/test-rpd` surviving as an
 * empty tree is enough to make a later `listPromptProfiles()` report a profile
 * that has no files in it.
 */
function ensureDir(dir: string): void {
  if (existsSync(dir)) return;

  let topmost = dir;
  let parent = dirname(topmost);
  while (!existsSync(parent)) {
    topmost = parent;
    parent = dirname(topmost);
  }

  // `dir`, not `topmost`: `topmost` is what gets *removed* afterwards, and it is
  // only an ancestor of `dir`. Creating it is `mkdirSync`'s job.
  createdDirs.push(topmost);
  mkdirSync(dir, { recursive: true });
}

function writeFixture(file: string, content: string): void {
  ensureDir(dirname(file));
  // Remember the pre-existing bytes exactly once, before the first overwrite.
  if (!originalContents.has(file)) {
    originalContents.set(file, read(file));
  }
  writeFileSync(file, content, 'utf-8');
}

function read(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf-8') : null;
}

/** Ports in a range unlikely to collide with a real dashboard. */
let nextPort = 34_200;
function freePort(): number {
  nextPort += 1;
  return nextPort;
}

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

/** Start the dashboard on a free port, run the body, always stop it. */
async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  Object.assign(config.dashboard, { port: freePort() });
  const server = startDashboardServer();
  if (!server) throw new Error('dashboard refused to start; test setup is wrong');
  try {
    await run(config.dashboard.port);
  } finally {
    server.stop(true);
  }
}

interface CallOptions {
  host?: string;
  auth?: boolean;
  headers?: Record<string, string>;
  body?: unknown;
}

async function call(port: number, path: string, method: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    Host: options.host ?? `127.0.0.1:${port}`,
    ...(options.auth === false ? {} : { Authorization: basic(USERNAME, PASSWORD) }),
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** The state projection `/api/prompt-profiles` returns. Only what is asserted on. */
interface ProfileState {
  available: string[];
  selectable: string[];
  active: string;
  override: string | null;
  byModel: Record<string, string>;
  currentModel: string;
}

/** `Response.json()` is `Promise<unknown>`; every call site here wants a shape. */
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** One GET of the profile state, typed. */
async function readState(port: number): Promise<ProfileState> {
  return json<ProfileState>(await call(port, '/api/prompt-profiles', 'GET'));
}

interface PersonaFile {
  path: string;
  exists: boolean;
  profile: string;
  overridden: boolean;
  content: string;
}

interface PersonaListEntry {
  path: string;
  exists: boolean;
  overridden: boolean;
}

interface PersonaList {
  profile: string;
  files: PersonaListEntry[];
}

interface ErrorBody {
  error: string;
}

/** The POST shape: the same state projection, plus `ok`. */
type AppliedState = ProfileState & { ok: boolean };

// ---- Per-guild fixtures ---------------------------------------------------

const GUILD_A = '123456789012345678';
const GUILD_B = '987654321098765432';
/** Absent from GUILD_PROMPT_PROFILES: structurally excluded from the feature. */
const GUILD_FOREIGN = '111111111111111111';

/**
 * Guild labels are valid profile ids, so each one *is* the guild's profile
 * folder — which is also why they can be used as the `profile` dimension on the
 * persona routes without appearing in `available`.
 */
const LABEL_A = 'guild-a-rpd';
const LABEL_B = 'guild-b-rpd';

const CONFIGURED = [
  { guildId: GUILD_A, label: LABEL_A },
  { guildId: GUILD_B, label: LABEL_B },
];

/**
 * A profile folder that exists under the real `profiles/` root and belongs to
 * nobody: not a guild's label, not whitelisted, not the main selection.
 *
 * This is the fixture the arbitrary-file-write test needs. It has to be a real
 * directory, because `getPromptProfileRoot` accepts any *existing* folder — that
 * is precisely why the dashboard cannot rely on it alone as the security gate,
 * and why the case would not be reproduced by naming a profile that does not
 * exist (which the same call rejects on a different ground).
 */
const FOREIGN_LABEL = 'stray-rpd';

interface GuildState {
  guilds: Array<{
    guildId: string;
    label: string;
    profile: string;
    source: 'assignment' | 'own-folder' | 'main';
    changedAt: string | null;
    eligible: boolean;
    inCache: boolean;
  }>;
  assignments: Record<string, { profile: string; changedAt: string | null }>;
  selectable: string[];
  mainActive: string;
  maxGuilds: number;
}

function readGuildState(port: number): Promise<GuildState> {
  return call(port, '/api/guild-prompt-profiles', 'GET').then((r) => json<GuildState>(r));
}

function assign(port: number, guildId: string, profile: string | null) {
  return call(port, '/api/guild-prompt-profiles', 'POST', { body: { guildId, profile } });
}

/** The `profiles[]` group list from `/api/persona`. */
interface PersonaGroup {
  id: string;
  label: string;
  kind: 'default' | 'main' | 'guild';
  main: boolean;
  guildId?: string;
}

interface GroupedPersonaList {
  profile: string;
  profiles: PersonaGroup[];
  files: Array<{ path: string; profile: string; exists: boolean; overridden: boolean }>;
}

/* ── the guild-folder write path, in a cold process ─────────────────────── */

/** Line prefix the harness prints its transcript on. */
const HARNESS_MARKER = '__TRANSCRIPT__';

/** Fixed port for the harness child. Nothing else is running in that process. */
const HARNESS_PORT = 34_900;

/**
 * `PUT /api/persona` into a profile folder, with the whole prompt tree under a
 * temp root.
 *
 * WHY A SUBPROCESS RATHER THAN THE IN-PROCESS FIXTURES ABOVE
 * ---------------------------------------------------------
 * The other tests in this file write under the real `prompt_storage/`, because
 * `PROMPT_STORAGE_DIR` is anchored to the repository and there is no env
 * override (`utils/paths.ts` — the same fact `swarmui-profile-overlay.test.ts`
 * turns into a subprocess). They get away with it by recording every file and
 * directory they touch and putting them all back in `afterAll`.
 *
 * That discipline cannot cover *this* case. The point of the test is a folder
 * being **created** — `prompt_storage/profiles/<guild label>/` did not exist, and
 * the save is what brings it into being — plus a real folder that exists and is
 * not the operator's to keep. Recording "the outermost directory that did not
 * exist" and deleting it afterwards would work mechanically, but it means a
 * failing run can leave a live folder inside the operator's prompt tree, and a
 * crash between the write and the cleanup leaves it there for good. This is
 * precisely the fixture the plan forbids building that way.
 *
 * So the temp root is real and nothing is: `mock.module` swaps `paths.ts` before
 * `dashboard.ts` is ever imported, which is safe *here* and only here, because
 * the child dies at the end of the run. In process it would be permanent for the
 * whole `bun test` and every later suite would inherit a redirected prompt tree.
 */
function writeHarnessSource(root: string): string {
  return `
import { mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const ROOT = ${JSON.stringify(root)};
const MARKER = ${JSON.stringify(HARNESS_MARKER)};
const GUILD_A = ${JSON.stringify(GUILD_A)};
const LABEL_A = ${JSON.stringify(LABEL_A)};
const FOREIGN = ${JSON.stringify(FOREIGN_LABEL)};
const IDENTITY = ${JSON.stringify(IDENTITY)};
const DEFAULT_IDENTITY = ${JSON.stringify(DEFAULT_IDENTITY)};
const PASSWORD = ${JSON.stringify(PASSWORD)};
const USERNAME = ${JSON.stringify(USERNAME)};
const PORT = ${JSON.stringify(HARNESS_PORT)};

// \`paths.ts\` before anything that imports it: the dashboard's write path is
// built from these two constants, so the fixture has to be substituted first or
// the routes would resolve against the real tree.
mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(ROOT, 'knowledge_documents'),
  DATA_DIR: join(ROOT, 'data'),
  LEGACY_DB_FILENAMES: [],
  dbPath: (name) => join(ROOT, 'data', name),
}));

const { config } = await import(join(REPO, 'src/utils/config.ts'));

// Configure the guild exactly as an operator would: through the env file. Going
// through the parser rather than assigning to \`config\` means the label is put
// through the same id validation a real deployment applies, which is part of
// what makes the write path safe to allow.
config.promptProfiles.guilds = [{ guildId: GUILD_A, label: LABEL_A }];
// Deliberately NOT whitelisted, and no profile folder for \`FOREIGN\`.
config.promptProfiles.available = ['default'];

mkdirSync(dirname(join(ROOT, IDENTITY)), { recursive: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, IDENTITY), DEFAULT_IDENTITY);
// A real, existing, unowned profile folder — the arbitrary-write target.
mkdirSync(join(ROOT, 'profiles', FOREIGN), { recursive: true });

const { startDashboardServer } = await import(join(REPO, 'src/server/dashboard.ts'));

Object.assign(config.dashboard, {
  enabled: true, host: '127.0.0.1', port: PORT,
  username: USERNAME, password: PASSWORD, passwordSet: true,
});

const server = startDashboardServer();
if (!server) throw new Error('harness: dashboard refused to start');

const t = {};
function read(label, fn) { t[label] = fn(); return t[label]; }
async function api(path, method, body) {
  const headers = {
    Host: '127.0.0.1:' + PORT,
    Authorization: 'Basic ' + btoa(USERNAME + ':' + PASSWORD),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + PORT + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

try {
  // ── 1. The editor lists the guild group even though its folder is absent.
  const list = await api('/api/persona?profile=' + LABEL_A, 'GET');
  read('list.status', () => list.status);
  read('list.profile', () => list.body && list.body.profile);
  read('list.groups', () => JSON.stringify((list.body && list.body.profiles) || []));
  read('list.rowProfile', () => {
    const row = ((list.body && list.body.files) || []).find((f) => f.path === IDENTITY);
    return row ? row.profile : '(no row)';
  });
  read('list.rowOverridden', () => {
    const row = ((list.body && list.body.files) || []).find((f) => f.path === IDENTITY);
    return row ? row.overridden : '(no row)';
  });

  // ── 2. The read of that row hands over the inherited default bytes, so the
  //       editor's \`ifMatch\` is the version the 409 check has to compare against.
  const file = await api('/api/persona?path=' + IDENTITY + '&profile=' + LABEL_A, 'GET');
  read('file.status', () => file.status);
  read('file.content', () => file.body && file.body.content);
  read('file.overridden', () => file.body && file.body.overridden);

  // ── 3. THE CREATION. No folder existed; the save must make it and land there.
  const save = await api('/api/persona', 'PUT', {
    path: IDENTITY, profile: LABEL_A, content: 'guild identity', ifMatch: DEFAULT_IDENTITY,
  });
  read('save.status', () => save.status);
  read('save.profile', () => save.body && save.body.profile);

  // ── 4. THE ARBITRARY-WRITE CASE, with a real folder behind the id.
  const stray = await api('/api/persona', 'PUT', {
    path: IDENTITY, profile: FOREIGN, content: 'owned', ifMatch: 'anything',
  });
  read('stray.status', () => stray.status);
  read('stray.error', () => (stray.body && stray.body.error) || '');
  const strayRead = await api('/api/persona?path=' + IDENTITY + '&profile=' + FOREIGN, 'GET');
  read('strayRead.status', () => strayRead.status);
} finally {
  server.stop(true);
}

read('guild.folderExists', () => existsSync(join(ROOT, 'profiles', LABEL_A)));
read('guild.file', () => existsSync(join(ROOT, 'profiles', LABEL_A, IDENTITY))
  ? readFileSync(join(ROOT, 'profiles', LABEL_A, IDENTITY), 'utf-8') : null);
read('default.file', () => existsSync(join(ROOT, IDENTITY))
  ? readFileSync(join(ROOT, IDENTITY), 'utf-8') : null);
read('stray.fileWritten', () => existsSync(join(ROOT, 'profiles', FOREIGN, IDENTITY)));

console.log(MARKER + JSON.stringify(t));
`;
}

/** Every value the harness records, flattened onto flat dotted keys. */
interface WriteTranscript {
  'list.status': number;
  'list.profile': string;
  'list.groups': string;
  'list.rowProfile': string;
  'list.rowOverridden': boolean;
  'file.status': number;
  'file.content': string;
  'file.overridden': boolean;
  'save.status': number;
  'save.profile': string;
  'stray.status': number;
  'stray.error': string;
  'strayRead.status': number;
  'guild.folderExists': boolean;
  'guild.file': string | null;
  'default.file': string | null;
  'stray.fileWritten': boolean;
}

/**
 * Run the harness cold and return its transcript as the flat keys the assertions
 * below use, so a failure says *which* step diverged rather than which object.
 */
function runWriteHarness(root: string): WriteTranscript {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-persona-write-harness-'));
  const harnessPath = join(dir, 'probe.ts');

  try {
    writeFileSync(harnessPath, writeHarnessSource(root), 'utf-8');

    // `process.execPath` is the running Bun binary, so this does not depend on
    // `bun` being on PATH.
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

    const line = stdout.split('\n').find((l) => l.startsWith(HARNESS_MARKER));
    if (line === undefined) {
      throw new Error(`harness produced no ${HARNESS_MARKER} line\nstdout: ${stdout}\nstderr: ${stderr}`);
    }

    return JSON.parse(line.slice(HARNESS_MARKER.length)) as WriteTranscript;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Rebuild the fixture files from their known constants.
 *
 * Per test, not once: several cases deliberately change what is on disk, and a
 * shared fixture would make them order-dependent — Bun collects files
 * alphabetically and there is no guarantee which of these runs first.
 */
function writeFixtures(): void {
  // Both files exist in the profile. Cases about an *inherited* file delete the
  // profile's copy themselves, so this one starts from the complete tree.
  writeFixture(profileIdentityPath, PROFILE_IDENTITY);
  writeFixture(profileReinforcementPath, PROFILE_REINFORCEMENT);
  writeFixture(defaultIdentityPath, DEFAULT_IDENTITY);
  writeFixture(defaultReinforcementPath, DEFAULT_REINFORCEMENT);
}

/**
 * Back to a known-clean selection: no override, `default` active in
 * `prompts.ts`. Run before *and* after every test, because the override is
 * persisted — leaving one behind would make the next unrelated suite read a
 * profile it never asked for.
 */
function resetSelection(): void {
  config.promptProfiles.byModel = {};
  promptSelectorService.clearOverride();
  setActivePromptProfileId(DEFAULT_ID);
}

/**
 * Swap the module-level singleton for a real service pointed at throwaway
 * fixtures, and undo it on the next `afterEach`.
 *
 * WHY A REAL SERVICE AND NOT STUBS
 * -------------------------------
 * The routes under test must be exercising the *actual* accept/reject rule —
 * eligibility, the own-label exemption, the cap — because the whole point of
 * surfacing `setAssignment`'s errors as 400s is that this file does not
 * re-implement them. A hand-written stub would let both drift together and still
 * pass, which is the failure mode the task explicitly rules out.
 *
 * `GuildPromptProfileService` takes its database path, eligible list and profile
 * directory as constructor options precisely so this is possible: `PROMPT_STORAGE_DIR`
 * is anchored to the repository and cannot be redirected in process, so without
 * them a test would have to create fixture folders under the operator's real
 * `prompt_storage/`. Everything below therefore lives in `os.tmpdir()`.
 *
 * The dashboard reaches the service through the exported singleton, so the
 * singleton's methods are the seam. `spyOn` is used rather than `mock.module`
 * deliberately: `mock.module` is permanent for the whole `bun test` process and
 * would leak these fixtures into every other suite.
 */
function useGuildService(options: { ownFolders?: string[] } = {}): GuildPromptProfileService {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-guild-api-'));
  scratchDirs.push(dir);

  const profilesDir = join(dir, 'profiles');
  mkdirSync(profilesDir, { recursive: true });
  for (const label of options.ownFolders ?? []) {
    mkdirSync(join(profilesDir, label), { recursive: true });
  }

  const service = new GuildPromptProfileService({
    databasePath: join(dir, 'dashboard_settings.db'),
    guilds: CONFIGURED,
    profilesDir,
  });

  const bound = [
    'listConfiguredGuilds',
    'getMaxGuilds',
    'isEligible',
    'ownProfileId',
    'assignmentFor',
    'listAssignments',
    'resolveProfileFor',
    'setAssignment',
    'clearAssignment',
  ] as const;

  for (const method of bound) {
    guildSpies.push(
      spyOn(guildPromptProfileService, method).mockImplementation(
        ((...args: unknown[]) => (service[method] as (...a: unknown[]) => unknown)(...args)) as never,
      ),
    );
  }

  return service;
}

beforeAll(() => {
  savedDashboard = { ...config.dashboard };
  savedAvailable = [...config.promptProfiles.available];
  savedByModel = { ...config.promptProfiles.byModel };
  savedModelAlias = config.openai.modelAlias;
  savedModelOptions = [...config.dashboard.modelOptions];
  savedMaxGuilds = config.promptProfiles.maxGuilds;

  // A real profile folder: `setOverride` refuses an id with nothing on disk, and
  // so does the startup diagnostic, so the fixture has to be a real directory
  // rather than a config-only entry.
  ensureDir(PROFILE_ROOT);
  writeFixtures();

  config.promptProfiles.available = [DEFAULT_ID, PROFILE_ID];
});

beforeEach(() => {
  // The counters are per-IP and module-level, and every request here comes from
  // 127.0.0.1, so a deliberate bad-credential case would lock out later tests.
  resetAuthFailuresForTests();
  resetSelection();
  writeFixtures();

  Object.assign(config.dashboard, {
    enabled: true,
    host: '127.0.0.1',
    password: PASSWORD,
    passwordSet: true,
    username: USERNAME,
  });
  config.openai.modelAlias = TEST_MODEL;
});

afterEach(() => {
  resetSelection();
  config.promptProfiles.available = [DEFAULT_ID, PROFILE_ID];
  // Also drops the persisted model row, keeping the dashboard_settings.db this
  // suite shares free of leftovers.
  modelSelectorService.reset();
  config.openai.modelAlias = TEST_MODEL;

  // Restore the real singleton before anything else reads it. Left in place, a
  // closed temp database would make the *next* suite's route call throw rather
  // than fail an assertion, which is a far more confusing report.
  for (const spy of guildSpies.splice(0)) spy.mockRestore();
});

afterAll(() => {
  Object.assign(config.dashboard, savedDashboard);
  config.promptProfiles.available = savedAvailable;
  config.promptProfiles.byModel = savedByModel;
  config.promptProfiles.maxGuilds = savedMaxGuilds;
  config.dashboard.modelOptions = savedModelOptions;
  config.openai.modelAlias = savedModelAlias;

  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }

  setActivePromptProfileId(DEFAULT_ID);
  clearCache();

  // Restore whatever was there before the suite ran. Files this file created are
  // removed; files it overwrote are put back byte for byte. This runs before the
  // directory removal below, because restoring a file recreates its directory.
  for (const [file, original] of originalContents) {
    if (original === null) {
      rmSync(file, { force: true });
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, original, 'utf-8');
    }
  }
  originalContents.clear();

  // Deepest first, so a nested record goes before the parent it sits inside.
  for (const dir of createdDirs.splice(0).sort((a, b) => b.length - a.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the same gate as every other dashboard route', () => {
  test('GET /api/prompt-profiles requires authentication', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/prompt-profiles', 'GET', { auth: false });
      expect(res.status).toBe(401);
    });
  });

  test('GET /api/prompt-profiles rejects a rebound Host with 421', async () => {
    await withServer(async (port) => {
      // What a full DNS rebinding looks like: same-origin as far as every header
      // is concerned, with valid credentials attached.
      const res = await call(port, '/api/prompt-profiles', 'GET', {
        host: 'evil.com',
        headers: { Origin: 'http://evil.com' },
      });
      expect(res.status).toBe(421);
    });
  });

  test('a cross-site mutation is rejected, and changes nothing', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/prompt-profiles/override', 'POST', {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
        body: { profile: PROFILE_ID },
      });
      expect(res.status).toBe(403);

      const state = await readState(port);
      expect(state.override).toBeNull();
      expect(state.active).toBe(DEFAULT_ID);
    });
  });
});

describe('GET /api/prompt-profiles', () => {
  test('reports everything the UI needs to resolve the precedence itself', async () => {
    await withServer(async (port) => {
      config.promptProfiles.byModel = { [TEST_MODEL]: PROFILE_ID };
      promptSelectorService.reconcile();

      const state = await readState(port);

      expect(state.available).toEqual([DEFAULT_ID, PROFILE_ID]);
      expect(state.selectable).toEqual([DEFAULT_ID, PROFILE_ID]);
      // No override, so the model's binding is what is active.
      expect(state.override).toBeNull();
      expect(state.active).toBe(PROFILE_ID);
      expect(state.byModel).toEqual({ [TEST_MODEL]: PROFILE_ID });
      expect(state.currentModel).toBe(TEST_MODEL);
    });
  });

  test('offers "default" even when the feature is off', async () => {
    await withServer(async (port) => {
      config.promptProfiles.available = [];

      const state = await readState(port);

      // `available` mirrors the whitelist and is empty here on purpose…
      expect(state.available).toEqual([]);
      // …but a picker with no rows in it is a bug, not an off switch.
      expect(state.selectable).toEqual([DEFAULT_ID]);
      expect(state.active).toBe(DEFAULT_ID);
    });
  });
});

describe('POST /api/prompt-profiles/override', () => {
  test('rejects an unknown profile with 400 and leaves the state untouched', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/prompt-profiles/override', 'POST', {
        body: { profile: 'not-a-profile' },
      });
      expect(res.status).toBe(400);

      // The message has to name what was wrong; a bare 400 is unactionable.
      expect((await json<ErrorBody>(res)).error).toContain('not-a-profile');

      const state = await readState(port);
      expect(state.override).toBeNull();
      expect(state.active).toBe(DEFAULT_ID);
      expect(getActivePromptProfileId()).toBe(DEFAULT_ID);
    });
  });

  test('rejects a body that is missing "profile", or is neither string nor null', async () => {
    await withServer(async (port) => {
      const missing = await call(port, '/api/prompt-profiles/override', 'POST', { body: { nope: 1 } });
      expect(missing.status).toBe(400);

      const wrongType = await call(port, '/api/prompt-profiles/override', 'POST', {
        body: { profile: { id: PROFILE_ID } },
      });
      expect(wrongType.status).toBe(400);

      const state = await readState(port);
      expect(state.override).toBeNull();
    });
  });

  test('accepts a profile, shows it in the next GET, and clears on null', async () => {
    await withServer(async (port) => {
      const applied = await call(port, '/api/prompt-profiles/override', 'POST', {
        body: { profile: PROFILE_ID },
      });
      expect(applied.status).toBe(200);

      // The route answers with the new state, so the UI needs no second round trip.
      const appliedBody = await json<AppliedState>(applied);
      expect(appliedBody.ok).toBe(true);
      expect(appliedBody.override).toBe(PROFILE_ID);
      expect(appliedBody.active).toBe(PROFILE_ID);

      const state = await readState(port);
      expect(state.override).toBe(PROFILE_ID);
      expect(state.active).toBe(PROFILE_ID);
      // And it reached the prompt resolver, not just the dashboard's copy of it.
      expect(getActivePromptProfileId()).toBe(PROFILE_ID);

      const cleared = await call(port, '/api/prompt-profiles/override', 'POST', {
        body: { profile: null },
      });
      expect(cleared.status).toBe(200);
      const clearedBody = await json<AppliedState>(cleared);
      expect(clearedBody.override).toBeNull();
      expect(clearedBody.active).toBe(DEFAULT_ID);
      expect(getActivePromptProfileId()).toBe(DEFAULT_ID);
    });
  });

  test('an override wins over the model binding, and the UI can still see the binding', async () => {
    await withServer(async (port) => {
      // Model bound to `default`, operator overrides it to the big profile.
      config.promptProfiles.byModel = { [TEST_MODEL]: DEFAULT_ID };
      promptSelectorService.reconcile();

      await call(port, '/api/prompt-profiles/override', 'POST', { body: { profile: PROFILE_ID } });

      const state = await readState(port);
      expect(state.byModel[TEST_MODEL]).toBe(DEFAULT_ID);
      expect(state.override).toBe(PROFILE_ID);
      expect(state.active).toBe(PROFILE_ID);
    });
  });

  test('changing the model clears the override and lands on the new model binding', async () => {
    await withServer(async (port) => {
      config.dashboard.modelOptions = [TEST_MODEL, OTHER_MODEL];
      config.promptProfiles.byModel = { [OTHER_MODEL]: PROFILE_ID };

      await call(port, '/api/prompt-profiles/override', 'POST', { body: { profile: DEFAULT_ID } });
      expect(getActivePromptProfileId()).toBe(DEFAULT_ID);

      // Deliberate, and the reason the UI has to say so: a model switch means
      // "this model wants its own prompts".
      const switched = await call(port, '/api/models', 'POST', { body: { model: OTHER_MODEL } });
      expect(switched.status).toBe(200);

      const state = await readState(port);
      expect(state.override).toBeNull();
      expect(state.active).toBe(PROFILE_ID);
    });
  });

  test('a model switch with no binding falls back to default, still with no override', async () => {
    await withServer(async (port) => {
      config.dashboard.modelOptions = [TEST_MODEL, OTHER_MODEL];

      await call(port, '/api/prompt-profiles/override', 'POST', { body: { profile: PROFILE_ID } });
      await call(port, '/api/models', 'POST', { body: { model: OTHER_MODEL } });

      const state = await readState(port);
      expect(state.override).toBeNull();
      expect(state.active).toBe(DEFAULT_ID);
    });
  });

  test('resetting the model clears the override too', async () => {
    await withServer(async (port) => {
      config.dashboard.modelOptions = [TEST_MODEL];
      await call(port, '/api/prompt-profiles/override', 'POST', { body: { profile: PROFILE_ID } });
      expect(getActivePromptProfileId()).toBe(PROFILE_ID);

      expect((await call(port, '/api/models/reset', 'POST')).status).toBe(200);

      const state = await readState(port);
      expect(state.override).toBeNull();
    });
  });
});

describe('the persona editor writes into the active profile', () => {
  /** Select the test profile through the real route, so the whole chain runs. */
  async function activateProfile(port: number): Promise<void> {
    const res = await call(port, '/api/prompt-profiles/override', 'POST', {
      body: { profile: PROFILE_ID },
    });
    expect(res.status).toBe(200);
  }

  function loadFile(port: number, path: string): Promise<PersonaFile> {
    return call(port, `/api/persona?path=${encodeURIComponent(path)}`, 'GET').then((r) =>
      json<PersonaFile>(r),
    );
  }

  function savePersona(port: number, path: string, content: string, ifMatch: string) {
    return call(port, '/api/persona', 'PUT', { body: { path, content, ifMatch } });
  }

  test('a save under a non-default profile lands in that profile and not in default', async () => {
    await withServer(async (port) => {
      await activateProfile(port);

      // The editor was handed the profile's copy, so that is what it sends back.
      const loaded = await loadFile(port, IDENTITY);
      expect(loaded.content).toBe(PROFILE_IDENTITY);
      expect(loaded.profile).toBe(PROFILE_ID);
      expect(loaded.overridden).toBe(true);

      const res = await savePersona(port, IDENTITY, 'edited under the profile', loaded.content);
      expect(res.status).toBe(200);
      expect((await json<{ profile: string }>(res)).profile).toBe(PROFILE_ID);

      // The point of the whole change: the shared default is untouched.
      expect(read(profileIdentityPath)).toBe('edited under the profile');
      expect(read(defaultIdentityPath)).toBe(DEFAULT_IDENTITY);
    });
  });

  test('saving a file the profile inherits creates the override instead of editing default', async () => {
    await withServer(async (port) => {
      // No reinforcement.txt in the profile yet: the editor shows the default's.
      rmSync(profileReinforcementPath, { force: true });
      await activateProfile(port);

      const loaded = await loadFile(port, REINFORCEMENT);
      expect(loaded.exists).toBe(true);
      expect(loaded.content).toBe(DEFAULT_REINFORCEMENT);
      expect(loaded.overridden).toBe(false);

      const res = await savePersona(port, REINFORCEMENT, 'profile-only reinforcement', loaded.content);
      expect(res.status).toBe(200);

      // This is the silent wrong-file write the feature exists to avoid: an edit
      // to an inherited file must not land in prompt_storage/, where it would
      // change the default for every profile at once. It also has to *succeed* —
      // resolving the write target through the read path would have fallen back
      // to the default root and rewritten it.
      expect(read(profileReinforcementPath)).toBe('profile-only reinforcement');
      expect(read(defaultReinforcementPath)).toBe(DEFAULT_REINFORCEMENT);
    });
  });

  test('under default, a save still lands in prompt_storage', async () => {
    await withServer(async (port) => {
      const loaded = await loadFile(port, IDENTITY);
      expect(loaded.profile).toBe(DEFAULT_ID);

      const res = await savePersona(port, IDENTITY, 'edited under default', loaded.content);
      expect(res.status).toBe(200);

      expect(read(defaultIdentityPath)).toBe('edited under default');
      expect(read(profileIdentityPath)).toBe(PROFILE_IDENTITY);
    });
  });

  test('a stale ifMatch still conflicts, and against the effective content', async () => {
    await withServer(async (port) => {
      rmSync(profileReinforcementPath, { force: true });
      await activateProfile(port);

      const loaded = await loadFile(port, REINFORCEMENT);
      const stale = await savePersona(port, REINFORCEMENT, 'first write', 'something else entirely');
      expect(stale.status).toBe(409);

      // Nothing was written by the rejected request.
      expect(read(profileReinforcementPath)).toBeNull();
      expect(read(defaultReinforcementPath)).toBe(DEFAULT_REINFORCEMENT);

      // And the correct ifMatch — the content the editor actually loaded — works.
      expect((await savePersona(port, REINFORCEMENT, 'first write', loaded.content)).status).toBe(200);
    });
  });

  test('the list says which files the profile overrides and which it inherits', async () => {
    await withServer(async (port) => {
      rmSync(profileReinforcementPath, { force: true });
      await activateProfile(port);

      const payload = await json<PersonaList>(await call(port, '/api/persona', 'GET'));
      expect(payload.profile).toBe(PROFILE_ID);

      const byPath = new Map<string, PersonaListEntry>(
        payload.files.map((f) => [f.path, f]),
      );

      // The profile ships identity.txt, so that row is an override…
      expect(byPath.get(IDENTITY)!.overridden).toBe(true);
      // …and reinforcement.txt is read straight out of the default root, which
      // is the state that makes a profile cheap to author: copy one file,
      // inherit the rest.
      expect(byPath.get(REINFORCEMENT)!.overridden).toBe(false);
      expect(byPath.get(REINFORCEMENT)!.exists).toBe(true);
    });
  });

  test('the profile root is not listed as loose files', async () => {
    await withServer(async (port) => {
      // With `default` active the overlay is not part of the prompt set at all,
      // and `profiles/<id>/persona/…` is a path the bot never loads.
      const payload = await json<PersonaList>(await call(port, '/api/persona', 'GET'));
      const paths = payload.files.map((f) => f.path);
      expect(paths.some((p) => p.startsWith('profiles/'))).toBe(false);
    });
  });

  test('a path outside the allow-list is still refused before any path is built', async () => {
    await withServer(async (port) => {
      await activateProfile(port);

      const traversal = await savePersona(port, '../../.env', 'owned', '');
      expect(traversal.status).toBe(400);
      expect((await json<ErrorBody>(traversal)).error).toContain('not editable');

      const readTraversal = await call(port, '/api/persona?path=../../.env', 'GET');
      expect(readTraversal.status).toBe(400);
    });
  });

  test('an empty identity is still refused, under a profile too', async () => {
    await withServer(async (port) => {
      await activateProfile(port);

      const res = await savePersona(port, IDENTITY, '   ', PROFILE_IDENTITY);
      expect(res.status).toBe(400);
      expect(read(profileIdentityPath)).toBe(PROFILE_IDENTITY);
    });
  });
});

describe('GET /api/guild-prompt-profiles is behind the same gate', () => {
  test('requires authentication', async () => {
    await withServer(async (port) => {
      useGuildService();
      const res = await call(port, '/api/guild-prompt-profiles', 'GET', { auth: false });
      expect(res.status).toBe(401);
    });
  });

  test('rejects a rebound Host with 421', async () => {
    await withServer(async (port) => {
      useGuildService();
      // Full DNS rebinding: same-origin by every header, valid credentials.
      const res = await call(port, '/api/guild-prompt-profiles', 'GET', {
        host: 'evil.com',
        headers: { Origin: 'http://evil.com' },
      });
      expect(res.status).toBe(421);
    });
  });

  test('a cross-site mutation is rejected, and nothing is assigned', async () => {
    await withServer(async (port) => {
      useGuildService();

      // A same-origin request, to prove the guard below is what refuses it and
      // not the body or the eligibility check.
      expect((await assign(port, GUILD_A, LABEL_A)).status).toBe(200);

      const crossSite = await call(port, '/api/guild-prompt-profiles', 'POST', {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
        body: { guildId: GUILD_B, profile: LABEL_B },
      });
      expect(crossSite.status).toBe(403);

      const state = await readGuildState(port);
      expect(state.assignments[GUILD_A]?.profile).toBe(LABEL_A);
      // The rejected request changed nothing — a cross-site POST must not be able
      // to steer a guild even to a valid profile.
      expect(state.assignments[GUILD_B]).toBeUndefined();
    });
  });
});

describe('GET /api/guild-prompt-profiles', () => {
  test('reports the effective profile and which rule produced it', async () => {
    await withServer(async (port) => {
      // Only guild A has a folder on disk, so the two configured guilds resolve
      // by *different* rules — which is exactly what `source` exists to say. A
      // payload that only carried `profile` would make these two look identical
      // to the UI, and the difference between "deliberately assigned" and
      // "happens to have a folder" is the whole point of the view.
      useGuildService({ ownFolders: [LABEL_A] });

      const state = await readGuildState(port);
      const byId = new Map(state.guilds.map((g) => [g.guildId, g]));

      expect(state.guilds.map((g) => g.guildId)).toEqual([GUILD_A, GUILD_B]);

      // Rule 2: the folder exists, so it resolves with no assignment row at all.
      const a = byId.get(GUILD_A)!;
      expect(a.profile).toBe(LABEL_A);
      expect(a.source).toBe('own-folder');
      expect(a.changedAt).toBeNull();
      expect(a.eligible).toBe(true);

      // Rule 3: no folder, so it follows the main page. And saying so is the
      // point — a guild reading `default` because nothing else applies must not
      // look like a guild that was told to.
      const b = byId.get(GUILD_B)!;
      expect(b.profile).toBe(DEFAULT_ID);
      expect(b.source).toBe('main');
      expect(b.changedAt).toBeNull();
    });
  });

  test('an assignment wins over the own-folder default, and is reported as such', async () => {
    await withServer(async (port) => {
      useGuildService({ ownFolders: [LABEL_A, LABEL_B] });

      expect((await assign(port, GUILD_A, PROFILE_ID)).status).toBe(200);

      const state = await readGuildState(port);
      const a = state.guilds.find((g) => g.guildId === GUILD_A)!;
      expect(a.profile).toBe(PROFILE_ID);
      expect(a.source).toBe('assignment');
      expect(a.changedAt).not.toBeNull();

      // The other guild is untouched by its neighbour's write — the failure mode
      // a single shared mutable profile id would produce.
      const b = state.guilds.find((g) => g.guildId === GUILD_B)!;
      expect(b.profile).toBe(LABEL_B);
      expect(b.source).toBe('own-folder');
    });
  });

  test('offers every guild\'s own label even when it is not whitelisted', async () => {
    await withServer(async (port) => {
      useGuildService();

      // `available` deliberately excludes both labels, as a `.env` that lists
      // only `PROMPT_PROFILES` would. Plan §3.5: a GUILD_PROMPT_PROFILES entry
      // authorises its label on its own. Without them in `selectable` the guild
      // dropdown would have no row for the guild's own profile, and the one
      // assignment that needs no configuration would be unreachable from the UI.
      const state = await readGuildState(port);
      expect(state.selectable).toContain(LABEL_A);
      expect(state.selectable).toContain(LABEL_B);
      expect(state.selectable).toContain(DEFAULT_ID);
      // Still the whitelist plus the guild labels, nothing looser.
      expect(state.selectable.sort()).toEqual([DEFAULT_ID, LABEL_A, LABEL_B, PROFILE_ID].sort());
    });
  });

  test('reports the cap and the main selection, so the UI needs no second request', async () => {
    await withServer(async (port) => {
      useGuildService();
      config.promptProfiles.maxGuilds = 2;

      const state = await readGuildState(port);
      expect(state.maxGuilds).toBe(2);
      expect(state.mainActive).toBe(DEFAULT_ID);

      // A guild the bot is not in is still listed, with the fact recorded — the
      // operator's first question about a guild id is usually "is that right?",
      // and hiding the entry would leave them unable to tell a typo from a
      // guild the bot has not joined yet.
      expect(state.guilds.every((g) => g.inCache === false)).toBe(true);
    });
  });
});

describe('POST /api/guild-prompt-profiles', () => {
  test('rejects a guild that is not in GUILD_PROMPT_PROFILES, naming the list', async () => {
    await withServer(async (port) => {
      useGuildService();

      const res = await assign(port, GUILD_FOREIGN, LABEL_A);
      expect(res.status).toBe(400);

      // The message has to name what is configured. An operator's first reaction
      // to this 400 is to go hunting for a typo in the guild id, and "not
      // allowed" with no list sends them to the wrong file.
      const body = await json<ErrorBody>(res);
      expect(body.error).toContain('GUILD_PROMPT_PROFILES');
      expect(body.error).toContain(GUILD_A);
      expect(body.error).toContain(GUILD_B);

      const state = await readGuildState(port);
      expect(state.assignments[GUILD_FOREIGN]).toBeUndefined();
    });
  });

  test('rejects a profile belonging to some other guild or to nobody', async () => {
    await withServer(async (port) => {
      useGuildService();

      // Guild A's own label is fine (§3.5). Guild B's is not: self-authorizing
      // means "for its own guild", and letting A borrow B's would let one guild's
      // persona overwrite another's.
      const foreign = await assign(port, GUILD_A, LABEL_B);
      expect(foreign.status).toBe(400);
      expect((await json<ErrorBody>(foreign)).error).toContain(LABEL_B);

      // And something that is not a profile at all.
      const bogus = await assign(port, GUILD_A, 'not-a-profile');
      expect(bogus.status).toBe(400);
      expect((await json<ErrorBody>(bogus)).error).toContain('not-a-profile');

      const state = await readGuildState(port);
      expect(state.assignments[GUILD_A]).toBeUndefined();
    });
  });

  test('rejects a malformed body without writing anything', async () => {
    await withServer(async (port) => {
      useGuildService();

      expect((await assign(port, GUILD_A, undefined as never)).status).toBe(400);
      expect((await assign(port, '' as string, LABEL_A)).status).toBe(400);
      // Same shape as the `/override` handler: a non-string, non-null profile is
      // a type error, not an allow-list error, and must say so.
      const wrongType = await call(port, '/api/guild-prompt-profiles', 'POST', {
        body: { guildId: GUILD_A, profile: { id: LABEL_A } },
      });
      expect(wrongType.status).toBe(400);
      expect((await json<ErrorBody>(wrongType)).error).toBe('"profile" must be a string or null');

      const missingGuild = await call(port, '/api/guild-prompt-profiles', 'POST', {
        body: { profile: LABEL_A },
      });
      expect(missingGuild.status).toBe(400);

      const state = await readGuildState(port);
      expect(Object.keys(state.assignments)).toEqual([]);
    });
  });

  test('a round trip assigns, shows up in the next GET, and clears on null', async () => {
    await withServer(async (port) => {
      useGuildService();

      const applied = await assign(port, GUILD_A, LABEL_A);
      expect(applied.status).toBe(200);
      // The route answers with the new state, so the UI needs no second round trip.
      const body = await json<GuildState & { ok: boolean }>(applied);
      expect(body.ok).toBe(true);
      expect(body.assignments[GUILD_A]?.profile).toBe(LABEL_A);

      const cleared = await assign(port, GUILD_A, null);
      expect(cleared.status).toBe(200);
      expect((await json<GuildState>(cleared)).assignments[GUILD_A]).toBeUndefined();
    });
  });

  test('clearing returns the guild to its own-folder default, not to `default`', async () => {
    await withServer(async (port) => {
      // The folder exists, so the post-clear answer must be `guild-a-rpd`.
      useGuildService({ ownFolders: [LABEL_A] });

      await assign(port, GUILD_A, PROFILE_ID);
      expect((await readGuildState(port)).assignments[GUILD_A]?.profile).toBe(PROFILE_ID);

      await assign(port, GUILD_A, null);

      const state = await readGuildState(port);
      const a = state.guilds.find((g) => g.guildId === GUILD_A)!;
      // "Clear" means stop overriding. A version that deleted the row and fell
      // through to the main page would silently change the guild's persona —
      // the opposite of what the operator asked for when they hit clear.
      expect(a.profile).toBe(LABEL_A);
      expect(a.source).toBe('own-folder');
      expect(a.changedAt).toBeNull();
    });
  });
});

describe('the persona editor is profile-aware', () => {
  function loadPersona(port: number, path: string, profile?: string) {
    const query = new URLSearchParams({ path });
    if (profile) query.set('profile', profile);
    return call(port, `/api/persona?${query.toString()}`, 'GET').then((r) => json<PersonaFile>(r));
  }

  function saveInto(port: number, path: string, profile: string, content: string, ifMatch: string) {
    return call(port, '/api/persona', 'PUT', { body: { path, profile, content, ifMatch } });
  }

  test('lists every profile, grouped and labelled, with the main one marked', async () => {
    await withServer(async (port) => {
      useGuildService();
      config.promptProfiles.byModel = { [TEST_MODEL]: PROFILE_ID };
      promptSelectorService.reconcile();

      const payload = await json<GroupedPersonaList>(await call(port, '/api/persona', 'GET'));

      // `default`, the main selection, and both guild folders — the editor has to
      // offer all of them, because a guild's persona is edited here rather than
      // behind a second UI.
      expect(payload.profiles.map((p) => p.id)).toEqual([
        DEFAULT_ID,
        PROFILE_ID,
        LABEL_A,
        LABEL_B,
      ]);

      const byId = new Map(payload.profiles.map((p) => [p.id, p]));
      expect(byId.get(DEFAULT_ID)!.kind).toBe('default');
      expect(byId.get(PROFILE_ID)!.kind).toBe('main');
      expect(byId.get(LABEL_A)!.kind).toBe('guild');
      expect(byId.get(LABEL_A)!.guildId).toBe(GUILD_A);

      // Exactly one entry is the main one — otherwise the UI has two "main"
      // headings and no way to know which one a save without an explicit profile
      // would target.
      expect(payload.profiles.filter((p) => p.main)).toHaveLength(1);
      expect(byId.get(PROFILE_ID)!.main).toBe(true);
    });
  });

  test('every row carries the profile it belongs to, and the save goes there', async () => {
    await withServer(async (port) => {
      useGuildService();

      const payload = await json<GroupedPersonaList>(
        await call(port, '/api/persona?profile=' + LABEL_A, 'GET'),
      );
      expect(payload.profile).toBe(LABEL_A);
      // Per-row, because editing is per-row: the UI must not share one textarea
      // across groups, and a row that did not say which profile it belongs to
      // could not be saved safely.
      expect(payload.files.every((f) => f.profile === LABEL_A)).toBe(true);

      // The guild folder does not exist on disk, so the row is the inherited
      // default and is marked not overridden. It must still be *editable* —
      // hiding it would leave no way to create the folder without hand-editing
      // the filesystem.
      const identity = payload.files.find((f) => f.path === IDENTITY)!;
      expect(identity.overridden).toBe(false);
    });
  });

  test('rejects a profile that is not default, the main selection, or a guild label', async () => {
    await withServer(async (port) => {
      useGuildService();

      // THE security case. The profile root is not sandboxed, so naming an
      // arbitrary folder would otherwise make this route an arbitrary-write
      // primitive over the whole operator prompt tree.
      const res = await saveInto(port, IDENTITY, FOREIGN_LABEL, 'owned', '');
      expect(res.status).toBe(400);
      expect((await json<ErrorBody>(res)).error).toContain(FOREIGN_LABEL);

      // Even the *real* profile root, `prompt_storage`, is only reachable by
      // naming `default` explicitly — and then the write is the operator's
      // ordinary default edit, which the allow-list does permit.
      expect((await saveInto(port, IDENTITY, DEFAULT_ID, 'fine', DEFAULT_IDENTITY)).status).toBe(200);
      expect(read(defaultIdentityPath)).toBe('fine');
    });
  });

  test('a guild folder nobody configured is refused, even with a real folder behind it', async () => {
    await withServer(async (port) => {
      // `PROFILE_ROOT` is a genuine directory under the real `profiles/` root,
      // created and removed by this file, and it *is* whitelisted. So a check
      // that only asked "is it whitelisted?" would let this through. The route
      // must refuse anything outside {default, main selection, guild labels} —
      // proving the gate is the allow-list and not a proxy for it.
      useGuildService();
      setActivePromptProfileId(DEFAULT_ID);

      const res = await saveInto(port, IDENTITY, PROFILE_ID, 'owned', '');
      expect(res.status).toBe(400);
      expect(read(profileIdentityPath)).toBe(PROFILE_IDENTITY);
    });
  });

  test('a real stray folder is refused too, which is the arbitrary-write case', async () => {
    // Needs a genuine directory under a genuine `profiles/` root, because
    // `getPromptProfileRoot` accepts any *existing* folder. `PROMPT_PROFILES_DIR`
    // is anchored to the repository with no env override (`utils/paths.ts`), so
    // the only way to have one without touching the operator's tree is a cold
    // subprocess that mocks `paths.ts` before anything imports it. Same
    // mechanism, and the same reason, as `swarmui-profile-overlay.test.ts`.
    const root = mkdtempSync(join(tmpdir(), 'lumia-persona-guild-write-'));
    try {
      const transcript = runWriteHarness(root);

      // The guild group is offered even though its folder does not exist, and its
      // rows say which profile they belong to — per-row, because editing is
      // per-row and a shared textarea across groups could not be saved safely.
      expect(transcript['list.status']).toBe(200);
      expect(transcript['list.profile']).toBe(LABEL_A);
      expect(transcript['list.rowProfile']).toBe(LABEL_A);
      expect(transcript['list.rowOverridden']).toBe(false);
      expect(JSON.parse(transcript['list.groups']).map((p: { id: string }) => p.id)).toEqual([
        DEFAULT_ID,
        LABEL_A,
      ]);

      // The row reads as the inherited default…
      expect(transcript['file.status']).toBe(200);
      expect(transcript['file.content']).toBe(DEFAULT_IDENTITY);
      expect(transcript['file.overridden']).toBe(false);

      // …and the save creates the folder and lands there. This is the only way a
      // guild's first override comes into being, so it has to work — not merely
      // not throw.
      expect(transcript['save.status']).toBe(200);
      expect(transcript['save.profile']).toBe(LABEL_A);
      expect(transcript['guild.folderExists']).toBe(true);
      expect(transcript['guild.file']).toBe('guild identity');
      // …and the shared default is untouched: an inherited file edited from the
      // guild group must create an override in *that* profile, never silently
      // rewrite the tree every other profile inherits from.
      expect(transcript['default.file']).toBe(DEFAULT_IDENTITY);

      // THE security case, with a real directory behind the id. Everything
      // `promptWritePath` does is inside a profile root that is not sandboxed, so
      // `getPromptProfileRoot` accepting this id is exactly why the allow-list
      // exists. A version of `assertEditableProfile` that only called
      // `getPromptProfileRoot` would write here.
      expect(transcript['stray.status']).toBe(400);
      expect(transcript['stray.error']).toContain(FOREIGN_LABEL);
      expect(transcript['stray.fileWritten']).toBe(false);

      // And the read route agrees with the write route about what is real, so
      // the UI cannot show a group whose save would be refused.
      expect(transcript['strayRead.status']).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});