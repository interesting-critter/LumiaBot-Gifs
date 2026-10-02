import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';
import { neutralizeMentions } from '../../utils/mentions';

/**
 * `/music` was missed by the mention-hardening pass that covered `/chat` and
 * `/search`. It is the worst command in the repo for this: a Spotify playlist
 * title is chosen by whoever owns the playlist, `/music list` is **not**
 * owner-gated, and `/music delete` interpolated that title straight into the
 * `content` of a confirmation prompt. A playlist named `@everyone` therefore
 * produced
 *
 *     ⚠️ Are you sure you want to delete "@everyone"?
 *
 * and Discord pinged the entire server.
 *
 * Driving a real Discord interaction is not practical in a unit test, so the
 * source-level invariant is asserted instead: no `reply`/`editReply`/`update`
 * in this file may be without an `allowedMentions`, and every dynamic string
 * that reaches `content` must be neutralised.
 */

const MUSIC_COMMAND_PATH = join(REPO_ROOT, 'src', 'commands', 'music.ts');
const source = readFileSync(MUSIC_COMMAND_PATH, 'utf8');

/**
 * Calls whose options object literal starts on this line, mapped to the full
 * call text so an assertion failure can name the line.
 *
 * `deferReply` is excluded on purpose: it carries no content of its own, and
 * discord.js applies the `allowedMentions` from the subsequent `editReply`.
 */
