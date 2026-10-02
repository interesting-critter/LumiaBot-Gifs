import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../utils/config';
import { resetAuthFailuresForTests, startDashboardServer } from '../dashboard';

/**
 * The dashboard's refusal to start without a password, its Host allowlist and
 * its brute-force backoff.
 *
 * `config` is built once at import time, and the env helpers read it eagerly, so
 * there is no way to vary `DASHBOARD_PASSWORD` by setting `process.env` here.
 * Each case therefore saves the dashboard slice of `config`, overwrites the
 * fields it cares about, and restores them afterwards — the same observable
 * state a different `.env` would produce, without re-importing the module.
 */

type DashboardConfig = typeof config.dashboard;

let saved: DashboardConfig;

function setDashboard(overrides: Partial<DashboardConfig>): void {
  Object.assign(config.dashboard, overrides);
}

/** Ports in a range unlikely to collide with a real dashboard. */
let nextPort = 34_100;
function freePort(): number {
  nextPort += 1;
  return nextPort;
}

const PASSWORD = 'a-long-random-password';

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

beforeEach(() => {
  // The counters are per-IP and module-level, and every request in this file
  // comes from 127.0.0.1, so they have to start clean each time.
  resetAuthFailuresForTests();
  saved = { ...config.dashboard };
  setDashboard({
    enabled: true,
    host: '127.0.0.1',
    port: freePort(),
    password: PASSWORD,
    passwordSet: true,
    username: 'admin',
  });
});

afterEach(() => {
  Object.assign(config.dashboard, saved);
});

/** Start the dashboard, run the body, always stop it. */
async function withServer(
  overrides: Partial<DashboardConfig>,
  run: (url: string, port: number) => Promise<void>
): Promise<void> {
  setDashboard(overrides);
  const port = config.dashboard.port;
  const server = startDashboardServer();
  if (!server) throw new Error('dashboard refused to start; test setup is wrong');
  try {
    await run(server.url, port);
  } finally {
    server.stop(true);
  }
}

describe('refusing to start without a password', () => {
  function captureErrors<T>(fn: () => T): { result: T; output: string } {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      return { result: fn(), output: errors.join('\n') };
    } finally {
      console.error = originalError;
    }
  }

  test('returns null and logs a message naming DASHBOARD_PASSWORD', () => {
    setDashboard({ password: '', passwordSet: false });

    const { result, output } = captureErrors(() => startDashboardServer());

    expect(result).toBeNull();
    expect(output).toContain('REFUSING TO START');
    expect(output).toContain('DASHBOARD_PASSWORD');
    // The operator needs to know the bot itself is fine.
    expect(output).toContain('unaffected');
  });

  test('the same holds on loopback — loopback is not a trust boundary', () => {
    setDashboard({ host: '127.0.0.1', password: '', passwordSet: false });

    const { result } = captureErrors(() => startDashboardServer());

    expect(result).toBeNull();
  });

  test('DASHBOARD_ENABLED=false stays a quiet, clean no-op', () => {
    setDashboard({ enabled: false, password: '', passwordSet: false });

    const { result, output } = captureErrors(() => startDashboardServer());

    expect(result).toBeNull();
    expect(output).not.toContain('REFUSING TO START');
  });

  test('starts normally once a password is set', () => {
    setDashboard({ password: PASSWORD, port: freePort() });
    const port = config.dashboard.port;

    const server = startDashboardServer();

    expect(server).not.toBeNull();
    try {
      expect(server!.url).toBe(`http://localhost:${port}`);
    } finally {
      server!.stop(true);
    }
  });
});

