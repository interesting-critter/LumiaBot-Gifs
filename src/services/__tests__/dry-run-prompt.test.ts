import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as pathsNamespace from '../../utils/paths';
import { config } from '../../utils/config';
import { reloadPrompts } from '../prompts';
import { formatDiscordResponseText } from '../../utils/discord-markdown';

/**
 * `/dryrun` — provider-level guarantees.
 *
 * The feature's whole claim is "the ENTIRE pipeline ran and NO model request was
 * made". Both halves are load-bearing and neither is visible in the code that
 * implements it, so both are pinned here:
 *
 *  - **No request.** `generateWithRetry` is the only thing in either provider
 *    that can reach the network, and it is reached from several places (the
 *    no-tools branch, the tool loop, the streaming path). Asserting on "the
 *    happy path did not call the SDK" would not catch a dry run that fell
 *    through to the tool loop, so the request function itself is replaced with
 *    one that records the call and fails — every path into the network is
 *    covered by construction.
 *
 *  - **POST-rewrite.** The prompt-rewrite hook runs *after* the normal
 *    `onFullPrompt` capture, deliberately, so dashboard logs of real turns keep
 *    the names the channel actually used. A dry run inverts that on purpose: its
 *    whole purpose is to answer "what would actually have been sent", and
 *    rewrites are a feature now, so someone debugging one needs the rewritten
 *    form. This is asserted against a real `config/rewrites.json`, not a stub,
 *    because the whole risk is in the ordering of two real calls.
 *
 * NOTHING HERE MAKES A NETWORK CALL. The provider client is replaced wholesale
 * before any turn runs, and the assertion is that its replacement was never
 * entered.
 */

/**
 * Plain snapshot of the paths namespace, taken before anything is mocked.
 *
 * `mock.module` writes through to the namespace it replaces, so `import *`
 * would hand back the mocked value later on — hence the spread, which detaches.
 * Same pattern (and same reason) as `prompt-profiles.test.ts`.
 */
const actualPaths = { ...pathsNamespace };

/**
 * A throwaway prompt root holding ONLY `config/rewrites.json`.
 *
 * Nothing else is in it, so every persona/guideline lookup misses and the system
 * prompt degrades to whatever the hardcoded blocks in `buildSystemPrompt`
 * produce. That is deliberate: the assertions here are about payload SHAPE and
 * ordering, not about persona content, and a fixture that depended on the
 * checked-in example tree would break whenever that tree is edited.
 */
const promptRoot = mkdtempSync(join(tmpdir(), 'lumia-dryrun-prompts-'));

/** The name the tests speak to the bot as, and the name the rewrite maps it to. */
const USERNAME = 'DryrunOperator';
const CANONICAL = 'Critter';

/** Written into the fixture's `config/rewrites.json`. */
const REWRITES = {
  rewrites: [{ match: USERNAME, replace: CANONICAL }],
};

