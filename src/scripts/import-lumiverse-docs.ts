/**
 * Import Lumiverse documentation into the knowledge graph.
 *
 * Reads all Markdown files from both user-docs and developer-docs in the
 * Lumiverse-Backend repo, converts them to frontmatter-tagged knowledge
 * documents, and bulk-imports them after clearing the existing DB.
 *
 * Usage:
 *   bun run import-docs --dry-run     # collect and report, change nothing
 *   bun run import-docs               # print the plan and refuse (exit 1)
 *   bun run import-docs --force       # back up, clear, and import
 *
 * WHY THE EXPLICIT GATE
 * ---------------------
 * This script used to call `clearAll()` and then `bulkImport()` unconditionally,
 * while `collectDocs()` merely logged and continued when a source directory was
 * missing. The doc root was a hardcoded developer path built from `HOME`, with
 * a literal `'~'` fallback when `HOME` was unset. Running it anywhere that path
 * did not exist therefore wiped the whole knowledge base and replaced it with
 * half the documents, with no dry run, no backup and no confirmation.
 *
 * Now: a missing source directory is a hard error, `--dry-run` previews the
 * plan, the destructive step requires `--force`, and `knowledge_graph.db` is
 * backed up with `VACUUM INTO` before anything is cleared.
 */

import { readFile, readdir } from 'fs/promises';
import { join, relative, dirname, basename, extname } from 'path';
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { knowledgeGraphService } from '../services/knowledge-graph';
import { dbPath } from '../utils/paths';
import { strEnv } from '../utils/env';
import { parseArgs, wantsHelp } from './safety';

const KNOWLEDGE_DB_PATH = dbPath('knowledge_graph.db');

/**
 * Root of the Lumiverse-Backend checkout. Overridable with `LUMIVERSE_ROOT`
 * because the previous value was hardcoded to one developer's `$HOME`.
 */
const HOME_DIR = process.env.HOME ?? '';
if (!HOME_DIR) {
  console.error('❌ HOME is not set, so the Lumiverse docs location cannot be derived.');
  console.error('   Set HOME, or set LUMIVERSE_ROOT to the Lumiverse-Backend checkout.');
  process.exit(1);
}

const LUMIVERSE_ROOT = strEnv('LUMIVERSE_ROOT', join(HOME_DIR, 'Projects', 'Lumiverse-Backend'));

const SOURCES = [
  {
    docsDir: join(LUMIVERSE_ROOT, 'user-docs', 'docs'),
    baseUrl: 'https://lumiverse.chat/guides',
    docSet: 'user-guides',
    defaultPriority: 6,
  },
  {
    docsDir: join(LUMIVERSE_ROOT, 'developer-docs', 'docs'),
    baseUrl: 'https://docs.lumiverse.chat',
    docSet: 'developer-docs',
    defaultPriority: 5,
  },
] as const;

const SKIP_FILES = new Set(['extra.css']);
const SKIP_DIRS = new Set(['stylesheets']);

