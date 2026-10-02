import { Database } from 'bun:sqlite';
import { intEnv } from '../../utils/env';
import { dbPath } from '../../utils/paths';
import type { ResponseRequestPayload } from './types';

export type OrchestratorTurnState =
  | 'received'
  | 'claimed'
  | 'generating'
  | 'generated'
  | 'discord_sent'
  | 'completion_sent'
  | 'acknowledged'
  | 'failed';

export interface OrchestratorTurnRecord {
  turnId: string;
  eventId: string;
  state: OrchestratorTurnState;
  instanceId?: string;
  payload?: ResponseRequestPayload;
  responseText?: string;
  responseMessageId?: string;
  lastError?: string;
  updatedAt: string;
  createdAt: string;
}

/** Outcome of one retention pass. Surfaced for logging/tests only. */
export interface TurnJournalSweepResult {
  /** Rows deleted because they fell outside the retention window. */
  deleted: number;
  /** Rows whose now-pointless `payload_json` blob was nulled. */
  strippedPayloads: number;
  /** ISO timestamp of the pass. */
  sweptAt: string;
}

export interface TurnJournalOptions {
  /** Days a turn record survives after its last update. Default 14. */
  retentionDays?: number;
  /** How often the retention pass runs. Default 6 hours. */
  sweepIntervalMs?: number;
  /**
   * Run the retention pass once immediately and then on an interval.
   * The singleton passes `true`; tests pass `false` so they can drive it.
   */
  autoStartRetention?: boolean;
}

interface TurnRow {
  turn_id: string;
  event_id: string;
  state: OrchestratorTurnState;
  instance_id: string | null;
  payload_json: string | null;
  response_text: string | null;
  response_message_id: string | null;
  last_error: string | null;
  updated_at: string;
  created_at: string;
}

/**
 * States in which `payload_json` is dead weight.
 *
 * Replay only ever needs `state`, `response_text` and `response_message_id`
 * (see the duplicate-suppression paths in `index.ts` and `bot/client.ts`), and
 * those are stored in their own columns. The payload embeds
 * `context.previousMessages` plus every `textAttachments` entry (up to 25 KB
 * each), so keeping it around after the turn is over is the single biggest
 * contributor to the size of this database.
 */
const PAYLOAD_DROPPING_STATES: ReadonlySet<OrchestratorTurnState> = new Set<OrchestratorTurnState>([
  'completion_sent',
  'acknowledged',
]);

/** `setInterval` returns a Timer in Bun and a Timeout in Node; both can unref. */
type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

export class OrchestratorTurnJournal {
  private db: Database;
  private readonly retentionDays: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: UnrefableTimer | null = null;
  private lastSweep: TurnJournalSweepResult | null = null;

