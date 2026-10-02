/**
 * Example seed script for the knowledge graph
 * Run this to add sample documents for testing
 *
 * Usage:
 *   bun run src/scripts/seed-knowledge.ts            # seed, skipping documents that already exist
 *   bun run src/scripts/seed-knowledge.ts --force    # overwrite existing documents with the same title+topic
 *   bun run src/scripts/seed-knowledge.ts --dry-run  # report what would be added, change nothing
 *
 * WHY THIS IS GATED
 * ------------------
 * The old version printed "Do you want to add example documents anyway? (y/n)"
 * and then immediately answered itself on the next line ("For automation, just
 * add them"), and `storeDocument` is a plain INSERT. So every re-run appended a
 * second copy of all five documents, with nothing to deduplicate them, growing
 * the knowledge base without bound. Documents are now matched on
 * `LOWER(title), LOWER(topic)` — the same key `knowledgeGraphService.syncFromFiles`
 * uses — and existing rows are updated rather than duplicated.
 */

import { Database } from 'bun:sqlite';
import { knowledgeGraphService } from '../services/knowledge-graph';
import { dbPath } from '../utils/paths';
import { parseArgs, wantsHelp } from './safety';

console.log('🌱 Seeding knowledge base with example documents...\n');

// Example documents about Lucid Loom
const exampleDocuments = [
  {
    topic: 'lucid-loom',
    title: 'What is Lucid Loom?',
    content: `Lucid Loom is a carefully curated preset designed for immersive character interactions. It emphasizes natural, flowing conversations that feel organic and engaging. The preset is built with specific goals in mind: creating deep character connections, maintaining narrative consistency, and enabling complex roleplay scenarios.

Key Features:
- Natural dialogue flow that mimics real conversation
- Strong character voice consistency
- Support for multi-turn narratives
- Enhanced emotional depth and expression
- Built-in safeguards for staying in character

The preset is particularly popular among users who want their AI characters to feel alive and responsive, with personalities that evolve naturally through conversation.`,
    keywords: ['loom', 'lucid loom', 'll', 'preset', 'character', 'roleplay', 'ai', 'persona'],
    type: 'document' as const,
    priority: 9,
  },
  {
    topic: 'lucid-loom',
    title: 'Lucid Loom Setup Guide',
    content: `Getting started with Lucid Loom is straightforward! Here are the basic steps:

1. Download the Lucid Loom preset files from the official repository
2. Import the preset into your AI platform (SillyTavern, Oobabooga, etc.)
3. Configure your character using the LL formatting guidelines
4. Adjust temperature and sampling settings for optimal results
5. Start your first conversation and refine based on responses

Pro Tips:
- Start with a simple character concept and build complexity gradually
- Use the example character cards as templates
- Pay attention to the formatting - it matters for consistency
- Don't be afraid to tweak the system prompt for your specific use case

The community is super helpful if you get stuck! Just ask in the Discord.`,
    keywords: ['setup', 'guide', 'install', 'configure', 'getting started', 'tutorial', 'help'],
    type: 'document' as const,
    priority: 8,
  },
  {
    topic: 'lucid-loom',
    title: 'Official Lucid Loom Repository',
    content: `The official Lucid Loom repository contains all preset files, documentation, example characters, and community resources.`,
    keywords: ['repository', 'github', 'download', 'official', 'source'],
    type: 'link' as const,
    url: 'https://github.com/lucid-loom/presets',
    priority: 10,
  },
  {
    topic: 'lucid-loom',
    title: 'Character Card Format',
    content: `Lucid Loom uses a specific character card format to ensure maximum compatibility and performance. The format includes:

Required Fields:
- name: Character's display name
- description: Physical appearance and personality
- personality: Core character traits
- scenario: Current situation/context
- first_mes: Opening message

Optional Fields:
- mes_example: Example dialogue
- creatorcomment: Notes for the user
- tags: Categories and descriptors
- creator: Your name/alias

The LL format emphasizes brevity and clarity over lengthy descriptions. Aim for concise but evocative writing that gives the AI room to improvise while staying true to the character essence.`,
    keywords: ['character card', 'format', 'json', 'fields', 'structure', 'template'],
    type: 'document' as const,
    priority: 8,
  },
  {
    topic: 'lucid-loom',
    title: 'Best Practices for LL Characters',
    content: `Creating great characters with Lucid Loom requires understanding some key principles:

Character Depth vs Complexity:
- Focus on 2-3 core personality traits rather than listing dozens
- Let the AI fill in gaps naturally through conversation
- Provide motivations and goals, not just descriptions

Writing Style:
- Use active, present-tense descriptions
- Avoid overly flowery or purple prose
- Show, don't tell - demonstrate personality through examples
- Keep descriptions under 500 words when possible

Testing and Iteration:
- Test your character with various conversation starters
- Note where they break character and refine those areas
- Get feedback from the community
- Iterate based on actual usage, not theory

Remember: The goal is a character that feels alive, not one that's exhaustively documented!`,
    keywords: ['best practices', 'tips', 'advice', 'character creation', 'writing', 'guide'],
    type: 'document' as const,
    priority: 7,
  },
];

