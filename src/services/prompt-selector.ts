import { Database } from 'bun:sqlite';

import { config } from '../utils/config';
import { dbPath } from '../utils/paths';
import {
  clearCache,
  getActivePromptProfileId,
  listPromptProfiles,
  setActivePromptProfileId,
} from './prompts';

/**
 * Which prompt profile the bot assembles its system prompt from.
 *
 * WHAT A PROFILE IS
 * -----------------
 * A profile is a folder of prompt files that *partially replaces*
 * `prompt_storage/`. `prompts.ts` resolves each file against the active profile
 * and falls back to `default` for anything that profile does not ship, so a
 * profile containing only `persona/identity.txt` changes exactly one prompt and
 * inherits the rest. Consequence for this module: **never assume a profile
 * folder is complete.** Whether an id resolves to anything is
 * `listPromptProfiles()`'s business, not this file's.
 *
 * PRECEDENCE
 * ----------
 *     manual override  >  profile bound to the current model  >  `default`
 *
 * The manual override survives a restart. Changing the model *clears* it — that
 * is the operator's explicit requirement (a model switch means "this model wants
 * its own prompts"), not an accident, and `onModelChanged` is the only thing
 * that clears it.
 *
 * WHY THERE IS A RECONCILE STEP AT ALL
 * ------------------------------------
 * The effective profile depends on the *current model*, but the current model is
 * not this module's business: `model-selector.ts` decides it and mirrors it
 * into `config.openai.modelAlias`. That mirror is applied during *its* module
 * evaluation, and ES module evaluation order is not something this file can
 * predict — `model-selector.ts` imports us, so we are constructed *before* it
 * runs, and reading `config.openai.modelAlias` at construction time can only
 * ever see the environment value.
 *
 * Two things follow, and both are load-bearing:
 *
 *   1. The current model is read **lazily**, on every read, never snapshotted
 *      at construction.
 *   2. The resolved profile **and the model it was resolved for** are both
 *      persisted (`prompt_profile_active`, `prompt_profile_active_model`). On a
 *      cold boot that pair is restored verbatim, which reconstructs the exact
 *      effective profile the operator left the bot on before anyone has touched
 *      the model. Only when the model that shows up *disagrees* with the
 *      recorded one is the profile re-resolved — and that disagreement means the
 *      model genuinely changed (the dashboard selection was restored from its
 *      own row), so re-resolving is the correct answer.
 *
 * Persisting only the override would lose the model binding across a restart
 * whenever the active model was a bound one; persisting only the active id would
 * go stale the moment the restored model came back different. The pair is what
 * makes the cold boot exact.
 */

/** The profile every other profile falls back to: `prompt_storage/` itself. */
export const DEFAULT_PROFILE_ID = 'default';

/** Shared settings table; see `model-selector.ts` for the schema. */
const SETTINGS_DB = 'dashboard_settings.db';

/** The manual dashboard override. Absent row = no override. */
const KEY_OVERRIDE = 'prompt_profile_override';
/** The effective profile id as of the last change. */
const KEY_ACTIVE = 'prompt_profile_active';
/** The model `KEY_ACTIVE` was resolved against. Empty = not yet known. */
const KEY_ACTIVE_MODEL = 'prompt_profile_active_model';

interface SettingsRow {
  value: string;
  updated_at: string;
}

/** Shape handed to the dashboard. `active` is the *effective* profile. */
export interface PromptProfileState {
  /**
   * The configured whitelist, verbatim — `[]` when `PROMPT_PROFILES` is unset.
   * For a picker that must always offer the built-in profile too, use
   * {@link PromptSelectorService.selectableProfiles} instead.
   */
  available: string[];
  /** Effective profile now: override ?? bound to the current model ?? `default`. This is what the UI shows as selected. */
  active: string;
  /** The manual override, or null when the profile is being chosen automatically. */
  override: string | null;
  /** Model → profile bindings, copied so callers cannot mutate config through it. */
  byModel: Record<string, string>;
  /** ISO timestamp of the last change to the selection, or null. */
  changedAt: string | null;
}

