import { config } from '../utils/config';
import { dashboardLoggerService } from '../services/dashboard-logger';
import { bot } from '../bot/client';
import { describeBindError } from './bind';

export interface HealthServer {
  stop: (closeActiveConnections?: boolean) => void;
  url: string;
}

/**
 * The two paths this server answers. Anything else is a 404 — see the route
 * table in {@link startHealthServer} for why that list is not going to grow.
 */
const HEALTH_PATHS = new Set(['/', '/healthz']);

/**
 * Methods that may read the payload. `HEAD` is included because that is what a
 * monitor sends when it only cares whether the port is answering at all, and
 * every HTTP client library uses it for exactly that. It cannot do anything a
 * `GET` could not, so allowing it costs nothing.
 */
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Local duplicate of the dashboard's `json()` helper.
 *
 * Deliberately NOT imported from `dashboard.ts`: that module pulls in the UI
 * file, SQLite, the prompt filesystem and a dozen services, and importing any of
 * it from the health server would make this "tiny side-effect-free liveness
 * listener" drag the whole admin stack into its import graph. Five lines are
 * cheaper than that dependency.
 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // A cached "ok" would outlive the process that produced it and defeat the
      // entire purpose of the endpoint.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Loopback spellings treated as "only this device", matching the dashboard's own
 * check. Note the honest caveat the dashboard also carries: under Termux on
 * Android, `127.0.0.1` is reachable by every other app on the device, so
 * loopback is a weaker boundary here than it looks.
 */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Start the unauthenticated health listener, or return `null` when it is off or
 * cannot bind. Never throws: a monitoring aid must not be able to stop the bot.
 *
 * WHY A WHOLE SERVER INSTEAD OF A DASHBOARD ROUTE
 * ----------------------------------------------
 * Three reasons, in increasing order of how hard they are to work around:
 *
 *  1. Auth. A monitor cannot send HTTP Basic credentials, so a route on the
 *     dashboard is by definition unreachable for the thing this exists to
 *     serve. Every unauthenticated poll counts against `AUTH_FAILURE_LIMIT`, and
 *     once the monitor's source address trips the backoff the operator — sharing
 *     that address on a phone, or behind a proxy that collapses both onto one —
 *     is locked out of their own dashboard.
 *  2. Blast radius. This handler reads no database, no prompt file and no
 *     Discord transcript. A monitoring endpoint that cannot reach private data
 *     cannot leak it, cannot be slow because some service is, and cannot fail in
 *     a way that takes the dashboard down with it.
 *  3. Noise. A poll must be silent (see the handler below). On the dashboard
 *     that is impossible: every rejected request goes through the audit,
 *     brute-force and rate-limit paths, all of which log.
 *
 * The route table is therefore complete and closed: `GET`/`HEAD` on `/` or
 * `/healthz`, `405` for any other method, `404` for any other path. There is no
 * auth check to bypass because there is no auth check.
 */
