import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const dataDir = join(import.meta.dir, '..', '..', 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new Database(join(dataDir, 'gif_settings.db'));

// Initialize settings table
db.run(`
  CREATE TABLE IF NOT EXISTS guild_gif_settings (
    guild_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )
`);

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
        .slice(0, 4)
        .sort(() => Math.random() - 0.5);

      for (const candidate of candidates) {
        try {
          const checkRes = await fetch(candidate, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
          if (checkRes.ok && checkRes.headers.get('content-type')?.includes('image/gif')) {
            return candidate;
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
