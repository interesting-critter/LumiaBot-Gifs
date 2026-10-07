/**
 * Per-guild prompt-profile resolution.
 *
 * The rules worth proving here, and the bug each one pins:
 *
 *   1. **Eligibility is the only gate.** A guild absent from
 *      `GUILD_PROMPT_PROFILES` cannot be assigned — not by the dashboard, and not
 *      by a hand-crafted `POST /api/guild-prompt-profiles`. Without the gate in
 *      the service, the API layer would be the only place enforcing it, and a
 *      future caller that skips the API (a command, a script) would not.
 *
 *   2. **A guild's own folder is used with NO database row.** This is the case
 *      that makes the feature work the instant `.env` is edited, and it is the
 *      one a naive implementation gets wrong: if the default were "the row, or
 *      nothing", the operator would have to create a folder *and* assign it
 *      before anything happened, and would conclude the feature was broken.
 *
 *   3. **Clearing returns to the own-folder default, not to `default`.** "Clear"
 *      means stop overriding. A version that deleted the row and resolved to the
 *      main page would silently change the guild's persona — the opposite of what
 *      the operator asked for when they hit "clear".
 *
 *   4. **Guild labels are self-authorizing** (plan §3.5): a label that is not in
 *      `PROMPT_PROFILES` is still assignable to its own guild. Requiring both
 *      declarations would mean declaring each guild twice, and forgetting the
 *      second leaves a folder that exists and is never used.
 *
 *   5. **A guild assignment survives a model change.** `onModelChanged` clears
 *      the *main* override only. This is the operator's explicit requirement and
 *      the reason this service is not a mode of `PromptSelectorService`.
 *
 *   6. **The cap is enforced, not assumed.** `parseGuildPromptProfiles` already
 *      refuses to emit more guilds than `GUILD_PROFILES_MAX`, so this is
 *      defensive — and defensive is exactly what gets dropped in a refactor, at
 *      which point the bound this feature exists to impose quietly disappears.
 *
 * FIXTURE DISCIPLINE
 * ------------------
 * Nothing is written under the real `prompt_storage/`: it is operator-private
 * and gitignored (`swarmui-profile-overlay.test.ts` explains why). Every profile
 * folder here is built under `os.tmpdir()` and handed to the service via the
 * `profilesDir` option, because `PROMPT_STORAGE_DIR` is anchored to
 * `import.meta.dir` with no env override and cannot be redirected in process.
 * Every database is a fresh temp file via `databasePath`, removed in `finally`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';
import { config } from '../../utils/config';
import { GuildPromptProfileService } from '../guild-prompt-profiles';
import { promptSelectorService } from '../prompt-selector';

const GUILD_A = '123456789012345678';
const GUILD_B = '987654321098765432';
const GUILD_FOREIGN = '111111111111111111';

/** Guild A owns a folder; guild B deliberately does not. */
const LABEL_A = 'guild-a';
const LABEL_B = 'guild-b';

/** A whitelisted profile that is not any guild's own label. */
const SHARED = 'shared-profile';

const CONFIGURED = [
  { guildId: GUILD_A, label: LABEL_A },
  { guildId: GUILD_B, label: LABEL_B },
];

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumia-guild-profiles-'));
  scratchDirs.push(dir);
  return dir;
}

function dbFile(): string {
  return join(scratch(), 'dashboard_settings.db');
}

/**
 * A profiles directory containing only the folders named.
 *
 * Built fresh per test so "does this guild have a folder?" is never answered by
 * residue from the previous one — a leaked folder would make the own-folder
 * default pass for the wrong reason.
 */
function profilesDirWith(...labels: string[]): string {
  const dir = join(scratch(), 'profiles');
  mkdirSync(dir, { recursive: true });
  for (const label of labels) {
    mkdirSync(join(dir, label), { recursive: true });
  }
  return dir;
}

/**
 * The main-page selection, pinned via the real singleton.
 *
 * `promptSelectorService` is shared, and the precedence rules say an unassigned
 * guild follows the main page — so the main page has to be a known value for
 * any of those assertions to mean anything. Config is saved and restored below.
 */
let originalModelOptions: string[];
let originalAvailable: string[];
let originalByModel: Record<string, string>;
let originalGuilds: typeof config.promptProfiles.guilds;
let originalMaxGuilds: number;
let originalModelAlias: string | undefined;

const MODELS = ['gpt-4o', 'kimi-k2-thinking'];

