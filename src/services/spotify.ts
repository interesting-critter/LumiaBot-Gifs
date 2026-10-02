import SpotifyWebApi from 'spotify-web-api-node';
import { config } from '../utils/config';
import { intEnv } from '../utils/env';

/**
 * Hard ceiling on how many playlist items are pulled from the Spotify API.
 *
 * The cap is on the pagination cursor (total items *offered* by the API), not on
 * the number of usable tracks: filtering out removed/local tracks must not let
 * the loop run forever.
 */
const MAX_PLAYLIST_TRACKS = intEnv('SPOTIFY_MAX_PLAYLIST_TRACKS', 1000, { min: 1, max: 10_000 });

/** Artist-genre batch size (Spotify allows 50 ids per request). */
const ARTIST_BATCH_SIZE = intEnv('SPOTIFY_ARTIST_BATCH_SIZE', 50, { min: 1, max: 50 });

/** How long to honour a 429 `Retry-After` before giving up on a batch. */
const RATE_LIMIT_MAX_WAIT_MS = intEnv('SPOTIFY_RATE_LIMIT_MAX_WAIT_MS', 10_000, { min: 0, max: 60_000 });

/**
 * How many times a rate-limited request is re-issued before the error is
 * allowed to propagate.
 *
 * One retry is the minimum that makes a 429 survivable; two means a request that
 * is caught by a second, separate rate-limit window also recovers. Spotify bills
 * a single playlist import as `1 + ceil(tracks/100) + ceil(artists/50)` requests
 * issued back to back, so hitting the limit once is common and hitting it
 * repeatedly on one call is not rare.
 */
const RATE_LIMIT_MAX_RETRIES = intEnv('SPOTIFY_RATE_LIMIT_MAX_RETRIES', 2, { min: 0, max: 5 });

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  durationMs: number;
  explicit: boolean;
  popularity: number;
  previewUrl: string | null;
  trackNumber: number;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  releaseDate: string;
  totalTracks: number;
  images: SpotifyImage[];
}

export interface SpotifyImage {
  url: string;
  height: number;
  width: number;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string;
  owner: {
    id: string;
    displayName: string;
  };
  tracks: {
    total: number;
    items: SpotifyPlaylistTrack[];
  };
  images: SpotifyImage[];
  public: boolean;
  collaborative: boolean;
}

export interface SpotifyPlaylistTrack {
  addedAt: string;
  addedBy: {
    id: string;
  };
  track: SpotifyTrack;
}