export function startHealthServer(): HealthServer | null {
  const { enabled, host, port } = config.health;

  // Silence when off. The dashboard logs "Disabled via DASHBOARD_ENABLED=false"
  // because the dashboard is enabled by default and this is a deliberate change
  // an operator should see. The health port is OFF by default for every existing
  // install, so a line on every boot would be noise about a feature nobody
  // asked for. `port === 0` is checked as well as `enabled`: both are the "off"
  // sentinel from `utils/config.ts`, and a caller that mutated one without the
  // other (as the tests do) must not be able to get a listener on port 0.
  if (!enabled || port === 0) {
    return null;
  }

  const loopback = isLoopback(host);

  const handler = {
    /**
     * ZERO logging on this path — no `console.log`, no `warn`, no `error`, ever,
     * for any request, successful or not. This is a hard requirement from the
     * operator: Dashy polls this endpoint on a short interval, and a per-ping
     * line would bury the bot's actual logs in noise forever. It is also why
     * this endpoint is its own server: on the dashboard, logging every request is
     * non-negotiable (it is how the audit trail and the brute-force counter work),
     * so a "silent" route there would have to be carved out of machinery that is
     * shared with authentication.
     *
     * This is also why the `discord: 'not-ready'` field below never changes the
     * status code. The status code is ALWAYS 200. A monitor that alerted on a
     * non-200 would false-alarm through every restart, every gateway reconnect and
     * every transient Discord blip — exactly the moments where the operator most
     * needs the alert to be meaningful. Gateway readiness is reported as data so
     * it can be graphed and alerted on deliberately, by someone who has decided
     * that is worth paging them, rather than by an unauthenticated port guessing.
     */
    fetch(request: Request): Response {
      const method = request.method.toUpperCase();

      // 405 for a wrong method on a known path, 404 for an unknown path. Both
      // are decided from the method and path alone — no state is read, no header
      // is consulted, and nothing is written anywhere.
      if (!READ_METHODS.has(method)) {
        return json({ error: 'Method not allowed' }, 405);
      }

      // Trailing slashes normalised the same way the dashboard does, so
      // `/healthz/` is the same resource as `/healthz` and a monitor configured
      // with a trailing slash does not get a puzzling 404.
      const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
      if (!HEALTH_PATHS.has(path)) {
        return json({ error: 'Not found' }, 404);
      }

      return json({
        status: 'ok',
        uptimeSeconds: dashboardLoggerService.getUptimeSeconds(),
        discord: bot.client.isReady() ? 'ready' : 'not-ready',
        serverTime: new Date().toISOString(),
      });
    },

    /**
     * Only fires when the handler itself throws, which for the four lines above
     * means a genuine fault (a Discord client in a bad state, a missing global)
     * rather than a ping. That is why this may log while the request path above
     * must not: a crash is worth a line, a monitor's poll is not.
     *
     * It answers a small JSON 500 instead of Bun's default error page so that a
     * monitor sees a well-formed response and an obvious status code, rather than
     * whatever HTML the runtime decides to substitute.
     */
    error(error: Error) {
      console.error('❌ [HEALTH] Unhandled request error:', error);
      return json({ error: 'Internal health error' }, 500);
    },
  };

  /**
   * ONE bind attempt, on the configured port, no stepping forward.
   *
   * The dashboard steps up to five ports and warns loudly when it moves, because
   * a stale process squatting on 3001 is common and the operator just follows
   * the URL in the log. Stepping silently here would be actively harmful: a
   * monitor is configured with a fixed URL once and never reads a boot log, so
   * hopping to 3003 would leave Dashy polling a closed port forever while every
   * human-visible sign said the bot was healthy. The right failure is to say so
   * once, loudly, at startup, and let the operator fix the port.
   *
   * The bot is unaffected in either case — it has already logged in to Discord
   * by the time this runs, and nothing here touches the gateway.
   */
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: host,
      port,
      fetch: handler.fetch,
      error: handler.error,
    });
  } catch (bindError) {
    console.error(
      `❌ [HEALTH] Could not bind ${host}:${port}: ${describeBindError(bindError)}. ` +
        `Not starting the health endpoint; your monitor will report it down until you fix the ` +
        `port or free it. Discord is unaffected.`
    );
    return null;
  }

  const displayHost = loopback ? 'localhost' : host;
  const url = `http://${displayHost}:${server.port}`;
  console.log(`💚 [HEALTH] Listening on ${url} (no auth, status only)`);

  if (!loopback) {
    console.warn(
      `💚 [HEALTH] Bound to ${host}, so this unauthenticated port is reachable by anything ` +
        `that can route to this device. It reports uptime and Discord readiness only — no ` +
        `transcripts, no prompts, no memory — but anyone who reaches it gets those two ` +
        `facts for free. Set HEALTH_HOST=127.0.0.1 if you did not mean to expose it.`
    );
  }

  return {
    stop: (closeActiveConnections?: boolean) => server.stop(closeActiveConnections),
    url,
  };
}