import { Database } from 'bun:sqlite';
import { importMarkdownDirectory } from '../utils/markdown-parser';
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

  constructor() {
    this.db = new Database('knowledge_graph.db');
    this.initDatabase();
    console.log('📚 [KNOWLEDGE GRAPH] Service initialized with FTS5 persistent storage');
  }

  private initDatabase(): void {
    // 1. Create main documents table
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

    // 2. Standard indexes
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge_documents(topic)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_documents(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_priority ON knowledge_documents(priority DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_usage ON knowledge_documents(usage_count DESC)`);

    // 3. FTS5 External Content Virtual Table with Porter Stemming & Unicode
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title,
        content,
        keywords,
        topic,
        content='knowledge_documents',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);

    // 4. Synchronization triggers between knowledge_documents and knowledge_fts
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(rowid, title, content, keywords, topic)
        VALUES (new.id, new.title, new.content, new.keywords, new.topic);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, keywords, topic)
        VALUES('delete', old.id, old.title, old.content, old.keywords, old.topic);
      END;
    `);

    // Only re-index when searchable content changes (avoids I/O churn when usage_count updates)
    this.db.run(`DROP TRIGGER IF EXISTS knowledge_au`);
    this.db.run(`
      CREATE TRIGGER knowledge_au AFTER UPDATE OF title, content, keywords, topic ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, keywords, topic)
        VALUES('delete', old.id, old.title, old.content, old.keywords, old.topic);
        INSERT INTO knowledge_fts(rowid, title, content, keywords, topic)
        VALUES (new.id, new.title, new.content, new.keywords, new.topic);
      END;
    `);

    // 5. Automatically populate or rebuild FTS index if documents exist but FTS is empty
    try {
      const docCount = (this.db.query('SELECT COUNT(*) as count FROM knowledge_documents').get() as { count: number }).count;
      const ftsCount = (this.db.query('SELECT COUNT(*) as count FROM knowledge_fts').get() as { count: number }).count;

      if (docCount > 0 && ftsCount === 0) {
        this.db.run(`INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')`);
        console.log(`📚 [KNOWLEDGE GRAPH] Rebuilt FTS5 index for ${docCount} existing documents`);
      }
    } catch (error) {
      console.warn('⚠️ [KNOWLEDGE GRAPH] Could not verify FTS5 rebuild status:', error);
    }

    console.log('📚 [KNOWLEDGE GRAPH] Database and FTS5 engine initialized');
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
   * Search documents using SQLite FTS5 Full-Text Search with BM25 ranking
   */
  searchByKeywords(query: KnowledgeQuery): KnowledgeSearchResult[] {
    const { query: searchQuery, topics, maxResults = 5, minPriority = 1 } = query;

    if (!searchQuery || !searchQuery.trim()) {
      return [];
    }

    // Extract alphanumeric tokens (supports unicode letters & numbers, strips FTS operators)
    const tokens = searchQuery
      .replace(/[^\p{L}\p{N}_]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(t => t.length >= 2);

    if (tokens.length === 0) {
      const singleChar = searchQuery.replace(/[^\p{L}\p{N}_]+/gu, '').trim();
      if (singleChar.length > 0) {
        tokens.push(singleChar);
      } else {
        return [];
      }
    }

    // Construct a safe FTS5 query: phrase match (if multi-word) + prefix wildcard matching per token
    const matchParts: string[] = [];
    if (tokens.length > 1) {
      matchParts.push(`"${tokens.join(' ')}"`);
    }
    for (const token of tokens) {
      matchParts.push(`"${token}"*`);
    }
    const ftsQuery = matchParts.join(' OR ');

    // Column weights: title=5.0, content=1.0, keywords=5.0, topic=2.0
    let sql = `
      SELECT 
        d.*,
        bm25(knowledge_fts, 5.0, 1.0, 5.0, 2.0) AS bm25_rank
      FROM knowledge_fts
      JOIN knowledge_documents d ON d.id = knowledge_fts.rowid
      WHERE knowledge_fts MATCH ?
        AND d.priority >= ?
    `;
    const params: any[] = [ftsQuery, minPriority];

    if (topics && topics.length > 0) {
      sql += ` AND d.topic IN (${topics.map(() => '?').join(',')})`;
      params.push(...topics);
    }

    // SQLite FTS5 bm25 returns negative numbers where more negative = higher relevance
    sql += ` ORDER BY bm25_rank ASC LIMIT ?`;
    params.push(Math.max(maxResults * 4, 25));

    let rows: any[];
    try {
      rows = this.db.query(sql).all(...params) as any[];
    } catch (error) {
      console.warn('⚠️ [KNOWLEDGE GRAPH] FTS5 search query error:', error);
      return [];
    }

    const queryTerms = tokens.map(t => t.toLowerCase());

    // Score and format results
    const scored: KnowledgeSearchResult[] = rows.map(row => {
      const doc = this.mapRowToDocument(row);
      const keywords: string[] = doc.keywords || [];

      // Convert negative BM25 score to positive relevance score
      const rawBm25 = Math.abs(Number(row.bm25_rank) || 0);

      // Add priority and usage boosts
      const score = rawBm25 + (doc.priority * 0.5) + Math.log10(doc.usageCount + 1);

      // Identify matched keywords for compatibility
      const matchedKeywords: string[] = [];
      for (const qTerm of queryTerms) {
        for (const kw of keywords) {
          if (kw.includes(qTerm) || qTerm.includes(kw)) {
            matchedKeywords.push(kw);
          }
        }
        if (doc.title.toLowerCase().includes(qTerm)) {
          matchedKeywords.push(qTerm);
        }
      }

      return {
        document: doc,
        relevanceScore: Math.round(score * 10) / 10,
        matchedKeywords: [...new Set(matchedKeywords)]
      };
    });

    // Sort by final combined score descending
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return scored.slice(0, maxResults);
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
    console.log(`📚 [KNOWLEDGE GRAPH] Deleted document ${id}`);
  }

  /**
   * Clear all documents from the knowledge base
   */
  clearAll(): { deletedCount: number } {
    const stats = this.getStats();
    const count = stats.totalDocuments;
    
    this.db.run('DELETE FROM knowledge_documents');
    this.db.run("INSERT INTO knowledge_fts(knowledge_fts) VALUES('delete-all')");
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

  hasDocuments(): boolean {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM knowledge_documents'
    ).get() as { count: number };

    return result.count > 0;
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
      keywords: JSON.parse(row.keywords || '[]'),
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
   * Bulk import documents from an array in a single transaction
   */
  bulkImport(documents: Array<Omit<KnowledgeDocument, 'id' | 'usageCount' | 'createdAt' | 'updatedAt'>>): void {
    const now = new Date().toISOString();
    
    const insert = this.db.prepare(`
      INSERT INTO knowledge_documents 
      (topic, title, content, keywords, type, url, priority, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    const runBulk = this.db.transaction((docs: typeof documents) => {
      for (const doc of docs) {
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
    });

    runBulk(documents);
    console.log(`📚 [KNOWLEDGE GRAPH] Bulk imported ${documents.length} documents`);
  }

  /**
   * Sync knowledge documents from markdown files
   */
  async syncFromFiles(dirPath: string = './knowledge_documents'): Promise<void> {
    const resolvedPath = resolve(dirPath);

    if (!existsSync(resolvedPath)) {
      console.log(`📚 [KNOWLEDGE GRAPH] No knowledge_documents directory found at ${resolvedPath}, skipping file sync`);
      return;
    }

    const docs = await importMarkdownDirectory(resolvedPath);

    if (docs.length === 0) {
      console.log('📚 [KNOWLEDGE GRAPH] No markdown documents found to sync');
      return;
    }

    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const doc of docs) {
      const existing = this.db.query(
        'SELECT id, content, keywords, type, url, priority FROM knowledge_documents WHERE LOWER(title) = LOWER(?) AND LOWER(topic) = LOWER(?)'
      ).get(doc.title, doc.topic) as any | null;

      if (existing) {
        const existingKeywords = JSON.parse(existing.keywords || '[]') as string[];
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

    console.log(`📚 [KNOWLEDGE GRAPH] File sync complete: ${added} added, ${updated} updated, ${unchanged} unchanged (${docs.length} files scanned)`);
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