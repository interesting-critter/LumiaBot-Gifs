import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../utils/paths';
import {
  decideConfirmation,
  isDiscordSnowflake,
  matchesConfirmation,
  mergeUserCandidates,
  missingDatabases,
  parseArgs,
  runDestructiveSteps,
  wantsHelp,
  resolveTarget,
  type UserCandidate,
} from '../safety';

/**
 * These tests cover the *decision logic* of the maintenance scripts, never the
 * scripts themselves: `wipe-memories`, `reattribute-memories` and
 * `import-lumiverse-docs` all irreversibly delete or rewrite real user data, so
 * exercising them for real is exactly what must not happen. The logic they hinge
 * on lives in `src/scripts/safety.ts` as pure functions, and that is what is
 * asserted here.
 */

const SCRIPTS_DIR = join(REPO_ROOT, 'src', 'scripts');

const ID_A = '123456789012345678';
const ID_B = '987654321098765432';

function candidate(userId: string, usernames: string[], scopes: string[] = ['111']): UserCandidate {
  return { userId, usernames, scopes };
}

// ---------------------------------------------------------------------------

describe('isDiscordSnowflake', () => {
  test('accepts 17-20 digit ids', () => {
    expect(isDiscordSnowflake(ID_A)).toBe(true);
    expect(isDiscordSnowflake('10000000000000000')).toBe(true);
    expect(isDiscordSnowflake('12345678901234567890')).toBe(true);
  });

  test('rejects short numbers and display names', () => {
    // A numeric-looking display name must not be accepted as an id.
    expect(isDiscordSnowflake('12345')).toBe(false);
    expect(isDiscordSnowflake('123456789012345678901234')).toBe(false);
    expect(isDiscordSnowflake('Prolix')).toBe(false);
    expect(isDiscordSnowflake('12345abc')).toBe(false);
    expect(isDiscordSnowflake('12345678901234567a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('resolveTarget', () => {
  test('a snowflake resolves to that exact account even when a name is ambiguous', () => {
    const candidates = [
      candidate(ID_A, ['Prolix']),
      candidate(ID_B, ['Prolix']),
    ];

    const result = resolveTarget(ID_A, candidates);

    expect(result.status).toBe('resolved');
    expect(result.status === 'resolved' && result.candidate.userId).toBe(ID_A);
  });

  test('a name resolving to multiple distinct user ids is refused', () => {
    const candidates = [
      candidate(ID_A, ['Prolix']),
      candidate(ID_B, ['Prolix']),
    ];

    const result = resolveTarget('Prolix', candidates);

    // This is the HIGH-severity case: the old query was
    // `LOWER(username) = LOWER(?) LIMIT 1`, so it silently picked one of these
    // two accounts and deleted that stranger's memories.
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.candidates.map(c => c.userId).sort()).toEqual([ID_A, ID_B].sort());
  });

  test('a name matching one account resolves, case-insensitively', () => {
    const result = resolveTarget('pRoLiX', [candidate(ID_A, ['Prolix']), candidate(ID_B, ['Someone'])]);

    expect(result.status).toBe('resolved');
    expect(result.status === 'resolved' && result.candidate.userId).toBe(ID_A);
  });

  test('the same account seen under several guild nicknames is not ambiguous', () => {
    // One person renamed per guild: multiple names, one id.
    const result = resolveTarget('Prolix', [candidate(ID_A, ['Prolix', 'Prolix (dev)'], ['111', '222'])]);

    expect(result.status).toBe('resolved');
    expect(result.status === 'resolved' && result.candidate.userId).toBe(ID_A);
  });

  test('an unknown name and an unknown id both report not-found', () => {
    const candidates = [candidate(ID_A, ['Prolix'])];
    expect(resolveTarget('Nobody', candidates).status).toBe('not-found');
    expect(resolveTarget(ID_B, candidates).status).toBe('not-found');
  });

  test('no candidates at all is not-found, not an error', () => {
    expect(resolveTarget('Prolix', []).status).toBe('not-found');
  });
});

describe('mergeUserCandidates', () => {
  test('groups rows by user id and collects every name and scope', () => {
    const merged = mergeUserCandidates([
      { userId: ID_A, username: 'Prolix', scope: '111' },
      { userId: ID_A, username: 'Prolix', scope: '222' },
      { userId: ID_A, username: 'prolix-dev', scope: '222' },
      { userId: ID_B, username: 'Prolix', scope: '222' },
    ]);

    expect(merged).toHaveLength(2);
    const a = merged.find(c => c.userId === ID_A)!;
    expect(a.usernames.sort()).toEqual(['Prolix', 'prolix-dev']);
    expect(a.scopes.sort()).toEqual(['111', '222']);
  });

  test('rows without a username still contribute their id and scope', () => {
    const merged = mergeUserCandidates([{ userId: ID_A, username: '', scope: '111' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.userId).toBe(ID_A);
    expect(merged[0]!.usernames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('decideConfirmation', () => {
  test('--force allows a non-interactive run', () => {
    const decision = decideConfirmation({
      force: true,
      interactive: false,
      userId: ID_A,
      username: 'Prolix',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe('forced');
  });

  test('non-interactive without --force refuses', () => {
    const decision = decideConfirmation({
      force: false,
      interactive: false,
      userId: ID_A,
      username: 'Prolix',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe('refused');
    expect(decision.reason).toContain('non-interactive');
  });

  test('an interactive run prompts with the numeric id as the token', () => {
    const decision = decideConfirmation({
      force: false,
      interactive: true,
      userId: ID_A,
      username: 'Prolix',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe('prompt');
    // The id, not the display name: a nickname is what made the old target
    // resolution unsafe in the first place.
    expect(decision.expectedToken).toBe(ID_A);
  });

  test('CI never grants consent', () => {
    const previous = process.env.CI;
    process.env.CI = 'true';
    try {
      const decision = decideConfirmation({
        force: false,
        interactive: false,
        userId: ID_A,
        username: 'Prolix',
      });
      expect(decision.allowed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CI;
      else process.env.CI = previous;
    }
  });

  test('FORCE_WIPE never grants consent', () => {
    const previous = process.env.FORCE_WIPE;
    process.env.FORCE_WIPE = 'true';
    try {
      const decision = decideConfirmation({
        force: false,
        interactive: false,
        userId: ID_A,
        username: 'Prolix',
      });
      expect(decision.allowed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.FORCE_WIPE;
      else process.env.FORCE_WIPE = previous;
    }
  });
});

describe('matchesConfirmation', () => {
  const target = { userId: ID_A, username: 'Prolix' };

  test('accepts the exact id and the username', () => {
    expect(matchesConfirmation(ID_A, target)).toBe(true);
    expect(matchesConfirmation('Prolix', target)).toBe(true);
    expect(matchesConfirmation('prolix', target)).toBe(true);
    expect(matchesConfirmation(`  ${ID_A}  `, target)).toBe(true);
  });

  test('rejects empty input, another id, and partial matches', () => {
    expect(matchesConfirmation('', target)).toBe(false);
    expect(matchesConfirmation('   ', target)).toBe(false);
    expect(matchesConfirmation(ID_B, target)).toBe(false);
    expect(matchesConfirmation(ID_A.slice(0, -1), target)).toBe(false);
    expect(matchesConfirmation(`${ID_A}0`, target)).toBe(false);
    expect(matchesConfirmation('Prolixx', target)).toBe(false);
    expect(matchesConfirmation('Pro', target)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('runDestructiveSteps', () => {
  test('records success for every step when nothing throws', async () => {
    const result = await runDestructiveSteps([
      { name: 'memories', run: () => undefined },
      { name: 'conversations', run: async () => undefined },
    ]);

    expect(result.outcomes.map(o => o.ok)).toEqual([true, true]);
    expect(result.failed).toHaveLength(0);
    expect(result.succeeded).toHaveLength(2);
  });

  test('a throwing step is reported as failed and the rest still run', async () => {
    const ran: string[] = [];

    const result = await runDestructiveSteps([
      {
        name: 'memories',
        run: () => {
          ran.push('memories');
        },
      },
      {
        name: 'conversations',
        run: () => {
          ran.push('conversations');
          throw new Error('database is locked');
        },
      },
      {
        name: 'boredom',
        run: () => {
          ran.push('boredom');
        },
      },
    ]);

    // The wipe must not abort silently: the operator is told which parts ran.
    expect(ran).toEqual(['memories', 'conversations', 'boredom']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.name).toBe('conversations');
    expect(result.failed[0]!.error).toContain('database is locked');
    // Non-empty failures are what stop the caller from printing "WIPE COMPLETE"
    // and setting exit code 0.
    expect(result.failed.length > 0).toBe(true);
  });

  test('a rejected promise is captured, not thrown', async () => {
    const result = await runDestructiveSteps([
      { name: 'async-fail', run: async () => Promise.reject(new Error('boom')) },
    ]);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain('boom');
  });

  test('a non-Error throw still produces a readable message', async () => {
    const result = await runDestructiveSteps([
      { name: 'weird', run: () => { throw 'plain string'; } },
    ]);

    expect(result.failed[0]!.error).toBe('plain string');
  });

  test('zero steps succeeds vacuously', async () => {
    const result = await runDestructiveSteps([]);
    expect(result.outcomes).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('missingDatabases', () => {
  const specs = [
    { label: 'user memories', path: '/data/user_memories.db' },
    { label: 'conversation history', path: '/data/conversations.db' },
  ];

  test('reports every spec whose file is absent', () => {
    const existing = new Set(['/data/user_memories.db']);
    const missing = missingDatabases(specs, path => existing.has(path));

    expect(missing.map(s => s.label)).toEqual(['conversation history']);
  });

  test('reports nothing when all files exist', () => {
    expect(missingDatabases(specs, () => true)).toEqual([]);
  });

  test('reports everything when the data directory is wrong', () => {
    // The CWD-relative bug in its purest form: every lookup misses.
    expect(missingDatabases(specs, () => false)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('separates flags from positionals', () => {
    const parsed = parseArgs(['Prolix', '--force', '--dry-run']);
    expect(parsed.positional).toEqual(['Prolix']);
    expect(parsed.flags.has('--force')).toBe(true);
    expect(parsed.flags.has('--dry-run')).toBe(true);
    expect(parsed.unknownFlags).toEqual([]);
  });

  test('an unknown flag is reported rather than ignored', () => {
    // A mistyped `--dry-runn` must not silently run a destructive import.
    const parsed = parseArgs(['--dry-runn']);
    expect(parsed.unknownFlags).toEqual(['--dry-runn']);
  });

  test('an empty argv yields nothing', () => {
    const parsed = parseArgs([]);
    expect(parsed.positional).toEqual([]);
    expect(parsed.flags.size).toBe(0);
  });

  test('help is recognised in either spelling', () => {
    expect(wantsHelp(parseArgs(['--help']))).toBe(true);
    expect(wantsHelp(parseArgs(['-h']))).toBe(true);
    expect(wantsHelp(parseArgs(['--force']))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('dbPath migration', () => {
  /**
   * A source-level assertion is the right tool here: the failure mode is a
   * literal string in a call expression, not runtime behaviour. Any
   * `new Database('something.db')` re-introduces the silent-empty-database
   * data-loss trap, and it can only be caught by reading the source.
   *
   * Comments are stripped first: several of these files carry header comments
   * that name the exact identifiers they no longer use (`boredom_settings`,
   * `process.env.CI`, the old filenames), and the assertions below are about
   * code, not prose.
   */
  function scriptSources(): Array<{ file: string; source: string }> {
    return readdirSync(SCRIPTS_DIR)
      .filter(name => name.endsWith('.ts'))
      .map(name => ({
        file: name,
        source: stripComments(readFileSync(join(SCRIPTS_DIR, name), 'utf8')),
      }));
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  /**
   * Every `*.db` filename literal must sit inside a `dbPath(...)` call.
   *
   * Removing the legal `dbPath('name.db')` calls first leaves any *other*
   * `'something.db'` literal, which is precisely the CWD-relative form that
   * silently created a fresh empty database when the script ran from the wrong
   * directory. Backup filenames are built by string-appending to a `dbPath()`
   * result, so they are not literals and do not appear here.
   */
  function bareDbLiterals(source: string): string[] {
    const withoutDbPath = source.replace(/dbPath\(\s*['"`][\w.-]+['"`]\s*\)/g, 'dbPath()');
    return [...withoutDbPath.matchAll(/['"`][\w.-]+\.db['"`]/g)].map(match => match[0]);
  }

  test('no script hardcodes a *.db filename outside a dbPath() call', () => {
    const offenders: string[] = [];

    for (const { file, source } of scriptSources()) {
      for (const literal of bareDbLiterals(source)) {
        offenders.push(`${file}: ${literal}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('no script passes a bare relative filename to new Database()', () => {
    // `new Database('user_memories.db')` is the original defect verbatim.
    const offenders: string[] = [];

    for (const { file, source } of scriptSources()) {
      for (const match of source.matchAll(/new Database\(\s*['"`][^'"`]+['"`]/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every new Database() argument is dbPath-derived', () => {
    // Accept either an inline `dbPath(...)` or a module constant assigned from
    // `dbPath(...)` / a helper parameter, and reject string literals outright.
    let opens = 0;
    const offenders: string[] = [];

    for (const { file, source } of scriptSources()) {
      const dbPathConstants = new Set(
        [...source.matchAll(/(?:const|let|var)\s+([A-Z0-9_]+)\s*=\s*dbPath\(/g)].map(match => match[1]!)
      );

      for (const match of source.matchAll(/new Database\(\s*([^,\n)]+)/g)) {
        opens++;
        const argument = match[1]!.trim();
        const isDbPathCall = argument.startsWith('dbPath(');
        const isDbPathConstant = dbPathConstants.has(argument);
        // Helper functions such as openDatabase(path) receive values that are
        // already dbPath results; they take no string literal.
        const isPlainIdentifier = /^[A-Za-z_$][\w$]*$/.test(argument);

        if (!isDbPathCall && !isDbPathConstant && !isPlainIdentifier) {
          offenders.push(`${file}: new Database(${argument})`);
        }
        if (argument.startsWith("'") || argument.startsWith('"')) {
          offenders.push(`${file}: new Database(${argument})`);
        }
      }
    }

    // The migration is actually applied, not merely absent.
    expect(opens).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('re-attribute and wipe assert the databases exist before opening them', () => {
    for (const name of ['wipe-memories.ts', 'reattribute-memories.ts']) {
      const source = stripComments(readFileSync(join(SCRIPTS_DIR, name), 'utf8'));
      expect(source).toContain('missingDatabases');
      expect(source).toContain('existsSync');
    }
  });

  test('re-attribute backs up with VACUUM INTO, not a raw byte copy', () => {
    const source = stripComments(readFileSync(join(SCRIPTS_DIR, 'reattribute-memories.ts'), 'utf8'));
    expect(source).toContain('VACUUM INTO');
    expect(source).not.toContain('arrayBuffer');
  });

  test('re-attribute wraps each database update in a transaction', () => {
    const source = stripComments(readFileSync(join(SCRIPTS_DIR, 'reattribute-memories.ts'), 'utf8'));
    expect(source).toContain("memories.run('BEGIN')");
    expect(source).toContain("memories.run('ROLLBACK')");
    expect(source).toContain("conversations.run('BEGIN')");
    expect(source).toContain("conversations.run('ROLLBACK')");
  });

  test('no script queries the non-existent boredom_settings table', () => {
    // boredom.db only ever held `boredom_state(key, value)`; there is no
    // per-user boredom table, and querying it aborted both scripts.
    for (const { file, source } of scriptSources()) {
      expect(source.includes('boredom_settings')).toBe(false);
      expect(file).toMatch(/\.ts$/);
    }
  });

  test('no script keys destructive behaviour off CI', () => {
    for (const { file, source } of scriptSources()) {
      expect(source.includes('process.env.CI')).toBe(false);
      expect(file).toMatch(/\.ts$/);
    }
  });

  test('the docs importer backs up and gates its clear step behind --force', () => {
    const source = stripComments(readFileSync(join(SCRIPTS_DIR, 'import-lumiverse-docs.ts'), 'utf8'));
    expect(source).toContain('VACUUM INTO');
    expect(source).toContain('--force');
    expect(source).toContain('--dry-run');
  });
});

// ---------------------------------------------------------------------------

describe('test fixture sanity', () => {
  test('SCRIPTS_DIR is a directory containing the scripts under test', () => {
    expect(statSync(SCRIPTS_DIR).isDirectory()).toBe(true);
    expect(statSync(join(SCRIPTS_DIR, 'wipe-memories.ts')).isFile()).toBe(true);
    expect(statSync(join(SCRIPTS_DIR, 'reattribute-memories.ts')).isFile()).toBe(true);
    expect(statSync(join(SCRIPTS_DIR, 'safety.ts')).isFile()).toBe(true);
  });
});