/** Mismatches between configuration, disk and persisted state. Pure — see {@link collectPromptProfileDiagnostics}. */
export interface PromptProfileDiagnostics {
  /** Whitelisted ids (other than `default`) with no folder on disk. Harmless at runtime, but almost always a typo. */
  missingFolders: string[];
  /** Profile folders on disk that PROMPT_PROFILES does not whitelist, so the dashboard cannot select them. */
  notWhitelisted: string[];
  /** Model bindings pointing at a whitelisted profile that has no folder. */
  bindingsWithoutFolder: string[];
  /** A persisted override/active profile that no longer exists. */
  stalePersisted: string[];
}

export interface PromptSelectorOptions {
  /** Settings database location. Tests only; defaults to `dbPath('dashboard_settings.db')`. */
  databasePath?: string;
  /** Override the whitelist. Defaults to `config.promptProfiles.available`. */
  available?: readonly string[];
  /** Override the bindings. Defaults to `config.promptProfiles.byModel`. */
  byModel?: Record<string, string>;
  /** Override the model bindings resolve against. Defaults to the mirrored config value. */
  currentModel?: string;
}

/**
 * Pure reconciliation of "what the operator configured" against "what exists on
 * disk" and "what was persisted last run".
 *
 * Kept free of I/O and of instance state so the interesting cases — a typo'd
 * profile name, a binding to a profile folder that was deleted, a leftover
 * override from an older config — are testable without a filesystem or a
 * database.
 */
export function collectPromptProfileDiagnostics(input: {
  available: readonly string[];
  byModel: Record<string, string>;
  onDisk: readonly string[];
  persistedOverride: string | null;
  persistedActive: string | null;
}): PromptProfileDiagnostics {
  const onDisk = new Set(input.onDisk);
  const available = new Set(input.available);

  const missingFolders = input.available.filter(
    (id) => id !== DEFAULT_PROFILE_ID && !onDisk.has(id),
  );
  const notWhitelisted = [...onDisk].filter(
    (id) => id !== DEFAULT_PROFILE_ID && !available.has(id),
  );
  const bindingsWithoutFolder = Object.entries(input.byModel)
    .filter(([, profile]) => !onDisk.has(profile))
    .map(([model, profile]) => `${model}=${profile}`);
  const stalePersisted = [input.persistedOverride, input.persistedActive].filter(
    (id): id is string =>
      id !== null && id !== DEFAULT_PROFILE_ID && !available.has(id) && !onDisk.has(id),
  );

  return { missingFolders, notWhitelisted, bindingsWithoutFolder, stalePersisted };
}

/**
 * The model a profile binding is resolved against.
 *
 * `config.openai.modelAlias` is the mirror `model-selector.ts` maintains for
 * every consumer (it also drives provider routing), so it is authoritative when
 * set; `config.openai.model` is the environment default behind it.
 */
export function currentModelId(): string {
  return config.openai.modelAlias || config.openai.model;
}

export class PromptSelectorService {
  private db: Database;

  private override: string | null = null;
  private active: string = DEFAULT_PROFILE_ID;
  /** The model `active` was resolved against; empty means "not yet known". */
  private activeModel = '';
  private changedAt: string | null = null;

  /**
   * The profile id `prompts.ts` was last told about. Seeded from
   * `getActivePromptProfileId()` so the boot path pushes exactly once, and only
   * when the restored selection differs from what `prompts.ts` is already on.
   */
  private pushed: string;

  private readonly fixedAvailable?: readonly string[];
  private readonly fixedBindings?: Record<string, string>;
  private readonly fixedModel?: string;

