/**
 * Markdown Document Parser for Knowledge Graph
 * 
 * Reads Markdown files from a directory and converts them to KnowledgeDocument format.
 * Supports frontmatter-style metadata or inline metadata headers.
 * 
 * Usage:
 *   bun run src/scripts/import-markdown.ts
 * 
 * Or programmatically:
 *   import { parseMarkdownFile, importMarkdownDirectory } from './markdown-parser';
 *   const docs = await importMarkdownDirectory('./knowledge_documents');
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';
import type { KnowledgeDocument } from '../services/knowledge-graph';

export interface ParsedMarkdownDocument {
  topic: string;
  title: string;
  content: string;
  keywords: string[];
  type: 'document' | 'link' | 'snippet';
  url?: string;
  priority: number;
  sourceFile: string;
}

/**
 * Parse a Markdown file into a KnowledgeDocument
 * 
 * Supports two metadata formats:
 * 
 * 1. Frontmatter style (YAML-like):
 *    ---
 *    topic: lucid-loom
 *    title: My Document
 *    keywords: loom, preset, ai
 *    type: document
 *    priority: 8
 *    ---
 *    
 *    Content here...
 * 
 * 2. Inline header style:
 *    # My Document Title
 *    
 *    **Topic:** lucid-loom
 *    **Keywords:** loom, preset, ai
 *    **Type:** document
 *    **Priority:** 8
 *    
 *    Content here...
 */
export async function parseMarkdownFile(filePath: string): Promise<ParsedMarkdownDocument | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const fileName = basename(filePath);
    
    // Try to parse frontmatter first
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    
    if (frontmatterMatch && frontmatterMatch[1] && frontmatterMatch[2]) {
      // Parse frontmatter
      const frontmatter = frontmatterMatch[1];
      const bodyContent = frontmatterMatch[2].trim();
      
      const metadata: Record<string, string> = {};
      frontmatter.split('\n').forEach(line => {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        if (match && match[1] && match[2]) {
          metadata[match[1].trim().toLowerCase()] = match[2].trim();
        }
      });
      
      // Extract title from frontmatter or first H1
      let title = metadata.title || '';
      if (!title) {
        const h1Match = bodyContent.match(/^#\s+(.+)$/m);
        title = (h1Match && h1Match[1]) ? h1Match[1] : fileName.replace('.md', '');
      }
      
      // Parse keywords
      const keywords = metadata.keywords 
        ? metadata.keywords.split(',').map(k => k.trim()).filter(k => k.length > 0)
        : [];
      
      return {
        topic: metadata.topic || 'general',
        title: title || 'Untitled',
        content: bodyContent,
        keywords,
        type: (metadata.type as 'document' | 'link' | 'snippet') || 'document',
        url: metadata.url,
        priority: parseInt(metadata.priority || '5', 10),
        sourceFile: fileName,
      };
    }
    
    // Try inline header style
    const headerMatch = content.match(/^#\s+(.+)$/m);
    const title = (headerMatch && headerMatch[1]) ? headerMatch[1] : fileName.replace('.md', '');
    
    // Extract metadata from bold headers
    const metadata: Record<string, string> = {};
    const metaRegex = /\*\*([^:]+):\*\*\s*(.+?)(?=\n\n|\n\*\*|$)/g;
    let match;
    while ((match = metaRegex.exec(content)) !== null) {
      if (match[1] && match[2]) {
        metadata[match[1].toLowerCase().trim()] = match[2].trim();
      }
    }
    
    // Remove metadata section from content
    let bodyContent = content;
    Object.entries(metadata).forEach(([key, value]) => {
      // Use simple string replacement instead of regex to avoid escaping issues
      const pattern = `**${key}:** ${value}`;
      bodyContent = bodyContent.split(pattern).join('');
    });
    
    // Clean up the content
    bodyContent = bodyContent
      .replace(/^#\s+.+$/m, '') // Remove title
      .replace(/\n{3,}/g, '\n\n') // Clean up excessive newlines
      .trim();
    
    // Parse keywords
    const keywords = metadata.keywords 
      ? metadata.keywords.split(',').map(k => k.trim()).filter(k => k.length > 0)
      : [];
    
    return {
      topic: metadata.topic || 'general',
      title: title || 'Untitled',
      content: bodyContent,
      keywords,
      type: (metadata.type as 'document' | 'link' | 'snippet') || 'document',
      url: metadata.url,
      priority: parseInt(metadata.priority || '5', 10),
      sourceFile: fileName,
    };
    
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error);
    return null;
  }
}

