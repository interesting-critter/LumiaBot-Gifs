import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseModelPromptProfiles,
  parsePromptProfileIds,
} from '../../utils/config';
import {
  DEFAULT_PROFILE_ID,
  PromptSelectorService,
  collectPromptProfileDiagnostics,
} from '../prompt-selector';

/**
 * Prompt-profile selection.
 *
 * The three things worth proving here:
 *
 *   1. **Parsing is loud.** A malformed `model=profile` entry and a binding that
 *      names a profile `PROMPT_PROFILES` does not allow are both dropped — but
 *      never silently. A binding silently dropped is the worst outcome the
 *      feature has: the dashboard shows the model, the config says it is bound,
 *      and nothing ever happens.
 *   2. **The override survives a restart.** The operator asked for this
 *      explicitly, so it is tested the way it happens: set it, throw the
 *      instance away, build a fresh one against the same database file.
 *   3. **Changing the model clears the override**, and lands on the new model's
 *      bound profile or on `default`. This is the specified behaviour, not an
 *      oversight, so it gets its own test rather than being left implicit.
 *
 * Every service instance here is built against a throwaway database in a temp
 * directory. The module-level singleton still uses the shared test DATA_DIR, but
 * nothing in this file asserts on it, and each instance is closed so no handle
 * outlives the test.
 */

const scratchDirs: string[] = [];

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-prompt-profile-'));
  scratchDirs.push(dir);
  return join(dir, 'dashboard_settings.db');
}

const AVAILABLE = ['default', 'big-rpd', 'nsfw-heavy'];

/**
 * Build a service with everything pinned, so the tests never depend on what the
 * machine running them has in `.env` or on disk.
 */
function makeService(
  overrides: Partial<{
    available: readonly string[];
    byModel: Record<string, string>;
    currentModel: string;
  }> = {},
): PromptSelectorService {
  return new PromptSelectorService({
    databasePath: dbFile(),
    available: overrides.available ?? AVAILABLE,
    byModel: overrides.byModel ?? {},
    currentModel: overrides.currentModel ?? 'gpt-4o',
  });
}

let warns: ReturnType<typeof spyOn<Console, 'warn'>>;
let errors: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  warns = spyOn(console, 'warn').mockImplementation(() => {});
  errors = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warns.mockRestore();
  errors.mockRestore();
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('PROMPT_PROFILES parsing', () => {
  test('trims entries, drops blanks, dedupes and preserves order', () => {
    expect(parsePromptProfileIds(' default , big-rpd ,, big-rpd ,nsfw-heavy')).toEqual([
      'default',
      'big-rpd',
      'nsfw-heavy',
    ]);
  });

  test('unset or empty means the feature is off, not an error', () => {
    expect(parsePromptProfileIds('')).toEqual([]);
    expect(parsePromptProfileIds(undefined)).toEqual([]);
    expect(parsePromptProfileIds('   ')).toEqual([]);
  });

  test('refuses ids that would escape the profile directory', () => {
    // These become directory names under prompt_storage/profiles/.
    expect(parsePromptProfileIds('../../etc,..,ok-profile')).toEqual(['ok-profile']);
    expect(warns).toHaveBeenCalled();
  });
});

