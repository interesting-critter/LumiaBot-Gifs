import { join } from 'node:path';
import { config } from '../utils/config';
import { dashboardLoggerService, type InteractionSource } from '../services/dashboard-logger';
import { apiUsageService } from '../services/api-usage';
import { userMemoryService, type MemoryEntryKind, type UserOpinion } from '../services/user-memory';
import { rateLimiterService } from '../services/rate-limiter';
import { modelSelectorService } from '../services/model-selector';
import { bot } from '../bot/client';

const UI_PATH = join(import.meta.dir, 'dashboard', 'index.html');

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
 * Length-independent, content-constant comparison so a wrong password cannot be
 * narrowed down by timing. Not strictly necessary for a loopback-only dashboard,
 * but cheap and avoids the usual footgun if someone binds to the LAN.
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

  const server = Bun.serve({
    hostname: host,
    port,

    async fetch(request: Request): Promise<Response> {
      if (!isAuthorized(request)) {
        return unauthorizedResponse();
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method.toUpperCase();

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

        return json({
          entries: dashboardLoggerService.list({
            limit: Number.isFinite(limit) ? limit : undefined,
            q: url.searchParams.get('q') ?? undefined,
            userId: url.searchParams.get('userId') ?? undefined,
            guildId: url.searchParams.get('guildId') ?? undefined,
            source,
            sinceEpochMs: Number.isFinite(since) ? since : undefined,
          }),
          summary: dashboardLoggerService.getSummary(),
        });
      }

      if (path === '/api/log' && method === 'DELETE') {
        const cleared = dashboardLoggerService.clear();
        return json({ ok: true, cleared });
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
  });

  const displayHost = isLoopback ? 'localhost' : host;
  const scheme = password ? 'http' : 'http';
  console.log(`📊 [DASHBOARD] Listening on http://${displayHost}:${server.port}`);
  console.log(`📊 [DASHBOARD] Open http://${displayHost}:${server.port} in your mobile browser`);
  if (password) {
    console.log(`📊 [DASHBOARD] Auth required — user "${config.dashboard.username}"`);
  } else {
    console.log('📊 [DASHBOARD] No password set (safe: bound to loopback only)');
  }
  void scheme;

  return {
    stop: (closeActiveConnections?: boolean) => server.stop(closeActiveConnections),
    url: `http://${displayHost}:${server.port}`,
  };
}
