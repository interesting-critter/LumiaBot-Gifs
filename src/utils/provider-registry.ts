/**
 * Named provider registry: the set of API providers the bot may route a request
 * to, each with its own base URL, its own single API key, and its own model
 * list. See `README`/`config.providers` for the operator-facing view.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * Everything here is a *pure function of an env-shaped record*. `config.ts`
 * holds `process.env` at exactly one place (the `config` literal's module-scope
 * locals, because `config` is in its temporal dead zone inside its own
 * initialiser). Keeping the parsers here rather than in that file means the
 * delimiter rules and the cross-validation rules can be unit-tested against
 * literal inputs — you cannot meaningfully test boot-time env parsing, and this
 * is the part that is easy to get wrong (three delimiters, see below).
 *
 * WHY THE DELIMITERS ARE MIXED
 * -----------------------------
 * The three variables group differently, and the operators who wrote them group
 * them differently too, so the delimiters follow the grouping rather than being
 * forced uniform:
 *
 *   OPENAI_PROVIDERS / GOOGLE_PROVIDERS   `,` between PAIRS
 *                                         `name=url`
 *   OPENAI_KEYS / GOOGLE_KEYS             `;` between PAIRS
 *                                         `name=key`
 *   DASHBOARD_MODELS                      `;` between PAIRS
 *                                         `name=model,model,model`
 *
 * `DASHBOARD_MODELS` is the reason the split is not "one delimiter everywhere":
 * it is the only variable whose *value* is itself a list, so it needs both. A
 * comma inside a models value and a semicolon between models values cannot be
 * confused for one another, which is what lets `openrouter=a/x,b/y;openai=c`
 * parse without ambiguity.
 *
 * Note that `,` is still the pair separator in `*_PROVIDERS`, so a base URL must
 * not contain a comma. A URL that does is mis-split rather than rejected — the
 * remainder is parsed as the next pair — which is why query strings (which use
 * `&`) are fine and a literal comma is not. `=` *is* allowed anywhere in the
 * value: pairs split at the FIRST `=` so `https://gw/v1?key=abc` survives.
 */

/** Which transport/SDK a provider is reached through. */
export type ProviderKind = 'openai' | 'google';

/**
 * One configured provider.
 *
 * `name` is the *display name* — it is what the dashboard renders, and it is
 * the key `*_KEYS` and `DASHBOARD_MODELS` use. The base URL is deliberately
 * not something the dashboard ever shows: an operator's URL can contain a
 * hostname that is only meaningful internally, and a bare URL in a picker is
 * unreadable when three providers are listed.
 */
export interface NamedProvider {
  name: string;
  kind: ProviderKind;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  models: string[];
}

/**
 * The five variables that make up the registry, read as a record so the parsers
 * stay pure. Every field is optional because every one of them may be unset.
 */
export interface ProviderEnvInput {
  OPENAI_PROVIDERS?: string;
  OPENAI_KEYS?: string;
  GOOGLE_PROVIDERS?: string;
  GOOGLE_KEYS?: string;
  DASHBOARD_MODELS?: string;
}

/**
 * The name given to the single implicit provider that exists when the registry
 * is not active — i.e. the legacy `OPENAI_BASE_URL` / `OPENAI_API_KEY` pair.
 *
 * Fixed rather than derived from the URL because nothing may key off it under
 * legacy behaviour (there is exactly one provider, so it is never looked up by
 * name); it exists so callers can write uniform code.
 */
export const LEGACY_PROVIDER_NAME = 'default';

/** The variables consulted for "is the registry in effect", in report order. */
export const PROVIDER_ENV_KEYS: ReadonlyArray<keyof ProviderEnvInput> = [
  'OPENAI_PROVIDERS',
  'OPENAI_KEYS',
  'GOOGLE_PROVIDERS',
  'GOOGLE_KEYS',
  'DASHBOARD_MODELS',
];

function text(raw: string | undefined): string {
  return String(raw ?? '');
}

/** "Set" means non-empty after trimming — `OPENAI_PROVIDERS="  "` is not a setting. */
function isSet(raw: string | undefined): boolean {
  return text(raw).trim() !== '';
}

/**
 * Split on a delimiter, trim, and drop blanks.
 *
 * Empty/whitespace segments are skipped *silently*: a trailing `,` or a stray
 * `;` is a formatting habit, not a mistake, and warning about it would bury the
 * warnings that matter in noise the operator learns to skim past.
 */