/**
 * Re-assert this file's baseline configuration.
 *
 * Split from "restore the operator's" on purpose. `promptSelectorService` is a
 * shared singleton that reads `config` live, so a per-test reset that put the
 * real `.env` values back would leave `PROMPT_PROFILES` empty and every
 * whitelist assertion in the next test would be testing an empty list. The
 * baseline is therefore re-applied per test, and the operator's values are put
 * back once in `afterAll`.
 */
function applyBaseline(): void {
  config.dashboard.modelOptions = [...MODELS];
  config.promptProfiles.available = ['default', SHARED];
  config.promptProfiles.byModel = {};
  config.promptProfiles.guilds = originalGuilds;
  config.promptProfiles.maxGuilds = originalMaxGuilds;
  promptSelectorService.clearOverride();
  config.openai.modelAlias = originalModelAlias;
}

function restoreConfig(): void {
  config.dashboard.modelOptions = originalModelOptions;
  config.promptProfiles.available = originalAvailable;
  config.promptProfiles.byModel = originalByModel;
  config.promptProfiles.guilds = originalGuilds;
  config.promptProfiles.maxGuilds = originalMaxGuilds;
}

function makeService(
  options: {
    databasePath?: string;
    guilds?: readonly { guildId: string; label: string }[];
    profilesDir?: string;
  } = {},
): GuildPromptProfileService {
  return new GuildPromptProfileService({
    databasePath: options.databasePath ?? dbFile(),
    guilds: options.guilds ?? CONFIGURED,
    profilesDir: options.profilesDir ?? profilesDirWith(LABEL_A),
  });
}

beforeAll(() => {
  originalModelOptions = config.dashboard.modelOptions;
  originalAvailable = config.promptProfiles.available;
  originalByModel = config.promptProfiles.byModel;
  originalGuilds = config.promptProfiles.guilds;
  originalMaxGuilds = config.promptProfiles.maxGuilds;
  originalModelAlias = config.openai.modelAlias;

  // A stable whitelist for the whole file: `default`, one shared profile, and
  // deliberately NOT the guild labels — that is what makes case 4 meaningful.
  applyBaseline();

  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  applyBaseline();
});

