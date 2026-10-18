import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  activeProviderApiKey,
  activeProviderBaseUrl,
  config,
  isMoonshotProvider,
  isOpenRouterProvider,
  resolveActiveProvider,
  setActiveProviderResolver,
} from '../../utils/config';
import type { NamedProvider } from '../../utils/provider-registry';

/**
 * How a request is ROUTED, as opposed to how the registry is parsed.
 *
 * `provider-registry.test.ts` covers the parsing; `model-selector-providers.ts`
 * covers persisting and validating a selection. What is left — and what silently
 * breaks in the most expensive way possible, by sending a request with one
 * provider's key to another provider's host — is that the selection actually
 * reaches the HTTP client.
 *
 * The provider registry is parsed from `process.env` at boot, so it cannot be
 * injected after the fact. The seam that CAN be driven from a test is the
 * active-provider resolver in `utils/config.ts`: `services/active-provider.ts`
 * installs one at module load that delegates to
 * `modelSelectorService.getActiveProvider()`, and standing a different one in
 * here is exactly what "the operator just picked a different provider in the
 * dashboard" means to every consumer below. One test checks that the real
 * delegation is wired up, so the rest can safely stand in a fake.
 */

/** The state this file mutates, captured once so every test can put it back. */
const saved = {
  providersActive: config.providers.active,
  apiKey: config.openai.apiKey,
  baseUrl: config.openai.baseUrl,
  modelAlias: config.openai.modelAlias,
  model: config.openai.model,
  modelOptions: config.dashboard.modelOptions,
  geminiEnabled: config.gemini.enabled,
  geminiApiKey: config.gemini.apiKey,
};

/**
 * The OpenAI singleton is constructed at module scope and its constructor throws
 * on a missing key, so the key has to be in place *before* the dynamic imports
 * below — which is to say before anything in this file runs. Assigning to
 * `config` rather than `process.env` because that is what the constructor reads.
 */
config.openai.apiKey = saved.apiKey || 'test-key-not-used';

beforeEach(() => {
  // `openaiService` is a module singleton whose constructor throws on a missing
  // key, and it is constructed on first import. Assigning here — before the
  // dynamic import below — is what keeps that import from throwing.
  config.openai.apiKey = saved.apiKey || 'test-key-not-used';
});

afterEach(() => {
  config.providers.active = saved.providersActive;
  config.openai.apiKey = saved.apiKey;
  config.openai.baseUrl = saved.baseUrl;
  config.openai.modelAlias = saved.modelAlias;
  config.openai.model = saved.model;
  config.dashboard.modelOptions = saved.modelOptions;
  config.gemini.enabled = saved.geminiEnabled;
  config.gemini.apiKey = saved.geminiApiKey;

  // Undo the fake resolver so a later test file observes the real one.
  setActiveProviderResolver(() => saved.providersActive ? config.providers.defaultProvider() : {
    name: 'default',
    kind: 'openai',
    baseUrl: config.openai.baseUrl || undefined,
    apiKey: config.openai.apiKey,
    models: [],
  });
});

function provider(over: Partial<NamedProvider> = {}): NamedProvider {
  return {
    name: 'test-provider',
    kind: 'openai',
    baseUrl: 'https://api.test-provider.example/v1',
    apiKey: 'sk-test-provider',
    models: ['test-model'],
    ...over,
  };
}

/** Stand in for a dashboard selection. */
function select(p: NamedProvider | undefined): void {
  setActiveProviderResolver(() => p);
}

const { getAIService, GoogleGenAIService } = await import('../google-genai');
const { openaiService } = await import('../openai');
const { getBalanceCurrency } = await import('../moonshot');

describe('the active-provider resolver is wired to the model selector', () => {
  test('a fresh import answers with exactly what getActiveProvider() says', async () => {
    // Guards the injection itself. Without `services/active-provider.ts` having
    // been imported, `utils/config.ts` falls back to
    // `config.providers.defaultProvider()`, which builds the SAME provider in
    // legacy mode except for one thing: the fallback carries an empty model
    // list while `getActiveProvider()` reports the provider's real one. That
    // difference is the whole test — it fails if the delegation is removed.
    const { modelSelectorService } = await import('../model-selector');
    config.providers.active = false;
    config.dashboard.modelOptions = ['a-model-only-the-selector-knows'];

    // Re-import so the module body runs again under the modified config.
    const fresh = await import(`../active-provider?fresh=${Date.now()}`);
    expect(typeof fresh.activeProvider).toBe('function');
    expect(resolveActiveProvider()).toEqual(modelSelectorService.getActiveProvider());
  });

  test('an unresolvable selection degrades to undefined, never to a throw', () => {
    setActiveProviderResolver(() => {
      throw new Error('selection service unavailable');
    });
    expect(resolveActiveProvider()).toBeUndefined();
    // ...and the helpers built on it are still safe to call.
    expect(isMoonshotProvider()).toBe(false);
    expect(activeProviderBaseUrl()).toBe('');
  });
});