function segments(raw: string | undefined, delimiter: ',' | ';'): string[] {
  return text(raw)
    .split(delimiter)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Split one `name=value` entry at its FIRST `=`.
 *
 * First rather than last, and first rather than "exactly one": the value side
 * of `*_PROVIDERS` is a URL, and a URL is allowed to contain `=` in a query
 * string (`https://gw/v1?key=abc`). Splitting at the last `=` would put
 * `https://gw/v1?key` in the name. Splitting at the first is correct for every
 * variable here because a provider name cannot contain `=` under any of the
 * documented formats.
 */
function splitPair(entry: string): { name: string; value: string } | undefined {
  const at = entry.indexOf('=');
  if (at < 0) return undefined;
  return { name: entry.slice(0, at).trim(), value: entry.slice(at + 1).trim() };
}

/** Every problem found while parsing, split into drops and kept-but-noteworthy. */
interface RegistryIssues {
  /** Entries thrown away — the operator wrote them expecting them to work. */
  dropped: string[];
  /** Entries that work, but not the way the operator probably expects. */
  notes: string[];
}

/**
 * Parse the two `*_PROVIDERS` variables into provider stubs, in configured
 * order (OpenAI first, then Google).
 *
 * Names are registered in a registry-wide set, not a per-kind set: `*_KEYS` and
 * `DASHBOARD_MODELS` are keyed by bare name with no kind prefix, so an OpenAI
 * and a Google provider sharing a name would make those two variables
 * ambiguous — `GOOGLE_KEYS=official=k` could not say whether `official` is the
 * Google provider or the OpenAI one. Refusing the second occurrence keeps that
 * key unambiguous, and first-wins (rather than last-wins) because the first
 * entry is the one the operator wrote first; letting order decide would make
 * the effective config depend on something the operator cannot see.
 */
function parseProviderUrls(
  input: ProviderEnvInput,
  issues: RegistryIssues,
): NamedProvider[] {
  const seen = new Set<string>();
  const out: NamedProvider[] = [];

  const kinds: ReadonlyArray<{ kind: ProviderKind; varName: 'OPENAI_PROVIDERS' | 'GOOGLE_PROVIDERS' }> = [
    { kind: 'openai', varName: 'OPENAI_PROVIDERS' },
    { kind: 'google', varName: 'GOOGLE_PROVIDERS' },
  ];

  for (const { kind, varName } of kinds) {
    for (const entry of segments(input[varName], ',')) {
      const pair = splitPair(entry);
      if (!pair) {
        issues.dropped.push(`${varName}: "${entry}" is not a name=url pair — dropped.`);
        continue;
      }
      if (!pair.name) {
        issues.dropped.push(
          `${varName}: "${entry}" has an empty provider name — dropped. Every entry needs a name ` +
            'because DASHBOARD_MODELS and *_KEYS refer to providers by name only.',
        );
        continue;
      }
      if (seen.has(pair.name)) {
        issues.dropped.push(
          `${varName}: provider name "${pair.name}" is already registered — dropped. Names must be ` +
            'unique across OPENAI_PROVIDERS and GOOGLE_PROVIDERS together, because OPENAI_KEYS, ' +
            'GOOGLE_KEYS and DASHBOARD_MODELS are keyed by bare name and could not say which ' +
            'provider they meant.',
        );
        continue;
      }

      seen.add(pair.name);
      out.push({
        name: pair.name,
        kind,
        // An empty URL is a legitimate value, not an error: it means "use the
        // SDK's own default endpoint", which is how the official Google and
        // OpenAI providers are normally configured.
        baseUrl: pair.value || undefined,
        apiKey: undefined,
        models: [],
      });
    }
  }

  return out;
}

/**
 * Parse one `*_KEYS` variable into `name -> key`, where a key may be absent.
 *
 * ONE key per provider, by design. Rotation is not implemented here: it needs a
 * "key currently in use" notion, and that state has to live next to the HTTP
 * client that would have to report a failure — not in a parser that runs once
 * at boot. An operator who wants rotation runs their own proxy and points the
 * base URL at it, which is also the only way to get rotation across the two
 * different auth styles (bearer header vs `x-goog-api-key`) that the two kinds
 * use. So a second key is *not* silently discarded: it is named, counted, and
 * the first is kept, because "I wrote two keys" is exactly the belief this
 * warning exists to correct.
 */
function parseKeys(raw: string | undefined, varName: 'OPENAI_KEYS' | 'GOOGLE_KEYS', issues: RegistryIssues): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();

  for (const entry of segments(raw, ';')) {
    const pair = splitPair(entry);
    if (!pair) {
      issues.dropped.push(`${varName}: "${entry}" is not a name=key pair — dropped.`);
      continue;
    }
    if (!pair.name) {
      issues.dropped.push(`${varName}: "${entry}" has an empty provider name — dropped.`);
      continue;
    }
    if (out.has(pair.name)) {
      issues.notes.push(
        `${varName}: provider "${pair.name}" appears more than once — keeping the first key.`,
      );
      continue;
    }

    // Comma-separated inside the value: only reachable if the operator wrote
    // keys with commas, which is the mistake this warning is for.
    const candidates = pair.value
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '');

    if (candidates.length > 1) {
      issues.notes.push(
        `${varName}: provider "${pair.name}" was given ${candidates.length} keys ` +
          `(separated by commas). Only ONE key per provider is supported here, so the first is used ` +
          'and the rest are ignored — they are NOT a rotation pool. If you need key rotation, run ' +
          'your own proxy and point this provider\'s base URL at it.',
      );
    }

    out.set(pair.name, candidates[0]);
  }

  return out;
}

