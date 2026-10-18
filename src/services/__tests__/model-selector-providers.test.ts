import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { config } from '../../utils/config';
import { dbPath } from '../../utils/paths';
import { LEGACY_PROVIDER_NAME, type NamedProvider } from '../../utils/provider-registry';
import { modelSelectorService, ModelSelectorService } from '../model-selector';

/**
 * Provider-aware model selection.
 *
 * The behaviour under test is all in the SEAMS between the three places the
 * selection exists: the config the operator wrote (`DASHBOARD_MODELS`), the row
 * in `dashboard_settings.db`, and what the dashboard and the AI services read
 * back. A test that only called `setModel()` and asserted on `getState()` would
 * pass even if the persistence format were wrong, so the raw row is read here
 * directly — that is the artefact an upgrading operator actually has.
 *
 * The migration case gets its own `new ModelSelectorService()` rather than
 * poking at private fields, because "what does a boot do with an old row" is
 * precisely a question about the constructor.
 *
 * Everything here runs against the real singleton and the throwaway `DATA_DIR`
 * that `bunfig.toml`'s preload points at, so no row touches a real database.
 * Every mutated config key is restored in `afterEach`.
 */

/**
 * Two providers that deliberately SHARE a model id, plus one unique to each.
 *
 * The shared id is the whole point: it is the case a bare model string cannot
 * express, and the case where silently picking one provider would send the
 * operator's request somewhere they did not choose.
 */
const REGISTRY: NamedProvider[] = [
  {
    name: 'openrouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'or-key',
    models: ['anthropic/claude-sonnet-4-5', 'shared/model'],
  },
  {
    name: 'gemini',
    kind: 'google',
    baseUrl: undefined,
    apiKey: 'gem-key',
    models: ['gemini-3-pro', 'shared/model'],
  },
];

/** The flat union, i.e. exactly what `config.dashboard.modelOptions` holds. */
const FLAT = ['anthropic/claude-sonnet-4-5', 'shared/model', 'gemini-3-pro'];

const LEGACY_OPTIONS = ['gpt-4o', 'kimi-k2-thinking'];

const originals = {
  modelOptions: config.dashboard.modelOptions,
  modelProviders: config.dashboard.modelProviders,
  providersActive: config.providers.active,
  registry: config.providers.registry,
  modelAlias: config.openai.modelAlias,
};

const warn = spyOn(console, 'warn').mockImplementation(() => {});

function useLegacy(): void {
  config.providers.active = false;
  config.providers.registry = [];
  config.dashboard.modelProviders = [];
  config.dashboard.modelOptions = [...LEGACY_OPTIONS];
}

function useRegistry(): void {
  config.providers.active = true;
  config.dashboard.modelProviders = REGISTRY.map((p) => ({ ...p, models: [...p.models] }));
  config.providers.registry = config.dashboard.modelProviders;
  config.dashboard.modelOptions = [...FLAT];
}

