import { join } from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from '../utils/config';
import { KNOWLEDGE_DOCUMENTS_DIR, PROMPT_STORAGE_DIR } from '../utils/paths';
import { strEnv } from '../utils/env';
import { dashboardLoggerService, type InteractionSource } from '../services/dashboard-logger';
import { apiUsageService } from '../services/api-usage';
import { userMemoryService, type MemoryEntryKind, type UserOpinion } from '../services/user-memory';
import { rateLimiterService } from '../services/rate-limiter';
import { modelSelectorService } from '../services/model-selector';
import { promptSelectorService } from '../services/prompt-selector';
import {
  DEFAULT_PROMPT_PROFILE_ID,
  getActivePromptProfileId,
  getPromptProfileRoot,
  resolvePromptPath,
} from '../services/prompts';
import { knowledgeGraphService } from '../services/knowledge-graph';
import { conversationHistoryService } from '../services/conversation-history';
import { searxngService } from '../services/searxng';
import { navidromeService } from '../services/navidrome';
import { reloadBotDefinition } from '../utils/bot-definition';
import { bot } from '../bot/client';
import { describeBindError, isAddressInUse } from './bind';

const UI_PATH = join(import.meta.dir, 'dashboard', 'index.html');

/** Shown in the UI so the operator knows which directory sync reads. */
const KNOWLEDGE_DIR_LABEL = 'knowledge_documents';

/**
 * How many consecutive ports to try, starting at `config.dashboard.port`.
 * A busy port is common when the bot has been restarted without the previous
 * process releasing the socket, and that must not be fatal.
 */
const DASHBOARD_PORT_ATTEMPTS = 5;

const VALID_SOURCES: InteractionSource[] = [
  'mention',
  'keyword',
  'reply',
  'orchestrator',
  'boredom',
  'slash-command',
  'unknown',
];

const VALID_KINDS: MemoryEntryKind[] = ['opinion', 'third_party'];
const VALID_SENTIMENTS: UserOpinion['sentiment'][] = ['positive', 'negative', 'neutral', 'mixed'];

let cachedHtml: string | null = null;

async function loadUi(): Promise<string> {
  if (cachedHtml === null) {
    cachedHtml = await Bun.file(UI_PATH).text();
  }
  return cachedHtml;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * Compare two credentials without an early exit *inside* the character loop.
 *
 * NOT constant-time, despite what the shape suggests: the length check below
 * returns immediately, so a caller can still learn the expected length, and JS
 * string ops give no timing guarantee regardless. That is acceptable here — the
 * only secret compared is a dashboard password protecting a loopback or
 * LAN-bound admin UI. Do not reuse this for anything that needs a real
 * timing-safe comparison.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Optional absolute origin the dashboard is also served under, e.g.
 * `https://ops.example.com` behind a TLS-terminating proxy.
 *
 * When set it becomes the only accepted `Origin` for mutations, which is
 * strictly safer than reconstructing an origin from request headers: a
 * `Host`/`X-Forwarded-Proto` pair is exactly what DNS rebinding controls.
 */
const PUBLIC_ORIGIN = strEnv('DASHBOARD_PUBLIC_ORIGIN', '').trim().replace(/\/+$/, '');

/** Upper bound on a single prompt-file write. */
const PERSONA_MAX_BYTES = 256 * 1024;

/** JSON envelope overhead on top of {@link PERSONA_MAX_BYTES}. */
const PERSONA_BODY_SLACK_BYTES = 64 * 1024;

/**
 * Build the set of `Host` header values this server answers to.
 *
 * WHY THIS EXISTS
 * ---------------
 * The origin check below used to compare `Origin` against
 * `${X-Forwarded-Proto}://${Host}`, which looks like it stops DNS rebinding and
 * does not: once the victim's DNS resolves `evil.com` to `127.0.0.1`, the
 * attacker's page origin *is* `http://evil.com:3001` and the `Host` header *is*
 * `evil.com:3001`, so the comparison matches and the request is same-origin as
 * far as every header is concerned. The page can then read every prompt and
 * response plus the system prompt, and rewrite the persona on disk. No CORS
 * headers are involved because after rebinding it genuinely is same-origin.
 *
 * The only defence that closes the class is to refuse requests whose `Host` we
 * were never configured to serve, before auth and before any data is touched.
 * The configured bind host and the loopback names are the legitimate values;
 * anything else is a rebinding attempt (or a stray port-forward).
 *
 * Every candidate port is included because the bind may step forward past a
 * busy one, and the operator follows the URL that was logged.
 */
function buildHostAllowlist(bindHost: string, basePort: number): Set<string> {
  const names = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  names.add(bindHost);
  // An IPv6 bind host arrives unbracketed from config (`::`) but bracketed in a
  // Host header (`[::]`), so allow both spellings.
  if (bindHost.includes(':') && !bindHost.startsWith('[')) {
    names.add(`[${bindHost}]`);
  }

  const allowed = new Set<string>();
  for (const name of names) {
    allowed.add(name.toLowerCase());
    for (let i = 0; i < DASHBOARD_PORT_ATTEMPTS; i++) {
      allowed.add(`${name}:${basePort + i}`.toLowerCase());
    }
  }

  if (PUBLIC_ORIGIN) {
    try {
      const publicUrl = new URL(PUBLIC_ORIGIN);
      allowed.add(publicUrl.host.toLowerCase());
      allowed.add(publicUrl.hostname.toLowerCase());
    } catch {
      // A malformed DASHBOARD_PUBLIC_ORIGIN must not silently widen or narrow
      // anything; it simply does not contribute to the allowlist.
    }
  }

  return allowed;
}

function isAllowedHost(header: string | null, allowed: Set<string>): boolean {
  if (!header) {
    return false;
  }
  // Case-insensitive per RFC 3986, and a trailing dot is the same host.
  return allowed.has(header.trim().toLowerCase().replace(/\.$/, ''));
}

/**
 * Whether a state-changing request came from somewhere other than the page's
 * own origin.
 *
 * The dashboard authenticates with HTTP Basic, which does not stop cross-site
 * requests: browsers cache Basic credentials against the *origin*, not the
 * referring page, so they will attach them to a cross-origin request too. A
 * plain cross-origin `<form method="POST">` or `fetch` is a CORS "simple
 * request", so it is sent without a preflight — meaning any page the operator
 * visits could silently reset the model or wipe the usage counter.
 *
 * Note that this is defence in depth only. Under a full DNS rebinding attack
 * both `Origin` and `Host` are attacker-chosen and agree with each other, so
 * the check passes; {@link isAllowedHost} is what actually stops that.
 *
 * `same-site` is treated as hostile: a legitimate sibling-subdomain deployment
 * would be blocked, which errs in the safe direction.
 */
function isCrossSiteMutation(request: Request, method: string): boolean {
  if (!MUTATING_METHODS.has(method)) {
    return false;
  }

  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    return true;
  }

  const origin = request.headers.get('Origin');
  // Omitted Origin on a mutation is not a case a browser produces for a real
  // same-origin form/fetch, so allow it rather than break an exotic client
  // (curl from a local shell). Credentials are still required, and the Host
  // allowlist has already rejected anything we were not bound to serve.
  if (!origin) {
    return false;
  }
  // 'null' is an opaque origin (sandboxed frame, file://) which by definition
  // cannot be same-origin with an http(s) dashboard.
  if (origin === 'null') {
    return true;
  }

  if (PUBLIC_ORIGIN) {
    return origin !== PUBLIC_ORIGIN;
  }

  const host = request.headers.get('Host');
  if (!host) {
    return true;
  }

  // No configured public origin: compare against the request's own Host on the
  // scheme the server actually speaks. `X-Forwarded-Proto` is deliberately NOT
  // trusted — it is a request header, so anyone who can send a request can set
  // it, and trusting it makes the check trivially satisfiable once the
  // dashboard is ever fronted by a proxy.
  return origin !== `http://${host}`;
}