afterAll(() => {
  restoreConfig();
  promptSelectorService.clearOverride();
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('eligibility', () => {
  test('a configured guild is eligible and an unconfigured one is not', () => {
    const service = makeService();

    expect(service.isEligible(GUILD_A)).toBe(true);
    // The load-bearing half: this is the gate the API layer delegates to.
    expect(service.isEligible(GUILD_FOREIGN)).toBe(false);
    service.close();
  });

  test('a guild with no entry has no profile of its own', () => {
    const service = makeService();

    expect(service.ownProfileId(GUILD_A)).toBe(LABEL_A);
    // Otherwise rule 2 of the precedence would silently invent a folder for a
    // guild the operator never opted in.
    expect(service.ownProfileId(GUILD_FOREIGN)).toBeNull();
    service.close();
  });

  test('assigning an ineligible guild throws and names the configured list', () => {
    const service = makeService();

    // The dashboard turns this into a 400. Naming the configured guilds is what
    // stops the operator hunting for a typo in the snowflake instead of in .env.
    expect(() => service.setAssignment(GUILD_FOREIGN, SHARED)).toThrow(
      /not in GUILD_PROMPT_PROFILES/,
    );
    expect(() => service.setAssignment(GUILD_FOREIGN, SHARED)).toThrow(new RegExp(LABEL_A));
    service.close();
  });

  test('a rejected assignment is never persisted', () => {
    const db = dbFile();
    const first = makeService({ databasePath: db });
    expect(() => first.setAssignment(GUILD_FOREIGN, SHARED)).toThrow();
    first.close();

    const second = makeService({ databasePath: db });
    expect(second.listAssignments()).toEqual([]);
    second.close();
  });

  test('an unconfigured guild follows the main-page selection', () => {
    const service = makeService();
    promptSelectorService.setOverride(SHARED);

    expect(service.resolveProfileFor(GUILD_FOREIGN)).toBe(SHARED);
    service.close();
  });
});

describe('the own-folder default needs no database row', () => {
  test('a guild whose folder exists resolves to it with nothing assigned', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    promptSelectorService.setOverride(SHARED);

    // No dashboard action, no DB row, and the main page says something else
    // entirely. This is the behaviour that makes the feature useful straight
    // after editing .env.
    expect(service.assignmentFor(GUILD_A)).toBeNull();
    expect(service.resolveProfileFor(GUILD_A)).toBe(LABEL_A);
    service.close();
  });

  test('a guild with no folder follows the main-page selection', () => {
    // Guild B has no folder here, so it has nothing of its own to speak with and
    // must behave exactly like an unlisted guild.
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    promptSelectorService.setOverride(SHARED);

    expect(service.ownProfileId(GUILD_B)).toBe(LABEL_B);
    expect(service.resolveProfileFor(GUILD_B)).toBe(SHARED);
    service.close();
  });

  test('the default is main-page selection, and a guild-less call is too', () => {
    const service = makeService({ profilesDir: profilesDirWith() });

    // With the whitelist's `default` in play and no override, the answer is the
    // reserved profile — and a DM (null guild) must land on the same thing.
    expect(service.resolveProfileFor(GUILD_A)).toBe('default');
    expect(service.resolveProfileFor(null)).toBe('default');
    expect(service.resolveProfileFor(undefined)).toBe('default');
    service.close();
  });

  test('a folder created after construction is picked up on the next write', () => {
    const profiles = profilesDirWith();
    const service = makeService({ profilesDir: profiles });

    expect(service.resolveProfileFor(GUILD_A)).toBe('default');

    // The dashboard's persona editor creates a guild's first override. If the
    // existence cache were only ever filled at construction, the guild would
    // follow the main page until the bot restarted — the "configured but does
    // nothing" class of failure this feature is meant to eliminate.
    mkdirSync(join(profiles, LABEL_A), { recursive: true });
    service.setAssignment(GUILD_A, null);

    expect(service.resolveProfileFor(GUILD_A)).toBe(LABEL_A);
    service.close();
  });
});

describe('an explicit assignment overrides the own-folder default', () => {
  test('and is reported with its label and timestamp', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    service.setAssignment(GUILD_A, SHARED);

    const row = service.assignmentFor(GUILD_A);
    expect(row?.profile).toBe(SHARED);
    // The dashboard renders the label next to the profile; they are different
    // fields and collapsing them loses "which guild is this?".
    expect(row?.label).toBe(LABEL_A);
    expect(row?.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(service.resolveProfileFor(GUILD_A)).toBe(SHARED);
    expect(service.listAssignments()).toHaveLength(1);
    service.close();
  });

  test('assignments are per guild', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A, LABEL_B) });
    // Guild B's own folder exists too, so it resolves to LABEL_B with no row at
    // all — which is the control for the second half of this test.
    service.setAssignment(GUILD_A, SHARED);

    expect(service.resolveProfileFor(GUILD_A)).toBe(SHARED);
    // Unassigned, so B falls to its own folder while A sits on the shared
    // profile. Two guilds, two personas, from one row and one folder.
    expect(service.resolveProfileFor(GUILD_B)).toBe(LABEL_B);
    expect(service.listAssignments()).toHaveLength(1);
    service.close();
  });

  test('a row for one guild does not leak into a sibling', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A, LABEL_B) });
    service.setAssignment(GUILD_A, SHARED);

    // Guild B has no row and its folder does not exist here, so it must land on
    // the main page — a shared cache bug would hand it SHARED.
    const noFolders = makeService({
      databasePath: join(scratch(), 'dashboard_settings.db'),
      profilesDir: profilesDirWith(),
    });
    expect(noFolders.resolveProfileFor(GUILD_B)).toBe('default');

    service.setAssignment(GUILD_B, 'default');
    expect(service.assignmentFor(GUILD_B)?.profile).toBe('default');
    expect(service.assignmentFor(GUILD_A)?.profile).toBe(SHARED);
    service.close();
    noFolders.close();
  });

  test('assigning `default` is a real choice, distinct from clearing', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    service.setAssignment(GUILD_A, 'default');

    expect(service.resolveProfileFor(GUILD_A)).toBe('default');
    // A row exists, so the dashboard can offer "clear" for it.
    expect(service.assignmentFor(GUILD_A)?.profile).toBe('default');
    service.close();
  });
});