interface DocEntry {
  topic: string;
  title: string;
  content: string;
  keywords: string[];
  type: 'document' | 'link' | 'snippet';
  url: string;
  priority: number;
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map(word => {
      if (word === 'api') return 'API';
      if (word === 'llm') return 'LLM';
      if (word === 'rpc') return 'RPC';
      if (word === 'ui') return 'UI';
      if (word === 'dom') return 'DOM';
      if (word === 'cors') return 'CORS';
      if (word === 'oauth') return 'OAuth';
      if (word === 'ooc') return 'OOC';
      if (word === 'tts') return 'TTS';
      if (word === 'stt') return 'STT';
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function buildUrl(baseUrl: string, relPath: string): string {
  let urlPath = relPath.replace(/\.md$/, '/');
  if (urlPath.endsWith('/index/')) {
    urlPath = urlPath.replace(/index\/$/, '');
  }
  return `${baseUrl}/${urlPath}`.replace(/\/+$/, '/');
}

function extractTitle(content: string, fileName: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1?.[1]) return h1[1].trim();
  return titleCase(fileName.replace(/\.md$/, ''));
}

function extractKeywords(content: string, title: string, topic: string): string[] {
  const kw = new Set<string>();

  kw.add('lumiverse');

  // Title words (>2 chars)
  title.toLowerCase().split(/\s+/).filter(w => w.length > 2).forEach(w => kw.add(w));

  // Topic (strip parenthesized qualifier like "(User Guide)")
  topic.replace(/\s*\(.*\)/, '').toLowerCase().split(/\s+/).filter(w => w.length > 2).forEach(w => kw.add(w));

  // Headings (H2-H4)
  const headings = content.matchAll(/^#{2,4}\s+(.+)$/gm);
  for (const m of headings) {
    if (m[1]) {
      m[1].toLowerCase().split(/\s+/).filter(w => w.length > 2 && !/^[#*`\-]+$/.test(w)).forEach(w => kw.add(w));
    }
  }

  // Bold terms
  const bolds = content.matchAll(/\*\*([^*]+)\*\*/g);
  for (const m of bolds) {
    if (m[1] && m[1].length < 40) {
      m[1].toLowerCase().split(/\s+/).filter(w => w.length > 2).forEach(w => kw.add(w));
    }
  }

  // Inline code terms
  const codes = content.matchAll(/`([^`]+)`/g);
  for (const m of codes) {
    if (m[1] && m[1].length < 30 && !m[1].includes(' ')) {
      kw.add(m[1].toLowerCase());
    }
  }

  // Remove noise
  const noise = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'was', 'one', 'our', 'out', 'use', 'her', 'him', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'with', 'this', 'that', 'from', 'they', 'have', 'will', 'each', 'make', 'like', 'just', 'over', 'such', 'take', 'than', 'them', 'very', 'when', 'what', 'your', 'been', 'more', 'some', 'then', 'these', 'about', 'which', 'would', 'their', 'other', 'there', 'after', 'could', 'those', 'where', 'should']);
  noise.forEach(w => kw.delete(w));

  return [...kw].slice(0, 25);
}

function determinePriority(relPath: string, docSet: string, defaultPriority: number): number {
  const name = basename(relPath, '.md');
  if (name === 'index' && dirname(relPath) === '.') return defaultPriority + 2; // Root index
  if (name === 'index') return defaultPriority + 1; // Section overviews
  if (relPath.startsWith('getting-started/')) return defaultPriority + 1;
  if (docSet === 'developer-docs' && relPath.startsWith('examples/')) return defaultPriority;
  return defaultPriority;
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(full));
    } else if (entry.isFile() && extname(entry.name) === '.md' && !SKIP_FILES.has(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Collect documents from every source.
 *
 * A missing source directory used to be logged and skipped, which is how a
 * half-populated knowledge base came to replace a full one. It is now a hard
 * failure: importing a partial set after a destructive clear is never the
 * intended outcome.
 */
async function collectDocs(): Promise<DocEntry[]> {
  const docs: DocEntry[] = [];
  const missing: string[] = [];

  for (const source of SOURCES) {
    if (!existsSync(source.docsDir)) {
      console.error(`❌ Directory not found: ${source.docsDir}`);
      missing.push(source.docsDir);
      continue;
    }

    const files = await walkDir(source.docsDir);
    console.log(`📂 Found ${files.length} markdown files in ${source.docSet}`);

    if (files.length === 0) {
      console.error(`❌ No markdown files found in ${source.docsDir}`);
      missing.push(source.docsDir);
      continue;
    }

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8');
      const relPath = relative(source.docsDir, filePath);
      const parentDir = dirname(relPath);
      const fileName = basename(relPath);

      const topic = parentDir === '.'
        ? (source.docSet === 'user-guides' ? 'Lumiverse User Guides' : 'Lumiverse Developer Docs')
        : `${titleCase(parentDir)} (${source.docSet === 'user-guides' ? 'User Guide' : 'Developer Docs'})`;

      const title = extractTitle(content, fileName);
      const url = buildUrl(source.baseUrl, relPath);
      const keywords = extractKeywords(content, title, topic);
      const priority = determinePriority(relPath, source.docSet, source.defaultPriority);

      docs.push({
        topic,
        title,
        content,
        keywords,
        type: 'document',
        url,
        priority,
      });
    }
  }

  if (missing.length > 0) {
    console.error('\n❌ Refusing to import: some source directories were missing or empty.');
    for (const dir of missing) console.error(`   - ${dir}`);
    console.error(`\nDocs root in use: ${LUMIVERSE_ROOT}`);
    console.error('Set LUMIVERSE_ROOT to the Lumiverse-Backend checkout if it lives elsewhere.');
    console.error('Importing now would replace the knowledge base with a partial set.');
    process.exit(1);
  }

  return docs;
}

/**
 * Consistent backup of the knowledge base.
 *
 * `VACUUM INTO` writes a single self-contained file that includes anything
 * still sitting in the WAL, unlike a raw byte copy of the main file.
 */
function backupKnowledgeBase(): string | null {
  if (!existsSync(KNOWLEDGE_DB_PATH)) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${KNOWLEDGE_DB_PATH}.predocsimport-${timestamp}.bak`;
  const source = new Database(KNOWLEDGE_DB_PATH, { readonly: true });
  try {
    source.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  return backup;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (wantsHelp(parsed)) {
    console.log(`
Import Lumiverse documentation into the knowledge graph.

Usage:
  bun run import-docs --dry-run   Collect documents and report; change nothing.
  bun run import-docs --force     Back up knowledge_graph.db, clear it, and import.
  bun run import-docs             Prints the plan and exits non-zero without importing.

Environment:
  LUMIVERSE_ROOT   Path to the Lumiverse-Backend checkout.
                   Default: $HOME/Projects/Lumiverse-Backend

--force is required because the import replaces the entire knowledge base.
`);
    return;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(`❌ Unknown option(s): ${parsed.unknownFlags.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const dryRun = parsed.flags.has('--dry-run');
  const force = parsed.flags.has('--force');

  console.log('📚 Lumiverse Documentation Importer');
  console.log('====================================\n');
  console.log(`Docs root: ${LUMIVERSE_ROOT}\n`);

  // collectDocs() exits(1) on a missing or empty source directory, so reaching
  // this point means every source contributed documents.
  const docs = await collectDocs();

  if (docs.length === 0) {
    console.error('❌ No documents found to import.');
    process.exit(1);
  }

  console.log(`\n📊 Summary: ${docs.length} documents ready to import`);
  console.log(`   User guides:    ${docs.filter(d => d.topic.includes('User Guide') || d.topic === 'Lumiverse User Guides').length}`);
  console.log(`   Developer docs: ${docs.filter(d => d.topic.includes('Developer Docs') || d.topic === 'Lumiverse Developer Docs').length}`);

  const existing = knowledgeGraphService.getStats();
  console.log(`\n⚠️  This replaces the whole knowledge base: ${existing.totalDocuments} existing document(s) will be deleted.`);
  console.log(`   Database: ${KNOWLEDGE_DB_PATH}`);

  if (dryRun) {
    console.log('\n📋 Documents that would be imported:');
    for (const doc of docs) {
      console.log(`   - "${doc.title}" (${doc.topic})`);
    }
    console.log(`\n🏃 Dry run complete. Nothing was changed.`);
    console.log('To import for real: bun run import-docs --force');
    return;
  }

  if (!force) {
    console.error('\n❌ Not importing: replacing the knowledge base requires --force.');
    console.error('   Preview the exact document list first:  bun run import-docs --dry-run');
    console.error('   Then import, keeping a backup:          bun run import-docs --force');
    process.exitCode = 1;
    return;
  }

  console.log('\n💾 Backing up the current knowledge base...');
  const backup = backupKnowledgeBase();
  if (backup) {
    console.log(`   Backup written: ${backup}`);
  } else {
    console.log(`   No existing database at ${KNOWLEDGE_DB_PATH}; nothing to back up.`);
  }

  // Clear existing knowledge base
  const cleared = knowledgeGraphService.clearAll();
  console.log(`\n🗑️  Cleared ${cleared.deletedCount} existing documents`);

  // Bulk import
  knowledgeGraphService.bulkImport(docs);
  console.log(`✅ Successfully imported ${docs.length} documents into knowledge graph`);

  // Show stats
  const stats = knowledgeGraphService.getStats();
  console.log(`\n📈 Knowledge base now has ${stats.totalDocuments} documents across ${stats.totalTopics} topics`);

  const topicStats = knowledgeGraphService.getTopicStats();
  console.log('\nDocuments by topic:');
  for (const t of topicStats) {
    console.log(`   ${t.topic}: ${t.count} docs (avg priority: ${t.avgPriority})`);
  }

  if (backup) {
    console.log(`\n↩️  To restore the previous knowledge base, stop the bot and replace`);
    console.log(`   ${KNOWLEDGE_DB_PATH} with ${backup}`);
  }
}

main().catch(err => {
  console.error('❌ Import failed:', err);
  process.exit(1);
});