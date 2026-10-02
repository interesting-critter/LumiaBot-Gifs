/**
 * LRCLib lyrics service (https://lrclib.net)
 *
 * Fetches lyrics for a track using a two-tier strategy that mirrors the
 * Lumiverse-SpotifyControls implementation:
 *   1. Exact match via /api/get (track + artist + album + duration in seconds)
 *   2. Fallback to /api/search with a looser "{artist} {track}" query
 *
 * We currently surface plain lyrics to the bot, but the full LRCLib contract
 * (plain + synced + instrumental) is returned so callers can opt into synced
 * lyrics later without changing this service.
 */

const LRCLIB_API = 'https://lrclib.net/api';

// LRCLib asks for a descriptive User-Agent that links back to the project.
const USER_AGENT = 'BadKittyBot (https://github.com/prolix-oc/LumiaBot)';

export interface LyricsData {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental: boolean;
}

interface LrclibResponse {
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
  /** Present on `/api/search` results; absent on `/api/get`. */
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
}

/**
 * Wall-clock ceiling for an LRCLib request. Both tiers are attempted per call and
 * this runs inside the LLM tool loop, so an unbounded fetch pins the turn.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Cap on how many search results we will consider. */
const MAX_SEARCH_RESULTS = 10;

/**
 * Reduce a title/artist to a comparable form.
 *
 * Deliberately lossy: LRCLib records are community-submitted, so the same song
 * appears as `"Bohemian Rhapsody"`, `"Bohemian Rhapsody - Remastered 2011"` and
 * `"Bohemian Rhapsody (2011 Remaster)"`. Everything that carries no identifying
 * signal — punctuation, brackets, featured-artist lists, "featuring"/"ft"/
 * "with" clauses, remaster/prod suffix noise — is dropped so the comparison
 * measures whether the songs are the same, not whether the strings are equal.
 */