describe('clearing returns to the own-folder default, not to the main page', () => {
  test('clear is identical to passing null', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    service.setAssignment(GUILD_A, SHARED);

    const after = service.setAssignment(GUILD_A, null);

    // The row is gone …
    expect(after).toEqual([]);
    expect(service.assignmentFor(GUILD_A)).toBeNull();
    // … and the guild is back on its own folder, NOT on the main page. A version
    // that resolved to the main selection here would silently change the guild's
    // persona, which is the opposite of what "clear" means.
    expect(service.resolveProfileFor(GUILD_A)).toBe(LABEL_A);
    service.close();
  });

  test('a blank string clears too, rather than selecting a blank profile', () => {
    // Matches `setOverride`'s handling, so the dashboard's form can send either.
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    service.setAssignment(GUILD_A, SHARED);
    service.setAssignment(GUILD_A, '   ');

    expect(service.assignmentFor(GUILD_A)).toBeNull();
    service.close();
  });

  test('clearing a guild with no folder returns it to the main-page selection', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    promptSelectorService.setOverride(SHARED);
    service.setAssignment(GUILD_B, 'default');

    service.setAssignment(GUILD_B, null);

    // Rule 2 cannot apply, so the honest fallback is rule 3.
    expect(service.resolveProfileFor(GUILD_B)).toBe(SHARED);
    service.close();
  });
});

describe('a guild label is self-authorizing', () => {
  test('its own label is accepted even though PROMPT_PROFILES does not list it', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });

    // `LABEL_A` is deliberately absent from the whitelist set in `beforeAll`.
    // Requiring both declarations would mean declaring each guild twice, and
    // forgetting the second leaves a folder that exists and is never used.
    expect(config.promptProfiles.available).not.toContain(LABEL_A);
    expect(() => service.setAssignment(GUILD_A, LABEL_A)).not.toThrow();
    expect(service.resolveProfileFor(GUILD_A)).toBe(LABEL_A);
    service.close();
  });

  test('another guild\'s label is still refused', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A, LABEL_B) });

    // Self-authorizing, not globally authorized: guild A cannot be steered onto
    // guild B's folder.
    expect(() => service.setAssignment(GUILD_A, LABEL_B)).toThrow(
      /not an allowed prompt profile/,
    );
    service.close();
  });

  test('a foreign profile is refused in the same words the main picker uses', () => {
    const service = makeService();

    // Same message shape as `setOverride`, so the dashboard's 400 needs no
    // per-feature branch.
    expect(() => service.setAssignment(GUILD_A, 'typo-profile')).toThrow(
      /not an allowed prompt profile/,
    );
    expect(service.assignmentFor(GUILD_A)).toBeNull();
    service.close();
  });

  test('the error names the guild\'s own label as the extra allowed id', () => {
    const service = makeService();
    expect(() => service.setAssignment(GUILD_A, 'typo-profile')).toThrow(new RegExp(LABEL_A));
    service.close();
  });
});

