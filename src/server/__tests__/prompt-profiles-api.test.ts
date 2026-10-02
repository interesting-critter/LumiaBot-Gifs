import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from '../../utils/config';
import { PROMPT_STORAGE_DIR } from '../../utils/paths';
import { modelSelectorService } from '../../services/model-selector';
import { promptSelectorService } from '../../services/prompt-selector';
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

beforeAll(() => {
  savedDashboard = { ...config.dashboard };
  savedAvailable = [...config.promptProfiles.available];
  savedByModel = { ...config.promptProfiles.byModel };
  savedModelAlias = config.openai.modelAlias;
  savedModelOptions = [...config.dashboard.modelOptions];

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
});

afterAll(() => {
  Object.assign(config.dashboard, savedDashboard);
  config.promptProfiles.available = savedAvailable;
  config.promptProfiles.byModel = savedByModel;
  config.dashboard.modelOptions = savedModelOptions;
  config.openai.modelAlias = savedModelAlias;

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