function normalizeTitle(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .toLowerCase()
    // Bracketed suffixes: (remastered), [live], (feat. x)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(?:feat|ft|featuring|with)\.?\b.*$/g, ' ')
    .replace(/\b(?:remaster(?:ed)?|deluxe|bonus track|radio edit|album version|single version|explicit|clean)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Is `candidate` plausibly the same track as what was asked for?
 *
 * A search hit must match on BOTH title and artist. Matching only the title
 * accepts every cover version, live take and mislabelled rip that happens to
 * share a name; matching only the artist accepts a whole discography. The
 * previous code took `results[0]` with no check at all, so the bot would
 * confidently recite someone else's lyrics.
 *
 * Either side may be absent from the payload. If LRCLib gave us nothing to
 * compare, there is no evidence either way and we accept — but that is only
 * reachable when the record carries no metadata at all, which `/api/get` does
 * not do, so in practice the fallback path always has both fields.
 */
function matchesRequest(candidate: LrclibResponse, trackName: string, artistName: string): boolean {
  const wantTitle = normalizeTitle(trackName);
  const wantArtist = normalizeTitle(artistName);
  const gotTitle = normalizeTitle(candidate.trackName);
  const gotArtist = normalizeTitle(candidate.artistName);

  if (gotTitle && wantTitle) {
    if (gotTitle !== wantTitle) {
      // Allow a strict prefix relationship in either direction so a trailing
      // stray word ("... (Live)" already stripped above, but e.g. "Song (2020)")
      // does not defeat an otherwise exact title.
      const prefix = gotTitle.startsWith(wantTitle) || wantTitle.startsWith(gotTitle);
      if (!prefix) return false;
    }
  }

  if (gotArtist && wantArtist) {
    // Artists routinely appear as "Queen", "Queen feat. Freddie Mercury" and
    // "Queen & Freddie Mercury", so require one normalised form to contain the
    // other rather than demanding equality.
    if (!gotArtist.includes(wantArtist) && !wantArtist.includes(gotArtist)) return false;
  }

  return true;
}

/**
 * Detect tracks whose only "lyric" is the literal word "instrumental" and
 * normalize them to a clean instrumental result with no lyric text.
 */
function normalizeInstrumental(result: LyricsData): LyricsData {
  if (result.instrumental) {
    return { plainLyrics: null, syncedLyrics: null, instrumental: true };
  }

  const plain = result.plainLyrics?.trim().toLowerCase();
  if (plain === 'instrumental') {
    return { plainLyrics: null, syncedLyrics: null, instrumental: true };
  }

  if (result.syncedLyrics) {
    const lines = result.syncedLyrics.split('\n').filter((l) => l.trim());
    if (lines.length === 1 && lines[0]) {
      const text = lines[0]
        .replace(/\[\d+:\d+[.:]\d+\]\s*/g, '')
        .trim()
        .toLowerCase();
      if (text === 'instrumental') {
        return { plainLyrics: null, syncedLyrics: null, instrumental: true };
      }
    }
  }

  return result;
}

/**
 * Strip leftover LRC timestamp tags (e.g. "[00:28.57] ") from plain lyrics.
 * Some community-contributed LRCLib records put timestamps in the plainLyrics
 * field; since we surface plain text to the model, clean them out.
 */
function stripTimestamps(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\[\d+:\d{2}(?:[.:]\d{1,3})?\]\s*/g, '').trim();
  return cleaned || null;
}

function toLyricsData(data: LrclibResponse): LyricsData {
  return normalizeInstrumental({
    plainLyrics: stripTimestamps(data.plainLyrics || null),
    syncedLyrics: data.syncedLyrics || null,
    instrumental: data.instrumental || false,
  });
}

export class LrclibService {
  /**
   * Fetch lyrics for a track. Returns null when nothing is found or on error.
   *
   * @param trackName   Track title (Spotify `details`)
   * @param artistName  Artist name(s) (Spotify `state`)
   * @param albumName   Album name, if known
   * @param durationSec Track length in seconds (rounded); improves exact-match accuracy
   *
   * NOTE on `durationSec`: it is only a `/api/get` query hint and is never used
   * to cross-check a response. Navidrome's now-playing entry supplies no
   * duration, so the exact tier usually runs without it. A duration is
   * deliberately NOT synthesised from the Discord embed timestamp — that value is
   * the post's age, not the track length, and comparing the two would reject
   * every correct match. When a caller genuinely knows the track length it should
   * pass it here.
   */
  async getLyrics(
    trackName: string,
    artistName: string,
    albumName?: string,
    durationSec?: number,
  ): Promise<LyricsData | null> {
    if (!trackName || !artistName) {
      return null;
    }

    // Tier 1: exact match
    try {
      const params = new URLSearchParams({
        track_name: trackName,
        artist_name: artistName,
      });
      if (albumName) params.set('album_name', albumName);
      if (durationSec && durationSec > 0) {
        params.set('duration', String(Math.round(durationSec)));
      }

      const res = await fetch(`${LRCLIB_API}/get?${params.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        const data = (await res.json()) as LrclibResponse;
        // `/api/get` is keyed on artist+track(+album+duration), so a 200 is
        // already an exact match. Guard anyway: the response is user-contributed
        // and a mismatched record is better reported as "not found" than recited.
        if (matchesRequest(data, trackName, artistName)) {
          return toLyricsData(data);
        }
        console.warn(
          `🎤 [LRCLib] Exact lookup returned a mismatched record ` +
            `("${data.trackName ?? '?'}" / "${data.artistName ?? '?'}"), treating as no match`,
        );
        return null;
      }
    } catch (error) {
      console.error('🎤 [LRCLib] Exact lookup failed:', error);
    }

    // Tier 2: search fallback
    try {
      const searchParams = new URLSearchParams({
        q: `${artistName} ${trackName}`,
      });

      const res = await fetch(`${LRCLIB_API}/search?${searchParams.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        const results = (await res.json()) as LrclibResponse[];
        if (Array.isArray(results) && results.length > 0) {
          // Scan for the first record that actually matches. Returning
          // `results[0]` unconditionally is how the bot ends up confidently
          // stating another song's lyrics: `/api/search` is fuzzy and ordered by
          // relevance, not identity, so the top hit is routinely a cover, a live
          // take, or a same-titled song by a different band.
          const candidates = results.slice(0, MAX_SEARCH_RESULTS);
          for (const candidate of candidates) {
            if (matchesRequest(candidate, trackName, artistName)) {
              if (candidate !== candidates[0]) {
                console.warn(
                  `🎤 [LRCLib] Search fallback: top hit "${candidates[0]?.trackName ?? '?'}" / ` +
                    `"${candidates[0]?.artistName ?? '?'}" did not match; used "${candidate.trackName}" / "${candidate.artistName}"`,
                );
              }
              return toLyricsData(candidate);
            }
          }
          console.warn(
            `🎤 [LRCLib] No search result matched "${trackName}" / "${artistName}" ` +
              `(${candidates.length} candidate(s) checked); returning null rather than guessing`,
          );
          return null;
        }
      }
    } catch (error) {
      console.error('🎤 [LRCLib] Search fallback failed:', error);
    }

    return null;
  }
}

// Export singleton instance
export const lrclibService = new LrclibService();
