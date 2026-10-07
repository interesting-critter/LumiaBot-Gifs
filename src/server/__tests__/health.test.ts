import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../utils/config';
import { resetAuthFailuresForTests, startDashboardServer } from '../dashboard';
import { startHealthServer } from '../health';

/**
 * The unauthenticated health listener.
 *
 * `config` is built once at import time and the env helpers read it eagerly, so
 * there is no way to vary `HEALTH_PORT` by setting `process.env` here. Each case
 * therefore saves the health slice of `config`, overwrites the fields it cares
 * about, and restores it afterwards — the same mutate-and-restore pattern
 * `dashboard-auth.test.ts` uses for the dashboard slice.
 */

type HealthConfig = typeof config.health;

let saved: HealthConfig;

/** Ports from a range of their own so this suite cannot collide with the auth suite's 34_1xx. */
let nextPort = 34_200;
function freePort(): number {
  nextPort += 1;
  return nextPort;
}

function setHealth(overrides: Partial<HealthConfig>): void {
  Object.assign(config.health, overrides);
}

const PASSWORD = 'a-long-random-password';

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

/** The documented shape of the health payload, so assertions read as assertions. */
interface HealthBody {
  status: string;
  uptimeSeconds: number;
  discord: string;
  serverTime: string;
}

async function readHealth(url: string): Promise<HealthBody> {
  return (await (await fetch(url)).json()) as HealthBody;
}

beforeEach(() => {
  resetAuthFailuresForTests();
  saved = { ...config.health };
  setHealth({ enabled: true, host: '127.0.0.1', port: freePort() });
});

afterEach(() => {
  Object.assign(config.health, saved);
});

/** Start the health server, run the body, always stop it. */
async function withHealth(run: (url: string, port: number) => Promise<void>): Promise<void> {
  const port = config.health.port;
  const server = startHealthServer();
  if (!server) throw new Error('health server refused to start; test setup is wrong');
  try {
    await run(server.url, port);
  } finally {
    server.stop(true);
  }
}

describe('opt-in', () => {
  test('port 0 binds nothing and returns null', () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    let result: ReturnType<typeof startHealthServer> | undefined;
    try {
      setHealth({ enabled: false, port: 0 });
      result = startHealthServer();
    } finally {
      console.error = originalError;
    }

    expect(result).toBeNull();
    // Off-by-default is not a fault, so it must not be reported as one.
    expect(errors).toEqual([]);
  });

  test('a zero port is off even if `enabled` was left true', () => {
    setHealth({ enabled: true, port: 0 });
    expect(startHealthServer()).toBeNull();
  });
});

describe('responses', () => {
  test('GET / and GET /healthz answer 200 with a well-formed body', async () => {
    await withHealth(async (_url, port) => {
      for (const path of ['/', '/healthz', '/healthz/', '/']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
        expect(res.headers.get('Cache-Control')).toBe('no-store');

        const body = (await res.json()) as HealthBody;
        expect(body.status).toBe('ok');
        expect(typeof body.uptimeSeconds).toBe('number');
        expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
        expect(['ready', 'not-ready']).toContain(body.discord);
      }
    });
  });

  test('discord readiness is reported as data and never changes the status code', async () => {
    await withHealth(async (_url, port) => {
      // The bot is not logged in during tests, so this is the `not-ready` case —
      // the exact state a monitor must not treat as an outage.
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HealthBody;
      expect(body.discord).toBe('not-ready');
      expect(body.status).toBe('ok');
    });
  });

  test('HEAD / answers 200 with an empty body', async () => {
    await withHealth(async (_url, port) => {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });
  });

  test('a wrong method is 405 and an unknown path is 404', async () => {
    await withHealth(async (_url, port) => {
      const post = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
      expect(post.status).toBe(405);

      const unknown = await fetch(`http://127.0.0.1:${port}/not-a-route`);
      expect(unknown.status).toBe(404);

      // Nothing else is reachable — in particular nothing that reads data.
      const api = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(api.status).toBe(404);
    });
  });
});

