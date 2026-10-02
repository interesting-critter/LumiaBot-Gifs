/**
 * Shared, dependency-free decision logic for the maintenance scripts.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Everything under `src/scripts/` deletes or rewrites user data, and the
 * failures that hurt were never "the SQL was wrong" — they were "the script
 * decided to be destructive for a reason the operator did not intend":
 *
 *   - `wipe-memories.ts` resolved its victim with `LOWER(username) = ?
 *     LIMIT 1`. `username` is filled from `member.displayName`
 *     (`bot/client.ts`), which is a *per-guild nickname* and is not unique. So
 *     "wipe Prolix" could delete a stranger's memories.
 *   - The confirmation prompt printed "type the username" and then called
 *     `process.exit(0)` **without ever reading stdin**, so it was a no-op, and
 *     `if (process.env.CI || process.env.FORCE_WIPE)` turned any CI shell into
 *     an unattended delete button.
 *   - Every per-step error was swallowed, so a half-applied wipe still printed
 *     `WIPE COMPLETE`.
 *
 * The decision logic therefore lives here, in pure functions with no database
 * and no filesystem access, so it can be unit-tested directly instead of by
 * pointing a destructive script at real user data.
 *
 * This module must stay free of service imports: several services construct
 * their SQLite handle at module load, which would silently *create* the
 * database the caller is about to assert must already exist.
 */

/**
 * Discord snowflakes are 17-20 digits. Used instead of "looks like a number" so
 * a username that happens to be numeric can never be mistaken for an ID.
 */
export const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isDiscordSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value.trim());
}

/** True when the process can actually ask a human a question. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Flags every destructive script understands. Anything else is rejected as a
 * typo rather than ignored, because a mistyped `--dry-run` that silently
 * imports is exactly the class of accident this module exists to prevent.
 */
export const KNOWN_FLAGS = ['--force', '--dry-run', '--all', '--help', '-h'] as const;

export interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  unknownFlags: string[];
}

export function parseArgs(argv: readonly string[], known: readonly string[] = KNOWN_FLAGS): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const unknownFlags: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith('-')) {
      if (known.includes(arg)) {
        flags.add(arg);
      } else {
        unknownFlags.push(arg);
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, unknownFlags };
}

export function wantsHelp(parsed: ParsedArgs): boolean {
  return parsed.flags.has('--help') || parsed.flags.has('-h');
}

// ---------------------------------------------------------------------------
// Target resolution: name -> user id
// ---------------------------------------------------------------------------

/** One database row that mentions a user, used to build candidate lists. */
export interface UserRefRow {
  userId: string;
  username: string;
  /** Guild scope, or `'legacy'` for rows predating guild scoping. */
  scope?: string;
}

/** A distinct account, merged across every row that mentioned it. */
export interface UserCandidate {
  userId: string;
  /** Every distinct display name seen for this id (nicknames vary per guild). */
  usernames: string[];
  /** Guild scopes (or `'legacy'`) the id appears in. Informational. */
  scopes: string[];
}

export function mergeUserCandidates(rows: readonly UserRefRow[]): UserCandidate[] {
  const byId = new Map<string, { usernames: Set<string>; scopes: Set<string> }>();

  for (const row of rows) {
    let entry = byId.get(row.userId);
    if (!entry) {
      entry = { usernames: new Set<string>(), scopes: new Set<string>() };
      byId.set(row.userId, entry);
    }
    if (row.username) entry.usernames.add(row.username);
    if (row.scope) entry.scopes.add(row.scope);
  }

  return [...byId.entries()].map(([userId, value]) => ({
    userId,
    usernames: [...value.usernames].sort(),
    scopes: [...value.scopes].sort(),
  }));
}

export type TargetResolution =
  | { status: 'resolved'; candidate: UserCandidate }
  /** Two or more distinct accounts share the display name — never guess. */
  | { status: 'ambiguous'; identifier: string; candidates: UserCandidate[] }
  | { status: 'not-found'; identifier: string };

/**
 * Decide which account an identifier refers to.
 *
 * A snowflake is authoritative: it *is* the account. Anything else is a
 * display name, and display names are not unique — so a name that matches two
 * different accounts is a refusal, not a coin flip.
 */
export function resolveTarget(identifier: string, candidates: readonly UserCandidate[]): TargetResolution {
  const trimmed = identifier.trim();

  if (isDiscordSnowflake(trimmed)) {
    const match = candidates.find(candidate => candidate.userId === trimmed);
    return match ? { status: 'resolved', candidate: match } : { status: 'not-found', identifier: trimmed };
  }

  const normalized = trimmed.toLowerCase();
  const matches = candidates.filter(candidate => candidate.usernames.some(name => name.toLowerCase() === normalized));

  if (matches.length > 1) {
    return { status: 'ambiguous', identifier: trimmed, candidates: matches };
  }
  if (matches.length === 1) {
    return { status: 'resolved', candidate: matches[0]! };
  }
  return { status: 'not-found', identifier: trimmed };
}

