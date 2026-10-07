import { boolEnv, floatEnv, hexColorEnv, intEnv, strEnv } from './env';

/**
 * Env vars that are read as bounded numbers, for the boot-time sanity report in
 * {@link validateConfig}. Anything here is clamped into range at parse time, so
 * a bad value shows up here once, loudly, instead of mysteriously later.
 */
const BOUNDED_ENV_VARS: ReadonlyArray<{
  key: string;
  min?: number;
  max?: number;
}> = [
  { key: 'OPENAI_MAX_TOKENS', min: 1 },
  { key: 'OPENAI_TOP_K', min: 0 },
  { key: 'OPENAI_TEMPERATURE', min: 0, max: 2 },
  { key: 'OPENAI_TOP_P', min: 0, max: 1 },
  { key: 'VISION_SECONDARY_MAX_TOKENS', min: 1 },
  { key: 'VISION_SECONDARY_TEMPERATURE', min: 0, max: 2 },
  { key: 'SEARXNG_MAX_RESULTS', min: 1, max: 100 },
  { key: 'SEARXNG_SAFE_SEARCH', min: 0, max: 2 },
  { key: 'CONVERSATION_MAX_HISTORY', min: 1 },
  { key: 'CHANNEL_MAX_HISTORY', min: 1 },
  { key: 'PORT', min: 1, max: 65535 },
  { key: 'VIDEO_MAX_SIZE_MB', min: 1 },
  { key: 'VIDEO_TARGET_RESOLUTION', min: 144, max: 2160 },
  { key: 'VIDEO_CRF', min: 0, max: 51 },
  { key: 'ATTACHMENTS_MAX_TEXT_SIZE_KB', min: 1 },
  { key: 'PAGE_EXTRACTION_MAX_URLS', min: 1 },
  { key: 'PAGE_EXTRACTION_MAX_CONTENT_KB', min: 1 },
  { key: 'PAGE_EXTRACTION_TIMEOUT_MS', min: 1 },
  { key: 'BOREDOM_MIN_MINUTES', min: 1 },
  { key: 'BOREDOM_MAX_MINUTES', min: 1 },
  { key: 'BOREDOM_HISTORY_LIMIT', min: 1 },
  { key: 'ORCHESTRATOR_RECONNECT_INTERVAL', min: 100 },
  { key: 'ORCHESTRATOR_MAX_RECONNECT', min: 0 },
  // A window of 0s would make `now - lastTime < windowMs` always false, i.e.
  // rate limiting silently off while the startup log claims it is on.
  { key: 'RATE_LIMIT_SECONDS', min: 1 },
  { key: 'DASHBOARD_PORT', min: 1, max: 65535 },
  { key: 'DASHBOARD_LOG_WINDOW_HOURS', min: 1 },
  { key: 'DASHBOARD_USAGE_WINDOW_HOURS', min: 1 },
  { key: 'LLM_DAILY_REQUEST_LIMIT', min: 0 },
  { key: 'DASHBOARD_LOG_MAX_ENTRIES', min: 1 },
  { key: 'GUILD_PROFILES_MAX', min: 1, max: 12 },
];

function parseKnowledgeSourceMode(value: string | undefined): 0 | 1 | 2 {
  const parsed = Number.parseInt(value || '0', 10);
  if (parsed === 1 || parsed === 2) {
    return parsed;
  }
  return 0;
}

/**
 * Owner id, or the empty string when neither OWNER_ID nor BOT_OWNER_ID is set.
 *
 * There is deliberately no hardcoded snowflake fallback: a default owner id
 * silently grants full privileges (memory wipes, global config changes) to
 * whoever holds that account whenever the operator forgets the env var. Empty
 * is the fail-closed sentinel — a Discord snowflake is never empty, so every
 * owner-only gate (`userId === config.bot.ownerId`) denies. `validateConfig()`
 * warns loudly at boot.
 *
 * Typed `string` rather than `string | null` because `src/index.ts` feeds this
 * straight into `setTemplateVariables({ ownerId })`, whose template variable is
 * `string`; making it nullable is a one-line change there.
 */
const ownerId: string = strEnv('OWNER_ID', strEnv('BOT_OWNER_ID', ''));

const dashboardPassword = strEnv('DASHBOARD_PASSWORD', '');

/**
 * Health/ping port for monitors (Dashy, Uptime Kuma, a cron `curl`, …).
 *
 * WHY THE DEFAULT IS 0, i.e. "off"
 * ---------------------------------
 * This listener is deliberately UNAUTHENTICATED — that is the whole point of
 * it (see `server/health.ts`) — so unlike every other tunable in this file it
 * must not appear on an existing install just because the bot was upgraded. A
 * fresh unauthenticated port that nobody asked for is new attack surface
 * appearing on a device that already had none, and it would appear silently,
 * between restarts, with nobody reading the boot log to notice. So the port has
 * to be *chosen* by the operator: `HEALTH_PORT=3002` and you get the listener;
 * unset (or `0`, or `HEALTH_ENABLED=false`) and there is no listener at all.
 *
 * `min: 0` is load-bearing and must not be "tidied" into `min: 1`. `intEnv`
 * clamps to `opts.min`, so a `min: 1` would turn the `0` sentinel into "port 1"
 * — which is privileged, fails to bind as a non-root user, and looks like a
 * deliberate configuration in every log and status line that prints the port.
 * `0` has to survive parsing as "disabled" for `server/health.ts` to branch on.
 */
const healthPort = intEnv('HEALTH_PORT', 0, { min: 0, max: 65535 });

/**
 * A prompt profile id is used verbatim as a directory name under
 * `prompt_storage/profiles/`, so it is restricted to characters that cannot
 * escape that directory.
 *
 * A `..` segment, or an id containing a separator, would let an operator typo
 * (`PROMPT_PROFILES=../../etc`) point the system prompt at arbitrary files on
 * the host. Env vars are trusted-but-typed, and this is the one place where a
 * bad string becomes a path, so it is rejected here rather than trusted to
 * `join()` downstream. Must start with a letter or digit so `.`, `..` and
 * dotfiles cannot be expressed.
 */