// ---- Brute-force protection ------------------------------------------------

/** Consecutive failures tolerated before the caller starts being delayed. */
const AUTH_FAILURE_LIMIT = 5;

/** First lockout window, doubling per further failure. */
const AUTH_BACKOFF_BASE_MS = 2_000;

/** Ceiling on the lockout window. */
const AUTH_BACKOFF_MAX_MS = 120_000;

/** Failed attempts older than this are forgotten. */
const AUTH_STATE_TTL_MS = 15 * 60_000;

/** Cap on tracked IPs so a spray from many source addresses cannot leak. */
const AUTH_STATE_MAX_ENTRIES = 1024;

interface AuthState {
  failures: number;
  blockedUntil: number;
  lastSeen: number;
}

const authStates = new Map<string, AuthState>();

function authBackoffMs(failures: number): number {
  const over = failures - AUTH_FAILURE_LIMIT;
  return Math.min(AUTH_BACKOFF_BASE_MS * 2 ** Math.max(0, over), AUTH_BACKOFF_MAX_MS);
}

function pruneAuthStates(now: number): void {
  for (const [ip, state] of authStates) {
    if (state.lastSeen < now - AUTH_STATE_TTL_MS) {
      authStates.delete(ip);
    }
  }
  // Oldest-first eviction so the map cannot grow without bound.
  while (authStates.size > AUTH_STATE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestSeen = Infinity;
    for (const [ip, state] of authStates) {
      if (state.lastSeen < oldestSeen) {
        oldestSeen = state.lastSeen;
        oldestKey = ip;
      }
    }
    if (oldestKey === null) break;
    authStates.delete(oldestKey);
  }
}

/** Extract `user:pass` from an HTTP Basic header, or null when absent/invalid. */
function readBasicCredentials(request: Request): { username: string; password: string } | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) {
    return null;
  }

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

/**
 * Clear the per-IP failure counters.
 *
 * Exported for tests only: the state is module-level, so without this a suite
 * that makes several deliberate bad-password attempts shares one counter across
 * cases and later ones see a lockout that has nothing to do with them.
 */
export function resetAuthFailuresForTests(): void {
  authStates.clear();
  mutationWindows.clear();
}

export interface AuthDecision {
  ok: boolean;
  /** 401 or 429. */
  status: number;
  /** Set only on success; used for the mutation audit trail. */
  username: string;
  retryAfterSeconds: number;
}

/**
 * HTTP Basic auth plus a per-IP failure counter.
 *
 * `safeEqual` is not constant-time (see its comment), the same single
 * credential guards full verbatim transcripts and long-term memory, and the
 * check was previously unthrottled — so a wrong password could be retried
 * forever at line speed. Failures are counted per source address: the first
 * {@link AUTH_FAILURE_LIMIT} are answered with a plain 401, and from the
 * threshold on the caller is locked out for an exponentially growing window
 * until a correct password arrives, which resets the counter.
 *
 * The response body and status never reveal whether the *username* was the
 * wrong part, so the endpoint cannot be used to enumerate accounts.
 */
function checkAuthorization(request: Request, clientIp: string): AuthDecision {
  const now = Date.now();
  const existing = authStates.get(clientIp);

  if (existing && existing.blockedUntil > now) {
    return {
      ok: false,
      status: 429,
      username: '',
      retryAfterSeconds: Math.max(1, Math.ceil((existing.blockedUntil - now) / 1000)),
    };
  }

  const credentials = readBasicCredentials(request);
  const expectedPassword = config.dashboard.password;
  const ok =
    credentials !== null &&
    safeEqual(credentials.username, config.dashboard.username) &&
    safeEqual(credentials.password, expectedPassword);

  if (ok) {
    authStates.delete(clientIp);
    return { ok: true, status: 200, username: credentials.username, retryAfterSeconds: 0 };
  }

  const failures = (existing?.failures ?? 0) + 1;
  const blockedUntil = failures >= AUTH_FAILURE_LIMIT ? now + authBackoffMs(failures) : 0;
  authStates.set(clientIp, { failures, blockedUntil, lastSeen: now });
  pruneAuthStates(now);

  if (blockedUntil > 0) {
    return {
      ok: false,
      status: 429,
      username: '',
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
    };
  }

  return { ok: false, status: 401, username: '', retryAfterSeconds: 0 };
}

/**
 * Deliberately identical for a wrong username, a wrong password and a missing
 * header: any difference would let a caller enumerate the account name.
 */
function unauthorizedResponse(retryAfterSeconds = 0): Response {
  const headers: Record<string, string> = {
    'WWW-Authenticate': 'Basic realm="LumiaBot Dashboard", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (retryAfterSeconds > 0) {
    headers['Retry-After'] = String(retryAfterSeconds);
  }
  return new Response('Authentication required', { status: retryAfterSeconds > 0 ? 429 : 401, headers });
}

// ---- Mutation rate limiting ------------------------------------------------

/** Writes allowed per IP per window. Generous for an operator, hostile to a loop. */
const MUTATION_LIMIT = 60;

/** Sliding window for {@link MUTATION_LIMIT}. */
const MUTATION_WINDOW_MS = 60_000;

const mutationWindows = new Map<string, number[]>();

function isMutationRateLimited(clientIp: string): number {
  const now = Date.now();
  const recent = (mutationWindows.get(clientIp) ?? []).filter((at) => now - at < MUTATION_WINDOW_MS);

  if (recent.length >= MUTATION_LIMIT) {
    mutationWindows.set(clientIp, recent);
    return Math.max(1, Math.ceil((recent[0]! + MUTATION_WINDOW_MS - now) / 1000));
  }

  recent.push(now);
  mutationWindows.set(clientIp, recent);
  return 0;
}

/**
 * Every state change is logged with the authenticated user and source address.
 *
 * On Android under Termux every app on the device can reach `127.0.0.1`, so
 * loopback is not a trust boundary and something else on the phone could be
 * holding valid credentials. The audit line is what makes "who rewrote the
 * persona / switched the model / injected a memory" answerable after the fact.
 */
function auditMutation(username: string, clientIp: string, method: string, path: string): void {
  console.log(`🔐 [DASHBOARD] user=${username} ip=${clientIp} ${method} ${path}`);
}

/**
 * Log the full error server-side, return a short generic message plus a
 * correlation id. Raw SQLite constraint text and absolute filesystem paths
 * used to be handed straight to the client.
 */
