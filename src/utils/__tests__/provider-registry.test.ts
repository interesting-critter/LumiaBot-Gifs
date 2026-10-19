import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createProviderRegistry,
  deriveModelOptions,
  findProvider,
  isProviderRegistryActive,
  LEGACY_PROVIDER_NAME,
  parseProviderRegistry,
  type NamedProvider,
  type ProviderEnvInput,
} from '../provider-registry';

/**
 * The registry parsers are pure functions of an env-shaped record precisely so
 * these tests can be literal: three different delimiters and six
 * cross-validation rules are far too many combinations to reason about by
 * reading, and each one has a distinct failure mode an operator would report as
 * "it just doesn't work".
 *
 * Warnings are captured rather than asserted line-by-line — the *content* is
 * what matters to an operator at 3am, so every case that is supposed to warn
 * asserts that the report was printed AND that it mentions the provider name,
 * which is the part that tells them which line of `.env` to fix.
 */
let warnings: string[] = [];
let originalWarn: typeof console.warn;

beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

function log(): string {
  return warnings.join('\n');
}

function names(registry: readonly NamedProvider[]): string[] {
  return registry.map((p) => p.name);
}

/**
 * `only()` and `providerAt()` exist because `noUncheckedIndexedAccess` makes
 * `registry[0]` a `NamedProvider | undefined` — and a bare `!` would turn a
 * parser regression into a confusing `undefined.baseUrl` crash instead of a
 * clear failure. Each helper states its expectation as a real assertion first,
 * so a registry that comes back short still fails loudly with "expected length
 * 1, got 0" rather than passing a `toEqual([])` on a provider that is not
 * there at all. That distinction is the whole point of the "kept but empty"
 * cases below.
 */
function only(registry: readonly NamedProvider[]): NamedProvider {
  expect(registry).toHaveLength(1);
  return registry[0]!;
}

function providerAt(registry: readonly NamedProvider[], index: number): NamedProvider {
  expect(registry.length).toBeGreaterThan(index);
  return registry[index]!;
}

const legacy: NamedProvider = {
  name: LEGACY_PROVIDER_NAME,
  kind: 'openai',
  baseUrl: 'https://legacy/v1',
  apiKey: 'sk-legacy',
  models: [],
};

describe('delimiter rules', () => {
  test('commas separate provider pairs and semicolons separate key pairs', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://api.openai.com/v1,openrouter=https://openrouter.ai/api/v1',
      OPENAI_KEYS: 'openai=sk-abc;openrouter=sk-or-xyz',
    });

    expect(names(registry)).toEqual(['openai', 'openrouter']);
    expect(providerAt(registry, 0).baseUrl).toBe('https://api.openai.com/v1');
    expect(providerAt(registry, 1).baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(registry.map((p) => p.apiKey)).toEqual(['sk-abc', 'sk-or-xyz']);
  });

  test('semicolons separate model pairs and commas separate models within one', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'a=https://a/v1,b=https://b/v1',
      OPENAI_KEYS: 'a=ka;kb=ignored',
      DASHBOARD_MODELS: 'a=m1,m2,m3;b=n1',
    });

    expect(providerAt(registry, 0).models).toEqual(['m1', 'm2', 'm3']);
    expect(providerAt(registry, 1).models).toEqual(['n1']);
  });

  test('a base URL containing "=" keeps everything after the first "="', () => {
    // Splitting at the LAST "=" would file this provider under the name
    // "https://gw/v1?key" — the realistic way an operator's gateway silently
    // never matches its key entry.
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'gw=https://gw.example/v1?key=abc',
      OPENAI_KEYS: 'gw=sk-gw',
    });

    expect(names(registry)).toEqual(['gw']);
    expect(only(registry).baseUrl).toBe('https://gw.example/v1?key=abc');
    expect(only(registry).apiKey).toBe('sk-gw');
  });

  test('a comma inside a URL ends that URL and starts the next pair', () => {
    // The documented price of `,` being the pair separator in *_PROVIDERS: a
    // URL with a literal comma is mis-split rather than rejected. That is why
    // the format forbids it (query strings use `&`), and why the truncated URL
    // is still loud — it fails at request time, not silently.
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'gw=https://gw/v1,a=b,second=https://ok/v1',
    });

    expect(names(registry)).toEqual(['gw', 'a', 'second']);
    expect(providerAt(registry, 0).baseUrl).toBe('https://gw/v1');
    expect(providerAt(registry, 2).baseUrl).toBe('https://ok/v1');
  });

  test('empty and whitespace-only segments are skipped silently', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: ' , openai=https://a/v1 , ,',
      OPENAI_KEYS: ' ; openai=sk-a ;',
      DASHBOARD_MODELS: ' ; openai=m1 ;',
    });

    expect(names(registry)).toEqual(['openai']);
    expect(only(registry).apiKey).toBe('sk-a');
    expect(only(registry).models).toEqual(['m1']);
    expect(log()).toBe('');
  });

  test('a provider entry with no "=" is dropped with a warning', () => {
    const registry = parseProviderRegistry({ OPENAI_PROVIDERS: 'https://a/v1' });

    expect(registry).toHaveLength(0);
    expect(log()).toContain('is not a name=url pair');
  });

  test('a provider entry with an empty name is dropped with a warning', () => {
    const registry = parseProviderRegistry({ OPENAI_PROVIDERS: '=https://a/v1' });

    expect(registry).toHaveLength(0);
    expect(log()).toContain('empty provider name');
  });

  test('an empty base URL means "use the SDK default" and is not an error', () => {
    const registry = parseProviderRegistry({ GOOGLE_PROVIDERS: 'official=' });

    expect(only(registry).baseUrl).toBeUndefined();
    expect(only(registry).kind).toBe('google');
    // No model list either, so the "unselectable" note still fires — but the
    // empty URL itself is not an error.
    expect(log()).not.toContain('name=url pair');
    expect(log()).toContain('UNSELECTABLE');
  });
});

