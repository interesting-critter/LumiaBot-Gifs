import { Database } from 'bun:sqlite';
import { config } from '../utils/config';
import { dbPath } from '../utils/paths';
import type { ChatMessage } from './openai';

export interface ConversationEntry {
  /**
   * Row id from `conversation_messages.id`. Carried through so a caller that
   * wants to delete exactly one message (the dashboard) can name it, instead
   * of only being offered "delete this whole conversation". It is the
   * autoincrement primary key, so it is sequential and guessable — which is why
   * `deleteMessage` treats it as an untrusted hint and re-checks the owner
   * columns rather than trusting it.
   */
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface UserConversation {
  userId: string;
  username: string;
  messages: ConversationEntry[];
  lastActivity: string;
}

export class ConversationHistoryService {
  private db: Database;
  private maxHistoryLength: number;

  constructor(databasePath: string = dbPath('conversations.db')) {
    // Absolute path from utils/paths: a CWD-relative filename silently creates a
    // brand-new empty database when the bot is started from another directory.
    this.db = new Database(databasePath);
    this.maxHistoryLength = config.conversation.maxHistoryLength;
    this.applyPragmas();
    this.initDatabase();
    console.log(`💬 [CONVERSATION] History service initialized (${this.maxHistoryLength} messages max, persistent storage)`);
  }

  private applyPragmas(): void {
    try {
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA busy_timeout = 5000');
    } catch (error) {
      console.warn('💬 [CONVERSATION] Could not enable WAL/busy_timeout:', error);
    }
  }

  private initDatabase(): void {
    // Create conversations table with guild_id support
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);

    // Migration: Check if guild_id column exists (for existing databases)
    this.migrateAddColumn('guild_id', 'TEXT', 'legacy');

    // Create index for faster lookups (user + guild)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_user_guild ON conversation_messages(user_id, guild_id)
    `);

    // Create index for timestamp ordering
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_timestamp ON conversation_messages(timestamp)
    `);

