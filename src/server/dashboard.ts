import { join } from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from '../utils/config';
import { dashboardLoggerService, type InteractionSource } from '../services/dashboard-logger';
import { apiUsageService } from '../services/api-usage';
import { userMemoryService, type MemoryEntryKind, type UserOpinion } from '../services/user-memory';
import { rateLimiterService } from '../services/rate-limiter';
import { modelSelectorService } from '../services/model-selector';
import { knowledgeGraphService } from '../services/knowledge-graph';
import { conversationHistoryService } from '../services/conversation-history';
import { searxngService } from '../services/searxng';
import { navidromeService } from '../services/navidrome';
import { reloadBotDefinition } from '../utils/bot-definition';
import { bot } from '../bot/client';

const UI_PATH = join(import.meta.dir, 'dashboard', 'index.html');
const PROMPT_STORAGE_DIR = join(import.meta.dir, '..', '..', 'prompt_storage');
const KNOWLEDGE_DIR = 'knowledge_documents';

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
 * Whether a state-changing request came from somewhere other than the page's
 * own origin.
 *
 * The dashboard authenticates with HTTP Basic, which does not stop cross-site
 * requests: browsers cache Basic credentials against the *origin*, not the
 * referring page, so they will attach them to a cross-origin request too. And
 * with no password set (the loopback default) auth is a no-op. A plain
 * cross-origin `<form method="POST">` or `fetch` is a CORS "simple request",
 * so it is sent without a preflight — meaning any page the operator visits
 * could silently reset the model or wipe the usage counter.
 *
 * Both checks below are origin-scoped, so they behave the same whether the
 * dashboard is reached over an SSH port-forward (`http://localhost:3001`) or a
 * LAN bind (`http://192.168.x.x:3001`): the request's own `Host` is what the
 * `Origin` is compared against.
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
  // same-origin form/fetch, so allow it rather than break an exotic client.
  if (!origin) {
    return false;
  }
  // 'null' is an opaque origin (sandboxed frame, file://) which by definition
  // cannot be same-origin with an http(s) dashboard.
  if (origin === 'null') {
    return true;
  }

  const host = request.headers.get('Host');
  if (!host) {
    return true;
  }

  const protocol = request.headers.get('X-Forwarded-Proto') || 'http';
  return origin !== `${protocol}://${host}`;
}

/**
 * HTTP Basic auth. Enabled only when DASHBOARD_PASSWORD is set, which is the
 * default-safe state because the server binds to loopback.
 */
function isAuthorized(request: Request): boolean {
  const expectedPassword = config.dashboard.password;
  if (!expectedPassword) {
    return true;
  }

  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) {
    return false;
  }

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) {
    return false;
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  return safeEqual(username, config.dashboard.username) && safeEqual(password, expectedPassword);
}