function internalFailure(context: string, error: unknown, status: number): Response {
  const correlationId = crypto.randomUUID().slice(0, 8);
  console.error(`❌ [DASHBOARD] ${context} (ref ${correlationId}):`, error);
  return json({ error: 'The dashboard could not complete that request', ref: correlationId }, status);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The complete set of prompt files the bot actually reads at runtime, and the
 * only paths the dashboard will ever write to.
 *
 * This is an allow-list, not a discovery result: a request can never supply an
 * arbitrary path, so the persona editor cannot be walked out of `prompt_storage`
 * with `../` or used to overwrite anything else in the repo. Files found on
 * disk that are not in this list are listed read-only, because no getter loads
 * them and editing them would have no effect.
 */
const PROMPT_FILES: Array<{ path: string; label: string; kind: 'text' | 'json'; hint: string }> = [
  { path: 'persona/identity.txt', label: 'Identity', kind: 'text', hint: 'The main persona. Replaces the system prompt.' },
  { path: 'persona/reinforcement.txt', label: 'Reinforcement', kind: 'text', hint: 'Appended to keep the persona on track.' },
  { path: 'persona/sfw_guidelines.txt', label: 'Safe-for-work guidelines', kind: 'text', hint: 'Guidance for SFW replies.' },
  { path: 'persona/nsfw_guidelines.txt', label: 'Adult guidelines', kind: 'text', hint: 'Guidance for adult replies.' },
  { path: 'persona/boredom_pings.json', label: 'Boredom pings', kind: 'json', hint: 'Random idle messages.' },
  { path: 'persona/error_templates.json', label: 'Error templates', kind: 'json', hint: 'Canned messages keyed by error type.' },
  { path: 'persona/command_responses.json', label: 'Command responses', kind: 'json', hint: 'Replies keyed by command name.' },
  { path: 'instructions/video_reaction.txt', label: 'Video reaction', kind: 'text', hint: 'How to react to a video.' },
  { path: 'instructions/gif_reaction.txt', label: 'GIF reaction', kind: 'text', hint: 'How to react to a GIF.' },
  { path: 'instructions/boredom_updates.txt', label: 'Boredom updates', kind: 'text', hint: 'Opt-in and opt-out idle replies.' },
  { path: 'instructions/music_taste.txt', label: 'Music taste', kind: 'text', hint: 'Template for describing music taste.' },
  { path: 'instructions/memory_system.txt', label: 'Memory system', kind: 'text', hint: 'How memories are formed and phrased.' },
  { path: 'instructions/reply_context.json', label: 'Reply context', kind: 'json', hint: 'Templates for replying to others.' },
  { path: 'config/triggers.json', label: 'Triggers', kind: 'json', hint: 'Keywords that make the bot reply.' },
  { path: 'config/tool_descriptions.json', label: 'Tool descriptions', kind: 'json', hint: 'How tools describe themselves.' },
  { path: 'config/image_prompt_pos.txt', label: 'Image prompt (positive)', kind: 'text', hint: 'Base prompt for image generation.' },
  { path: 'config/image_prompt_neg.txt', label: 'Image prompt (negative)', kind: 'text', hint: 'Terms excluded from images.' },
  { path: 'config/swarm_cfg.json', label: 'Image generation config', kind: 'json', hint: 'Backend, steps, sampler.' },
];

const PROMPT_FILE_MAP = new Map(PROMPT_FILES.map((f) => [f.path, f]));

/** Recursively list files under a directory, relative to it. Never throws. */
async function listFilesRecursive(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFilesRecursive(full, base, out);
    } else if (entry.isFile()) {
      out.push(full.slice(base.length + 1).split('\\').join('/'));
    }
  }
  return out;
}

function buildStatusPayload() {
  const discordUser = bot.client.user;
  const orchestrator = bot.getOrchestratorStatus();

  return {
    bot: {
      name: config.bot.name,
      id: discordUser?.id ?? null,
      tag: discordUser?.tag ?? null,
      ready: bot.client.isReady(),
      guilds: bot.client.guilds.cache.size,
      channels: bot.client.channels.cache.size,
    },
    orchestrator: orchestrator
      ? { enabled: true, ...orchestrator }
      : { enabled: false, isConnected: false },
    rateLimit: {
      seconds: rateLimiterService.getLimitSeconds(),
      maxRequests: 1,
      emoji: config.rateLimit.emoji,
      exemptRoles: rateLimiterService.getExemptRoles(),
      ownerExempt: true,
    },
    ai: {
      model: modelSelectorService.getActiveModel(),
      modelSource: modelSelectorService.getState().source,
      baseUrl: config.openai.baseUrl || null,
      geminiNative: config.gemini.enabled,
      visionSecondary: config.vision.enabled,
    },
    knowledge: {
      sourceMode: config.knowledge.sourceMode,
    },
    log: dashboardLoggerService.getSummary(),
    uptimeSeconds: dashboardLoggerService.getUptimeSeconds(),
    serverTime: new Date().toISOString(),
  };
}

function buildGuildsPayload() {
  return Array.from(bot.client.guilds.cache.values()).map((guild) => ({
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount,
    channels: guild.channels.cache.size,
  }));
}

// ---- Knowledge ------------------------------------------------------------

