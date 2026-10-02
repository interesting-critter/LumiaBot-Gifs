import { Database } from 'bun:sqlite';
import { dbPath } from '../utils/paths';
import { intEnv } from '../utils/env';
import { escapeLikeWildcards } from '../utils/sql-escape';

// Re-exported so the historical import path keeps working. The implementation
// now lives in one place (see the note there): `services/user-memory.ts` had a
// byte-identical copy, which is exactly the failure mode a security helper
// should not have.
export { escapeLikeWildcards };

/**
 * Tracks inserted between event-loop yields during a playlist import.
 *
 * WHY
 * ---
 * `bun:sqlite` is synchronous. The import loop issues three to four blocking
 * statements per track for up to 1000 tracks, so a naive loop pins Bun's single
 * thread for seconds: no message handling, no typing indicators, no gateway
 * heartbeat. Yielding to the event loop every N tracks keeps the bot responsive
 * while the (single, atomic) transaction stays open.
 */
const IMPORT_YIELD_EVERY = intEnv('MUSIC_IMPORT_YIELD_EVERY', 25, { min: 1, max: 1000 });

/** How long SQLite waits on a locked database before returning SQLITE_BUSY. */
const DB_BUSY_TIMEOUT_MS = intEnv('MUSIC_DB_BUSY_TIMEOUT_MS', 5000, { min: 0, max: 60000 });

/**
 * Escape the LIKE metacharacters so a user-supplied term matches literally.
 *
 * Shared implementation: see `src/utils/sql-escape.ts`.
 */

export interface MusicPlaylist {
  id?: number;
  spotifyId: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  trackCount: number;
  imageUrl?: string;
  spotifyUrl: string;
  isPublic: boolean;
  importedAt: string;
  lastUpdated: string;
}

export interface MusicTrack {
  id?: number;
  spotifyId: string;
  name: string;
  albumId: number;
  durationMs: number;
  explicit: boolean;
  popularity: number;
  previewUrl?: string;
  trackNumber: number;
  spotifyUrl: string;
}

export interface MusicArtist {
  id?: number;
  spotifyId: string;
  name: string;
  genres: string[];
  popularity: number;
  spotifyUrl: string;
}

export interface MusicAlbum {
  id?: number;
  spotifyId: string;
  name: string;
  releaseDate: string;
  totalTracks: number;
  imageUrl?: string;
  spotifyUrl: string;
}

export interface MusicTrackWithDetails extends MusicTrack {
  artists: MusicArtist[];
  album: MusicAlbum;
  genres: string[];
}

export interface PlaylistWithTracks extends MusicPlaylist {
  tracks: MusicTrackWithDetails[];
}

export interface MusicStats {
  totalPlaylists: number;
  totalTracks: number;
  totalArtists: number;
  totalAlbums: number;
  topGenres: Array<{ genre: string; count: number }>;
  topArtists: Array<{ artist: MusicArtist; trackCount: number }>;
}

/** What {@link MusicService.importPlaylist} reports back to the command layer. */
export interface ImportPlaylistResult {
  playlistId: number;
  importedTracks: number;
  newArtists: number;
  newAlbums: number;
  newTracks: number;
  duplicateArtists: number;
  duplicateAlbums: number;
  duplicateTracks: number;
}

export class MusicService {
  private db: Database;
  /**
   * Serialises `importPlaylist` / `clearPlaylistAndTracks`.
   *
   * Both open an explicit transaction on one shared synchronous connection, and
   * SQLite rejects a nested `BEGIN` ("cannot start a transaction within a
   * transaction"). Two overlapping `/music import` commands would have done
   * exactly that. Chaining onto this promise makes the second caller wait its
   * turn instead of corrupting the first one's transaction.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * @param dbFile Database location. Defaults to {@link dbPath} so the file is
   *   anchored to the repo's `data/` directory instead of the process CWD —
   *   a CWD-relative `'music.db'` silently creates a fresh empty database when
   *   the bot is started from any other directory. Tests pass `':memory:'`.
   */
  constructor(dbFile: string = dbPath('music.db')) {
    this.db = new Database(dbFile);
    this.initDatabase();
    console.log('🎵 [MUSIC] Service initialized with persistent storage');
  }