function replyCallSites(): Array<{ line: number; text: string }> {
  const lines = source.split('\n');
  const sites: Array<{ line: number; text: string }> = [];

  lines.forEach((text, index) => {
    const match = /\.(reply|editReply|update|followUp)\(\{/.exec(text);
    if (!match) return;

    // Accumulate until braces balance, so a multi-line options object is checked
    // as a whole rather than only its first line.
    let depth = 0;
    let whole = text;
    for (let i = index; i < lines.length; i++) {
      const line = lines[i]!;
      whole += (i === index ? '' : '\n') + line;
      for (const char of line) {
        if (char === '{') depth++;
        if (char === '}') depth--;
      }
      if (depth <= 0) break;
    }

    sites.push({ line: index + 1, text: whole });
  });

  return sites;
}

describe('src/commands/music.ts — allowedMentions coverage', () => {
  test('the file has reply call sites at all (guards the check below)', () => {
    expect(replyCallSites().length).toBeGreaterThan(10);
  });

  test('no reply/editReply/update omits allowedMentions', () => {
    const offenders = replyCallSites()
      .filter((site) => !/allowedMentions\s*:/.test(site.text))
      .map((site) => `${MUSIC_COMMAND_PATH}:${site.line} — ${site.text.split('\n')[0]!.trim()}`);

    expect(offenders).toEqual([]);
  });

  test('the coverage threshold the review asked for is met', () => {
    // Not a style rule: it means "someone actually went through this file".
    const count = (source.match(/allowedMentions/g) ?? []).length;
    expect(count).toBeGreaterThan(10);
  });

  test('allowedMentions always comes from the shared helper', () => {
    // A hand-rolled `{ parse: [] }` here is how the boredom.ts drift happened.
    const handRolled = replyCallSites()
      .filter((site) => /allowedMentions\s*:\s*\{\s*parse/.test(site.text))
      .map((site) => site.line);
    expect(handRolled).toEqual([]);
  });

  test('the file imports the shared helper', () => {
    expect(source).toContain("import { buildAllowedMentions } from '../utils/permissions'");
  });
});

describe('src/commands/music.ts — dynamic content is neutralised', () => {
  /**
   * Every `content:` line that interpolates a variable rather than a literal.
   * This is the half of the hardening that survives someone dropping
   * `allowedMentions`: the text itself is not a mention.
   */
  function dynamicContentLines(): Array<{ line: number; text: string }> {
    return source
      .split('\n')
      .map((text, index) => ({ line: index + 1, text }))
      .filter(({ text }) => /^\s*(content:\s*`|content:\s*[a-zA-Z])/.test(text) && /\$\{/.test(text));
  }

  test('there is dynamic content to check (guards the check below)', () => {
    expect(dynamicContentLines().length).toBeGreaterThan(0);
  });

  test('every interpolated value in `content` is either neutralised or a trusted scalar', () => {
    /**
     * Allowlist of interpolations that cannot contain mention syntax:
     *   - numbers, counts and ids the bot itself produced,
     *   - the `deletePlaylist`/clear-all result counts,
     *   - already-neutralised values.
     * Anything else has to go through `neutralizeMentions`.
     */
    const SAFE_INTERPOLATIONS = new Set([
      'errorMessage',   // wrapped in neutralizeMentions at every use
      'message',        // wrapped in neutralizeMentions at every use
      'safeQuery',      // = neutralizeMentions(query), computed once above
      'isReimport',
      'spotifyPlaylist.tracks.items.length',
      'deleted.playlistsDeleted',
      'deleted.tracksDeleted',
      'deleted.artistsDeleted',
      'deleted.albumsDeleted',
      'stats.totalPlaylists',
      'stats.totalTracks',
      'stats.totalArtists',
      'stats.totalAlbums',
      'refreshedCount',
      'totalTracks',
      'newTracks',
      'playlists.length',
      'tracks.length',
      'playlistId',
      'deletedCount',
      'userId',
      // Ternaries whose branches are all literals: no user data can reach them.
      "isReimport ? '(This will update the existing import)' : ''",
      "playlists.length === 1 ? '' : 's'",
    ]);

    const offenders: string[] = [];
    for (const { line, text } of dynamicContentLines()) {
      for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
        const expression = match[1]!.trim();
        if (SAFE_INTERPOLATIONS.has(expression)) continue;
        // A compound expression is fine as long as neutralizeMentions is
        // somewhere inside it.
        if (/neutralizeMentions\(/.test(expression)) continue;
        offenders.push(`${MUSIC_COMMAND_PATH}:${line} — \${${expression}}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('the /music delete confirmation prompt is inert for a hostile playlist name', () => {
    // End to end over the two functions that actually decide what gets sent.
    const ZWSP = '\u200b';
    const playlistName = '@everyone';
    const confirm = `⚠️ Are you sure you want to delete "${neutralizeMentions(playlistName)}"?`;

    // Same visible text, one invisible character inserted.
    expect(confirm).toContain(`@${ZWSP}everyone`);
    expect(confirm.replace(new RegExp(ZWSP, 'g'), '')).toBe(
      '⚠️ Are you sure you want to delete "@everyone"?',
    );
    // Not a mention by Discord's own syntax.
    expect(/(^|[^\w@])@(everyone|here)\b/i.test(confirm)).toBe(false);
  });

  test('the delete confirmation source really does neutralise the name', () => {
    // Ties the behavioural assertion above to the line in the command, so a
    // future edit that drops the call cannot pass silently.
    expect(source).toContain(
      'content: `⚠️ Are you sure you want to delete "${neutralizeMentions(playlist.name)}"?',
    );
  });

  test('/music search neutralises the echoed query', () => {
    // `/music search @everyone` was its own ping: the query was typed by any
    // member and echoed straight back into `content`.
    expect(source).toContain('const safeQuery = neutralizeMentions(query);');
    const content = `🔍 No tracks found matching "${neutralizeMentions('@everyone')}".`;
    expect(/(^|[^\w@])@(everyone|here)\b/i.test(content)).toBe(false);
  });
});

describe('src/commands/music.ts — subcommand gating', () => {
  test('the destructive subcommands stay owner-only', () => {
    // `list` and `delete` are the pair that matters here: `delete` writes the
    // untrusted title into a prompt, and it must never be reachable by a
    // non-owner. If this ever changes, the ping surface changes with it.
    expect(source).toContain(
      "ownerOnlySubcommands: ['import', 'refresh', 'delete', 'clear-all']",
    );
  });
});