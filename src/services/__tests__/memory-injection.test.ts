import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserMemoryService } from '../user-memory';

/**
 * `searchUsers` is reachable from the model-facing `search_users` tool and from
 * `resolveUserMention`, so its query argument is attacker-influenced. The
 * performance rewrite built its `WHERE` clause by string interpolation while
 * `escapeLike` only escaped `\ % _` — leaving the quote free. Against a scratch
 * database, `x') OR 1=1 --` pulled every row in the guild into the candidate
 * set and `x' UNION SELECT ...` threw `SQLiteError` straight out of the method.
 *
 * These tests pin the property that matters: the needle is bound, never parsed
 * as SQL. Each payload is additionally paired with a row that the pre-fix
 * interpolation genuinely matched, so the assertion is about SQL semantics and
 * not merely about "no rows came back".
 */

let dir: string;
let dbPath: string;
let service: UserMemoryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumia-memory-sqli-'));
  dbPath = join(dir, 'user_memories.db');
  service = new UserMemoryService(dbPath);

  service.storeOpinion('111111111111111111', 'Alice', 'likes cats', 'positive', 'guild-a');
  service.storeOpinion('222222222222222222', 'Bob', 'likes dogs', 'positive', 'guild-a');
  service.storeOpinion('333333333333333333', 'Carol', 'likes tea', 'neutral', 'guild-b');
});

function cleanup(): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('searchUsers treats the query as data, never as SQL', () => {
  test("a tautology payload does not throw and returns nothing", () => {
    // NOTE ON WHAT THIS TEST PROVES: pre-fix, `username_norm = 'x') OR 1=1 --'`
    // was valid SQL and did scan every row in the guild — but the *returned*
    // array was already empty, because computeFuzzyScore() discarded every
    // injected row afterwards. So this assertion alone does NOT fail against the
    // vulnerable code; the two tests below do. It is kept because "does not
    // throw, returns nothing" is the contract callers rely on.
    let results: unknown;
    expect(() => {
      results = service.searchUsers("x') OR 1=1 --", 5, 'guild-a');
    }).not.toThrow();
    expect(results).toEqual([]);

    cleanup();
  });

  test('a UNION payload does not throw and returns nothing', () => {
    // Pre-fix: SQLiteError("near union: syntax error") propagated out of
    // searchUsers — the only reason it was not a crash was the try/catch in the
    // openai tool wrapper.
    let results: unknown;
    expect(() => {
      results = service.searchUsers(
        "x' UNION SELECT user_id, guild_id, username, pronouns, sentiment FROM user_opinions --",
        5,
        'guild-a',
      );
    }).not.toThrow();
    expect(results).toEqual([]);

    cleanup();
  });

  test('an injected OR cannot widen the match to a real user', () => {
    // This is the assertion that actually fails pre-fix: the interpolated
    // literal `x' OR username_norm = 'alice` is a complete second predicate, so
    // Alice was returned. Bound, it is one string that matches nobody.
    const results = service.searchUsers("x' OR username_norm = 'alice", 5, 'guild-a');
    expect(results).toEqual([]);

    // Control: the legitimate query still finds her, so the test above is not
    // passing because searchUsers is simply broken.
    expect(service.searchUsers('Alice', 5, 'guild-a')).toHaveLength(1);

    cleanup();
  });

  test('an injected trailing OR cannot leak another guild', () => {
    const results = service.searchUsers("x' OR guild_id = 'guild-b' --", 5, 'guild-a');
    expect(results).toEqual([]);

    cleanup();
  });

  test('LIKE wildcards are escaped, so a bare % cannot scan the table', () => {
    // Regression guard for the `ESCAPE '\'` contract: pre-fix a needle of `\`
    // escaped to `\\` and the trailing `%` of the prefix pattern was then eaten
    // as an escaped wildcard, turning the predicate into "match everything".
    // `%`, `_` and `\` must all find nobody here — Alice, Bob and Carol are the
    // only rows, and none of them contains these characters literally.
    expect(service.searchUsers('%', 5, 'guild-a')).toEqual([]);
    expect(service.searchUsers('_', 5, 'guild-a')).toEqual([]);
    expect(service.searchUsers('\\', 5, 'guild-a')).toEqual([]);
    expect(service.searchUsers("'", 5, 'guild-a')).toEqual([]);

    // Control: ordinary names still resolve, through the bound predicate.
    expect(service.searchUsers('Alice', 5, 'guild-a')).toHaveLength(1);
    expect(service.searchUsers('ali', 5, 'guild-a')).toHaveLength(1);

    cleanup();
  });
});