  constructor(options: PromptSelectorOptions = {}) {
    this.fixedAvailable = options.available;
    this.fixedBindings = options.byModel;
    this.fixedModel = options.currentModel;

    // Same settings table as `model-selector.ts` (`rate-limiter.ts` uses it for
    // a third thing), opened via `dbPath` so the path is identical no matter
    // where the process was started from.
    this.db = new Database(options.databasePath ?? dbPath(SETTINGS_DB));
    this.initDatabase();

    const restored = this.restore();
    this.pushed = getActivePromptProfileId();
    this.reportDiagnostics();

    if (restored) {
      // Cold boot: the persisted pair is the truth. Push it, but only if it
      // differs from where `prompts.ts` already is.
      this.pushActive(this.active, false);
    } else {
      // First run for this database. Resolve now so a model bound in config is
      // honoured from the first turn, but record *no* model: at this point
      // `config.openai.modelAlias` may still be the environment value, because
      // `model-selector.ts` has not restored its own dashboard selection yet.
      // The first read re-resolves against the real model and persists it.
      this.active = this.resolve(this.getCurrentModel());
      this.activeModel = '';
      this.pushActive(this.active, false);
    }
  }

  /* ── configuration views ───────────────────────────────────────────────── */

  /** The whitelist, as configured. `[]` means the feature is off. */
  getAvailable(): string[] {
    return [...(this.fixedAvailable ?? config.promptProfiles.available)];
  }

  /** The model → profile bindings, as configured. */
  getBindings(): Record<string, string> {
    return { ...(this.fixedBindings ?? config.promptProfiles.byModel) };
  }

  /**
   * The ids the dashboard should offer: the whitelist, plus the built-in
   * `default`, which is always usable (including when the feature is off).
   *
   * Separate from `getState().available` because that field mirrors the
   * configured whitelist exactly — an empty list there is meaningful ("feature
   * off"), whereas a picker with no "default" row in it is a bug.
   */
  selectableProfiles(): string[] {
    const available = this.getAvailable();
    return available.includes(DEFAULT_PROFILE_ID) ? available : [DEFAULT_PROFILE_ID, ...available];
  }

  /** The model bindings resolve against right now. */
  getCurrentModel(): string {
    return this.fixedModel ?? currentModelId();
  }

  /* ── reads ─────────────────────────────────────────────────────────────── */

  /**
   * The effective profile id. Cheap enough for a per-turn call: two config
   * lookups, a string compare, and a re-resolve only when the current model has
   * moved away from the one the active id was resolved for.
   */
  getActiveProfileId(): string {
    this.reconcile();
    return this.active;
  }

  getState(): PromptProfileState {
    this.reconcile();
    return this.snapshot();
  }

  /* ── writes ────────────────────────────────────────────────────────────── */

  /**
   * Set (or clear) the manual override.
   *
   * Validated against the whitelist first and only then persisted, so a
   * rejected id never reaches the database. `default` is always accepted: it is
   * the profile in use whenever nothing else applies, and refusing it would
   * make "explicitly go back to default" impossible while the whitelist is
   * empty.
   *
   * @throws when `profile` is neither `null`/blank nor `default` nor a
   *         whitelisted id — the dashboard turns this into a 400.
   */
  setOverride(profile: string | null): PromptProfileState {
    const available = this.getAvailable();
    let next: string | null = null;

    if (profile !== null && profile !== undefined) {
      const trimmed = String(profile).trim();
      if (trimmed !== '') {
        if (trimmed !== DEFAULT_PROFILE_ID && !available.includes(trimmed)) {
          if (available.length === 0) {
            throw new Error('No prompt profiles are configured (set PROMPT_PROFILES)');
          }
          throw new Error(
            `"${trimmed}" is not an allowed prompt profile. Allowed: ${available.join(', ')}`,
          );
        }
        next = trimmed;
      }
    }

    const previous = this.active;
    this.override = next;
    this.changedAt = new Date().toISOString();
    this.commit(this.getCurrentModel(), true);

    console.log(
      `📝 [PROMPT] Profile ${previous} → ${this.active}` +
        (next === null ? ' (override cleared)' : ` (override: ${next})`),
    );
    return this.snapshot();
  }

  /** Identical to `setOverride(null)`. */
  clearOverride(): PromptProfileState {
    return this.setOverride(null);
  }

