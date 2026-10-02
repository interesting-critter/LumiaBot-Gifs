import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrchestratorTurnJournal } from '../orchestrator/turn-journal';
import type { TurnJournalOptions } from '../orchestrator/turn-journal';
import { validateOrchestratorUrl } from '../orchestrator';
import { LumiaBotIntegration } from '../orchestrator';
import type { ResponseRequestPayload } from '../orchestrator/types';

/**
 * The orchestrator turn journal is the only thing standing between a retried
 * `response_request` and a second LLM generation. These tests pin the two
 * properties that matter: replay still works, and the table does not grow
 * without bound.
 */

let workDir: string;
let dbPathInUse: string;

function makePayload(turnId: string, eventId: string): ResponseRequestPayload {
  return {
    turnId,
    eventId,
    botId: 'bot-1',
    context: {
      previousMessages: [],
      conversationId: 'conv-1',
      turnCount: 1,
      maxTurns: 5,
      isBanter: false,
    },
    timeoutAt: new Date(Date.now() + 60_000),
  };
}

function makeJournal(options: TurnJournalOptions = {}): OrchestratorTurnJournal {
  return new OrchestratorTurnJournal(dbPathInUse, { autoStartRetention: false, ...options });
}



beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'orch-journal-'));
  dbPathInUse = join(workDir, 'turns.db');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('turn journal replay', () => {
  test('terminal turn replays its response text without regenerating', () => {
    const journal = makeJournal();
    const payload = makePayload('turn-1', 'event-1');

    journal.markReceived(payload, 'instance-1');
    journal.markCompletionSent('turn-1', 'event-1', 'instance-1', 'the answer', 'msg-42');

    const replayed = journal.getTurn('turn-1');
    expect(replayed?.state).toBe('completion_sent');
    // This is exactly what index.ts and bot/client.ts read on a duplicate
    // delivery. If it regresses, a retry re-runs the LLM.
    expect(replayed?.responseText).toBe('the answer');
    expect(replayed?.responseMessageId).toBe('msg-42');
  });

  test('payload_json is dropped once the turn reaches a terminal state', () => {
    const journal = makeJournal();
    const payload = makePayload('turn-2', 'event-2');
    payload.eventSnapshot = {
      eventId: 'event-2',
      messageId: '999',
      channelId: 'c1',
      guildId: 'g1',
      authorId: 'u1',
      authorName: 'someone',
      content: 'a'.repeat(25_000),
      mentionedBotIds: ['bot-1'],
      timestamp: new Date(),
    };

    journal.markReceived(payload, 'instance-1');
    expect(journal.getTurn('turn-2')?.payload).toBeDefined();

    journal.markCompletionSent('turn-2', 'event-2', 'instance-1', 'done');

    // The blob was the bulk of the row; replay does not need it.
    expect(journal.getTurn('turn-2')?.payload).toBeUndefined();
    expect(journal.getTurn('turn-2')?.responseText).toBe('done');
  });

  test('acknowledging a terminal turn does not resurrect the payload', () => {
    const journal = makeJournal();
    journal.markReceived(makePayload('turn-3', 'event-3'), 'instance-1');
    journal.markCompletionSent('turn-3', 'event-3', 'instance-1', 'done');
    journal.markAcknowledged('turn-3');

    expect(journal.getTurn('turn-3')?.state).toBe('acknowledged');
    expect(journal.getTurn('turn-3')?.payload).toBeUndefined();
  });

  test('a non-terminal state still keeps the payload for replay', () => {
    const journal = makeJournal();
    journal.markReceived(makePayload('turn-4', 'event-4'), 'instance-1');

    expect(journal.getTurn('turn-4')?.payload?.turnId).toBe('turn-4');
  });
});

describe('getTurnByEventId', () => {
  test('finds the turn recorded for an event', () => {
    const journal = makeJournal();
    journal.markReceived(makePayload('turn-5', 'event-5'), 'instance-1');

    expect(journal.getTurnByEventId('event-5')?.turnId).toBe('turn-5');
  });

  test('returns undefined for an unknown event', () => {
    const journal = makeJournal();
    expect(journal.getTurnByEventId('never-seen')).toBeUndefined();
  });
});

