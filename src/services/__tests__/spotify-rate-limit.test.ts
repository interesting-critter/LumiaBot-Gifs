import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression coverage for the 429 gap.
 *
 * `getArtists` had `Retry-After` handling. `getPlaylist` and `getPlaylistTracks`
 * did not, so a rate limit anywhere in the pagination of a large playlist threw
 * `SpotifyWebApiException` straight out of `getPlaylist`.
 *
 * Why that was worse than one failed import: `handleRefresh` in
 * `commands/music.ts` loops over every saved playlist with no retry of its own,
 * so one 429 aborted *that* import (correctly rolled back) **and** every
 * playlist after it in the refresh loop. A single Spotify rate-limit window
 * silently emptied the refresh.
 *
 * The retry is now hoisted into one `withRateLimitRetry` helper applied to all
 * three call sites. `sleep` is overridden below so the honoured `Retry-After`
 * is asserted without the test actually waiting for it. No network: `this.api`
 * is a stub.
 */

/**
 * A throwable that carries the shape `SpotifyWebApiException` has: a real
 * `Error` (so the caller's `catch` unwraps `message` correctly) plus the
 * `statusCode` and `headers` the retry helper branches on.
 */
function rateLimited(retryAfterSeconds?: string): Error {
  const error = new Error('rate limited') as Error & {
    statusCode: number;
    headers: Record<string, string>;
  };
  error.statusCode = 429;
  error.headers = retryAfterSeconds === undefined ? {} : { 'retry-after': retryAfterSeconds };
  return error;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** A stub `SpotifyWebApi` whose methods return a queued script of results. */
interface StubApi {
  getPlaylist: ReturnType<typeof scripted>;
  getPlaylistTracks: ReturnType<typeof scripted>;
  getArtists: ReturnType<typeof scripted>;
  clientCredentialsGrant: () => Promise<{ body: { access_token: string; expires_in: number } }>;
  setAccessToken: (token: string) => void;
}

type Script = Array<unknown | Error>;

/**
 * Each entry is a value to resolve with, or an Error to reject with. The last
 * entry repeats forever so a test only has to script the interesting prefix.
 */
function scripted(script: Script) {
  let index = 0;
  return async (..._args: unknown[]) => {
    const step = script[Math.min(index, script.length - 1)];
    index++;
    if (step instanceof Error) throw step;
    return step;
  };
}

interface Harness {
  service: SpotifyServiceInstance;
  api: StubApi;
  /** Milliseconds the service asked to wait for, in call order. */
  waits: number[];
}

function harness(script: Partial<Record<keyof StubApi, Script>> = {}): Harness {
  const service: SpotifyServiceInstance = new SpotifyService();
  const waits: number[] = [];

  const api = {
    getPlaylist: scripted(script.getPlaylist ?? [{ body: playlistBody() }]),
    getPlaylistTracks: scripted(script.getPlaylistTracks ?? [{ body: pageBody([]) }]),
    getArtists: scripted(script.getArtists ?? [{ body: { artists: [] } }]),
    clientCredentialsGrant: async () => ({ body: { access_token: 'test', expires_in: 3600 } }),
    setAccessToken: () => {},
  } as StubApi;

  const host = service as unknown as {
    api: StubApi;
    ensureAuthenticated: () => Promise<void>;
    sleep: (ms: number) => Promise<void>;
  };
  host.api = api;
  host.ensureAuthenticated = async () => {};
  host.sleep = async (ms: number) => {
    waits.push(ms);
  };

  return { service, api, waits };
}

function playlistBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'playlist-id',
    name: 'Playlist',
    description: '',
    owner: { id: 'owner', display_name: 'Owner' },
    tracks: { total: 0 },
    images: [],
    public: true,
    collaborative: false,
    ...overrides,
  };
}

function pageBody(items: unknown[]) {
  return { items, next: null };
}

/**
 * One playlist track that carries a real artist id.
 *
 * `getPlaylist` only calls `getArtists` when the collected tracks reference at
 * least one non-`unknown` artist id, so a playlist of zero tracks never reaches
 * the artist call site at all.
 */
function trackPageBody() {
  return pageBody([
    {
      added_at: '2024-01-01T00:00:00Z',
      added_by: { id: 'curator' },
      track: {
        id: 'track-id',
        name: 'Track',
        duration_ms: 1000,
        explicit: false,
        popularity: 1,
        preview_url: null,
        track_number: 1,
        artists: [{ id: 'artist-id', name: 'Artist' }],
        album: { id: 'album-id', name: 'Album', release_date: '2024-01-01', total_tracks: 1, images: [] },
      },
    },
  ]);
}

// Spotify credentials must be present or the module-level singleton warns at
// import; each test still builds its own instance with a stubbed API, so these
// values are never sent anywhere.
process.env.SPOTIFY_CLIENT_ID ??= 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET ??= 'test-client-secret';

type SpotifyServiceInstance = InstanceType<typeof import('../spotify').SpotifyService>;

const { SpotifyService } = await import('../spotify');

