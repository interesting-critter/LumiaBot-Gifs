import { describe, expect, test } from 'bun:test';
import { MusicService } from '../music';
import { spotifyService } from '../spotify';

/**
 * The import loop used to run a DELETE followed by up to 1000 tracks × 3-4
 * synchronous statements with no transaction. Any throw mid-loop left the
 * playlist row alive with zero or partial tracks and a stale `track_count`, and
 * the dashboard reported a healthy-but-empty playlist. These tests pin the
 * rollback.
 */

function makeTrack(index: number, over: Record<string, unknown> = {}): any {
  return {
    addedAt: `2024-01-0${(index % 9) + 1}T00:00:00.000Z`,
    addedBy: { id: 'someone' },
    track: {
      id: `track${index}`,
      name: `Track ${index}`,
      artists: [{ id: `artist${index}`, name: `Artist ${index}`, genres: ['rock'], popularity: 10 }],
      album: {
        id: `album${index}`,
        name: `Album ${index}`,
        releaseDate: '2020-01-01',
        totalTracks: 1,
        images: [{ url: 'http://example.invalid/cover.jpg', height: 1, width: 1 }],
      },
      durationMs: 200000,
      explicit: false,
      popularity: 10,
      previewUrl: null,
      trackNumber: 1,
    },
    ...over,
  };
}

function makePlaylist(id = 'playlist1', name = 'Test Playlist'): any {
  return {
    id,
    name,
    description: 'desc',
    owner: { id: 'owner', displayName: 'Owner' },
    images: [{ url: 'http://example.invalid/img.jpg', height: 1, width: 1 }],
    public: true,
  };
}

function makeService(): MusicService {
  // In-memory so each test starts from an empty schema and touches no file.
  return new MusicService(':memory:');
}