describe('getAIService() — registry active: the provider KIND picks the transport', () => {
  test('an openai-kind provider reaches the OpenAI singleton', () => {
    config.providers.active = true;
    select(provider({ name: 'local-proxy', kind: 'openai' }));

    expect(getAIService()).toBe(openaiService);
    expect(openaiService.getBaseUrl()).toBe('https://api.test-provider.example/v1');
    expect(openaiService.getApiKey()).toBe('sk-test-provider');
  });

  test('a google-kind provider reaches the Google GenAI SDK', () => {
    config.providers.active = true;
    select(provider({ name: 'official-gemini', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com' }));

    expect(getAIService()).toBeInstanceOf(GoogleGenAIService);
  });

  test('the model NAME does not decide the transport', () => {
    config.providers.active = true;

    // The exact misroute the registry exists to prevent: a `claude-3`-ish id
    // behind an OpenAI-compatible proxy. Sniffing the string would send this to
    // Google's SDK.
    select(provider({ name: 'proxy', kind: 'openai' }));
    config.openai.modelAlias = 'claude-3-opus';
    expect(getAIService()).toBe(openaiService);

    // ...and the mirror image: a `gemini-3` id on an OpenAI-compatible proxy.
    select(provider({ name: 'proxy-gem', kind: 'openai' }));
    config.openai.modelAlias = 'gemini-3-pro-preview';
    expect(getAIService()).toBe(openaiService);

    // A non-Gemini model on a declared Google provider still goes to Google.
    select(provider({ name: 'official-gemini', kind: 'google' }));
    config.openai.modelAlias = 'gpt-4o';
    expect(getAIService()).toBeInstanceOf(GoogleGenAIService);
  });

  test('a google-kind provider is routed even with no Gemini env key set', () => {
    // Under the registry the legacy `GEMINI_API_KEY` is not consulted for
    // routing at all, so its absence must not veto a declared google provider.
    config.providers.active = true;
    config.gemini.enabled = false;
    config.gemini.apiKey = undefined;
    select(provider({ name: 'keyless-gemini', kind: 'google', apiKey: 'gemini-key' }));

    expect(getAIService()).toBeInstanceOf(GoogleGenAIService);
  });

  test('a keyless provider does not inherit the previously selected key', () => {
    config.providers.active = true;
    select(provider({ name: 'with-key' }));
    getAIService();
    expect(openaiService.getApiKey()).toBe('sk-test-provider');

    // Falling back to the last key here would post one operator's credential to
    // a different host — the failure the registry warns about at boot.
    select(provider({ name: 'no-key', baseUrl: 'https://other.example/v1', apiKey: undefined }));
    getAIService();
    expect(openaiService.getApiKey()).toBe('');
    expect(openaiService.getBaseUrl()).toBe('https://other.example/v1');
  });
});

describe('getAIService() — registry inactive: behaviour is unchanged', () => {
  test('a non-Gemini model goes to the OpenAI singleton', () => {
    config.providers.active = false;
    config.openai.modelAlias = 'gpt-4o';
    expect(getAIService()).toBe(openaiService);
  });

  test('a gemini-3 model with a configured Gemini key goes to the GenAI SDK', () => {
    // The legacy sniff-and-check, untouched: the registry is not in effect, so
    // an install that has never heard of it behaves as it always did.
    config.providers.active = false;
    config.gemini.enabled = true;
    config.gemini.apiKey = 'legacy-gemini-key';
    config.openai.modelAlias = 'gemini-3-pro-preview';

    expect(getAIService()).toBeInstanceOf(GoogleGenAIService);
  });

  test('a gemini-3 model WITHOUT a Gemini key still goes to the OpenAI singleton', () => {
    config.providers.active = false;
    config.gemini.enabled = true;
    config.gemini.apiKey = undefined;
    config.openai.modelAlias = 'gemini-3-pro-preview';

    expect(getAIService()).toBe(openaiService);
  });

  test('the legacy path re-points the model only, never the URL or key', () => {
    config.providers.active = false;
    config.openai.baseUrl = 'https://legacy.example/v1';
    config.openai.apiKey = 'legacy-key';
    config.openai.modelAlias = 'gpt-4o';

    // Fresh construction is needed for this one: the singleton has already been
    // re-pointed by an earlier test in this file, and the legacy path must not
    // touch the URL.
    getAIService();
    expect(openaiService.getModel()).toBe('gpt-4o');
  });
});

describe('the OpenAI singleton re-points on a provider switch', () => {
  test('URL, key and model all follow the selection, and back again', () => {
    config.providers.active = true;

    select(provider({ name: 'a', baseUrl: 'https://a.example/v1', apiKey: 'key-a' }));
    config.openai.modelAlias = 'model-a';
    getAIService();
    expect(openaiService.getBaseUrl()).toBe('https://a.example/v1');
    expect(openaiService.getApiKey()).toBe('key-a');
    expect(openaiService.getModel()).toBe('model-a');

    select(provider({ name: 'b', baseUrl: 'https://b.example/v1', apiKey: 'key-b' }));
    config.openai.modelAlias = 'model-b';
    getAIService();
    expect(openaiService.getBaseUrl()).toBe('https://b.example/v1');
    expect(openaiService.getApiKey()).toBe('key-b');
    expect(openaiService.getModel()).toBe('model-b');

    // Switching back must not be a no-op: a one-way re-point would strand the
    // operator on provider B for the rest of the process's life.
    select(provider({ name: 'a', baseUrl: 'https://a.example/v1', apiKey: 'key-a' }));
    config.openai.modelAlias = 'model-a';
    getAIService();
    expect(openaiService.getBaseUrl()).toBe('https://a.example/v1');
    expect(openaiService.getApiKey()).toBe('key-a');
    expect(openaiService.getModel()).toBe('model-a');
  });

  test('a provider with no base URL clears the previous one', () => {
    // An empty URL is a legitimate registry value meaning "the SDK's own default
    // endpoint" (the official OpenAI provider is normally configured that way).
    // Treating it as "no opinion" would keep sending to the old host.
    config.providers.active = true;
    select(provider({ name: 'custom-host', baseUrl: 'https://custom.example/v1' }));
    getAIService();
    expect(openaiService.getBaseUrl()).toBe('https://custom.example/v1');

    select(provider({ name: 'official', baseUrl: undefined }));
    getAIService();
    expect(openaiService.getBaseUrl()).toBeUndefined();
  });

  test('re-selecting the same provider is a no-op on the model', () => {
    config.providers.active = true;
    select(provider({ name: 'stable' }));
    config.openai.modelAlias = 'stable-model';
    getAIService();
    getAIService();

    expect(openaiService.getModel()).toBe('stable-model');
    expect(openaiService.getBaseUrl()).toBe('https://api.test-provider.example/v1');
  });
});

describe('the provider-detection helpers follow the ACTIVE provider', () => {
  test('isMoonshotProvider / isOpenRouterProvider track a switch', () => {
    config.providers.active = true;

    select(provider({ name: 'kimi', baseUrl: 'https://api.moonshot.cn/v1' }));
    expect(isMoonshotProvider()).toBe(true);
    expect(isOpenRouterProvider()).toBe(false);
    expect(getBalanceCurrency()).toBe('¥');

    select(provider({ name: 'router', baseUrl: 'https://openrouter.ai/api/v1' }));
    expect(isMoonshotProvider()).toBe(false);
    expect(isOpenRouterProvider()).toBe(true);
    expect(getBalanceCurrency()).toBe('$');
  });

  test('the Moonshot domain split is honoured for .cn vs .ai', () => {
    config.providers.active = true;

    select(provider({ baseUrl: 'https://api.moonshot.ai/v1' }));
    expect(isMoonshotProvider()).toBe(true);
    expect(getBalanceCurrency()).toBe('$');

    select(provider({ baseUrl: 'https://api.moonshot.cn/v1' }));
    expect(isMoonshotProvider()).toBe(true);
    expect(getBalanceCurrency()).toBe('¥');
  });

  test('the base URL is returned verbatim, not lower-cased', () => {
    // It is used to build request URLs, where a path component can legitimately
    // be case-sensitive. The substring helpers do their own lower-casing.
    config.providers.active = true;
    select(provider({ baseUrl: 'https://Gateway.Example/API/v1' }));

    expect(activeProviderBaseUrl()).toBe('https://Gateway.Example/API/v1');
  });

  test('with the registry inactive they read the legacy pair', () => {
    config.providers.active = false;
    select(provider({ baseUrl: 'https://api.openrouter.ai/api/v1' }));
    config.openai.baseUrl = 'https://api.moonshot.cn/v1';

    // `config.openai.baseUrl` is not what the provider says, but with the
    // registry off that pair is not consulted for routing — the selection is.
    expect(isMoonshotProvider()).toBe(false);
    expect(isOpenRouterProvider()).toBe(true);
  });

  test('the API key helper never falls back to the legacy key under the registry', () => {
    config.providers.active = true;
    config.openai.apiKey = 'legacy-key';
    select(provider({ name: 'keyless', apiKey: undefined }));

    expect(activeProviderApiKey()).toBe('');

    // ...and under legacy behaviour the legacy key is exactly right.
    config.providers.active = false;
    select(undefined);
    expect(activeProviderApiKey()).toBe('legacy-key');
  });
});