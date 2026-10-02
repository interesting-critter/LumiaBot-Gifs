import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { escapeLikeWildcards } from '../sql-escape';
import { REPO_ROOT } from '../paths';

/**
 * `escapeLikeWildcards` used to be reimplemented, byte for byte, in three
 * places: `services/music.ts`, `services/user-memory.ts`, and inline in
 * `services/knowledge-graph.ts`. Copies of a security helper are the problem — a
 * fix to one leaves the other two vulnerable, and nothing at the call site hints
 * that a sibling copy exists.
 *
 * The behaviour under test is the point: `%` and `_` are wildcards *inside* a
 * bound parameter, which is a different bug from SQL injection. `/music search %`
 * built `'%%%'` and matched every row, i.e. dumped the table to any member who
 * could type a percent sign.
 */
describe('escapeLikeWildcards', () => {
  test('escapes the two LIKE wildcards', () => {
    expect(escapeLikeWildcards('%')).toBe('\\%');
    expect(escapeLikeWildcards('_')).toBe('\\_');
    expect(escapeLikeWildcards('100%_pure')).toBe('100\\%\\_pure');
  });

  test('escapes the ESCAPE character itself, first', () => {
    // Backslash is the `ESCAPE '\'` character. If it is not escaped, a literal
    // backslash in the input consumes the `%` that follows it and the pattern
    // silently widens — e.g. `\%` would mean "a literal %", not "backslash then
    // any run of characters".
    expect(escapeLikeWildcards('\\')).toBe('\\\\');
    expect(escapeLikeWildcards('\\%')).toBe('\\\\\\%');
  });

  test('leaves ordinary text alone', () => {
    expect(escapeLikeWildcards('loom')).toBe('loom');
    expect(escapeLikeWildcards('')).toBe('');
    expect(escapeLikeWildcards('DJ set 🎧')).toBe('DJ set 🎧');
    // Apostrophes are not LIKE metacharacters; escaping them would break the
    // `contains` searches on names like "O'Brien".
    expect(escapeLikeWildcards("O'Brien")).toBe("O'Brien");
  });

  test('does not double-escape text that is already escaped', () => {
    // Deliberate: the helper is applied to raw input exactly once per query. A
    // second pass would turn `\%` into `\\%`, which no longer matches the
    // literal backslash the operator typed.
    expect(escapeLikeWildcards(escapeLikeWildcards('%'))).toBe('\\\\\\%');
  });
});

describe('escapeLikeWildcards against real SQLite', () => {
  /** In-memory table with the ESCAPE clause the queries actually use. */
  function fixture() {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (name TEXT)');
    const insert = db.query('INSERT INTO t (name) VALUES (?)');
    for (const name of ['plain', '100% pure', 'under_score', 'back\\slash', 'a%b', '%', '_']) {
      insert.run(name);
    }
    return db;
  }

  /** The exact query shape used by music.ts / knowledge-graph.ts. */
  function like(db: Database, term: string): string[] {
    const rows = db
      .query("SELECT name FROM t WHERE name LIKE ? ESCAPE '\\'")
      .all(`%${escapeLikeWildcards(term)}%`) as Array<{ name: string }>;
    return rows.map((row) => row.name).sort();
  }

  test('a bare % matches only rows that literally contain a percent sign', () => {
    // The regression: unescaped, this is `'%%%'` and returns the whole table.
    expect(like(fixture(), '%')).toEqual(['%', '100% pure', 'a%b']);
  });

  test('a bare _ matches only rows that literally contain an underscore', () => {
    expect(like(fixture(), '_')).toEqual(['_', 'under_score']);
  });

  test('a backslash does not eat the wildcard that follows it', () => {
    // Unescaped, `\%` is parsed as "a literal %", so this search silently
    // returned the percent-sign rows instead of the backslash row.
    expect(like(fixture(), '\\')).toEqual(['back\\slash']);
  });

  test('ordinary search terms still work', () => {
    expect(like(fixture(), 'pure')).toEqual(['100% pure']);
    expect(like(fixture(), 'plain')).toEqual(['plain']);
  });

  test('a term containing several metacharacters matches nothing, not everything', () => {
    // The important shape of the guarantee: over-escaping costs a result,
    // under-escaping returns the table.
    expect(like(fixture(), '%_%')).toEqual([]);
  });
});

describe('the duplication is gone', () => {
  const src = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

  test('services/music.ts imports the shared helper', () => {
    expect(src('src/services/music.ts')).toContain("from '../utils/sql-escape'");
  });

  test('services/knowledge-graph.ts imports the shared helper', () => {
    expect(src('src/services/knowledge-graph.ts')).toContain("from '../utils/sql-escape'");
  });

  test('neither file re-declares the implementation inline', () => {
    // The old form, spelled exactly as both copies had it. Kept deliberately
    // narrow so a differently-shaped reimplementation is not missed by accident.
    const inline = /function escapeLike\w*\([^)]*\)\s*\{\s*return\s+\w+\.replace\(\/\[\\\\\\\\%_\]\/g/;
    expect(inline.test(src('src/services/music.ts'))).toBe(false);
    expect(inline.test(src('src/services/knowledge-graph.ts'))).toBe(false);
  });

  test('every LIKE query in knowledge-graph declares the ESCAPE it now relies on', () => {
    const source = src('src/services/knowledge-graph.ts');
    const likeClauses = source.match(/LIKE \? ESCAPE/g) ?? [];
    expect(likeClauses.length).toBeGreaterThan(0);
    // One clause per keyword per column: keywords/content/title.
    expect(likeClauses.length % 3).toBe(0);
  });

  test('user-memory.ts is left for its current owner to migrate (reported, not edited)', () => {
    // Recorded as a known duplication rather than silently duplicated further.
    const source = src('src/services/user-memory.ts');
    expect(source).toContain('escapeLike');
  });
});