  constructor(
    filename: string = dbPath('orchestrator_turns.db'),
    options: TurnJournalOptions = {},
  ) {
    // MUST go through `dbPath()`: a bare 'orchestrator_turns.db' is CWD-relative,
    // so starting the bot from a different directory silently created a brand
    // new empty journal and every duplicate-suppression lookup missed.
    this.db = new Database(filename);

    this.retentionDays = options.retentionDays
      ?? intEnv('ORCHESTRATOR_TURN_RETENTION_DAYS', 14, { min: 1, max: 3650 });
    this.sweepIntervalMs = options.sweepIntervalMs
      ?? intEnv('ORCHESTRATOR_TURN_SWEEP_INTERVAL_MINUTES', 360, { min: 1, max: 1440 }) * 60_000;

    this.init();

    if (options.autoStartRetention !== false) {
      this.startRetentionSweep();
    }
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orchestrator_turns (
        turn_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        state TEXT NOT NULL,
        instance_id TEXT,
        payload_json TEXT,
        response_text TEXT,
        response_message_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_orchestrator_turns_event_id ON orchestrator_turns(event_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_orchestrator_turns_state ON orchestrator_turns(state)');
    // Supports the retention sweep (`WHERE updated_at < ?` is a range scan on
    // this index instead of a full table scan that grows without bound).
    this.db.run('CREATE INDEX IF NOT EXISTS idx_orchestrator_turns_updated_at ON orchestrator_turns(updated_at)');
    // Supports the payload-stripping pass, which only looks at rows in a
    // terminal state that still carry a blob.
    this.db.run('CREATE INDEX IF NOT EXISTS idx_orchestrator_turns_state_payload ON orchestrator_turns(state, payload_json)');
  }

  private static readonly SELECT_COLUMNS = `turn_id, event_id, state, instance_id, payload_json, response_text,
              response_message_id, last_error, updated_at, created_at`;

  private static toRecord(row: TurnRow): OrchestratorTurnRecord {
    return {
      turnId: row.turn_id,
      eventId: row.event_id,
      state: row.state,
      instanceId: row.instance_id ?? undefined,
      payload: row.payload_json ? JSON.parse(row.payload_json) as ResponseRequestPayload : undefined,
      responseText: row.response_text ?? undefined,
      responseMessageId: row.response_message_id ?? undefined,
      lastError: row.last_error ?? undefined,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    };
  }

  getTurn(turnId: string): OrchestratorTurnRecord | undefined {
    const row = this.db.query(
      `SELECT ${OrchestratorTurnJournal.SELECT_COLUMNS}
       FROM orchestrator_turns
       WHERE turn_id = ?`
    ).get(turnId) as TurnRow | null;

    if (!row) {
      return undefined;
    }

    return OrchestratorTurnJournal.toRecord(row);
  }

  /**
   * Most recently updated record for an event id, or undefined.
   *
   * Used to detect a peer that pairs a known event id with an unrelated turn
   * id (turn ids are supposed to be stable per event), and vice versa.
   */
  getTurnByEventId(eventId: string): OrchestratorTurnRecord | undefined {
    const row = this.db.query(
      `SELECT ${OrchestratorTurnJournal.SELECT_COLUMNS}
       FROM orchestrator_turns
       WHERE event_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    ).get(eventId) as TurnRow | null;

    if (!row) {
      return undefined;
    }

    return OrchestratorTurnJournal.toRecord(row);
  }

  markReceived(payload: ResponseRequestPayload, instanceId: string): void {
    this.upsert(payload.turnId, payload.eventId, 'received', instanceId, payload);
  }

  markClaimed(turnId: string, eventId: string, instanceId: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'claimed', instanceId, payload);
  }

  markGenerating(turnId: string, eventId: string, instanceId: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'generating', instanceId, payload);
  }

  markGenerated(turnId: string, eventId: string, instanceId: string, responseText: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'generated', instanceId, payload, responseText);
  }

  markDiscordSent(turnId: string, eventId: string, instanceId: string, responseText: string, responseMessageId: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'discord_sent', instanceId, payload, responseText, responseMessageId);
  }

  markCompletionSent(turnId: string, eventId: string, instanceId: string, responseText: string, responseMessageId?: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'completion_sent', instanceId, payload, responseText, responseMessageId);
  }

  markAcknowledged(turnId: string): void {
    const existing = this.getTurn(turnId);
    if (!existing) {
      return;
    }

    this.upsert(
      turnId,
      existing.eventId,
      'acknowledged',
      existing.instanceId,
      existing.payload,
      existing.responseText,
      existing.responseMessageId,
      undefined
    );
  }

  markFailed(turnId: string, eventId: string, instanceId: string, error: string, payload?: ResponseRequestPayload): void {
    this.upsert(turnId, eventId, 'failed', instanceId, payload, undefined, undefined, error);
  }

  private upsert(
    turnId: string,
    eventId: string,
    state: OrchestratorTurnState,
    instanceId?: string,
    payload?: ResponseRequestPayload,
    responseText?: string,
    responseMessageId?: string,
    lastError?: string
  ): void {
    const existing = this.getTurn(turnId);
    const now = new Date().toISOString();

    // Terminal states drop the blob instead of re-storing it, so a late
    // duplicate delivery cannot resurrect ~20 KB per turn.
    let payloadJson: string | null = null;
    if (!PAYLOAD_DROPPING_STATES.has(state)) {
      const source = payload ?? existing?.payload;
      payloadJson = source ? JSON.stringify(source) : null;
    }

    this.db.run(
      `INSERT INTO orchestrator_turns (
         turn_id,
         event_id,
         state,
         instance_id,
         payload_json,
         response_text,
         response_message_id,
         last_error,
         updated_at,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET
         event_id = excluded.event_id,
         state = excluded.state,
         instance_id = excluded.instance_id,
         -- Terminal states drop the blob outright; everything else keeps the
         -- stored one when this call carries no payload of its own.
         payload_json = CASE
           WHEN excluded.state IN ('completion_sent', 'acknowledged') THEN NULL
           ELSE COALESCE(excluded.payload_json, orchestrator_turns.payload_json)
         END,
         response_text = COALESCE(excluded.response_text, orchestrator_turns.response_text),
         response_message_id = COALESCE(excluded.response_message_id, orchestrator_turns.response_message_id),
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        turnId,
        eventId,
        state,
        instanceId ?? existing?.instanceId ?? null,
        payloadJson,
        responseText ?? existing?.responseText ?? null,
        responseMessageId ?? existing?.responseMessageId ?? null,
        lastError ?? null,
        now,
        existing?.createdAt ?? now,
      ]
    );
  }

  /**
   * Delete rows older than the retention window and null out `payload_json`
   * on terminal rows.
   *
   * `updated_at` is an ISO-8601 UTC string, so lexical comparison is also
   * chronological comparison and the range scan uses
   * `idx_orchestrator_turns_updated_at`.
   */
  sweep(now: number = Date.now()): TurnJournalSweepResult {
    const cutoff = new Date(now - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const run = this.db.transaction((): TurnJournalSweepResult => {
      const deleted = this.db.run(
        'DELETE FROM orchestrator_turns WHERE updated_at < ?',
        [cutoff]
      ).changes;

      const strippedPayloads = this.db.run(
        `UPDATE orchestrator_turns
            SET payload_json = NULL
          WHERE payload_json IS NOT NULL
            AND state IN ('completion_sent', 'acknowledged')`
      ).changes;

      return { deleted, strippedPayloads, sweptAt: new Date(now).toISOString() };
    });

    this.lastSweep = run();
    return this.lastSweep;
  }

  /** Most recent sweep result, or null if no sweep has run yet. */
  getLastSweep(): TurnJournalSweepResult | null {
    return this.lastSweep;
  }

  /**
   * Run one sweep now and then on an interval. Idempotent: calling it while a
   * sweep is already scheduled only re-runs the immediate pass.
   */
  startRetentionSweep(): void {
    this.runSweepSafely();

    if (this.sweepTimer) {
      return;
    }

    const timer = setInterval(() => {
      this.runSweepSafely();
    }, this.sweepIntervalMs) as UnrefableTimer;

    // Must never be the reason the process stays alive.
    timer.unref?.();
    this.sweepTimer = timer;

    console.log(
      `[Orchestrator] Turn journal retention: sweeping every ${Math.round(this.sweepIntervalMs / 60000)}min, keeping ${this.retentionDays} day(s)`
    );
  }

  stopRetentionSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private runSweepSafely(): void {
    try {
      const result = this.sweep();
      if (result.deleted > 0 || result.strippedPayloads > 0) {
        console.log(
          `[Orchestrator] Turn journal sweep: removed ${result.deleted} row(s) older than ${this.retentionDays}d, stripped ${result.strippedPayloads} payload(s)`
        );
      }
    } catch (error) {
      // A retention pass failing must never take the bot down.
      console.error('[Orchestrator] Turn journal sweep failed:', error);
    }
  }
}

/**
 * The process-wide journal, created on first use.
 *
 * Deliberately lazy. The constructor opens `orchestrator_turns.db`, runs
 * `init()` and then `startRetentionSweep()`, which issues a `DELETE` and an
 * `UPDATE` against live rows. Constructing that at module load meant merely
 * *importing* this file mutated the database — which is a real hazard for
 * anything that imports the module without meaning to use the journal (the
 * test suite being the obvious case), and for any tool that only wants the
 * types. Now the side effects happen only when something actually asks for
 * the journal.
 */
let singleton: OrchestratorTurnJournal | null = null;

/**
 * The shared journal, constructing it on first call.
 *
 * Idempotent: every caller gets the same instance, so the retention sweep is
 * scheduled exactly once per process.
 */
export function getOrchestratorTurnJournal(): OrchestratorTurnJournal {
  if (singleton === null) {
    singleton = new OrchestratorTurnJournal();
  }
  return singleton;
}

/**
 * Backwards-compatible alias for {@link getOrchestratorTurnJournal}, kept
 * because the module is imported by name in several places.
 *
 * A forwarding proxy rather than a second instance, so no call site can
 * accidentally get a journal that was never initialised or swept. Every
 * property read — including method lookup — resolves against the real
 * singleton, so `orchestratorTurnJournal.markClaimed(...)` works unchanged.
 *
 * Prefer calling {@link getOrchestratorTurnJournal} explicitly in new code: it
 * says "this may open a database" at the call site, which a bare property
 * access does not.
 */
export const orchestratorTurnJournal: OrchestratorTurnJournal = new Proxy(
  {} as OrchestratorTurnJournal,
  {
    get(_target, property) {
      const instance = getOrchestratorTurnJournal() as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(instance, property, instance);
      // Bind methods to the real instance so `this` is the journal, not the
      // proxy. (TS `private` is compile-time only, but binding unconditionally
      // keeps this correct if a `#field` is ever introduced.)
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    set(_target, property, value) {
      const instance = getOrchestratorTurnJournal() as unknown as Record<PropertyKey, unknown>;
      return Reflect.set(instance, property, value);
    },
    has(_target, property) {
      return Reflect.has(getOrchestratorTurnJournal() as object, property);
    },
  },
);