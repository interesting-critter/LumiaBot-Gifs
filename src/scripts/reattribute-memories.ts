#!/usr/bin/env bun
/**
 * Reassign a Discord user's stored data to a replacement Discord account.
 *
 * Usage:
 *   bun run reattribute-memories <old_user_id> <new_user_id> [--force]
 *
 * The script first previews the migration. Re-run it with --force to create
 * database backups and apply it. Stop the bot before using this script.
 *
 * NOTE ON `boredom.db`
 * -------------------
 * This script used to touch a `boredom_settings(guild_id, user_id, enabled)`
 * table. No such table exists and none ever has: `src/services/boredom.ts`
 * creates only `boredom_state(key, value)`, a single global key/value table
 * with no user or guild column, and nothing in the repository ever writes a
 * per-user boredom preference (`boredomAction` is accepted by both AI services
 * but has zero producers). The references here therefore queried a table that
 * does not exist — which aborted the preview with `no such table` before any
 * output, so `--force` reattribution never ran at all. Per-user boredom state
 * is not user data and is not migrated; only the memories and conversation
 * tables below are, and they are now handled inside transactions.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { dbPath } from '../utils/paths';
import { missingDatabases, parseArgs, wantsHelp } from './safety';

/**
 * Absolute paths from `utils/paths`. These were CWD-relative filenames, so
 * running the script from any other directory opened — and, because
 * `new Database()` creates missing files, silently created — a brand-new empty
 * database. Every source count would then be zero and the migration would
 * "succeed" against nothing.
 */
const USER_MEMORIES_DB = dbPath('user_memories.db');
const CONVERSATIONS_DB = dbPath('conversations.db');

const REQUIRED_DATABASES = [
  { label: 'user memories', path: USER_MEMORIES_DB },
  { label: 'conversation history', path: CONVERSATIONS_DB },
];

const DISCORD_ID_PATTERN = /^\d{17,20}$/;

interface MigrationPreview {
  sourceOpinions: number;
  destinationOpinions: number;
  sourceMemoryEntries: number;
  destinationMemoryEntries: number;
  sourceMessages: number;
  destinationMessages: number;
}

function countRows(db: Database, table: string, userId: string): number {
  return (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId) as { count: number }).count;
}

/**
 * The individually-addressable memory rows live in a table added after the
 * original schema, so it may be absent from databases that have not been
 * opened by the bot since the upgrade.
 */
