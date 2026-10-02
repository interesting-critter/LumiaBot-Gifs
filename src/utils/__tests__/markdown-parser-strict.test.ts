import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  importMarkdownDirectory,
  MarkdownImportError,
  parseMarkdownFile,
} from '../markdown-parser';
import { REPO_ROOT } from '../paths';

/**
 * The `strict` option was built, documented, and then never passed by any
 * production caller — so the failure list was computed and thrown away on both
 * of them, and a partial tree was indistinguishable from a complete one.
 *
 * The failure it was meant to prevent: `knowledge_documents/` holds 40 files,
 * one sits behind an unreadable directory, `readdir` throws, and the operator
 * sees `✅ Found 39 documents` / `✅ File sync complete: 39 unchanged` with no
 * hint that anything was skipped.
 *
 * Real filesystem, temp directories, no mocks.
 */

const scratch = mkdtempSync(join(tmpdir(), 'lumia-md-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function doc(name: string, title: string): string {
  return `---\ntopic: t\ntitle: ${title}\nkeywords: a, b\n---\n\nBody of ${title}.\n`;
}

/** A tree with `count` readable documents. */
function tree(count: number, label: string): string {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `doc-${i}.md`), doc(`${i}`, `Doc ${i}`));
  }
  return dir;
}

describe('importMarkdownDirectory — strict mode', () => {
  test('a fully readable tree returns every document in both modes', async () => {
    const dir = tree(3, 'clean');

    const lenient = await importMarkdownDirectory(dir);
    const strict = await importMarkdownDirectory(dir, { strict: true });

    expect(lenient).toHaveLength(3);
    expect(strict).toHaveLength(3);
  });

  test('a missing directory is a silent short list in lenient mode — the original bug', async () => {
    // This is the shape of the incident: a caller cannot tell "the tree is
    // empty" from "the tree is unreadable", because both return `[]`.
    const lenient = await importMarkdownDirectory(join(scratch, 'does-not-exist'));
    expect(lenient).toEqual([]);
  });

  test('a missing directory throws in strict mode', async () => {
    await expect(
      importMarkdownDirectory(join(scratch, 'does-not-exist'), { strict: true }),
    ).rejects.toBeInstanceOf(MarkdownImportError);
  });

  test('the error names every unreadable path', async () => {
    let thrown: unknown;
    try {
      await importMarkdownDirectory(join(scratch, 'does-not-exist'), { strict: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MarkdownImportError);
    const failure = thrown as MarkdownImportError;
    expect(failure.failures).toHaveLength(1);
    expect(failure.failures[0]).toContain('does-not-exist');
    expect(failure.message).toContain('does-not-exist');
  });

  test('the error still carries what did parse, so the caller can report "12 of 15"', async () => {
    // A partially-readable tree: a readable subdirectory beside an unreadable
    // one. `bad` is chmod 000, so `readdir` on it throws EACCES — the exact
    // shape of the incident ("one file behind an unreadable directory").
    const root = join(scratch, 'partial');
    const good = join(root, 'good');
    const bad = join(root, 'bad');
    mkdirSync(good, { recursive: true });
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(good, 'a.md'), doc('a', 'Good A'));
    writeFileSync(join(good, 'b.md'), doc('b', 'Good B'));
    writeFileSync(join(bad, 'hidden.md'), doc('hidden', 'Hidden'));
    chmodSync(bad, 0o000);

    try {
      let thrown: unknown;
      try {
        await importMarkdownDirectory(root, { strict: true });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(MarkdownImportError);
      const failure = thrown as MarkdownImportError;
      expect(failure.documents).toHaveLength(2);
      expect(failure.failures.length).toBeGreaterThanOrEqual(1);
    } finally {
      // Always restore, or the temp dir cannot be cleaned up.
      chmodSync(bad, 0o755);
    }
  });

  test('lenient mode silently returns the short list — the behaviour being fixed', async () => {
    // Built separately from the previous case: restoring the permissions there
    // makes the tree complete again, which would hide the contrast.
    const root = join(scratch, 'partial-lenient');
    const good = join(root, 'good');
    const bad = join(root, 'bad');
    mkdirSync(good, { recursive: true });
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(good, 'a.md'), doc('a', 'Good A'));
    writeFileSync(join(bad, 'hidden.md'), doc('hidden', 'Hidden'));
    chmodSync(bad, 0o000);

    try {
      // Lenient: two documents, and not one word about the third being skipped.
      // This is what both production call sites used to do.
      const lenient = await importMarkdownDirectory(root);
      expect(lenient).toHaveLength(1);
    } finally {
      chmodSync(bad, 0o755);
    }
  });
});

describe('parseMarkdownFile', () => {
  test('reads frontmatter and returns null on an unreadable path', async () => {
    const dir = tree(1, 'parse');
    const parsed = await parseMarkdownFile(join(dir, 'doc-0.md'));
    expect(parsed?.title).toBe('Doc 0');
    expect(parsed?.topic).toBe('t');

    expect(await parseMarkdownFile(join(dir, 'nope.md'))).toBeNull();
  });
});

/**
 * Source-level assertions for the two production call sites, because the
 * behaviour that matters is "does this caller opt in", and that is only visible
 * in the call.
 */
describe('production call sites pass strict: true', () => {
  const source = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

  test('import-to-db.ts aborts rather than importing a partial tree', () => {
    const text = source('src/scripts/import-to-db.ts');
    expect(text).toMatch(/importMarkdownDirectory\(\s*targetDir,\s*\{\s*strict:\s*true\s*,?\s*\}\s*\)/);
    // And it must handle the throw rather than letting `main().catch` print a
    // bare stack trace with no indication of what was unreadable.
    expect(text).toContain('MarkdownImportError');
    expect(text).toContain('error.failures');
  });

  test('knowledge-graph.syncFromFiles opts in but does not fail the boot', () => {
    const text = source('src/services/knowledge-graph.ts');
    expect(text).toMatch(/importMarkdownDirectory\(\s*resolvedPath,\s*\{\s*strict:\s*true\s*,?\s*\}\s*\)/);

    // Boot-safety: the error is caught, reported loudly, and the readable
    // subset is still synced.
    expect(text).toContain('MarkdownImportError');
    expect(text).toContain('docs = error.documents');
    expect(text).toContain('PARTIAL FILE SYNC');
  });

  test('a partial sync never claims to be complete', () => {
    const text = source('src/services/knowledge-graph.ts');
    expect(text).toContain("${unreadableCount > 0 ? 'partial' : 'complete'}");
    expect(text).toContain('unreadableCount > 0\n      ? ` — ⚠️ PARTIAL');
  });

  test('the module CLI was already strict and stays that way', () => {
    expect(source('src/utils/markdown-parser.ts')).toContain(
      'importMarkdownDirectory(targetDir, { strict: true })',
    );
  });
});