describe('retention sweep', () => {
  test('deletes rows older than the retention window', () => {
    const journal = makeJournal({ retentionDays: 14 });
    const now = Date.UTC(2026, 0, 31);

    journal.markReceived(makePayload('old', 'event-old'), 'instance-1');
    journal.markReceived(makePayload('fresh', 'event-fresh'), 'instance-1');

    // Backdate one row by rewriting updated_at directly.
    const raw = new Database(dbPathInUse);
    raw.run('UPDATE orchestrator_turns SET updated_at = ? WHERE turn_id = ?', [
      new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      'old',
    ]);
    raw.close();

    const result = journal.sweep(now);

    expect(result.deleted).toBe(1);
    expect(journal.getTurn('old')).toBeUndefined();
    expect(journal.getTurn('fresh')).toBeDefined();
  });

  test('a row inside the window survives', () => {
    const journal = makeJournal({ retentionDays: 30 });
    const now = Date.UTC(2026, 0, 31);
    journal.markReceived(makePayload('recent', 'event-recent'), 'instance-1');

    const raw = new Database(dbPathInUse);
    raw.run('UPDATE orchestrator_turns SET updated_at = ? WHERE turn_id = ?', [
      new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      'recent',
    ]);
    raw.close();

    expect(journal.sweep(now).deleted).toBe(0);
    expect(journal.getTurn('recent')).toBeDefined();
  });

  test('strips payloads from rows already sitting in a terminal state', () => {
    // Rows written before the retention pass existed: `completion_sent` is not
    // reachable without passing through markCompletionSent, so backdate one
    // into that state directly to model legacy data.
    const journal = makeJournal({ retentionDays: 3650 });
    const now = Date.UTC(2026, 0, 31);

    journal.markReceived(makePayload('done', 'event-done'), 'instance-1');
    journal.markDiscordSent('done', 'event-done', 'instance-1', 'text', 'm1');

    const raw = new Database(dbPathInUse);
    raw.run('UPDATE orchestrator_turns SET state = ? WHERE turn_id = ?', ['completion_sent', 'done']);
    raw.close();

    expect(journal.getTurn('done')?.payload).toBeDefined();

    const result = journal.sweep(now);

    expect(result.strippedPayloads).toBe(1);
    expect(result.deleted).toBe(0);
    expect(journal.getTurn('done')?.payload).toBeUndefined();
    // Replay still works after the blob is gone.
    expect(journal.getTurn('done')?.responseText).toBe('text');
    expect(journal.getTurn('done')?.responseMessageId).toBe('m1');
  });

  test('does not strip payloads from in-flight turns', () => {
    const journal = makeJournal();
    journal.markGenerating('busy', 'event-busy', 'instance-1', makePayload('busy', 'event-busy'));

    const result = journal.sweep();

    expect(result.strippedPayloads).toBe(0);
    expect(journal.getTurn('busy')?.payload).toBeDefined();
  });

  test('exposes the last sweep result', () => {
    const journal = makeJournal();
    expect(journal.getLastSweep()).toBeNull();

    journal.sweep();

    expect(journal.getLastSweep()?.sweptAt).toBeString();
  });
});

