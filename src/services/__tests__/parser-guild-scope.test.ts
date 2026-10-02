import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * These tests exercise the PARSER path, not the service API.
 *
 * `memory.test.ts` already proves the service scopes its writes correctly — which
 * is exactly why the bug survived review: `handleMessage` called
 * `storeParsedInformation(userId, username, parsedInfo)` with no guild, so every
 * automatic pronoun detection and automatic `<@mention>` context landed in the
 * `LEGACY_GUILD_SCOPE` bucket that no production read ever queries. Automatic
 * capture was write-only, and the `store_user_opinion` /
 * `store_third_party_context` LLM tools (which do pass a guild) kept working,
 * which made it read as "the bot isn't picking up pronouns any more".
 *
 * `message-parser.ts` reaches storage through the module-level
 * `userMemoryService` singleton, so the singleton is redirected at a temp
 * database before the parser is imported.
 */

const actualUserMemory = await import('../user-memory');

let dir: string;
let dbPath: string;
let service: InstanceType<typeof actualUserMemory.UserMemoryService>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumia-parser-guild-'));
  dbPath = join(dir, 'user_memories.db');
  service = new actualUserMemory.UserMemoryService(dbPath);

  // Re-export the real module with only the singleton swapped, so type-only and
  // class exports keep working for anything else that imports it.
  mock.module('../user-memory', () => ({
    ...actualUserMemory,
    userMemoryService: service,
  }));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AUTHOR = '999000111222333444';
const FRIEND = '111222333444555666';

/** `hey <@FRIEND> i use she/her and she thinks you are cool` */
const MESSAGE = `hey <@${FRIEND}> i use she/her and she thinks you are cool`;

async function freshParser() {
  // Imported lazily per test so the mocked singleton is picked up.
  return await import('../message-parser');
}

describe('automatic memory capture is guild-scoped', () => {
  test('parseMessage stamps the guild onto every extracted mention', async () => {
    const { parseMessage } = await freshParser();
    const mentioned = new Map([[FRIEND, 'she/her friend']]);
    // The username map keys on user id; use the friend's name as the display.
    mentioned.set(FRIEND, 'Robin');

    const parsed = parseMessage(MESSAGE, mentioned, 'bob', 'guild-x');

    expect(parsed.pronouns).toBe('she/her');
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0]!.userId).toBe(FRIEND);
    expect(parsed.mentions[0]!.guildId).toBe('guild-x');
    expect(parsed.mentions[0]!.context).toContain('Robin');
  });

  test('storeParsedInformation writes pronouns and mention context under the real guild', async () => {
    const { parseMessage, storeParsedInformation } = await freshParser();
    const mentioned = new Map([[FRIEND, 'Robin']]);
    const parsed = parseMessage(MESSAGE, mentioned, 'bob', 'guild-x');

    storeParsedInformation(AUTHOR, 'bob', parsed, 'guild-x');

    // Readable in the guild the message happened in...
    expect(service.getPronouns(AUTHOR, 'guild-x')).toBe('she/her');
    const entries = service.listEntries(FRIEND, 'third_party', 'guild-x');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toContain('she thinks you are cool');

    // ...and invisible everywhere else. This is the whole point: pre-fix both
    // of these writes landed in 'legacy' and every production read returned
    // nothing.
    expect(service.getPronouns(AUTHOR, 'guild-y')).toBeNull();
    expect(service.getOpinionContext(AUTHOR, 'guild-y')).toBe('');
    expect(service.listEntries(FRIEND, 'third_party', 'guild-y')).toHaveLength(0);
    expect(service.getOpinion(AUTHOR, 'legacy')).toBeNull();
    expect(service.getOpinion(FRIEND, 'legacy')).toBeNull();
    expect(service.getOpinionContext(FRIEND, 'guild-y')).toBe('');
  });

  test('third-party context falls back to the guild stamped on the mention', async () => {
    // Guards the `guildId ?? mention.guildId` fallback in storeParsedInformation:
    // a caller that parsed earlier and stored later without re-passing the guild
    // still writes mention context to the right guild, because parseMessage
    // stamped each mention.
    //
    // Pronouns have no such fallback — they belong to the *author*, so with no
    // guild argument they land in the legacy bucket. That asymmetry is
    // intentional and asserted here so it cannot regress into "both silently
    // unscoped" or "both scoped".
    const { parseMessage, storeParsedInformation } = await freshParser();
    const parsed = parseMessage(MESSAGE, new Map([[FRIEND, 'Robin']]), 'bob', 'guild-x');

    storeParsedInformation(AUTHOR, 'bob', parsed);

    expect(service.listEntries(FRIEND, 'third_party', 'guild-x')).toHaveLength(1);
    expect(service.listEntries(FRIEND, 'third_party', 'legacy')).toHaveLength(0);
    expect(service.getPronouns(AUTHOR, 'legacy')).toBe('she/her');
    expect(service.getPronouns(AUTHOR, 'guild-x')).toBeNull();
  });

  test('a self-mention is still skipped', async () => {
    const { parseMessage, storeParsedInformation } = await freshParser();
    const selfMention = `hey <@${AUTHOR}> i use they/them and they are me`;
    const parsed = parseMessage(selfMention, new Map([[AUTHOR, 'bob']]), 'bob', 'guild-x');

    storeParsedInformation(AUTHOR, 'bob', parsed, 'guild-x');

    expect(service.getPronouns(AUTHOR, 'guild-x')).toBe('they/them');
    expect(service.listEntries(AUTHOR, 'third_party', 'guild-x')).toHaveLength(0);
  });

  test('nothing is written at all when there is no guild context to write to', async () => {
    // The legacy bucket is still reachable when a caller genuinely has no
    // guild — but it must be an explicit omission, not the default outcome of
    // a normal guild message.
    const { parseMessage, storeParsedInformation } = await freshParser();
    const parsed = parseMessage(MESSAGE, new Map([[FRIEND, 'Robin']]), 'bob');

    expect(parsed.mentions[0]!.guildId).toBeUndefined();
    storeParsedInformation(AUTHOR, 'bob', parsed);

    expect(service.getPronouns(AUTHOR, 'legacy')).toBe('she/her');
    expect(service.getPronouns(AUTHOR, 'guild-x')).toBeNull();
  });
});