  /**
   * Called by `model-selector.ts` after a model change succeeds.
   *
   * Clears the manual override (the operator asked for a different model, which
   * means "use that model's prompts") and activates whatever the new model is
   * bound to, or `default` when it has no binding. Safe to call when there was
   * no override: the clear is a no-op and the active profile is still
   * reconciled, so a restart that restores a model from the database lands on
   * the right prompts too.
   */
  onModelChanged(model: string): PromptProfileState {
    const next = (model ?? '').trim() || this.getCurrentModel();
    const previous = this.active;
    const hadOverride = this.override !== null;

    this.override = null;
    this.changedAt = new Date().toISOString();
    this.commit(next, true);

    console.log(
      `📝 [PROMPT] Model changed to ${next}: profile ${previous} → ${this.active}` +
        (hadOverride ? ' (manual override cleared)' : ''),
    );
    return this.snapshot();
  }

  /**
   * Re-resolve the effective profile against the current model.
   *
   * Runs on every read and after every change. It only writes when the answer
   * actually differs, so a settled configuration costs two string comparisons.
   *
   * @param persist write the outcome to the database. Off on the boot path,
   *                where the persisted state is the truth being restored.
   */
  reconcile(opts: { persist?: boolean } = {}): PromptProfileState {
    const model = this.getCurrentModel();
    const resolved = this.resolve(model);

    if (resolved !== this.active || model !== this.activeModel) {
      this.commit(model, opts.persist ?? true);
    }

    return this.snapshot();
  }

