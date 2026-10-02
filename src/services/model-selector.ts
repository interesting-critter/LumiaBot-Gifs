import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import { dbPath } from '../utils/paths';

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
}

/**
 * Single source of truth for which model the bot is using.
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
  private override: string | null = null;
  private changedAt: string | null = null;

  constructor() {
    // Absolute path from utils/paths, matching `rate-limiter.ts`. A
    // CWD-relative filename meant the two services opened *different* database
    // files whenever the process did not start in the repo root: `/ratelimit set`
    // would write one file and the dashboard would read another.
    this.db = new Database(dbPath('dashboard_settings.db'));
    this.envModel = config.openai.modelAlias || config.openai.model;
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

  private loadOverride(): void {
    const row = this.db
      .query("SELECT value, updated_at FROM settings WHERE key = 'model_override'")
      .get() as { value: string; updated_at: string } | undefined;

    if (row) {
      this.override = row.value;
      this.changedAt = row.updated_at;
      console.log(`🎛️ [MODEL] Restored dashboard model selection: ${row.value}`);
    }
  }

  private persist(value: string | null): void {
    this.db.run('DELETE FROM settings WHERE key = ?', ['model_override']);
    if (value !== null) {
      this.db.run(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        ['model_override', value, new Date().toISOString()]
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
    };
  }

  /**
   * Switch the active model. Only models listed in DASHBOARD_MODEL_OPTIONS are
   * accepted, so a typo cannot silently wedge the bot on a bad model.
   */
  setModel(name: string): ModelState {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Model name cannot be empty');
    }

    const options = config.dashboard.modelOptions;
    if (options.length === 0) {
      throw new Error('No model options are configured (set DASHBOARD_MODEL_OPTIONS)');
    }
    if (!options.includes(trimmed)) {
      throw new Error(`"${trimmed}" is not an allowed model. Allowed: ${options.join(', ')}`);
    }

    if (trimmed === this.override) {
      return this.getState();
    }

    const previous = this.getActiveModel();
    this.override = trimmed;
    this.changedAt = new Date().toISOString();
    this.persist(trimmed);
    this.applyToConfig();

    console.log(`🎛️ [MODEL] Switched ${previous} → ${trimmed} (via dashboard)`);
    return this.getState();
  }

  /**
   * Drop the override and fall back to the environment model. The bot's
   * OpenAIService singleton is re-synced lazily on the next getAIService() call.
   */
  reset(): ModelState {
    this.override = null;
    this.changedAt = new Date().toISOString();
    this.persist(null);
    this.applyToConfig();
    console.log(`🎛️ [MODEL] Cleared dashboard model selection; now using ${this.getActiveModel()}`);
    return this.getState();
  }
}

export const modelSelectorService = new ModelSelectorService();