/**
 * Parse `DASHBOARD_MODELS` into `name -> models`.
 *
 * Duplicate models inside one provider's list are collapsed, first-seen order
 * preserved: that order is the order the dashboard renders the picker in, and
 * the common cause of a duplicate is the same model pasted into two positions
 * while editing, not an intent to show it twice.
 *
 * A repeated *provider* name is merged rather than rejected, unlike a repeated
 * key. Splitting one provider's list across two `;`-separated entries is a
 * formatting habit rather than a contradiction — there is no "which one wins"
 * ambiguity in a concatenation, and rejecting it would drop models the operator
 * believes they configured.
 */
function parseModels(raw: string | undefined, issues: RegistryIssues): Map<string, string[]> {
  const out = new Map<string, string[]>();

  for (const entry of segments(raw, ';')) {
    const pair = splitPair(entry);
    if (!pair) {
      issues.dropped.push(`DASHBOARD_MODELS: "${entry}" is not a name=model,model pair — dropped.`);
      continue;
    }
    if (!pair.name) {
      issues.dropped.push(`DASHBOARD_MODELS: "${entry}" has an empty provider name — dropped.`);
      continue;
    }

    const existing = out.get(pair.name) ?? [];
    const seen = new Set(existing);
    for (const model of pair.value.split(',')) {
      const name = model.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      existing.push(name);
    }
    out.set(pair.name, existing);
  }

  return out;
}

/**
 * One bordered report, printed at the end of parsing.
 *
 * Bordered block in the style of the `MODEL_PROMPT_PROFILES` /
 * `GUILD_PROMPT_PROFILES` summaries in `config.ts`: the point is that an
 * operator can read one thing, once, at boot, and see both what survived and
 * what did not. Scattering these warnings across individual `console.warn`
 * calls means the ones that matter are the ones that scroll past.
 */
function report(issues: RegistryIssues, registry: readonly NamedProvider[]): void {
  if (issues.dropped.length === 0 && issues.notes.length === 0) return;

  const described = registry
    .map((p) => `${p.name} [${p.kind}] → ${p.models.length > 0 ? p.models.join(', ') : '(no models)'}`)
    .join('\n      ');

  const lines: string[] = [
    '',
    '='.repeat(72),
    '  CONFIGURATION ERROR: the provider registry has unusable entries.',
    '='.repeat(72),
  ];

  if (issues.dropped.length > 0) {
    lines.push('', '  Dropped:', ...issues.dropped.map((d) => `      - ${d}`));
  }
  if (issues.notes.length > 0) {
    lines.push('', '  Kept, but not how you probably meant it:', ...issues.notes.map((n) => `      - ${n}`));
  }

  lines.push(
    '',
    `  Providers: ${described !== '' ? `\n      ${described}` : '(none)'}`,
    '',
    '  A dropped key or model list is NOT a fallback: nothing reads it, so the',
    '  provider keeps whatever it was actually configured with. A provider with',
    '  no models simply never appears in the dashboard switcher.',
    '='.repeat(72),
    '',
  );

  console.warn(lines.join('\n'));
}

/**
 * Parse the whole registry from an env-shaped record.
 *
 * Pure: no `process.env`, no console side effects beyond the one report (which
 * tests can silence by spying on `console.warn`).
 */
