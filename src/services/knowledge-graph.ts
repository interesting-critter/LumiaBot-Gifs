import { Database } from 'bun:sqlite';
import {
  importMarkdownDirectory,
  MarkdownImportError,
  type ParsedMarkdownDocument,
} from '../utils/markdown-parser';
import { dbPath, KNOWLEDGE_DOCUMENTS_DIR } from '../utils/paths';
import { escapeLikeWildcards } from '../utils/sql-escape';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface KnowledgeDocument {
  id?: number;
  topic: string;
  title: string;
  content: string;
  keywords: string[];
  type: 'document' | 'link' | 'snippet';
  url?: string;
  priority: number; // 1-10, higher = more important
  usageCount: number;
  lastAccessed?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeQuery {
  query: string;
  topics?: string[];
  maxResults?: number;
  minPriority?: number;
}

export interface KnowledgeSearchResult {
  document: KnowledgeDocument;
  relevanceScore: number;
  matchedKeywords: string[];
}

export interface KnowledgeCandidate {
  id: number;
  title: string;
  topic: string;
  type: 'document' | 'link' | 'snippet';
  url?: string;
  relevanceScore: number;
  matchedKeywords: string[];
  preview: string;
}

export interface CollectiveKnowledgeCandidate extends KnowledgeCandidate {
  excerpt: string;
}

export class KnowledgeGraphService {
  private db: Database;

  /**
   * Cached answer for {@link hasDocuments}, invalidated on every write.
   *
   * `hasDocuments()` is called up to six times per message (once per AI service
   * plus the orchestrator's prefetch), and each call used to be a full
   * `COUNT(*)` over the documents table.
   */
  private hasDocumentsCache: { value: boolean; expiresAt: number } | null = null;

  /**
   * Upper bound on rows pulled out of SQLite per search before JS scoring runs.
   * The keyword predicate runs in SQL, so the database narrows first.
   */
  private static readonly MAX_SEARCH_CANDIDATES = 200;

  /** How long a `hasDocuments()` answer stays valid, in ms. */
  private static readonly HAS_DOCUMENTS_TTL_MS = 5_000;

  constructor(databasePath: string = dbPath('knowledge_graph.db')) {
    // Absolute path from utils/paths: a CWD-relative filename silently creates a
    // brand-new empty database when the bot is started from another directory.
    this.db = new Database(databasePath);
    this.applyPragmas();
    this.initDatabase();
    console.log('📚 [KNOWLEDGE GRAPH] Service initialized with persistent storage');
  }

  private applyPragmas(): void {
    try {
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA busy_timeout = 5000');
    } catch (error) {
      console.warn('📚 [KNOWLEDGE GRAPH] Could not enable WAL/busy_timeout:', error);
    }
  }

  /** Drop the cached `hasDocuments()` answer; called by every writer. */
  private invalidateDocumentCache(): void {
    this.hasDocumentsCache = null;
  }

  private initDatabase(): void {
    // Create documents table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        keywords TEXT NOT NULL, -- JSON array of keywords
        type TEXT NOT NULL CHECK (type IN ('document', 'link', 'snippet')),
        url TEXT,
        priority INTEGER DEFAULT 5,
        usage_count INTEGER DEFAULT 0,
        last_accessed TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create indexes for efficient querying
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge_documents(topic)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_documents(type)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_priority ON knowledge_documents(priority DESC)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_usage ON knowledge_documents(usage_count DESC)
    `);

    console.log('📚 [KNOWLEDGE GRAPH] Database initialized');
  }

  /**
   * Store a new knowledge document
   */
  storeDocument(doc: Omit<KnowledgeDocument, 'id' | 'usageCount' | 'createdAt' | 'updatedAt'>): void {
    const now = new Date().toISOString();
    
    this.db.run(
      `INSERT INTO knowledge_documents 
       (topic, title, content, keywords, type, url, priority, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        doc.topic,
        doc.title,
        doc.content,
        JSON.stringify(doc.keywords.map(k => k.toLowerCase())),
        doc.type,
        doc.url || null,
        doc.priority,
        now,
        now
      ]
    );

    this.invalidateDocumentCache();
    console.log(`📚 [KNOWLEDGE GRAPH] Stored document: "${doc.title}" (${doc.topic})`);
  }

  /**
   * Update an existing document
   */
  updateDocument(id: number, updates: Partial<KnowledgeDocument>): void {
    const now = new Date().toISOString();
    
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.topic !== undefined) {
      fields.push('topic = ?');
      values.push(updates.topic);
    }
    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
    }
    if (updates.keywords !== undefined) {
      fields.push('keywords = ?');
      values.push(JSON.stringify(updates.keywords.map(k => k.toLowerCase())));
    }
    if (updates.type !== undefined) {
      fields.push('type = ?');
      values.push(updates.type);
    }
    if (updates.url !== undefined) {
      fields.push('url = ?');
      values.push(updates.url);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    this.db.run(
      `UPDATE knowledge_documents SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    this.invalidateDocumentCache();
    console.log(`📚 [KNOWLEDGE GRAPH] Updated document ${id}`);
  }

  /**
   * Get a document by ID
   */
  getDocument(id: number): KnowledgeDocument | null {
    const result = this.db.query(
      'SELECT * FROM knowledge_documents WHERE id = ?'
    ).get(id) as any;

    if (!result) return null;

    return this.mapRowToDocument(result);
  }

  /**
   * Get all documents, ordered by priority
   */
  getAllDocuments(limit: number = 50): KnowledgeDocument[] {
    const results = this.db.query(
      `SELECT * FROM knowledge_documents
       ORDER BY priority DESC, topic ASC, title ASC
       LIMIT ?`
    ).all(limit) as any[];

    return results.map(r => this.mapRowToDocument(r));
  }

  /**
   * Get all documents for a topic
   */
  getDocumentsByTopic(topic: string, limit: number = 10): KnowledgeDocument[] {
    const results = this.db.query(
      `SELECT * FROM knowledge_documents 
       WHERE topic = ? 
       ORDER BY priority DESC, usage_count DESC 
       LIMIT ?`
    ).all(topic, limit) as any[];

    return results.map(r => this.mapRowToDocument(r));
  }

  /**
   * Search documents by keywords
   * Uses fuzzy matching and relevance scoring
   */
  searchByKeywords(query: KnowledgeQuery): KnowledgeSearchResult[] {
    const { query: searchQuery, topics, maxResults = 5, minPriority = 1 } = query;

    // Extract keywords from query.
    //
    // The token-length filter runs on the RAW token, before escaping: it exists
    // to drop short stop-words, and escaping grows a token (`a%` → `a\%`), so
    // filtering afterwards would let 2-character junk like `%_` through and
    // reject legitimate 3-character keywords whose escape made them look long.
    //
    // Escaping itself is not optional here. Every clause below declares
    // `ESCAPE '\'`, which turns `%`, `_` and `\` back into match-literal
    // characters — without it a query word containing `%` matched every document
    // in the table, and a word containing `\` ate the `%` that followed it in the
    // bind list. Shared with the other LIKE callers; see utils/sql-escape.ts.
    const queryKeywords = [...new Set(searchQuery.toLowerCase()
      .split(/\s+/)
      .filter(k => k.length > 2) // Only words longer than 2 chars
      .map(escapeLikeWildcards))];

    if (queryKeywords.length === 0) {
      return [];
    }

    /*
     * Keyword matching is pushed into SQL so the database — not JavaScript —
     * decides which rows are candidates, and the hard LIMIT below applies to
     * that narrowed set. The previous implementation ran `SELECT *` over every
     * document with no LIMIT, then scored all of them in JS with a JSON.parse
     * per row; this path is on the hot route (the `search_knowledge_base` tool
     * and the per-message `requestCollectiveKnowledge` prefetch).
     *
     * LIKE is used rather than FTS because the keyword list is a JSON blob in a
     * TEXT column; the OR-with-LIMIT shape still bounds the work.
     */
    const matchClauses = queryKeywords
      .map(() => `(keywords LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(title) LIKE ? ESCAPE '\\')`)
      .join(' OR ');

    const matchParams: string[] = [];
    for (const kw of queryKeywords) {
      matchParams.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
    }

    let sql = `SELECT * FROM knowledge_documents WHERE priority >= ? AND (${matchClauses})`;
    const params: any[] = [minPriority, ...matchParams];

    if (topics && topics.length > 0) {
      sql += ` AND topic IN (${topics.map(() => '?').join(',')})`;
      params.push(...topics);
    }

    sql += ` ORDER BY priority DESC LIMIT ?`;
    params.push(KnowledgeGraphService.MAX_SEARCH_CANDIDATES);

    const results = this.db.query(sql).all(...params) as any[];

    // Score and filter results
    const scored: KnowledgeSearchResult[] = results.map(doc => {
      let keywords: string[] = [];
      try {
        keywords = JSON.parse(doc.keywords);
      } catch {
        keywords = [];
      }

      // Calculate relevance score
      let score = 0;
      const matchedKeywords: string[] = [];
      const titleLower = doc.title.toLowerCase();
      const contentLower = doc.content.toLowerCase();

      for (const queryKw of queryKeywords) {
        const rawKw = queryKw.replace(/\\(.)/g, '$1');

        // Exact match on keyword
        if (keywords.includes(rawKw)) {
          score += 10;
          matchedKeywords.push(rawKw);
          continue;
        }

        // Partial match on keyword
        for (const kw of keywords) {
          if (kw.includes(rawKw) || rawKw.includes(kw)) {
            score += 5;
            matchedKeywords.push(kw);
            break;
          }
        }

        // Match in title
        if (titleLower.includes(rawKw)) {
          score += 3;
        }

        // Match in content
        if (contentLower.includes(rawKw)) {
          score += 1;
        }
      }

      /*
       * The priority and usage boosts are only meaningful for a document that
       * actually matched. Applied unconditionally they guaranteed
       * `relevanceScore >= 0.5` for every row, so a garbage query
       * ("zzzz nonexistent term") returned the whole table with
       * `matchedKeywords: []` — and `queryKnowledgeBase` then incremented
       * `usage_count` on those non-matches, permanently reordering
       * `getStats().mostUsed`.
       */
      if (matchedKeywords.length > 0) {
        score += doc.priority * 0.5;
        score += Math.log10(doc.usage_count + 1);
      }

      return {
        document: this.mapRowToDocument(doc),
        relevanceScore: score,
        matchedKeywords: [...new Set(matchedKeywords)] // Remove duplicates
      };
    });

    // Sort by relevance and take top results
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    /*
     * Keep only genuine matches. A document that matched nothing scores exactly
     * 0 now that the priority/usage boosts are gated on `matchedKeywords`, so
     * `relevanceScore > 0` is a real match signal again — it also keeps title-
     * and content-only matches, which are legitimate but contribute nothing to
     * `matchedKeywords` (that field lists keyword-column hits).
     */
    return scored.filter(s => s.matchedKeywords.length > 0 || s.relevanceScore > 0).slice(0, maxResults);
  }

  /**
   * Query the knowledge base (main method for LLM tool)
   * Returns formatted context string for system prompt
   */
  async queryKnowledgeBase(
    query: string,
    maxResults: number = 3
  ): Promise<string> {
    console.log(`📚 [KNOWLEDGE GRAPH] Querying: "${query}"`);

    const results = this.searchByKeywords({ 
      query, 
      maxResults 
    });

    if (results.length === 0) {
      console.log(`📚 [KNOWLEDGE GRAPH] No relevant documents found`);
      return '';
    }

    console.log(`📚 [KNOWLEDGE GRAPH] Found ${results.length} relevant documents`);

    // Update usage statistics
    for (const result of results) {
      this.incrementUsage(result.document.id!);
    }

    // Format results for context
    return this.formatKnowledgeContext(results);
  }

  findCandidateDocuments(query: string, maxResults: number = 5): KnowledgeCandidate[] {
    const results = this.searchByKeywords({
      query,
      maxResults,
    });

    return results.map((result) => ({
      id: result.document.id!,
      title: result.document.title,
      topic: result.document.topic,
      type: result.document.type,
      url: result.document.url,
      relevanceScore: result.relevanceScore,
      matchedKeywords: result.matchedKeywords,
      preview: this.buildPreview(result.document.content),
    }));
  }

  findCollectiveKnowledgeCandidates(query: string, maxResults: number = 3, excerptLength: number = 700): CollectiveKnowledgeCandidate[] {
    const results = this.searchByKeywords({
      query,
      maxResults,
    });

    return results.map((result) => ({
      id: result.document.id!,
      title: result.document.title,
      topic: result.document.topic,
      type: result.document.type,
      url: result.document.url,
      relevanceScore: result.relevanceScore,
      matchedKeywords: result.matchedKeywords,
      preview: this.buildPreview(result.document.content),
      excerpt: this.buildExcerpt(result.document.content, excerptLength),
    }));
  }

  searchForTool(query: string, maxResults: number = 5): string {
    const results = this.searchByKeywords({ query, maxResults });

    if (results.length === 0) {
      return `No knowledge documents matched the query "${query}".`;
    }

    const entries = results.map((result, i) => {
      const doc = result.document;
      const preview = this.buildPreview(doc.content, 500);
      const urlLine = doc.url ? `\nURL: ${doc.url}` : '';
      return `${i + 1}. [Doc ID ${doc.id}] ${doc.title}\n   Topic: ${doc.topic}${urlLine}\n   Preview: ${preview}`;
    });

    this.incrementUsageForResults(results);

    return `Found ${results.length} knowledge document(s) for "${query}":\n\n${entries.join('\n\n')}\n\nUse get_knowledge_document with a Doc ID to retrieve the full content of any document above.`;
  }

  private incrementUsageForResults(results: KnowledgeSearchResult[]): void {
    for (const result of results) {
      if (result.document.id) {
        this.incrementUsage(result.document.id);
      }
    }
  }

  formatCandidateContext(candidates: KnowledgeCandidate[]): string {
    if (candidates.length === 0) {
      return '';
    }

    const sections = candidates.map((candidate, index) => {
      const matchedKeywords = candidate.matchedKeywords.length > 0
        ? candidate.matchedKeywords.join(', ')
        : 'none';
      const urlLine = candidate.url ? `\nURL: ${candidate.url}` : '';
      return `${index + 1}. Doc ID ${candidate.id}: ${candidate.title}\nTopic: ${candidate.topic}\nType: ${candidate.type}\nMatched keywords: ${matchedKeywords}${urlLine}\nPreview: ${candidate.preview}`;
    });

    return `<knowledge-candidates>
Deterministic candidate documents for this message. These are the closest knowledge matches already found in app code.
If you need the full raw content from one of them, call get_knowledge_document with its Doc ID.

${sections.join('\n\n')}
</knowledge-candidates>`;
  }

  formatCandidateSummary(candidates: KnowledgeCandidate[]): string {
    if (candidates.length === 0) {
      return 'No candidate documents were matched for this message.';
    }

    return candidates
      .map((candidate) => `Doc ID ${candidate.id}: "${candidate.title}" (${candidate.topic})`)
      .join('; ');
  }

  getDocumentToolPayload(id: number): string {
    const document = this.getDocument(id);
    if (!document) {
      return `Knowledge document ${id} was not found.`;
    }

    this.incrementUsage(id);

    let output = `Knowledge document ${id}: ${document.title}\n`;
    output += `Topic: ${document.topic}\n`;
    output += `Type: ${document.type}\n`;
    if (document.url) {
      output += `URL: ${document.url}\n`;
    }
    if (document.keywords.length > 0) {
      output += `Keywords: ${document.keywords.join(', ')}\n`;
    }
    output += `\n${document.content}`;

    return output;
  }

  /**
   * Increment usage count for a document
   */
  private incrementUsage(id: number): void {
    const now = new Date().toISOString();
    
    this.db.run(
      `UPDATE knowledge_documents 
       SET usage_count = usage_count + 1, last_accessed = ?
       WHERE id = ?`,
      [now, id]
    );
  }

  /**
   * Format search results for system prompt
   * Creates context that Lumia can naturally reference
   * Formatted to encourage chaotic, non-robotic responses
   */
  private formatKnowledgeContext(results: KnowledgeSearchResult[]): string {
    const sections = results.map((result) => {
      const doc = result.document;

      let section = `${doc.title}\n`;

      if (doc.type === 'link' && doc.url) {
        section += `[${doc.url}]\n`;
      }

      section += doc.content;

      return section;
    });

    return `<knowledge-base>
${sections.join('\n\n')}
</knowledge-base>`;
  }

  /**
   * Delete a document
   */
  deleteDocument(id: number): void {
    this.db.run('DELETE FROM knowledge_documents WHERE id = ?', [id]);
    this.invalidateDocumentCache();
    console.log(`📚 [KNOWLEDGE GRAPH] Deleted document ${id}`);
  }

  /**
   * Clear all documents from the knowledge base
   * Use with caution - this deletes EVERYTHING!
   */
  clearAll(): { deletedCount: number } {
    const stats = this.getStats();
    const count = stats.totalDocuments;
    
    this.db.run('DELETE FROM knowledge_documents');
    this.invalidateDocumentCache();
    console.log(`📚 [KNOWLEDGE GRAPH] Cleared all ${count} documents from knowledge base`);
    
    return { deletedCount: count };
  }

  /**
   * Delete all documents for a specific topic
   */
  deleteByTopic(topic: string): { deletedCount: number } {
    const beforeCount = this.db.query(
      'SELECT COUNT(*) as count FROM knowledge_documents WHERE topic = ?'
    ).get(topic) as { count: number };
    
    this.db.run('DELETE FROM knowledge_documents WHERE topic = ?', [topic]);
    this.invalidateDocumentCache();
    console.log(`📚 [KNOWLEDGE GRAPH] Deleted ${beforeCount.count} documents from topic "${topic}"`);
    
    return { deletedCount: beforeCount.count };
  }

  /**
   * List all topics
   */
  listTopics(): string[] {
    const results = this.db.query(
      'SELECT DISTINCT topic FROM knowledge_documents ORDER BY topic'
    ).all() as Array<{ topic: string }>;

    return results.map(r => r.topic);
  }

  /**
   * Get statistics
   */
  getStats(): { totalDocuments: number; totalTopics: number; mostUsed: KnowledgeDocument[] } {
    const totalResult = this.db.query(
      'SELECT COUNT(*) as count FROM knowledge_documents'
    ).get() as { count: number };

    const topicsResult = this.db.query(
      'SELECT COUNT(DISTINCT topic) as count FROM knowledge_documents'
    ).get() as { count: number };

    const mostUsed = this.db.query(
      `SELECT * FROM knowledge_documents 
       ORDER BY usage_count DESC 
       LIMIT 5`
    ).all() as any[];

    return {
      totalDocuments: totalResult.count,
      totalTopics: topicsResult.count,
      mostUsed: mostUsed.map(r => this.mapRowToDocument(r))
    };
  }

  /**
   * Whether the knowledge base holds any document.
   *
   * Cached for a few seconds and invalidated on every write. This is asked up
   * to six times per turn across the two AI services and the orchestrator
   * prefetch, and each call used to be a full `COUNT(*)`.
   */
  hasDocuments(): boolean {
    const now = Date.now();
    const cached = this.hasDocumentsCache;

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const result = this.db.query(
      'SELECT 1 AS present FROM knowledge_documents LIMIT 1'
    ).get() as { present: number } | undefined;

    const value = result !== null && result !== undefined;
    this.hasDocumentsCache = {
      value,
      expiresAt: now + KnowledgeGraphService.HAS_DOCUMENTS_TTL_MS,
    };

    return value;
  }

  getToolSummary(limit: number = 8): string {
    const stats = this.getStats();
    if (stats.totalDocuments === 0) {
      return 'No knowledge documents are currently loaded.';
    }

    const topics = this.listTopics();
    const topicSummary = topics.slice(0, 10).join(', ');

    return `${stats.totalDocuments} documents across ${stats.totalTopics} topics: ${topicSummary}.`;
  }

  private buildPreview(content: string, maxLength: number = 220): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return normalized.slice(0, maxLength - 3).trimEnd() + '...';
  }

  private buildExcerpt(content: string, maxLength: number = 700): string {
    return this.buildPreview(content, maxLength);
  }

  /**
   * Map database row to KnowledgeDocument
   */
  private mapRowToDocument(row: any): KnowledgeDocument {
    return {
      id: row.id,
      topic: row.topic,
      title: row.title,
      content: row.content,
      keywords: JSON.parse(row.keywords),
      type: row.type,
      url: row.url,
      priority: row.priority,
      usageCount: row.usage_count,
      lastAccessed: row.last_accessed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Bulk import documents from a JSON array
   */
  bulkImport(documents: Array<Omit<KnowledgeDocument, 'id' | 'usageCount' | 'createdAt' | 'updatedAt'>>): void {
    const now = new Date().toISOString();
    
    const insert = this.db.query(`
      INSERT INTO knowledge_documents 
      (topic, title, content, keywords, type, url, priority, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    for (const doc of documents) {
      insert.run(
        doc.topic,
        doc.title,
        doc.content,
        JSON.stringify(doc.keywords.map(k => k.toLowerCase())),
        doc.type,
        doc.url || null,
        doc.priority,
        now,
        now
      );
    }

    this.invalidateDocumentCache();
    console.log(`📚 [KNOWLEDGE GRAPH] Bulk imported ${documents.length} documents`);
  }

  /**
   * Sync knowledge documents from the knowledge_documents/ directory on disk.
   * New documents (by title+topic) are inserted; existing documents with changed content are updated.
   * This is safe to call on every startup.
   *
   * CONTRACT: this sync is ADDITIVE ONLY. Documents whose `.md` file was
   * deleted or renamed are **not** removed from the database — the table is also
   * the destination for `/knowledge add`, the dashboard editor, and
   * `import-to-db.ts`, none of which have a file on disk, so pruning "anything
   * not in the directory" would silently delete operator-authored knowledge.
   * Deleting a synced document is an explicit `deleteDocument` /
   * `deleteByTopic` / `clearAll` (or a `DROP TABLE` reset). The consequence is
   * that the knowledge base can drift ahead of the directory in the sense that
   * removed files linger; that is deliberate, not an oversight.
   *
   * FAILURE REPORTING (deliberately NOT a hard throw)
   * --------------------------------------------------
   * The directory walk runs `strict: true`, so an unreadable file or directory
   * raises {@link MarkdownImportError} instead of silently shortening the list.
   * That error is then caught and logged, and whatever *did* parse is still
   * synced, because this runs on the boot path: one unreadable document must not
   * stop the bot from starting, and the table is additive, so syncing the
   * readable subset is still the right outcome.
   *
   * A throw here would also have been useless as a signal — the caller of
   * `syncFromFiles` is the boot sequence, which has nobody to tell. What was
   * actually wrong before was silence: an unreadable file landed in the parser's
   * failure list, the count dropped to 39, and the operator saw
   * `✅ File sync complete: 39 unchanged`, indistinguishable from a complete
   * tree. The failure list is therefore printed at `error` level, naming every
   * path, and says outright that the knowledge base is incomplete.
   */
  async syncFromFiles(dirPath: string = KNOWLEDGE_DOCUMENTS_DIR): Promise<void> {
    const resolvedPath = resolve(dirPath);

    if (!existsSync(resolvedPath)) {
      console.log(`📚 [KNOWLEDGE GRAPH] No knowledge_documents directory found at ${resolvedPath}, skipping file sync`);
      return;
    }

    let docs: ParsedMarkdownDocument[];
    let unreadableCount = 0;
    try {
      docs = await importMarkdownDirectory(resolvedPath, { strict: true });
    } catch (error) {
      if (!(error instanceof MarkdownImportError)) throw error;

      // Partial tree: name every unreadable path, then carry on with what parsed.
      unreadableCount = error.failures.length;
      console.error(
        `🚨 [KNOWLEDGE GRAPH] PARTIAL FILE SYNC — ${unreadableCount} path(s) could not be read, ` +
          `so the knowledge base is INCOMPLETE. Any document under those paths was NOT synced.`,
      );
      for (const failure of error.failures) {
        console.error(`🚨 [KNOWLEDGE GRAPH]   unreadable: ${failure}`);
      }
      docs = error.documents;
    }

    if (docs.length === 0) {
      console.log('📚 [KNOWLEDGE GRAPH] No markdown documents found to sync');
      return;
    }

    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const doc of docs) {
      // Look for an existing document with the same title and topic
      const existing = this.db.query(
        'SELECT id, content, keywords, type, url, priority FROM knowledge_documents WHERE LOWER(title) = LOWER(?) AND LOWER(topic) = LOWER(?)'
      ).get(doc.title, doc.topic) as any | null;

      if (existing) {
        // Check if content or metadata changed
        const existingKeywords = JSON.parse(existing.keywords) as string[];
        const newKeywords = doc.keywords.map(k => k.toLowerCase());
        const contentChanged = existing.content !== doc.content;
        const keywordsChanged = JSON.stringify(existingKeywords.sort()) !== JSON.stringify(newKeywords.sort());
        const metaChanged = existing.type !== doc.type
          || existing.url !== (doc.url || null)
          || existing.priority !== doc.priority;

        if (contentChanged || keywordsChanged || metaChanged) {
          this.updateDocument(existing.id, {
            content: doc.content,
            keywords: doc.keywords,
            type: doc.type,
            url: doc.url,
            priority: doc.priority,
          });
          updated++;
        } else {
          unchanged++;
        }
      } else {
        // New document — insert it
        this.storeDocument({
          topic: doc.topic,
          title: doc.title,
          content: doc.content,
          keywords: doc.keywords,
          type: doc.type,
          url: doc.url,
          priority: doc.priority,
        });
        added++;
      }
    }

    this.invalidateDocumentCache();
    // "Complete" is only true when every path in the tree was readable. On a
    // partial tree the word would be a lie, and this log line is exactly what an
    // operator stares at to decide whether the sync worked.
    const partialSuffix = unreadableCount > 0
      ? ` — ⚠️ PARTIAL: ${unreadableCount} path(s) unreadable, see the errors above`
      : '';
    console.log(`📚 [KNOWLEDGE GRAPH] File sync ${unreadableCount > 0 ? 'partial' : 'complete'}: ${added} added, ${updated} updated, ${unchanged} unchanged (${docs.length} files scanned)${partialSuffix}`);
  }

  /** Close the underlying handle. Used by tests and maintenance scripts. */
  close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.warn('📚 [KNOWLEDGE GRAPH] Failed to close database:', error);
    }
  }

  /**
   * Get document count by topic
   */
  getTopicStats(): Array<{ topic: string; count: number; avgPriority: number }> {
    const results = this.db.query(`
      SELECT 
        topic,
        COUNT(*) as count,
        AVG(priority) as avg_priority
      FROM knowledge_documents
      GROUP BY topic
      ORDER BY count DESC
    `).all() as Array<{ topic: string; count: number; avg_priority: number }>;

    return results.map(r => ({
      topic: r.topic,
      count: r.count,
      avgPriority: Math.round(r.avg_priority * 10) / 10
    }));
  }
}

// Singleton instance
export const knowledgeGraphService = new KnowledgeGraphService();