describe('one key per provider', () => {
  test('a comma-separated key list uses the first key and warns loudly', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-first,sk-second,sk-third',
    });

    expect(only(registry).apiKey).toBe('sk-first');
    expect(log()).toContain('"openai" was given 3 keys');
    expect(log()).toContain('Only ONE key per provider is supported');
    expect(log()).toContain('run your own proxy');
  });

  test('two keys warn and still yield exactly one', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-one,sk-two',
    });

    expect(only(registry).apiKey).toBe('sk-one');
    expect(log()).toContain('was given 2 keys');
  });

  test('a single key warns about nothing', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-one',
    });

    expect(only(registry).apiKey).toBe('sk-one');
    expect(log()).not.toContain('keys');
  });
});

describe('name uniqueness across both provider variables', () => {
  test('a Google provider colliding with an OpenAI one is dropped, first wins', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'shared=https://openai/v1',
      GOOGLE_PROVIDERS: 'shared=https://google/v1,other=https://google2/v1',
    });

    expect(names(registry)).toEqual(['shared', 'other']);
    expect(providerAt(registry, 0).kind).toBe('openai');
    expect(providerAt(registry, 0).baseUrl).toBe('https://openai/v1');
    expect(log()).toContain('"shared" is already registered');
    expect(log()).toContain('unique across OPENAI_PROVIDERS and GOOGLE_PROVIDERS');
  });

  test('a duplicate name within one variable is also first-wins', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'dup=https://first/v1,dup=https://second/v1',
    });

    expect(names(registry)).toEqual(['dup']);
    expect(only(registry).baseUrl).toBe('https://first/v1');
  });

  test('names are case-sensitive and whitespace-insensitive', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: ' Foo = https://a/v1 ,foo=https://b/v1',
    });

    expect(names(registry)).toEqual(['Foo', 'foo']);
    expect(findProvider(registry, ' Foo ')).toBe(registry[0]);
    expect(findProvider(registry, 'missing')).toBeUndefined();
  });
});

describe('cross-validation', () => {
  test('a key naming no provider is dropped with a warning', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-a;ghost=sk-ghost',
    });

    expect(registry.map((p) => p.apiKey)).toEqual(['sk-a']);
    expect(log()).toContain('OPENAI_KEYS: there is no provider named "ghost"');
  });

  test('a model list naming no provider is dropped with a warning', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-a',
      DASHBOARD_MODELS: 'openai=gpt-4o;ghost=some/model',
    });

    expect(only(registry).models).toEqual(['gpt-4o']);
    expect(log()).toContain('DASHBOARD_MODELS: there is no provider named "ghost"');
  });

  test('a provider with no model list is kept, empty, and flagged unselectable', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1,router=https://b/v1',
      OPENAI_KEYS: 'openai=sk-a;router=sk-b',
      DASHBOARD_MODELS: 'openai=gpt-4o',
    });

    expect(names(registry)).toEqual(['openai', 'router']);
    // `providerAt` asserts the index exists before the `toEqual([])`, so this
    // case proves "router is registered with an empty model list" and cannot
    // silently pass as "router was dropped by the parser".
    expect(providerAt(registry, 1).models).toEqual([]);
    expect(providerAt(registry, 1).apiKey).toBe('sk-b');
    expect(log()).toContain('DASHBOARD_MODELS has no entry for provider "router"');
    expect(log()).toContain('UNSELECTABLE');
  });

  test('a provider with no key is kept and flagged as failing requests', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      DASHBOARD_MODELS: 'openai=gpt-4o',
    });

    expect(names(registry)).toEqual(['openai']);
    expect(only(registry).apiKey).toBeUndefined();
    expect(log()).toContain('provider "openai" has no API key');
    expect(log()).toContain('authentication error');
  });

  test('a malformed key or model entry is dropped and named', () => {
    parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'sk-bare;openai=sk-a',
      DASHBOARD_MODELS: 'bare-list',
    });

    expect(log()).toContain('OPENAI_KEYS: "sk-bare" is not a name=key pair');
    expect(log()).toContain('DASHBOARD_MODELS: "bare-list" is not a name=model,model pair');
  });

  test('a key entry repeated for one provider keeps the first and warns', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-first;openai=sk-second',
    });

    expect(only(registry).apiKey).toBe('sk-first');
    expect(log()).toContain('appears more than once');
  });

  test('a model list repeated for one provider is merged, not rejected', () => {
    // Splitting one provider's list across two `;` entries is a formatting
    // habit, not a contradiction — there is no "which wins" ambiguity in a
    // concatenation, and dropping it would lose models the operator wrote.
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-a',
      DASHBOARD_MODELS: 'openai=m1,m2;openai=m3,m1',
    });

    expect(only(registry).models).toEqual(['m1', 'm2', 'm3']);
  });

  test('duplicate models inside one list are deduped in first-seen order', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-a',
      DASHBOARD_MODELS: 'openai=m3,m1,m3,m2,m1',
    });

    expect(only(registry).models).toEqual(['m3', 'm1', 'm2']);
  });

  test('a provider whose model entry lists nothing is kept but flagged', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-a',
      DASHBOARD_MODELS: 'openai=',
    });

    // `only()` asserts the provider survived the parse, so this distinguishes
    // "openai is registered with an empty model list" from "openai was dropped".
    expect(only(registry).models).toEqual([]);
    expect(log()).toContain('provider "openai" lists no models');
  });

  test('a fully clean configuration prints no report at all', () => {
    parseProviderRegistry({
      OPENAI_PROVIDERS: 'openai=https://a/v1',
      OPENAI_KEYS: 'openai=sk-a',
      DASHBOARD_MODELS: 'openai=gpt-4o,gpt-4o-mini',
    });

    expect(log()).toBe('');
  });
});