function writeFixture(relativePath: string, contents: string): void {
  const full = join(promptRoot, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf-8');
}

writeFixture('config/rewrites.json', JSON.stringify(REWRITES, null, 2));

// `openai.ts` constructs its exported singleton at module load, and the SDK
// throws when the key is blank. Mutate the already-evaluated config object
// rather than the env, so this works no matter which test file loaded config
// first in the shared process — same approach (and same reason) as
// `llm-output.test.ts`.
config.openai.apiKey = config.openai.apiKey || 'test-key-not-used';
config.gemini.apiKey = config.gemini.apiKey || 'test-key-not-used';

// Redirect prompt reads at the fixture BEFORE either provider is imported, so
// the `prompts` module both of them capture is the redirected one. A
// `mock.module` is permanent for the process, so the real path is restored in
// `afterAll` below rather than left pointing at a deleted temp directory.
mock.module('../../utils/paths', () => ({ ...actualPaths, PROMPT_STORAGE_DIR: promptRoot }));

const { OpenAIService } = await import('../openai');
const { GoogleGenAIService } = await import('../google-genai');

type OpenAIServiceShape = {
  client: unknown;
  createChatCompletion: (options: Record<string, unknown>) => Promise<string>;
  streamChatCompletion: (options: Record<string, unknown>) => AsyncGenerator<string>;
};
type GoogleGenAIServiceShape = {
  client: unknown;
  createChatCompletion: (options: Record<string, unknown>) => Promise<string>;
  streamChatCompletion: (options: Record<string, unknown>) => AsyncGenerator<string>;
};

/** Every outbound call the providers can make, and how many times each fired. */
interface RequestSpy {
  calls: number;
  openaiCreate: number;
  geminiGenerate: number;
  geminiStream: number;
}

/**
 * Replace a provider's SDK client with recorders.
 *
 * The recorder THROWS rather than returning a canned response. A stub that
 * returned success would let a test pass on a dry run that did reach the model
 * and simply got a polite answer back; a throw turns "the network was touched"
 * into an unmistakable failure while still recording the count.
 */
function installSpyClient(service: { client: unknown }, kind: 'openai' | 'gemini'): RequestSpy {
  const spy: RequestSpy = { calls: 0, openaiCreate: 0, geminiGenerate: 0, geminiStream: 0 };

  const record = (which: keyof RequestSpy): never => {
    spy.calls += 1;
    spy[which] += 1;
    throw new Error(`A DRY RUN REACHED THE NETWORK (${which})`);
  };

  if (kind === 'openai') {
    service.client = {
      chat: {
        completions: {
          create: () => record('openaiCreate'),
        },
      },
    };
  } else {
    service.client = {
      models: {
        generateContent: () => record('geminiGenerate'),
        generateContentStream: () => record('geminiStream'),
      },
    };
  }

  return spy;
}

function newOpenAI(): OpenAIServiceShape {
  return new OpenAIService({ apiKey: 'test-key-not-used' }) as unknown as OpenAIServiceShape;
}

function newGoogle(): GoogleGenAIServiceShape {
  return new GoogleGenAIService({ apiKey: 'test-key-not-used' }) as unknown as GoogleGenAIServiceShape;
}

/** One user turn, enough for `convertMessages` to produce a non-empty payload. */
const MESSAGES = [{ role: 'user' as const, content: 'hello there, what does my prompt look like?' }];

beforeAll(() => {
  // Drops the already-populated `promptCache` so the fixture's rewrites.json is
  // actually read, rather than a cached "file not found" left by an earlier
  // test file in this shared process.
  reloadPrompts();
});

afterAll(() => {
  // Put the real prompt root back, then delete the fixture. See the note on
  // `mock.module` permanence in `prompt-profiles.test.ts`.
  mock.module('../../utils/paths', () => ({ ...actualPaths }));
  reloadPrompts();
  rmSync(promptRoot, { recursive: true, force: true });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OpenAI provider
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('openai.ts — a dry run never reaches the network', () => {
  test('the SDK request function is never entered, and the payload comes back instead', async () => {
    const service = newOpenAI();
    const spy = installSpyClient(service, 'openai');

    let captured = '';
    const rendered = await service.createChatCompletion({
      messages: MESSAGES,
      userId: '111222333444555666',
      username: USERNAME,
      guildId: '999888777666555444',
      dryRun: true,
      onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
    });

    // The recorder throws when entered, so reaching this line already proves a
    // lot; the counter makes the intent explicit and readable when it fails.
    expect(spy.calls).toBe(0);
    expect(spy.openaiCreate).toBe(0);
    expect(rendered.length).toBeGreaterThan(0);
    // The returned string IS the payload — the caller gets something to show.
    expect(captured.length).toBeGreaterThan(0);
    expect(rendered).toBe(captured);
  });

  test('the captured prompt is the POST-rewrite form', async () => {
    const service = newOpenAI();
    installSpyClient(service, 'openai');

    let captured = '';
    await service.createChatCompletion({
      messages: MESSAGES,
      userId: '111222333444555666',
      username: USERNAME,
      guildId: '999888777666555444',
      dryRun: true,
      onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
    });

    // The rewrite rule maps the operator's name onto `Critter`. A dry run must
    // show what the MODEL would see, so only the rewritten form is acceptable —
    // and its presence proves the capture happens after the hook rather than
    // reusing the pre-rewrite one.
    expect(captured).toContain(CANONICAL);
    expect(captured).not.toContain(USERNAME);
  });

  test('a NON-dry run still captures the PRE-rewrite form (the control)', async () => {
    // Without this, the test above would also pass if the capture were simply
    // always post-rewrite — which would quietly change what every real turn's
    // dashboard entry shows.
    const service = newOpenAI();
    installSpyClient(service, 'openai');

    let captured = '';
    await service
      .createChatCompletion({
        messages: MESSAGES,
        userId: '111222333444555666',
        username: USERNAME,
        guildId: '999888777666555444',
        onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
      })
      // The spy client throws, which is the expected outcome: the point of this
      // case is only which text the CAPTURE produced before the send.
      .catch(() => undefined);

    expect(captured).toContain(USERNAME);
    expect(captured).not.toContain(CANONICAL);
  });

  test('the streaming path refuses a dry run rather than silently sending it', async () => {
    // A generator cannot return a value. Yielding the payload as if it were
    // model output would be undetectable by the caller, so the honest options
    // are "throw" or "lie", and it throws.
    const service = newOpenAI();
    const spy = installSpyClient(service, 'openai');

    const iterate = async (): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.streamChatCompletion({
        messages: MESSAGES,
        dryRun: true,
      })) {
        // Any chunk at all would mean the payload was dressed up as output.
        throw new Error('streamChatCompletion yielded for a dry run');
      }
    };

    await expect(iterate()).rejects.toThrow(/does not support dryRun/);
    expect(spy.calls).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Google GenAI provider
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('google-genai.ts — a dry run never reaches the network', () => {
  test('generateContent is never entered, and the payload comes back instead', async () => {
    const service = newGoogle();
    const spy = installSpyClient(service, 'gemini');

    let captured = '';
    const rendered = await service.createChatCompletion({
      messages: MESSAGES,
      userId: '111222333444555666',
      username: USERNAME,
      guildId: '999888777666555444',
      dryRun: true,
      onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
    });

    expect(spy.calls).toBe(0);
    expect(spy.geminiGenerate).toBe(0);
    expect(spy.geminiStream).toBe(0);
    expect(captured.length).toBeGreaterThan(0);
    expect(rendered).toBe(captured);
  });

  test('the captured prompt is the POST-rewrite form', async () => {
    const service = newGoogle();
    installSpyClient(service, 'gemini');

    let captured = '';
    await service.createChatCompletion({
      messages: MESSAGES,
      userId: '111222333444555666',
      username: USERNAME,
      guildId: '999888777666555444',
      dryRun: true,
      onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
    });

    // Gemini splits the payload in two — persona as `systemInstruction`, turns as
    // `contents` — and rewrites both, so the assertion covers the turn here and
    // the system half in the next case.
    expect(captured).toContain(CANONICAL);
    expect(captured).not.toContain(USERNAME);
  });

  test('a NON-dry run still captures the PRE-rewrite form (the control)', async () => {
    const service = newGoogle();
    installSpyClient(service, 'gemini');

    let captured = '';
    await service
      .createChatCompletion({
        messages: MESSAGES,
        userId: '111222333444555666',
        username: USERNAME,
        guildId: '999888777666555444',
        onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
      })
      .catch(() => undefined);

    expect(captured).toContain(USERNAME);
    expect(captured).not.toContain(CANONICAL);
  });

  test('the streaming path refuses a dry run rather than silently sending it', async () => {
    const service = newGoogle();
    const spy = installSpyClient(service, 'gemini');

    const iterate = async (): Promise<void> => {
      for await (const _chunk of service.streamChatCompletion({
        messages: MESSAGES,
        dryRun: true,
      })) {
        throw new Error('streamChatCompletion yielded for a dry run');
      }
    };

    await expect(iterate()).rejects.toThrow(/does not support dryRun/);
    expect(spy.calls).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Why the captured payload must not be post-processed as if it were output
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('the captured prompt survives the output filters intact', () => {
  /**
   * A payload the filters WOULD damage.
   *
   * Not a contrived string: `<gif>` and `[REACT: …]` both appear in the real
   * assembled system prompt, because that prompt is where the bot documents how
   * to use those tags. `formatDiscordResponseText` strips both on their way to
   * Discord, so running it over a prompt under inspection deletes the
   * documentation of the very feature being debugged — silently, and in a way
   * that still looks like a valid prompt.
   */
  const PROMPT_WITH_TAGS = [
    '[system]',
    'Reply with [REACT: emoji] to react to the message.',
    'Use <gif>cute cat</gif> when a GIF fits.',
    '',
    '[user]',
    'hello there',
  ].join('\n');

  test('the output filter really would strip both tags (so the test below is meaningful)', () => {
    const filtered = formatDiscordResponseText(PROMPT_WITH_TAGS);
    expect(filtered).not.toContain('[REACT: emoji]');
    expect(filtered).not.toContain('<gif>cute cat</gif>');
  });

  test('a dry run hands the payload over with its [REACT: ...] tags intact', async () => {
    const service = newOpenAI();
    installSpyClient(service, 'openai');

    let captured = '';
    await service.createChatCompletion({
      messages: MESSAGES,
      userId: '111222333444555666',
      username: USERNAME,
      guildId: '999888777666555444',
      dryRun: true,
      onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
    });

    // The `[REACT: emoji]` documentation lives in a hardcoded block of
    // `buildSystemPrompt`, so it is present in every assembled prompt no matter
    // which persona files exist on disk. Its survival is the proof that the
    // payload went out unfiltered: `formatDiscordResponseText` deletes exactly
    // this text, and the test above shows it doing so.
    expect(captured).toContain('[REACT:');
    expect(formatDiscordResponseText(captured)).not.toContain('[REACT:');
  });

  test('the returned payload is byte-identical to the captured one', async () => {
    // The strongest available form of "nothing touched it": the string the
    // caller receives and the string the dashboard stores are the same text.
    const service = newOpenAI();
    installSpyClient(service, 'openai');

    let captured = '';
    const rendered = await service.createChatCompletion({
      messages: MESSAGES,
      userId: '111222333444555666',
      username: USERNAME,
      guildId: '999888777666555444',
      dryRun: true,
      onFullPrompt: (fullPrompt: string) => { captured = fullPrompt; },
    });

    expect(rendered).toBe(captured);
  });

  test('the handler returns the payload on its own field, never as postable text', async () => {
    // The structural half of D4, asserted where the decision is encoded: the
    // prompt is a separate response field precisely so no caller can treat it as
    // Discord-ready text by accident.
    const source = await Bun.file(
      join(actualPaths.REPO_ROOT, 'src', 'services', 'message-handler.ts'),
    ).text();

    expect(source).toContain('dryRunPrompt?: string;');
    // The dry-run return block must come BEFORE the gif/reaction extraction.
    const dryRunReturn = source.indexOf('if (isDryRun) {');
    const gifExtraction = source.indexOf('gifService.extractAndResolveGif(response)');
    expect(dryRunReturn).toBeGreaterThan(-1);
    expect(gifExtraction).toBeGreaterThan(-1);
    expect(dryRunReturn).toBeLessThan(gifExtraction);
  });
});
