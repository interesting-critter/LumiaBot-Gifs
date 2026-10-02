/**
 * Import Markdown documents to Knowledge Graph Database
 *
 * Usage:
 *   bun run src/scripts/import-to-db.ts [directory]
 *
 * Example:
 *   bun run src/scripts/import-to-db.ts ./knowledge_documents
 *   bun run src/scripts/import-to-db.ts  # Uses default ./knowledge_documents
 *
 * Options:
 *   --dry-run    Parse files but don't save to database
 *   --force      Import even if documents with same titles exist
 */

import { knowledgeGraphService } from '../services/knowledge-graph';
import {
  importMarkdownDirectory,
  MarkdownImportError,
  type ParsedMarkdownDocument,
} from '../utils/markdown-parser';
import { dbPath, KNOWLEDGE_DOCUMENTS_DIR } from '../utils/paths';
import { Database } from 'bun:sqlite';
import { parseArgs, wantsHelp } from './safety';

/**
 * Build the set of `LOWER(title) + LOWER(topic)` keys already stored.
 *
 * The duplicate check used to call `knowledgeGraphService.searchByKeywords` once
 * per document, and that method pulls `SELECT *` over the whole table before
 * scoring in JS. N documents therefore meant N full table scans.
 *
 * A single pass over `(id, title, topic)` — the same case-insensitive pairing
 * `knowledgeGraphService.syncFromFiles` matches on — turns the duplicate check
 * into O(1) per document after one sequential read, with an index-friendly
 * comparison and no per-document allocation of the full corpus.
 */
function loadExistingDocumentKeys(): Set<string> {
  const keys = new Set<string>();
  const db = new Database(dbPath('knowledge_graph.db'), { readonly: true });

  try {
    const rows = db
      .query('SELECT title, topic FROM knowledge_documents')
      .all() as Array<{ title: string; topic: string }>;
    for (const row of rows) {
      keys.add(`${row.title.toLowerCase()} ${row.topic.toLowerCase()}`);
    }
  } finally {
    db.close();
  }

  return keys;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const targetDir = parsed.positional[0] ?? KNOWLEDGE_DOCUMENTS_DIR;
  const dryRun = parsed.flags.has('--dry-run');
  const force = parsed.flags.has('--force');

  if (wantsHelp(parsed)) {
    console.log(`
Import Markdown documents to the knowledge graph.

Usage:
  bun run import-to-db [directory] [--dry-run] [--force]

Options:
  --dry-run    Parse and report; do not write to the database.
  --force      Import documents that already exist instead of skipping them.

Without --force, a document whose (title, topic) already exists is skipped.
`);
    return;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(`❌ Unknown option(s): ${parsed.unknownFlags.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('📚 Knowledge Graph Markdown Import\n');
  console.log(`Target directory: ${targetDir}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'IMPORT TO DATABASE'}`);
  console.log();

  // Parse all Markdown files
  console.log('🔍 Parsing Markdown files...');

  // `strict: true` because this is *the* explicit import: a partially-readable
  // tree used to produce `✅ Found 39 documents` for a directory holding 40, and
  // a short list is indistinguishable from "that was all of them" at every call
  // site. The error carries the unreadable paths *and* the documents that did
  // parse, so the operator gets the exact list instead of a wrong total.
  let docs: ParsedMarkdownDocument[];
  try {
    docs = await importMarkdownDirectory(targetDir, { strict: true });
  } catch (error) {
    if (!(error instanceof MarkdownImportError)) throw error;

    console.error(`\n❌ Import ABORTED: ${error.failures.length} file(s)/directory(ies) could not be read.`);
    console.error('   Nothing was written to the database.');
    console.error(`   ${error.documents.length} document(s) did parse; they were NOT imported, because a`);
    console.error('   partial import looks exactly like a complete one to everything downstream.');
    console.error('\n   Unreadable paths:');
    for (const failure of error.failures) {
      console.error(`     • ${failure}`);
    }
    console.error('\n   Fix the permissions (or move the unreadable trees) and re-run.');
    process.exitCode = 1;
    return;
  }

  if (docs.length === 0) {
    console.log('❌ No valid Markdown files found.');
    console.log('\nMake sure your .md files have the proper format:');
    console.log('  - Frontmatter (--- key: value ---) OR');
    console.log('  - Inline headers (**Topic:** value)');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ Found ${docs.length} documents\n`);

  // Preview documents
  console.log('📋 Document Preview:\n');
  docs.forEach((doc, i) => {
    console.log(`${i + 1}. "${doc.title}"`);
    console.log(`   Topic: ${doc.topic} | Type: ${doc.type} | Priority: ${doc.priority}`);
    console.log(`   Keywords: ${doc.keywords.join(', ') || 'none'}`);
    if (doc.url) console.log(`   URL: ${doc.url}`);
    console.log(`   Source: ${doc.sourceFile}`);
    console.log();
  });

  if (dryRun) {
    console.log('\n🏃 Dry run complete. No changes made to database.');
    console.log('To import, run without --dry-run flag.');
    return;
  }

  // Warn about the current size of the knowledge base. This used to print
  // "Continue with import?" and then import regardless of the answer, so the
  // question was never actually asked. The behaviour is now stated instead:
  // duplicates are skipped unless --force is given.
  const stats = knowledgeGraphService.getStats();
  if (stats.totalDocuments > 0) {
    console.log(`⚠️  Database already has ${stats.totalDocuments} documents.`);
    if (force) {
      console.log('--force was given, so existing documents with the same title and topic');
      console.log('will be imported again as duplicates.');
    } else {
      console.log('Documents whose title and topic already exist will be skipped.');
      console.log('Use --force to import them anyway.');
    }
    console.log('To see existing documents, use: /knowledge list\n');
  }

  // One indexed pass instead of a full scan per document.
  const existingKeys = loadExistingDocumentKeys();
  // Documents duplicated *within this batch* must be caught too, otherwise a
  // directory holding the same page twice would insert it twice.
  const seenKeys = new Set<string>();

  console.log('\n💾 Importing to database...\n');

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of docs) {
    const key = `${doc.title.toLowerCase()} ${doc.topic.toLowerCase()}`;
    try {
      if (!force && (existingKeys.has(key) || seenKeys.has(key))) {
        console.log(`⏭️  Skipped: "${doc.title}" (already exists)`);
        skipped++;
        continue;
      }

      knowledgeGraphService.storeDocument({
        topic: doc.topic,
        title: doc.title,
        content: doc.content,
        keywords: doc.keywords,
        type: doc.type,
        url: doc.url,
        priority: doc.priority,
      });

      seenKeys.add(key);
      console.log(`✅ Imported: "${doc.title}" (${doc.topic})`);
      imported++;
    } catch (error) {
      console.error(`❌ Error importing "${doc.title}":`, error);
      errors++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Import Summary:');
  console.log(`   Imported: ${imported}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log('='.repeat(50));

  // Show final stats
  const finalStats = knowledgeGraphService.getStats();
  console.log(`\n📚 Database now has ${finalStats.totalDocuments} documents across ${finalStats.totalTopics} topics.`);

  const topics = knowledgeGraphService.listTopics();
  if (topics.length > 0) {
    console.log(`\n📁 Topics: ${topics.join(', ')}`);
  }

  if (errors > 0) {
    // The count was printed but the exit code stayed 0, so a partially failed
    // import was indistinguishable from a clean one to CI and to any wrapper.
    console.error(`\n❌ ${errors} document(s) failed to import.`);
    process.exitCode = 1;
    return;
  }

  console.log('\n✨ Import complete!');
  console.log('You can now ask Lumia about these topics.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});