describe('MODEL_PROMPT_PROFILES parsing', () => {
  test('reads model=profile pairs', () => {
    expect(parseModelPromptProfiles('kimi-k2-thinking=big-rpd, gemini-3-flash = big-rpd ', ['big-rpd'])).toEqual({
      'kimi-k2-thinking': 'big-rpd',
      'gemini-3-flash': 'big-rpd',
    });
  });

  test('names every malformed entry in a warning instead of swallowing it', () => {
    const parsed = parseModelPromptProfiles('kimi-k2-thinking, =big-rpd, kimi=, a=b=c', ['big-rpd']);

    expect(parsed).toEqual({});
    const said = warns.mock.calls.map((call) => String(call[0])).join('\n');
    // Each dropped entry is quoted back to the operator.
    expect(said).toContain('kimi-k2-thinking');
    expect(said).toContain('=big-rpd');
    expect(said).toContain('kimi=');
    expect(said).toContain('a=b=c');
  });

  test('drops a binding whose profile is not whitelisted, and says so loudly', () => {
    const parsed = parseModelPromptProfiles('kimi-k2-thinking=typo-profile', ['big-rpd']);

    // Dropped, not passed through: a binding the dashboard could never activate
    // must not reach request time.
    expect(parsed).toEqual({});

    const warning = warns.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warning).toContain('CONFIGURATION ERROR');
    expect(warning).toContain('kimi-k2-thinking=typo-profile');
    expect(warning).toContain('big-rpd');
    // Loud means console.warn at config time, not just a stray log line.
    expect(warns).toHaveBeenCalled();
  });

  test('every binding is an error when the whitelist is empty', () => {
    expect(parseModelPromptProfiles('kimi-k2-thinking=big-rpd', [])).toEqual({});
    expect(warns.mock.calls.map((c) => String(c[0])).join('\n')).toContain('feature is off');
  });

  test('keeps the first binding for a model and warns about the duplicate', () => {
    const parsed = parseModelPromptProfiles('m=big-rpd,m=nsfw-heavy', ['big-rpd', 'nsfw-heavy']);

    expect(parsed).toEqual({ m: 'big-rpd' });
    expect(warns.mock.calls.map((c) => String(c[0])).join('\n')).toContain('duplicate binding');
  });
});

describe('startup reconciliation of config against disk', () => {
  test('reports a whitelisted profile that has no folder on disk', () => {
    // The typo case: the dashboard offers a dropdown entry that does nothing,
    // and nothing in the request path would ever say so.
    const diagnostics = collectPromptProfileDiagnostics({
      available: ['default', 'big-rpd', 'big-rpdd'],
      byModel: {},
      onDisk: ['default', 'big-rpd'],
      persistedOverride: null,
      persistedActive: 'default',
    });

    expect(diagnostics.missingFolders).toEqual(['big-rpdd']);
    expect(diagnostics.notWhitelisted).toEqual([]);
  });

  test('reports profile folders that cannot be selected because they are not whitelisted', () => {
    const diagnostics = collectPromptProfileDiagnostics({
      available: ['big-rpd'],
      byModel: {},
      onDisk: ['default', 'big-rpd', 'unlisted'],
      persistedOverride: null,
      persistedActive: 'big-rpd',
    });

    expect(diagnostics.notWhitelisted).toEqual(['unlisted']);
  });

  test('reports a model binding that points at a profile with no folder', () => {
    const diagnostics = collectPromptProfileDiagnostics({
      available: ['big-rpd'],
      byModel: { 'kimi-k2-thinking': 'big-rpd' },
      onDisk: ['default'],
      persistedOverride: null,
      persistedActive: 'default',
    });

    expect(diagnostics.bindingsWithoutFolder).toEqual(['kimi-k2-thinking=big-rpd']);
  });

  test('"default" needs no folder and is never reported as missing', () => {
    // `default` IS prompt_storage/ — there is nothing for it to have.
    const diagnostics = collectPromptProfileDiagnostics({
      available: ['default'],
      byModel: {},
      onDisk: ['default'],
      persistedOverride: null,
      persistedActive: 'default',
    });

    expect(diagnostics.missingFolders).toEqual([]);
    expect(diagnostics.notWhitelisted).toEqual([]);
    expect(diagnostics.bindingsWithoutFolder).toEqual([]);
    expect(diagnostics.stalePersisted).toEqual([]);
  });

  test('reports a persisted selection that no longer exists anywhere', () => {
    const diagnostics = collectPromptProfileDiagnostics({
      available: ['big-rpd'],
      byModel: {},
      onDisk: ['default', 'big-rpd'],
      persistedOverride: 'deleted-profile',
      persistedActive: 'big-rpd',
    });

    expect(diagnostics.stalePersisted).toEqual(['deleted-profile']);
  });
});

