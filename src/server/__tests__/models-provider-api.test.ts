import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../../utils/config';
import { REPO_ROOT } from '../../utils/paths';
import { modelSelectorService } from '../../services/model-selector';
import type { NamedProvider } from '../../utils/provider-registry';
import { resetAuthFailuresForTests, startDashboardServer } from '../dashboard';

/**
 * The provider-aware half of `/api/models`.
 *
 * Two things are covered, and they are covered at two different levels on
 * purpose:
 *
 *   1. The ROUTE, over a real socket with the real auth gate, exactly as
 *      `prompt-profiles-api.test.ts` does it. What matters here is that the
 *      optional `provider` reaches the service, that omitting it still works,
 *      and above all that a *rejected* selection is a 400 with a readable
 *      message rather than a 500 — that mapping is a deliberate design decision
 *      (see the comment in `dashboard.ts`) and a regression there would be
 *      invisible to unit tests of the service.
 *
 *   2. The PICKER MARKUP, by extracting the page's own `modelOptionsMarkup`
 *      out of `index.html` and running it. There is no DOM harness in this
 *      repo and inventing one for two string builders would be out of proportion
 *      to what they do — but the escaping of provider names is a security
 *      property, and a test that re-implements the escaping in TypeScript would
 *      be testing its own copy rather than the shipped page. So the real
 *      function, and the real `esc` it calls, are lifted out of the file and
 *      called with hostile input.
 *
 * FIXTURE DISCIPLINE
 * ------------------
 * `config` is a module-level singleton shared with every other suite, and both
 * `model-selector` and the route read it lazily on each call, so the slices
 * touched here are saved and restored. `config.providers.active` is included
 * because the service, not the route, decides whether a provider is reported at
 * all. Every test resets the selection afterwards: the override is persisted in
 * `dashboard_settings.db`, and a leftover row would silently change what the
 * next test sees.
 */

const PASSWORD = 'a-long-random-password';
const USERNAME = 'admin';

const OPENROUTER = 'openrouter';
const OFFICIAL = 'official-google';
const SHARED_MODEL = 'shared/model-1';

const HTML_PATH = join(REPO_ROOT, 'src', 'server', 'dashboard', 'index.html');

type DashboardConfig = typeof config.dashboard;

let savedDashboard: DashboardConfig;
let savedProviderSettings: { active: boolean; registry: NamedProvider[] };

beforeAll(() => {
  savedDashboard = { ...config.dashboard };
  savedProviderSettings = {
    active: config.providers.active,
    registry: [...config.providers.registry],
  };
});

beforeEach(() => {
  // The counters are per-IP and module-level, and every request here comes from
  // 127.0.0.1, so a bad-credential case would lock out later tests.
  resetAuthFailuresForTests();

  Object.assign(config.dashboard, {
    enabled: true,
    host: '127.0.0.1',
    password: PASSWORD,
    passwordSet: true,
    username: USERNAME,
    modelOptions: ['anthropic/claude-sonnet-4-5', SHARED_MODEL],
    modelProviders: [
      {
        name: OPENROUTER,
        kind: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-super-secret',
        models: ['anthropic/claude-sonnet-4-5', SHARED_MODEL],
      },
      {
        name: OFFICIAL,
        kind: 'google',
        baseUrl: undefined,
        apiKey: 'gemini-secret',
        models: [SHARED_MODEL, 'gemini-3-flash'],
      },
    ],
  });
  config.providers.active = true;
  config.providers.registry = [...config.dashboard.modelProviders];
});

afterEach(() => {
  modelSelectorService.reset();
});

afterAll(() => {
  Object.assign(config.dashboard, savedDashboard);
  config.providers.active = savedProviderSettings.active;
  config.providers.registry = savedProviderSettings.registry;
});

// ---- HTTP helpers ---------------------------------------------------------

