import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../utils/config';
import { dbPath } from '../utils/paths';
import { DEFAULT_PROFILE_ID, promptSelectorService } from './prompt-selector';
import { PROMPT_PROFILES_DIR, bumpPromptCacheGeneration } from './prompts';

/**
 * Which prompt profile a guild speaks with.
 *
 * WHY THIS IS A SEPARATE SERVICE AND NOT A MODE OF `PromptSelectorService`
 * ---------------------------------------------------------------------
 * `prompt-selector.ts` answers a question that is global by definition: "what
 * has the operator picked for the whole bot". Its precedence is
 *
 *     manual override  >  profile bound to the current model  >  `default`
 *
 * This file answers a different, per-guild one, and the two must not be merged,
 * because they deliberately disagree about what a model change does:
 *
 *   - `PromptSelectorService.onModelChanged()` **clears the manual override**.
 *     Switching model means "this model wants its own prompts" — an explicit
 *     operator requirement.
 *   - A per-guild assignment **survives** a model change. It is not an override
 *     of a model; it is the guild's identity. Coupling the two would make
 *     "clear the main override" and "clear the guild assignments" the same code
 *     path, and the operator would lose the second thing every time they wanted
 *     the first. That is the whole reason this is its own module.
 *
 * So: nothing here is registered with, or called from, `onModelChanged`. There
 * is a test that pins it.
 *
 * PRECEDENCE (per guild, evaluated on the message path)
 * ----------------------------------------------------
 *     1. an explicit assignment row, set from the dashboard
 *     2. the guild's OWN folder — its `.env` label, which *is* its profile folder
 *        name — but only if that folder exists on disk
 *     3. the main-page selection (override ?? model binding ?? `default`)
 *
 * Rule 2 is the reason the feature is useful the moment `.env` is edited: a guild
 * whose folder already exists speaks with it, with no dashboard action and no
 * database row. Rule 1 exists for the operator who wants a guild on some *other*
 * profile for a while. Rule 3 is not a degraded path — it is what DMs, unlisted
 * guilds and every guild-less entry point (login metadata, the dashboard's own
 * reads) always get.
 *
 * IMPORT DIRECTION
 * ----------------
 * This module imports `prompts.ts` (for `PROMPT_PROFILES_DIR`) and
 * `prompt-selector.ts` (for the main selection and the whitelist).
 * **`prompts.ts` must never import this module** — the lookup it needs is
 * injected via `setGuildProfileResolver` precisely to keep it a leaf. See the
 * DEPENDENCY DIRECTION block in `prompts.ts`.
 */

/** Shared settings table; see the note at `prompt-selector.ts`'s `SETTINGS_DB`. */
const SETTINGS_DB = 'dashboard_settings.db';

/**
 * Key prefix for one guild's assignment, as `guild_prompt_profile:<guildId>`.
 *
 * One row per assigned guild rather than a single JSON blob, so clearing one
 * guild is a single `DELETE` and cannot lose a sibling's assignment. An absent
 * row means "not assigned", which is why nothing has to persist negatives: the
 * default is derived (rules 2 and 3 above), not stored.
 */
const KEY_PREFIX = 'guild_prompt_profile:';

/**
 * `KEY_PREFIX` as a `LIKE` pattern, for the one bulk read of the assignment rows.
 *
 * The prefix contains `_`, which `LIKE` would otherwise read as "any single
 * character" and quietly widen the match to unrelated keys in the shared
 * `settings` table. Escaping both wildcards explicitly is cheaper than trusting
 * a future rename to stay wildcard-free.
 */
const KEY_PREFIX_LIKE = `${KEY_PREFIX.replace(/[%_]/g, (c) => `\\${c}`)}%`;

interface SettingsRow {
  value: string;
  updated_at: string;
}

/** One entry of `GUILD_PROMPT_PROFILES`, as this module consumes it. */
export interface GuildProfileConfig {
  /** Discord guild snowflake — the only real identifier here. */
  guildId: string;
  /**
   * Dashboard label, which is also the guild's own profile folder name
   * (`prompt_storage/profiles/<label>/`). It is why every eligible guild has an
   * identity-shaped profile of its own with no extra configuration.
   */
  label: string;
}

