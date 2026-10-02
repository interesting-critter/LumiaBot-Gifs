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
    modelOptions: strEnv('DASHBOARD_MODEL_OPTIONS', '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
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
