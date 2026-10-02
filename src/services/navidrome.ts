import { createHash, randomBytes } from 'node:crypto';
import { config } from '../utils/config';

export interface NavidromeNowPlayingEntry {
  id: string;
  title: string;
  artist: string;
  album: string;
  username: string;
  minutesAgo: number;
  duration?: number;
  coverArt?: string;
}

/**
 * Minimal shape of the Subsonic JSON API responses this service consumes.
 * Documenting them keeps the parsed payloads typed instead of `unknown`.
 */
interface SubsonicNowPlayingEntry {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  username?: string;
  minutesAgo?: number;
  duration?: number;
  coverArt?: string;
}

interface SubsonicLyrics {
  content?: string;
  value?: string;
}

interface SubsonicResponseBody {
  status?: string;
  error?: { message?: string };
  nowPlaying?: { entry?: SubsonicNowPlayingEntry | SubsonicNowPlayingEntry[] };
  lyrics?: string | SubsonicLyrics;
  version?: string;
}

interface SubsonicEnvelope {
  'subsonic-response'?: SubsonicResponseBody;
}

/** Result of a Navidrome liveness probe. See `NavidromeService.ping`. */
export interface NavidromeHealth {
  configured: boolean;
  reachable: boolean;
  url: string | null;
  status: number | null;
  latencyMs: number | null;
  detail: string | null;
}

export class NavidromeService {
  private get baseUrl(): string {
    return (config.navidrome.url || '').replace(/\/+$/, '');
  }

  isAvailable(): boolean {
    return Boolean(config.navidrome.url && config.navidrome.user && config.navidrome.password);
  }

  /**
   * Generates Subsonic auth query parameters using MD5 token + salt.
   */
  private getAuthParams(): URLSearchParams {
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5')
      .update(config.navidrome.password + salt)
      .digest('hex');

    return new URLSearchParams({
      u: config.navidrome.user,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'LumiaBot',
      f: 'json',
    });
  }

  /**
   * Liveness probe for the dashboard's integrations view.
   *
   * Uses the Subsonic `ping.view` endpoint, which authenticates but returns no
   * data, so a health check has no side effects. Distinguishes "not configured"
   * from "configured but unreachable" so a missing password is not reported as
   * an outage. Never throws and never hangs: the request is bounded by a timeout.
   */
  async ping(timeoutMs = 4000): Promise<NavidromeHealth> {
    const url = this.baseUrl || null;

    if (!this.isAvailable()) {
      const missing = [
        !config.navidrome.url && 'NAVIDROME_URL',
        !config.navidrome.user && 'NAVIDROME_USER',
        !config.navidrome.password && 'NAVIDROME_PASSWORD',
      ].filter(Boolean);
      return {
        configured: false,
        reachable: false,
        url,
        status: null,
        latencyMs: null,
        detail: `set ${missing.join(', ')}`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const params = this.getAuthParams();
      const res = await fetch(`${this.baseUrl}/rest/ping.view?${params.toString()}`, {
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;

      if (!res.ok) {
        return { configured: true, reachable: false, url, status: res.status, latencyMs, detail: `HTTP ${res.status}` };
      }

      const json = (await res.json()) as SubsonicEnvelope;
      const response = json?.['subsonic-response'];

      if (!response || response.status !== 'ok') {
        return {
          configured: true,
          reachable: false,
          url,
          status: res.status,
          latencyMs,
          detail: response?.error?.message || 'Subsonic API rejected the ping',
        };
      }

      const version = response.version ?? null;
      return {
        configured: true,
        reachable: true,
        url,
        status: res.status,
        latencyMs,
        detail: version ? `Navidrome ${version}` : 'healthy',
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        configured: true,
        reachable: false,
        url,
        status: null,
        latencyMs: Date.now() - started,
        detail: aborted ? `no response after ${timeoutMs}ms` : (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch currently playing or recently played tracks from Navidrome
   */
  async getNowPlaying(): Promise<NavidromeNowPlayingEntry[]> {
    if (!this.isAvailable()) {
      throw new Error('Navidrome is not configured. Set NAVIDROME_URL, NAVIDROME_USER, and NAVIDROME_PASSWORD.');
    }

    const params = this.getAuthParams();
    const url = `${this.baseUrl}/rest/getNowPlaying.view?${params.toString()}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Navidrome HTTP error: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as SubsonicEnvelope;
    const response = json?.['subsonic-response'];

    if (!response || response.status !== 'ok') {
      const errorMsg = response?.error?.message || 'Unknown Subsonic API error';
      throw new Error(`Navidrome API error: ${errorMsg}`);
    }

    const entries = response.nowPlaying?.entry;
    if (!entries) {
      return [];
    }

    const list = Array.isArray(entries) ? entries : [entries];

    return list.map((item) => ({
      id: item.id,
      title: item.title || 'Unknown Title',
      artist: item.artist || 'Unknown Artist',
      album: item.album || 'Unknown Album',
      username: item.username || 'Unknown User',
      minutesAgo: item.minutesAgo ?? 0,
      duration: item.duration,
      coverArt: item.coverArt || undefined,
    }));
  }
  async getCoverArtBuffer(coverArtId: string): Promise<Buffer | null> {
    if (!this.isAvailable()) return null;

    try {
      const params = this.getAuthParams();
      const url = `${this.baseUrl}/rest/getCoverArt.view?${params.toString()}&id=${encodeURIComponent(coverArtId)}`;

      const res = await fetch(url);
      if (!res.ok) return null;

      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.error('❌ [NAVIDROME] Failed to fetch cover art buffer:', err);
      return null;
    }
  }
  /**
   * Fetch lyrics from Navidrome for a given artist and title
   */
  async getLyrics(artist: string, title: string): Promise<string | null> {
    if (!this.isAvailable()) return null;

    try {
      const params = this.getAuthParams();
      params.set('artist', artist);
      params.set('title', title);

      const url = `${this.baseUrl}/rest/getLyrics.view?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const json = (await res.json()) as SubsonicEnvelope;
      const lyricsData = json?.['subsonic-response']?.lyrics;
      if (!lyricsData) return null;

      // Subsonic returns either a plain string or an object with content
      if (typeof lyricsData === 'string') return lyricsData;
      if (lyricsData.content) return lyricsData.content;
      if (lyricsData.value) return lyricsData.value;

      return null;
    } catch (err) {
      console.error('❌ [NAVIDROME] Failed to fetch lyrics:', err);
      return null;
    }
  }
   /**
   * Convert Navidrome now-playing status into LumiaBot's MusicActivity format
   */
  async getListeningActivity(): Promise<import('./user-activity').MusicActivity | null> {
    if (!this.isAvailable()) return null;

    try {
      const nowPlaying = await this.getNowPlaying();
      if (!nowPlaying || nowPlaying.length === 0) return null;

      // The length check above guarantees this exists; the guard just satisfies
      // noUncheckedIndexedAccess and keeps a malformed response from throwing.
      const current = nowPlaying[0];
      if (!current) return null;

      return {
        source: 'spotify', // Set to 'spotify' so existing tool formatters recognize title/artist/album/lyrics
        trackName: current.title,
        artistName: current.artist,
        albumName: current.album,
        state: current.artist,
        details: current.title,
        isPlaying: current.minutesAgo === 0,
      };
    } catch (err) {
      console.error('❌ [NAVIDROME] Failed to get listening activity:', err);
      return null;
    }
  }
}

export const navidromeService = new NavidromeService();