/** The raw `model_override` row, as an operator upgrading would find it. */
function readRawRow(): string | undefined {
  const db = new Database(dbPath('dashboard_settings.db'));
  try {
    const row = db
      .query("SELECT value FROM settings WHERE key = 'model_override'")
      .get() as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

function writeRawRow(value: string): void {
  const db = new Database(dbPath('dashboard_settings.db'));
  try {
    db.run('DELETE FROM settings WHERE key = ?', ['model_override']);
    db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
      ['model_override', value, new Date().toISOString()],
    );
  } finally {
    db.close();
  }
}

beforeEach(() => {
  useLegacy();
});

afterEach(() => {
  // Clearing the singleton's override first matters: `reset()` writes to the DB
  // using whatever config is in effect, so restoring config before resetting
  // would leave a row from the test's registry behind.
  modelSelectorService.reset();
  config.dashboard.modelOptions = originals.modelOptions;
  config.dashboard.modelProviders = originals.modelProviders;
  config.providers.active = originals.providersActive;
  config.providers.registry = originals.registry;
  config.openai.modelAlias = originals.modelAlias;
});

afterAll(() => {
  warn.mockRestore();
});

describe('legacy mode (no provider registry)', () => {
  test('a single-argument setModel still works, with no provider in the state', () => {
    const state = modelSelectorService.setModel('kimi-k2-thinking');

    // Every pre-registry caller passes one argument; it must keep working with
    // no config change at all beyond the flat model list.
    expect(state.active).toBe('kimi-k2-thinking');
    expect(state.source).toBe('dashboard');
    expect(state.provider).toBeNull();
    // `[]` (not a synthetic one-provider group) so the dashboard renders
    // today's flat list exactly.
    expect(state.providerOptions).toEqual([]);
    expect(modelSelectorService.getActiveModel()).toBe('kimi-k2-thinking');
  });

  test('an unknown model still throws the "not an allowed model" message', () => {
    expect(() => modelSelectorService.setModel('not-a-real-model')).toThrow(
      /"not-a-real-model" is not an allowed model\. Allowed: gpt-4o, kimi-k2-thinking/,
    );
  });

  test('getActiveProvider returns the legacy implicit provider', () => {
    modelSelectorService.setModel('kimi-k2-thinking');

    const provider = modelSelectorService.getActiveProvider();
    // The point of the contract: one code path for callers. Under legacy
    // behaviour there IS a provider, and it carries the legacy values, so
    // Wave 2B never has to branch on `config.providers.active`.
    expect(provider?.name).toBe(LEGACY_PROVIDER_NAME);
    expect(provider?.kind).toBe('openai');
    expect(provider?.apiKey).toBe(config.openai.apiKey);
    expect(provider?.baseUrl).toBe(config.openai.baseUrl || undefined);
    expect(provider?.models).toEqual([...LEGACY_OPTIONS]);
  });

  test('naming a provider under legacy mode is rejected, not ignored', () => {
    // There is nothing to resolve it against, so pretending the name was
    // accepted would leave the caller believing routing had changed.
    expect(() => modelSelectorService.setModel('gpt-4o', LEGACY_PROVIDER_NAME)).toThrow(
      /no provider named/,
    );
  });
});

describe('provider-aware selection', () => {
  beforeEach(() => {
    useRegistry();
  });

  test('an explicit provider + model pair is stored and surfaced', () => {
    const state = modelSelectorService.setModel('anthropic/claude-sonnet-4-5', 'openrouter');

    expect(state.active).toBe('anthropic/claude-sonnet-4-5');
    expect(state.provider).toBe('openrouter');
    // The grouped view the dashboard renders: name, kind, models — and no URL.
    expect(state.providerOptions).toEqual([
      { name: 'openrouter', kind: 'openai', models: ['anthropic/claude-sonnet-4-5', 'shared/model'] },
      { name: 'gemini', kind: 'google', models: ['gemini-3-pro', 'shared/model'] },
    ]);
    expect(Object.keys(state.providerOptions[0] ?? {})).not.toContain('baseUrl');

    const provider = modelSelectorService.getActiveProvider();
    expect(provider?.name).toBe('openrouter');
    expect(provider?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(provider?.apiKey).toBe('or-key');
  });

  test('a single-argument call infers the only provider offering the model', () => {
    const state = modelSelectorService.setModel('gemini-3-pro');

    expect(state.provider).toBe('gemini');
    expect(modelSelectorService.getActiveProvider()?.kind).toBe('google');
  });

  test('a model on two providers throws and names both', () => {
    // The one case where inference is unsafe. Guessing here would send the
    // operator's request to a provider they did not pick, with a different key
    // and a different bill, and nothing on screen would say so.
    expect(() => modelSelectorService.setModel('shared/model')).toThrow(
      /"shared\/model" is offered by more than one provider \(openrouter, gemini\)/,
    );

    // …and naming the provider explicitly is the documented fix.
    const state = modelSelectorService.setModel('shared/model', 'gemini');
    expect(state.provider).toBe('gemini');
  });

  test('a model the named provider does not offer throws', () => {
    expect(() => modelSelectorService.setModel('gemini-3-pro', 'openrouter')).toThrow(
      /Provider "openrouter" does not offer the model "gemini-3-pro"\. Its models: anthropic\/claude-sonnet-4-5, shared\/model\./,
    );
  });

  test('an unknown provider name throws and lists the configured ones', () => {
    expect(() => modelSelectorService.setModel('anthropic/claude-sonnet-4-5', 'openai')).toThrow(
      /There is no provider named "openai"\. Configured providers: openrouter, gemini\./,
    );
  });

  test('the same model on a different provider counts as a change', () => {
    modelSelectorService.setModel('shared/model', 'openrouter');
    const first = modelSelectorService.getState().changedAt;

    // Same id, different provider: routing moves, so this is a real switch
    // rather than a re-confirmation of the current selection.
    modelSelectorService.setModel('shared/model', 'gemini');
    expect(modelSelectorService.getState().provider).toBe('gemini');
    expect(modelSelectorService.getState().changedAt).not.toBe(first);
  });
});

describe('persistence', () => {
  beforeEach(() => {
    useRegistry();
  });

  test('the pair round-trips through the settings row', () => {
    modelSelectorService.setModel('anthropic/claude-sonnet-4-5', 'openrouter');

    const raw = readRawRow();
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? 'null')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });
  });

  test('a legacy selection is written as a JSON pair with a null provider', () => {
    // Back to pre-registry config, including the flat list that mode uses.
    config.providers.active = false;
    config.dashboard.modelProviders = [];
    config.dashboard.modelOptions = [...LEGACY_OPTIONS];
    modelSelectorService.setModel('gpt-4o');

    expect(JSON.parse(readRawRow() ?? 'null')).toEqual({ provider: null, model: 'gpt-4o' });
  });

  test('a fresh instance restores the provider, not just the model', () => {
    modelSelectorService.setModel('anthropic/claude-sonnet-4-5', 'openrouter');

    // What a restart does: a brand-new service reading the row this one wrote.
    const restarted = new ModelSelectorService();
    const state = restarted.getState();
    expect(state.active).toBe('anthropic/claude-sonnet-4-5');
    expect(state.provider).toBe('openrouter');
    expect(restarted.getActiveProvider()?.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  test('reset removes the row entirely', () => {
    modelSelectorService.setModel('anthropic/claude-sonnet-4-5', 'openrouter');
    expect(readRawRow()).toBeDefined();

    const state = modelSelectorService.reset();

    expect(readRawRow()).toBeUndefined();
    // Back to the environment model and to whatever the CONFIG calls the
    // default provider — explicitly NOT the provider that was selected a moment
    // ago, which is the bug a reset that only cleared the model half would have.
    expect(state.source).toBe('environment');
    expect(state.provider).not.toBe('openrouter');
    expect(modelSelectorService.getActiveProvider()?.name).not.toBe('openrouter');
  });
});

describe('migration from a pre-provider row', () => {
  beforeEach(() => {
    useRegistry();
  });

  test('a bare model id keeps the model and gains its provider', () => {
    // A row written before this feature: one string, no provider.
    writeRawRow('anthropic/claude-sonnet-4-5');

    const migrated = new ModelSelectorService();

    // Not discarded. Silently dropping the operator's chosen model would be a
    // regression worse than the ambiguity this feature introduces.
    expect(migrated.getActiveModel()).toBe('anthropic/claude-sonnet-4-5');
    expect(migrated.getState().provider).toBe('openrouter');
    expect(migrated.getActiveProvider()?.apiKey).toBe('or-key');

    // Loud: the operator is told the stored value predates provider routing.
    const notices = warn.mock.calls.map((call) => String(call[0] ?? ''));
    expect(notices.some((n) => n.includes('predates') && n.includes('anthropic/claude-sonnet-4-5'))).toBe(true);
  });

  test('an ambiguous legacy id is kept, with no provider guessed', () => {
    writeRawRow('shared/model');

    const migrated = new ModelSelectorService();

    // The model survives; the provider does not, because guessing one is the
    // failure mode this feature exists to prevent. `getState()` surfaces the id
    // even though it is not otherwise selectable, so it stays visible.
    expect(migrated.getActiveModel()).toBe('shared/model');
    expect(migrated.getState().provider).toBeNull();
    expect(migrated.getActiveProvider()).toBeUndefined();
  });

  test('a legacy id on no configured provider is kept and routed nowhere', () => {
    writeRawRow('a-model-that-no-provider-offers');

    const migrated = new ModelSelectorService();

    expect(migrated.getActiveModel()).toBe('a-model-that-no-provider-offers');
    expect(migrated.getActiveProvider()).toBeUndefined();
    expect(migrated.getState().options).toContain('a-model-that-no-provider-offers');
  });

  test('an unreadable row is ignored rather than crashing the boot', () => {
    writeRawRow('{"provider":"openrouter"}');

    const migrated = new ModelSelectorService();

    // Nothing usable in it: there is no model to preserve, so the environment
    // default stands.
    expect(migrated.getState().source).toBe('environment');
  });
});