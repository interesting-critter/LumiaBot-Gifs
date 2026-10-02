#!/usr/bin/env bun
/**
 * Memory Wipe Script for Lumia
 *
 * Irreversibly erases every stored trace of one Discord user: their long-term
 * opinion profile, pronouns, third-party context, the individual memory rows
 * derived from them, and their full conversation history in every guild.
 *
 * Usage:
 *   bun run wipe-memories <discord_user_id> [--force]
 *   bun run wipe-memories <display_name>   [--force] [--dry-run]
 *
 * Deleting by ID is always safe to confirm. Deleting by display name resolves
 * through an explicit disambiguation step first, because display names are
 * per-guild nicknames and are not unique.
 *
 * WHY THE CONFIRMATION IS STRICT
 * ------------------------------
 * This script previously printed "type the username" and then exited without
 * ever reading stdin, so the documented confirmation did nothing; and it
 * skipped the prompt entirely whenever `CI` or `FORCE_WIPE` was set, which
 * meant any automation shell could delete a user with no prompt at all. It now
 * reads a real line from stdin and refuses entirely when it cannot.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { dbPath } from '../utils/paths';
import {
  decideConfirmation,
  isInteractive,
  matchesConfirmation,
  mergeUserCandidates,
  missingDatabases,
  parseArgs,
  readConfirmationLine,
  runDestructiveSteps,
  wantsHelp,
  type DestructiveStep,
  type UserCandidate,
  type UserRefRow,
  resolveTarget,
} from './safety';

/**
 * Absolute paths from `utils/paths`. These were CWD-relative filenames, which
 * meant running this from any other directory silently created a brand-new
 * empty database — and "no memories found" for a user who demonstrably had
 * them, followed by a wipe of that empty file.
 */
const USER_MEMORIES_PATH = dbPath('user_memories.db');
const CONVERSATIONS_PATH = dbPath('conversations.db');

const REQUIRED_DATABASES = [
  { label: 'user memories', path: USER_MEMORIES_PATH },
  { label: 'conversation history', path: CONVERSATIONS_PATH },
];

interface UserStats {
  opinionProfiles: number;
  memoryEntries: number;
  thirdPartyEntries: number;
  conversationMessages: number;
  guilds: string[];
}

/**
 * `user_memory_entries` was added after the original schema, so a database
 * that has not been opened by the bot since the upgrade may not have it.
 */