describe('silence', () => {
  test('successful requests log nothing at all', async () => {
    const port = config.health.port;
    const server = startHealthServer();
    if (!server) throw new Error('health server refused to start; test setup is wrong');

    // Spies installed AFTER startup, so the one boot line is not counted: the
    // property under test is per-request silence, not silence at boot.
    const calls = { log: 0, warn: 0, error: 0 };
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = () => { calls.log++; };
    console.warn = () => { calls.warn++; };
    console.error = () => { calls.error++; };

    try {
      for (let i = 0; i < 5; i++) {
        const ok = await fetch(`http://127.0.0.1:${port}/`);
        expect(ok.status).toBe(200);
        const alt = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'HEAD' });
        expect(alt.status).toBe(200);
      }
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
      server.stop(true);
    }

    expect(calls).toEqual({ log: 0, warn: 0, error: 0 });
  });
});

describe('independence from the dashboard brute-force lockout', () => {
  test('locking 127.0.0.1 out of the dashboard leaves the health port at 200', async () => {
    const dashboardSlice = { ...config.dashboard };
    const healthPort = config.health.port;

    Object.assign(config.dashboard, {
      enabled: true,
      host: '127.0.0.1',
      port: freePort(),
      password: PASSWORD,
      passwordSet: true,
      username: 'admin',
    });
    resetAuthFailuresForTests();

    const dashboard = startDashboardServer();
    const health = startHealthServer();
    if (!dashboard) throw new Error('dashboard refused to start; test setup is wrong');
    if (!health) throw new Error('health server refused to start; test setup is wrong');

    try {
      const dashboardPort = config.dashboard.port;
      const url = `http://127.0.0.1:${dashboardPort}/api/status`;
      const wrong = { Host: `127.0.0.1:${dashboardPort}`, Authorization: basic('admin', 'wrong') };

      // AUTH_FAILURE_LIMIT is 5; six guarantees the backoff has engaged.
      for (let attempt = 0; attempt < 6; attempt++) {
        await fetch(url, { headers: wrong });
      }

      const locked = await fetch(url, { headers: wrong });
      expect(locked.status).toBe(429);

      // Even the correct password is refused while the lockout stands — this is
      // the operator being locked out of their own dashboard.
      const duringLockout = await fetch(url, {
        headers: { Host: `127.0.0.1:${dashboardPort}`, Authorization: basic('admin', PASSWORD) },
      });
      expect(duringLockout.status).toBe(429);

      // The monitor's port is unaffected, which is the entire point of it being
      // a separate listener.
      const healthRes = await fetch(`http://127.0.0.1:${healthPort}/`);
      expect(healthRes.status).toBe(200);
      expect((await readHealth(`http://127.0.0.1:${healthPort}/`)).status).toBe('ok');
    } finally {
      health.stop(true);
      dashboard.stop(true);
      resetAuthFailuresForTests();
      Object.assign(config.dashboard, dashboardSlice);
    }
  });
});

describe('bind failures', () => {
  test('an occupied port returns null and logs once instead of stepping or throwing', () => {
    const port = freePort();
    setHealth({ port });

    // Stand in for the stale process that makes this realistic.
    const squatter = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('nope') });

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    let result: ReturnType<typeof startHealthServer> | undefined;
    try {
      result = startHealthServer();
    } finally {
      console.error = originalError;
      squatter.stop(true);
    }

    expect(result).toBeNull();
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain(String(port));
    // The operator needs to know the bot itself is fine.
    expect(errors[0]).toContain('unaffected');
  });

  test('stop(true) releases the socket', async () => {
    const port = config.health.port;
    const server = startHealthServer();
    if (!server) throw new Error('health server refused to start; test setup is wrong');

    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    server.stop(true);

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});