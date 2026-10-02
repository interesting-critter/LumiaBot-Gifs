import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LEGACY_GUILD_SCOPE, UserMemoryService } from '../user-memory';

/**
 * These tests pin the two properties that make user memory safe to keep:
 *
 *  1. Guild isolation. `user_opinions` / `user_memory_entries` used to be one
 *     global store, so what the bot learned about someone in one server was
 *     readable from every other server. The schema now carries `guild_id` and
 *     every read is scoped.
 *  2. Mention validation. `store_third_party_context` is an LLM tool whose
 *     target is chosen by the model, which is attacker-influenced input.
 *
 * Each test gets a fresh temp-file database (a real file, not `:memory:`, so the
 * migration can be re-run against the *same* database to prove idempotency).
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumia-memory-test-'));
  dbPath = join(dir, 'user_memories.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build the pre-guild-scoping schema, exactly as it shipped. */
function createLegacyDatabase(path: string): Database {
  const db = new Database(path);
  db.run(`
    CREATE TABLE user_opinions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      opinion TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      pronouns TEXT,
      third_party_context TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE user_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

describe('guild-scoping migration', () => {
  test('is idempotent and preserves data on an already-populated database', () => {
    const legacy = createLegacyDatabase(dbPath);
    legacy.run(
      `INSERT INTO user_opinions (user_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at)
       VALUES ('111111111111111111', 'Alice', '[2024-01-01T00:00:00.000Z] likes cats', 'positive', 'she/her', NULL, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
    );
    legacy.run(
      `INSERT INTO user_opinions (user_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at)
       VALUES ('222222222222222222', 'Bob', '', 'neutral', NULL, NULL, '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z')`
    );
    legacy.close();

    // First boot: migration runs.
    const first = new UserMemoryService(dbPath);
    const aliceAfterFirst = first.getOpinion('111111111111111111', LEGACY_GUILD_SCOPE);
    expect(aliceAfterFirst).not.toBeNull();
    expect(aliceAfterFirst!.username).toBe('Alice');
    expect(aliceAfterFirst!.pronouns).toBe('she/her');
    expect(aliceAfterFirst!.opinion).toContain('likes cats');
    expect(first.hasOpinion('222222222222222222')).toBe(true);

    const statsAfterFirst = first.getMemoryStats();
    first.close();

    // Second boot against the same file: must not throw and must not double up.
    const second = new UserMemoryService(dbPath);
    const aliceAfterSecond = second.getOpinion('111111111111111111', LEGACY_GUILD_SCOPE);
    expect(aliceAfterSecond).not.toBeNull();
    expect(aliceAfterSecond!.username).toBe('Alice');
    expect(aliceAfterSecond!.pronouns).toBe('she/her');
    expect(aliceAfterSecond!.opinion).toContain('likes cats');

    const statsAfterSecond = second.getMemoryStats();
    expect(statsAfterSecond.entries).toBe(statsAfterFirst.entries);
    expect(statsAfterSecond.opinionEntries).toBe(statsAfterFirst.opinionEntries);
    expect(statsAfterSecond.users).toBe(2);
  });

  test('backfills pre-existing rows with the legacy sentinel, not a drop', () => {
    const legacy = createLegacyDatabase(dbPath);
    legacy.run(
      `INSERT INTO user_opinions (user_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at)
       VALUES ('333333333333333333', 'Carol', '', 'neutral', NULL, NULL, '2024-01-03T00:00:00.000Z', '2024-01-03T00:00:00.000Z')`
    );
    legacy.close();

    const service = new UserMemoryService(dbPath);

    const migrated = service.getOpinion('333333333333333333', LEGACY_GUILD_SCOPE);
    expect(migrated).not.toBeNull();
    expect(migrated!.guildId).toBe(LEGACY_GUILD_SCOPE);
    expect(migrated!.username).toBe('Carol');

    // The sentinel is readable only through the sentinel scope, never as a
    // guild-scoped read.
    expect(service.getOpinion('333333333333333333', '999')).toBeNull();
  });

  test('merges duplicate profiles instead of failing on the UNIQUE index', () => {
    const legacy = createLegacyDatabase(dbPath);
    legacy.run(
      `INSERT INTO user_opinions (user_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at)
       VALUES ('444444444444444444', 'Dave', '', 'neutral', NULL, NULL, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
    );
    legacy.run(
      `INSERT INTO user_opinions (user_id, username, opinion, sentiment, pronouns, third_party_context, created_at, updated_at)
       VALUES ('444444444444444444', 'Dave', '', 'neutral', 'he/him', NULL, '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z')`
    );
    legacy.close();

    const service = new UserMemoryService(dbPath);
    const summary = service.getMemoryDetail('444444444444444444');
    expect(summary).not.toBeNull();
    expect(summary!.username).toBe('Dave');
    // Pronouns from the newer duplicate are carried over.
    expect(summary!.pronouns).toBe('he/him');

    // Writing again must not create a second row (the upsert is the guard).
    service.storeOpinion('444444444444444444', 'Dave', 'likes tea', 'positive', LEGACY_GUILD_SCOPE);
    expect(service.getEntryCount('444444444444444444', 'opinion', LEGACY_GUILD_SCOPE)).toBe(1);
  });
});

describe('guild isolation', () => {
  test("guild A's memories are invisible to a guild B read", () => {
    const service = new UserMemoryService(dbPath);

    service.storeOpinion('555555555555555555', 'Erin', 'loves DnD', 'positive', 'guild-a');
    service.storeThirdPartyContext(
      {
        userId: '555555555555555555',
        username: 'Erin',
        context: 'said she is DMing on Friday',
        mentionedBy: 'Frank',
        timestamp: new Date().toISOString(),
        guildId: 'guild-a',
      },
    );

    expect(service.getOpinion('555555555555555555', 'guild-a')?.opinion).toContain('loves DnD');
    expect(service.getOpinion('555555555555555555', 'guild-b')).toBeNull();
    expect(service.getOpinionByUsername('Erin', 'guild-b')).toBeNull();
    expect(service.getOpinionByUsername('Erin', 'guild-a')).not.toBeNull();
    expect(service.getOpinionContext('555555555555555555', 'guild-b')).toBe('');
    expect(service.getPronouns('555555555555555555', 'guild-b')).toBeNull();
    expect(service.listUsers('guild-b')).toHaveLength(0);
    expect(service.listUsers('guild-a')).toHaveLength(1);
    expect(service.searchUsers('Erin', 5, 'guild-b')).toHaveLength(0);
    expect(service.searchUsers('Erin', 5, 'guild-a')).toHaveLength(1);
  });

  test('per-guild rolling caps do not evict another guild', () => {
    const service = new UserMemoryService(dbPath);
    const userId = '666666666666666666';

    // MAX_OPINION_ENTRIES is 10.
    for (let i = 0; i < 10; i++) {
      service.storeOpinion(userId, 'Grace', `guild-b opinion ${i}`, 'neutral', 'guild-b');
    }
    for (let i = 0; i < 10; i++) {
      service.storeOpinion(userId, 'Grace', `guild-a opinion ${i}`, 'neutral', 'guild-a');
    }

    expect(service.getEntryCount(userId, 'opinion', 'guild-a')).toBe(10);
    expect(service.getEntryCount(userId, 'opinion', 'guild-b')).toBe(10);

    const guildA = service.listEntries(userId, 'opinion', 'guild-a');
    expect(guildA.map(e => e.content)).toContain('guild-a opinion 0');
    const guildB = service.listEntries(userId, 'opinion', 'guild-b');
    expect(guildB.map(e => e.content)).toContain('guild-b opinion 0');

    // Pushing guild-a past its cap must leave guild-b untouched.
    service.storeOpinion(userId, 'Grace', 'guild-a overflow', 'neutral', 'guild-a');
    expect(service.getEntryCount(userId, 'opinion', 'guild-a')).toBe(10);
    expect(service.getEntryCount(userId, 'opinion', 'guild-b')).toBe(10);
    expect(service.listEntries(userId, 'opinion', 'guild-b').map(e => e.content)).toContain('guild-b opinion 0');
  });

  test('deleteOpinion without a guild id erases every scope', () => {
    const service = new UserMemoryService(dbPath);
    const userId = '777777777777777777';
    service.storeOpinion(userId, 'Heidi', 'guild-a note', 'positive', 'guild-a');
    service.storeOpinion(userId, 'Heidi', 'guild-b note', 'positive', 'guild-b');

    expect(service.hasOpinion(userId)).toBe(true);
    expect(service.deleteOpinion(userId)).toBe(2);
    expect(service.hasOpinion(userId)).toBe(false);
    expect(service.getOpinion(userId, 'guild-a')).toBeNull();
    expect(service.getOpinion(userId, 'guild-b')).toBeNull();
  });
});

describe('validateMentionTarget', () => {
  const service = () => new UserMemoryService(dbPath);

  test('accepts an id present in allowedIds', async () => {
    const memory = service();
    const result = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUserId: '888888888888888888',
      allowedIds: ['888888888888888888', '999999999999999999'],
    });
    expect(result).toEqual({ ok: true, userId: '888888888888888888' });
  });

  test('rejects an id that is not in allowedIds', async () => {
    const memory = service();
    const result = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUserId: '123123123123123123',
      allowedIds: ['888888888888888888'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not mentioned');
    }
  });

  test('rejects blank, malformed and missing targets', async () => {
    const memory = service();

    const blank = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUserId: '   ',
      allowedIds: ['888888888888888888'],
    });
    expect(blank.ok).toBe(false);

    const malformed = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUserId: 'not-an-id',
      allowedIds: ['not-an-id'],
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.reason).toContain('valid Discord user id');
    }

    const nothing = await memory.validateMentionTarget({
      guildId: 'guild-a',
      allowedIds: ['888888888888888888'],
    });
    expect(nothing.ok).toBe(false);

    const noAllowed = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUserId: '888888888888888888',
      allowedIds: [],
    });
    expect(noAllowed.ok).toBe(false);
  });

  test('resolves a username only to an allowed id, within the guild', async () => {
    const memory = service();
    memory.storeOpinion('888888888888888888', 'Ivan', 'guild-a note', 'neutral', 'guild-a');

    const ok = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUsername: 'ivan',
      allowedIds: ['888888888888888888'],
    });
    expect(ok).toEqual({ ok: true, userId: '888888888888888888' });

    const notAllowed = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUsername: 'ivan',
      allowedIds: ['777777777777777777'],
    });
    expect(notAllowed.ok).toBe(false);

    const unknown = await memory.validateMentionTarget({
      guildId: 'guild-a',
      mentionedUsername: 'nobody',
      allowedIds: ['888888888888888888'],
    });
    expect(unknown.ok).toBe(false);
  });
});