describe('Host header allowlist', () => {
  test('rejects a rebound Host before auth, with 421', async () => {
    await withServer({}, async (_url, port) => {
      // What a full DNS rebinding looks like: the browser is genuinely
      // same-origin with evil.com and sends an Origin that agrees with the Host.
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: {
          Host: 'evil.com:3001',
          Origin: 'http://evil.com:3001',
          Authorization: basic('admin', PASSWORD),
        },
      });
      expect(res.status).toBe(421);
    });
  });

  test('rejects a rebound Host even with correct credentials and a matching Origin', async () => {
    await withServer({}, async (_url, port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Host: 'evil.com', Origin: 'http://evil.com', Authorization: basic('admin', PASSWORD) },
      });
      expect(res.status).toBe(421);
    });
  });

  test('accepts the loopback names on the bound port', async () => {
    await withServer({}, async (_url, port) => {
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { Host: host, Authorization: basic('admin', PASSWORD) },
        });
        expect(res.status).not.toBe(421);
      }
    });
  });

  test('a custom DASHBOARD_HOST answers on its own Host and on loopback, but nothing else', async () => {
    await withServer({ host: '0.0.0.0' }, async (_url, port) => {
      const onConfiguredHost = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Host: `0.0.0.0:${port}`, Authorization: basic('admin', PASSWORD) },
      });
      expect(onConfiguredHost.status).not.toBe(421);

      const onLoopback = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Host: `127.0.0.1:${port}`, Authorization: basic('admin', PASSWORD) },
      });
      expect(onLoopback.status).not.toBe(421);

      const stranger = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Host: `192.168.1.44:${port}`, Authorization: basic('admin', PASSWORD) },
      });
      expect(stranger.status).toBe(421);
    });
  });

  test('the Host check runs ahead of authentication', async () => {
    await withServer({}, async (_url, port) => {
      // No credentials at all. 421 proves the Host gate came first; a 401 would
      // mean an unauthenticated request got as far as the auth check.
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Host: 'evil.com' } });
      expect(res.status).toBe(421);
    });
  });
});

describe('brute-force backoff', () => {
  test('401s up to the threshold, then 429; a correct password after the wait resets', async () => {
    await withServer({}, async (_url, port) => {
      const url = `http://127.0.0.1:${port}/api/status`;
      const host = { Host: `127.0.0.1:${port}` };
      const wrong = { ...host, Authorization: basic('admin', 'wrong-password') };
      const right = { ...host, Authorization: basic('admin', PASSWORD) };

      for (let attempt = 1; attempt <= 4; attempt++) {
        const res = await fetch(url, { headers: wrong });
        expect(res.status).toBe(401);
      }

      const locked = await fetch(url, { headers: wrong });
      expect(locked.status).toBe(429);
      expect(Number(locked.headers.get('Retry-After'))).toBeGreaterThan(0);

      // Even the correct password is refused while the lockout stands.
      const duringLockout = await fetch(url, { headers: right });
      expect(duringLockout.status).toBe(429);

      // The first backoff window is 2s. After it, the correct password both
      // succeeds and clears the counter.
      await Bun.sleep(2_100);
      const ok = await fetch(url, { headers: right });
      expect(ok.status).toBe(200);

      for (let attempt = 1; attempt <= 4; attempt++) {
        const res = await fetch(url, { headers: wrong });
        expect(res.status).toBe(401);
      }
    });
  });

  test('the response does not distinguish a wrong username from a wrong password', async () => {
    await withServer({}, async (_url, port) => {
      const url = `http://127.0.0.1:${port}/api/status`;
      const host = { Host: `127.0.0.1:${port}` };

      const badUser = await fetch(url, { headers: { ...host, Authorization: basic('root', PASSWORD) } });
      const badPass = await fetch(url, { headers: { ...host, Authorization: basic('admin', 'nope') } });
      const noHeader = await fetch(url, { headers: host });

      expect(badUser.status).toBe(badPass.status);
      expect(noHeader.status).toBe(badPass.status);

      const [badUserBody, badPassBody, noHeaderBody] = await Promise.all([
        badUser.text(),
        badPass.text(),
        noHeader.text(),
      ]);
      expect(badUserBody).toBe(badPassBody);
      expect(noHeaderBody).toBe(badPassBody);
    });
  });

  test('an unauthenticated request with a good Host is refused with 401', async () => {
    await withServer({}, async (_url, port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
    });
  });
});