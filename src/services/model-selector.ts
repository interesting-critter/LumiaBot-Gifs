import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import { dbPath } from '../utils/paths';
import {
  LEGACY_PROVIDER_NAME,
  findProvider,
  type NamedProvider,
} from '../utils/provider-registry';
import { promptSelectorService } from './prompt-selector';

/**
 * One provider's model list, as the dashboard renders it.
 *
 * A projection of `config.dashboard.modelProviders` rather than the
 * `NamedProvider` itself: the dashboard must be handed the provider's NAME and
 * its model ids and nothing else. A `NamedProvider` carries `baseUrl` and
 * `apiKey`, and handing those to a template that only knows how to print a
 * label is how a URL (or worse, a key) ends up in a page. The type is the
 * boundary that makes that unrepresentable rather than merely discouraged.
 */
export interface ProviderOption {
  name: string;
  kind: 'openai' | 'google';
  models: string[];
}

export interface ModelState {
  /** The model actually in effect right now. */
  active: string;
  /** Models the dashboard may switch between. */
  options: string[];
  /** Where `active` came from. */
  source: 'dashboard' | 'environment';
  /** The literal OPENAI_MODEL env value, or null when unset. */
  environmentModel: string | null;
  /** What a reset reverts to. Falls back to the hardcoded default when unset. */
  fallbackModel: string;
  canChange: boolean;
  changedAt: string | null;
  /** Display name of the provider in effect, e.g. "openrouter". null in legacy mode. */
  provider: string | null;
  /** Grouped provider→models view for the dashboard, in configured order. */
  providerOptions: ProviderOption[];
}

/**
 * The persisted selection: which model, and which provider's list it was picked
 * from.
 *
 * A pair rather than a bare string because a model id is only unique WITHIN a
 * provider — the same id can sit on two providers with different prices and
 * different uptimes, so storing the id alone throws away the half of the choice
 * that decides where the request goes.
 */
interface StoredSelection {
  provider: string | null;
  model: string;
}

/**
 * Single source of truth for which model — and, under the provider registry,
 * which PROVIDER — the bot is using.
 *
 * The selection is persisted so it survives restarts. This matters because the
 * model may be chosen here rather than in the environment (e.g. when
 * `OPENAI_MODEL` is left unset), so there would otherwise be nothing to fall
 * back to.
 *
 * The active model is mirrored into `config.openai.modelAlias`, which is the
 * value every existing reader already resolves through
 * (`config.openai.modelAlias || config.openai.model`) — the two AI service
 * constructors and all the `is*Model()` feature-detection helpers. That keeps
 * provider routing (Gemini vs OpenAI), thinking config, and reasoning filtering
 * consistent with the dashboard selection without duplicating the precedence
 * rule in a dozen places.
 *
 * WHY THE PROVIDER IS PART OF THIS SERVICE'S STATE
 * -----------------------------------------------
 * `provider` used to be a property of the model id: the model list was a
 * constant and the model named its own transport. `DASHBOARD_MODELS` breaks
 * that, because one id can now be served by two providers. The provider
 * therefore travels with the selection — persisted, mirrored into
 * {@link ModelState}, and resolvable through {@link getActiveProvider}, which
 * is the single accessor the AI services use to learn where a request goes.
 * The base URL is deliberately NOT part of this state: it is re-read from
 * config at request time, so a URL change in `.env` takes effect without
 * rewriting the persisted selection.
 *
 * LEGACY MODE IS NOT A SECOND CODE PATH
 * ------------------------------------
 * When `config.providers.active` is false there is exactly one provider, named
 * `default`, carrying `config.openai.baseUrl` / `config.openai.apiKey`. That is
 * why {@link getActiveProvider} returns it rather than `undefined`: callers can
 * ask once and route, without branching on whether the operator migrated.
 */