function tableExists(db: Database, table: string): boolean {
  return (db
    .query(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { count: number }).count > 0;
}

function countRows(db: Database, sql: string, ...params: string[]): number {
  return (db.query(sql).get(...params) as { count: number }).count;
}

function openDatabase(path: string): Database {
  // The file's existence is asserted before any open. `new Database(path)`
  // creates a missing file, so opening first would defeat that check.
  return new Database(path);
}

function assertDatabasesExist(): boolean {
  const missing = missingDatabases(REQUIRED_DATABASES, existsSync);
  if (missing.length === 0) return true;

  console.error('❌ Refusing to run: the following databases do not exist:');
  for (const spec of missing) {
    console.error(`   - ${spec.label}: ${spec.path}`);
  }
  console.error('\n`new Database()` creates a missing file, so continuing would wipe a brand-new');
  console.error('empty database and report success. Start the bot once to create its databases,');
  console.error('or check that DATA_DIR points at the directory the bot actually uses.');
  return false;
}

/**
 * Every row that mentions a user, from both databases.
 *
 * The previous version ran `LOWER(username) = LOWER(?) LIMIT 1`. Because
 * `username` is populated from `member.displayName` — a per-guild nickname,
 * not a unique account handle — that could select a completely different
 * person, and then permanently delete their memories. Collecting all rows lets
 * the resolver refuse instead of guessing.
 */
function collectUserRefs(): UserRefRow[] {
  interface RawRow {
    user_id?: string | null;
    username?: string | null;
    guild_id?: string | null;
  }

  const raw: RawRow[] = [];

  const memories = openDatabase(USER_MEMORIES_PATH);
  try {
    raw.push(...(memories.query('SELECT user_id, username, guild_id FROM user_opinions').all() as RawRow[]));
    if (tableExists(memories, 'user_memory_entries')) {
      // `user_memory_entries` has no username column in the current schema, so
      // rows from here carry the id and scope only; the resolver merges them
      // with the names already seen for the same id.
      raw.push(
        ...(memories
          .query('SELECT user_id, NULL AS username, guild_id FROM user_memory_entries')
          .all() as RawRow[])
      );
    }
  } finally {
    memories.close();
  }

  const conversations = openDatabase(CONVERSATIONS_PATH);
  try {
    raw.push(...(conversations.query('SELECT user_id, username, guild_id FROM conversation_messages').all() as RawRow[]));
  } finally {
    conversations.close();
  }

  const refs: UserRefRow[] = [];
  for (const row of raw) {
    if (typeof row.user_id !== 'string') continue;
    refs.push({
      userId: row.user_id,
      username: typeof row.username === 'string' ? row.username : '',
      scope: typeof row.guild_id === 'string' ? row.guild_id : undefined,
    });
  }
  return refs;
}

/**
 * Read what is about to be destroyed.
 *
 * This deliberately does **not** swallow errors. It previously caught every
 * exception and reported `false`/`0`, so a broken query was displayed to the
 * operator as "this user has no memories" immediately before the wipe — the
 * exact moment where a wrong answer is most dangerous.
 */
function getUserStats(userId: string): UserStats {
  const memories = openDatabase(USER_MEMORIES_PATH);
  let opinionProfiles: number;
  let memoryEntries = 0;
  let thirdPartyEntries = 0;

  try {
    opinionProfiles = countRows(memories, 'SELECT COUNT(*) AS count FROM user_opinions WHERE user_id = ?', userId);
    if (tableExists(memories, 'user_memory_entries')) {
      memoryEntries = countRows(memories, 'SELECT COUNT(*) AS count FROM user_memory_entries WHERE user_id = ?', userId);
      thirdPartyEntries = countRows(
        memories,
        "SELECT COUNT(*) AS count FROM user_memory_entries WHERE user_id = ? AND kind = 'third_party'",
        userId
      );
    }
  } finally {
    memories.close();
  }

  const conversations = openDatabase(CONVERSATIONS_PATH);
  let conversationMessages: number;
  let guilds: string[];
  try {
    conversationMessages = countRows(
      conversations,
      'SELECT COUNT(*) AS count FROM conversation_messages WHERE user_id = ?',
      userId
    );
    guilds = (conversations
      .query('SELECT DISTINCT guild_id FROM conversation_messages WHERE user_id = ? ORDER BY guild_id')
      .all(userId) as Array<{ guild_id: string }>).map(row => row.guild_id);
  } finally {
    conversations.close();
  }

  return { opinionProfiles, memoryEntries, thirdPartyEntries, conversationMessages, guilds };
}

interface WipeCounts {
  opinionProfilesDeleted: number;
  memoryEntriesDeleted: number;
  conversationMessagesDeleted: number;
}

/**
 * Build the deletion steps.
 *
 * Each database's work is wrapped in its own transaction: a partial failure
 * must not leave memories deleted from one table but not another in the same
 * file. `user_opinions` holds the opinion, pronouns and third-party context
 * columns; `user_memory_entries` holds the individual rows those blobs were
 * split into, so both have to go for erasure to be complete.
 */
function buildWipeSteps(userId: string, counts: WipeCounts): DestructiveStep[] {
  return [
    {
      name: 'user memories (opinion, pronouns, third-party context, memory entries)',
      run: () => {
        const memories = openDatabase(USER_MEMORIES_PATH);
        try {
          memories.run('BEGIN');
          try {
            if (tableExists(memories, 'user_memory_entries')) {
              counts.memoryEntriesDeleted = memories.run(
                'DELETE FROM user_memory_entries WHERE user_id = ?',
                [userId]
              ).changes;
            }
            counts.opinionProfilesDeleted = memories.run(
              'DELETE FROM user_opinions WHERE user_id = ?',
              [userId]
            ).changes;
            memories.run('COMMIT');
          } catch (error) {
            memories.run('ROLLBACK');
            throw error;
          }
        } finally {
          memories.close();
        }
      },
    },
    {
      name: 'conversation history (all guilds)',
      run: () => {
        const conversations = openDatabase(CONVERSATIONS_PATH);
        try {
          conversations.run('BEGIN');
          try {
            counts.conversationMessagesDeleted = conversations.run(
              'DELETE FROM conversation_messages WHERE user_id = ?',
              [userId]
            ).changes;
            conversations.run('COMMIT');
          } catch (error) {
            conversations.run('ROLLBACK');
            throw error;
          }
        } finally {
          conversations.close();
        }
      },
    },
  ];
}

function describeCandidate(candidate: UserCandidate): string {
  const names = candidate.usernames.length > 0 ? candidate.usernames.join(' / ') : '(no display name)';
  const guilds = candidate.scopes.length > 0 ? candidate.scopes.join(', ') : 'unknown';
  return `  ${candidate.userId}  "${names}"  [guilds: ${guilds}]`;
}

function printUsage(): void {
  console.log(`
🧹 Lumia Memory Wipe Tool

Usage:
  bun run wipe-memories <discord_user_id> [--force]
  bun run wipe-memories <display_name>   [--force] [--dry-run]

Options:
  --force      Skip the interactive confirmation. Required in any non-interactive
               shell (cron, CI, a piped heredoc). Nothing about the environment
               implies consent any more.
  --dry-run    Show exactly what would be deleted, then exit without writing.

This permanently deletes, for one Discord user:
  - their long-term opinion profile, pronouns and third-party context
  - every individual memory entry recorded about them
  - their conversation messages in every guild

Deletion by display name resolves to a Discord user ID first and prints it for
confirmation; a name shared by more than one account is refused.

⚠️  There is no undo. Take a copy of the database first if you might need it.
  `);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (wantsHelp(parsed)) {
    printUsage();
    return;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(`❌ Unknown option(s): ${parsed.unknownFlags.join(', ')}`);
    console.error('A mistyped flag must not silently run a destructive script.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.positional.length === 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.positional.length > 1) {
    console.error('❌ Expected exactly one user identifier. Ambiguous input is refused rather than guessed.');
    process.exitCode = 1;
    return;
  }

  const identifier = parsed.positional[0]!;
  const force = parsed.flags.has('--force');
  const dryRun = parsed.flags.has('--dry-run');

  if (!assertDatabasesExist()) {
    process.exitCode = 1;
    return;
  }

  console.log(`\n🔍 Resolving "${identifier}"...`);

  const resolution = resolveTarget(identifier, mergeUserCandidates(collectUserRefs()));

  if (resolution.status === 'ambiguous') {
    console.error(`\n❌ "${resolution.identifier}" matches ${resolution.candidates.length} different Discord accounts:`);
    for (const candidate of resolution.candidates) console.error(describeCandidate(candidate));
    console.error('\nDisplay names are per-guild nicknames and are not unique, so this script refuses to');
    console.error('guess which one you meant. Re-run with the numeric Discord user ID.');
    console.error('Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  if (resolution.status === 'not-found') {
    console.error(`\n❌ No stored data found for "${identifier}".`);
    console.error('Nothing was changed. Check the ID, or confirm the bot has ever seen this user.');
    process.exitCode = 1;
    return;
  }

  const target = resolution.candidate;
  const username = target.usernames[0] ?? target.userId;

  // Echo the numeric ID even when the operator supplied a name: the ID is the
  // only handle that cannot be ambiguous, so it is what they must confirm.
  console.log(`\n✓ Resolved to Discord user ID ${target.userId}`);
  console.log(`  Display name(s): ${target.usernames.length > 0 ? target.usernames.join(' / ') : '(none recorded)'}`);
  console.log(`  Guild scopes:    ${target.scopes.length > 0 ? target.scopes.join(', ') : 'none recorded'}`);

  let stats: UserStats;
  try {
    stats = getUserStats(target.userId);
  } catch (error) {
    console.error('\n❌ Could not read the current memory state:', error);
    console.error('Refusing to wipe: a failed lookup is indistinguishable from an empty one, and the');
    console.error('summary you would be shown right now would be a guess. Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  console.log('\n📊 What would be deleted:');
  console.log(`  Opinion profiles (incl. pronouns, third-party context): ${stats.opinionProfiles}`);
  console.log(`  Individual memory entries:                             ${stats.memoryEntries}`);
  console.log(`  ...of which third-party references:                    ${stats.thirdPartyEntries}`);
  console.log(`  Conversation messages:                                  ${stats.conversationMessages}`);
  console.log(`  Guilds with history:                                    ${stats.guilds.length > 0 ? stats.guilds.join(', ') : 'none'}`);

  const totalRecords =
    stats.opinionProfiles + stats.memoryEntries + stats.conversationMessages;

  if (totalRecords === 0) {
    console.log('\nℹ No stored records for this user. Nothing to wipe.');
    return;
  }

  if (dryRun) {
    console.log(`\n🏃 Dry run: ${totalRecords} record(s) would be deleted. No changes made.`);
    return;
  }

  console.log('\n⚠️  WARNING: this permanently deletes all stored data for this user.');
  console.log(`   Target Discord user ID: ${target.userId}`);
  console.log('   This cannot be undone.\n');

  const decision = decideConfirmation({
    force,
    interactive: isInteractive(),
    userId: target.userId,
    username,
  });

  if (!decision.allowed) {
    console.error(`❌ ${decision.reason}`);
    console.error(`\nTo proceed anyway: bun run wipe-memories ${target.userId} --force`);
    console.error('To preview first:   bun run wipe-memories ' + target.userId + ' --dry-run');
    process.exitCode = 1;
    return;
  }

  if (decision.mode === 'prompt') {
    const answer = await readConfirmationLine(
      `Type the Discord user ID to confirm deletion (${target.userId}): `
    );

    if (answer === null || !matchesConfirmation(answer, { userId: target.userId, username })) {
      console.error('\n❌ Confirmation did not match. Aborting; nothing was deleted.');
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('Confirmation skipped because --force was given.');
  }

  const counts: WipeCounts = {
    opinionProfilesDeleted: 0,
    memoryEntriesDeleted: 0,
    conversationMessagesDeleted: 0,
  };

  const result = await runDestructiveSteps(buildWipeSteps(target.userId, counts));

  console.log('\n' + '='.repeat(60));

  if (result.failed.length > 0) {
    // The previous version printed "WIPE COMPLETE" regardless of what had
    // actually happened, which told the operator (and CI) that a partial,
    // possibly inconsistent deletion had fully succeeded.
    console.log('WIPE INCOMPLETE');
    console.log('='.repeat(60));
    console.log(`Target: ${username} (${target.userId})`);
    console.log('\nThe following steps FAILED:');
    for (const failure of result.failed) {
      console.error(`  ✗ ${failure.name}: ${failure.error}`);
    }
    console.log('\nPartial results:');
    console.log(`  Opinion profiles deleted: ${counts.opinionProfilesDeleted}`);
    console.log(`  Memory entries deleted:   ${counts.memoryEntriesDeleted}`);
    console.log(`  Messages deleted:         ${counts.conversationMessagesDeleted}`);
    console.log('\n⚠️  Data for this user may still partially exist. Re-run the script, or restore');
    console.log('    from a backup, before considering the erasure complete.');
    process.exitCode = 1;
    return;
  }

  console.log('WIPE COMPLETE');
  console.log('='.repeat(60));
  console.log(`User: ${username} (${target.userId})`);
  console.log(`Opinion profiles deleted: ${counts.opinionProfilesDeleted}`);
  console.log(`Memory entries deleted:   ${counts.memoryEntriesDeleted}`);
  console.log(`Messages deleted:         ${counts.conversationMessagesDeleted}`);
  console.log('='.repeat(60));
  console.log('\n✨ All stored memories, pronouns, third-party context and conversation history');
  console.log('   for this user have been removed.\n');
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exitCode = 1;
});