function basic(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

/**
 * A distinct port per test, from a range this repo already reserves for its
 * own suite (see `prompt-profiles-api.test.ts`). Bun's `serve` will not bind
 * port 0 back into the config we just wrote, so an "ask the OS" approach does
 * not work here.
 */
let nextPort = 34_400;
function freePort(): number {
  nextPort += 1;
  return nextPort;
}

interface ModelPayload {
  active: string;
  options: string[];
  source: string;
  provider: string | null;
  providerOptions: { name: string; kind: string; models: string[] }[];
}

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

async function call(
  port: number,
  path: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Host: `127.0.0.1:${port}`,
    Authorization: basic(USERNAME, PASSWORD),
    ...extraHeaders,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readModel(res: Response): Promise<ModelPayload> {
  const data = (await res.json()) as { model: ModelPayload };
  return data.model;
}

// ---- 1. The route ---------------------------------------------------------

describe('GET /api/models projects the provider state', () => {
  test('the grouped view is the state the service holds, not a copy of it', async () => {
    await withServer(async (port) => {
      const state = await readModel(await call(port, '/api/models', 'GET'));

      expect(state.providerOptions).toEqual([
        { name: OPENROUTER, kind: 'openai', models: ['anthropic/claude-sonnet-4-5', SHARED_MODEL] },
        { name: OFFICIAL, kind: 'google', models: [SHARED_MODEL, 'gemini-3-flash'] },
      ]);
      // Whatever it resolved to on entry, the route neither invents nor drops
      // it: `provider` is the service's answer about where requests go.
      expect(typeof state.provider).toBe(state.provider === null ? 'object' : 'string');
    });
  });

  test('the projection carries no base URL and no API key', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/models', 'GET');
      const raw = await res.text();

      // The strongest form of this assertion is textual: whatever else the
      // shape is, a credential must not be anywhere in the response.
      expect(raw).not.toContain('sk-or-super-secret');
      expect(raw).not.toContain('gemini-secret');
      expect(raw).not.toContain('openrouter.ai');

      for (const group of (await readModel(
        await call(port, '/api/models', 'GET'),
      )).providerOptions) {
        expect(Object.keys(group).sort()).toEqual(['kind', 'models', 'name']);
      }
    });
  });

  test('legacy mode reports a null provider and an empty grouped list', async () => {
    await withServer(async (port) => {
      config.providers.active = false;
      config.dashboard.modelProviders = [];

      const state = await readModel(await call(port, '/api/models', 'GET'));
      expect(state.provider).toBeNull();
      expect(state.providerOptions).toEqual([]);
      // The flat list is untouched: it is what every pre-registry consumer
      // reads, and it is what the UI falls back to.
      expect(state.options).toEqual(['anthropic/claude-sonnet-4-5', SHARED_MODEL]);
    });
  });
});

describe('POST /api/models takes an optional provider', () => {
  test('a provider is applied and echoed back', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/models', 'POST', {
        model: SHARED_MODEL,
        provider: OFFICIAL,
      });

      expect(res.status).toBe(200);
      const state = await readModel(res);
      expect(state.active).toBe(SHARED_MODEL);
      expect(state.provider).toBe(OFFICIAL);
      expect(modelSelectorService.getActiveProvider()?.name).toBe(OFFICIAL);
    });
  });

  test('omitting it still works: a model on exactly one provider is inferred', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/models', 'POST', { model: 'gemini-3-flash' });

      expect(res.status).toBe(200);
      const state = await readModel(res);
      expect(state.active).toBe('gemini-3-flash');
      expect(state.provider).toBe(OFFICIAL);
    });
  });

  test('a legacy client that knows nothing about providers is unaffected', async () => {
    await withServer(async (port) => {
      // The registry off, the flat list on: exactly the pre-feature world.
      config.providers.active = false;
      config.dashboard.modelProviders = [];
      config.dashboard.modelOptions = ['legacy-model-a', 'legacy-model-b'];

      const res = await call(port, '/api/models', 'POST', { model: 'legacy-model-b' });
      expect(res.status).toBe(200);

      const state = await readModel(res);
      expect(state.active).toBe('legacy-model-b');
      expect(state.provider).toBeNull();
    });
  });

  test('the same gate as every other dashboard route still applies', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/models`, {
        method: 'GET',
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(401);
    });
  });
});

describe('a rejected selection is a 400, never a 500', () => {
  test('an unknown provider is reported with its own message', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/models', 'POST', {
        model: 'gemini-3-flash',
        provider: 'no-such-provider',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('no-such-provider');
    });
  });

  test('an ambiguous model with no provider names the providers involved', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/models', 'POST', { model: SHARED_MODEL });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      // The message has to be actionable, not merely true: the operator can only
      // fix this by picking one of the providers, so both must be named.
      expect(body.error).toContain(OPENROUTER);
      expect(body.error).toContain(OFFICIAL);
    });
  });

  test('a model that is on no provider at all is also a 400', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/models', 'POST', { model: 'not-a-real-model' });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('not-a-real-model');
    });
  });

  test('a non-string provider is rejected before it reaches the service', async () => {
    await withServer(async (port) => {
      const res = await call(port, '/api/models', 'POST', {
        model: 'gemini-3-flash',
        provider: { name: OFFICIAL },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('"provider"');
    });
  });

  test('a rejected switch leaves the selection exactly as it was', async () => {
    await withServer(async (port) => {
      expect((await call(port, '/api/models', 'POST', {
        model: SHARED_MODEL,
        provider: OPENROUTER,
      })).status).toBe(200);

      expect((await call(port, '/api/models', 'POST', { model: SHARED_MODEL })).status).toBe(400);

      const state = await readModel(await call(port, '/api/models', 'GET'));
      expect(state.active).toBe(SHARED_MODEL);
      expect(state.provider).toBe(OPENROUTER);
    });
  });
});

// ---- 2. The picker markup -------------------------------------------------

/**
 * Lift one top-level `function name(...)` out of the page source, braces and
 * all, and return it as an evaluable expression.
 *
 * The naive `source.slice(from, source.indexOf('}', from))` truncates at the
 * first `}`, which is the `if` inside every one of these builders. Counting
 * braces is enough here because the extracted functions contain no braces
 * inside string literals or comments — asserted implicitly by the tests below,
 * which would fail loudly on a malformed extraction rather than quietly passing
 * on half a function.
 */
function extractFunction(name: string): string {
  const source = readFileSync(HTML_PATH, 'utf-8');
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);

  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name} from index.html`);
}

