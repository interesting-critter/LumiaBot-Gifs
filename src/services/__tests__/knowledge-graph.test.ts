import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeGraphService } from '../knowledge-graph';

/**
 * Regression coverage for the false-positive search bug: `searchByKeywords`
 * added `doc.priority * 0.5` and `log10(usage_count + 1)` to every row, so
 * `relevanceScore > 0` was true for the entire table no matter what the query
 * was. `"zzzz nonexistent term"` returned every document with
 * `matchedKeywords: []`, the model was told those matched, and
 * `queryKnowledgeBase` then bumped `usage_count` on them — permanently
 * reordering `getStats().mostUsed` from garbage queries.
 */

let dir: string;
let dbPath: string;
let service: KnowledgeGraphService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumia-knowledge-test-'));
  dbPath = join(dir, 'knowledge_graph.db');
  service = new KnowledgeGraphService(dbPath);

  service.storeDocument({
    topic: 'loom',
    title: 'Loom basics',
    content: 'A loom is a frame that holds warp threads under tension.',
    keywords: ['loom', 'warp', 'weaving'],
    type: 'document',
    priority: 5,
  });
  service.storeDocument({
    topic: 'coding',
    title: 'TypeScript tips',
    content: 'Prefer narrow unions over optional fields in TypeScript.',
    keywords: ['typescript', 'types'],
    type: 'document',
    priority: 3,
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('searchByKeywords', () => {
  test('returns zero results for a query that matches nothing', () => {
    const results = service.searchByKeywords({ query: 'zzzz nonexistent term' });
    expect(results).toHaveLength(0);
  });

  test('returns zero results for a nonsense query even with high priority documents', () => {
    const results = service.searchByKeywords({ query: 'quantum tunnelling recipe' });
    expect(results).toEqual([]);
  });

  test('still matches on keywords, title and content', () => {
    const byKeyword = service.searchByKeywords({ query: 'loom' });
    expect(byKeyword.length).toBeGreaterThan(0);
    expect(byKeyword[0]!.matchedKeywords).toContain('loom');

    const byTitle = service.searchByKeywords({ query: 'typescript' });
    expect(byTitle.length).toBeGreaterThan(0);
  });

  test('every returned result actually matched', () => {
    const results = service.searchByKeywords({ query: 'threads tension' });
    for (const result of results) {
      expect(result.relevanceScore).toBeGreaterThan(0);
    }
  });

  test('a miss does not bump usage_count', async () => {
    const before = service.getStats().mostUsed.map(doc => [doc.title, doc.usageCount]);

    await service.queryKnowledgeBase('zzzz nonexistent term');
    await service.queryKnowledgeBase('another garbage query');
    service.searchForTool('yet more nonsense');

    const after = service.getStats().mostUsed.map(doc => [doc.title, doc.usageCount]);
    expect(after).toEqual(before);
  });

  test('a real hit does bump usage_count', async () => {
    const doc = service.getAllDocuments().find(d => d.title === 'Loom basics')!;
    const before = doc.usageCount;

    await service.queryKnowledgeBase('loom');

    expect(service.getDocument(doc.id!)!.usageCount).toBe(before + 1);
  });

  test('findCollectiveKnowledgeCandidates returns nothing for a miss', () => {
    expect(service.findCollectiveKnowledgeCandidates('zzzz nonexistent term')).toEqual([]);
  });
});

describe('hasDocuments cache', () => {
  test('reflects writes immediately', () => {
    expect(service.hasDocuments()).toBe(true);

    const docs = service.getAllDocuments();
    for (const doc of docs) {
      service.deleteDocument(doc.id!);
    }
    expect(service.hasDocuments()).toBe(false);

    service.storeDocument({
      topic: 'new',
      title: 'Freshly added',
      content: 'body',
      keywords: ['fresh'],
      type: 'snippet',
      priority: 1,
    });
    expect(service.hasDocuments()).toBe(true);
  });
});