describe('assignments survive a restart', () => {
  test('a fresh instance against the same database returns them', () => {
    const db = dbFile();
    const profiles = profilesDirWith(LABEL_A);

    const first = makeService({ databasePath: db, profilesDir: profiles });
    first.setAssignment(GUILD_A, SHARED);
    first.setAssignment(GUILD_B, 'default');
    first.close();

    // "Turn the bot off and on again."
    const second = makeService({ databasePath: db, profilesDir: profiles });
    expect(second.resolveProfileFor(GUILD_A)).toBe(SHARED);
    expect(second.resolveProfileFor(GUILD_B)).toBe('default');
    expect(second.assignmentFor(GUILD_A)?.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    second.close();
  });

  test('a cleared assignment stays cleared across a restart', () => {
    const db = dbFile();
    const profiles = profilesDirWith(LABEL_A);

    const first = makeService({ databasePath: db, profilesDir: profiles });
    first.setAssignment(GUILD_A, SHARED);
    first.setAssignment(GUILD_A, null);
    first.close();

    const second = makeService({ databasePath: db, profilesDir: profiles });
    // A delete that only cleared the in-memory cache would come back as a
    // resurrected assignment after every restart.
    expect(second.assignmentFor(GUILD_A)).toBeNull();
    expect(second.resolveProfileFor(GUILD_A)).toBe(LABEL_A);
    second.close();
  });

  test('a row for a guild that left GUILD_PROMPT_PROFILES is ignored, not honoured', () => {
    const db = dbFile();
    const profiles = profilesDirWith(LABEL_A);

    const first = makeService({ databasePath: db, profilesDir: profiles });
    first.setAssignment(GUILD_A, SHARED);
    first.close();

    // The operator removed the entry from .env. Honouring the leftover row would
    // mean a guild the operator believes is opted out still has a persona.
    const second = makeService({ databasePath: db, profilesDir: profiles, guilds: [] });
    expect(second.assignmentFor(GUILD_A)).toBeNull();
    expect(second.resolveProfileFor(GUILD_A)).toBe('default');
    second.close();
  });
});

describe('a guild assignment survives a model change', () => {
  test('onModelChanged clears the main override and leaves guild rows alone', () => {
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    service.setAssignment(GUILD_A, SHARED);
    promptSelectorService.setOverride('default');
    expect(promptSelectorService.getState().override).toBe('default');

    promptSelectorService.onModelChanged('kimi-k2-thinking');

    // The main override is gone, as the operator requires …
    expect(promptSelectorService.getState().override).toBeNull();
    // … and the guild's identity is untouched. If these were the same code path,
    // switching model would silently cost the operator their per-guild personas.
    expect(service.assignmentFor(GUILD_A)?.profile).toBe(SHARED);
    expect(service.resolveProfileFor(GUILD_A)).toBe(SHARED);
    service.close();
  });

  test('and the row is still there for the next process', () => {
    const db = dbFile();
    const profiles = profilesDirWith(LABEL_A);

    const first = makeService({ databasePath: db, profilesDir: profiles });
    first.setAssignment(GUILD_A, SHARED);
    promptSelectorService.onModelChanged('kimi-k2-thinking');
    first.close();

    const second = makeService({ databasePath: db, profilesDir: profiles });
    expect(second.resolveProfileFor(GUILD_A)).toBe(SHARED);
    second.close();
  });

  test('an unassigned guild re-resolves as the main selection moves', () => {
    // The counterpart to the test above, and the reason unassigned guilds must
    // never be given a row: they follow the main page by construction.
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A) });
    config.promptProfiles.byModel = { 'kimi-k2-thinking': SHARED };

    // Mirror the active model into config the way `model-selector.ts` does.
    // Without this, the very next read reconciles against the *previous* model
    // and the binding is resolved away before anything observes it.
    promptSelectorService.onModelChanged('kimi-k2-thinking');
    config.openai.modelAlias = 'kimi-k2-thinking';
    try {
      expect(service.resolveProfileFor(GUILD_B)).toBe(SHARED);

      promptSelectorService.onModelChanged('gpt-4o');
      config.openai.modelAlias = 'gpt-4o';
      expect(service.resolveProfileFor(GUILD_B)).toBe('default');
    } finally {
      config.openai.modelAlias = originalModelAlias;
    }
    service.close();
  });
});

describe('the guild cap is enforced, not assumed', () => {
  test('assigning past GUILD_PROFILES_MAX throws instead of growing without bound', () => {
    config.promptProfiles.maxGuilds = 1;
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A, LABEL_B) });

    service.setAssignment(GUILD_A, SHARED);

    // Defensive only — `parseGuildPromptProfiles` already refuses to emit more
    // guilds than the cap — but defensive code is exactly what a refactor drops,
    // and the bound this feature exists to impose would go with it.
    expect(() => service.setAssignment(GUILD_B, SHARED)).toThrow(/GUILD_PROFILES_MAX/);
    expect(service.listAssignments()).toHaveLength(1);
    service.close();
  });

  test('re-assigning an already-assigned guild is not a new seat', () => {
    config.promptProfiles.maxGuilds = 1;
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A, LABEL_B) });
    service.setAssignment(GUILD_A, SHARED);

    // At the cap, changing your mind must still work — otherwise "clear and
    // re-pick" breaks for the one guild that is configured.
    expect(() => service.setAssignment(GUILD_A, 'default')).not.toThrow();
    service.close();
  });

  test('clearing frees a seat', () => {
    config.promptProfiles.maxGuilds = 1;
    const service = makeService({ profilesDir: profilesDirWith(LABEL_A, LABEL_B) });
    service.setAssignment(GUILD_A, SHARED);
    service.setAssignment(GUILD_A, null);

    expect(() => service.setAssignment(GUILD_B, SHARED)).not.toThrow();
    service.close();
  });
});

describe('fixture hygiene', () => {
  test('no fixture was written under the repository prompt tree', () => {
    // `prompt_storage/` is operator-private and gitignored; it must not appear
    // because of this suite.
    expect(existsSync(join(REPO_ROOT, 'prompt_storage'))).toBe(false);
  });
});