describe('validateOrchestratorUrl', () => {
  const KEY = 'ORCHESTRATOR_ALLOW_INSECURE';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  test('accepts wss', () => {
    const verdict = validateOrchestratorUrl('wss://orch.example.com', 'secret');
    expect(verdict.ok).toBe(true);
    expect(verdict.url).toBe('wss://orch.example.com');
  });

  test('upgrades https to wss', () => {
    const verdict = validateOrchestratorUrl('https://orch.example.com', 'secret');
    expect(verdict.ok).toBe(true);
    expect(verdict.url).toBe('wss://orch.example.com');
  });

  test('accepts cleartext on loopback without any opt-in', () => {
    // This is the default ORCHESTRATOR_URL, so refusing it would break local
    // development outright.
    expect(validateOrchestratorUrl('ws://localhost:3000', 'secret').ok).toBe(true);
    expect(validateOrchestratorUrl('ws://127.0.0.1:3000', 'secret').ok).toBe(true);
    expect(validateOrchestratorUrl('ws://127.5.5.5:3000', 'secret').ok).toBe(true);
    expect(validateOrchestratorUrl('ws://[::1]:3000', 'secret').ok).toBe(true);
  });

  test('refuses cleartext to a non-loopback host', () => {
    const verdict = validateOrchestratorUrl('ws://192.168.1.50:3000', 'secret');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('ORCHESTRATOR_ALLOW_INSECURE');
  });

  test('accepts cleartext to a non-loopback host with the explicit opt-in', () => {
    process.env[KEY] = 'true';
    expect(validateOrchestratorUrl('ws://192.168.1.50:3000', 'secret').ok).toBe(true);
  });

  test('a bogus opt-in value does not unlock cleartext', () => {
    // `boolEnv` returns the fallback for unparseable input, so a typo fails
    // closed rather than silently enabling cleartext.
    process.env[KEY] = 'ture';
    expect(validateOrchestratorUrl('ws://192.168.1.50:3000', 'secret').ok).toBe(false);
  });

  test('refuses schemes other than ws/wss', () => {
    expect(validateOrchestratorUrl('ftp://orch.example.com', 'secret').ok).toBe(false);
  });

  test('refuses an unparseable URL', () => {
    expect(validateOrchestratorUrl('not a url', 'secret').ok).toBe(false);
  });

  test('a missing API key is reported but does not block a wss connection', () => {
    // Refusing outright would break anyone running a keyless local setup over
    // TLS; the orchestrator gets to reject it, with a loud warning first.
    expect(validateOrchestratorUrl('wss://orch.example.com', '').ok).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// Interval lifetime
// ---------------------------------------------------------------------------

/**
 * Every interval this class starts is retained so it can be cleared, and every
 * one of them is also `unref`'d.
 *
 * Retaining without `unref` is the half that is easy to get wrong: `clearInterval`
 * only runs on a path the bot actually reaches, while a `ref`'d timer holds the
 * event loop open no matter what. The stale sweep had it; the heartbeat (30s)
 * and the lease renewal (2-5s, one per in-flight turn) did not, so a bot that
 * had shut everything down still could not exit on its own — on a phone that
 * means the OS SIGKILLs it and the turn journal is never flushed.
 *
 * Asserted by intercepting `setInterval` rather than by reading the source, so
 * the property that matters is the observed one.
 */
type IntervalRecord = { ms: number; unrefCalls: number; clearCalls: number };

function withIntervalSpy<T>(body: (calls: IntervalRecord[]) => T): T {
  const calls: IntervalRecord[] = [];
  const original = globalThis.setInterval;

  globalThis.setInterval = ((handler: (...args: unknown[]) => void, ms?: number) => {
    const record: IntervalRecord = { ms: ms ?? 0, unrefCalls: 0, clearCalls: 0 };
    calls.push(record);

    const fake = {
      unref: () => { record.unrefCalls += 1; return fake; },
      ref: () => fake,
      hasRef: () => false,
      refresh: () => fake,
      clear: () => { record.clearCalls += 1; },
      [Symbol.toPrimitive]: () => ms ?? 0,
    };

    // Never invoked: the stub interval body is a no-op timer handle, and these
    // tests never let the clock advance.
    void handler;
    return fake as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof globalThis.setInterval;

  try {
    return body(calls);
  } finally {
    globalThis.setInterval = original;
  }
}

function makeBot() {
  return new LumiaBotIntegration({
    orchestratorUrl: 'wss://orchestrator.example.com',
    apiKey: 'secret',
    botId: 'bot-1',
    botName: 'Tester',
    token: 'token',
    guilds: [],
  });
}

describe('orchestrator intervals are unref\'d', () => {
  test('the stale sweep started by the constructor is unref\'d', () => {
    withIntervalSpy((calls) => {
      const bot = makeBot();
      expect(calls.length).toBe(1);
      expect(calls[0]?.unrefCalls).toBe(1);
      // Guards the assertion above: if the constructor ever starts a second
      // timer, the index no longer refers to the stale sweep and the test
      // would pass for the wrong reason.
      expect(calls[0]?.ms).toBe(60_000);
      bot.disconnect();
    });
  });

  test('the heartbeat interval is unref\'d', () => {
    withIntervalSpy((calls) => {
      const bot = makeBot();
      calls.length = 0;

      (bot as unknown as { startHeartbeat: () => void }).startHeartbeat();

      expect(calls.length).toBe(1);
      expect(calls[0]?.unrefCalls).toBe(1);
      expect(calls[0]?.ms).toBe(30_000);
    });
  });

  test('each lease-renewal interval is unref\'d', () => {
    withIntervalSpy((calls) => {
      const bot = makeBot();
      calls.length = 0;

      const start = (bot as unknown as {
        startLeaseRenewal: (p: ResponseRequestPayload) => void;
      }).startLeaseRenewal.bind(bot);

      const payload = makePayload('turn-a', 'event-a');
      payload.leaseId = 'lease-a';
      // Half of this lands between the documented 2s floor and 5s ceiling.
      payload.leaseExpiresAt = new Date(Date.now() + 9_000);

      start(payload);
      start({ ...payload, turnId: 'turn-b', eventId: 'event-b', leaseId: 'lease-b' });

      // One per turn, and neither is holding the process open.
      expect(calls.length).toBe(2);
      for (const call of calls) expect(call.unrefCalls).toBe(1);
    });
  });

  test('a payload with no lease does not start a timer at all', () => {
    withIntervalSpy((calls) => {
      const bot = makeBot();
      calls.length = 0;

      const payload = makePayload('turn-c', 'event-c');
      payload.leaseId = undefined;
      (bot as unknown as { startLeaseRenewal: (p: ResponseRequestPayload) => void }).startLeaseRenewal(payload);

      expect(calls.length).toBe(0);
    });
  });
});