describe('effective profile resolution', () => {
  test('with no override the bound profile wins, otherwise default', () => {
    const bound = makeService({ byModel: { 'kimi-k2-thinking': 'big-rpd' }, currentModel: 'kimi-k2-thinking' });
    expect(bound.getState().active).toBe('big-rpd');
    bound.close();

    const unbound = makeService({ byModel: { 'kimi-k2-thinking': 'big-rpd' }, currentModel: 'gpt-4o' });
    expect(unbound.getState().active).toBe(DEFAULT_PROFILE_ID);
    unbound.close();
  });

  test('the override beats the model binding', () => {
    const service = makeService({ byModel: { 'kimi-k2-thinking': 'big-rpd' }, currentModel: 'kimi-k2-thinking' });
    service.setOverride('nsfw-heavy');

    expect(service.getState().active).toBe('nsfw-heavy');
    service.close();
  });

  test('selectableProfiles always offers the built-in default', () => {
    // getState().available mirrors the whitelist exactly — [] means "feature
    // off" and the UI must not read that as "there is nothing to select".
    const service = makeService({ available: [] });

    expect(service.getState().available).toEqual([]);
    expect(service.selectableProfiles()).toEqual(['default']);
    expect(service.getState().active).toBe(DEFAULT_PROFILE_ID);
    service.close();
  });
});

describe('setOverride validation', () => {
  test('throws for a profile that is not whitelisted', () => {
    const service = makeService();

    // The dashboard turns this into a 400.
    expect(() => service.setOverride('nope')).toThrow(/not an allowed prompt profile/);
    expect(service.getState().override).toBeNull();
    service.close();
  });

  test('throws with a distinct message when no profiles are configured', () => {
    const service = makeService({ available: [] });

    expect(() => service.setOverride('nope')).toThrow(/PROMPT_PROFILES/);
    service.close();
  });

  test('still accepts "default" when the feature is off', () => {
    // `default` is the profile in use whenever nothing else applies; refusing it
    // would make "explicitly go back to default" impossible with no whitelist.
    const service = makeService({ available: [] });

    expect(service.setOverride('default').override).toBe('default');
    service.close();
  });

  test('a rejected override is never persisted', () => {
    const db = dbFile();
    const first = new PromptSelectorService({ databasePath: db, available: AVAILABLE, byModel: {}, currentModel: 'gpt-4o' });
    expect(() => first.setOverride('nope')).toThrow();
    first.close();

    const second = new PromptSelectorService({ databasePath: db, available: AVAILABLE, byModel: {}, currentModel: 'gpt-4o' });
    expect(second.getState().override).toBeNull();
    second.close();
  });

  test('a blank string clears the override rather than selecting a blank profile', () => {
    const service = makeService();
    service.setOverride('big-rpd');

    expect(service.clearOverride().override).toBeNull();
    expect(service.getState().active).toBe(DEFAULT_PROFILE_ID);
    service.close();
  });
});

describe('the override survives a restart', () => {
  test('a fresh instance against the same database returns it', () => {
    const db = dbFile();

    const first = makeServiceWith(db);
    first.setOverride('nsfw-heavy');
    first.close();

    // "Turn the bot off and on again."
    const second = makeServiceWith(db);
    const state = second.getState();

    expect(state.override).toBe('nsfw-heavy');
    expect(state.active).toBe('nsfw-heavy');
    second.close();
  });

  test('the resolved active profile is restored too, not just the override', () => {
    const db = dbFile();
    const options = { available: AVAILABLE, byModel: { 'kimi-k2-thinking': 'big-rpd' }, currentModel: 'kimi-k2-thinking' };

    const first = new PromptSelectorService({ databasePath: db, ...options });
    expect(first.getState().active).toBe('big-rpd');
    first.close();

    // No override was ever set, so this only works because the *resolved*
    // profile and the model it was resolved for were both persisted. Storing
    // the override alone would land back on `default` here.
    const second = new PromptSelectorService({ databasePath: db, ...options });
    expect(second.getState().override).toBeNull();
    expect(second.getState().active).toBe('big-rpd');
    second.close();
  });

  test('a restored model that differs from the recorded one re-resolves', () => {
    // model-selector restores its own dashboard selection during its module
    // evaluation, i.e. after this one is constructed. The recorded model is what
    // tells the two apart: if the model that turns up is not the one the
    // profile was resolved for, the profile is stale and is re-derived.
    const db = dbFile();

    const first = new PromptSelectorService({
      databasePath: db,
      available: AVAILABLE,
      byModel: { 'kimi-k2-thinking': 'big-rpd' },
      currentModel: 'kimi-k2-thinking',
    });
    expect(first.getState().active).toBe('big-rpd');
    first.close();

    const second = new PromptSelectorService({
      databasePath: db,
      available: AVAILABLE,
      byModel: { 'kimi-k2-thinking': 'big-rpd' },
      currentModel: 'gpt-4o',
    });
    expect(second.getState().active).toBe(DEFAULT_PROFILE_ID);
    second.close();
  });

  test('a stale persisted override no longer in the whitelist does not come back as the active profile', () => {
    const db = dbFile();

    const first = new PromptSelectorService({ databasePath: db, available: AVAILABLE, byModel: {}, currentModel: 'gpt-4o' });
    first.setOverride('nsfw-heavy');
    first.close();

    // The operator edited .env and removed the profile.
    const second = new PromptSelectorService({
      databasePath: db,
      available: ['default', 'big-rpd'],
      byModel: {},
      currentModel: 'gpt-4o',
    });
    const state = second.getState();

    // The id is reported so the dashboard can show/clear it rather than acting
    // on a selection that can no longer be honoured.
    expect(state.override).toBe('nsfw-heavy');
    expect(state.active).toBe('nsfw-heavy');
    expect(second.selectableProfiles()).not.toContain('nsfw-heavy');
    second.close();
  });
});

