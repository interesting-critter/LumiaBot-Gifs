/**
 * Contract tests for the checked-in `prompt_storage.example/` template.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * `prompt_storage.example/` is not documentation — it is the tree an operator
 * copies to make their own `prompt_storage/`. Every getter in
 * `src/services/prompts.ts` resolves against that tree, so a fixture that is
 * syntactically or structurally wrong is not a cosmetic problem: it is the
 * starting state of every new install.
 *
 * Two failure modes are pinned here, both of which shipped broken:
 *
 *   1. A `config/tool_descriptions.json` whose keys do not match what the code
 *      reads. `getToolDescriptions()` dereferences `boredom_preference` with no
 *      guard, so a file that parses but lacks that key raises a `TypeError` out
 *      of the getter. The template shipped the pre-rename camelCase keys
 *      (`queryKnowledgeBase`, `storeUserOpinion`, `searchWeb`, `searchUsers`),
 *      so *every* fresh install had it.
 *
 *   2. A `persona/command_responses.json` that is two concatenated JSON
 *      objects. `loadJsonFile` swallows the parse error and returns `null`, so
 *      the getter silently degrades to `{}` — every canned command reply
 *      answers with nothing, and nothing anywhere logs why.
 *
 * WHY THE EXPECTED TOOL SET IS DERIVED, NOT COPIED
 * ------------------------------------------------
 * The whole point is to fail when the two sides drift. A test that read its
 * expected keys out of `tool_descriptions.json` would pass forever, including on
 * the broken fixture. So the tool-name set is extracted from the provider
 * sources (`src/services/**.ts`, any file that registers tools), and the set of
 * keys `getToolDescriptions()` needs is extracted from `prompts.ts`. Adding a
 * tool without describing it now fails here instead of shipping.
 *
 * WHY THE FRESH INSTALL RUNS IN A SUBPROCESS
 * ------------------------------------------
 * `PROMPT_STORAGE_DIR` is derived from `import.meta.dir` at module load and has
 * no env override (`src/utils/paths.ts`), so a test cannot redirect it in
 * process — `mock.module` would mutate the module namespace for the whole
 * `bun test` process, where other suites also swap that module (see
 * `prompt-profiles.test.ts`, whose mocks are permanent). The subprocess builds
 * its own temp root and its own module instance, which both proves the real
 * code path end to end and keeps this file free of process-wide side effects.
 */

import { describe, expect, test } from 'bun:test';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import * as pathsNamespace from '../../utils/paths';

/**
 * Plain snapshot, taken before anything is mocked anywhere in this file.
 * Spreading detaches it from the live binding — see the note in
 * `prompt-profiles.test.ts` about Bun's `mock.module` writing through to the
 * namespace it replaces.
 */
const { REPO_ROOT } = { ...pathsNamespace };

/** The template tree an operator copies. */
const EXAMPLE_DIR = resolve(REPO_ROOT, 'prompt_storage.example');

/** Where the provider services that declare tools live. */
const SRC_DIR = resolve(REPO_ROOT, 'src');

/** The prompt service, source-read for the keys its getters dereference. */
const PROMPTS_SOURCE = resolve(SRC_DIR, 'services/prompts.ts');

/** Recursively list files under `base`, as forward-slash paths relative to it. */
function listFiles(base: string, dir: string = base, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(base, full, out);
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

/** Every `.json` file in the template tree. */
function exampleJsonFiles(): string[] {
  return listFiles(EXAMPLE_DIR).filter((f) => f.endsWith('.json')).sort();
}

/** Read + parse a file from the template tree, failing loudly on a typo. */
function readExampleJson(relativePath: string): Record<string, unknown> {
  const full = join(EXAMPLE_DIR, relativePath);
  return JSON.parse(readFileSync(full, 'utf-8')) as Record<string, unknown>;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Deriving the tool names the bot can actually register
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Tool names registered by one source file, keyed by tool name.
 *
 * Both providers build a local `tools` array and push declarations onto it, in
 * two different shapes:
 *
 *   - `openai.ts`      — `tools.push({ type: 'function', function: { name: '…' } })`
 *   - `google-genai.ts` — `tools.push({ name: '…', description, parameters })`
 *
 * so the shape cannot be pattern-matched directly. What both shapes share is
 * the boundary: a tool declaration starts at a `tools.push(` and runs until the
 * next `tools.push(` (or a declaration that pushes several at once, as
 * `openai.ts` does for the seven user-context tools). Scanning each of those
 * windows for `name: '<snake_case>'` therefore yields exactly the tool names,
 * and picks up multi-tool pushes without needing to know which style is in use.
 */
function toolNamesInFile(source: string): Set<string> {
  const lines = source.split('\n');
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/tools\.push\(/.test(line)) starts.push(i);
  });

  const names = new Set<string>();
  starts.forEach((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const window = lines.slice(start, end).join('\n');
    for (const match of window.matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)) {
      // The capture group is present whenever the regex matches; the guard is
      // only here because `noUncheckedIndexedAccess` widens it to `| undefined`.
      const toolName = match[1];
      if (toolName) names.add(toolName);
    }
  });

  return names;
}