  /** Release the database handle. Tests only. */
  close(): void {
    this.db.close();
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  private read(key: string): SettingsRow | undefined {
    return this.db.query('SELECT value, updated_at FROM settings WHERE key = ?').get(key) as
      | SettingsRow
      | undefined;
  }

  private write(key: string, value: string): void {
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, new Date().toISOString()],
    );
  }

  /** Persist a resolved profile and its model. The override row is deleted or rewritten. */
  private persistSelection(): void {
    this.write(KEY_ACTIVE, this.active);
    this.write(KEY_ACTIVE_MODEL, this.activeModel);

    if (this.override === null) {
      this.db.run('DELETE FROM settings WHERE key = ?', [KEY_OVERRIDE]);
    } else {
      this.write(KEY_OVERRIDE, this.override);
    }
  }

  /**
   * Reload the last session's selection.
   *
   * Restores the override, the resolved profile, and the model that resolution
   * was made against. See the cold-boot note at the top of the file: the pair
   * (active, activeModel) is what makes a restart reconstruct exactly what the
   * operator had, rather than re-deriving it from a model value that has not
   * been mirrored into config yet.
   *
   * @returns whether a profile was persisted at all.
   */
  private restore(): boolean {
    const overrideRow = this.read(KEY_OVERRIDE);
    const activeRow = this.read(KEY_ACTIVE);

    this.override = overrideRow?.value ?? null;
    this.changedAt = activeRow?.updated_at ?? overrideRow?.updated_at ?? null;

    if (!activeRow) {
      return false;
    }

    this.active = activeRow.value || DEFAULT_PROFILE_ID;
    this.activeModel = this.read(KEY_ACTIVE_MODEL)?.value ?? '';

    if (overrideRow) {
      console.log(`📝 [PROMPT] Restored dashboard profile override: ${overrideRow.value}`);
    }
    console.log(
      `📝 [PROMPT] Restored active profile: ${this.active}` +
        (this.activeModel ? ` (resolved for model ${this.activeModel})` : ''),
    );
    return true;
  }

  /** override ?? binding for `model` ?? `default`. */
  private resolve(model: string): string {
    if (this.override !== null) return this.override;
    return this.getBindings()[model] ?? DEFAULT_PROFILE_ID;
  }

  /**
   * Apply a resolution: persist it (when asked) and hand it to `prompts.ts`.
   *
   * `prompts.ts` is always told, and its cache always dropped, so the profile
   * takes effect on the very next turn rather than whenever the cache happens
   * to expire. `prompts.ts` then drops the cache again itself; the second call
   * here is the explicit one, so the intent survives a future refactor of
   * either side.
   */
  private commit(model: string, persist: boolean): void {
    this.active = this.resolve(model);
    this.activeModel = model;
    if (persist) {
      this.persistSelection();
    }
    this.pushActive(this.active, true);
  }

  /**
   * Hand the resolved profile to `prompts.ts`, dropping its cache so the change
   * lands on the very next turn rather than whenever the cache happens to
   * expire.
   *
   * `setActivePromptProfileId` **throws** for an id with no folder on disk, and
   * this runs from the module-level singleton's constructor. A whitelisted typo
   * would therefore take the whole bot down at import, which is far worse than
   * the outcome the operator asked for: prompts keep resolving per file against
   * `default`, which is exactly what a missing folder was going to produce
   * anyway. So a failed push logs loudly and falls back to `default`.
   */
  private pushActive(id: string, force: boolean): void {
    if (!force && id === this.pushed) return;

    try {
      setActivePromptProfileId(id);
      clearCache();
      this.pushed = id;
      return;
    } catch (error) {
      console.error(
        `📝 [PROMPT] Could not activate profile "${id}": ${error instanceof Error ? error.message : String(error)}\n` +
          `     Using "${DEFAULT_PROFILE_ID}" until prompt_storage/profiles/${id}/ exists.`,
      );
    }

    try {
      // `default` is the storage root itself and can never fail to resolve.
      setActivePromptProfileId(DEFAULT_PROFILE_ID);
    } catch {
      /* Unreachable: getPromptProfileRoot('default') has no disk requirement. */
    }
    this.pushed = DEFAULT_PROFILE_ID;
  }

  /** A read of the state that does not re-reconcile, for use inside write paths. */
  private snapshot(): PromptProfileState {
    return {
      available: this.getAvailable(),
      active: this.active,
      override: this.override,
      byModel: this.getBindings(),
      changedAt: this.changedAt,
    };
  }

  /**
   * Turn configuration/disk/persistence mismatches into startup log lines.
   *
   * Every case here is harmless at runtime — a missing folder resolves to
   * `default` per file — and that is exactly why they need saying out loud: a
   * typo'd profile name produces a dashboard dropdown that silently does
   * nothing, and nothing in the request path would ever say so.
   */
  private reportDiagnostics(): void {
    let onDisk: string[];
    try {
      onDisk = listPromptProfiles();
    } catch (error) {
      console.error('📝 [PROMPT] Could not list prompt profiles for the startup check:', error);
      return;
    }

    const diagnostics = collectPromptProfileDiagnostics({
      available: this.getAvailable(),
      byModel: this.getBindings(),
      onDisk,
      persistedOverride: this.override,
      persistedActive: this.active,
    });

    if (diagnostics.missingFolders.length > 0) {
      console.warn(
        `⚠️ [PROMPT] PROMPT_PROFILES lists ${diagnostics.missingFolders.length} profile(s) with no ` +
          `folder in prompt_storage/profiles: ${diagnostics.missingFolders.join(', ')}. ` +
          'They will resolve to "default" — check the spelling.',
      );
    }
    if (diagnostics.notWhitelisted.length > 0) {
      console.warn(
        `⚠️ [PROMPT] Found profile folder(s) not listed in PROMPT_PROFILES: ` +
          `${diagnostics.notWhitelisted.join(', ')}. They cannot be selected until you add them to ` +
          'PROMPT_PROFILES.',
      );
    }
    if (diagnostics.bindingsWithoutFolder.length > 0) {
      console.warn(
        `⚠️ [PROMPT] ${diagnostics.bindingsWithoutFolder.length} model binding(s) point at a profile ` +
          `with no folder: ${diagnostics.bindingsWithoutFolder.join(', ')}. Those models will use "default".`,
      );
    }
    if (diagnostics.stalePersisted.length > 0) {
      console.warn(
        `⚠️ [PROMPT] Persisted profile selection(s) no longer exist: ` +
          `${diagnostics.stalePersisted.join(', ')}. Falling back to "default".`,
      );
    }
  }
}

export const promptSelectorService = new PromptSelectorService();