    // Create index for guild-specific lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_guild ON conversation_messages(guild_id)
    `);

    console.log('💬 [CONVERSATION] Database initialized');
  }

  private migrateAddColumn(columnName: string, columnType: string, defaultValue: string): void {
    try {
      // Check if column exists
      const result = this.db.query(
        `SELECT COUNT(*) as count FROM pragma_table_info('conversation_messages') WHERE name = ?`
      ).get(columnName) as { count: number };

      if (result.count === 0) {
        // Column doesn't exist, add it
        this.db.run(`ALTER TABLE conversation_messages ADD COLUMN ${columnName} ${columnType} DEFAULT ${defaultValue}`);
        console.log(`💬 [CONVERSATION] Migration: Added column '${columnName}' with default '${defaultValue}'`);
      }
    } catch (error) {
      console.error(`💬 [CONVERSATION] Migration failed for column '${columnName}':`, error);
    }
  }

  /**
   * Add a message to the conversation history (guild-specific)
   */
  addMessage(userId: string, guildId: string, username: string, role: 'user' | 'assistant', content: string): void {
    const now = new Date().toISOString();

    // Insert the new message
    this.db.run(
      `INSERT INTO conversation_messages (user_id, guild_id, username, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, guildId, username, role, content, now]
    );

    // Get current message count for this user in this guild
    const countResult = this.db.query(
      'SELECT COUNT(*) as count FROM conversation_messages WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as { count: number };

    // Trim to max length (rolling window) - delete oldest messages.
    //
    // `timestamp` is `new Date().toISOString()`, i.e. millisecond resolution, and
    // handleMessage inserts the user's message and the assistant's reply in
    // adjacent awaits — so identical timestamps are reachable. Ordering by
    // timestamp alone lets SQLite pick an arbitrary row among the ties, which can
    // delete the assistant reply while keeping the user message and permanently
    // lopside the history. `id ASC` is the tiebreaker that makes the oldest-N
    // selection deterministic.
    if (countResult.count > this.maxHistoryLength) {
      const toDelete = countResult.count - this.maxHistoryLength;
      this.db.run(
        `DELETE FROM conversation_messages
         WHERE id IN (
           SELECT id FROM conversation_messages
           WHERE user_id = ? AND guild_id = ?
           ORDER BY timestamp ASC, id ASC
           LIMIT ?
         )`,
        [userId, guildId, toDelete]
      );
      console.log(`💬 [CONVERSATION] Trimmed ${toDelete} oldest messages for ${username} in guild ${guildId}`);
    }

    console.log(`💬 [CONVERSATION] Added ${role} message for ${username} in guild ${guildId}`);
  }

  /**
   * Get conversation history as ChatMessage array for OpenAI (guild-specific)
   */
  getHistory(userId: string, guildId: string): ChatMessage[] {
    // `id ASC` is a tiebreaker: timestamps have millisecond resolution and the
    // user message and its reply can land in the same millisecond.
    const results = this.db.query(
      `SELECT role, content, username, timestamp
       FROM conversation_messages
       WHERE user_id = ? AND guild_id = ?
       ORDER BY timestamp ASC, id ASC`
    ).all(userId, guildId) as Array<{ role: 'user' | 'assistant'; content: string; username: string; timestamp: string }>;

    // Convert to ChatMessage format with username attribution on user messages
    return results.map(msg => ({
      role: msg.role,
      content: msg.role === 'user' && msg.username
        ? `[${msg.username}]: ${msg.content}`
        : msg.content,
    }));
  }

  /**
   * Get the full conversation object (guild-specific)
   */
  getConversation(userId: string, guildId: string): UserConversation | null {
    const results = this.db.query(
      `SELECT id, user_id, username, role, content, timestamp 
       FROM conversation_messages 
       WHERE user_id = ? AND guild_id = ?
       ORDER BY timestamp ASC, id ASC`
    ).all(userId, guildId) as Array<{ id: number; user_id: string; username: string; role: 'user' | 'assistant'; content: string; timestamp: string }>;

    if (results.length === 0) {
      return null;
    }

    const firstResult = results[0];
    const lastResult = results[results.length - 1];
    
    if (!firstResult || !lastResult) {
      return null;
    }

    const messages: ConversationEntry[] = results.map(r => ({
      id: r.id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
    }));

    return {
      userId: firstResult.user_id,
      username: firstResult.username,
      messages,
      lastActivity: lastResult.timestamp,
    };
  }

  /**
   * Clear conversation history for a user in a guild
   */
  clearHistory(userId: string, guildId: string): void {
    const result = this.db.run(
      'DELETE FROM conversation_messages WHERE user_id = ? AND guild_id = ?',
      [userId, guildId]
    );
    
    if (result.changes > 0) {
      console.log(`💬 [CONVERSATION] Cleared ${result.changes} messages for user ${userId} in guild ${guildId}`);
    }
  }

  /**
   * Delete a single message from a user's conversation in a guild.
   *
   * `id` comes off a URL the dashboard was handed, and it is an autoincrement
   * primary key — small, dense and entirely predictable (the first message the
   * bot has ever stored is id 1). A `DELETE ... WHERE id = ?` on its own would
   * therefore let any authenticated dashboard caller remove a row out of a
   * guild it has no business touching just by counting up. So the id is treated
   * as nothing more than a hint *within* an already-authorised scope: `user_id`
   * and `guild_id` are bound alongside it, and a mismatch simply matches zero
   * rows. That mirrors every other read here — the guild is part of the key,
   * not a filter applied afterwards.
   *
   * Returns whether a row was actually removed, so the route can answer 404 for
   * an id that was never there (or belongs to someone else) instead of
   * pretending the delete succeeded.
   */
  deleteMessage(id: number, userId: string, guildId: string): boolean {
    // Reject a non-integer before it reaches the driver: SQLite would happily
    // compare any TEXT binding against an INTEGER column, and relying on "it
    // matches nothing" to reject junk from a public URL path is a weaker
    // contract than saying no outright.
    if (!Number.isInteger(id)) {
      return false;
    }

    const result = this.db.run(
      'DELETE FROM conversation_messages WHERE id = ? AND user_id = ? AND guild_id = ?',
      [id, userId, guildId]
    );

    if (result.changes > 0) {
      console.log(`💬 [CONVERSATION] Deleted message ${id} for user ${userId} in guild ${guildId}`);
      return true;
    }

    // Not logged as an error: the overwhelmingly common cause is a stale tab
    // re-submitting an id that has already been trimmed away by the rolling
    // window or deleted by a previous click, which is not worth a warning line
    // per request.
    return false;
  }

  /**
   * Clear all conversation history for a user across all guilds
   */
  clearAllHistory(userId: string): number {
    const result = this.db.run(
      'DELETE FROM conversation_messages WHERE user_id = ?',
      [userId]
    );
    
    if (result.changes > 0) {
      console.log(`💬 [CONVERSATION] Cleared ${result.changes} messages for user ${userId} across all guilds`);
    }

    return result.changes;
  }

  /**
   * Get conversation summary for display (guild-specific)
   */
  getConversationSummary(userId: string, guildId: string): string {
    const result = this.db.query(
      `SELECT username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages 
       WHERE user_id = ? AND guild_id = ?
       GROUP BY user_id, username`
    ).get(userId, guildId) as { username: string; count: number; last_activity: string } | undefined;

    if (!result) {
      return 'No conversation history found.';
    }

    const timeAgo = this.getTimeAgo(new Date(result.last_activity));
    
    return `Conversation with ${result.username}: ${result.count} messages, last active ${timeAgo}`;
  }

  /**
   * List all active conversations for a user across all guilds
   */
  listUserConversations(userId: string): Array<{ guildId: string; username: string; messageCount: number; lastActivity: string }> {
    const results = this.db.query(
      `SELECT guild_id, username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages 
       WHERE user_id = ?
       GROUP BY guild_id, username
       ORDER BY last_activity DESC`
    ).all(userId) as Array<{ guild_id: string; username: string; count: number; last_activity: string }>;

    return results.map(r => ({
      guildId: r.guild_id,
      username: r.username,
      messageCount: r.count,
      lastActivity: r.last_activity,
    }));
  }

  /**
   * List all active conversations in a guild
   */
  listGuildConversations(guildId: string): Array<{ userId: string; username: string; messageCount: number; lastActivity: string }> {
    const results = this.db.query(
      `SELECT user_id, username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages 
       WHERE guild_id = ?
       GROUP BY user_id, username
       ORDER BY last_activity DESC`
    ).all(guildId) as Array<{ user_id: string; username: string; count: number; last_activity: string }>;

    return results.map(r => ({
      userId: r.user_id,
      username: r.username,
      messageCount: r.count,
      lastActivity: r.last_activity,
    }));
  }

  /**
   * List all active conversations (admin view)
   *
   * `limit` is optional and defaults to *unlimited*, which is the behaviour
   * this method always had. Callers that only render a page should pass one:
   * the `GROUP BY` below has to walk every row in the table regardless, but
   * without a `LIMIT` it also materialises one object per distinct
   * (user, guild, username) triple, so an established bot hands the caller
   * thousands of rows to look at the first hundred of. `total` is the true
   * number of groups, so a caller can say "showing 100 of 4212" rather than
   * silently truncating.
   *
   * Note `total` costs a second aggregate pass over the same rows, so it is
   * only computed when a `limit` was actually requested.
   */
  listActiveConversations(limit?: number): { conversations: Array<{ userId: string; guildId: string; username: string; messageCount: number; lastActivity: string }>; total: number } {
    const capped =
      typeof limit === 'number' && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : null;

    // The LIMIT is inlined rather than bound because SQLite will not accept a
    // parameter in that position on every version, and `capped` is a clamped
    // integer built above — there is no string in this concatenation.
    const results = this.db.query(
      `SELECT user_id, guild_id, username, COUNT(*) as count, MAX(timestamp) as last_activity
       FROM conversation_messages
       GROUP BY user_id, guild_id, username
       ORDER BY last_activity DESC${capped === null ? '' : ` LIMIT ${capped}`}`
    ).all() as Array<{ user_id: string; guild_id: string; username: string; count: number; last_activity: string }>;

    const conversations = results.map(r => ({
      userId: r.user_id,
      guildId: r.guild_id,
      username: r.username,
      messageCount: r.count,
      lastActivity: r.last_activity,
    }));

    if (capped === null) {
      return { conversations, total: conversations.length };
    }

    const counted = this.db.query(
      `SELECT COUNT(*) as total FROM (
         SELECT 1 FROM conversation_messages
         GROUP BY user_id, guild_id, username
       )`
    ).get() as { total: number };

    return { conversations, total: counted.total };
  }

  /**
   * Format history for system prompt context (guild-specific).
   * Returns a concise summary of past 1:1 exchanges wrapped in XML tags.
   * This is background context — the channel conversation turns take priority.
   */
  formatHistoryForPrompt(userId: string, guildId: string): string {
    const results = this.db.query(
      `SELECT role, content
       FROM conversation_messages
       WHERE user_id = ? AND guild_id = ?
       ORDER BY timestamp ASC, id ASC`
    ).all(userId, guildId) as Array<{ role: 'user' | 'assistant'; content: string }>;

    if (results.length === 0) {
      return '';
    }

    // Format last few messages for context (keep it concise)
    const recentMessages = results.slice(-6); // Last 3 exchanges (user + assistant pairs)

    const formatted = recentMessages.map(msg => {
      const prefix = msg.role === 'user' ? 'User:' : 'You:';
      // Truncate long messages
      const content = msg.content.length > 150
        ? msg.content.substring(0, 150) + '...'
        : msg.content;
      return `${prefix} ${content}`;
    }).join('\n');

    return `
<past-interactions>
These are excerpts from your previous 1:1 exchanges with this user (may span multiple sessions). Use them for continuity (remembering topics, tone, rapport), but the current channel conversation (the message turns below) always takes priority for understanding what is being discussed right now.

${formatted}
</past-interactions>`;
  }

  /**
   * Get message count for a user in a guild
   */
  getMessageCount(userId: string, guildId: string): number {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM conversation_messages WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as { count: number };
    
    return result.count;
  }

  /**
   * Get total message count for a user across all guilds
   */
  getTotalMessageCount(userId: string): number {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM conversation_messages WHERE user_id = ?'
    ).get(userId) as { count: number };
    
    return result.count;
  }

  /**
   * Get human-readable time ago string
   */
  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
    
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
}

// Singleton instance
export const conversationHistoryService = new ConversationHistoryService();