/** One guild's effective assignment, as handed to the dashboard. */
export interface GuildProfileAssignment {
  guildId: string;
  /** The configured label, joined in for display. */
  label: string;
  /** The resolved profile id — NOT necessarily the label. */
  profile: string;
  /** ISO timestamp of the last change, from the row's `updated_at`; null if unknown. */
  changedAt: string | null;
}

export interface GuildPromptProfileOptions {
  /** Settings database location. Tests only; defaults to `dbPath('dashboard_settings.db')`. */
  databasePath?: string;
  /** Override the eligible guild list. Defaults to `config.promptProfiles.guilds`. */
  guilds?: readonly GuildProfileConfig[];
  /**
   * Where profile folders live. Tests only; defaults to `PROMPT_PROFILES_DIR`.
   *
   * It exists because `PROMPT_STORAGE_DIR` is anchored to `import.meta.dir` with
   * no env override (`utils/paths.ts`), so a test cannot point the folder
   * existence check at a temp tree any other way — and writing fixture folders
   * under the real `prompt_storage/` is not an option (it is operator-private
   * and gitignored; see `swarmui-profile-overlay.test.ts`).
   */
  profilesDir?: string;
}

/**
 * `statSync().isDirectory()` that answers `false` instead of throwing.
 *
 * Same shape as the private helper in `prompts.ts`. A label that reached here
 * came out of `parseGuildPromptProfiles`, which validated it with the same
 * profile-id rule `prompts.ts` enforces, so this join cannot escape
 * `profilesDir`.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class GuildPromptProfileService {
  private db: Database;

  private readonly fixedGuilds?: readonly GuildProfileConfig[];
  private readonly profilesDir: string;

  /** guildId → its configured entry. The single eligibility gate's backing store. */
  private readonly guildsById = new Map<string, GuildProfileConfig>();

  /**
   * The persisted rows, pre-loaded once so the per-turn path is a `Map.get`.
   *
   * At most `maxGuilds` entries, so the whole thing is a handful of comparisons;
   * it is a cache for latency and for keeping the message path free of queries,
   * not for correctness.
   */
  private assignments = new Map<string, GuildProfileAssignment>();

  /**
   * label → whether `profilesDir/<label>` is a directory right now.
   *
   * Also pre-loaded, because rule 2 of the precedence is a filesystem question
   * and the message path must not ask it there: `existsSync` per turn would put
   * a `stat` syscall between two prompt reads that have to agree, inside a turn
   * that already contains several awaits (see the concurrency notes in
   * `prompts.ts`). Refreshed on write, because writing a guild folder is exactly
   * when the answer changes — the dashboard creates a guild's first override.
   */
  private ownFolderExists = new Map<string, boolean>();

  constructor(options: GuildPromptProfileOptions = {}) {
    this.fixedGuilds = options.guilds;
    this.profilesDir = options.profilesDir ?? PROMPT_PROFILES_DIR;

    // Same `settings` table and same `dbPath` resolution as `prompt-selector.ts`,
    // `model-selector.ts` and `rate-limiter.ts`. A new database file here would
    // mean a second copy of the operator's settings and a second answer to "is
    // this a fresh install?".
    this.db = new Database(options.databasePath ?? dbPath(SETTINGS_DB));
    this.initDatabase();

    for (const entry of this.getConfiguredGuilds()) {
      this.guildsById.set(entry.guildId, entry);
    }

    this.refreshOwnFolderCache();
    this.restore();

    this.reportDiagnostics();
  }

  /* ── configuration views ───────────────────────────────────────────────── */

  /** The configured guilds, in the order `.env` listed them (the dashboard's order). */
  listConfiguredGuilds(): GuildProfileConfig[] {
    return this.getConfiguredGuilds().map((entry) => ({ ...entry }));
  }

  /**
   * Read lazily from config rather than snapshotted, for the same reason
   * `PromptSelectorService.getAvailable()` is: the dashboard and the tests
   * mutate it, and a snapshot taken at construction would disagree with them
   * silently.
   */
  getMaxGuilds(): number {
    return config.promptProfiles.maxGuilds;
  }

  /* ── reads ─────────────────────────────────────────────────────────────── */

  /**
   * The single eligibility gate. Everything else consults it, so a guild absent
   * from `GUILD_PROMPT_PROFILES` cannot be assigned even by a hand-crafted
   * `POST /api/guild-prompt-profiles`, and always follows the main selection.
   */
  isEligible(guildId: string): boolean {
    return typeof guildId === 'string' && this.guildsById.has(guildId);
  }

  /**
   * The profile folder this guild owns — i.e. its label — or null when it is not
   * eligible.
   *
   * This is the new part of the feature: the label from `.env` doubles as a
   * profile id, so every eligible guild already has an identity of its own and
   * does not need the operator to create and assign anything.
   */
  ownProfileId(guildId: string): string | null {
    return this.guildsById.get(guildId)?.label ?? null;
  }

  /** The guild's explicit assignment, or null when unassigned (or not eligible). */
  assignmentFor(guildId: string | null | undefined): GuildProfileAssignment | null {
    if (!guildId) return null;
    const row = this.assignments.get(guildId);
    return row ? { ...row } : null;
  }

  /**
   * Every explicit assignment, in configured guild order.
   *
   * Only *assigned* guilds: an unassigned guild is not an override, and
   * `assignmentFor` already answers "does this one have one". The dashboard's
   * "unassigned" affordance is a guild with no entry here, not an entry with a
   * null profile — so a cleared assignment leaves the UI in the state that means
   * "follow the own-folder default", which is what clearing actually did.
   */
  listAssignments(): GuildProfileAssignment[] {
    const out: GuildProfileAssignment[] = [];
    for (const entry of this.getConfiguredGuilds()) {
      const row = this.assignments.get(entry.guildId);
      if (row) out.push({ ...row });
    }
    return out;
  }

  /**
   * The profile a turn in `guildId` should resolve prompts against.
   *
   * Deliberately cheap: one `Map.get`, one `Map.get`, and a string compare. No
   * query and no `stat` — both are cached at construction and refreshed on write.
   *
   * `null`/`undefined` means "no guild in scope" (a DM, or an entry point that
   * never had one), which is the main-page selection by definition. `4.` of the
   * precedence, `default`, is already what the main selection resolves to when
   * nothing else applies — the explicit fallback is here only so this function
   * can never return an empty string.
   */
  resolveProfileFor(guildId: string | null | undefined): string {
    const entry = guildId ? this.guildsById.get(guildId) : undefined;
    if (!entry) return this.mainProfileId();

    const assigned = this.assignments.get(guildId!);
    if (assigned) return assigned.profile;

    // Rule 2: the guild's own folder, if it exists. A configured guild with no
    // folder has nothing of its own to speak with yet — the operator is expected
    // to create it through the persona editor — so it follows the main page
    // until they do.
    if (this.ownFolderExists.get(entry.label)) return entry.label;

    return this.mainProfileId();
  }

  /* ── writes ────────────────────────────────────────────────────────────── */

  /**
   * Set (or clear) a guild's explicit assignment.
   *
   * `null` — or a blank string, mirroring `setOverride` — clears the row, which
   * returns the guild to its own-folder default (or the main selection if that
   * folder does not exist). "Clear" therefore means *stop overriding*, not *use
   * `default` explicitly*: that is the honest meaning of removing an override,
   * and it matches `clearOverride()`'s existing semantics. Assigning `default`
   * is still possible and is a real choice.
   *
   * Validated before anything is written, so a rejected id never reaches the
   * database and the in-memory cache never diverges from it.
   *
   * @throws when the guild is not in `GUILD_PROMPT_PROFILES`, when the profile is
   *         neither `default`, nor whitelisted, nor the guild's own label, or
   *         when the assignment would exceed `GUILD_PROFILES_MAX`. The dashboard
   *         turns all of these into a 400 unchanged.
   */
  setAssignment(guildId: string, profile: string | null): GuildProfileAssignment[] {
    const entry = this.guildsById.get(guildId);
    if (!entry) {
      // Named, because the operator's first reaction to a 400 here is to go look
      // for a spelling mistake in the guild id rather than in `.env`.
      const configured = this.getConfiguredGuilds();
      throw new Error(
        `Guild ${guildId} is not in GUILD_PROMPT_PROFILES. Configured: ` +
          (configured.length > 0
            ? configured.map((g) => `${g.label}=${g.guildId}`).join(', ')
            : '(none — the feature is off)'),
      );
    }

    const trimmed = profile === null || profile === undefined ? '' : String(profile).trim();
    if (trimmed === '') {
      // The refresh happens even when there was no row to delete. "Clear" is
      // reached from the same dashboard screen that creates a guild's first
      // override, so this is exactly the moment the folder-existence answer can
      // have changed underneath us; skipping it would leave the guild following
      // the main page until the next restart.
      this.clearRow(guildId);
      this.afterWrite();
      return this.listAssignments();
    }

    this.assertAllowedProfile(trimmed, entry);

    // Capacity. `parseGuildPromptProfiles` already refuses to emit more entries
    // than the cap, so this can only fire on a hand-built list or on rows left
    // behind by a `.env` that used to be longer. It is kept because the failure
    // it prevents is the one this feature exists to bound: a dashboard quietly
    // managing more personas than one operator can keep straight.
    if (!this.assignments.has(guildId) && this.assignments.size >= this.getMaxGuilds()) {
      throw new Error(
        `Cannot assign a prompt profile for guild ${guildId}: ` +
          `${this.assignments.size} guild(s) already assigned and GUILD_PROFILES_MAX is ${this.getMaxGuilds()}. ` +
          'Clear one, or raise GUILD_PROFILES_MAX in .env.',
      );
    }

    const changedAt = new Date().toISOString();
    this.write(`${KEY_PREFIX}${guildId}`, trimmed, changedAt);
    this.assignments.set(guildId, {
      guildId,
      label: entry.label,
      profile: trimmed,
      changedAt,
    });

    this.afterWrite();
    console.log(`📝 [PROMPT] Guild ${entry.label} (${guildId}) → ${trimmed}`);
    return this.listAssignments();
  }

  /** Identical to `setAssignment(guildId, null)`. */
  clearAssignment(guildId: string): GuildProfileAssignment[] {
    return this.setAssignment(guildId, null);
  }

  /** Release the database handle. Tests only. */
  close(): void {
    this.db.close();
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private initDatabase(): void {
    // `CREATE TABLE IF NOT EXISTS` against the table the other three services
    // already share — no schema of its own, by design.
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

  private write(key: string, value: string, updatedAt: string): void {
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, updatedAt],
    );
  }

  private getConfiguredGuilds(): readonly GuildProfileConfig[] {
    return this.fixedGuilds ?? config.promptProfiles.guilds;
  }

  /** The main-page selection, with a guaranteed non-empty answer. */
  private mainProfileId(): string {
    return promptSelectorService.getActiveProfileId() || DEFAULT_PROFILE_ID;
  }

  /**
   * Re-stat each configured guild's own folder.
   *
   * Called at construction and after every write. The write is the only moment
   * the answer can change, so there is no TTL and no polling: a stale `false`
   * here would mean the guild silently follows the main page until the bot is
   * restarted, which is the "configured but does nothing" class of failure this
   * feature is meant to eliminate.
   */
  private refreshOwnFolderCache(): void {
    for (const entry of this.guildsById.values()) {
      this.ownFolderExists.set(entry.label, isDirectory(join(this.profilesDir, entry.label)));
    }
  }

  /**
   * Load persisted assignments for still-eligible guilds.
   *
   * A row for a guild that is no longer in `GUILD_PROMPT_PROFILES` is dropped
   * from the cache rather than honoured, because the eligibility gate has to be
   * the only thing that decides whether a guild can be steered. It stays in the
   * database untouched — so putting the entry back in `.env` restores it — and
   * is reported by {@link reportDiagnostics}, because a row nothing reads is
   * always a surprise.
   */
  private restore(): void {
    const rows = this.db
      .query("SELECT key, value, updated_at FROM settings WHERE key LIKE ? ESCAPE '\\'")
      .all(KEY_PREFIX_LIKE) as Array<SettingsRow & { key: string }>;

    for (const row of rows) {
      const guildId = row.key.slice(KEY_PREFIX.length);
      const entry = this.guildsById.get(guildId);
      if (!entry || !row.value) continue;

      this.assignments.set(guildId, {
        guildId,
        label: entry.label,
        profile: row.value,
        changedAt: row.updated_at ?? null,
      });
    }
  }

  /**
   * Reject anything that is not `default`, not whitelisted, and not the guild's
   * own label.
   *
   * The own-label exemption is deliberate and load-bearing (plan §3.5): an entry
   * in `GUILD_PROMPT_PROFILES` authorises that guild on its own. Requiring its
   * label to *also* appear in `PROMPT_PROFILES` would make the operator declare
   * each guild twice, and the failure mode of forgetting the second declaration
   * is a guild folder that exists and is silently never used — precisely the
   * silent no-op this feature removes. Every *other* unwhitelisted id is still
   * refused, in the same words `setOverride` uses, so the dashboard's 400 needs
   * no per-feature branch.
   */
  private assertAllowedProfile(profile: string, entry: GuildProfileConfig): void {
    if (profile === entry.label) return;
    if (profile === DEFAULT_PROFILE_ID) return;
    if (promptSelectorService.selectableProfiles().includes(profile)) return;

    const available = promptSelectorService.getAvailable();
    if (available.length === 0) {
      throw new Error(
        `No prompt profiles are configured (set PROMPT_PROFILES), so "${profile}" ` +
          `cannot be used for guild ${entry.label}. Create prompt_storage/profiles/${profile}/ and list it.`,
      );
    }
    throw new Error(
      `"${profile}" is not an allowed prompt profile. Allowed: ${available.join(', ')} ` +
        `(plus ${entry.label}, which belongs to this guild)`,
    );
  }

  private clearRow(guildId: string): void {
    const entry = this.guildsById.get(guildId);
    // A `DELETE` that matches nothing is still issued: it is the one statement
    // that makes "cleared" true regardless of what the cache believed, and the
    // caller (`setAssignment`) refreshes the folder cache afterwards either way.
    this.db.run('DELETE FROM settings WHERE key = ?', [`${KEY_PREFIX}${guildId}`]);
    if (this.assignments.delete(guildId)) {
      console.log(`📝 [PROMPT] Guild ${entry?.label ?? guildId} assignment cleared`);
    }
  }

  /**
   * Shared post-write bookkeeping.
   *
   * WHY THE GENERATION BUMP IS THE WHOLE OF IT
   * -------------------------------------------
   * A write here changes exactly one thing about the prompt layer: which profile
   * *this guild* resolves against. That is consumed by three caches, and they
   * split cleanly:
   *
   *   - `prompts.ts`'s own `promptCache` is keyed on the **resolved absolute
   *     path**, which already contains the profile's directory. A guild moving to
   *     another profile simply resolves to other keys and re-reads on its own, so
   *     this map needs no invalidation at all. Dropping it would be pure waste:
   *     every unrelated guild would re-read every prompt file on the next turn
   *     because one operator clicked a dropdown.
   *   - `swarmui.ts`'s 30s `config/swarm_cfg.json` cache and
   *     `bot-definition.ts`'s persona memo are keyed on
   *     `(profile, generation)`. The profile half moves on its own; the generation
   *     half is what makes the *external* consumers re-read now rather than
   *     whenever their TTL happens to expire. That is exactly what
   *     `bumpPromptCacheGeneration()` is, and it is what this calls.
   *   - `message-handler.ts`'s compiled trigger patterns are keyed on the profile
   *     too, so a guild that changes profile lands on a *different* map slot and
   *     compiles fresh; returning to a previous profile finds that profile's slot
   *     holding patterns compiled from *that* profile's own cached array, which is
   *     the correct list, so it neither recompiles nor serves anything stale.
   *
   * An earlier version of this comment argued for `clearCache()` on the grounds
   * that `message-handler.ts` memoises compiled regexes on the array *object* it
   * was handed, so "a guild write has to hand every profile a new object". That
   * was true when the patterns had one global slot, and it stopped being true the
   * moment that slot became `TRIGGER_PATTERNS_BY_PROFILE`, keyed on the profile.
   * It also conflated two different events: a *trigger file edit* is what needs a
   * new array object, and that edit arrives through the dashboard's
   * `PUT /api/persona`-style path, which calls `reloadBotDefinition()` →
   * `reloadPrompts()` → `clearCache()` and drops the map regardless of anything
   * here. A guild *assignment write* changes no prompt bytes at all.
   *
   * Nor do the `WeakMap`s in `prompts.ts` — `compiledPromptRewrites` and
   * `renderedTriggerKeywords` — require the drop. Both are keyed on objects
   * `loadJsonFile`/`loadTextFile` own inside that very `promptCache`, so they are
   * strictly *downstream* of it: whenever the map is cleared they lose their keys
   * for free, and whenever it is not, the object they are keyed on is exactly the
   * one still in the cache. They cannot be staler than the map that owns their
   * keys, and `WeakMap` means not dropping the map leaks nothing.
   *
   * `setActivePromptProfileId` still calls `clearCache()` and should: that one
   * *is* an edit to what `prompt_storage/` resolves to process-wide.
   */
  private afterWrite(): void {
    this.refreshOwnFolderCache();
    bumpPromptCacheGeneration();
  }

  /**
   * Startup log lines for configuration that will not do what the operator
   * expects.
   *
   * Both cases are harmless at runtime — a guild without its folder follows the
   * main page, which is the documented fallback — and that is exactly why they
   * need saying out loud: nothing in the request path would ever report them.
   */
  private reportDiagnostics(): void {
    const configured = this.getConfiguredGuilds();
    if (configured.length === 0) return;

    const cap = this.getMaxGuilds();
    if (configured.length > cap) {
      console.warn(
        `⚠️ [PROMPT] GUILD_PROMPT_PROFILES lists ${configured.length} guild(s) but GUILD_PROFILES_MAX is ${cap}. ` +
          'Raise GUILD_PROFILES_MAX if this was deliberate.',
      );
    }

    const missing = configured
      .filter((entry) => !this.ownFolderExists.get(entry.label))
      .map((entry) => `${entry.label}=${entry.guildId}`);
    if (missing.length > 0) {
      console.warn(
        `⚠️ [PROMPT] No prompt folder for guild profile(s): ${missing.join(', ')}. ` +
          'They will follow the main-page selection until prompt_storage/profiles/<label>/ exists. ' +
          'Create the folder from the dashboard\'s Persona tab.',
      );
    }

    // Rows nothing reads. Not an error — the guild is simply not eligible any
    // more — but the operator must be able to tell the difference between "I
    // never set this" and "I set this and it stopped applying".
    const rows = this.db
      .query("SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\'")
      .all(KEY_PREFIX_LIKE) as Array<{ key: string }>;
    const orphans = rows
      .map((row) => row.key.slice(KEY_PREFIX.length))
      .filter((guildId) => !this.guildsById.has(guildId));
    if (orphans.length > 0) {
      console.warn(
        `⚠️ [PROMPT] Saved prompt profile(s) for guild(s) no longer in GUILD_PROMPT_PROFILES: ${orphans.join(', ')}. ` +
          'They are ignored until the guild is listed again.',
      );
    }
  }
}

export const guildPromptProfileService = new GuildPromptProfileService();