/**
 * Look up an existing document by the same case-insensitive (title, topic) key
 * used for de-duplication, returning its id so it can be updated in place.
 */
function findExistingDocumentId(title: string, topic: string): number | null {
  const db = new Database(dbPath('knowledge_graph.db'), { readonly: true });
  try {
    const row = db
      .query('SELECT id FROM knowledge_documents WHERE LOWER(title) = LOWER(?) AND LOWER(topic) = LOWER(?) LIMIT 1')
      .get(title, topic) as { id: number } | undefined;
    return row ? row.id : null;
  } finally {
    db.close();
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));

  if (wantsHelp(parsed)) {
    console.log(`
Seed the knowledge base with the five example "Lucid Loom" documents.

Usage:
  bun run src/scripts/seed-knowledge.ts            Skip documents that already exist.
  bun run src/scripts/seed-knowledge.ts --force    Update existing documents in place.
  bun run src/scripts/seed-knowledge.ts --dry-run  Report only; change nothing.
`);
    return;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(`❌ Unknown option(s): ${parsed.unknownFlags.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const force = parsed.flags.has('--force');
  const dryRun = parsed.flags.has('--dry-run');

  console.log('🌱 Seeding knowledge base with example documents...\n');

  const existingStats = knowledgeGraphService.getStats();

  if (existingStats.totalDocuments > 0) {
    console.log(`⚠️  Knowledge base already has ${existingStats.totalDocuments} document(s).`);
    if (force) {
      console.log('--force was given, so existing Lucid Loom documents will be updated in place.');
    } else {
      console.log('Example documents that already exist will be skipped, not duplicated.');
      console.log('Use --force to overwrite them with the bundled content.');
    }
    console.log();
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const doc of exampleDocuments) {
    const existingId = findExistingDocumentId(doc.title, doc.topic);

    if (existingId !== null && !force) {
      console.log(`⏭️  Skipped: "${doc.title}" (${doc.topic}) — already present`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`${existingId !== null ? '🔄 Would update' : '➕ Would add'}: "${doc.title}" (${doc.topic})`);
      if (existingId !== null) updated++;
      else added++;
      continue;
    }

    if (existingId !== null) {
      // updateDocument sets `updated_at` and invalidates the document cache.
      knowledgeGraphService.updateDocument(existingId, {
        topic: doc.topic,
        title: doc.title,
        content: doc.content,
        keywords: doc.keywords,
        type: doc.type,
        url: doc.url,
        priority: doc.priority,
      });
      console.log(`🔄 Updated: "${doc.title}" (${doc.topic})`);
      updated++;
    } else {
      knowledgeGraphService.storeDocument(doc);
      console.log(`✅ Added: "${doc.title}" (${doc.topic})`);
      added++;
    }
  }

  if (dryRun) {
    console.log('\n🏃 Dry run complete. No changes made to database.');
    return;
  }

  console.log(`\n🎉 Seed complete: ${added} added, ${updated} updated, ${skipped} skipped.`);

  // Show final stats
  const stats = knowledgeGraphService.getStats();
  console.log(`\n📊 Knowledge Base Stats:`);
  console.log(`   Total Documents: ${stats.totalDocuments}`);
  console.log(`   Topics: ${stats.totalTopics}`);

  const topics = knowledgeGraphService.listTopics();
  console.log(`\n📁 Topics: ${topics.join(', ')}`);

  console.log('\n💡 Try asking Lumia about "Loom", "Lucid Loom", or "LL" to test!');
}

try {
  main();
} catch (error) {
  console.error('❌ Error seeding knowledge base:', error);
  process.exitCode = 1;
}