export class ModelSelectorService {
  private db: Database;
  /**
   * The environment-configured model, captured once at construction.
   *
   * This must be read *before* any mirroring happens: `applyToConfig` overwrites
   * `config.openai.modelAlias`, so reading the env value back from config later
   * would just return the last mirrored override and `reset()` could never
   * return to the environment default.
   */
  private envModel: string;
  /**
   * The provider name the ENV model came from, captured the same way and for
   * the same reason.
   *
   * `reset()` has to be able to restore the whole selection, not just the model
   * half, so the env side has to be remembered as a pair too.
   */
  private envProvider: string | null;
  private override: string | null = null;
  private overrideProvider: string | null = null;
  private changedAt: string | null = null;
  /**
   * Latches after the first migration warning.
   *
   * The warning is important enough that it cannot be silent, but it is about
   * state the operator will fix once — printing it on every `getState()` would
   * turn a one-time migration notice into permanent log noise that trains the
   * operator to ignore the model-selector's output.
   */
  private warnedAboutLegacyRow = false;
  /**
   * Latches after the first "this selection has no provider" warning.
   *
   * Same reasoning as {@link warnedAboutLegacyRow}, and it matters more here:
   * `getActiveProvider()` is not called once per selection, it is called on
   * every `isMoonshotProvider()`, `activeProviderBaseUrl()`, `getState()` and
   * `getAIService()` — all of which now resolve the active provider through
   * this method. Without the latch an unresolvable selection printed the same
   * paragraph several times per message, which trains the operator to scroll
   * past the one thing in the log that says their selection is not routing.
   */
  private warnedAboutUnresolvedProvider = false;

  constructor() {
    // Absolute path from utils/paths, matching `rate-limiter.ts`. A
    // CWD-relative filename meant the two services opened *different* database
    // files whenever the process did not start in the repo root: `/ratelimit set`
    // would write one file and the dashboard would read another.
    this.db = new Database(dbPath('dashboard_settings.db'));
    this.envModel = config.openai.modelAlias || config.openai.model;
    // Read from the registry, NOT from `config.providers.defaultProvider()`:
    // the env model's provider is whichever provider offers that model, which is
    // not necessarily the first configured one.
    this.envProvider = this.inferProvider(this.envModel);
    this.initDatabase();
    this.loadOverride();

    // Re-apply on boot so every consumer sees the persisted selection.
    this.applyToConfig();
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /**
   * The provider-grouped model lists for the dashboard.
   *
   * Derived fresh on each call rather than cached, because tests (and the
   * registry itself) rewrite `config.dashboard.modelProviders` in place after
   * this singleton is constructed; a cached copy would keep serving the boot
   * snapshot. The cost is one small array build per read, on a path that already
   * hits SQLite.
   *
   * `[]` in legacy mode, deliberately — see `config.dashboard.modelProviders`.
   * The dashboard renders today's flat list in that case, unchanged.
   */
  private providerOptions(): ProviderOption[] {
    return config.dashboard.modelProviders.map((p) => ({
      name: p.name,
      kind: p.kind,
      models: [...p.models],
    }));
  }

  /**
   * Every provider whose model list contains `name`.
   *
   * Returns the MATCHES rather than a single answer because the caller's
   * reaction differs by count: zero and two-or-more are both errors, and they
   * are different errors with different fixes, so the decision belongs where
   * the message is written.
   */
  private providersOffering(name: string): NamedProvider[] {
    if (!config.providers.active) return [];
    return config.providers.registry.filter((p) => p.models.includes(name));
  }

  /**
   * Best-effort single provider for `name`, used only where a wrong-but-safe
   * answer is still correct: the env fallback and the read-path migration.
   *
   * Never throws, because both callers are on paths where throwing would turn a
   * recoverable configuration question into a boot failure — see the two call
   * sites for why `undefined` is the right failure there.
   */
  private inferProvider(name: string): string | null {
    const matches = this.providersOffering(name);
    const only = matches.length === 1 ? matches[0] : undefined;
    return only ? only.name : null;
  }

  /**
   * Parse one stored `model_override` value.
   *
   * Returns `null` for anything unreadable, and for a *plain string* returns
   * `{ provider: <inferred or null>, model: <the string> }` — the MIGRATION
   * path. Rows written before provider-aware routing are bare model ids, and
   * the operator chose that model deliberately; the fix is to attach a provider
   * to it, not to throw their choice away because our storage format changed.
   * A row we genuinely cannot read is dropped, because there is nothing in it to
   * preserve.
   */
  private parseStored(raw: string): StoredSelection | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // A legacy value is any value that is not the JSON object we now write.
    // Trying JSON first (rather than checking for a leading brace) keeps the
    // check correct for a model id that happens to be valid JSON — a numeric
    // id, or the quoted string `"gpt-4o"` — which would otherwise parse into
    // something that is not `{provider, model}`.
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { provider: this.inferProvider(trimmed), model: trimmed };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // `123` or `"gpt-4o"` — a legacy value that merely happens to be JSON.
      const model = typeof parsed === 'string' ? parsed : trimmed;
      return { provider: this.inferProvider(model), model };
    }