/** Document shape sent to the UI, with the DB's null `url` normalised away. */
function serialiseDocument(doc: ReturnType<typeof knowledgeGraphService.getDocument>) {
  if (!doc) return null;
  return {
    id: doc.id,
    topic: doc.topic,
    title: doc.title,
    content: doc.content,
    keywords: doc.keywords ?? [],
    type: doc.type,
    url: doc.url ?? null,
    priority: doc.priority,
    usageCount: doc.usageCount,
    lastAccessed: doc.lastAccessed ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const VALID_DOC_TYPES = new Set(['document', 'link', 'snippet']);

function buildKnowledgePayload(limitParam: string | null) {
  const limit = Math.max(1, Math.min(Number.parseInt(limitParam ?? '50', 10) || 50, 500));
  const stats = knowledgeGraphService.getStats();
  return {
    stats: {
      totalDocuments: stats.totalDocuments,
      totalTopics: stats.totalTopics,
      mostUsed: stats.mostUsed.map((doc) => ({
        id: doc.id,
        title: doc.title,
        topic: doc.topic,
        usageCount: doc.usageCount,
      })),
    },
    topics: knowledgeGraphService.getTopicStats().sort((a, b) => b.count - a.count),
    documents: knowledgeGraphService.getAllDocuments(limit).map((doc) => serialiseDocument(doc)),
    directory: KNOWLEDGE_DIR_LABEL,
  };
}

/** Collects and validates a document body shared by create and update. */
function readDocumentInput(body: Record<string, unknown>, existing?: ReturnType<typeof knowledgeGraphService.getDocument>) {
  const errors: string[] = [];
  const patch: Record<string, unknown> = {};

  const title = asString(body.title);
  const topic = asString(body.topic);
  const content = body.content === undefined ? undefined : asString(body.content);
  const type = asString(body.type);
  const url = body.url === null ? null : asString(body.url);
  const priority = typeof body.priority === 'number' ? body.priority : Number.parseInt(String(body.priority), 10);
  const keywords = asStringArray(body.keywords);

  if (title !== undefined) {
    if (!title.trim()) errors.push('"title" cannot be empty');
    else patch.title = title.trim();
  }
  if (topic !== undefined) {
    if (!topic.trim()) errors.push('"topic" cannot be empty');
    else patch.topic = topic.trim();
  }
  if (content !== undefined) patch.content = content;
  if (type !== undefined) {
    if (!VALID_DOC_TYPES.has(type)) errors.push(`"type" must be one of: ${[...VALID_DOC_TYPES].join(', ')}`);
    else patch.type = type;
  }
  if (url !== undefined) patch.url = url && url.trim() ? url.trim() : null;
  if (body.priority !== undefined) {
    if (!Number.isFinite(priority) || priority < 1 || priority > 10) errors.push('"priority" must be a number from 1 to 10');
    else patch.priority = Math.round(priority);
  }
  if (keywords !== undefined) patch.keywords = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);

  // A link with no URL cannot be opened, and a snippet with a URL is a document.
  const nextType = (patch.type as string | undefined) ?? existing?.type;
  const nextUrl = 'url' in patch ? (patch.url as string | null) : (existing?.url ?? null);
  if (nextType === 'link' && !nextUrl) errors.push('A link needs a "url"');

  return { errors, patch };
}

// ---- Conversations --------------------------------------------------------

type ConversationRow = {
  userId: string;
  guildId: string;
  username: string;
  messageCount: number;
  lastActivity: string;
};

/**
 * `listActiveConversations()` used to have no LIMIT, so an established bot
 * materialised thousands of rows and this handler then threw all but `limit`
 * of them away. The service now caps the query itself and reports the true
 * total, so the UI can say "showing 100 of 4212" rather than silently
 * truncating.
 *
 * The `slice` is still applied here because the service clamps to whatever it
 * is given while this handler clamps to the dashboard's own 500-row ceiling:
 * the tighter of the two is the one that should win, and taking `min` of both
 * is what this already does via `slice`.
 */
function buildConversationList(limitParam: string | null) {
  const limit = Math.max(1, Math.min(Number.parseInt(limitParam ?? '100', 10) || 100, 500));

  const result = conversationHistoryService.listActiveConversations(limit);
  const rows = result.conversations;

  return { total: result.total ?? rows.length, conversations: rows.slice(0, limit) };
}

// ---- Prompt profiles ------------------------------------------------------

/**
 * The one payload both prompt-profile routes return.
 *
 * `byModel` is the raw binding table so the UI can show which profile the model
 * in use is bound to, and `currentModel` alongside it so that label needs no
 * second request. `changedAt` is included because the persona and overview views
 * render it the same way the model card renders its own.
 */
function buildPromptProfilePayload() {
  const state = promptSelectorService.getState();
  return {
    available: state.available,
    selectable: promptSelectorService.selectableProfiles(),
    active: state.active,
    override: state.override,
    byModel: state.byModel,
    currentModel: promptSelectorService.getCurrentModel(),
    changedAt: state.changedAt,
  };
}

// ---- Persona --------------------------------------------------------------

/**
 * Root of the profile currently in effect, or `null` when that is `default`.
 *
 * `getPromptProfileRoot` throws for an id with no folder on disk. That is the
 * right behaviour for the prompt loader (a typo must not silently read the
 * wrong tree) but wrong for the dashboard, which must still render: a 500 on
 * the persona list over a mistyped `PROMPT_PROFILES` entry would take the
 * editor down entirely rather than showing the operator the one thing they need
 * to fix. So this answers `null` and every caller falls back to the default root,
 * which is exactly what `prompts.ts` does with the same missing folder.
 */
function activeProfileRoot(): string | null {
  try {
    if (getActivePromptProfileId() === DEFAULT_PROMPT_PROFILE_ID) return null;
    return getPromptProfileRoot(getActivePromptProfileId());
  } catch (error) {
    console.warn('📊 [DASHBOARD] Active prompt profile has no folder; showing the default tree:', error);
    return null;
  }
}

/**
 * Where a persona **read** resolves to: the profile's copy of the file, or the
 * default root's when the profile does not ship one.
 *
 * This is `resolvePromptPath` verbatim, guarded only so a broken profile id
 * degrades to the default tree instead of failing the request.
 */
function promptReadPath(filePath: string): string {
  try {
    return resolvePromptPath(filePath);
  } catch (error) {
    console.warn(`📊 [DASHBOARD] Could not resolve ${filePath} against the active profile:`, error);
    return join(PROMPT_STORAGE_DIR, filePath);
  }
}

/**
 * Where a persona **write** must land: always inside the active profile.
 *
 * WHY THIS IS NOT `resolvePromptPath`
 * -----------------------------------
 * `resolvePromptPath` is a read resolver. It answers the *default* root's path
 * whenever the profile does not already have its own copy of the file, because
 * at read time that is the file whose bytes the bot will use. Used for a write
 * that rule is actively harmful: the operator has a non-default profile
 * selected, opens a file the profile inherits from `default`, edits it and saves
 * — and the edit lands in `prompt_storage/`, changing the shared default for
 * every profile at once, with no override ever created and no sign in the UI.
 *
 * So writes resolve against the profile root unconditionally, which turns that
 * edit into an explicit override the persona list can show. The relative path
 * comes from {@link PROMPT_FILE_MAP}, which is checked by the caller before any
 * path is built — that allow-list is the traversal guard, and joining a known
 * literal onto the profile root cannot escape it.
 */
function promptWritePath(filePath: string): string {
  const root = activeProfileRoot();
  return root === null ? join(PROMPT_STORAGE_DIR, filePath) : join(root, filePath);
}

/** Every file in the profile overlay, or nothing when `default` is active. */
async function listProfileFiles(root: string): Promise<string[]> {
  return listFilesRecursive(root);
}

async function buildPersonaPayload() {
  const activeProfile = getActivePromptProfileId();
  const profileRoot = activeProfileRoot();

  // The overlay tree is described by the profile that owns it, not as a pile of
  // loose `profiles/<id>/…` rows. Those raw entries would be listed as paths the
  // bot never loads (every load goes through the profile root) and would
  // duplicate every row the active profile already contributes below.
  const onDisk = (await listFilesRecursive(PROMPT_STORAGE_DIR)).filter(
    (path) => !path.startsWith('profiles/'),
  );
  const profileFiles = profileRoot === null ? [] : await listProfileFiles(profileRoot);

  const known = new Set(PROMPT_FILES.map((f) => f.path));
  const editable = new Set(known);

  const files = await Promise.all(
    PROMPT_FILES.map(async (meta) => {
      const full = promptReadPath(meta.path);
      let size: number | null = null;
      let exists = false;
      try {
        const info = await stat(full);
        exists = info.isFile();
        size = info.size;
      } catch {
        exists = false;
      }
      return {
        path: meta.path,
        label: meta.label,
        kind: meta.kind,
        hint: meta.hint,
        exists,
        bytes: size,
        editable: editable.has(meta.path),
        // The whole point of a profile: does this profile ship its own copy, or
        // is it inheriting the default root's? One `existsSync` inside
        // `resolvePromptPath` already made this decision, so it is a comparison.
        overridden: full !== join(PROMPT_STORAGE_DIR, meta.path),
      };
    })
  );

  // Anything on disk the bot does not read: listed so it is visible, never editable.
  const unlisted = onDisk
    .filter((path) => !known.has(path))
    .map((path) => ({ path, label: path.split('/').pop() || path, kind: path.endsWith('.json') ? ('json' as const) : ('text' as const), hint: 'Not read by the bot, so editing it has no effect.', exists: true, bytes: null, editable: false, overridden: false }));

  // Files the active profile ships that the default root does not have. Without
  // these the list would be a union of default only, and a profile that adds a
  // prompt would be invisible in the one view that is meant to explain it.
  const overlayOnly = profileFiles
    .filter((path) => !known.has(path))
    .map((path) => ({ path, label: path.split('/').pop() || path, kind: path.endsWith('.json') ? ('json' as const) : ('text' as const), hint: `Only in profile "${activeProfile}".`, exists: true, bytes: null, editable: false, overridden: true }));

  return {
    directory: 'prompt_storage',
    // Which profile the read/write paths below are resolving against. The UI
    // needs this to tell the operator where a save will land.
    profile: profileRoot === null ? DEFAULT_PROMPT_PROFILE_ID : activeProfile,
    files: [...files, ...unlisted, ...overlayOnly].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export interface DashboardServer {
  stop: (closeActiveConnections?: boolean) => void;
  url: string;
}

/**
 * One nonce per process boot, substituted into the served HTML.
 *
 * The UI is a single file with an inline `<script>`, and `script-src
 * 'unsafe-inline'` would hand any injected markup the same privileges as the
 * real script — which throws away the escaping discipline `esc()` maintains on
 * all 33 `innerHTML` sites. A nonce keeps the inline script legal while making
 * injected markup unrunnable, because an attacker cannot guess this value.
 */
const CSP_NONCE = crypto.randomUUID().replace(/-/g, '');

const CSP_HEADER = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'nonce-${CSP_NONCE}'`,
  "connect-src 'self'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Best-effort peer address, used to bucket brute-force attempts, throttle
 * mutations and attribute an audit line.
 *
 * `server.requestIP()` is the only trustworthy source here: the usual
 * `X-Forwarded-For` fallback is a request header, so a caller can put any
 * address they like in it and evade every per-IP limit. When it is unavailable
 * (some transports, or a test harness calling the handler directly) every
 * request lands in one shared bucket, which is stricter, not looser.
 */
function clientAddress(server: DashboardServerLike | undefined, request: Request): string {
  const address = server?.requestIP?.(request)?.address;
  return typeof address === 'string' && address.length > 0 ? address : 'unknown';
}

interface DashboardServerLike {
  requestIP?: (request: Request) => { address: string } | null;
}

export function startDashboardServer(): DashboardServer | null {
  const { enabled, host, port, password } = config.dashboard;

  if (!enabled) {
    console.log('📊 [DASHBOARD] Disabled via DASHBOARD_ENABLED=false');
    return null;
  }

  // A dashboard with no password is an open door, and loopback is not a
  // boundary here: this bot runs under Termux on Android, where every app on
  // the device can open a socket to 127.0.0.1. So "loopback only" never meant
  // "only the operator", and there is no safe default to fall back to. Refuse
  // to start, loudly, and let the bot carry on running normally.
  if (!password) {
    console.error(
      '❌❌❌ [DASHBOARD] REFUSING TO START — DASHBOARD_PASSWORD is not set ❌❌❌\n' +
        '   The dashboard exposes full Discord transcripts, the system prompt and long-term\n' +
        '   memory, and can rewrite the persona on disk. It will not run unauthenticated,\n' +
        '   not even on loopback: on Android any app on the device can reach 127.0.0.1.\n' +
        '   To enable it, set DASHBOARD_PASSWORD in your .env file to a long random string\n' +
        '   and restart the bot. The bot itself is unaffected and keeps running.\n' +
        '   (To disable the dashboard entirely, set DASHBOARD_ENABLED=false instead.)'
    );
    return null;
  }

  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const allowedHosts = buildHostAllowlist(host, port);

  const handler = {
    // Bun passes the live server as the second argument, which is the only
    // trustworthy source of the peer address.
    async fetch(request: Request, server?: DashboardServerLike): Promise<Response> {
      const clientIp = clientAddress(server, request);

      // Host allowlist first, ahead of auth: under a full DNS rebinding attack
      // the browser is genuinely same-origin with `evil.com`, so it would sail
      // past every origin check with valid-looking headers. Refusing a Host we
      // were never bound to serve closes the whole class, read and write alike.
      const requestHost = request.headers.get('Host');
      if (!isAllowedHost(requestHost, allowedHosts)) {
        console.warn(
          `🚨 [DASHBOARD] Rejected request with unexpected Host "${requestHost ?? '(none)'}" from ${clientIp}. ` +
            `Expected one of: ${[...allowedHosts].filter((h) => h.includes(':')).slice(0, 12).join(', ')}`
        );
        return fail('This dashboard only answers to its configured address', 421);
      }

      const auth = checkAuthorization(request, clientIp);
      if (!auth.ok) {
        return unauthorizedResponse(auth.retryAfterSeconds);
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method.toUpperCase();

      // Basic auth does not stop a cross-origin POST, and several endpoints
      // are state-changing, so reject those before any of them is reachable.
      if (isCrossSiteMutation(request, method)) {
        return fail('Cross-site request rejected', 403);
      }

      if (MUTATING_METHODS.has(method)) {
        const retryAfter = isMutationRateLimited(clientIp);
        if (retryAfter > 0) {
          return fail('Too many changes in a short time. Wait a moment and retry.', 429);
        }
        auditMutation(auth.username, clientIp, method, path);
      }

      // ---- UI ----------------------------------------------------------
      if (path === '/' || path === '/index.html') {
        try {
          const html = (await loadUi()).replace(/__CSP_NONCE__/g, CSP_NONCE);
          return new Response(html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'DENY',
              'Referrer-Policy': 'no-referrer',
              'Content-Security-Policy': CSP_HEADER,
            },
          });
        } catch (error) {
          console.error('❌ [DASHBOARD] Failed to load UI:', error);
          return new Response('Dashboard UI failed to load', { status: 500 });
        }
      }

      // ---- Status ------------------------------------------------------
      if (path === '/api/status' && method === 'GET') {
        return json(buildStatusPayload());
      }

      if (path === '/api/guilds' && method === 'GET') {
        return json({ guilds: buildGuildsPayload() });
      }

      // ---- Model switching ---------------------------------------------
      if (path === '/api/models' && method === 'GET') {
        return json({ model: modelSelectorService.getState() });
      }

      if (path === '/api/models' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body) return fail('Expected a JSON body', 400);
        const model = asString(body.model);
        if (model === undefined) return fail('Missing "model"', 400);

        try {
          return json({ ok: true, model: modelSelectorService.setModel(model) });
        } catch (error) {
          // setModel only ever throws its own allow-list validation messages,
          // which are what the operator needs to see and carry no internals, so
          // the text is returned as-is — but it is logged too, so a future
          // failure mode that does leak cannot reach the client silently.
          console.warn(`📊 [DASHBOARD] Rejected model "${model}":`, error);
          return fail(error instanceof Error ? error.message : String(error), 400);
        }
      }

      if (path === '/api/models/reset' && method === 'POST') {
        return json({ ok: true, model: modelSelectorService.reset() });
      }

      // ---- Prompt profiles --------------------------------------------------
      // `active` is the *effective* profile — override ?? the current model's
      // binding ?? `default` — resolved by the service, so the UI never has to
      // reimplement that precedence. `selectable` is deliberately the
      // whitelist *plus* `default`: `available` is legitimately empty when
      // PROMPT_PROFILES is unset, and a picker with no "Default" row in it is a
      // bug rather than an off switch.
      //
      // No changes are needed on the two model routes above: `model-selector.ts`
      // calls `promptSelectorService.onModelChanged()` itself on a successful
      // switch and on a reset, which is what clears the override.
      if (path === '/api/prompt-profiles' && method === 'GET') {
        return json(buildPromptProfilePayload());
      }

      if (path === '/api/prompt-profiles/override' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body) return fail('Expected a JSON body', 400);
        if (!('profile' in body)) return fail('Missing "profile" (use null to clear the override)', 400);

        const requested = body.profile;
        // Explicit null clears; anything that is not null must be a string, so a
        // client sending `{"profile": {}}` gets told so instead of it being
        // coerced into the id "[object Object]" and rejected with a confusing
        // allow-list message.
        if (requested !== null && asString(requested) === undefined) {
          return fail('"profile" must be a string or null', 400);
        }

        try {
          promptSelectorService.setOverride(requested as string | null);
        } catch (error) {
          // setOverride only throws its own allow-list validation messages, which
          // are what the operator needs and carry no internals — returned as-is,
          // logged so a future failure mode that does leak cannot pass silently.
          console.warn(`📊 [DASHBOARD] Rejected prompt profile override "${String(requested)}":`, error);
          return fail(error instanceof Error ? error.message : String(error), 400);
        }

        return json({ ok: true, ...buildPromptProfilePayload() });
      }

      // ---- LLM usage ---------------------------------------------------
      if (path === '/api/usage' && method === 'GET') {
        return json({
          stats: apiUsageService.getStats(),
          recent: apiUsageService.getRecentCalls(40),
        });
      }

      if (path === '/api/usage/reset' && method === 'POST') {
        const removed = apiUsageService.clear();
        return json({ ok: true, removed });
      }

      // ---- Activity log ------------------------------------------------
      if (path === '/api/log' && method === 'GET') {
        const sourceParam = url.searchParams.get('source');
        const source = VALID_SOURCES.includes(sourceParam as InteractionSource)
          ? (sourceParam as InteractionSource)
          : undefined;

        const sinceParam = url.searchParams.get('since');
        const since = sinceParam ? Number.parseInt(sinceParam, 10) : undefined;

        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

        const entries = dashboardLoggerService.list({
          limit: Number.isFinite(limit) ? limit : undefined,
          q: url.searchParams.get('q') ?? undefined,
          userId: url.searchParams.get('userId') ?? undefined,
          guildId: url.searchParams.get('guildId') ?? undefined,
          source,
          sinceEpochMs: Number.isFinite(since) ? since : undefined,
        });

        // Entries carry a key, not the text: distinct prompts are resolved once
        // and sent as a map so a stable persona does not repeat per entry.
        return json({
          entries,
          fullPrompts: dashboardLoggerService.getFullPrompts(entries),
          summary: dashboardLoggerService.getSummary(),
        });
      }

      // ---- Log summary ---------------------------------------------------
      // What the overview polls. `/api/log` serialises up to `limit` entries
      // plus the full multi-kilobyte system prompt behind each one, which on a
      // phone is the single most expensive thing the dashboard does; the
      // overview only needs counters, an hourly profile and the newest prompt.
      // Everything here is derived from the in-memory ring buffer, so this is a
      // projection rather than a second pass over the same data.
      if (path === '/api/log/summary' && method === 'GET') {
        const windowHours = Math.max(
          6,
          Math.min(24, config.dashboard.logWindowHours || 12)
        );
        const now = Date.now();
        const bucketMs = 3_600_000;

        const buckets: Array<{ startMs: number; count: number; errors: number }> = [];
        for (let i = windowHours - 1; i >= 0; i--) {
          buckets.push({ startMs: now - i * bucketMs, count: 0, errors: 0 });
        }
        const base = buckets[0]?.startMs ?? now;

        // Fields are projected to the handful the strip and the "most recent"
        // block need; `response` and the full-prompt payloads are dropped here.
        let latest: { timestamp: string; username: string | null; userId: string | null; source: string; prompt: string } | null =
          null;

        // The whole in-memory ring buffer, not the default page of 100: the
        // hourly profile has to account for every activation in the window or
        // the strip under-reports on a busy bot.
        for (const entry of dashboardLoggerService.list({ limit: config.dashboard.logMaxEntries })) {
          let index = Math.floor((entry.epochMs - base) / bucketMs);
          if (index < 0) index = 0;
          if (index > buckets.length - 1) index = buckets.length - 1;
          const bucket = buckets[index];
          if (bucket) {
            bucket.count++;
            if (entry.error) bucket.errors++;
          }
          if (!latest) {
            latest = {
              timestamp: entry.timestamp,
              username: entry.username ?? null,
              userId: entry.userId ?? null,
              source: entry.source,
              prompt: entry.prompt,
            };
          }
        }

        return json({
          summary: dashboardLoggerService.getSummary(),
          timeline: buckets,
          latest,
        });
      }

      if (path === '/api/log' && method === 'DELETE') {
        const cleared = dashboardLoggerService.clear();
        return json({ ok: true, cleared });
      }

      // ---- Log analytics ---------------------------------------------------
      // Percentiles, hour-of-day profile and full leaderboards. Kept off
      // /api/log because this is markedly heavier than the summary the
      // overview polls.
      if (path === '/api/log/analytics' && method === 'GET') {
        return json(dashboardLoggerService.getAnalytics());
      }

      // ---- Knowledge -------------------------------------------------------
      // Order matters: /api/knowledge/sync and the bare path must be matched
      // before /api/knowledge/:id.
      if (path === '/api/knowledge' && method === 'GET') {
        return json(buildKnowledgePayload(url.searchParams.get('limit')));
      }

      if (path === '/api/knowledge' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body) return fail('Expected a JSON body', 400);

        const { errors, patch } = readDocumentInput(body);
        if (errors.length) return fail(errors.join('; '), 400);

        try {
          knowledgeGraphService.storeDocument(patch as never);
        } catch (error) {
          // SQLite constraint text names tables and columns; it does not belong
          // in a response body.
          return internalFailure('Storing a knowledge document failed', error, 400);
        }
        return json({ ok: true, documents: knowledgeGraphService.getAllDocuments(1) });
      }

      if (path === '/api/knowledge/sync' && method === 'POST') {
        try {
          await knowledgeGraphService.syncFromFiles(KNOWLEDGE_DOCUMENTS_DIR);
        } catch (error) {
          // The message here embeds an absolute filesystem path.
          return internalFailure('Knowledge file sync failed', error, 500);
        }
        return json(buildKnowledgePayload('50'));
      }

      if (path === '/api/knowledge/search' && method === 'GET') {
        const query = url.searchParams.get('q')?.trim() ?? '';
        if (!query) return fail('Missing "q"', 400);

        const topic = url.searchParams.get('topic');
        const results = knowledgeGraphService
          .searchByKeywords({
            query,
            topics: topic ? [topic] : undefined,
            maxResults: Math.max(1, Math.min(Number.parseInt(url.searchParams.get('limit') ?? '25', 10) || 25, 200)),
          })
          .map((hit) => ({
            ...serialiseDocument(hit.document)!,
            relevanceScore: Math.round(hit.relevanceScore * 100) / 100,
            matchedKeywords: hit.matchedKeywords,
          }));

        return json({ query, results });
      }

      const knowledgeDocMatch = path.match(/^\/api\/knowledge\/(\d+)$/);
      if (knowledgeDocMatch) {
        const id = Number.parseInt(knowledgeDocMatch[1]!, 10);

        if (method === 'GET') {
          const doc = serialiseDocument(knowledgeGraphService.getDocument(id));
          if (!doc) return fail(`No document with id ${id}`, 404);
          return json({ document: doc });
        }

        if (method === 'PUT') {
          const body = await readJsonBody(request);
          if (!body) return fail('Expected a JSON body', 400);

          const existing = knowledgeGraphService.getDocument(id);
          if (!existing) return fail(`No document with id ${id}`, 404);

          const { errors, patch } = readDocumentInput(body, existing);
          if (errors.length) return fail(errors.join('; '), 400);

          try {
            knowledgeGraphService.updateDocument(id, patch as never);
          } catch (error) {
            return internalFailure(`Updating knowledge document ${id} failed`, error, 400);
          }
          return json({ ok: true, document: serialiseDocument(knowledgeGraphService.getDocument(id)) });
        }

        if (method === 'DELETE') {
          if (!knowledgeGraphService.getDocument(id)) return fail(`No document with id ${id}`, 404);
          knowledgeGraphService.deleteDocument(id);
          return json({ ok: true, deleted: id });
        }

        return fail('Method not allowed', 405);
      }

      // ---- Conversations ---------------------------------------------------
      // Guild scope is part of the path: every read in the service needs an
      // explicit guildId, and a missing one returns empty rather than erroring.
      if (path === '/api/conversations' && method === 'GET') {
        return json(buildConversationList(url.searchParams.get('limit')));
      }

      const conversationMatch = path.match(/^\/api\/conversations\/(\d{5,25})(?:\/([^/]+))?$/);
      if (conversationMatch) {
        const userId = conversationMatch[1]!;
        const guildId = conversationMatch[2] ? decodeURIComponent(conversationMatch[2]) : null;

        if (!guildId) {
          if (method === 'GET') {
            return json({ conversations: conversationHistoryService.listUserConversations(userId) });
          }
          if (method === 'DELETE') {
            const removed = conversationHistoryService.clearAllHistory(userId);
            return json({ ok: true, removed });
          }
          return fail('Method not allowed', 405);
        }

        if (method === 'GET') {
          const conversation = conversationHistoryService.getConversation(userId, guildId);
          if (!conversation) return fail(`No conversation for user ${userId} in ${guildId}`, 404);
          return json({ conversation });
        }

        if (method === 'DELETE') {
          const count = conversationHistoryService.getMessageCount(userId, guildId);
          if (count === 0) return fail(`No conversation for user ${userId} in ${guildId}`, 404);
          conversationHistoryService.clearHistory(userId, guildId);
          return json({ ok: true, removed: count });
        }

        return fail('Method not allowed', 405);
      }

      // ---- Integrations ----------------------------------------------------
      if (path === '/api/integrations' && method === 'GET') {
        // Both probes are timeout-bounded and never reject, so one dead
        // service cannot stall the whole health view.
        const [searxng, navidrome] = await Promise.all([
          searxngService.ping(),
          navidromeService.ping(),
        ]);
        return json({ searxng, navidrome, checkedAt: new Date().toISOString() });
      }

      // ---- Persona ---------------------------------------------------------
      if (path === '/api/persona' && method === 'GET') {
        const requested = url.searchParams.get('path');

        if (!requested) {
          return json(await buildPersonaPayload());
        }

        // Allow-listed first: `requested` is untrusted input and
        // `promptReadPath` joins it onto a directory, so the traversal guard has
        // to run before any path exists.
        if (!PROMPT_FILE_MAP.has(requested)) {
          return fail('That file is not editable', 400);
        }

        // Profile-aware: the profile's copy if it has one, else the default
        // root's. Hardcoding PROMPT_STORAGE_DIR here would show the default
        // bytes for a profile that overrides the file.
        const full = promptReadPath(requested);
        if (!existsSync(full)) {
          return json({ path: requested, kind: PROMPT_FILE_MAP.get(requested)!.kind, content: '', exists: false, profile: getActivePromptProfileId(), overridden: false });
        }
        return json({
          path: requested,
          kind: PROMPT_FILE_MAP.get(requested)!.kind,
          content: await readFile(full, 'utf-8'),
          exists: true,
          // Where this save will land, which is not always where these bytes came
          // from: see promptWritePath.
          profile: getActivePromptProfileId(),
          overridden: full !== join(PROMPT_STORAGE_DIR, requested),
        });
      }

      if (path === '/api/persona' && method === 'PUT') {
        // Bun's default maximum request body is ~128 MB, so reject an oversized
        // body on its declared length before parsing it. Without this a single
        // request can allocate hundreds of megabytes on a phone.
        const declaredLength = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
        if (Number.isFinite(declaredLength) && declaredLength > PERSONA_MAX_BYTES + PERSONA_BODY_SLACK_BYTES) {
          return fail(
            `That file is too large. The limit is ${PERSONA_MAX_BYTES} bytes; ` +
              `this request body is ${declaredLength} bytes.`,
            413
          );
        }

        const body = await readJsonBody(request);
        if (!body) return fail('Expected a JSON body', 400);

        const filePath = asString(body.path);
        const content = asString(body.content);
        if (!filePath) return fail('Missing "path"', 400);
        if (content === undefined) return fail('Missing "content"', 400);

        const meta = PROMPT_FILE_MAP.get(filePath);
        if (!meta) return fail('That file is not editable', 400);

        // Cap the write itself rather than trusting the declared length: a
        // chunked request has no Content-Length, and the limit must hold
        // regardless of how the body arrived.
        const contentBytes = Buffer.byteLength(content, 'utf-8');
        if (contentBytes > PERSONA_MAX_BYTES) {
          return fail(`That file is too large. The limit is ${PERSONA_MAX_BYTES} bytes (got ${contentBytes}).`, 413);
        }

        // An empty system prompt is not a valid state: `loadTextFile` treats a
        // blank file as "no persona" without reporting anything, so the bot
        // would silently lose its instructions on the next reply.
        if (filePath === 'persona/identity.txt' && !content.trim()) {
          return fail('The identity file cannot be empty. Write the persona text first.', 400);
        }

        // Reject unparseable JSON before it reaches disk: a broken triggers.json
        // makes loadJsonFile return null, which silently disables the feature
        // rather than reporting the error.
        if (meta.kind === 'json') {
          try {
            JSON.parse(content);
          } catch (error) {
            // The parser's message describes the operator's own text, not our
            // internals, so it is safe and useful to return.
            return fail(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 400);
          }
        }

        // Profile-aware target. Under a non-default profile this is inside that
        // profile's folder, so an edit to a file the profile inherits creates an
        // override instead of quietly rewriting the shared default.
        const full = promptWritePath(filePath);

        // Optimistic concurrency. The editor sends the content it loaded as
        // `ifMatch`; if the file changed on disk since then — another tab, a
        // hand edit over SSH, or a second operator on the LAN — refuse rather
        // than silently clobbering that edit with a blind overwrite.
        const ifMatch = asString(body.ifMatch);
        if (ifMatch === undefined) {
          return fail('Missing "ifMatch": reload the file and save again', 428);
        }

        // Read the *effective* content, not the file at the write target: the
        // editor was handed `promptReadPath` bytes, so that is the version the
        // 409 check has to compare against. Comparing against the write target
        // instead would make every inherited file answer "not found" here and
        // reject a perfectly good save with a conflict the operator cannot act
        // on. It is also the correct scope for the check — two operators editing
        // the same file under *different* profiles are editing different files.
        const currentFull = promptReadPath(filePath);
        let current = '';
        if (existsSync(currentFull)) {
          try {
            current = await readFile(currentFull, 'utf-8');
          } catch (error) {
            return internalFailure(`Reading ${filePath} before writing failed`, error, 500);
          }
        }
        if (current !== ifMatch) {
          return fail(
            'This file changed on disk since you opened it. Reload it, re-apply your edit, then save.',
            409
          );
        }

        try {
          await mkdir(join(full, '..'), { recursive: true });
          await writeFile(full, content, 'utf-8');
        } catch (error) {
          // writeFile errors carry the absolute path and the OS errno text.
          return internalFailure(`Writing ${filePath} failed`, error, 500);
        }

        // Same process as the bot (started in-process from src/index.ts), so
        // this drops the in-memory persona and prompt caches. `reloadPrompts()`
        // alone is not enough: the system prompt is served from a separate
        // cached definition that only `reloadBotDefinition()` clears.
        reloadBotDefinition();

        return json({
          ok: true,
          path: filePath,
          bytes: Buffer.byteLength(content, 'utf-8'),
          reloaded: true,
          // Named so the operator can see the save landed in the profile and not
          // in the shared default root.
          profile: getActivePromptProfileId(),
        });
      }

      // ---- Memories ----------------------------------------------------
      if (path === '/api/memories' && method === 'GET') {
        const limitParam = url.searchParams.get('limit');
        return json({
          stats: userMemoryService.getMemoryStats(),
          users: userMemoryService.listMemorySummaries(
            url.searchParams.get('q') ?? undefined,
            limitParam ? Number.parseInt(limitParam, 10) : undefined,
          ),
        });
      }

      // Individual memory rows. Must be matched before /api/memories/:userId.
      const entryMatch = path.match(/^\/api\/memories\/entries\/(\d+)$/);
      if (entryMatch) {
        const entryId = Number.parseInt(entryMatch[1]!, 10);

        if (method === 'PUT') {
          const body = await readJsonBody(request);
          if (!body) return fail('Expected a JSON body', 400);
          const content = asString(body.content);
          if (content === undefined) return fail('Missing "content"', 400);

          try {
            const updated = userMemoryService.updateMemoryEntry(entryId, content);
            if (!updated) return fail(`No memory with id ${entryId}`, 404);
            return json({ ok: true, entry: updated });
          } catch (error) {
            return internalFailure(`Updating memory ${entryId} failed`, error, 400);
          }
        }

        if (method === 'DELETE') {
          const deleted = userMemoryService.deleteMemoryEntry(entryId);
          if (!deleted) return fail(`No memory with id ${entryId}`, 404);
          return json({ ok: true, deleted });
        }

        return fail('Method not allowed', 405);
      }

      const userMemoryMatch = path.match(/^\/api\/memories\/(\d{5,25})$/);
      if (userMemoryMatch) {
        const userId = userMemoryMatch[1]!;

        if (method === 'GET') {
          const detail = userMemoryService.getMemoryDetail(userId);
          if (!detail) return fail(`No stored memory for user ${userId}`, 404);
          return json({ memory: detail });
        }

        if (method === 'DELETE') {
          if (!userMemoryService.hasOpinion(userId)) {
            return fail(`No stored memory for user ${userId}`, 404);
          }
          const removed = userMemoryService.deleteOpinion(userId);
          return json({ ok: true, removed });
        }

        if (method === 'PUT') {
          const body = await readJsonBody(request);
          if (!body) return fail('Expected a JSON body', 400);

          const updates: {
            username?: string;
            pronouns?: string | null;
            sentiment?: UserOpinion['sentiment'];
          } = {};

          const username = asString(body.username);
          if (username !== undefined) updates.username = username;

          if (body.pronouns !== undefined) {
            if (body.pronouns === null) {
              updates.pronouns = null;
            } else {
              const pronouns = asString(body.pronouns);
              if (pronouns === undefined) return fail('"pronouns" must be a string or null', 400);
              updates.pronouns = pronouns;
            }
          }

          if (body.sentiment !== undefined) {
            const sentiment = asString(body.sentiment);
            if (!sentiment || !VALID_SENTIMENTS.includes(sentiment as UserOpinion['sentiment'])) {
              return fail(`"sentiment" must be one of: ${VALID_SENTIMENTS.join(', ')}`, 400);
            }
            updates.sentiment = sentiment as UserOpinion['sentiment'];
          }

          const detail = userMemoryService.updateMemoryProfile(userId, updates);
          if (!detail) return fail(`No stored memory for user ${userId}`, 404);
          return json({ ok: true, memory: detail });
        }

        if (method === 'POST') {
          const body = await readJsonBody(request);
          if (!body) return fail('Expected a JSON body', 400);

          const kind = asString(body.kind);
          if (!kind || !VALID_KINDS.includes(kind as MemoryEntryKind)) {
            return fail(`"kind" must be one of: ${VALID_KINDS.join(', ')}`, 400);
          }

          const content = asString(body.content);
          if (content === undefined || !content.trim()) {
            return fail('Missing or empty "content"', 400);
          }

          try {
            const entry = userMemoryService.addMemoryEntry(
              userId,
              kind as MemoryEntryKind,
              content,
              asString(body.username),
            );
            return json({ ok: true, entry });
          } catch (error) {
            return internalFailure(`Adding a memory for user ${userId} failed`, error, 400);
          }
        }

        return fail('Method not allowed', 405);
      }

      return fail('Not found', 404);
    },

    error(error: Error) {
      console.error('❌ [DASHBOARD] Unhandled request error:', error);
      return json({ error: 'Internal dashboard error' }, 500);
    },
  };

  /**
   * Bind the configured port, stepping forward only when that exact port is
   * already in use.
   *
   * The dashboard is optional observability, so a stale process squatting on
   * the port must never stop the bot from connecting to Discord. But stepping
   * silently is its own hazard: a bookmark for `http://localhost:3001` lands in
   * whatever process *does* own 3001, and that process receives the operator's
   * credentials. Availability is not worth trading for confidentiality without
   * saying so, so the move is announced loudly below.
   *
   * Any other bind failure (bad interface, permission denied, invalid host) is
   * fatal for the dashboard rather than a reason to try a different port —
   * retrying it four more times cannot fix it and only delays the log line.
   */
  let server: ReturnType<typeof Bun.serve> | null = null;
  let lastBindError: unknown = null;
  let movedFrom = 0;

  for (let attempt = 0; attempt < DASHBOARD_PORT_ATTEMPTS && server === null; attempt++) {
    const candidate = port + attempt;
    try {
      server = Bun.serve({
        hostname: host,
        port: candidate,
        fetch: handler.fetch,
        error: handler.error,
      });
      movedFrom = candidate;
    } catch (error) {
      lastBindError = error;
      if (!isAddressInUse(error)) {
        console.error(
          `❌ [DASHBOARD] Could not bind ${host}:${candidate}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `Starting without the dashboard; Discord is unaffected.`
        );
        return null;
      }
      console.warn(
        `⚠️  [DASHBOARD] Another process already owns port ${candidate} (${describeBindError(error)}).`
      );
    }
  }

  if (server === null) {
    console.error(
      `❌ [DASHBOARD] Ports ${port} to ${port + DASHBOARD_PORT_ATTEMPTS - 1} are all in use; ` +
        `starting without the dashboard. Discord is unaffected.`
    );
    void lastBindError;
    return null;
  }

  if (movedFrom !== port) {
    console.warn(
      `⚠️⚠️  [DASHBOARD] THE DASHBOARD HAS MOVED: another process owns port ${port}, ` +
        `so it is now on port ${movedFrom} ⚠️⚠️\n` +
        `   Do NOT use a saved URL or bookmark for port ${port} — it points at that other\n` +
        `   process, which is not this bot and will receive your dashboard sign-in.\n` +
        `   Use port ${movedFrom}, or stop the other process and restart to get ${port} back.`
    );
  }

  const displayHost = isLoopback ? 'localhost' : host;
  console.log(`📊 [DASHBOARD] Listening on http://${displayHost}:${server.port}`);
  console.log(`📊 [DASHBOARD] Open http://${displayHost}:${server.port} in your mobile browser`);
  console.log(`📊 [DASHBOARD] Auth required — user "${config.dashboard.username}", password from DASHBOARD_PASSWORD`);
  if (!isLoopback) {
    console.warn(
      `📊 [DASHBOARD] Bound to ${host}, so this is reachable by anything that can route to this ` +
        `device. Only Host headers for ${[...allowedHosts].filter((h) => h.includes(':')).length} ` +
        `configured address(es) are answered.`
    );
  }
  if (PUBLIC_ORIGIN) {
    console.log(`📊 [DASHBOARD] Also answering on the configured public origin ${PUBLIC_ORIGIN}`);
  }

  return {
    stop: (closeActiveConnections?: boolean) => server.stop(closeActiveConnections),
    url: `http://${displayHost}:${server.port}`,
  };
}