export function parseProviderRegistry(input: ProviderEnvInput): NamedProvider[] {
  const issues: RegistryIssues = { dropped: [], notes: [] };

  const registry = parseProviderUrls(input, issues);
  const byName = new Map(registry.map((p) => [p.name, p]));

  // Keys are applied after the URLs so a key for a provider that does not exist
  // can be reported by name instead of vanishing.
  const keyVars: ReadonlyArray<{ kind: ProviderKind; varName: 'OPENAI_KEYS' | 'GOOGLE_KEYS' }> = [
    { kind: 'openai', varName: 'OPENAI_KEYS' },
    { kind: 'google', varName: 'GOOGLE_KEYS' },
  ];
  for (const { kind, varName } of keyVars) {
    for (const [name, key] of parseKeys(input[varName], varName, issues)) {
      const provider = byName.get(name);
      if (!provider) {
        issues.dropped.push(
          `${varName}: there is no provider named "${name}" in ${kind === 'openai' ? 'OPENAI_PROVIDERS' : 'GOOGLE_PROVIDERS'} — dropped.`,
        );
        continue;
      }
      provider.apiKey = key;
    }
  }

  const models = parseModels(input.DASHBOARD_MODELS, issues);
  for (const [name, list] of models) {
    const provider = byName.get(name);
    if (!provider) {
      issues.dropped.push(
        `DASHBOARD_MODELS: there is no provider named "${name}" in OPENAI_PROVIDERS or GOOGLE_PROVIDERS — dropped.`,
      );
      continue;
    }
    if (list.length === 0) {
      issues.notes.push(
        `DASHBOARD_MODELS: provider "${name}" lists no models — it will not appear in the dashboard switcher.`,
      );
      continue;
    }
    provider.models = list;
  }

  // Providers with no entry of their own are KEPT, with an empty model list.
  // Dropping them would take the base URL and the key with them, and the
  // operator's next move would be to re-add the provider without its models and
  // be confused again. Being unusable in the dashboard and being absent are
  // different failures, and only the first is what they wrote.
  for (const provider of registry) {
    if (!models.has(provider.name)) {
      issues.notes.push(
        `DASHBOARD_MODELS has no entry for provider "${provider.name}" — it is configured but ` +
          'UNSELECTABLE: it will not appear in the dashboard switcher and the dashboard cannot ' +
          'route a request to it.',
      );
    }
    if (!provider.apiKey) {
      issues.notes.push(
        `provider "${provider.name}" has no API key — kept, but any request routed to it will ` +
          'fail with an authentication error from the provider.',
      );
    }
  }

  report(issues, registry);
  return registry;
}

/**
 * True when at least one of the five new variables is set.
 *
 * Precedence rule: the new variables beat the legacy single-provider values
 * (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GEMINI_BASE_URL`)
 * as soon as ANY of them is present, rather than per-variable. A half-migrated
 * `.env` — say `OPENAI_PROVIDERS` added but `GOOGLE_KEYS` not yet — must not
 * end up routing the Google side through the legacy key while the OpenAI side
 * goes to the registry: two providers reading one key is a security incident
 * the operator cannot see. Either the registry is in effect or it is not.
 *
 * The consequence is stated rather than hidden: with the registry active, the
 * legacy key/base URL are not consulted for routing at all, even for the kind
 * whose registry list is empty.
 */
export function isProviderRegistryActive(input: ProviderEnvInput): boolean {
  return PROVIDER_ENV_KEYS.some((key) => isSet(input[key]));
}

/**
 * Look a provider up by its display name. Names are unique registry-wide (see
 * {@link parseProviderUrls}), so no kind disambiguation is needed here.
 */
export function findProvider(
  registry: readonly NamedProvider[],
  name: string,
): NamedProvider | undefined {
  const wanted = text(name).trim();
  if (!wanted) return undefined;
  return registry.find((p) => p.name === wanted);
}

/**
 * Flatten every registry model's list into one `string[]`, deduplicated, in
 * registry order.
 *
 * This is what `config.dashboard.modelOptions` carries so that everything
 * already reading that flat list keeps working unchanged under the new
 * variables. A model appearing on two providers is listed once: the legacy
 * consumers key a *selection* by model id and have nowhere to record which
 * provider it came from, so listing it twice would give the same id two
 * different meanings depending on which row the user clicked.
 */
export function deriveModelOptions(registry: readonly NamedProvider[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const provider of registry) {
    for (const model of provider.models) {
      if (seen.has(model)) continue;
      seen.add(model);
      out.push(model);
    }
  }
  return out;
}

/**
 * The registry plus whether it is in effect, with the legacy single-provider
 * case folded in.
 *
 * When `active` is false the returned registry is exactly one implicit
 * provider carrying the legacy values, so callers can write uniform code
 * without branching — while `active` itself is what tells them whether the
 * dashboard may offer a provider picker at all.
 *
 * @param legacy the single provider to synthesise when the new vars are unset.
 *               Passed in rather than read from `process.env` here so this
 *               function stays pure.
 */
export function createProviderRegistry(
  input: ProviderEnvInput,
  legacy: NamedProvider,
): { active: boolean; registry: NamedProvider[] } {
  if (!isProviderRegistryActive(input)) {
    return { active: false, registry: [legacy] };
  }
  return { active: true, registry: parseProviderRegistry(input) };
}