/** The page's real `esc` and its real option builder, compiled together. */
function pagePicker(): (model: unknown) => string {
  // eslint-disable-next-line no-new-func -- the subject under test is a string.
  const factory = new Function(
    extractFunction('esc') + '\n' + extractFunction('groupLabel') + '\n' +
    extractFunction('modelOptionsMarkup') +
    '\nreturn modelOptionsMarkup;',
  );
  return factory() as (model: unknown) => string;
}

describe('the picker renders a grouped select when the registry is active', () => {
  const markup = pagePicker();

  const GROUPED = {
    active: 'deepseek/deepseek-chat',
    options: ['anthropic/claude-sonnet-4-5', 'deepseek/deepseek-chat', 'gemini-3-flash'],
    provider: 'openrouter',
    providerOptions: [
      { name: 'openrouter', kind: 'openai', models: ['anthropic/claude-sonnet-4-5', 'deepseek/deepseek-chat'] },
      { name: 'official-google', kind: 'google', models: ['gemini-3-flash'] },
    ],
  };

  test('one optgroup per provider, labelled by name', () => {
    const html = markup(GROUPED);

    expect(html).toContain('<optgroup label="openrouter — openai-compatible">');
    expect(html).toContain('<optgroup label="official-google — google genai">');
    expect(html.indexOf('openrouter')).toBeLessThan(html.indexOf('official-google'));
  });

  test('every option carries its provider, and the active one is selected', () => {
    const html = markup(GROUPED);

    expect(html).toContain('<option value="anthropic/claude-sonnet-4-5" data-provider="openrouter"');
    expect(html).toContain('<option value="gemini-3-flash" data-provider="official-google"');
    expect(html).toContain('<option value="deepseek/deepseek-chat" data-provider="openrouter" selected>');
    // Exactly one selected option: the one matching the active PAIR. Matching
    // on the model id alone would select the same id under both providers.
    expect(html.match(/ selected/g)).toHaveLength(1);
  });

  test('a model offered by two providers appears under both', () => {
    const html = markup({
      active: 'shared/model-1',
      options: ['shared/model-1'],
      provider: 'official-google',
      providerOptions: [
        { name: 'openrouter', kind: 'openai', models: ['shared/model-1'] },
        { name: 'official-google', kind: 'google', models: ['shared/model-1'] },
      ],
    });

    // Deduplicating here would defeat the entire feature: the provider name is
    // what tells the two apart, and an option without one cannot be submitted.
    expect(html).toContain('data-provider="openrouter"');
    expect(html).toContain('data-provider="official-google"');
    expect(html.match(/ selected/g)).toHaveLength(1);
    expect(html.indexOf('data-provider="openrouter"')).toBeLessThan(
      html.indexOf('data-provider="official-google" selected'),
    );
  });

  test('a provider with no models is skipped rather than rendered empty', () => {
    const html = markup({
      active: 'gemini-3-flash',
      options: ['gemini-3-flash'],
      provider: 'official-google',
      providerOptions: [
        { name: 'unconfigured', kind: 'openai', models: [] },
        { name: 'official-google', kind: 'google', models: ['gemini-3-flash'] },
      ],
    });

    expect(html).not.toContain('unconfigured');
    expect(html).toContain('official-google');
  });

  test('a model on no provider is still listed, ungrouped and selected', () => {
    const html = markup({
      active: 'pinned/model',
      options: ['pinned/model'],
      provider: null,
      providerOptions: [{ name: 'openrouter', kind: 'openai', models: ['other/model'] }],
    });

    // Dropping it would hide the current selection from the operator, which is
    // the one thing a picker must never do.
    expect(html).toContain('<option value="pinned/model" selected>');
    expect(html.indexOf('pinned/model')).toBeLessThan(html.indexOf('<optgroup'));
  });
});