  private initDatabase(): void {
    // `ON DELETE CASCADE` is inert unless `foreign_keys` is ON. Without this
    // pragma SQLite silently ignores every FK clause in the schema below and
    // correctness depends entirely on manual delete ordering in code.
    this.db.run('PRAGMA foreign_keys = ON');
    // WAL lets the dashboard read while an import transaction is open instead
    // of returning SQLITE_BUSY; the busy timeout covers the remaining writers.
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);

    // Create playlists table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        owner_id TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        track_count INTEGER DEFAULT 0,
        image_url TEXT,
        spotify_url TEXT NOT NULL,
        is_public BOOLEAN DEFAULT 1,
        imported_at TEXT NOT NULL,
        last_updated TEXT NOT NULL
      )
    `);

    // Create artists table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        genres TEXT NOT NULL, -- JSON array
        popularity INTEGER DEFAULT 0,
        spotify_url TEXT NOT NULL
      )
    `);

    // Create albums table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        release_date TEXT,
        total_tracks INTEGER,
        image_url TEXT,
        spotify_url TEXT NOT NULL
      )
    `);

    // Create tracks table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        album_id INTEGER NOT NULL,
        duration_ms INTEGER,
        explicit BOOLEAN DEFAULT 0,
        popularity INTEGER DEFAULT 0,
        preview_url TEXT,
        track_number INTEGER,
        spotify_url TEXT NOT NULL,
        FOREIGN KEY (album_id) REFERENCES music_albums(id)
      )
    `);

    // Create track-artists junction table (many-to-many)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_track_artists (
        track_id INTEGER NOT NULL,
        artist_id INTEGER NOT NULL,
        PRIMARY KEY (track_id, artist_id),
        FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE,
        FOREIGN KEY (artist_id) REFERENCES music_artists(id) ON DELETE CASCADE
      )
    `);

    // Create playlist-tracks junction table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_playlist_tracks (
        playlist_id INTEGER NOT NULL,
        track_id INTEGER NOT NULL,
        added_at TEXT,
        position INTEGER,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES music_playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for efficient querying
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_playlist_spotify_id ON music_playlists(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_artist_spotify_id ON music_artists(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_album_spotify_id ON music_albums(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_track_spotify_id ON music_tracks(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_track_album ON music_tracks(album_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_track_name ON music_tracks(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_artist_name ON music_artists(name)`);

    console.log('🎵 [MUSIC] Database initialized');
  }

  /**
   * Resolve a Spotify id to its local row id, inserting or refreshing the row on
   * first sight, and report whether this call created it.
   *
   * WHY THIS EXISTS
   * ---------------
   * Duplicate detection used to run three `SELECT spotify_id FROM <table>`
   * full-table scans per import and materialise every id in the database into a
   * `Set`. That is harmless at 10k tracks, brutal at 1M (three multi-hundred-MB
   * arrays per import), and it duplicated work the `ON CONFLICT ... RETURNING id`
   * upsert already does. The upsert alone does not say *which* branch it took, so
   * this helper does a single indexed point lookup per unique id and memoises the
   * result: a 1000-track playlist by one artist costs one lookup, not 1000.
   */
  private upsertBySpotifyId(
    table: 'music_artists' | 'music_albums' | 'music_tracks',
    spotifyId: string,
    insertSql: string,
    values: Array<string | number | null>
  ): { id: number; isNew: boolean } {
    const existing = this.db
      .query(`SELECT id FROM ${table} WHERE spotify_id = ?`)
      .get(spotifyId) as { id: number } | null;

    const row = this.db.query(insertSql).get(...values) as { id: number };

    return { id: row.id, isNew: existing === null };
  }

  /**
   * Import a playlist with all its tracks
   * Handles duplicates: skips existing artists/albums/tracks, only links to playlist
   *
   * ATOMICITY
   * ---------
   * The playlist row, the `DELETE` of the previous track links and every insert
   * run inside a single transaction, so a malformed track, a full disk or a
   * Ctrl-C mid-loop leaves the previous import fully intact instead of a playlist
   * row that claims N tracks and links none of them. The loop yields to the event
   * loop between chunks (`Bun.sleep(0)`) so the bot stays responsive during a
   * 1000-track import; yielding does not commit, so the transaction still covers
   * the whole import.
   */
  async importPlaylist(
    spotifyPlaylist: any,
    spotifyTracks: any[]
  ): Promise<ImportPlaylistResult> {
    return this.enqueueWrite(() => this.importPlaylistUnsafe(spotifyPlaylist, spotifyTracks));
  }

  /** Run `task` after every previously queued write has settled. */
  private enqueueWrite<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task, task);
    // The queue itself must never reject, or every later write would be skipped.
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async importPlaylistUnsafe(
    spotifyPlaylist: any,
    spotifyTracks: any[]
  ): Promise<ImportPlaylistResult> {
    const now = new Date().toISOString();

    // Check if playlist already exists
    const existingPlaylist = this.getPlaylistBySpotifyId(spotifyPlaylist.id);
    const isReimport = !!existingPlaylist;

    let playlistId = 0;
    let importedTracks = 0;
    let newArtists = 0;
    let newAlbums = 0;
    let newTracks = 0;
    let duplicateArtists = 0;
    let duplicateAlbums = 0;
    let duplicateTracks = 0;

    // Per-import memo so a repeated artist/album/track is one statement, not one
    // per occurrence. Keyed by the same value the lookup above used.
    const artistCache = new Map<string, { id: number; isNew: boolean }>();
    const albumCache = new Map<string, { id: number; isNew: boolean }>();
    const trackCache = new Map<string, { id: number; isNew: boolean }>();

    // Yields inside the transaction let other handlers read this connection, so
    // they observe uncommitted rows. That is a deliberate trade: blocking the
    // loop for seconds is worse than a same-tick read seeing an in-flight import.
    this.db.run('BEGIN');

    try {
      // Insert or update playlist
      const playlistResult = this.db.query(`
        INSERT INTO music_playlists 
        (spotify_id, name, description, owner_id, owner_name, track_count, image_url, spotify_url, is_public, imported_at, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(spotify_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          track_count = excluded.track_count,
          image_url = excluded.image_url,
          last_updated = excluded.last_updated
        RETURNING id
      `).get(
        spotifyPlaylist.id,
        spotifyPlaylist.name,
        spotifyPlaylist.description || '',
        spotifyPlaylist.owner.id,
        spotifyPlaylist.owner.displayName,
        spotifyTracks.length,
        spotifyPlaylist.images[0]?.url || null,
        `https://open.spotify.com/playlist/${spotifyPlaylist.id}`,
        spotifyPlaylist.public ? 1 : 0,
        now,
        now
      ) as { id: number };

      playlistId = playlistResult.id;

      // Clear existing playlist tracks (for re-imports)
      this.db.run('DELETE FROM music_playlist_tracks WHERE playlist_id = ?', [playlistId]);

      // Process each track
      for (let i = 0; i < spotifyTracks.length; i++) {
        const playlistTrack = spotifyTracks[i];
        const track = playlistTrack.track;

        // Insert artists (or get existing)
        const artistIds: number[] = [];
        for (const artist of track.artists) {
          let resolved = artistCache.get(artist.id);
          if (!resolved) {
            resolved = this.upsertBySpotifyId(
              'music_artists',
              artist.id,
              `
                INSERT INTO music_artists (spotify_id, name, genres, popularity, spotify_url)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(spotify_id) DO UPDATE SET
                  name = excluded.name,
                  genres = excluded.genres,
                  popularity = excluded.popularity
                RETURNING id
              `,
              [
                artist.id,
                artist.name,
                JSON.stringify(artist.genres || []),
                artist.popularity || 0,
                `https://open.spotify.com/artist/${artist.id}`,
              ]
            );
            artistCache.set(artist.id, resolved);
          }

          artistIds.push(resolved.id);

          if (resolved.isNew) {
            newArtists++;
          } else {
            duplicateArtists++;
          }
        }

        // Insert album (or get existing)
        let album = albumCache.get(track.album.id);
        if (!album) {
          album = this.upsertBySpotifyId(
            'music_albums',
            track.album.id,
            `
              INSERT INTO music_albums (spotify_id, name, release_date, total_tracks, image_url, spotify_url)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(spotify_id) DO UPDATE SET
                name = excluded.name,
                release_date = excluded.release_date,
                total_tracks = excluded.total_tracks,
                image_url = excluded.image_url
              RETURNING id
            `,
            [
              track.album.id,
              track.album.name,
              track.album.releaseDate,
              track.album.totalTracks,
              track.album.images[0]?.url || null,
              `https://open.spotify.com/album/${track.album.id}`,
            ]
          );
          albumCache.set(track.album.id, album);
        }

        if (album.isNew) {
          newAlbums++;
        } else {
          duplicateAlbums++;
        }

        // Insert track (or get existing)
        let inserted = trackCache.get(track.id);
        if (!inserted) {
          inserted = this.upsertBySpotifyId(
            'music_tracks',
            track.id,
            `
              INSERT INTO music_tracks 
              (spotify_id, name, album_id, duration_ms, explicit, popularity, preview_url, track_number, spotify_url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(spotify_id) DO UPDATE SET
                name = excluded.name,
                album_id = excluded.album_id,
                duration_ms = excluded.duration_ms,
                explicit = excluded.explicit,
                popularity = excluded.popularity,
                preview_url = excluded.preview_url,
                track_number = excluded.track_number
              RETURNING id
            `,
            [
              track.id,
              track.name,
              album.id,
              track.durationMs,
              track.explicit ? 1 : 0,
              track.popularity,
              track.previewUrl,
              track.trackNumber,
              `https://open.spotify.com/track/${track.id}`,
            ]
          );
          trackCache.set(track.id, inserted);
        }

        if (inserted.isNew) {
          newTracks++;
        } else {
          duplicateTracks++;
        }

        // Link track to artists
        for (const artistId of artistIds) {
          this.db.run(`
            INSERT OR IGNORE INTO music_track_artists (track_id, artist_id)
            VALUES (?, ?)
          `, [inserted.id, artistId]);
        }

        // Link track to playlist. A playlist may legitimately contain the same
        // track twice and (playlist_id, track_id) is the primary key, so this
        // must be idempotent — a bare INSERT threw on the first duplicate. The
        // reported count is the number of *links* actually created, so
        // `track_count` always matches the rows in the junction table.
        const linkResult = this.db.run(`
          INSERT INTO music_playlist_tracks (playlist_id, track_id, added_at, position)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(playlist_id, track_id) DO NOTHING
        `, [playlistId, inserted.id, playlistTrack.addedAt, i]);

        if (linkResult.changes > 0) {
          importedTracks++;
        }

        // Hand the event loop back periodically: bun:sqlite is synchronous, so
        // without this the 1000-iteration loop blocks messages, typing
        // indicators and gateway heartbeats for its whole duration.
        if ((i + 1) % IMPORT_YIELD_EVERY === 0) {
          await Bun.sleep(0);
        }
      }

      // Update actual track count
      this.db.run(
        'UPDATE music_playlists SET track_count = ? WHERE id = ?',
        [importedTracks, playlistId]
      );

      this.db.run('COMMIT');
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Ignore rollback failures; the original error is what matters.
      }
      console.error(`❌ [MUSIC] Import of "${spotifyPlaylist.name}" rolled back:`, error);
      throw error;
    }

    const actionType = isReimport ? 'Updated' : 'Imported';
    console.log(`🎵 [MUSIC] ${actionType} playlist "${spotifyPlaylist.name}"`);
    console.log(`   📊 Tracks: ${importedTracks} (${newTracks} new, ${duplicateTracks} existing)`);
    console.log(`   🎤 Artists: ${newArtists} new, ${duplicateArtists} existing`);
    console.log(`   💿 Albums: ${newAlbums} new, ${duplicateAlbums} existing`);

    return { 
      playlistId, 
      importedTracks, 
      newArtists, 
      newAlbums,
      newTracks,
      duplicateArtists,
      duplicateAlbums,
      duplicateTracks
    };
  }

  /**
   * Get all playlists
   */
  getAllPlaylists(): MusicPlaylist[] {
    const results = this.db.query(`
      SELECT * FROM music_playlists
      ORDER BY imported_at DESC
    `).all() as any[];

    return results.map(r => this.mapRowToPlaylist(r));
  }

  /**
   * Get playlist by ID with all tracks
   */
  getPlaylistWithTracks(playlistId: number): PlaylistWithTracks | null {
    const playlist = this.db.query('SELECT * FROM music_playlists WHERE id = ?').get(playlistId) as any;
    if (!playlist) return null;

    const tracks = this.db.query(`
      SELECT 
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_playlist_tracks pt ON t.id = pt.track_id
      JOIN music_albums a ON t.album_id = a.id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position
    `).all(playlistId) as any[];

    const tracksWithDetails: MusicTrackWithDetails[] = tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const genres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres,
      };
    });

    return {
      ...this.mapRowToPlaylist(playlist),
      tracks: tracksWithDetails,
    };
  }

  /**
   * Get playlist by Spotify ID
   */
  getPlaylistBySpotifyId(spotifyId: string): MusicPlaylist | null {
    const result = this.db.query('SELECT * FROM music_playlists WHERE spotify_id = ?').get(spotifyId) as any;
    return result ? this.mapRowToPlaylist(result) : null;
  }

  /**
   * Delete a playlist along with everything that only existed because of it.
   *
   * A track shared with another playlist is kept (and stays linked to the other
   * playlist); a track unique to this one is removed, and any album or artist
   * left with no referencing track/row is pruned too. Without that pruning the
   * `music_tracks`/`music_albums`/`music_artists` tables grow monotonically
   * forever: every `/music delete` orphaned its rows and nothing ever collected
   * them, even though `clearAll` was the only way to reclaim the space.
   */
  deletePlaylist(playlistId: number): Promise<{ tracksRemoved: number }> {
    return this.clearPlaylistAndTracks(playlistId);
  }

  /**
   * Get music statistics
   */
  getStats(): MusicStats {
    const totalPlaylists = (this.db.query('SELECT COUNT(*) as count FROM music_playlists').get() as { count: number }).count;
    const totalTracks = (this.db.query('SELECT COUNT(*) as count FROM music_tracks').get() as { count: number }).count;
    const totalArtists = (this.db.query('SELECT COUNT(*) as count FROM music_artists').get() as { count: number }).count;
    const totalAlbums = (this.db.query('SELECT COUNT(*) as count FROM music_albums').get() as { count: number }).count;

    // Get genre counts
    const genreResults = this.db.query('SELECT genres FROM music_artists').all() as Array<{ genres: string }>;
    const genreCounts = new Map<string, number>();
    for (const row of genreResults) {
      const genres = JSON.parse(row.genres || '[]');
      for (const genre of genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }

    const topGenres = Array.from(genreCounts.entries())
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Get top artists by track count
    const artistTrackCounts = this.db.query(`
      SELECT ar.id, ar.spotify_id, ar.name, ar.genres, ar.popularity, ar.spotify_url, COUNT(ta.track_id) as track_count
      FROM music_artists ar
      JOIN music_track_artists ta ON ar.id = ta.artist_id
      GROUP BY ar.id
      ORDER BY track_count DESC
      LIMIT 10
    `).all() as any[];

    const topArtists = artistTrackCounts.map(row => ({
      artist: this.mapRowToArtist(row),
      trackCount: row.track_count,
    }));

    return {
      totalPlaylists,
      totalTracks,
      totalArtists,
      totalAlbums,
      topGenres,
      topArtists,
    };
  }

  hasTracks(): boolean {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM music_tracks'
    ).get() as { count: number };

    return result.count > 0;
  }

  getToolSummary(limit: number = 5): string {
    const stats = this.getStats();
    if (stats.totalTracks === 0) {
      return 'No Spotify playlists have been imported yet.';
    }

    const playlists = this.getAllPlaylists()
      .slice(0, limit)
      .map((playlist) => `"${playlist.name}"`);
    const playlistSummary = playlists.length > 0 ? playlists.join(', ') : 'no playlist names available';

    const topGenres = stats.topGenres
      .slice(0, 5)
      .map((genre) => genre.genre);
    const genreSummary = topGenres.length > 0 ? topGenres.join(', ') : 'mixed genres';

    return `Spotify library has ${stats.totalTracks} tracks from ${stats.totalPlaylists} playlists and ${stats.totalArtists} artists. Playlist preview: ${playlistSummary}. Top genres: ${genreSummary}.`;
  }

  /**
   * Get random tracks for music taste queries
   */
  getRandomTracks(count: number = 10): MusicTrackWithDetails[] {
    const tracks = this.db.query(`
      SELECT 
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_albums a ON t.album_id = a.id
      ORDER BY RANDOM()
      LIMIT ?
    `).all(count) as any[];

    return tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const genres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres,
      };
    });
  }

  /**
   * Get tracks by genre
   */
  getTracksByGenre(genre: string, limit: number = 10): MusicTrackWithDetails[] {
    const tracks = this.db.query(`
      SELECT DISTINCT
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_albums a ON t.album_id = a.id
      JOIN music_track_artists ta ON t.id = ta.track_id
      JOIN music_artists ar ON ta.artist_id = ar.id
      WHERE LOWER(ar.genres) LIKE LOWER(?) ESCAPE '\\'
      ORDER BY RANDOM()
      LIMIT ?
    `).all(`%"${escapeLikeWildcards(genre)}"%`, limit) as any[];

    return tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const trackGenres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres: trackGenres,
      };
    });
  }

  /**
   * Search tracks by name or artist
   */
  searchTracks(query: string, limit: number = 10): MusicTrackWithDetails[] {
    const searchTerm = `%${escapeLikeWildcards(query.toLowerCase())}%`;

    const tracks = this.db.query(`
      SELECT DISTINCT
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_albums a ON t.album_id = a.id
      JOIN music_track_artists ta ON t.id = ta.track_id
      JOIN music_artists ar ON ta.artist_id = ar.id
      WHERE LOWER(t.name) LIKE ? ESCAPE '\\' OR LOWER(ar.name) LIKE ? ESCAPE '\\'
      ORDER BY t.popularity DESC
      LIMIT ?
    `).all(searchTerm, searchTerm, limit) as any[];

    return tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const genres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres,
      };
    });
  }

  searchLibrary(query: string, limit: number = 10): MusicTrackWithDetails[] {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const trackMatches = this.searchTracks(trimmedQuery, limit);
    const normalizedQuery = trimmedQuery.toLowerCase();
    const genreMatches = this.getAllGenres().filter((genre) => {
      const normalizedGenre = genre.toLowerCase();
      return normalizedGenre === normalizedQuery ||
        normalizedGenre.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedGenre);
    });

    const results = new Map<string, MusicTrackWithDetails>();

    for (const track of trackMatches) {
      results.set(track.spotifyId, track);
      if (results.size >= limit) {
        return Array.from(results.values()).slice(0, limit);
      }
    }

    for (const genre of genreMatches.slice(0, 3)) {
      const genreTracks = this.getTracksByGenre(genre, Math.max(3, Math.ceil(limit / Math.max(genreMatches.length, 1))));
      for (const track of genreTracks) {
        results.set(track.spotifyId, track);
        if (results.size >= limit) {
          return Array.from(results.values()).slice(0, limit);
        }
      }
    }

    return Array.from(results.values()).slice(0, limit);
  }

  /**
   * Get all unique genres across all artists
   */
  getAllGenres(): string[] {
    const results = this.db.query('SELECT genres FROM music_artists').all() as Array<{ genres: string }>;
    const allGenres = new Set<string>();
    
    for (const row of results) {
      const genres = JSON.parse(row.genres || '[]');
      genres.forEach((g: string) => allGenres.add(g));
    }

    return Array.from(allGenres).sort();
  }

  // Mapping helpers
  private mapRowToPlaylist(row: any): MusicPlaylist {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      trackCount: row.track_count,
      imageUrl: row.image_url,
      spotifyUrl: row.spotify_url,
      isPublic: row.is_public === 1,
      importedAt: row.imported_at,
      lastUpdated: row.last_updated,
    };
  }

  private mapRowToTrack(row: any): MusicTrack {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      albumId: row.album_id,
      durationMs: row.duration_ms,
      explicit: row.explicit === 1,
      popularity: row.popularity,
      previewUrl: row.preview_url,
      trackNumber: row.track_number,
      spotifyUrl: row.spotify_url,
    };
  }

  private mapRowToArtist(row: any): MusicArtist {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      genres: JSON.parse(row.genres || '[]'),
      popularity: row.popularity,
      spotifyUrl: row.spotify_url,
    };
  }

  private mapRowToAlbum(row: any): MusicAlbum {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      releaseDate: row.release_date,
      totalTracks: row.total_tracks,
      imageUrl: row.image_url,
      spotifyUrl: row.spotify_url,
    };
  }

  /**
   * Clear all music data from the database
   * WARNING: This deletes EVERYTHING - playlists, tracks, artists, albums
   * Returns statistics about what was deleted
   */
  clearAll(): { playlistsDeleted: number; tracksDeleted: number; artistsDeleted: number; albumsDeleted: number } {
    const stats = this.getStats();
    
    // Delete in order to respect foreign key constraints
    // 1. Delete junction tables first
    this.db.run('DELETE FROM music_playlist_tracks');
    this.db.run('DELETE FROM music_track_artists');
    
    // 2. Delete main tables
    this.db.run('DELETE FROM music_tracks');
    this.db.run('DELETE FROM music_playlists');
    this.db.run('DELETE FROM music_albums');
    this.db.run('DELETE FROM music_artists');
    
    console.log(`🎵 [MUSIC] CLEARED ALL MUSIC DATA:`);
    console.log(`   📁 Playlists deleted: ${stats.totalPlaylists}`);
    console.log(`   🎵 Tracks deleted: ${stats.totalTracks}`);
    console.log(`   🎤 Artists deleted: ${stats.totalArtists}`);
    console.log(`   💿 Albums deleted: ${stats.totalAlbums}`);
    
    return {
      playlistsDeleted: stats.totalPlaylists,
      tracksDeleted: stats.totalTracks,
      artistsDeleted: stats.totalArtists,
      albumsDeleted: stats.totalAlbums,
    };
  }

  /**
   * Clear all data for a specific playlist and its tracks.
   * More targeted than `clearAll`: only removes tracks unique to this playlist,
   * then prunes the albums and artists that are left with no referencing row so
   * the library does not grow monotonically. Runs as one transaction so a
   * failure cannot leave the playlist deleted but its tracks still linked.
   *
   * Async because writes are serialised through {@link enqueueWrite}.
   */
  clearPlaylistAndTracks(playlistId: number): Promise<{ tracksRemoved: number }> {
    return this.enqueueWrite(() => this.clearPlaylistAndTracksUnsafe(playlistId));
  }

  private clearPlaylistAndTracksUnsafe(playlistId: number): { tracksRemoved: number } {
    // Get tracks that are ONLY in this playlist (not in any other playlist)
    const uniqueTracks = this.db.query(`
      SELECT pt.track_id
      FROM music_playlist_tracks pt
      WHERE pt.playlist_id = ?
      AND pt.track_id NOT IN (
        SELECT track_id
        FROM music_playlist_tracks
        WHERE playlist_id != ?
      )
    `).all(playlistId, playlistId) as Array<{ track_id: number }>;

    const trackIds = uniqueTracks.map(t => t.track_id);

    this.db.run('BEGIN');
    try {
      // Remove playlist associations
      this.db.run('DELETE FROM music_playlist_tracks WHERE playlist_id = ?', [playlistId]);

      // Remove the playlist
      this.db.run('DELETE FROM music_playlists WHERE id = ?', [playlistId]);

      // Remove tracks that were unique to this playlist
      let tracksRemoved = 0;
      if (trackIds.length > 0) {
        // Chunked so a large playlist cannot blow the SQLITE_MAX_VARIABLE_NUMBER
        // limit (999 host parameters on some builds) on the IN (...) list.
        for (let i = 0; i < trackIds.length; i += 500) {
          const chunk = trackIds.slice(i, i + 500);
          const placeholders = chunk.map(() => '?').join(',');
          // `music_track_artists` rows cascade via ON DELETE CASCADE now that
          // `PRAGMA foreign_keys = ON`; delete explicitly anyway so the order is
          // correct even on a database opened before the pragma existed.
          this.db.run(`DELETE FROM music_track_artists WHERE track_id IN (${placeholders})`, chunk);
          this.db.run(`DELETE FROM music_tracks WHERE id IN (${placeholders})`, chunk);
        }
        tracksRemoved = trackIds.length;
      }

      // Prune albums nobody references any more (music_tracks.album_id is a
      // foreign key, so an album with live tracks cannot be deleted).
      this.db.run(`
        DELETE FROM music_albums
        WHERE id NOT IN (SELECT DISTINCT album_id FROM music_tracks)
      `);
      // Prune artists that are no longer linked to any track.
      this.db.run(`
        DELETE FROM music_artists
        WHERE id NOT IN (SELECT DISTINCT artist_id FROM music_track_artists)
      `);

      this.db.run('COMMIT');

      console.log(`🎵 [MUSIC] Cleared playlist ${playlistId} and ${tracksRemoved} unique tracks`);

      return { tracksRemoved };
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Ignore rollback failures; surface the original error instead.
      }
      throw error;
    }
  }
}

// Singleton instance
export const musicService = new MusicService();