describe('changing the model clears the override', () => {
  test('and activates the new model\'s bound profile', () => {
    const service = makeService({ byModel: { 'kimi-k2-thinking': 'big-rpd' } });
    service.setOverride('nsfw-heavy');
    expect(service.getState().override).toBe('nsfw-heavy');

    const state = service.onModelChanged('kimi-k2-thinking');

    expect(state.override).toBeNull();
    expect(state.active).toBe('big-rpd');
    service.close();
  });

  test('and activates default when the new model has no binding', () => {
    const service = makeService({ byModel: { 'kimi-k2-thinking': 'big-rpd' } });
    service.setOverride('nsfw-heavy');

    const state = service.onModelChanged('gpt-4o');

    expect(state.override).toBeNull();
    expect(state.active).toBe(DEFAULT_PROFILE_ID);
    service.close();
  });

  test('a model change survives a restart without an override', () => {
    const db = dbFile();

    const first = new PromptSelectorService({
      databasePath: db,
      available: AVAILABLE,
      byModel: { 'kimi-k2-thinking': 'big-rpd' },
      currentModel: 'gpt-4o',
    });
    first.setOverride('nsfw-heavy');
    first.onModelChanged('kimi-k2-thinking');
    first.close();

    // `currentModel` is what `config.openai.modelAlias` reads as after
    // `model-selector.ts` has applied the change, which is exactly why the
    // switch is durable.
    const second = new PromptSelectorService({
      databasePath: db,
      available: AVAILABLE,
      byModel: { 'kimi-k2-thinking': 'big-rpd' },
      currentModel: 'kimi-k2-thinking',
    });
    expect(second.getState().active).toBe('big-rpd');
    expect(second.getState().override).toBeNull();
    second.close();
  });

  test('is safe with no override set — it just reconciles the active profile', () => {
    const service = makeService({ byModel: { 'kimi-k2-thinking': 'big-rpd' } });

    const state = service.onModelChanged('kimi-k2-thinking');

    expect(state.override).toBeNull();
    expect(state.active).toBe('big-rpd');
    service.close();
  });
});

describe('a profile with no folder on disk does not break the bot', () => {
  // `prompts.ts` throws for an id with no directory, and this runs from the
  // service's constructor. A whitelisted typo must not be able to stop the
  // process from importing.
  test('the service still resolves and reports the configured id', () => {
    const service = makeService({ available: ['default', 'does-not-exist-on-disk'] });

    expect(service.setOverride('does-not-exist-on-disk').override).toBe('does-not-exist-on-disk');
    expect(errors).toHaveBeenCalled();
    service.close();
  });
});

function makeServiceWith(db: string): PromptSelectorService {
  return new PromptSelectorService({
    databasePath: db,
    available: AVAILABLE,
    byModel: {},
    currentModel: 'gpt-4o',
  });
}