const PROMPT_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Shared by both parsers below so they cannot drift apart. */
function isUsableProfileId(id: string): boolean {
  return PROMPT_PROFILE_ID_PATTERN.test(id);
}

/**
 * Parse `PROMPT_PROFILES`: the comma-separated whitelist of prompt profiles the
 * dashboard is allowed to activate.
 *
 * Semantics that matter:
 *   - Entries are trimmed and blanks dropped, so a trailing comma or a stray
 *     space is not a profile.
 *   - Duplicates are collapsed, preserving first-seen order (the order is the
 *     order the dashboard renders the picker in).
 *   - Unset/empty yields `[]`, which turns the whole feature off: only the
 *     built-in `default` profile remains usable. That is deliberately not an
 *     error — a bot with no profiles configured must behave exactly as before.
 *   - Ids that would escape the profile directory are refused loudly (see
 *     {@link PROMPT_PROFILE_ID_PATTERN}) rather than silently kept.
 */
export function parsePromptProfileIds(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of String(raw ?? '').split(',')) {
    const id = entry.trim();
    if (!id) continue;

    if (!isUsableProfileId(id)) {
      console.warn(
        `⚠️ [Config] PROMPT_PROFILES: "${id}" is not a usable profile id ` +
          '(letters, digits, dot, dash and underscore, starting with a letter or digit) — dropped.',
      );
      continue;
    }

    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

/**
 * Parse `MODEL_PROMPT_PROFILES`: comma-separated `model=profile` bindings.
 *
 * Three classes of bad input are handled differently on purpose:
 *
 *   1. **Malformed** (no `=`, more than one `=`, or an empty side) — dropped
 *      with a warning that *names the offending entry*. A silent drop here is
 *      how an operator ends up wondering why their bound profile "never
 *      activates" with no evidence anywhere in the logs.
 *   2. **Profile not in `PROMPT_PROFILES`** — this is a configuration *error*,
 *      not a typo to shrug at: the dashboard could never activate it, so the
 *      binding would look live in config and do nothing at request time. It is
 *      dropped with a loud multi-line warning and the whole `byModel` map is
 *      logged alongside.
 *   3. **Profile whitelisted but with no folder on disk** — not detectable
 *      here (config must not touch the filesystem); `prompt-selector.ts`
 *      reconciles that against `listPromptProfiles()` at startup.
 *
 * @param available ids from {@link parsePromptProfileIds}. An empty list means
 *                    every binding is an error, by design.
 * @param models    `DASHBOARD_MODEL_OPTIONS`, used only to warn about a binding
 *                  for a model the dashboard cannot switch to.
 */
export function parseModelPromptProfiles(
  raw: string | undefined,
  available: readonly string[],
  models: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set(available);
  const knownModels = new Set(models);
  const out: Record<string, string> = {};
  const rejected: string[] = [];

  for (const entry of String(raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Exactly one `=`. `a=b=c` is not a model/profile pair, and guessing which
    // side was meant is how a binding ends up silently pointing somewhere else.
    if (trimmed.split('=').length - 1 !== 1) {
      console.warn(
        `⚠️ [Config] MODEL_PROMPT_PROFILES: "${trimmed}" is not a model=profile pair — dropped.`,
      );
      continue;
    }

    const separator = trimmed.indexOf('=');
    const model = trimmed.slice(0, separator).trim();
    const profile = trimmed.slice(separator + 1).trim();

    if (!model || !profile) {
      console.warn(
        `⚠️ [Config] MODEL_PROMPT_PROFILES: "${trimmed}" is missing a model or a profile name — dropped.`,
      );
      continue;
    }

    if (!isUsableProfileId(profile)) {
      console.warn(
        `⚠️ [Config] MODEL_PROMPT_PROFILES: "${trimmed}" uses an unusable profile id — dropped.`,
      );
      continue;
    }

    if (!allowed.has(profile)) {
      // Loud, not a one-liner: the operator has to understand that this binding
      // is now inert, and why.
      rejected.push(`${model}=${profile}`);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(out, model)) {
      console.warn(
        `⚠️ [Config] MODEL_PROMPT_PROFILES: duplicate binding for "${model}" — ` +
          `keeping "${out[model]}", ignoring "${profile}".`,
      );
      continue;
    }

    if (knownModels.size > 0 && !knownModels.has(model)) {
      // A warning, not a drop: DASHBOARD_MODEL_OPTIONS can legitimately be
      // empty (switching disabled) or out of date relative to this file.
      console.warn(
        `⚠️ [Config] MODEL_PROMPT_PROFILES: "${model}" is not in DASHBOARD_MODEL_OPTIONS — ` +
          'the binding only applies if that model becomes selectable.',
      );
    }

    out[model] = profile;
  }

  if (rejected.length > 0) {
    console.warn(
      [
        '',
        '='.repeat(72),
        '  CONFIGURATION ERROR: MODEL_PROMPT_PROFILES names profiles that',
        '  PROMPT_PROFILES does not allow.',
        '='.repeat(72),
        '',
        '  Dropped:',
        ...rejected.map((r) => `      - ${r}`),
        '',
        `  Allowed by PROMPT_PROFILES: ${available.length > 0 ? available.join(', ') : '(none — the feature is off)'}`,
        '',
        '  A dropped binding is NOT a fallback: the model simply has no profile of',
        '  its own and always resolves to "default". Fix the name, or add it to',
        '  PROMPT_PROFILES and create prompt_storage/profiles/<id>/.',
        '='.repeat(72),
        '',
      ].join('\n'),
    );
  }

  return out;
}

/**
 * One entry of `GUILD_PROMPT_PROFILES`: a Discord guild snowflake and the label
 * the operator gave it.
 *
 * The label is *not* a Discord identifier and is never matched against one. It
 * has two jobs, both operator-facing:
 *   - it is the name shown for this guild in the dashboard's guild list, and
 *   - it is the guild's **own prompt profile folder**,
 *     `prompt_storage/profiles/<label>/`.
 *
 * That second job is why the label has to satisfy
 * {@link PROMPT_PROFILE_ID_PATTERN}: a profile id is joined onto a directory, and
 * the path-traversal boundary around that join is the validator above. Because
 * the label *is* the folder name, "My Cool Guild" is not a label this feature
 * can accept — see rule 9 in {@link parseGuildPromptProfiles}.
 */
export interface GuildPromptProfileEntry {
  label: string;
  guildId: string;
}

/**
 * A Discord snowflake: 16–20 digits.
 *
 * Deliberately shape-checked rather than merely "non-empty". The guild id is
 * the only field here that is ever matched against Discord, so a mistyped id is
 * the failure mode this feature is most prone to: it is not an error anywhere,
 * it simply never matches, and the guild quietly keeps using the main-page
 * persona while the operator believes the `.env` change took effect. Rejecting
 * it loudly at boot converts a silent no-op into a line in the log.
 *
 * The 16-digit floor is a real 2015-era snowflake width; the 20-digit ceiling
 * leaves headroom for the next ~35 years of id growth (Discord's ids are
 * millisecond-since-epoch based), so it will not become a bug that rejects valid
 * guilds. Discord has never issued ids outside this shape.
 */
const DISCORD_SNOWFLAKE_PATTERN = /^\d{16,20}$/;

/**
 * Upper bound on a guild label's length.
 *
 * The label is rendered in the dashboard (a card heading, and the folder name
 * in the persona view's group labels) and appears verbatim in several warning
 * lines at boot. 64 characters is far longer than any sane label and short
 * enough that a pasted paragraph — the realistic way to blow this — is caught
 * rather than wrapping a layout or drowning the log. There is no lower bound
 * beyond "non-empty": single-character profile ids are perfectly usable.
 */
const GUILD_PROMPT_LABEL_MAX_LENGTH = 64;

/**
 * Strip stray parentheses and surrounding whitespace from a label.
 *
 * `( Name )` is how an operator will *inevitably* write a label whose whole
 * purpose is to be human-readable, so refusing it would fail the feature for
 * being friendly rather than for being wrong. It is therefore **tolerated, not
 * rejected**, and it is applied only to the label side: a guild id is a
 * snowflake, and wrapping one in parens is a genuine typo rather than a
 * formatting habit.
 *
 * Looped rather than single-pass so `( ( Name ) )` also collapses, and bounded
 * by the length guard so a bare `(` is left alone for the emptiness/profile-id
 * rules to reject with an accurate message.
 */
function normalizeGuildPromptLabel(raw: string): string {
  let label = raw.trim();
  while (label.length >= 2 && label.startsWith('(') && label.endsWith(')')) {
    label = label.slice(1, -1).trim();
  }
  return label;
}

/**
 * Parse `GUILD_PROMPT_PROFILES`: comma-separated `(label)=(guildId)` pairs naming
 * the guilds allowed their own prompt profile.
 *
 * Format, with one entry per guild:
 *
 *     GUILD_PROMPT_PROFILES=(big-rpd)=123456789012345678,(other)=987654321098765432
 *
 * The philosophy is the same as {@link parseModelPromptProfiles} and follows the
 * plan's decision — **bad entries are rejected loudly, good ones still load.** A
 * single typo must not cost the operator the two entries they got right, and a
 * silent drop is how somebody ends up convinced their per-guild persona is
 * configured when nothing was ever read. So every rejection names the offending
 * entry, and the drops are also summarised in one bordered block at the end
 * rather than left scattered across the boot log.
 *
 * Unset/empty yields `[]`, which turns the whole feature off and leaves
 * behaviour byte-identical to a build without it.
 *
 * Rules, in evaluation order per entry:
 *   1. Not exactly one `=` (`a=b=c`) → dropped. Guessing which side was meant is
 *      exactly how a binding ends up pointing somewhere else; same reasoning as
 *      the `=` check in {@link parseModelPromptProfiles}.
 *   2. Empty label or empty guild id → dropped.
 *   3. Guild id not matching {@link DISCORD_SNOWFLAKE_PATTERN} → dropped, because
 *      a mistyped snowflake silently matches no guild at all.
 *   4. Label longer than {@link GUILD_PROMPT_LABEL_MAX_LENGTH} → dropped.
 *   5. Duplicate guild id → **first wins**, later ones dropped. The operator
 *      means the first one they wrote; the later ones are edits that were never
 *      removed, and silently letting the last win would make the effective
 *      config depend on ordering the operator cannot see.
 *   6. Duplicate label → **allowed**. Labels are display text and folder names,
 *      not keys — the dashboard and the resolution service both key on
 *      `guildId`, so two guilds may legitimately share a label. Refusing it
 *      would be enforcing a uniqueness property nothing depends on.
 *   7. More than `maxGuilds` accepted entries → the extras are dropped with a
 *      warning naming the cutoff, so the cap is visible rather than felt as an
 *      entry the operator swears they wrote.
 *   8. Label wrapped in stray parens/spaces → the parens are stripped and the
 *      label trimmed (tolerated, not rejected). See
 *      {@link normalizeGuildPromptLabel}.
 *   9. Label that is not a usable profile id → dropped, **not slugified**. The
 *      label doubles as the guild's profile folder name (§3.1 of the plan), and
 *      the natural operator guess for "My Guild" is "MyGuild" — silently
 *      renaming it would create a folder somewhere they did not expect and
 *      quietly ignore the one they named. {@link isUsableProfileId} is reused
 *      rather than re-implemented so this parser and
 *      {@link parsePromptProfileIds} cannot drift apart on what a profile id is.
 *
 * Profile *existence* is not checked here — a configured guild's folder may
 * legitimately not exist yet (that is how the operator creates the first
 * override). Config must not touch the filesystem; that reconciliation belongs
 * to the startup diagnostics, exactly as for `MODEL_PROMPT_PROFILES`.
 *
 * @param raw       the raw env value; blank entries and a blank string yield `[]`.
 * @param maxGuilds ceiling on accepted entries, i.e. the operator-configured
 *                  `GUILD_PROFILES_MAX` value rather than a literal, so raising
 *                  the cap needs no code change.
 */
export function parseGuildPromptProfiles(
  raw: string | undefined,
  maxGuilds: number = 3,
): GuildPromptProfileEntry[] {
  // Defensive floor. `maxGuilds` normally arrives already clamped by `intEnv`
  // (min 1), but this function is exported for unit tests and is the only guard
  // between the ceiling and the loop below — a 0 or NaN here would silently drop
  // every entry, turning a typo into a feature that appears simply not to work.
  const cap = Math.max(1, Math.floor(maxGuilds) || 1);
  const seenGuildIds = new Set<string>();
  const out: GuildPromptProfileEntry[] = [];
  const dropped: string[] = [];

  for (const entry of String(raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Exactly one `=`. `a=b=c` is not a label/guild pair, and the plan's
    // format `(label)=(guildId)` means the parens belong to the label — so the
    // raw entry commonly *looks* like it has extra `=`, hence the strip in rule 8
    // happening after this check rather than before it.
    if (trimmed.split('=').length - 1 !== 1) {
      dropped.push(`"${trimmed}" — not a (label)=(guildId) pair`);
      continue;
    }

    const separator = trimmed.indexOf('=');
    const label = normalizeGuildPromptLabel(trimmed.slice(0, separator));
    const guildId = trimmed.slice(separator + 1).trim();

    if (!label || !guildId) {
      dropped.push(`"${trimmed}" — missing a label or a guild id`);
      continue;
    }

    if (!DISCORD_SNOWFLAKE_PATTERN.test(guildId)) {
      // The one identifier here that Discord actually matches on. A typo here is
      // invisible at runtime: the guild simply never resolves to its own
      // profile, which is indistinguishable from the feature not existing.
      dropped.push(`"${trimmed}" — "${guildId}" is not a Discord guild id (16–20 digits)`);
      continue;
    }

    if (label.length > GUILD_PROMPT_LABEL_MAX_LENGTH) {
      dropped.push(
        `"${trimmed}" — label is ${label.length} characters, over the ${GUILD_PROMPT_LABEL_MAX_LENGTH} character limit`,
      );
      continue;
    }

    if (!isUsableProfileId(label)) {
      // The warning has to name the character rule rather than just say "invalid":
      // the operator's instinct on seeing this is to write `MyGuild`, and they
      // must be told that the label is a *folder name*, so the fix is to rename
      // the label themselves — not to have the bot rename it for them.
      dropped.push(
        `"${trimmed}" — label "${label}" is not a usable profile id ` +
          '(letters, digits, dot, dash and underscore, starting with a letter or digit; ' +
          'no spaces). The label is this guild\'s prompt folder name ' +
          '(prompt_storage/profiles/<label>/), so it cannot be rewritten for you — ' +
          'rename it in .env to something like "my-guild".',
      );
      continue;
    }

    if (seenGuildIds.has(guildId)) {
      // First wins, mirroring the duplicate-model handling in
      // `parseModelPromptProfiles`: keep what the operator wrote first rather
      // than letting file order decide which of two contradictory rows applies.
      dropped.push(`"${trimmed}" — guild ${guildId} is already configured as "${label}"`);
      continue;
    }

    if (out.length >= cap) {
      // Reported with the cutoff named, because the visible symptom of hitting
      // the cap is an entry the operator swears they wrote and that appears
      // nowhere.
      dropped.push(
        `"${trimmed}" — over the ${cap}-guild limit (GUILD_PROFILES_MAX); the first ${cap} entries are kept`,
      );
      continue;
    }

    seenGuildIds.add(guildId);
    out.push({ label, guildId });
  }

  if (dropped.length > 0) {
    // Bordered block in the style of the MODEL_PROMPT_PROFILES summary: the
    // whole point is that this is one thing to read, at the end, with the
    // surviving entries named so the operator can tell at a glance whether the
    // remaining pairs are the ones they meant.
    const kept = out.map((e) => `${e.label}=${e.guildId}`);
    console.warn(
      [
        '',
        '='.repeat(72),
        '  CONFIGURATION ERROR: GUILD_PROMPT_PROFILES contains unusable entries.',
        '='.repeat(72),
        '',
        '  Dropped:',
        ...dropped.map((d) => `      - ${d}`),
        '',
        `  Configured: ${kept.length > 0 ? kept.join(', ') : '(none — the feature is off)'}`,
        '',
        '  A dropped guild is NOT a fallback: it simply never matches, so it keeps',
        '  using the main-page prompt profile. Fix the entry above, or comment it',
        '  out. Labels must be usable profile ids because each one names that',
        '  guild\'s own prompt folder (prompt_storage/profiles/<label>/).',
        '='.repeat(72),
        '',
      ].join('\n'),
    );
  }

  return out;
}

/**
 * The dashboard's model list and the prompt-profile tables are parsed here,
 * before the config object, because both parsers need each other: a binding can
 * only be validated against the whitelist, and a whitelist entry is useless
 * without a model list to bind it to.
 *
 * Held in locals (rather than re-reading `process.env` inside the object
 * literal) because `config` is still in its temporal dead zone while it is
 * being initialised — referencing it from inside its own initialiser throws.
 */
const dashboardModelOptions: string[] = strEnv('DASHBOARD_MODEL_OPTIONS', '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const promptProfileIds: string[] = parsePromptProfileIds(strEnv('PROMPT_PROFILES', ''));

const modelPromptProfiles: Record<string, string> = parseModelPromptProfiles(
  strEnv('MODEL_PROMPT_PROFILES', ''),
  promptProfileIds,
  dashboardModelOptions,
);

/**
 * How many guilds may be given their own prompt profile.
 *
 * A ceiling rather than a fixed three so an operator running the bot in more
 * than three places can raise it from `.env` without a code change — but a
 * *small* ceiling on purpose: this feature multiplies the number of distinct
 * personas a single operator has to keep straight, and the dashboard renders one
 * card per guild. `min: 1` because 0 would disable the feature through a number
 * that reads like a mistake, and `max: 12` so a fat-fingered `GUILD_PROFILES_MAX`
 * cannot turn the dashboard into a list nobody can scroll.
 *
 * Read through `intEnv` and never bare `parseInt`: per `utils/env.ts`, a NaN
 * here would make every `length >= cap` comparison false and silently disable
 * the cap, which is exactly the unbounded fan-out the cap exists to prevent.
 * Registered in {@link BOUNDED_ENV_VARS} so a bad value is reported once at boot
 * rather than quietly clamped.
 */
const guildProfilesMax: number = intEnv('GUILD_PROFILES_MAX', 3, { min: 1, max: 12 });

/**
 * The guilds eligible for their own prompt profile, in configured order.
 *
 * Parsed at module scope for the same reason `promptProfileIds` and
 * `modelPromptProfiles` are: the parser is pure and this is a one-shot boot
 * parse, and resolving it inside the `config` literal is not possible because
 * `config` is still in its temporal dead zone there. `[]` (env unset) leaves
 * every guild on the main-page selection.
 */
const guildPromptProfiles: GuildPromptProfileEntry[] = parseGuildPromptProfiles(
  strEnv('GUILD_PROMPT_PROFILES', ''),
  guildProfilesMax,
);

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    redirectUri: strEnv('DISCORD_REDIRECT_URI', 'http://localhost:3000/auth/callback'),
  },
  bot: {
    name: strEnv('BOT_NAME', 'Bad Kitty'),
    familyName: strEnv('BOT_FAMILY_NAME', ''),
    ownerName: strEnv('BOT_OWNER_NAME', 'Prolix'),
    ownerId,
    // False when neither OWNER_ID nor BOT_OWNER_ID is set. Use this to gate
    // owner-only behaviour explicitly; `ownerId` is the empty string then.
    ownerIdSet: ownerId !== '',
    ownerUsername: strEnv('BOT_OWNER_USERNAME', 'prolix_oc'),
    // When true, the bot only responds in Discord channels marked NSFW
    // (reuses the same age-gating used for NSFW image generation).
    nsfwOnly: boolEnv('NSFW_ONLY', false),
    /**
     * Presentation of the reply "card" (embed) the bot posts instead of a bare
     * text message — see `src/utils/response-card.ts`.
     *
     * `EMBED_ENABLED` exists so the previous plain-text-plus-separate-GIF
     * layout can be restored without a code change: an operator who preferred
     * it (or a downstream fork that parses message content) can flip this back
     * off in `.env` and keep everything else.
     */
    embed: {
      enabled: boolEnv('EMBED_ENABLED', true),
      color: hexColorEnv('BOT_EMBED_COLOR', 0x9f3c41),
      // `{botName}` is substituted at render time (not here) so the accent
      // framing can be reworded without restating the bot's display name.
      authorTemplate: strEnv('BOT_EMBED_AUTHOR', '⋆˖⁺‧₊☽{botName}☾₊‧⁺˖⋆'),
      footer: strEnv('BOT_EMBED_FOOTER', '૮₍ ˃ ⤙ ˂ ₎ა arf.'),
    },
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    baseUrl: strEnv('OPENAI_BASE_URL', '') || undefined,
    model: strEnv('OPENAI_MODEL', 'gpt-4o-mini'),
    modelAlias: strEnv('OPENAI_MODEL_ALIAS', '') || undefined,
    maxTokens: intEnv('OPENAI_MAX_TOKENS', 2000, { min: 1 }),
    temperature: floatEnv('OPENAI_TEMPERATURE', 1, { min: 0, max: 2 }),
    topP: floatEnv('OPENAI_TOP_P', 0.95, { min: 0, max: 1 }),
    topK: intEnv('OPENAI_TOP_K', 0, { min: 0 }),
    filterReasoning: boolEnv('OPENAI_FILTER_REASONING', true),
    extraBody: (() => {
      try {
        return process.env.OPENAI_EXTRA_BODY ? JSON.parse(process.env.OPENAI_EXTRA_BODY) : undefined;
      } catch (e) {
        console.warn('⚠️ [Config] Failed to parse OPENAI_EXTRA_BODY as JSON, ignoring');
        return undefined;
      }
    })(),
    rawBodyParams: (() => {
      try {
        return process.env.OPENAI_RAW_BODY_PARAMS ? JSON.parse(process.env.OPENAI_RAW_BODY_PARAMS) : undefined;
      } catch (e) {
        console.warn('⚠️ [Config] Failed to parse OPENAI_RAW_BODY_PARAMS as JSON, ignoring');
        return undefined;
      }
    })(),
    videoEnabled: boolEnv('OPENAI_VIDEO_ENABLED', false),
  },
  gemini: {
    apiKey: strEnv('GEMINI_API_KEY', '') || undefined,
    baseUrl: strEnv('GEMINI_BASE_URL', '') || undefined,
    enabled: !!process.env.GEMINI_API_KEY,
  },
  vision: {
    enabled: !!process.env.VISION_SECONDARY_MODEL,
    model: strEnv('VISION_SECONDARY_MODEL', ''),
    provider: strEnv('VISION_SECONDARY_PROVIDER', 'openai') as 'openai' | 'gemini',
    apiKey: strEnv('VISION_SECONDARY_API_KEY', '') || process.env.OPENAI_API_KEY!,
    baseUrl: strEnv('VISION_SECONDARY_BASE_URL', '') || process.env.OPENAI_BASE_URL,
    maxTokens: intEnv('VISION_SECONDARY_MAX_TOKENS', 2000, { min: 1 }),
    temperature: floatEnv('VISION_SECONDARY_TEMPERATURE', 1, { min: 0, max: 2 }),
    promptPrefix: strEnv('VISION_SECONDARY_PROMPT_PREFIX', 'Describe what you see in this image in detail:'),
  },
  searxng: {
    baseUrl: strEnv('SEARXNG_URL', 'https://search.example.com'),
    maxResults: intEnv('SEARXNG_MAX_RESULTS', 5, { min: 1, max: 100 }),
    safeSearch: intEnv('SEARXNG_SAFE_SEARCH', 1, { min: 0, max: 2 }),
  },
  navidrome: {
    url: strEnv('NAVIDROME_URL', ''),
    user: strEnv('NAVIDROME_USER', ''),
    password: strEnv('NAVIDROME_PASSWORD', ''),
  },
  conversation: {
    maxHistoryLength: intEnv('CONVERSATION_MAX_HISTORY', 20, { min: 1 }),
  },
  dryRun: {
    /**
     * The emoji `/dryrun` replies with once the pipeline has finished.
     *
     * This is an **input**, not markup to paste: `/dryrun` runs it through the
     * same resolver the reaction path uses (`src/utils/emoji.ts`), which
     * accepts a bare name (`zak_yap`), a `:wrapped:` name, a bare snowflake
     * (`1552379447246852146`), or full `<:name:id>` / `<a:name:id>` markup, and
     * emits the correct *content* form for whatever it finds. The default is
     * written as full markup only so it is recognisable; the `a` is added by the
     * resolver because this id is an application-owned emoji.
     *
     * It is overridable per install: a plain unicode emoji renders identically
     * everywhere, and a **guild** emoji only renders inside the guild that owns
     * its id — so an operator whose bot is in a guild that does not own the
     * configured emoji should point this at an application emoji or a unicode
     * one instead.
     */
    emoji: strEnv('DRY_RUN_EMOJI', '<:zak_yap:1552379447246852146>'),
  },
  channel: {
    maxHistoryLength: intEnv('CHANNEL_MAX_HISTORY', 20, { min: 1 }),
  },
  server: {
    port: intEnv('PORT', 3000, { min: 1, max: 65535 }),
  },
  video: {
    // Max video size in MB (default: 50). A NaN here previously meant "no cap",
    // so a huge upload was transcoded at full size.
    maxSizeMB: intEnv('VIDEO_MAX_SIZE_MB', 50, { min: 1 }),
    // Target vertical resolution (default: 720, options: 480, 720, 1080)
    targetResolution: intEnv('VIDEO_TARGET_RESOLUTION', 720, { min: 144, max: 2160 }),
    // CRF quality setting (default: 23, range: 18-28, lower = better quality)
    crf: intEnv('VIDEO_CRF', 23, { min: 0, max: 51 }),
  },
  attachments: {
    // Max text file size in KB (default: 25). Bounds how much of an uploaded
    // file can be injected into the prompt.
    maxTextFileSizeKB: intEnv('ATTACHMENTS_MAX_TEXT_SIZE_KB', 25, { min: 1 }),
  },
  pageExtraction: {
    enabled: boolEnv('PAGE_EXTRACTION_ENABLED', true),
    maxUrls: intEnv('PAGE_EXTRACTION_MAX_URLS', 3, { min: 1 }),
    // Stored in bytes (KB * 1024). The multiply happens after clamping, so an
    // unparseable value can never collapse the cap to 0/NaN and truncate every
    // fetched page to an empty string.
    maxContentLength: intEnv('PAGE_EXTRACTION_MAX_CONTENT_KB', 50, { min: 1 }) * 1024,
    timeoutMs: intEnv('PAGE_EXTRACTION_TIMEOUT_MS', 10000, { min: 1 }),
  },
  thinking: {
    enabled: boolEnv('THINKING_ENABLED', true), // default: true
  },
  knowledge: {
    sourceMode: parseKnowledgeSourceMode(process.env.KNOWLEDGE_GRAPH_SOURCE_MODE),
  },
  orchestrator: {
    // Optional: Enable orchestrator integration for multi-bot coordination
    enabled: boolEnv('ORCHESTRATOR_ENABLED', false),
    url: strEnv('ORCHESTRATOR_URL', 'ws://localhost:3000'),
    apiKey: strEnv('ORCHESTRATOR_API_KEY', ''),
    // Unique bot identifier for the orchestrator
    botId: strEnv('ORCHESTRATOR_BOT_ID', strEnv('DISCORD_CLIENT_ID', 'lumia-bot')),
    botName: strEnv('ORCHESTRATOR_BOT_NAME', strEnv('BOT_NAME', 'LumiaBot')),
    councilName: strEnv('COUNCIL_NAME', strEnv('COUNCIL_FAMILY_NAME', strEnv('BOT_FAMILY_NAME', ''))),
    councilParticipant: boolEnv('ORCHESTRATOR_COUNCIL_PARTICIPANT', true),
    familyName: strEnv('COUNCIL_NAME', strEnv('COUNCIL_FAMILY_NAME', strEnv('BOT_FAMILY_NAME', ''))),
    // Reconnection settings
    reconnectIntervalMs: intEnv('ORCHESTRATOR_RECONNECT_INTERVAL', 5000, { min: 100 }),
    maxReconnectAttempts: intEnv('ORCHESTRATOR_MAX_RECONNECT', 10, { min: 0 }),
  },
  boredom: {
    channelIds: strEnv('BOREDOM_CHANNELS', '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    minIntervalMinutes: intEnv('BOREDOM_MIN_MINUTES', 60, { min: 1 }),
    maxIntervalMinutes: intEnv('BOREDOM_MAX_MINUTES', 240, { min: 1 }),
    showTyping: boolEnv('BOREDOM_SHOW_TYPING', false),
    historyLimit: intEnv('BOREDOM_HISTORY_LIMIT', 15, { min: 1 }),
  },
  rateLimit: {
    // Minimum 1: a 0s window makes `now - lastTime < windowMs` always false,
    // which turns rate limiting off entirely.
    seconds: intEnv('RATE_LIMIT_SECONDS', 60, { min: 1 }),
    /**
     * Rate-limit bypass list ONLY — role IDs or exact names (case-insensitive).
     *
     * This list authorises nothing. It used to double as the trusted-role list
     * for `/ratelimit` and `/boredom`, but those commands write global bot
     * state, and a role *name* is minted by each guild's own admins: any admin
     * of any server the bot is in could create a role called `Moderator`,
     * hand it to a friend, and that member could then spend the operator's
     * money forcing an LLM call every minute.
     *
     * Authority now lives in `TRUSTED_ROLE_IDS`, which accepts role snowflakes
     * only and is parsed by `utils/permissions.ts` (which rejects and logs
     * non-numeric entries, and still honours numeric IDs found here so an
     * existing config keeps working). It is deliberately NOT a field on this
     * object: that module re-reads the env lazily and memoises per raw value,
     * and a second frozen-at-import parse here could disagree with it.
     *
     * Names remain safe in this list because the grant is self-limiting: a
     * bypass only buys the holder more of their own chat quota.
     */
    exemptRoles: strEnv('RATE_LIMIT_EXEMPT_ROLES', '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    emoji: strEnv('RATE_LIMIT_EMOJI', 'rate_limited'),
  },
  dashboard: {
    enabled: boolEnv('DASHBOARD_ENABLED', true),
    // Default is loopback-only. Set to 0.0.0.0 to reach the dashboard from other
    // devices on your LAN. DASHBOARD_PASSWORD is required either way — see
    // `passwordSet` below.
    host: strEnv('DASHBOARD_HOST', '127.0.0.1'),
    // Separate from PORT so it never collides with the orchestrator websocket
    // (ORCHESTRATOR_URL defaults to ws://localhost:3000). Bounded because a
    // NaN port here makes every bind attempt fail and the dashboard silently
    // never comes up.
    port: intEnv('DASHBOARD_PORT', 3001, { min: 1, max: 65535 }),
    password: dashboardPassword,
    // True when DASHBOARD_PASSWORD is a non-empty string. The dashboard server
    // refuses to start on ANY host without a password — loopback included,
    // because on Android every app on the device can reach 127.0.0.1 — and
    // this flag lets it check that without duplicating the parse.
    passwordSet: dashboardPassword !== '',
    username: strEnv('DASHBOARD_USERNAME', 'admin'),
    // Rolling window sizes for the dashboard readouts.
    logWindowHours: intEnv('DASHBOARD_LOG_WINDOW_HOURS', 12, { min: 1 }),
    usageWindowHours: intEnv('DASHBOARD_USAGE_WINDOW_HOURS', 24, { min: 1 }),
    // Your provider's requests-per-day ceiling, used to render usage bars.
    dailyRequestLimit: intEnv('LLM_DAILY_REQUEST_LIMIT', 0, { min: 0 }),
    // Max interactions retained in the in-memory prompt/response log.
    logMaxEntries: intEnv('DASHBOARD_LOG_MAX_ENTRIES', 500, { min: 1 }),
    // Models the dashboard is allowed to switch between. Empty means the
    // switcher stays hidden and the model is fixed by the environment.
    modelOptions: dashboardModelOptions,
  },

  /**
   * Dead-silent, unauthenticated liveness port for monitoring tools.
   *
   * WHY A SEPARATE PORT AND NOT A DASHBOARD ROUTE
   * --------------------------------------------
   * Monitors (Dashy in particular) cannot hold credentials, so they poll the
   * dashboard without them. Every one of those unauthenticated polls is counted
   * as a failed login by `checkAuthorization()`, and after five of them the
   * monitor's source address is locked out — 429, with the window doubling up to
   * 120s. Whenever the monitor shares a source address with the operator (same
   * phone, same Termux session, same `127.0.0.1`, or a reverse proxy in between
   * that collapses both onto one address) the monitor's polling locks the
   * operator out of their own dashboard until the process is restarted. The two
   * failure modes are indistinguishable from the operator's side: the dashboard
   * simply stops loading, and the logs show only the monitor's 401s.
   *
   * A separate listener is the only structural fix. It shares no state with the
   * auth machinery, so there is no counter for a monitor to trip and no
   * credentials for it to fail to supply. The trade-off is that anything that
   * can route to the port learns uptime and whether the Discord gateway is up —
   * which is why the bind host defaults to loopback and a non-loopback bind is
   * warned about loudly at startup.
   *
   * See `server/health.ts` for the server, and `healthPort` above for the
   * opt-in.
   */
  health: {
    // 0 is the "off" sentinel: the port must be explicitly chosen, so an
    // existing install never gains a new unauthenticated listener on upgrade.
    // `HEALTH_ENABLED` is the belt to that braces — defaulting to `true` it can
    // never turn anything on by itself, and it lets an operator who set
    // HEALTH_PORT once kill the listener again without editing the port too.
    enabled: healthPort > 0 && boolEnv('HEALTH_ENABLED', true),
    // Loopback by default for the same reason the dashboard defaults there, but
    // WITHOUT the password requirement: the payload is uptime and gateway
    // readiness, not transcripts. Note that on Android loopback is still shared
    // with every other app on the device, so this is a weak boundary, not a
    // real one.
    host: strEnv('HEALTH_HOST', '127.0.0.1'),
    port: healthPort,
  },

  /**
   * Named prompt profiles.
   *
   * A *profile* is a folder of prompt files that partially replaces
   * `prompt_storage/`. Resolution is per-file with fallback to `default`, so a
   * profile that only ships `persona/identity.txt` overrides that one file and
   * inherits every other prompt.
   *
   * Precedence, implemented by `services/prompt-selector.ts`:
   *   manual override  >  the profile bound to the current model  >  `default`
   *
   * `available` is a **whitelist**: a profile that is not listed here can never
   * be activated, however it is named in `byModel`. `[]` means the feature is
   * off and only `default` is usable.
   *
   * Top level rather than nested under `dashboard` because profiles are read by
   * the bot itself, not only by the dashboard UI.
   */
  promptProfiles: {
    /** Profile ids the dashboard may activate, in configured order. */
    available: promptProfileIds,
    /** Model name → profile id, from MODEL_PROMPT_PROFILES. Bindings whose profile is not whitelisted are dropped with a loud warning. */
    byModel: modelPromptProfiles,
    /**
     * Guilds eligible for their own prompt profile, from
     * GUILD_PROMPT_PROFILES. `[]` means the feature is off and every guild
     * resolves to the main-page selection.
     *
     * `label` is display text AND the guild's own profile folder name, so it is
     * held to the same profile-id rule as `available` — see
     * {@link GuildPromptProfileEntry}.
     */
    guilds: guildPromptProfiles,
    /**
     * Ceiling on how many entries `guilds` may hold (GUILD_PROFILES_MAX,
     * default 3, clamped to 1–12). Exposed rather than hard-coded downstream so
     * the dashboard can show the limit without re-deriving it, and so the
     * enforcement point stays a single value.
     */
    maxGuilds: guildProfilesMax,
  },
};

/**
 * Check if the current model is a Gemini 3 model
 * Gemini 3 models support native video understanding
 */
export function isGemini3Model(): boolean {
  const model = (config.openai.modelAlias || config.openai.model).toLowerCase();
  return model.includes('gemini-3') || model.includes('gemini3');
}

export function isDeepSeekModel(): boolean {
  const model = (config.openai.modelAlias || config.openai.model).toLowerCase();
  return model.includes('deepseek');
}

export function isMoonshotThinkingModel(): boolean {
  const model = (config.openai.modelAlias || config.openai.model).toLowerCase();
  return (model.includes('moonshot') || model.includes('kimi')) && (model.includes('thinking') || model.includes('k2.5') || model.includes('k2.6'));
}

export function isOpenRouterProvider(): boolean {
  return (config.openai.baseUrl || '').toLowerCase().includes('openrouter');
}

export function isGLMModel(): boolean {
  const model = (config.openai.modelAlias || config.openai.model).toLowerCase();
  return model.includes('glm');
}

export function isGeminiFlashModel(): boolean {
  const model = (config.openai.modelAlias || config.openai.model).toLowerCase();
  return (model.includes('gemini-3') || model.includes('gemini3')) && model.includes('flash');
}

export function isMoonshotProvider(): boolean {
  const baseUrl = (config.openai.baseUrl || '').toLowerCase();
  return baseUrl.includes('moonshot.cn') || baseUrl.includes('moonshot.ai');
}

export function isGeminiProModel(): boolean {
  const model = (config.openai.modelAlias || config.openai.model).toLowerCase();
  if (!model.includes('gemini-3') && !model.includes('gemini3')) return false;
  return model.includes('pro') || (!model.includes('flash') && !model.includes('nano'));
}

export function validateConfig(): void {
  const required = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'OPENAI_API_KEY',
    'SEARXNG_URL',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Report out-of-range or unparseable tunables once, at boot, instead of
  // letting them fail mysteriously later (or, worse, silently disable a limit).
  const bad: string[] = [];
  for (const { key, min, max } of BOUNDED_ENV_VARS) {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = Number.parseFloat(raw.trim());
    const range = [
      min !== undefined ? `min ${min}` : null,
      max !== undefined ? `max ${max}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      bad.push(`${key}="${raw}" is not a number (${range ? `expected ${range}` : 'expected a number'}) — using default`);
    } else if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      bad.push(`${key}="${raw}" is outside ${range} — clamped`);
    }
  }
  if (bad.length > 0) {
    console.warn(`⚠️ [Config] ${bad.length} environment variable(s) corrected at startup:`);
    for (const line of bad) console.warn(`   - ${line}`);
  }

  // Fail closed, loudly, but do NOT throw: the bot must still boot and chat.
  // Without an owner id, owner-only gates (memory wipes, global config
  // changes, owner-only mod commands) deny everyone.
  if (!config.bot.ownerIdSet) {
    console.warn(
      '🚨 [Config] OWNER_ID is not set (neither OWNER_ID nor BOT_OWNER_ID).\n' +
        '     Owner-only commands and privileges are DISABLED — nobody can pass the owner check.\n' +
        '     Set OWNER_ID to your Discord user id to restore them. There is no default owner.',
    );
  }

  // One message, one truth. startDashboardServer() refuses to start on ANY
  // host when the password is empty — including loopback, because this runs on
  // Android where every app on the device can reach 127.0.0.1 — so do not
  // suggest that rebinding to 127.0.0.1 helps. It will also print its own
  // refusal at start time; this is the earlier, config-time notice.
  if (config.dashboard.enabled && !config.dashboard.passwordSet) {
    console.warn(
      '🚨 [Config] DASHBOARD_ENABLED is true but DASHBOARD_PASSWORD is empty.\n' +
        '     The dashboard will REFUSE TO START on any bind, including loopback — on Android any\n' +
        '     app on the device can reach 127.0.0.1, so loopback is not a boundary.\n' +
        '     Set DASHBOARD_PASSWORD to a long random string, or set DASHBOARD_ENABLED=false.\n' +
        '     The bot itself is unaffected and keeps running.',
    );
  }
}