function tableExists(db: Database, table: string): boolean {
  return (db
    .query(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { count: number }).count > 0;
}

function countRowsIfPresent(db: Database, table: string, userId: string): number {
  return tableExists(db, table) ? countRows(db, table, userId) : 0;
}

function assertDatabasesExist(): boolean {
  const missing = missingDatabases(REQUIRED_DATABASES, existsSync);
  if (missing.length === 0) return true;

  console.error('❌ Refusing to run: the following databases do not exist:');
  for (const spec of missing) {
    console.error(`   - ${spec.label}: ${spec.path}`);
  }
  console.error('\nOpening a missing path would create an empty database and report a zero-row');
  console.error('migration as a success. Start the bot once to create its databases, or check');
  console.error('that DATA_DIR points at the directory the bot actually uses.');
  return false;
}

function collectPreview(oldUserId: string, newUserId: string): MigrationPreview {
  const memories = new Database(USER_MEMORIES_DB, { readonly: true });
  const conversations = new Database(CONVERSATIONS_DB, { readonly: true });

  try {
    return {
      sourceOpinions: countRows(memories, 'user_opinions', oldUserId),
      destinationOpinions: countRows(memories, 'user_opinions', newUserId),
      sourceMemoryEntries: countRowsIfPresent(memories, 'user_memory_entries', oldUserId),
      destinationMemoryEntries: countRowsIfPresent(memories, 'user_memory_entries', newUserId),
      sourceMessages: countRows(conversations, 'conversation_messages', oldUserId),
      destinationMessages: countRows(conversations, 'conversation_messages', newUserId),
    };
  } finally {
    memories.close();
    conversations.close();
  }
}

function describeConflicts(preview: MigrationPreview): string[] {
  const conflicts: string[] = [];

  // user_opinions has no uniqueness constraint, but duplicate profiles make
  // retrieval ambiguous. Require an explicit manual decision instead.
  if (preview.sourceOpinions > 0 && preview.destinationOpinions > 0) {
    conflicts.push('both user IDs have long-term memory records');
  }

  return conflicts;
}

/** Total source rows the migration expects to move. */
function sourceRowTotal(preview: MigrationPreview): number {
  return preview.sourceOpinions + preview.sourceMemoryEntries + preview.sourceMessages;
}

/**
 * Create consistent backups.
 *
 * The previous implementation copied the raw bytes of the live files with
 * `Bun.file(...).arrayBuffer()`. On a WAL database that captures the main file
 * without the `-wal` sidecar, so the copy could be missing recent commits —
 * exactly the rows this script is about to rewrite. `VACUUM INTO` produces a
 * single self-contained, transactionally consistent copy of the database
 * including any WAL contents, and it refuses to overwrite an existing file.
 */
function createBackups(): string[] {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const databases = [USER_MEMORIES_DB, CONVERSATIONS_DB];
  const backups: string[] = [];

  for (const database of databases) {
    const backup = `${database}.reattribution-${timestamp}.bak`;
    const source = new Database(database, { readonly: true });
    try {
      // The path is inlined because SQLite does not accept a bound parameter
      // for the VACUUM target; single quotes are escaped instead.
      source.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    backups.push(backup);
  }

  return backups;
}

/**
 * Apply the migration, one transaction per database.
 *
 * The previous version issued four bare `UPDATE`s with no transaction, so a
 * failure on the third left the migration half-applied: opinions moved to the
 * new account while conversation history stayed on the old one, with no way to
 * tell which rows had moved. Each database is now all-or-nothing.
 */
function applyMigration(oldUserId: string, newUserId: string): void {
  const memories = new Database(USER_MEMORIES_DB);
  try {
    memories.run('BEGIN');
    try {
      memories.run('UPDATE user_opinions SET user_id = ? WHERE user_id = ?', [newUserId, oldUserId]);
      // Individual memory rows must follow the profile, otherwise they would be
      // orphaned and invisible to the prompt builder.
      if (tableExists(memories, 'user_memory_entries')) {
        memories.run('UPDATE user_memory_entries SET user_id = ? WHERE user_id = ?', [newUserId, oldUserId]);
      }
      memories.run('COMMIT');
    } catch (error) {
      memories.run('ROLLBACK');
      throw error;
    }
  } finally {
    memories.close();
  }

  const conversations = new Database(CONVERSATIONS_DB);
  try {
    conversations.run('BEGIN');
    try {
      conversations.run('UPDATE conversation_messages SET user_id = ? WHERE user_id = ?', [newUserId, oldUserId]);
      conversations.run('COMMIT');
    } catch (error) {
      conversations.run('ROLLBACK');
      throw error;
    }
  } finally {
    conversations.close();
  }
}

function printUsage(): void {
  console.log(`
Reattribute stored memories to a replacement Discord account.

Usage:
  bun run reattribute-memories <old_user_id> <new_user_id> [--force]

The first run is a preview. --force creates backups and applies the migration.
Stop the bot before running with --force.
`);
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2), ['--force']);

  if (wantsHelp(parsed)) {
    printUsage();
    return;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(`❌ Unknown option(s): ${parsed.unknownFlags.join(', ')}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const force = parsed.flags.has('--force');
  const [oldUserId, newUserId] = parsed.positional;

  if (parsed.positional.length !== 2 || !oldUserId || !newUserId || !DISCORD_ID_PATTERN.test(oldUserId) || !DISCORD_ID_PATTERN.test(newUserId)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (oldUserId === newUserId) {
    console.error('The old and new Discord user IDs must be different.');
    process.exitCode = 1;
    return;
  }

  if (!assertDatabasesExist()) {
    process.exitCode = 1;
    return;
  }

  const preview = collectPreview(oldUserId, newUserId);
  const conflicts = describeConflicts(preview);

  console.log('\nReattribution preview');
  console.log(`  Source ID: ${oldUserId}`);
  console.log(`  Target ID: ${newUserId}`);
  console.log(`  Long-term memory records: ${preview.sourceOpinions}`);
  console.log(`  Individual memory entries: ${preview.sourceMemoryEntries}`);
  console.log(`  Conversation messages: ${preview.sourceMessages}`);
  console.log(`  Target conversation messages (unchanged, then shared under target): ${preview.destinationMessages}`);

  if (conflicts.length > 0) {
    console.error('\nMigration was not applied because:', ...conflicts.map(conflict => `\n  - ${conflict}`));
    console.error('\nResolve or choose how to merge the destination records before rerunning. No data was changed.');
    process.exitCode = 1;
    return;
  }

  // Zero source rows everywhere almost never means "there is nothing to do" —
  // it means the wrong ID was passed, or the databases were not the ones the
  // bot uses. Refusing here is what prevents a plausible-looking no-op.
  if (sourceRowTotal(preview) === 0) {
    console.error('\n❌ No stored records were found for the source ID in either database.');
    console.error('   Refusing to report an empty migration as a success — verify the source ID,');
    console.error('   and confirm these are the databases the bot actually uses. No data was changed.');
    process.exitCode = 1;
    return;
  }

  if (!force) {
    console.log('\nPreview only; no data was changed.');
    console.log(`To apply after stopping the bot:\n  bun run reattribute-memories ${oldUserId} ${newUserId} --force`);
    return;
  }

  console.log('\nCreating database backups...');
  const backups = createBackups();
  applyMigration(oldUserId, newUserId);

  console.log('\nReattribution complete. Backups created:');
  for (const backup of backups) console.log(`  - ${backup}`);
  console.log('\nThe stored username will update when the replacement account next speaks to the bot.');
}

try {
  main();
} catch (error) {
  console.error('Reattribution failed:', error);
  process.exitCode = 1;
}