    const record = parsed as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model) {
      // Right shape, no usable model: nothing to preserve.
      return null;
    }
    const provider = typeof record.provider === 'string' && record.provider.trim()
      ? record.provider.trim()
      : null;
    return { provider, model };
  }

  private warnAboutLegacyRow(stored: StoredSelection): void {
    if (this.warnedAboutLegacyRow) return;
    this.warnedAboutLegacyRow = true;
    // The two halves of this notice say different things depending on whether the
    // registry is in effect, because only one of them is true at a time. Under
    // legacy behaviour a providerless selection really does fall back to the
    // single implicit provider; under the registry the legacy pair is NOT
    // consulted, so the request cannot be routed at all until a provider is
    // chosen. Telling the operator the legacy routing applies when it does not
    // would have them waiting for a working bot that never works.
    const consequence = stored.provider
      ? `It is used with provider "${stored.provider}" until you pick a different one.`
      : config.providers.active
        ? 'No configured provider offers it, so NO provider is behind it and requests ' +
          'cannot be routed until you choose one in the dashboard.'
        : 'No configured provider offers it, so it falls back to the legacy ' +
          'single-provider routing until you pick one in the dashboard.';
    console.warn(
      [
        '',
        '='.repeat(72),
        '  CONFIGURATION NOTICE: the stored dashboard model selection predates',
        '  provider-aware routing.',
        '='.repeat(72),
        `  Stored as a bare model id: "${stored.model}"`,
        `  Resolved provider: ${stored.provider ?? '(none — it is on no configured provider)'}`,
        '',
        '  The model has been KEPT. ' + consequence,
        '  The selection is re-saved in the new format the next time you switch',
        '  models.',
        '',
        '  If that is not the provider you meant, choose one in the dashboard —',
        '  the same model id can be served by several providers with different',
        '  prices, and only the provider says which one.',
        '='.repeat(72),
        '',
      ].join('\n'),
    );
  }

  private loadOverride(): void {
    const row = this.db
      .query("SELECT value, updated_at FROM settings WHERE key = 'model_override'")
      .get() as { value: string; updated_at: string } | undefined;

    if (!row) return;

    const stored = this.parseStored(row.value);
    if (!stored) {
      console.warn(
        `🎛️ [MODEL] Stored dashboard model selection is unreadable (${row.value}) — ignoring it.`,
      );
      return;
    }

    // A legacy bare-string row cannot have carried a provider, so `provider` is
    // null here by construction and the warning below is the operator's only
    // signal that their selection was re-homed. Note it is NOT rewritten to the
    // new format on read: rewriting in a getter would write to the database from
    // a read path, and would do it before the operator has seen the warning.
    this.warnAboutLegacyRow(stored);

    this.override = stored.model;
    this.overrideProvider = stored.provider;
    this.changedAt = row.updated_at;
    console.log(
      `🎛️ [MODEL] Restored dashboard model selection: ${stored.model}` +
        (stored.provider ? ` (provider "${stored.provider}")` : ''),
    );
  }

  private persist(selection: StoredSelection | null): void {
    this.db.run('DELETE FROM settings WHERE key = ?', ['model_override']);
    if (selection !== null) {
      this.db.run(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        ['model_override', JSON.stringify(selection), new Date().toISOString()]
      );
    }
  }

  /**
   * Mirror the effective model into config so existing readers pick it up.
   * Falls back to the environment model when there is no override.
   */
  private applyToConfig(): void {
    const effective = this.getActiveModel();
    if (effective) {
      config.openai.modelAlias = effective;
    }
  }

  /** The model in effect: the dashboard override, else the env model. */
  getActiveModel(): string {
    return this.override || this.envModel;
  }

  getState(): ModelState {
    const options = [...config.dashboard.modelOptions];
    const canChange = options.length > 0;

    // A previously-selected model that is no longer in the option list would be
    // invisible in the UI, so surface it rather than silently hiding it.
    if (this.override && !options.includes(this.override)) {
      options.unshift(this.override);
    }

    return {
      active: this.getActiveModel(),
      options,
      source: this.override ? 'dashboard' : 'environment',
      environmentModel: process.env.OPENAI_MODEL?.trim() || null,
      fallbackModel: this.envModel,
      canChange,
      changedAt: this.changedAt,
      // null in legacy mode even though `getActiveProvider()` resolves there: the
      // dashboard must render today's single flat picker, and a provider label
      // on every option would imply the operator could choose between them.
      provider: config.providers.active ? (this.getActiveProvider()?.name ?? null) : null,
      providerOptions: this.providerOptions(),
    };
  }

  /**
   * Switch the active model, optionally naming the provider to take it from.
   *
   * `provider` is optional and additive: every pre-registry caller passes one
   * argument and must keep working unchanged, which is also why the single-arg
   * form still works *under* the registry — it infers the provider from the
   * model id, and only refuses when that inference is genuinely unsafe.
   *
   * WHY INFER AND NOT JUST REJECT THE ONE-ARGUMENT FORM
   * -------------------------------------------------
   * An operator upgrading gets a dashboard that still posts `{ model: "x" }`
   * until the frontend is updated, and a service that refuses the old shape
   * would break the switcher entirely for them. Inference keeps that working,
   * and the case it cannot cover safely — the same id on two providers — is
   * exactly the case where silently picking one would be worse than an error,
   * because the operator would have no way to tell which provider they got.
   * So: infer when the answer is unambiguous, name both candidates and stop
   * when it is not.
   *
   * Only models an operator actually configured are accepted, so a typo cannot
   * silently wedge the bot on a bad model.
   */
  setModel(name: string, provider?: string): ModelState {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Model name cannot be empty');
    }

    const options = config.dashboard.modelOptions;
    if (options.length === 0) {
      throw new Error(
        'No model options are configured (set DASHBOARD_MODEL_OPTIONS, or DASHBOARD_MODELS ' +
          'to list models per provider)',
      );
    }

    const requestedProvider = provider?.trim() ? provider.trim() : undefined;
    let resolvedProvider: string | null;

    if (requestedProvider !== undefined) {
      resolvedProvider = requestedProvider;
      this.assertProviderOffers(requestedProvider, trimmed);
    } else if (!config.providers.active) {
      // Legacy mode: one implicit provider, so the flat list is the whole
      // truth and there is no provider to infer. Kept as a separate branch
      // because inferring here would consult an empty registry and reject
      // models the operator has legitimately always been able to select.
      if (!options.includes(trimmed)) {
        throw new Error(`"${trimmed}" is not an allowed model. Allowed: ${options.join(', ')}`);
      }
      resolvedProvider = null;
    } else {
      const matches = this.providersOffering(trimmed);
      if (matches.length > 1) {
        throw new Error(
          `"${trimmed}" is offered by more than one provider (${matches
            .map((p) => p.name)
            .join(', ')}), so the provider cannot be inferred. Pass the provider explicitly: ` +
            `setModel(${JSON.stringify(trimmed)}, provider).`,
        );
      }
      if (matches.length === 1 && matches[0]) {
        resolvedProvider = matches[0].name;
      } else {
        // Same message shape as the legacy rejection: the model is not one the
        // operator configured, whichever mode they are in.
        throw new Error(`"${trimmed}" is not an allowed model. Allowed: ${options.join(', ')}`);
      }
    }

    // Same model on a DIFFERENT provider is a real change — it moves where
    // requests are routed even though the model id is identical — so the
    // no-op check has to compare the pair, not just the id.
    if (trimmed === this.override && resolvedProvider === this.overrideProvider) {
      // Nothing actually changed, so this is not a model switch: leave the
      // prompt profile alone (an operator re-confirming the current model
      // should not lose their manual prompt override).
      return this.getState();
    }

    const previous = this.getActiveModel();
    const previousProvider = this.overrideProvider;
    this.override = trimmed;
    this.overrideProvider = resolvedProvider;
    this.changedAt = new Date().toISOString();
    this.persist({ provider: resolvedProvider, model: trimmed });
    this.applyToConfig();

    console.log(
      `🎛️ [MODEL] Switched ${previous}${previousProvider ? ` [${previousProvider}]` : ''} → ` +
        `${trimmed}${resolvedProvider ? ` [${resolvedProvider}]` : ''} (via dashboard)`,
    );
    // Only reached once the change has succeeded, and never on the throw paths
    // above, so a rejected model leaves the prompt profile override intact.
    this.notifyPromptSelector();
    return this.getState();
  }

  /**
   * Validate an EXPLICIT provider/model pair.
   *
   * Two distinct failures, reported separately because the operator fixes them
   * differently: an unknown provider name means the `.env` does not have it (or
   * the caller sent a stale one), while a known provider that does not offer the
   * model means the pair was mismatched. Collapsing them into "invalid" would
   * send the operator looking in the wrong file.
   */
  private assertProviderOffers(providerName: string, model: string): void {
    const provider = findProvider(config.providers.registry, providerName);
    if (!provider) {
      const known = config.providers.registry.map((p) => p.name);
      throw new Error(
        `There is no provider named "${providerName}". ` +
          (known.length > 0
            ? `Configured providers: ${known.join(', ')}.`
            : 'No providers are configured.'),
      );
    }
    if (!provider.models.includes(model)) {
      throw new Error(
        provider.models.length > 0
          ? `Provider "${providerName}" does not offer the model "${model}". ` +
              `Its models: ${provider.models.join(', ')}.`
          : `Provider "${providerName}" has no configured models (add them under DASHBOARD_MODELS).`,
      );
    }
  }

  /**
   * The NamedProvider backing the current selection. Legacy implicit provider when
   * providers.active === false; undefined when nothing resolves.
   *
   * STABLE CONTRACT — this is the accessor the AI services (`openai.ts`,
   * `google-genai.ts`) route through, so its three cases are load-bearing:
   *
   *   - registry active, an override is set: that provider, looked up by name.
   *   - registry active, no override: `config.providers.defaultProvider()`.
   *   - registry inactive: ONE synthetic provider named `default`, kind `openai`,
   *     carrying `config.openai.baseUrl` / `config.openai.apiKey`.
   *
   * `undefined` means "the operator's stored selection names a provider that no
   * longer exists" — a `.env` edit that renamed or removed a provider while a
   * dashboard selection still points at it. That is reported once and loudly
   * rather than papered over with the default provider, because falling back
   * silently would send the operator's request to a DIFFERENT provider than the
   * one they chose, with a different key and a different bill.
   *
   * The returned object is freshly built in the legacy case so that a caller
   * mutating it cannot corrupt config for the next caller; the registry case
   * returns the config-owned instance, which every other registry reader also
   * treats as read-only.
   */
  getActiveProvider(): NamedProvider | undefined {
    if (!config.providers.active) {
      return {
        name: LEGACY_PROVIDER_NAME,
        kind: 'openai',
        baseUrl: config.openai.baseUrl || undefined,
        apiKey: config.openai.apiKey,
        // The flat option list IS this provider's model list under legacy
        // behaviour, so a caller validating a selection against it sees the same
        // set `setModel` accepted.
        models: [...config.dashboard.modelOptions],
      };
    }

    if (this.override !== null && this.overrideProvider === null) {
      // An active selection with no provider behind it: either a migrated
      // pre-provider row whose model no configured provider offers, or one that
      // two providers share. Falling back to the default provider here would be
      // the one move that is wrong in both cases — it would route a model the
      // operator deliberately picked to a provider they never chose.
      if (!this.warnedAboutUnresolvedProvider) {
        this.warnedAboutUnresolvedProvider = true;
        console.warn(
          `🎛️ [MODEL] The dashboard selection "${this.override}" has no provider behind it ` +
            '(it was stored before provider-aware routing, or several providers offer it). ' +
            'Requests cannot be routed until it is re-selected in the dashboard.',
        );
      }
      return undefined;
    }

    if (this.overrideProvider !== null) {
      const provider = findProvider(config.providers.registry, this.overrideProvider);
      if (provider) return provider;
      if (this.warnedAboutUnresolvedProvider) return undefined;
      this.warnedAboutUnresolvedProvider = true;
      console.warn(
        `🎛️ [MODEL] The dashboard selection points at provider "${this.overrideProvider}", ` +
          'which is not configured any more (renamed or removed from OPENAI_PROVIDERS / ' +
          'GOOGLE_PROVIDERS?). Requests will not be routed until the provider is restored or the ' +
          'model is re-selected in the dashboard.',
      );
      return undefined;
    }

    return config.providers.defaultProvider();
  }

  /**
   * Drop the override and fall back to the environment model. The bot's
   * OpenAIService singleton is re-synced lazily on the next getAIService() call.
   */
  reset(): ModelState {
    this.override = null;
    // The provider half is cleared with the model half. Leaving it behind would
    // make the next `setModel` see a stale pair as "already selected" and skip
    // the prompt-profile rebind — and would keep routing at a provider the
    // operator just gave up by resetting.
    this.overrideProvider = null;
    this.changedAt = new Date().toISOString();
    this.persist(null);
    this.applyToConfig();
    console.log(`🎛️ [MODEL] Cleared dashboard model selection; now using ${this.getActiveModel()}`);
    this.notifyPromptSelector();
    return this.getState();
  }

  /**
   * Tell the prompt-profile service which model is now in effect.
   *
   * That service clears any manual prompt override and activates the profile
   * bound to this model (or `default`). A reset counts: reverting to the
   * environment model is as much a model change as picking another one.
   *
   * The import is one-directional — `prompt-selector` → `prompts`/`config`/
   * `paths`, never back to here — so there is no cycle.
   *
   * Failures are logged rather than propagated: the model change has already
   * been persisted and applied, and returning a 500 that claims the switch
   * failed would strand the operator in a loop where they cannot switch models
   * at all. The error is loud in the log instead, which is the trade this
   * makes deliberately.
   */
  private notifyPromptSelector(): void {
    const model = this.getActiveModel();
    try {
      promptSelectorService.onModelChanged(model);
    } catch (error) {
      console.error(
        `🎛️ [MODEL] Model is now ${model}, but the prompt profile could not be switched: `,
        error,
      );
    }
  }
}

export const modelSelectorService = new ModelSelectorService();