describe('the picker is byte-for-byte the old flat list in legacy mode', () => {
  const markup = pagePicker();

  test('no optgroups, no provider attribute, one option per flat entry', () => {
    const html = markup({
      active: 'gemini-1.5-pro',
      options: ['gemini-1.5-pro', 'gemini-2.0-flash'],
      provider: null,
      providerOptions: [],
    });

    expect(html).toBe(
      '<option value="gemini-1.5-pro" selected>gemini-1.5-pro</option>' +
      '<option value="gemini-2.0-flash">gemini-2.0-flash</option>',
    );
  });

  test('a missing providerOptions field is legacy too, not a crash', () => {
    // `providerOptions` is only absent from a payload older than the registry;
    // the whole point of the fallback is that such a payload still renders.
    const html = markup({ active: 'gemini-1.5-pro', options: ['gemini-1.5-pro'] });

    expect(html).toContain('<option value="gemini-1.5-pro" selected>');
    expect(html).not.toContain('data-provider');
  });
});

describe('provider names and model ids cannot inject markup', () => {
  const markup = pagePicker();

  // The realistic shape of the attack: `.env` is operator input, and the whole
  // page is built by string concatenation. A provider name is quoted in an
  // attribute, and a model id is quoted in an attribute and a text node.
  const HOSTILE_PROVIDER = 'x" onmouseover="alert(1)';
  const HOSTILE_MODEL = '<img src=x onerror=alert(2)>';

  test('both attribute and text position are escaped', () => {
    const html = markup({
      active: HOSTILE_MODEL,
      options: [HOSTILE_MODEL],
      provider: HOSTILE_PROVIDER,
      providerOptions: [
        { name: HOSTILE_PROVIDER, kind: 'openai', models: [HOSTILE_MODEL] },
      ],
    });

    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;img');
    // The payloads survive as TEXT, which is correct: an operator naming a
    // provider `<img src=x>` should see that name, not have it disappear. What
    // must not survive is the payload's ability to close a tag or an attribute,
    // so the assertion is about the characters that would do it, not about the
    // substring `onerror=` — which appears legitimately inside the escaped
    // text of the option label.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onmouseover="alert(1)"');
    // Exact match: the strongest available statement that the whole thing is
    // inert, rather than that some substrings of it are absent. Every quote and
    // angle bracket from the payloads is an entity, so the tag and attribute
    // structure is exactly the four tags the builder wrote.
    expect(html).toBe(
      '<optgroup label="x&quot; onmouseover=&quot;alert(1) — openai-compatible">' +
      '<option value="&lt;img src=x onerror=alert(2)&gt;" ' +
      'data-provider="x&quot; onmouseover=&quot;alert(1)" selected>' +
      '&lt;img src=x onerror=alert(2)&gt;</option></optgroup>',
    );
    // The quote that would have closed the attribute is a character entity, so
    // the attribute value ends where the builder put it.
    expect(html).toContain('data-provider="x&quot; onmouseover=&quot;alert(1)"');
  });

  test('a provider name cannot become an attribute of its own', () => {
    const html = markup({
      active: 'm',
      options: ['m'],
      provider: 'p" autofocus onfocus="alert(3)',
      providerOptions: [{ name: 'p" autofocus onfocus="alert(3)', kind: 'google', models: ['m'] }],
    });

    // The label attribute must close exactly once, at the end of the name.
    expect(html.match(/<optgroup /g)).toHaveLength(1);
    expect(html).toContain('<optgroup label="p&quot; autofocus onfocus=&quot;alert(3) — google genai">');
  });
});

describe('the picker code never reaches for a URL or a key', () => {
  test('neither field appears in the functions that render providers', () => {
    // Scoped to the two provider-rendering functions rather than the whole
    // file: the Status card separately shows the configured AI endpoint, which
    // is pre-existing behaviour about the bot's own config and not something
    // this feature changed. What matters here is that the provider label
    // cannot grow a URL or a credential as a side effect of a future edit.
    const sources =
      extractFunction('groupLabel') + extractFunction('modelOptionsMarkup');

    expect(sources).not.toContain('baseUrl');
    expect(sources).not.toContain('apiKey');
  });

  test('neither field survives on the wire, whatever the service holds', async () => {
    await withServer(async (port) => {
      const raw = await (await call(port, '/api/models', 'GET')).text();

      // The fixture's key and its internal-looking URL are the two strings that
      // must never reach a browser through this route.
      expect(raw).not.toContain('sk-or-super-secret');
      expect(raw).not.toContain('gemini-secret');
      expect(raw).not.toContain('openrouter.ai');
    });
  });
});