describe('withRateLimitRetry — Retry-After is honoured', () => {
  test('a 429 on getPlaylist is retried, and the wait comes from the header', async () => {
    const { service, waits } = harness({
      getPlaylist: [rateLimited('2'), { body: playlistBody() }],
    });

    const playlist = await service.getPlaylist('playlist-id');

    expect(playlist.name).toBe('Playlist');
    // 2 seconds, not an immediate re-issue.
    expect(waits).toEqual([2000]);
  });

  test('a 429 on getPlaylistTracks is retried — the pagination case', async () => {
    const { service, waits } = harness({
      getPlaylistTracks: [rateLimited('3'), { body: pageBody([]) }],
    });

    await service.getPlaylist('playlist-id');

    expect(waits).toEqual([3000]);
  });

  test('a 429 on getArtists is retried — the case that already worked', async () => {
    const { service, waits } = harness({
      getPlaylistTracks: [{ body: trackPageBody() }],
      getArtists: [rateLimited('1'), { body: { artists: [] } }],
    });

    await service.getPlaylist('playlist-id');

    expect(waits).toEqual([1000]);
  });

  test('a malformed Retry-After falls back to a short wait rather than hammering', async () => {
    const bogus = rateLimited() as Error & { headers: Record<string, string> };
    bogus.headers = { 'retry-after': 'soon' };
    const { service, waits } = harness({
      getPlaylist: [bogus, { body: playlistBody() }],
    });

    await service.getPlaylist('playlist-id');

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(1000);
  });

  test('a missing Retry-After header still waits before retrying', async () => {
    // Retrying immediately is what turns one rate-limit window into a ban.
    const { service, waits } = harness({
      getPlaylist: [rateLimited(), { body: playlistBody() }],
    });

    await service.getPlaylist('playlist-id');

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  test('the capitalised header spelling is honoured too', async () => {
    const capitalised = new Error('slow down') as Error & {
      statusCode: number;
      headers: Record<string, string>;
    };
    capitalised.statusCode = 429;
    capitalised.headers = { 'Retry-After': '4' };

    const { service, waits } = harness({
      getPlaylist: [capitalised, { body: playlistBody() }],
    });

    await service.getPlaylist('playlist-id');

    expect(waits).toEqual([4000]);
  });
});

describe('withRateLimitRetry — what must not be retried', () => {
  test('a 404 propagates immediately, with no wait', async () => {
    const { service, waits } = harness({
      getPlaylist: [httpError(404, 'nope'), { body: playlistBody() }],
    });

    await expect(service.getPlaylist('missing')).rejects.toThrow('Playlist not found');
    expect(waits).toEqual([]);
  });

  test('a 401 propagates immediately, with no wait', async () => {
    const { service, waits } = harness({
      getPlaylist: [httpError(401, 'bad creds'), { body: playlistBody() }],
    });

    await expect(service.getPlaylist('playlist-id')).rejects.toThrow('authentication failed');
    expect(waits).toEqual([]);
  });

  test('a non-429 failure propagates rather than swallowing the playlist', async () => {
    const { service, waits } = harness({
      getPlaylist: [new Error('socket hang up')],
    });

    await expect(service.getPlaylist('playlist-id')).rejects.toThrow('socket hang up');
    expect(waits).toEqual([]);
  });

  test('a persistent 429 eventually propagates instead of hanging forever', async () => {
    const { service, waits } = harness({ getPlaylist: [rateLimited('1')] });

    await expect(service.getPlaylist('playlist-id')).rejects.toThrow('Failed to fetch playlist');
    // Bounded: it retried, then gave up.
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.length).toBeLessThanOrEqual(5);
  });
});

describe('withRateLimitRetry — every call site is covered', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'spotify.ts'), 'utf8');

  /**
   * Regression guard for the original bug: 429 handling that lived on
   * `getArtists` only, while the two playlist calls went straight to the API.
   */
  test('the helper is declared and used, and all three API calls are present', () => {
    expect(source).toContain('private async withRateLimitRetry');
    expect(source).toContain('this.withRateLimitRetry(');

    for (const call of ['this.api.getPlaylist(', 'this.api.getPlaylistTracks(', 'this.api.getArtists(']) {
      expect(source).toContain(call);
    }
  });

  test('no API call is invoked unguarded', () => {
    // Every `this.api.*` invocation must sit inside the wrapper as the first
    // argument, never awaited directly off `this.api`.
    for (const method of ['getPlaylist', 'getPlaylistTracks', 'getArtists']) {
      const direct = (source.match(new RegExp(`await this\\.api\\.${method}\\(`, 'g')) ?? []).length;
      expect(direct).toBe(0);
    }
  });

  test('the retry count and the wait cap are both configurable and bounded', () => {
    // A hostile or misconfigured env must not be able to stall a command
    // forever or turn into an unbounded retry loop.
    expect(source).toContain("intEnv('SPOTIFY_RATE_LIMIT_MAX_RETRIES', 2, { min: 0, max: 5 })");
    expect(source).toContain(
      "intEnv('SPOTIFY_RATE_LIMIT_MAX_WAIT_MS', 10_000, { min: 0, max: 60_000 })",
    );
  });
});