/**
 * Every tool name the bot can register, from every source file that registers
 * tools. The file list is discovered, not hard-coded, so a new provider that
 * declares tools is covered by this test too.
 */
function allRegisteredToolNames(): { toolNames: Set<string>; declaringFiles: string[] } {
  const declaringFiles = listFiles(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
    .filter((f) => readFileSync(join(SRC_DIR, f), 'utf-8').includes('tools.push('))
    .sort();

  const toolNames = new Set<string>();
  for (const file of declaringFiles) {
    for (const name of toolNamesInFile(readFileSync(join(SRC_DIR, file), 'utf-8'))) {
      toolNames.add(name);
    }
  }

  return { toolNames, declaringFiles };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Deriving the keys getToolDescriptions() dereferences
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Keys `prompts.ts` reaches through `descriptions.<key>` — one per dotted path
 * that is actually dereferenced. Read out of the source rather than hard-coded
 * so the fixture's obligations follow the getter.
 *
 * `descriptions.boredom_preference.description` yields the top-level key
 * `boredom_preference` and the sub-key `description`.
 */
function requiredToolDescriptionKeys(): Array<{ key: string; subKey?: string }> {
  const source = readFileSync(PROMPTS_SOURCE, 'utf-8');
  const required = new Map<string, { key: string; subKey?: string }>();

  // The lookbehind keeps the path literal in `loadJsonFile('config/
  // tool_descriptions.json')` from being read as a `descriptions.json` key
  // access: there, `descriptions` is preceded by `_`, not by a property
  // operator or an identifier boundary.
  for (const match of source.matchAll(/(?<![A-Za-z0-9_.$])descriptions\.([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?/g)) {
    const [, key, subKey] = match;
    // Present whenever the regex matches; the guard is only here because
    // `noUncheckedIndexedAccess` widens the capture groups to `| undefined`.
    if (!key) continue;
    // A bare top-level reference has no sub-key obligation; a dotted one does.
    if (required.has(key) && required.get(key)!.subKey === undefined) continue;
    required.set(key, subKey ? { key, subKey } : { key });
  }

  return [...required.values()];
}

/** Sentinel shapes that pass `JSON.parse` but say nothing. */
const PLACEHOLDER_DESCRIPTION = /^(todo|tbd|n\/?a|placeholder|fixme|xxx+|description|lorem ipsum|\.\.\.|changeme)\.?$/i;

/* ═══════════════════════════════════════════════════════════════════════════
 * Tests
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('prompt_storage.example — JSON validity', () => {
  test('the template tree actually contains JSON files to check', () => {
    // Guards the loop below from passing vacuously if the path or the glob
    // ever stops matching anything.
    const files = exampleJsonFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('config/tool_descriptions.json');
    expect(files).toContain('persona/command_responses.json');
  });

  test('every JSON file in the template tree parses', () => {
    const failures: string[] = [];

    for (const file of exampleJsonFiles()) {
      const raw = readFileSync(join(EXAMPLE_DIR, file), 'utf-8');
      try {
        JSON.parse(raw);
      } catch (err) {
        failures.push(`${file}: ${(err as Error).message}`);
      }
    }

    // Reported together so one run lists every broken file instead of hiding
    // the second behind the first.
    expect(failures).toEqual([]);
  });
});

describe('prompt_storage.example — config/tool_descriptions.json', () => {
  test('the provider sources were found and yield tool names', () => {
    // If the extraction in `allRegisteredToolNames` ever silently stops
    // matching, the coverage test below would pass on an empty set.
    const { toolNames, declaringFiles } = allRegisteredToolNames();
    expect(declaringFiles.length).toBeGreaterThan(0);
    expect(toolNames.size).toBeGreaterThan(0);
  });

  test('has an entry for every tool name the bot can register', () => {
    const { toolNames } = allRegisteredToolNames();
    const descriptions = readExampleJson('config/tool_descriptions.json');
    const present = new Set(Object.keys(descriptions));

    const missing = [...toolNames].filter((name) => !present.has(name)).sort();

    expect(missing).toEqual([]);
  });

  test('covers every key getToolDescriptions() dereferences', () => {
    // This is the boot-crash invariant. The getter reads these without a
    // guard, so a missing key is a thrown TypeError, not a degraded feature.
    const descriptions = readExampleJson('config/tool_descriptions.json');
    const problems: string[] = [];

    for (const { key, subKey } of requiredToolDescriptionKeys()) {
      const entry = descriptions[key] as Record<string, unknown> | undefined;
      if (entry === undefined || entry === null || typeof entry !== 'object') {
        problems.push(`${key}: missing or not an object`);
        continue;
      }
      if (subKey !== undefined && entry[subKey] === undefined) {
        problems.push(`${key}.${subKey}: missing`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('every entry carries a real description, not a placeholder', () => {
    const descriptions = readExampleJson('config/tool_descriptions.json');
    const problems: string[] = [];

    for (const [key, raw] of Object.entries(descriptions)) {
      const entry = raw as Record<string, unknown> | undefined;

      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`${key}: entry is not an object`);
        continue;
      }

      // `description` is the field the prompt layer reads.
      const description = entry.description;
      if (typeof description !== 'string') {
        problems.push(`${key}: description is ${typeof description}, expected string`);
        continue;
      }

      const trimmed = description.trim();
      if (trimmed.length === 0) {
        problems.push(`${key}: description is empty`);
      } else if (trimmed.length < 20) {
        problems.push(`${key}: description is too short to be useful (${trimmed.length} chars)`);
      } else if (PLACEHOLDER_DESCRIPTION.test(trimmed)) {
        problems.push(`${key}: description is a placeholder`);
      } else if (/\bTODO\b|\bFIXME\b/.test(trimmed)) {
        problems.push(`${key}: description still contains a TODO marker`);
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('prompt_storage.example — persona/command_responses.json', () => {
  test('parses to an object with at least one key', () => {
    // `getCommandResponses()` catches the parse error and returns `{}`, so an
    // unparseable file here degrades silently: canned replies answer with
    // nothing and no error is ever logged.
    const responses = readExampleJson('persona/command_responses.json');

    expect(typeof responses).toBe('object');
    expect(Array.isArray(responses)).toBe(false);
    expect(Object.keys(responses).length).toBeGreaterThan(0);
  });

  test('every value is a non-empty string', () => {
    const responses = readExampleJson('persona/command_responses.json');
    const problems: string[] = [];

    for (const [key, value] of Object.entries(responses)) {
      if (typeof value !== 'string') {
        problems.push(`${key}: ${typeof value}, expected string`);
      } else if (value.trim().length === 0) {
        problems.push(`${key}: empty string`);
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('prompt_storage.example — simulated fresh install', () => {
  test('a fresh install seeded from the template does not throw when the bot reads tool descriptions', () => {
    const installRoot = mkdtempSync(join(tmpdir(), 'lumia-example-install-'));

    // Exactly the copy step the template's own README documents.
    cpSync(EXAMPLE_DIR, installRoot, { recursive: true });

    // A subprocess, because `PROMPT_STORAGE_DIR` is a module-load constant with
    // no env override and mocking it would leak into every other suite in this
    // process. `process.execPath` is the running Bun binary, so this does not
    // depend on `bun` being on PATH.
    const harnessPath = join(installRoot, 'fresh-install-probe.ts');
    writeFileSync(
      harnessPath,
      `
import { mock } from 'bun:test';
import { join } from 'node:path';

const REPO = ${JSON.stringify(REPO_ROOT)};
const INSTALL_ROOT = ${JSON.stringify(installRoot)};

// Same substitution a fresh operator performs: point the prompt root at the
// copied tree before prompts.ts is ever evaluated.
mock.module(join(REPO, 'src/utils/paths.ts'), () => ({
  REPO_ROOT: REPO,
  PROMPT_STORAGE_DIR: INSTALL_ROOT,
  DATA_DIR: INSTALL_ROOT,
  KNOWLEDGE_DOCUMENTS_DIR: join(REPO, 'knowledge_documents'),
  dbPath: (name: string) => join(INSTALL_ROOT, name),
}));

const prompts = await import(join(REPO, 'src/services/prompts.ts'));

// The call the template exists to satisfy.
const descriptions = prompts.getToolDescriptions();

// The other template file that fails silently when malformed.
const responses = prompts.getCommandResponses();

if (!descriptions.boredomPreference?.description) {
  throw new Error('boredomPreference.description came back empty');
}
if (Object.keys(responses).length === 0) {
  throw new Error('command responses degraded to {} — the file did not parse');
}

console.log('FRESH_INSTALL_OK ' + JSON.stringify({
  tools: Object.keys(descriptions).sort(),
  responses: Object.keys(responses).length,
}));
`,
      'utf-8',
    );

    const proc = Bun.spawnSync([process.execPath, 'run', harnessPath], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();

    // The failure mode is a crash, so a non-zero exit is the assertion; the
    // marker line then proves it was the real getter that ran, not an early
    // import error that happened to exit non-zero for another reason.
    expect(stderr).not.toContain('THREW');
    expect(stdout).toContain('FRESH_INSTALL_OK');
    expect(proc.exitCode).toBe(0);

    // Keep the temp tree out of the operator's temp dir between runs.
    try {
      rmSync(installRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }, 30_000);
});