describe('precedence and the legacy fallback', () => {
  test('no new vars set yields the single implicit legacy provider', () => {
    const result = createProviderRegistry({}, legacy);

    expect(result.active).toBe(false);
    expect(result.registry).toHaveLength(1);
    expect(result.registry[0]).toEqual(legacy);
    expect(log()).toBe('');
  });

  test('whitespace-only new vars do not activate the registry', () => {
    // A blank value in `.env` must not silently take the operator's legacy key
    // and base URL out of use — that is the failure this guard prevents.
    const input: ProviderEnvInput = {
      OPENAI_PROVIDERS: '   ',
      OPENAI_KEYS: '',
      GOOGLE_PROVIDERS: '\t',
      GOOGLE_KEYS: '',
      DASHBOARD_MODELS: ' ',
    };

    expect(isProviderRegistryActive(input)).toBe(false);
    expect(createProviderRegistry(input, legacy).active).toBe(false);
  });

  test('any ONE new var activates the registry and retires the legacy values', () => {
    const result = createProviderRegistry({ OPENAI_KEYS: 'openai=sk-a' }, legacy);

    expect(result.active).toBe(true);
    // No *PROVIDERS set, so the key names a provider that does not exist and is
    // dropped — which is exactly why "the registry won" matters: the legacy key
    // must not be used as a silent fallback for it.
    expect(result.registry).toHaveLength(0);
    expect(log()).toContain('there is no provider named "openai"');
  });

  test('each var independently activates the registry', () => {
    for (const key of [
      'OPENAI_PROVIDERS',
      'OPENAI_KEYS',
      'GOOGLE_PROVIDERS',
      'GOOGLE_KEYS',
      'DASHBOARD_MODELS',
    ] as const) {
      expect(isProviderRegistryActive({ [key]: 'x=1' })).toBe(true);
    }
  });

  test('configured order is OpenAI providers then Google providers', () => {
    const registry = parseProviderRegistry({
      GOOGLE_PROVIDERS: 'g1=https://g/v1,g2=https://g2/v1',
      OPENAI_PROVIDERS: 'o1=https://o/v1',
    });

    expect(names(registry)).toEqual(['o1', 'g1', 'g2']);
  });
});

describe('deriveModelOptions', () => {
  test('returns the registry models in registry order', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'a=https://a/v1,b=https://b/v1',
      OPENAI_KEYS: 'a=ka;kb=kb',
      DASHBOARD_MODELS: 'a=m1,m2;b=m3',
    });

    expect(deriveModelOptions(registry)).toEqual(['m1', 'm2', 'm3']);
  });

  test('a model on two providers is listed once', () => {
    // The legacy consumers key a selection by model id with nowhere to record
    // which provider it came from, so listing it twice would give one id two
    // meanings depending on the row clicked.
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'a=https://a/v1,b=https://b/v1',
      OPENAI_KEYS: 'a=ka;kb=kb',
      DASHBOARD_MODELS: 'a=shared,only-a;b=shared',
    });

    expect(deriveModelOptions(registry)).toEqual(['shared', 'only-a']);
  });

  test('providers with no models contribute nothing', () => {
    const registry = parseProviderRegistry({
      OPENAI_PROVIDERS: 'a=https://a/v1,b=https://b/v1',
      OPENAI_KEYS: 'a=ka;kb=kb',
      DASHBOARD_MODELS: 'b=m1',
    });

    expect(deriveModelOptions(registry)).toEqual(['m1']);
  });

  test('an empty registry yields an empty list', () => {
    expect(deriveModelOptions([])).toEqual([]);
    expect(deriveModelOptions([legacy])).toEqual([]);
  });
});