/**
 * Options for {@link importMarkdownDirectory}.
 */
export interface MarkdownImportOptions {
  /**
   * Throw a {@link MarkdownImportError} when any file or directory could not be
   * read, instead of returning the documents that *were* readable.
   *
   * Default `false` (lenient) because the boot-time sync in
   * `knowledge-graph.syncFromFiles()` must not take the whole bot down when one
   * document is unreadable. An explicit import run should pass `true`: silently
   * skipping a file makes a partial import look like a complete one.
   */
  strict?: boolean;
}

/**
 * Thrown in strict mode when part of the tree could not be read. Carries the
 * documents that did parse, so the caller can report "12 of 15 imported" rather
 * than pretending the import was empty.
 */
export class MarkdownImportError extends Error {
  public readonly failures: string[];
  public readonly documents: ParsedMarkdownDocument[];

  constructor(failures: string[], documents: ParsedMarkdownDocument[]) {
    super(
      `Markdown import incomplete: ${failures.length} file(s) or directory(ies) could not be read ` +
        `(${documents.length} parsed). Unreadable: ${failures.join(', ')}`
    );
    this.name = 'MarkdownImportError';
    this.failures = failures;
    this.documents = documents;
  }
}

async function importMarkdownDirectoryInto(
  dirPath: string,
  results: ParsedMarkdownDocument[],
  failures: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    // Previously swallowed, so a permission error or a missing directory made
    // a *partial* tree look like an empty one.
    failures.push(dirPath);
    console.error(`Error reading directory ${dirPath}:`, error);
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Recursively process subdirectories
      await importMarkdownDirectoryInto(fullPath, results, failures);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      // Skip README.md files (documentation, not knowledge content)
      if (entry.name.toLowerCase() === 'readme.md') {
        continue;
      }

      const doc = await parseMarkdownFile(fullPath);
      if (doc) {
        results.push(doc);
      } else {
        // parseMarkdownFile returns null only when the read threw.
        failures.push(fullPath);
      }
    }
  }
}

/**
 * Import all Markdown files from a directory (recursively).
 *
 * Unreadable files and directories are counted. With `strict: true` the import
 * fails loudly instead of returning a short list, because a short list is
 * indistinguishable from "there was nothing to import" at the call site.
 */
export async function importMarkdownDirectory(
  dirPath: string,
  options: MarkdownImportOptions = {}
): Promise<ParsedMarkdownDocument[]> {
  const results: ParsedMarkdownDocument[] = [];
  const failures: string[] = [];

  await importMarkdownDirectoryInto(dirPath, results, failures);

  if (failures.length > 0 && options.strict) {
    throw new MarkdownImportError(failures, results);
  }

  return results;
}

/**
 * CLI script to import Markdown files
 * Run with: bun run src/scripts/import-markdown.ts [directory]
 */
if (import.meta.main) {
  const targetDir = process.argv[2] || './knowledge_documents';
  
  console.log(`📚 Importing Markdown files from: ${targetDir}\n`);
  
  importMarkdownDirectory(targetDir, { strict: true }).then(docs => {
    if (docs.length === 0) {
      console.log('❌ No valid Markdown files found.');
      process.exit(1);
    }
    
    console.log(`✅ Successfully parsed ${docs.length} documents:\n`);
    
    docs.forEach((doc, i) => {
      console.log(`${i + 1}. "${doc.title}" (${doc.topic})`);
      console.log(`   Type: ${doc.type} | Priority: ${doc.priority}`);
      console.log(`   Keywords: ${doc.keywords.join(', ')}`);
      console.log(`   Source: ${doc.sourceFile}`);
      console.log();
    });
    
    // Optionally import to database
    console.log('💾 To import these into the knowledge base, run:');
    console.log('   bun run src/scripts/import-to-db.ts ' + targetDir);
    
  }).catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
}