function unauthorizedResponse(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="LumiaBot Dashboard", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
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
    directory: KNOWLEDGE_DIR,
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

/**
 * `listActiveConversations()` has no LIMIT, so an established bot can return
 * thousands of rows. Cap it here and report the true total so the UI can say
 * "showing 200 of 4212" rather than silently truncating.
 */
function buildConversationList(limitParam: string | null) {
  const limit = Math.max(1, Math.min(Number.parseInt(limitParam ?? '100', 10) || 100, 500));
  const all = conversationHistoryService.listActiveConversations();
  return {
    total: all.length,
    conversations: all.slice(0, limit),
  };
}

// ---- Persona --------------------------------------------------------------

async function buildPersonaPayload() {
  const onDisk = await listFilesRecursive(PROMPT_STORAGE_DIR);
  const known = new Set(PROMPT_FILES.map((f) => f.path));
  const editable = new Set(known);

  const files = await Promise.all(
    PROMPT_FILES.map(async (meta) => {
      const full = join(PROMPT_STORAGE_DIR, meta.path);
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
      };
    })
  );

  // Anything on disk the bot does not read: listed so it is visible, never editable.
  const unlisted = onDisk
    .filter((path) => !known.has(path))
    .map((path) => ({ path, label: path.split('/').pop() || path, kind: path.endsWith('.json') ? ('json' as const) : ('text' as const), hint: 'Not read by the bot, so editing it has no effect.', exists: true, bytes: null, editable: false }));

  return {
    directory: 'prompt_storage',
    files: [...files, ...unlisted].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export interface DashboardServer {
  stop: (closeActiveConnections?: boolean) => void;
  url: string;
}

export function startDashboardServer(): DashboardServer | null {
  const { enabled, host, port, password } = config.dashboard;

  if (!enabled) {
    console.log('📊 [DASHBOARD] Disabled via DASHBOARD_ENABLED=false');
    return null;
  }

  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  // Refuse to expose memory data and full transcripts on an open network
  // without credentials. Loopback stays usable with no password at all.
  if (!isLoopback && !password) {
    console.error(
      `❌ [DASHBOARD] Refusing to start on ${host}: set DASHBOARD_PASSWORD to expose the dashboard beyond localhost. ` +
      `Set DASHBOARD_HOST=127.0.0.1 (the default) to run without a password.`
    );
    return null;
  }

  const handler = {
    async fetch(request: Request): Promise<Response> {
      if (!isAuthorized(request)) {
        return unauthorizedResponse();
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method.toUpperCase();

      // Basic auth does not stop a cross-origin POST, and several endpoints
      // are state-changing, so reject those before any of them is reachable.
      if (isCrossSiteMutation(request, method)) {
        return fail('Cross-site request rejected', 403);
      }

      // ---- UI ----------------------------------------------------------
      if (path === '/' || path === '/index.html') {
        try {
          const html = await loadUi();
          return new Response(html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'DENY',
              'Referrer-Policy': 'no-referrer',
              'Content-Security-Policy':
                "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
          return fail(error instanceof Error ? error.message : String(error), 400);
        }
      }

      if (path === '/api/models/reset' && method === 'POST') {
        return json({ ok: true, model: modelSelectorService.reset() });
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
          return fail(error instanceof Error ? error.message : String(error), 400);
        }
        return json({ ok: true, documents: knowledgeGraphService.getAllDocuments(1) });
      }

      if (path === '/api/knowledge/sync' && method === 'POST') {
        try {
          await knowledgeGraphService.syncFromFiles(KNOWLEDGE_DIR);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), 500);
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
            return fail(error instanceof Error ? error.message : String(error), 400);
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

        if (!PROMPT_FILE_MAP.has(requested)) {
          return fail('That file is not editable', 400);
        }

        const full = join(PROMPT_STORAGE_DIR, requested);
        if (!existsSync(full)) {
          return json({ path: requested, kind: PROMPT_FILE_MAP.get(requested)!.kind, content: '', exists: false });
        }
        return json({
          path: requested,
          kind: PROMPT_FILE_MAP.get(requested)!.kind,
          content: await readFile(full, 'utf-8'),
          exists: true,
        });
      }

      if (path === '/api/persona' && method === 'PUT') {
        const body = await readJsonBody(request);
        if (!body) return fail('Expected a JSON body', 400);

        const filePath = asString(body.path);
        const content = asString(body.content);
        if (!filePath) return fail('Missing "path"', 400);
        if (content === undefined) return fail('Missing "content"', 400);

        const meta = PROMPT_FILE_MAP.get(filePath);
        if (!meta) return fail('That file is not editable', 400);

        // Reject unparseable JSON before it reaches disk: a broken triggers.json
        // makes loadJsonFile return null, which silently disables the feature
        // rather than reporting the error.
        if (meta.kind === 'json') {
          try {
            JSON.parse(content);
          } catch (error) {
            return fail(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 400);
          }
        }

        try {
          const full = join(PROMPT_STORAGE_DIR, filePath);
          await mkdir(join(full, '..'), { recursive: true });
          await writeFile(full, content, 'utf-8');
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), 500);
        }

        // Same process as the bot (started in-process from src/index.ts), so
        // this drops the in-memory persona and prompt caches. `reloadPrompts()`
        // alone is not enough: the system prompt is served from a separate
        // cached definition that only `reloadBotDefinition()` clears.
        reloadBotDefinition();

        return json({ ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf-8'), reloaded: true });
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
            return fail(error instanceof Error ? error.message : String(error), 400);
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
            return fail(error instanceof Error ? error.message : String(error), 400);
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
   * Bind the configured port, stepping forward if it is taken.
   *
   * The dashboard is optional observability, so a stale process squatting on
   * the port must never stop the bot from connecting to Discord. Trying the
   * next few ports keeps it reachable without being fatal; if they are all
   * occupied we log and return null so startup continues without it.
   */
  let server: ReturnType<typeof Bun.serve> | null = null;
  let lastBindError: unknown = null;

  for (let attempt = 0; attempt < DASHBOARD_PORT_ATTEMPTS && server === null; attempt++) {
    const candidate = port + attempt;
    try {
      server = Bun.serve({
        hostname: host,
        port: candidate,
        fetch: handler.fetch,
        error: handler.error,
      });
    } catch (error) {
      lastBindError = error;
      console.warn(
        `📊 [DASHBOARD] Port ${candidate} unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (server === null) {
    console.error(
      `❌ [DASHBOARD] Could not bind any port from ${port} to ${port + DASHBOARD_PORT_ATTEMPTS - 1}; ` +
        `starting without the dashboard. Discord is unaffected.`
    );
    void lastBindError;
    return null;
  }

  const displayHost = isLoopback ? 'localhost' : host;
  console.log(`📊 [DASHBOARD] Listening on http://${displayHost}:${server.port}`);
  console.log(`📊 [DASHBOARD] Open http://${displayHost}:${server.port} in your mobile browser`);
  if (password) {
    console.log(`📊 [DASHBOARD] Auth required — user "${config.dashboard.username}"`);
  } else {
    console.log('📊 [DASHBOARD] No password set (safe: bound to loopback only)');
  }

  return {
    stop: (closeActiveConnections?: boolean) => server.stop(closeActiveConnections),
    url: `http://${displayHost}:${server.port}`,
  };
}