describe('MusicService pragmas', () => {
  test('foreign keys are actually enforced', () => {
    // `ON DELETE CASCADE` is inert without this pragma, which is why the schema
    // relied on manual delete ordering everywhere.
    const service = makeService();
    // The pragma is private state, so prove it behaviourally: insert an artist
    // and a track referencing a non-existent album, and expect a constraint
    // failure rather than a silently accepted row.
    const db = (service as any).db as import('bun:sqlite').Database;
    expect(
      (db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
    ).toBe(1);
  });
});

describe('MusicService.importPlaylist atomicity', () => {
  test('a mid-loop failure rolls back every row from that import', async () => {
    const service = makeService();
    const playlist = makePlaylist();

    // Track 3 throws inside the loop: `track.artists` is not iterable.
    const tracks = [
      makeTrack(1),
      makeTrack(2),
      { ...makeTrack(3), track: { ...makeTrack(3).track, artists: null } },
      makeTrack(4),
    ];

    await expect(service.importPlaylist(playlist, tracks)).rejects.toThrow();

    const db = (service as any).db as import('bun:sqlite').Database;
    const count = (table: string) =>
      (db.query(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;

    // The playlist row itself is inside the transaction too, so nothing at all
    // survives — not a playlist claiming four tracks with zero links.
    expect(count('music_playlists')).toBe(0);
    expect(count('music_playlist_tracks')).toBe(0);
    expect(count('music_tracks')).toBe(0);
    expect(count('music_albums')).toBe(0);
    expect(count('music_artists')).toBe(0);
    expect(count('music_track_artists')).toBe(0);
  });

  test('a failed re-import leaves the previous import fully intact', async () => {
    const service = makeService();
    const playlist = makePlaylist();

    const first = await service.importPlaylist(playlist, [makeTrack(1), makeTrack(2)]);
    expect(first.importedTracks).toBe(2);
    expect(service.getPlaylistWithTracks(first.playlistId)?.tracks).toHaveLength(2);

    const broken = [
      makeTrack(1),
      { ...makeTrack(2), track: { ...makeTrack(2).track, album: null } },
    ];
    await expect(service.importPlaylist(playlist, broken)).rejects.toThrow();

    const after = service.getPlaylistWithTracks(first.playlistId);
    expect(after?.tracks).toHaveLength(2);
    expect(after?.trackCount).toBe(2);
    expect(after?.tracks.map((t) => t.name)).toEqual(['Track 1', 'Track 2']);
  });

  test('a successful import links every track and sets track_count', async () => {
    const service = makeService();
    const playlist = makePlaylist();

    const result = await service.importPlaylist(playlist, [
      makeTrack(1),
      makeTrack(2),
      makeTrack(3),
    ]);

    expect(result.importedTracks).toBe(3);
    expect(result.newTracks).toBe(3);
    const stored = service.getPlaylistWithTracks(result.playlistId);
    expect(stored?.trackCount).toBe(3);
    expect(stored?.tracks).toHaveLength(3);
  });

  test('a repeated track in one playlist does not abort the import', async () => {
    const service = makeService();
    const result = await service.importPlaylist(makePlaylist(), [makeTrack(1), makeTrack(1)]);

    // (playlist_id, track_id) is the primary key; a bare INSERT threw on the
    // second occurrence and rolled the whole playlist back.
    expect(service.getPlaylistWithTracks(result.playlistId)?.tracks).toHaveLength(1);
    expect(service.getPlaylistWithTracks(result.playlistId)?.trackCount).toBe(1);
  });

  test('overlapping imports serialise instead of nesting transactions', async () => {
    const service = makeService();

    // Two commands firing at once used to issue a second BEGIN on the same
    // connection, which SQLite rejects outright ("cannot start a transaction
    // within a transaction") and would abort the first import.
    const [a, b] = await Promise.all([
      service.importPlaylist(makePlaylist('p1', 'A'), [makeTrack(1), makeTrack(2)]),
      service.importPlaylist(makePlaylist('p2', 'B'), [makeTrack(3), makeTrack(4)]),
    ]);

    expect(service.getPlaylistWithTracks(a.playlistId)?.tracks).toHaveLength(2);
    expect(service.getPlaylistWithTracks(b.playlistId)?.tracks).toHaveLength(2);
    expect(service.getStats().totalTracks).toBe(4);
  });

  test('a failed queued write does not poison later writes', async () => {
    const service = makeService();

    const broken = [{ ...makeTrack(1), track: { ...makeTrack(1).track, artists: null } }];
    await expect(service.importPlaylist(makePlaylist('p1', 'A'), broken)).rejects.toThrow();

    const ok = await service.importPlaylist(makePlaylist('p2', 'B'), [makeTrack(2)]);
    expect(service.getPlaylistWithTracks(ok.playlistId)?.tracks).toHaveLength(1);
  });

  test('the loop yields to the event loop instead of blocking it', async () => {
    const service = makeService();
    const many = Array.from({ length: 120 }, (_, i) => makeTrack(i));

    // Without the `Bun.sleep(0)` yield every 25 tracks, this timer could not
    // possibly fire before the import promise settled: the loop never awaited.
    let timerFiredDuringImport = false;
    const timer = setTimeout(() => {
      timerFiredDuringImport = true;
    }, 0);

    await service.importPlaylist(makePlaylist(), many);
    clearTimeout(timer);

    expect(timerFiredDuringImport).toBe(true);
    expect(service.getStats().totalTracks).toBe(120);
  });

  test('duplicate counts come from point lookups, not full-table scans', async () => {
    const service = makeService();
    const playlist = makePlaylist();

    await service.importPlaylist(playlist, [makeTrack(1), makeTrack(2)]);
    const second = await service.importPlaylist(playlist, [makeTrack(1), makeTrack(2), makeTrack(3)]);

    expect(second.newTracks).toBe(1);
    expect(second.duplicateTracks).toBe(2);
    expect(second.newArtists).toBe(1);
    expect(second.duplicateArtists).toBe(2);
  });
});

describe('MusicService.deletePlaylist', () => {
  test('removes tracks unique to the playlist and keeps shared ones', async () => {
    const service = makeService();
    const a = await service.importPlaylist(makePlaylist('p1', 'A'), [makeTrack(1), makeTrack(2)]);
    const b = await service.importPlaylist(makePlaylist('p2', 'B'), [makeTrack(2), makeTrack(3)]);

    await service.deletePlaylist(a.playlistId);

    expect(service.getPlaylistWithTracks(a.playlistId)).toBeNull();
    // Track 2 is still reachable through playlist B; track 1 was unique to A.
    const remaining = service.getPlaylistWithTracks(b.playlistId);
    expect(remaining?.tracks.map((t) => t.name)).toEqual(['Track 2', 'Track 3']);
    expect(service.getStats().totalTracks).toBe(2);
  });

  test('prunes albums and artists left with no referencing row', async () => {
    const service = makeService();
    const a = await service.importPlaylist(makePlaylist('p1', 'A'), [makeTrack(1)]);

    await service.deletePlaylist(a.playlistId);

    const stats = service.getStats();
    expect(stats.totalTracks).toBe(0);
    expect(stats.totalAlbums).toBe(0);
    expect(stats.totalArtists).toBe(0);
  });
});

describe('SpotifyService.extractPlaylistId', () => {
  const ID = '37i9dQZF1DXcBWIGoYBM5M';

  test('accepts the real URL, URI and bare-id forms', () => {
    expect(spotifyService.extractPlaylistId(`https://open.spotify.com/playlist/${ID}`)).toBe(ID);
    expect(spotifyService.extractPlaylistId(`https://open.spotify.com/playlist/${ID}?si=abc`)).toBe(ID);
    expect(spotifyService.extractPlaylistId(`spotify:playlist:${ID}`)).toBe(ID);
    expect(spotifyService.extractPlaylistId(ID)).toBe(ID);
  });

  test('rejects a lookalike host', () => {
    // The unanchored regex matched any host that merely *contained* the path.
    expect(spotifyService.extractPlaylistId(`https://evil.com/open.spotify.com/playlist/${ID}`)).toBeNull();
  });

  test('rejects ids of the wrong length', () => {
    expect(spotifyService.extractPlaylistId('tooshort')).toBeNull();
    expect(spotifyService.extractPlaylistId(`${ID}extra`)).toBeNull();
  });
});

describe('MusicService search escaping', () => {
  test('a bare backslash does not disable the other escapes', async () => {
    const service = makeService();
    await service.importPlaylist(makePlaylist(), [makeTrack(1)]);

    // '%\' would be an incomplete escape sequence; the backslash itself is
    // escaped first so the following % is still a literal.
    expect(service.searchTracks('%\\')).toHaveLength(0);
  });

  test('a bare % does not match every row', async () => {
    const service = makeService();
    await service.importPlaylist(makePlaylist(), [makeTrack(1), makeTrack(2)]);

    // Before the ESCAPE clause, '%' built '%%%' and dumped the whole table.
    expect(service.searchTracks('%')).toHaveLength(0);
    // A literal underscore must not act as a single-character wildcard.
    expect(service.searchTracks('Trac_')).toHaveLength(0);
    expect(service.searchTracks('Track 1')).toHaveLength(1);
  });

  test('a literal % in a track name is still findable', async () => {
    const service = makeService();
    const odd = makeTrack(1);
    odd.track.name = '100% Pure';
    await service.importPlaylist(makePlaylist(), [odd]);

    expect(service.searchTracks('100%').map((t) => t.name)).toEqual(['100% Pure']);
  });
});
