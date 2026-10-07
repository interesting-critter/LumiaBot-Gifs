import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationHistoryService } from '../conversation-history';

/**
 * These cover the single-message delete, which the dashboard route reaches with
 * an id straight out of the URL.
 *
 * The guild-scoping assertions are the point of the file rather than a footnote.
 * `id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so ids are sequential and
 * predictable from row one — the interesting question is not "does the DELETE
 * work" but "what stops `DELETE ... WHERE id = ?` from becoming a
 * cross-guild delete behind an authenticated dashboard". Every read in this
 * service is guild-scoped by design, and `deleteMessage` has to be too.
 *
 * Temp databases, one per test, because the id is global to the file and a
 * shared one would make the ids in each assertion depend on test order.
 */

let dir: string;
let service: ConversationHistoryService;

const USER = '100000000000000001';
const OTHER_USER = '100000000000000002';
const GUILD = '200000000000000001';
const OTHER_GUILD = '200000000000000002';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumia-conv-history-'));
  service = new ConversationHistoryService(join(dir, 'conversations.db'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deleteMessage removes exactly one row', () => {
  test('an existing message is deleted and reported as removed', () => {
    service.addMessage(USER, GUILD, 'ada', 'user', 'first');
    service.addMessage(USER, GUILD, 'ada', 'assistant', 'second');

    const before = service.getConversation(USER, GUILD)!;
    expect(before.messages).toHaveLength(2);
    const target = before.messages[0]!;
    expect(target.content).toBe('first');

    expect(service.deleteMessage(target.id, USER, GUILD)).toBe(true);

    const after = service.getConversation(USER, GUILD)!;
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.content).toBe('second');
    expect(service.getMessageCount(USER, GUILD)).toBe(1);
  });

  test('getConversation hands back each row id so a delete can name it', () => {
    // The UI has no other handle on a single turn — without the id in the SELECT
    // there is nothing to put in the DELETE URL.
    service.addMessage(USER, GUILD, 'ada', 'user', 'one');
    service.addMessage(USER, GUILD, 'ada', 'assistant', 'two');

    const messages = service.getConversation(USER, GUILD)!.messages;
    expect(messages.every((m) => Number.isInteger(m.id))).toBe(true);
    expect(new Set(messages.map((m) => m.id)).size).toBe(2);
    // Ascending with insertion order, so "newest first" in the transcript is a
    // reverse() and not a re-sort.
    expect(messages[0]!.id).toBeLessThan(messages[1]!.id);
  });

  test('an id that does not exist returns false and removes nothing', () => {
    service.addMessage(USER, GUILD, 'ada', 'user', 'only');

    const { id } = service.getConversation(USER, GUILD)!.messages[0]!;

    // A neighbour of the one real id — not id 0, not a huge number. Guessing
    // around the id space is the cheapest way to prove the miss is a miss.
    expect(service.deleteMessage(id + 1, USER, GUILD)).toBe(false);
    expect(service.deleteMessage(0, USER, GUILD)).toBe(false);
    expect(service.deleteMessage(-1, USER, GUILD)).toBe(false);
    expect(service.deleteMessage(999_999, USER, GUILD)).toBe(false);

    expect(service.getMessageCount(USER, GUILD)).toBe(1);
  });

  test('a non-integer id is rejected outright', () => {
    service.addMessage(USER, GUILD, 'ada', 'user', 'only');
    const { id } = service.getConversation(USER, GUILD)!.messages[0]!;

    expect(service.deleteMessage(Number.NaN, USER, GUILD)).toBe(false);
    expect(service.deleteMessage(1.5, USER, GUILD)).toBe(false);
    // Infinity is not an integer but is the one value that can survive an
    // isInteger check in some engines' eyes; assert it too rather than assume.
    expect(service.deleteMessage(Number.POSITIVE_INFINITY, USER, GUILD)).toBe(false);

    expect(service.getMessageCount(USER, GUILD)).toBe(1);
    expect(service.deleteMessage(id, USER, GUILD)).toBe(true);
  });
});

describe('deleteMessage will not cross a scope boundary', () => {
  test("an id from another guild survives a delete naming this user's guild", () => {
    // The security case. Both rows belong to the same user and were created in
    // the same database, so `user_id` alone would match; only `guild_id` keeps
    // them apart.
    service.addMessage(USER, GUILD, 'ada', 'user', 'guild one message');
    service.addMessage(USER, OTHER_GUILD, 'ada', 'user', 'guild two message');

    const victim = service.getConversation(USER, OTHER_GUILD)!.messages[0]!;
    expect(victim.content).toBe('guild two message');

    // Attacker claims the message is theirs by supplying their own guild.
    expect(service.deleteMessage(victim.id, USER, GUILD)).toBe(false);

    expect(service.getMessageCount(USER, OTHER_GUILD)).toBe(1);
    expect(service.getMessageCount(USER, GUILD)).toBe(1);
    expect(service.getConversation(USER, OTHER_GUILD)!.messages[0]!.content).toBe('guild two message');
  });

  test("an id from another user survives a delete naming this guild", () => {
    service.addMessage(USER, GUILD, 'ada', 'user', 'mine');
    service.addMessage(OTHER_USER, GUILD, 'bob', 'user', 'theirs');

    const victim = service.getConversation(OTHER_USER, GUILD)!.messages[0]!;

    expect(service.deleteMessage(victim.id, USER, GUILD)).toBe(false);

    expect(service.getMessageCount(OTHER_USER, GUILD)).toBe(1);
    expect(service.getMessageCount(USER, GUILD)).toBe(1);
  });

  test('the guild scope has to match exactly, not merely exist', () => {
    // The bot stores DMs under the literal string 'dm' rather than a snowflake,
    // so the guild segment of the delete URL is arbitrary operator-supplied
    // text. 'dm-1' must not be a prefix-match or a near miss for 'dm'.
    service.addMessage(USER, GUILD, 'ada', 'user', 'server message');
    service.addMessage(USER, 'dm', 'ada', 'user', 'dm message');

    const server = service.getConversation(USER, GUILD)!.messages[0]!;
    expect(service.deleteMessage(server.id, USER, 'dm')).toBe(false);
    expect(service.deleteMessage(server.id, USER, 'GUILD')).toBe(false);
    expect(service.deleteMessage(server.id, USER, `${GUILD} `)).toBe(false);
    expect(service.deleteMessage(server.id, USER, '')).toBe(false);

    expect(service.getMessageCount(USER, GUILD)).toBe(1);
    expect(service.getMessageCount(USER, 'dm')).toBe(1);
  });

  test('the same id deletes in its own scope and nowhere else', () => {
    // Positive control for the tests above: the row is genuinely removable, so a
    // `false` above can only be the scoping and not a broken DELETE.
    service.addMessage(USER, GUILD, 'ada', 'user', 'reachable');
    const { id } = service.getConversation(USER, GUILD)!.messages[0]!;

    expect(service.deleteMessage(id, OTHER_USER, OTHER_GUILD)).toBe(false);
    expect(service.getMessageCount(USER, GUILD)).toBe(1);
    expect(service.deleteMessage(id, USER, GUILD)).toBe(true);
    expect(service.getMessageCount(USER, GUILD)).toBe(0);
    // And it is genuinely gone, not just invisible to the count.
    expect(service.getConversation(USER, GUILD)).toBeNull();
  });
});