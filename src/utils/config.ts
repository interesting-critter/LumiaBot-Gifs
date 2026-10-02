import { boolEnv, floatEnv, intEnv, strEnv } from './env';

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