// ---------------------------------------------------------------------------
// Confirmation gate
// ---------------------------------------------------------------------------

export interface ConfirmationDecision {
  /** May the destructive work start? */
  allowed: boolean;
  /** How the operator proved intent. */
  mode: 'forced' | 'prompt' | 'refused';
  /** Token the operator must type, when `mode === 'prompt'`. */
  expectedToken?: string;
  /** Human-readable explanation shown when `allowed === false`. */
  reason?: string;
}

/**
 * Decide whether a destructive step may run.
 *
 * `CI` is deliberately **not** consulted. An automation environment is not a
 * human saying yes, and keying deletion off it is what turned this script into
 * an unattended delete button: any CI job that happened to pass a display name
 * destroyed that account's data with no prompt and no `--force`.
 */
export function decideConfirmation(input: {
  force: boolean;
  interactive: boolean;
  userId: string;
  username: string;
}): ConfirmationDecision {
  const { force, interactive, userId, username } = input;

  if (force) {
    return { allowed: true, mode: 'forced' };
  }

  if (!interactive) {
    return {
      allowed: false,
      mode: 'refused',
      reason:
        'Refusing to run without confirmation: this shell is non-interactive (no TTY), so the ' +
        'confirmation prompt cannot be answered. Re-run with --force once you have verified the ' +
        'target Discord user ID above.',
    };
  }

  return { allowed: true, mode: 'prompt', expectedToken: userId || username };
}

/**
 * Compare the operator's typed answer against the target.
 *
 * The ID is what the prompt asks for and the only globally unique handle; the
 * username is also accepted because the prompt echoes it and operators copy
 * from their terminal. Comparison is exact — a prefix, a substring or a
 * case-folded snowflake is not a confirmation.
 */
export function matchesConfirmation(input: string, target: { userId: string; username: string }): boolean {
  const typed = input.trim();
  if (!typed) return false;
  if (target.userId && typed === target.userId) return true;
  return Boolean(target.username) && typed.toLowerCase() === target.username.toLowerCase();
}

/**
 * Read one line from stdin. Resolves to `null` when stdin is closed or not a
 * TTY, which callers must treat as "not confirmed" rather than "confirmed".
 */
export async function readConfirmationLine(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(prompt);
    return await rl.question('');
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Step runner: never report success for a partial failure
// ---------------------------------------------------------------------------

export interface DestructiveStep {
  name: string;
  run: () => void | Promise<void>;
}

export interface StepOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export interface StepRunResult {
  outcomes: StepOutcome[];
  failed: StepOutcome[];
  succeeded: StepOutcome[];
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run destructive steps in order, recording each failure instead of swallowing
 * it.
 *
 * The old script wrapped every step in its own `try/catch` that only logged,
 * then unconditionally printed `WIPE COMPLETE`. An operator could not tell a
 * full wipe from one where the conversation delete had thrown — and the exit
 * code was 0 either way, so CI was told it had worked.
 */
export async function runDestructiveSteps(steps: readonly DestructiveStep[]): Promise<StepRunResult> {
  const outcomes: StepOutcome[] = [];

  for (const step of steps) {
    try {
      await step.run();
      outcomes.push({ name: step.name, ok: true });
    } catch (error) {
      outcomes.push({ name: step.name, ok: false, error: describeError(error) });
    }
  }

  const failed = outcomes.filter(outcome => !outcome.ok);
  return { outcomes, failed, succeeded: outcomes.filter(outcome => outcome.ok) };
}

// ---------------------------------------------------------------------------
// Pre-flight: refuse to touch a database we may have just created
// ---------------------------------------------------------------------------

export interface DatabaseSpec {
  /** Absolute path. */
  path: string;
  /** Friendly name for error messages. */
  label: string;
}

/**
 * Return the specs whose file is missing.
 *
 * `new Database(path)` **creates** the file when it is absent. A script that
 * opens a CWD-relative (or wrongly rooted) path therefore gets a pristine
 * empty database and happily reports "0 memories found" for a user who
 * demonstrably has them. Checking existence first turns that silent data loss
 * into a loud refusal.
 */
export function missingDatabases(specs: readonly DatabaseSpec[], exists: (path: string) => boolean): DatabaseSpec[] {
  return specs.filter(spec => !exists(spec.path));
}