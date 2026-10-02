import { Database } from 'bun:sqlite';
import { dbPath } from '../utils/paths';

/**
 * Anchored to `DATA_DIR` rather than a CWD-relative `'data'`, so a guild's GIF
 * toggle cannot silently reset just because the process was started from a
 * different directory. `dbPath` also owns creating the directory, which removes
 * the `mkdirSync` that used to run as an import-time side effect of this module.
 */
const db = new Database(dbPath('gif_settings.db'));

// Initialize settings table
db.run(`
  CREATE TABLE IF NOT EXISTS guild_gif_settings (
    guild_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )
`);

/**
 * Hosts we will accept a scraped GIF URL from.
 *
 * `resolveGif` regex-scrapes an `<img src="...gif">` out of the Tenor search
 * page and returns whatever host it finds. That page is not a trust boundary:
 * the URL is ultimately chosen by regex, so a page that manages to influence it
 * (or a Tenor markup change that picks up a third-party URL) can point the bot at
 * an arbitrary origin — which then gets `HEAD`ed here and, more importantly,
 * handed to Discord as a media embed. Wildcards cover Tenor's own regional CDN
 * hosts, which are siblings rather than sub-domains of `tenor.com`.
 */
const GIF_ALLOWED_HOSTS = [
  '*.tenor.com',
  'tenor.com',
  '*.tenorcdn.com',
  'tenorcdn.com',
  '*.giphy.com',
  'giphy.com',
  '*.giphycdn.com',
  'giphycdn.com',
] as const;

/** True when `rawUrl`'s host is on the Tenor/Giphy allowlist. */
function isAllowedGifHost(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === '') return false;

  return GIF_ALLOWED_HOSTS.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const base = allowed.slice(2);
      // Dot boundary, so `evil-tenor.com` cannot pass as `tenor.com`.
      return hostname.endsWith(`.${base}`) && hostname.length > base.length + 1;
    }
    return hostname === allowed || hostname.endsWith(`.${allowed}`);
  });
}

const gifDirectivePatterns = [
  /(?:^|\n)[ \t]*```(?:xml|html)?[ \t]*\n[ \t]*<gif\s*>\s*([^<>\r\n]+?)\s*<\/gif\s*>[ \t]*\n[ \t]*```[ \t]*$/i,
  /<gif\s*>\s*([^<>\r\n]+?)\s*<\/gif\s*>/i,
  /<(?:gif[_-]?query|tenor)\s*>\s*([^<>\r\n]+?)\s*<\/(?:gif[_-]?query|tenor)\s*>/i,
  /\[gif\]\s*([^\[\]\r\n]+?)\s*\[\/gif\]/i,
  /(?:^|\n)[ \t]*<gif\s*>\s*([^<>\r\n]+?)\s*(?:<\/gif\s*)?>?[ \t]*$/i,
  /(?:^|\n)[ \t]*(?:gif(?:[ \t]+(?:search|query))?|tenor(?:[ \t]+search)?)\s*:\s*([^\r\n]{1,120}?)[ \t]*$/i,
];

export class GifService {
  /**
   * Check if GIF feature is enabled for a guild (defaults to enabled)
   */
  isGifEnabled(guildId: string): boolean {
    const row = db.query<{ enabled: number }, [string]>(
      'SELECT enabled FROM guild_gif_settings WHERE guild_id = ?'
    ).get(guildId);
    
    return row ? row.enabled === 1 : true;
  }

  /**
   * Enable or disable GIFs for a guild
   */
  setGifEnabled(guildId: string, enabled: boolean): void {
    db.run(
      `INSERT INTO guild_gif_settings (guild_id, enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [guildId, enabled ? 1 : 0, new Date().toISOString()]
    );
  }

  /**
   * Search Tenor and resolve candidate GIF URLs
   */
  async resolveGif(query: string): Promise<string | undefined> {
    const cleanQuery = query.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!cleanQuery) return undefined;

    try {
      const url = `https://tenor.com/search/${encodeURIComponent(cleanQuery.replace(/\s+/g, '-'))}-gifs`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return undefined;

      const html = await res.text();
      const candidates = [...html.matchAll(/<img[^>]+src="([^"]+\.gif)"/g)]
        .map((match) => match[1])
        // Group 1 is a required capture, so this never drops anything; it only
        // narrows the type for noUncheckedIndexedAccess.
        .filter((candidate): candidate is string => Boolean(candidate))
        // Scrape-time allowlist: a candidate from an unknown host is dropped
        // before any request is made, so it can neither be probed nor returned.
        .filter((candidate) => {
          if (isAllowedGifHost(candidate)) return true;
          console.warn(`🎬 [GIF] Ignoring off-allowlist candidate: ${candidate.slice(0, 120)}`);
          return false;
        })
        .slice(0, 4)
        .sort(() => Math.random() - 0.5);

      for (const candidate of candidates) {
        try {
          const checkRes = await fetch(candidate, {
            method: 'HEAD',
            signal: AbortSignal.timeout(3000),
            redirect: 'manual',
          });
          if (checkRes.ok && checkRes.headers.get('content-type')?.includes('image/gif')) {
            // Re-check the host we actually ended up on. `manual` means no hop is
            // followed silently, but a same-host redirect chain could still be
            // constructed; verifying at return time costs nothing.
            if (isAllowedGifHost(candidate)) return candidate;
          }
        } catch {
          // Try next candidate
        }
      }
    } catch (error) {
      console.warn(`🎬 [GIF] Tenor lookup failed for "${cleanQuery}":`, error);
    }
    return undefined;
  }

  /**
   * Extract <gif> tags from the model output and resolve the GIF URL
   */
  async extractAndResolveGif(content: string): Promise<{ text: string; gifUrl?: string }> {
    let cleanText = content;
    let gifQuery: string | undefined;

    for (const pattern of gifDirectivePatterns) {
      const match = cleanText.match(pattern);
      if (match && match[1]) {
        gifQuery = match[1].trim();
        cleanText = cleanText.replace(match[0], '').trim();
        break;
      }
    }

    let gifUrl: string | undefined;
    if (gifQuery) {
      console.log(`🎬 [GIF] AI requested GIF search: "${gifQuery}"`);
      gifUrl = await this.resolveGif(gifQuery);
      if (gifUrl) {
        console.log(`🎬 [GIF] Resolved GIF URL: ${gifUrl}`);
      }
    }

    return { text: cleanText, gifUrl };
  }
}

export const gifService = new GifService();