export class SpotifyService {
  private api: SpotifyWebApi;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.warn('⚠️ [SPOTIFY] Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET. Spotify features disabled.');
      this.api = new SpotifyWebApi({
        clientId: '',
        clientSecret: '',
      });
      return;
    }

    this.api = new SpotifyWebApi({
      clientId,
      clientSecret,
    });

    console.log('🎵 [SPOTIFY] Service initialized');
  }

  /**
   * Check if Spotify is configured and available
   */
  isAvailable(): boolean {
    return !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET;
  }

  /**
   * Ensure we have a valid access token
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
    }

    // Check if token is still valid (with 5 minute buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 300000) {
      return;
    }

    try {
      const data = await this.api.clientCredentialsGrant();
      this.accessToken = data.body.access_token;
      this.tokenExpiresAt = Date.now() + (data.body.expires_in * 1000);
      
      this.api.setAccessToken(this.accessToken);
      console.log('🎵 [SPOTIFY] Access token refreshed');
    } catch (error) {
      console.error('❌ [SPOTIFY] Failed to get access token:', error);
      throw new Error('Failed to authenticate with Spotify');
    }
  }

  /**
   * Extract playlist ID from various Spotify URL formats
   */
  extractPlaylistId(url: string): string | null {
    // Match various Spotify playlist URL formats.
    //
    // The patterns are anchored: an unanchored `open.spotify.com/playlist/...`
    // also matched `https://evil.com/open.spotify.com/playlist/xyz`, and the
    // unbounded `[a-zA-Z0-9]+` accepted ids of any length. Spotify playlist ids
    // are exactly 22 base62 characters, so the URL forms require that too.
    const patterns = [
      /^https?:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})(?:[/?#].*)?$/,
      /^spotify:playlist:([a-zA-Z0-9]{22})$/,
      /^([a-zA-Z0-9]{22})$/, // Direct ID (22 chars)
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Fetch a playlist with all its tracks
   */
  async getPlaylist(playlistId: string): Promise<SpotifyPlaylist> {
    await this.ensureAuthenticated();

    try {
      // Get playlist info
      const playlistResponse = await this.withRateLimitRetry(
        () => this.api.getPlaylist(playlistId),
        'getPlaylist',
      );
      const playlist = playlistResponse.body;

      // Fetch all tracks (pagination)
      const tracks: SpotifyPlaylistTrack[] = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const tracksResponse = await this.withRateLimitRetry(
          () => this.api.getPlaylistTracks(playlistId, {
            offset,
            limit,
            fields: 'items(added_at,added_by.id,track(id,name,duration_ms,explicit,popularity,preview_url,track_number,artists(id,name),album(id,name,release_date,total_tracks,images))),next',
          }),
          'getPlaylistTracks',
        );

        const items = tracksResponse.body.items
          .filter((item: any) => {
            // Skip null tracks or tracks without valid IDs (deleted, unavailable, local files)
            if (!item.track || !item.track.id) {
              console.log(`🎵 [SPOTIFY] Skipping track without ID: ${item.track?.name || 'unknown'}`);
              return false;
            }
            return true;
          })
          .map((item: any) => this.mapPlaylistTrack(item));

        tracks.push(...items);

        hasMore = tracksResponse.body.next !== null;
        // `offset` is the API's pagination cursor, so it counts *every* item
        // Spotify returned — including the null-id ones filtered out above.
        // The old cap tested `tracks.length`, which never grows for a playlist
        // made entirely of removed/local tracks, so such a playlist paged
        // forever against the API until it 404'd or rate-limited us.
        offset += limit;

        if (offset >= MAX_PLAYLIST_TRACKS) {
          if (hasMore) {
            console.warn(`🎵 [SPOTIFY] Playlist ${playlistId} exceeds ${MAX_PLAYLIST_TRACKS} tracks, truncating`);
          }
          break;
        }
      }

      // Fetch artist genres for each unique artist (skip 'unknown' IDs)
      const artistIds = [...new Set(
        tracks.flatMap(t => t.track.artists.map(a => a.id).filter(id => id && id !== 'unknown'))
      )];
      
      console.log(`🎵 [SPOTIFY] Found ${artistIds.length} unique artists to fetch genres for`);
      
      const artistGenres = await this.getArtistGenres(artistIds);

      // Enrich tracks with genres
      tracks.forEach(t => {
        t.track.artists.forEach(artist => {
          artist.genres = artistGenres.get(artist.id) || [];
        });
      });

      return {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description || '',
        owner: {
          id: playlist.owner.id,
          displayName: playlist.owner.display_name || playlist.owner.id,
        },
        tracks: {
          total: playlist.tracks.total,
          items: tracks,
        },
        images: playlist.images.map((img: any) => ({
          url: img.url,
          height: img.height,
          width: img.width,
        })),
        public: playlist.public || false,
        collaborative: playlist.collaborative,
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        throw new Error('Playlist not found. Make sure it exists and is public.');
      }
      if (error.statusCode === 401) {
        throw new Error('Spotify authentication failed. Check your credentials.');
      }
      console.error('❌ [SPOTIFY] Error fetching playlist:', error);
      throw new Error(`Failed to fetch playlist: ${error.message}`);
    }
  }

  /**
   * Fetch genres for multiple artists
   */
  private async getArtistGenres(artistIds: string[]): Promise<Map<string, string[]>> {
    const genres = new Map<string, string[]>();

    if (artistIds.length === 0) return genres;

    for (let i = 0; i < artistIds.length; i += ARTIST_BATCH_SIZE) {
      const batch = artistIds.slice(i, i + ARTIST_BATCH_SIZE);

      try {
        const response = await this.getArtistsWithBackoff(batch);
        response.body.artists.forEach((artist: any) => {
          genres.set(artist.id, artist.genres || []);
        });
      } catch (error) {
        console.warn(`🎵 [SPOTIFY] Failed to fetch genres for artist batch ${i}:`, error);
      }
    }

    return genres;
  }

  /**
   * Run a Spotify request, honouring `Retry-After` when it is rate-limited.
   *
   * WHY THIS IS ONE HELPER AND NOT AN ARTIST-ONLY ONE
   * --------------------------------------------------
   * The 429 handling used to exist only on `getArtists`. `getPlaylist` and
   * `getPlaylistTracks` called the API raw, so a 429 anywhere in the pagination
   * of a large playlist threw `SpotifyWebApiException` straight out of
   * `getPlaylist`. That aborted the whole import (correctly — it rolls back),
   * but `handleRefresh` iterates the saved playlists with no retry of its own,
   * so one rate-limited playlist also killed every playlist *after* it in the
   * loop: a single Spotify rate-limit window silently emptied the refresh.
   *
   * The wait is `Retry-After`-derived and capped by
   * `SPOTIFY_RATE_LIMIT_MAX_WAIT_MS`, so a hostile or absurd header cannot stall
   * a command indefinitely. Non-429 errors are rethrown immediately — retrying
   * a 404 or a 401 just burns the budget.
   *
   * @param operation the request to issue; called at most `1 + retries` times
   * @param label short name used in the warning log, so the operator can see
   *   which call was throttled
   */
  private async withRateLimitRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        if (error?.statusCode !== 429) throw error;
        lastError = error;

        if (attempt === RATE_LIMIT_MAX_RETRIES) break;

        const waitMs = this.parseRetryAfter(error);
        console.warn(
          `🎵 [SPOTIFY] Rate limited during ${label}; retrying in ${waitMs}ms ` +
            `(attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`,
        );
        await this.sleep(waitMs);
      }
    }

    // Every attempt was rate-limited. Rethrow the original exception so callers
    // keep seeing Spotify's own status/headers rather than a vague wrapper.
    throw lastError;
  }

  /**
   * `getArtists` with 429 handling, via {@link withRateLimitRetry}.
   *
   * A 1000-track playlist means up to 20 serial artist batches. A single rate
   * limit response used to be swallowed by this method's own `catch`, so every
   * remaining artist silently lost its genres and nothing said so.
   */
  private async getArtistsWithBackoff(batch: string[]) {
    return this.withRateLimitRetry(() => this.api.getArtists(batch), 'getArtists');
  }

  /**
   * Indirection over `setTimeout` so tests can assert the honoured wait without
   * actually sleeping for it.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** `Retry-After` is seconds; anything malformed falls back to a 1s wait. */
  private parseRetryAfter(error: any): number {
    const header = error?.headers?.['retry-after'] ?? error?.headers?.['Retry-After'];
    const seconds = Number.parseFloat(String(header ?? ''));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return Math.min(1000, RATE_LIMIT_MAX_WAIT_MS);
    }
    return Math.min(Math.round(seconds * 1000), RATE_LIMIT_MAX_WAIT_MS);
  }

  /**
   * Get track details by ID
   */
  async getTrack(trackId: string): Promise<SpotifyTrack> {
    await this.ensureAuthenticated();

    try {
      const response = await this.api.getTrack(trackId);
      return this.mapTrack(response.body);
    } catch (error) {
      console.error('❌ [SPOTIFY] Error fetching track:', error);
      throw new Error('Failed to fetch track details');
    }
  }

  /**
   * Map Spotify API track to our interface
   * Handles null/undefined fields gracefully (local files, unavailable tracks, etc.)
   */
  private mapTrack(track: any): SpotifyTrack {
    // Handle missing album (local files, unavailable tracks)
    const album = track.album || {};
    
    return {
      id: track.id || 'unknown',
      name: track.name || 'Unknown Track',
      artists: (track.artists || []).map((a: any) => ({
        id: a?.id || 'unknown',
        name: a?.name || 'Unknown Artist',
        genres: [], // Will be populated separately
        popularity: 0,
      })),
      album: {
        id: album.id || 'unknown',
        name: album.name || 'Unknown Album',
        artists: (album.artists || []).map((a: any) => ({
          id: a?.id || 'unknown',
          name: a?.name || 'Unknown Artist',
          genres: [],
          popularity: 0,
        })),
        releaseDate: album.release_date || '',
        totalTracks: album.total_tracks || 0,
        images: (album.images || []).map((img: any) => ({
          url: img?.url || '',
          height: img?.height || 0,
          width: img?.width || 0,
        })),
      },
      durationMs: track.duration_ms || 0,
      explicit: track.explicit || false,
      popularity: track.popularity || 0,
      previewUrl: track.preview_url || null,
      trackNumber: track.track_number || 0,
    };
  }

  /**
   * Map Spotify API playlist track to our interface
   */
  private mapPlaylistTrack(item: any): SpotifyPlaylistTrack {
    return {
      addedAt: item.added_at,
      addedBy: {
        id: item.added_by?.id || 'unknown',
      },
      track: this.mapTrack(item.track),
    };
  }
}

// Singleton instance
export const spotifyService = new SpotifyService();
