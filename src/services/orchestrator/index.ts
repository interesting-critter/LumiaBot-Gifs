import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type {
  MessageContext,
  ObservedOrchestratorEvent,
  OrchestratorConnectionState,
  WebSocketMessage,
  BotRegistrationPayload,
  HeartbeatPayload,
  MentionPayload,
  ResponseCompletePayload,
  ResponseRequestPayload,
  FollowUpRequestPayload,
  FollowUpAckPayload,
  TurnClaimPayload,
  TurnLeaseRenewedPayload,
  ErrorPayload,
  LumiaBotConfig,
  ResponseHandler,
  TypingCallback,
  CollectiveKnowledgeQueryPayload,
  CollectiveKnowledgeLookupRequestPayload,
  CollectiveKnowledgeLookupResponsePayload,
  CollectiveKnowledgeResultPayload,
  CollectiveKnowledgeCandidate,
} from './types';
import { orchestratorTurnJournal } from './turn-journal';
import { boolEnv } from '../../utils/env';

/** Set `ORCHESTRATOR_ALLOW_INSECURE=true` to permit a cleartext `ws://` peer. */
const ALLOW_INSECURE_ENV = 'ORCHESTRATOR_ALLOW_INSECURE';

/**
 * Coarse lifecycle of the outbound socket.
 *
 *   disconnected ──connect()──▶ connecting ──'open'──▶ connected
 *        ▲                           │                    │
 *        │                     timeout/'error'            'close'
 *        │                           ▼                    ▼
 *        └──── disconnect() ────────┴────── disconnected ◀─┴──▶ backoff
 *                                                              │
 *                                                   timer fires│
 *                                                              ▼
 *                                                         connecting
 *
 * Only `close` and the connect timeout leave `connecting`, and only `close`
 * schedules a reconnect: `ws` always emits `close` after `error`, so scheduling
 * from `error` as well would double-book the retry.
 */
type ConnectionState = OrchestratorConnectionState;

/** Verdict from {@link LumiaBotIntegration.authorizeTurn}. */
type TurnAuthorizationVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/** Connection attempt budget and delays. */
const CONNECTION_TIMEOUT_MS = 10000;
const STALE_SWEEP_INTERVAL_MS = 60_000;
const STALE_SWEEP_THRESHOLD_MS = 10 * 60 * 1000;
const MENTION_RETRY_INTERVAL_MS = 5000;
/** Matches the 5-minute stale-entry sweep in `bot/client.ts`. */
const MAX_MENTION_RETRY_ATTEMPTS = 60;

/** Outcome of the pre-flight URL check performed before any socket is created. */
interface UrlValidationVerdict {
  ok: boolean;
  /** Normalised `ws://`/`wss://` URL. Only meaningful when `ok`. */
  url: string;
  /** Why the connection was refused. Only meaningful when `!ok`. */
  reason: string;
}

/**
 * Decide whether the configured orchestrator URL may be dialled at all.
 *
 * The shared `X-API-Key` is sent in a header on every reconnect, so a cleartext
 * `ws://` hop hands the secret to anyone on-path (shared LAN, phone hotspot).
 * The default `ORCHESTRATOR_URL` is `ws://localhost:3000` and `config.ts` does
 * `.replace(/^http/, 'ws')`, so cleartext is what you get by default — which is
 * fine on loopback and a credential disclosure anywhere else.
 *
 * `ORCHESTRATOR_ALLOW_INSECURE=true` is the explicit opt-in for a non-loopback
 * cleartext peer (a tunnel, a sidecar on a trusted bridge). It is read here
 * rather than through `config.ts` so this check cannot be weakened by accident.
 */
export function validateOrchestratorUrl(configuredUrl: string, apiKey: string): UrlValidationVerdict {
  const url = configuredUrl.replace(/^http/, 'ws');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, reason: `ORCHESTRATOR_URL is not a valid URL: ${configuredUrl}` };
  }

  if (parsed.protocol === 'wss:') {
    if (!apiKey) {
      console.warn(
        '[Orchestrator] ⚠️ ORCHESTRATOR_API_KEY is empty - the orchestrator will see this ' +
        'connection as unauthenticated and should reject it'
      );
    }
    return { ok: true, url, reason: '' };
  }

  if (parsed.protocol !== 'ws:') {
    return { ok: false, url, reason: `Unsupported scheme ${parsed.protocol} - expected wss://` };
  }

  if (isLoopbackHostname(parsed.hostname)) {
    // Cleartext, but it never leaves the machine.
    return { ok: true, url, reason: '' };
  }

  if (boolEnv(ALLOW_INSECURE_ENV, false)) {
    console.warn(
      '\n' +
      '  ┌─────────────────────────────────────────────────────────────────┐\n' +
      '  │ ⚠️  INSECURE ORCHESTRATOR CONNECTION                            │\n' +
      `  │ Target: ${url}`.padEnd(66) + '│\n' +
      '  │ The shared API key is sent as a plain header on every reconnect. │\n' +
      '  │ Anyone on this network can read it and impersonate this bot.    │\n' +
      `  │ Opted in via ${ALLOW_INSECURE_ENV}=true — unset it to enforce TLS.`.padEnd(66) + '│\n' +
      '  └─────────────────────────────────────────────────────────────────┘\n'
    );
    return { ok: true, url, reason: '' };
  }

  return {
    ok: false,
    url,
    reason:
      `Refusing to send the orchestrator API key in cleartext to non-loopback host "${parsed.hostname}". ` +
      `Use wss://, or set ${ALLOW_INSECURE_ENV}=true to accept the risk.`,
  };
}

/** Hosts where a cleartext `ws://` hop stays on this machine. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  // RFC 6761 reserves every *.localhost name for the loopback interface.
  if (host.endsWith('.localhost')) return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export class LumiaBotIntegration {
  private ws: WebSocket | null = null;
  private config: Required<LumiaBotConfig>;
  private instanceId: string;
  private isConnected: boolean = false;
  /**
   * Lifecycle of the outbound socket. `isConnected` is kept in lockstep with
   * `connected` because `shouldUseOrchestrator()` in `bot/client.ts` gates on it.
   */
  private connectionState: ConnectionState = 'disconnected';
  /**
   * Set by `disconnect()`. `close` is emitted asynchronously, so without this
   * flag the intentional `ws.close()` in `disconnect()` looks like an
   * unexpected drop to `handleDisconnect()` and schedules a reconnect 5s later —
   * resurrecting the socket after `bot.destroy()`.
   */
  private disconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Handle for the in-memory stale sweep; kept so `disconnect()` can stop it. */
  private staleSweepInterval: ReturnType<typeof setInterval> | null = null;
  private responseHandler: ResponseHandler | null = null;
  private pendingResponse: ((response: string) => void) | null = null;
  private pendingGuildUpdate: string[] | null = null;
  private guildUpdateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private onConnectCallback: (() => void) | null = null;
  private responseReadyCallback: ((eventId: string, response: string) => void) | null = null;
  private typingCallback: TypingCallback | null = null;
  private pendingFollowUps: Map<string, { eventId: string; resolve: (result: FollowUpAckPayload) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();
  private pendingCollectiveKnowledgeQueries: Map<string, { resolve: (result: CollectiveKnowledgeResultPayload) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();
  private completedFollowUps: Map<string, { payload: FollowUpAckPayload; completedAt: number }> = new Map();
  private responseMessageIds: Map<string, string> = new Map(); // turnId -> Discord message ID
  private leaseRenewalTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private inFlightTurns: Set<string> = new Set();
  private completedTurns: Map<string, { eventId: string; responseContent: string; responseMessageId?: string; completedAt: number }> = new Map();
  /**
   * Guilds this bot has told the orchestrator about. Seeded from config and
   * refreshed on every connect/guild-change. A `response_request` naming a
   * guild outside this set is refused, so a peer cannot aim replies at servers
   * the operator never enrolled the bot in.
   */
  private knownGuilds: Set<string>;
  /**
   * Event ids this bot actually emitted a `mention` for. A `response_request`
   * for an unknown event id is refused before any LLM work starts — without
   * this, an authenticated-but-unverified peer could name arbitrary turn ids
   * and bill unlimited generations.
   */
  private observedEvents: Map<string, ObservedOrchestratorEvent>;
  /**
   * Mentions waiting for a live socket, oldest first, retried like
   * `pendingGuildUpdate`. A FIFO rather than a single slot: two messages
   * arriving while disconnected are two events the orchestrator has to hear
   * about, and a single slot would silently drop the first.
   */
  private mentionQueue: (Omit<MentionPayload, 'mentionedBotIds'> & { mentionedBotIds?: string[] })[] = [];
  private mentionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private mentionRetryAttempts: number = 0;
  private collectiveKnowledgeHandler: ((payload: CollectiveKnowledgeLookupRequestPayload) => Promise<CollectiveKnowledgeCandidate[]>) | null = null;

  constructor(config: LumiaBotConfig) {
    this.config = {
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 10,
      metadata: {},
      instanceId: config.instanceId || randomUUID(),
      ...config,
    };
    this.instanceId = this.config.instanceId;
    this.knownGuilds = new Set(this.config.guilds);
    this.observedEvents = new Map();

    this.startStaleSweep();
  }

  /**
   * Expire in-memory entries that nothing will ever look up again.
   *
   * `unref`'d so this interval is never the reason the process stays alive, and
   * the handle is kept so `disconnect()` can stop it (it used to be registered
   * anonymously at construction with no way to cancel it).
   */
  private startStaleSweep(): void {
    if (this.staleSweepInterval) {
      return;
    }

    const timer = setInterval(() => {
      const staleThreshold = Date.now() - STALE_SWEEP_THRESHOLD_MS;

      for (const [turnId, completed] of this.completedTurns.entries()) {
        if (completed.completedAt < staleThreshold) {
          this.completedTurns.delete(turnId);
        }
      }

      for (const [turnId, completed] of this.completedFollowUps.entries()) {
        if (completed.completedAt < staleThreshold) {
          this.completedFollowUps.delete(turnId);
        }
      }

      for (const [eventId, observed] of this.observedEvents.entries()) {
        if (observed.observedAt < staleThreshold) {
          this.observedEvents.delete(eventId);
        }
      }
    }, STALE_SWEEP_INTERVAL_MS);

    (timer as { unref?: () => void }).unref?.();
    this.staleSweepInterval = timer;
  }

  private stopStaleSweep(): void {
    if (this.staleSweepInterval) {
      clearInterval(this.staleSweepInterval);
      this.staleSweepInterval = null;
    }
  }

  connect(): Promise<void> {
    if (this.isConnected) {
      console.log('[Orchestrator] Already connected');
      return Promise.resolve();
    }

    const urlCheck = validateOrchestratorUrl(this.config.orchestratorUrl, this.config.apiKey);
    if (!urlCheck.ok) {
      const error = new Error(urlCheck.reason);
      this.connectionState = 'disconnected';
      return Promise.reject(error);
    }

    // A new explicit connect() attempt clears the shutdown intent: whatever
    // `disconnect()` parked is being replaced on purpose.
    this.disconnecting = false;
    this.connectionState = 'connecting';

    // `disconnect()` stopped the stale sweep; a reconnecting instance needs it
    // back or the dedup maps grow for the life of the process.
    this.startStaleSweep();

    console.log(`[Orchestrator] Connecting to ${urlCheck.url}`);

    return new Promise<void>((resolve, reject) => {
      // Handlers close over this exact socket, not `this.ws`. Dereferencing
      // `this.ws` after assigning it meant a concurrent `disconnect()` (which
      // nulls the field) turned every handler into a TypeError.
      let ws: WebSocket;
      try {
        ws = new WebSocket(urlCheck.url, {
          headers: {
            'X-API-Key': this.config.apiKey,
          },
        });
      } catch (error) {
        this.connectionState = 'disconnected';
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      this.ws = ws;

      // `settled` gates rejection: once the promise settles, a late 'error'
      // must not surface as an unhandled rejection AND (more importantly) the
      // 10s timer below must not fire after a successful open.
      let settled = false;

      const clearConnectionTimer = (): void => {
        clearTimeout(connectionTimer);
      };

      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        clearConnectionTimer();
        resolve();
      };

      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearConnectionTimer();
        reject(error);
      };

      // A handshake that has not produced 'open' within the budget gets torn
      // down. `terminate()` forces the 'close' event, so the normal
      // disconnect/backoff path still runs and the attempt is retried.
      const connectionTimer = setTimeout(() => {
        settleReject(new Error('Connection timeout'));
        console.error('[Orchestrator] Connection timed out after 10s');
        try {
          ws.terminate();
        } catch {
          // Already gone.
        }
      }, CONNECTION_TIMEOUT_MS);

      ws.on('open', () => {
        if (this.ws !== ws) {
          // A newer socket (or a disconnect) took over while this handshake was
          // in flight. Report failure rather than resolving: `isConnected`
          // belongs to the other socket, and resolving would make
          // `bot/client.ts` log a success it did not get.
          settleReject(new Error('Connection superseded by a newer socket'));
          return;
        }

        // The 10s timer must be cleared here, not left to fire against an
        // already-open socket.
        clearConnectionTimer();

        console.log('[Orchestrator] Connected successfully');
        this.isConnected = true;
        this.connectionState = 'connected';
        this.reconnectAttempts = 0;
        this.mentionRetryAttempts = 0;
        this.register();
        this.startHeartbeat();

        // Call onConnect callback if set
        if (this.onConnectCallback) {
          console.log('[Orchestrator] Calling onConnect callback');
          this.onConnectCallback();
        }

        // Flush mentions that were queued while the socket was down, rather than
        // making them wait out the 5s retry tick.
        this.flushMentionQueue();

        settleResolve();
      });

      ws.on('message', (data: Buffer) => {
        if (this.ws !== ws) return;
        try {
          const message: WebSocketMessage = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('[Orchestrator] Failed to parse message:', error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        clearConnectionTimer();

        if (this.ws !== ws) {
          // Either `disconnect()` already cleared the field, or a newer socket
          // took over. Either way this socket's state is not ours to change —
          // but a caller still awaiting this connect() must be told it failed.
          settleReject(new Error(`Connection closed before it opened: ${code} - ${reason.toString()}`));
          return;
        }

        console.log(`[Orchestrator] Connection closed: ${code} - ${reason.toString()}`);
        this.ws = null;

        if (!settled) {
          // Closed before 'open': the caller is still waiting on connect().
          settleReject(new Error(`Connection closed before it opened: ${code} - ${reason.toString()}`));
        }

        // 'close' is the single source of reconnection, not 'error'.
        this.handleDisconnect();
      });

      ws.on('error', (error: Error) => {
        console.error('[Orchestrator] WebSocket error:', error);
        clearConnectionTimer();

        if (this.ws === ws) {
          this.connectionState = 'disconnected';
        }

        // Only reject while the connect promise is still pending. After a
        // successful open the promise is settled, so this used to be swallowed
        // silently: the socket died but `isConnected` stayed true and nothing
        // reconnected. `ws` always follows 'error' with 'close', and the close
        // handler owns the reconnect, so there is nothing else to do here.
        settleReject(error);
      });
    });
  }

  disconnect(): void {
    console.log('[Orchestrator] Disconnecting...');

    // Arm this BEFORE closing: 'close' fires asynchronously, and the handler
    // would otherwise treat the intentional close as an unexpected drop.
    this.disconnecting = true;
    this.connectionState = 'disconnected';

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.mentionRetryTimer) {
      clearTimeout(this.mentionRetryTimer);
      this.mentionRetryTimer = null;
    }
    // A queued mention refers to a `bot/client.ts` queue entry that is about to
    // be swept as stale; delivering it later would resurrect a dead turn.
    this.mentionQueue = [];
    this.mentionRetryAttempts = 0;

    this.stopStaleSweep();

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch (error) {
        console.error('[Orchestrator] Error while closing socket:', error);
      }
    }

    for (const timer of this.leaseRenewalTimers.values()) {
      clearInterval(timer);
    }
    this.leaseRenewalTimers.clear();

    for (const pending of this.pendingCollectiveKnowledgeQueries.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingCollectiveKnowledgeQueries.clear();

    this.isConnected = false;
    this.reconnectAttempts = 0;
  }

  setResponseHandler(handler: ResponseHandler): void {
    this.responseHandler = handler;
  }

  setOnConnect(callback: () => void): void {
    this.onConnectCallback = callback;
  }

  updateGuilds(guilds: string[]): void {
    // Store guilds for retry if not connected
    this.pendingGuildUpdate = guilds;
    this.refreshKnownGuilds(guilds);

    if (!this.isConnected || !this.ws) {
      console.log(`[Orchestrator] Guild update queued (${guilds.length} guilds) - not connected yet`);
      this.scheduleGuildUpdateRetry();
      return;
    }

    this.sendGuildUpdate(guilds);
  }

  private sendGuildUpdate(guilds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[Orchestrator] Cannot send guild update - WebSocket not open');
      this.scheduleGuildUpdateRetry();
      return;
    }

    const payload: HeartbeatPayload = {
      botId: this.config.botId,
      timestamp: new Date(),
      instanceId: this.instanceId,
      guilds,
      status: 'online',
    };

    this.sendMessage({
      type: 'heartbeat',
      payload,
    });

    console.log(`[Orchestrator] Sent guild update: ${guilds.length} guilds`);
    this.pendingGuildUpdate = null;
    
    if (this.guildUpdateRetryTimer) {
      clearTimeout(this.guildUpdateRetryTimer);
      this.guildUpdateRetryTimer = null;
    }
  }

  private scheduleGuildUpdateRetry(): void {
    if (this.guildUpdateRetryTimer) {
      return; // Already scheduled
    }

    this.guildUpdateRetryTimer = setTimeout(() => {
      this.guildUpdateRetryTimer = null;
      if (this.pendingGuildUpdate && this.isConnected) {
        console.log('[Orchestrator] Retrying pending guild update...');
        this.sendGuildUpdate(this.pendingGuildUpdate);
      } else if (this.pendingGuildUpdate) {
        this.scheduleGuildUpdateRetry();
      }
    }, 5000);
  }

  private refreshKnownGuilds(guilds: string[]): void {
    const next = new Set(guilds.filter((id) => typeof id === 'string' && id.length > 0));
    if (next.size === 0) {
      // Never treat an empty refresh as "the bot is in no guilds" — that would
      // make every legitimate response_request look out-of-scope.
      return;
    }

    // 'dm' is the placeholder `bot/client.ts` sends for guild-less channels, not
    // a real guild id, so it is always in scope. DM turns are still pinned to
    // the channel their mention came from by the check in `authorizeTurn`.
    next.add('dm');
    this.knownGuilds = next;
  }

  notifyMention(payload: Omit<MentionPayload, 'mentionedBotIds'> & { mentionedBotIds?: string[] }): void {
    // Record the event as one this bot observed, so the matching
    // `response_request` later passes the origin check. Must happen even when
    // the socket is down, otherwise the queued mention could never be answered.
    this.observedEvents.set(payload.eventId, {
      eventId: payload.eventId,
      guildId: payload.guildId,
      channelId: payload.channelId,
      observedAt: Date.now(),
    });

    if (!this.isConnected || !this.ws) {
      // Previously dropped on the floor: the mention sat in
      // `bot/client.ts`'s orchestratorQueue until the 5-minute sweep deleted it,
      // and the user got neither a reply nor an error. Queue and retry instead.
      console.log(`[Orchestrator] Mention for event ${payload.eventId} queued - not connected yet`);
      this.mentionQueue.push(payload);
      this.scheduleMentionRetry();
      return;
    }

    this.sendMention(payload);
  }

  private sendMention(payload: Omit<MentionPayload, 'mentionedBotIds'> & { mentionedBotIds?: string[] }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[Orchestrator] Cannot send mention - WebSocket not open');
      this.mentionQueue.push(payload);
      this.scheduleMentionRetry();
      return;
    }

    const fullPayload: MentionPayload = {
      ...payload,
      mentionedBotIds: payload.mentionedBotIds || [this.config.botId],
    };

    this.sendMessage({
      type: 'mention',
      payload: fullPayload,
    });

    this.mentionQueue = this.mentionQueue.filter((queued) => queued.eventId !== payload.eventId);
    this.mentionRetryAttempts = 0;

    if (this.mentionQueue.length === 0 && this.mentionRetryTimer) {
      clearTimeout(this.mentionRetryTimer);
      this.mentionRetryTimer = null;
    }
  }

  /** Drain every queued mention, oldest first. Called once the socket is open. */
  private flushMentionQueue(): void {
    while (this.mentionQueue.length > 0 && this.isConnected && this.ws) {
      const next = this.mentionQueue[0];
      if (!next) break;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
      console.log(`[Orchestrator] Flushing queued mention ${next.eventId}`);
      this.sendMention(next);
    }
  }

  private scheduleMentionRetry(): void {
    if (this.mentionRetryTimer) {
      return; // Already scheduled
    }

    if (this.mentionQueue.length === 0) {
      return;
    }

    if (this.mentionRetryAttempts >= MAX_MENTION_RETRY_ATTEMPTS) {
      // Give up rather than retry forever: the caller's queue entry is swept at
      // the same 5-minute mark, so there is nothing left to deliver to.
      console.warn(`[Orchestrator] Dropping ${this.mentionQueue.length} queued mention(s) after ${this.mentionRetryAttempts} retry attempts`);
      this.mentionQueue = [];
      this.mentionRetryAttempts = 0;
      return;
    }

    this.mentionRetryTimer = setTimeout(() => {
      this.mentionRetryTimer = null;
      if (this.mentionQueue.length === 0) {
        return;
      }

      if (this.isConnected && this.ws) {
        this.mentionRetryAttempts++;
        this.flushMentionQueue();
      } else if (!this.disconnecting) {
        this.scheduleMentionRetry();
      }
    }, MENTION_RETRY_INTERVAL_MS);
  }

  private register(): void {
    if (!this.ws) return;

    const payload: BotRegistrationPayload = {
      botId: this.config.botId,
      name: this.config.botName,
      token: this.config.token,
      instanceId: this.instanceId,
      // `bot/client.ts` constructs this with `guilds: []` and fills them in later
      // via updateGuilds/forceGuildUpdate, so prefer what we have actually seen.
      guilds: this.config.guilds.length > 0 ? this.config.guilds : Array.from(this.knownGuilds),
      metadata: this.config.metadata,
    };

    this.sendMessage({
      type: 'register',
      payload,
    });

    console.log(`[Orchestrator] Registering bot: ${this.config.botName} (${this.config.botId})`);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (!this.isConnected || !this.ws) return;

      const payload: HeartbeatPayload = {
        botId: this.config.botId,
        timestamp: new Date(),
        instanceId: this.instanceId,
        status: 'online',
      };

      this.sendMessage({
        type: 'heartbeat',
        payload,
      });
    }, 30000);

    // Not a reason to keep the process alive. The handle is still retained so
    // `disconnect()` can clear it, but a 30s interval that is `ref`'d will
    // hold the event loop open after everything else has shut down, which on
    // a phone means the OS has to SIGKILL the bot and the turn journal never
    // gets flushed. Matches the stale sweep's handling.
    (this.heartbeatInterval as { unref?: () => void }).unref?.();
  }

  private handleMessage(message: WebSocketMessage): void {
    switch (message.type) {
      case 'register_ack':
        console.log('[Orchestrator] Registration acknowledged');
        // Send any pending guild update now that we're registered
        if (this.pendingGuildUpdate) {
          console.log('[Orchestrator] Sending pending guild update after registration');
          this.sendGuildUpdate(this.pendingGuildUpdate);
        }
        break;
      case 'heartbeat_ack':
        break;
      case 'mention':
        // This is a mention event from another bot - we need to coordinate
        // This is handled by the client calling notifyMention, not received here
        break;
      case 'mention_ack':
        // Acknowledgement that our mention was received
        console.log(`[Orchestrator] Mention acknowledged: ${(message.payload as any).eventId}`);
        break;
      case 'response_request':
        // Fire-and-forget; `.catch` is mandatory because a rejection here would
        // otherwise be an unhandled promise rejection.
        void this.handleResponseRequest(message.payload as ResponseRequestPayload).catch((error) => {
          console.error('[Orchestrator] response_request handler crashed:', error);
        });
        break;
      case 'response_complete':
        // We receive this when another bot completes their response
        console.log('[Orchestrator] Response complete notification received');
        break;
      case 'response_ack':
        // Acknowledgement that our response was received
        this.handleResponseAck(message.payload as { turnId: string; status: string; nextBotId?: string });
        break;
      case 'follow_up_ack':
        this.handleFollowUpAck(message.payload as FollowUpAckPayload);
        break;
      case 'banter_invite':
        console.log('[Orchestrator] Received banter invite');
        break;
      case 'collective_knowledge_request':
        // The internal try/catch covers the handler only — the trailing
        // `sendMessage` and the payload construction were unguarded.
        void this.handleCollectiveKnowledgeRequest(message.payload as CollectiveKnowledgeLookupRequestPayload)
          .catch((error) => {
            console.error('[Orchestrator] Collective knowledge request handling failed:', error);
          });
        break;
      case 'collective_knowledge_result':
        this.handleCollectiveKnowledgeResult(message.payload as CollectiveKnowledgeResultPayload);
        break;
      case 'error':
        console.error('[Orchestrator] Error:', (message.payload as ErrorPayload).message);
        break;
      default:
        console.warn(`[Orchestrator] Unknown message type: ${(message as any).type}`);
    }
  }

  private async handleResponseRequest(payload: ResponseRequestPayload): Promise<void> {
    // Untrusted-input checks run BEFORE anything that costs money or touches
    // Discord, and before the duplicate-suppression replays below (those write
    // to the journal and emit frames on behalf of a turn we did not author).
    const verdict = this.authorizeTurn(payload);
    if (!verdict.ok) {
      console.warn(`[Orchestrator] Rejected response_request for turn ${payload.turnId}, event ${payload.eventId}: ${verdict.reason}`);
      this.rejectTurn(payload, verdict.reason);
      return;
    }

    console.log(`[Orchestrator] Received response request for turn ${payload.turnId}, event: ${payload.eventId}`, {
      channelId: payload.channelId,
      guildId: payload.guildId,
      hasContext: !!payload.context,
      previousMessages: payload.context?.previousMessages?.length || 0,
      timeoutAt: payload.timeoutAt,
      alreadyInFlight: this.inFlightTurns.has(payload.turnId),
      alreadyCompleted: this.completedTurns.has(payload.turnId),
    });

    const completedTurn = this.completedTurns.get(payload.turnId);
    if (completedTurn) {
      console.warn(`[Orchestrator] Duplicate response_request for completed turn ${payload.turnId} - replaying cached completion`);
      this.sendResponseComplete(payload.turnId, completedTurn.responseContent, completedTurn.responseMessageId);
      return;
    }

    if (this.inFlightTurns.has(payload.turnId)) {
      console.warn(`[Orchestrator] Duplicate response_request for in-flight turn ${payload.turnId} - ignoring replay`);
      return;
    }

    const timeoutAt = new Date(payload.timeoutAt).getTime();
    if (!Number.isNaN(timeoutAt) && timeoutAt < Date.now()) {
      console.warn(`[Orchestrator] Ignoring stale response_request for turn ${payload.turnId} - timeout already elapsed`);
      this.sendResponseComplete(payload.turnId, '');
      return;
    }

    if (!this.responseHandler) {
      console.warn('[Orchestrator] No response handler set');
      this.sendResponseComplete(payload.turnId, '');
      return;
    }

    // ALWAYS start typing indicator if channel/guild info is available
    if (this.typingCallback && payload.channelId && payload.guildId) {
      console.log(`⌨️ [Orchestrator] STARTING typing indicator for channel ${payload.channelId}`);
      this.typingCallback(payload.channelId, payload.guildId, true);
    } else {
      console.warn(`[Orchestrator] Cannot start typing - missing info:`, {
        hasTypingCallback: !!this.typingCallback,
        hasChannelId: !!payload.channelId,
        hasGuildId: !!payload.guildId,
      });
    }

    this.inFlightTurns.add(payload.turnId);

    try {
      console.log(`[Orchestrator] Calling response handler with eventId ${payload.eventId}, turnId ${payload.turnId}...`);
      
      // Call the response handler to generate the response
      const replayableTurn = orchestratorTurnJournal.getTurn(payload.turnId);
      if (replayableTurn?.state === 'completion_sent' || replayableTurn?.state === 'acknowledged' || replayableTurn?.state === 'discord_sent') {
        console.warn(`[Orchestrator] Duplicate response_request for persisted turn ${payload.turnId} - replaying journaled completion`);
        if (this.typingCallback && payload.channelId && payload.guildId) {
          this.typingCallback(payload.channelId, payload.guildId, false);
        }
        this.sendResponseComplete(
          payload.turnId,
          replayableTurn.responseText || '',
          replayableTurn.responseMessageId,
          payload,
        );
        return;
      }

      orchestratorTurnJournal.markReceived(payload, this.instanceId);
      orchestratorTurnJournal.markClaimed(payload.turnId, payload.eventId, this.instanceId, payload);
      this.sendTurnClaimed(payload);
      this.startLeaseRenewal(payload);

      const response = await this.responseHandler(payload);
      
      console.log(`[Orchestrator] Response handler completed, got response of ${response.length} chars`);
      
      // ALWAYS stop typing indicator
      if (this.typingCallback && payload.channelId && payload.guildId) {
        console.log(`⌨️ [Orchestrator] STOPPING typing indicator for channel ${payload.channelId}`);
        this.typingCallback(payload.channelId, payload.guildId, false);
      }
      
      // Retrieve the Discord message ID set by client.ts after sending to Discord.
      // The delete lives in `finally` below, not here: this block used to be the
      // only place it ran, so a throw anywhere below leaked one map entry per
      // failed turn, forever.
      const discordMessageId = this.responseMessageIds.get(payload.turnId);

      const journalTurn = orchestratorTurnJournal.getTurn(payload.turnId);
      const resolvedResponse = journalTurn?.responseText ?? response;
      const resolvedMessageId = journalTurn?.responseMessageId ?? discordMessageId;

      this.completedTurns.set(payload.turnId, {
        eventId: payload.eventId,
        responseContent: resolvedResponse,
        responseMessageId: resolvedMessageId,
        completedAt: Date.now(),
      });

      // Send the response back to the orchestrator
      this.sendResponseComplete(payload.turnId, resolvedResponse, resolvedMessageId, payload);

      // Notify client that response is ready
      if (this.responseReadyCallback) {
        console.log(`[Orchestrator] Notifying client that response is ready for event ${payload.eventId}`);
        this.responseReadyCallback(payload.eventId, resolvedResponse);
      }
    } catch (error) {
      console.error('[Orchestrator] Response handler failed:', error);
      orchestratorTurnJournal.markFailed(
        payload.turnId,
        payload.eventId,
        this.instanceId,
        error instanceof Error ? error.message : String(error),
        payload,
      );
      
      // ALWAYS stop typing indicator on error
      if (this.typingCallback && payload.channelId && payload.guildId) {
        console.log(`⌨️ [Orchestrator] STOPPING typing indicator (error) for channel ${payload.channelId}`);
        this.typingCallback(payload.channelId, payload.guildId, false);
      }
      
      this.sendResponseComplete(payload.turnId, '');
      
      // Notify with empty response to prevent hanging
      if (this.responseReadyCallback) {
        this.responseReadyCallback(payload.eventId, '');
      }
    } finally {
      this.stopLeaseRenewal(payload.turnId);
      this.inFlightTurns.delete(payload.turnId);
      // Runs on the error path too, so a failed turn leaks nothing.
      this.responseMessageIds.delete(payload.turnId);
    }
  }

  /**
   * Decide whether an inbound `response_request` may be acted on.
   *
   * The channel is authenticated with a shared `X-API-Key`, which proves the
   * peer holds the secret but says nothing about which turns it may ask for.
   * Without this check, any peer with the key could name an arbitrary turn id
   * and force an LLM generation (direct cost) or aim the reply at a channel the
   * operator never enrolled the bot in.
   *
   * Order matters: cheap identity checks first, then the duplicate/replay
   * exemptions, then the more expensive journal cross-check.
   */
  private authorizeTurn(payload: ResponseRequestPayload): TurnAuthorizationVerdict {
    // Shape check first — everything below dereferences these fields.
    if (!payload || typeof payload.turnId !== 'string' || payload.turnId.length === 0) {
      return { ok: false, reason: 'missing or malformed turnId' };
    }
    if (typeof payload.eventId !== 'string' || payload.eventId.length === 0) {
      return { ok: false, reason: 'missing or malformed eventId' };
    }

    // The request must name this bot. A peer may legitimately forward turns, but
    // it must address them to us.
    if (payload.botId && payload.botId !== this.config.botId) {
      return { ok: false, reason: `request addressed to bot ${payload.botId}, not ${this.config.botId}` };
    }

    const observed = this.observedEvents.get(payload.eventId);
    const journalTurn = orchestratorTurnJournal.getTurn(payload.turnId);

    // Duplicate deliveries of a turn we already handled are legitimate: the
    // orchestrator retries until it sees the ack. Exempt them from the
    // "did we originate this?" requirement so retries keep working.
    const isKnownTurn = this.completedTurns.has(payload.turnId)
      || this.inFlightTurns.has(payload.turnId)
      || journalTurn !== undefined;

    if (!observed && !isKnownTurn) {
      return {
        ok: false,
        reason: `event ${payload.eventId} was never observed by this bot (no matching mention was sent)`,
      };
    }

    // Channel/guild pinning. For an observed event the mention payload is
    // authoritative — `bot/client.ts` built it from a real Discord message — so
    // the turn must name the same guild and channel the mention did. A peer that
    // knows a valid event id still cannot redirect the reply somewhere else.
    // For a turn with no observed event, fall back to the announced guild list.
    // Skipped while `knownGuilds` is empty (before the first guild sync) so a
    // cold start does not reject everything.
    if (observed) {
      if (payload.guildId && observed.guildId && payload.guildId !== observed.guildId) {
        return {
          ok: false,
          reason: `turn names guild ${payload.guildId} but event ${payload.eventId} was observed in ${observed.guildId}`,
        };
      }
      if (payload.channelId && observed.channelId && payload.channelId !== observed.channelId) {
        return {
          ok: false,
          reason: `turn names channel ${payload.channelId} but event ${payload.eventId} was observed in ${observed.channelId}`,
        };
      }
    } else if (payload.guildId && this.knownGuilds.size > 0 && !this.knownGuilds.has(payload.guildId)) {
      return { ok: false, reason: `guild ${payload.guildId} is not one this bot announced` };
    }

    // Cross-check against the journal: if we have a record for this turn it must
    // be the same event, otherwise a peer is replaying one event's turn id
    // under another event id to slip past the check above.
    if (journalTurn && journalTurn.eventId !== payload.eventId) {
      return {
        ok: false,
        reason: `turn ${payload.turnId} is journaled under event ${journalTurn.eventId}, not ${payload.eventId}`,
      };
    }

    // If the event id is already journaled under a different turn, that pairing
    // is bogus too.
    const eventTurn = orchestratorTurnJournal.getTurnByEventId(payload.eventId);
    if (eventTurn && eventTurn.turnId !== payload.turnId && !observed) {
      return {
        ok: false,
        reason: `event ${payload.eventId} is journaled under turn ${eventTurn.turnId}, not ${payload.turnId}`,
      };
    }

    return { ok: true };
  }

  /**
   * Refuse a turn with an error frame rather than an empty completion.
   *
   * An empty `response_complete` would be indistinguishable from "the bot had
   * nothing to say", which reads as a legitimate answer. An `error` frame with a
   * specific code lets the orchestrator tell a refusal from a shrug.
   *
   * Deliberately NOT done here:
   *  - no journal write: this turn is not ours to record.
   *  - no lease renewal: renewing a lease we refused to work would keep the turn
   *    pinned to this bot until it expires, delaying the real responder.
   */
  private rejectTurn(payload: ResponseRequestPayload, reason: string): void {
    this.sendMessage({
      type: 'error',
      payload: {
        code: 'TURN_NOT_AUTHORIZED',
        message: `Refusing response_request for turn ${payload.turnId}: ${reason}`,
        details: {
          turnId: payload.turnId,
          eventId: payload.eventId,
          botId: this.config.botId,
          instanceId: this.instanceId,
          rejectedAt: new Date().toISOString(),
        },
      } satisfies ErrorPayload,
    });
  }

  setResponseReadyCallback(callback: (eventId: string, response: string) => void): void {
    this.responseReadyCallback = callback;
  }

  setTypingCallback(callback: TypingCallback): void {
    this.typingCallback = callback;
  }

  setCollectiveKnowledgeHandler(handler: (payload: CollectiveKnowledgeLookupRequestPayload) => Promise<CollectiveKnowledgeCandidate[]>): void {
    this.collectiveKnowledgeHandler = handler;
  }

  setResponseMessageId(turnId: string, messageId: string): void {
    this.responseMessageIds.set(turnId, messageId);
  }

  requestCollectiveKnowledge(eventId: string, turnId: string, query: string, maxResults: number = 5, guildId?: string): Promise<CollectiveKnowledgeResultPayload> {
    return new Promise((resolve) => {
      const queryId = randomUUID();

      if (!this.isConnected || !this.ws) {
        resolve({
          queryId,
          eventId,
          turnId,
          botId: this.config.botId,
          query,
          results: [],
          queriedBotIds: [],
          respondedBotIds: [],
        });
        return;
      }

      const payload: CollectiveKnowledgeQueryPayload = {
        queryId,
        eventId,
        turnId,
        botId: this.config.botId,
        query,
        maxResults,
        guildId,
      };

      const timeout = setTimeout(() => {
        this.pendingCollectiveKnowledgeQueries.delete(queryId);
        resolve({
          queryId,
          eventId,
          turnId,
          botId: this.config.botId,
          query,
          results: [],
          queriedBotIds: [],
          respondedBotIds: [],
        });
      }, 10000);

      this.pendingCollectiveKnowledgeQueries.set(queryId, { resolve, timeout });
      this.sendMessage({
        type: 'collective_knowledge_query',
        payload,
      });

      console.log(`[Orchestrator] Sent collective knowledge query ${queryId} for turn ${turnId}`, {
        eventId,
        query,
        maxResults,
      });
    });
  }

  private async handleCollectiveKnowledgeRequest(payload: CollectiveKnowledgeLookupRequestPayload): Promise<void> {
    let results: CollectiveKnowledgeCandidate[] = [];

    if (this.collectiveKnowledgeHandler) {
      try {
        results = await this.collectiveKnowledgeHandler(payload);
      } catch (error) {
        console.error('[Orchestrator] Collective knowledge handler failed:', error);
      }
    }

    const responsePayload: CollectiveKnowledgeLookupResponsePayload = {
      queryId: payload.queryId,
      eventId: payload.eventId,
      turnId: payload.turnId,
      botId: this.config.botId,
      botName: this.config.botName,
      results,
    };

    this.sendMessage({
      type: 'collective_knowledge_response',
      payload: responsePayload,
    });
  }

  private handleCollectiveKnowledgeResult(payload: CollectiveKnowledgeResultPayload): void {
    const pending = this.pendingCollectiveKnowledgeQueries.get(payload.queryId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCollectiveKnowledgeQueries.delete(payload.queryId);
    pending.resolve(payload);
  }

  private sendResponseComplete(turnId: string, responseContent: string, responseMessageId?: string, requestPayload?: ResponseRequestPayload): void {
    const completionPayload: ResponseCompletePayload = {
      turnId,
      botId: this.config.botId,
      responseContent,
      responseMessageId,
    };

    this.sendMessage({
      type: 'response_complete',
      payload: completionPayload,
    });

    const eventId = requestPayload?.eventId || this.completedTurns.get(turnId)?.eventId;
    if (eventId) {
      orchestratorTurnJournal.markCompletionSent(turnId, eventId, this.instanceId, responseContent, responseMessageId, requestPayload);
    }
  }

  /**
   * Request a follow-up turn from the orchestrator.
   * Returns a promise that resolves with the ack payload (approved/denied).
   * Called by the LLM tool execution when the model wants to reply to another bot.
   */
  requestFollowUp(eventId: string, turnId: string, targetBotId?: string, reason?: string): Promise<FollowUpAckPayload> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.ws) {
        resolve({
          eventId,
          botId: this.config.botId,
          approved: false,
          reason: 'not_connected',
        });
        return;
      }

      const completed = this.completedFollowUps.get(turnId)?.payload;
      if (completed) {
        console.log(`[Orchestrator] Reusing completed follow-up request for turn ${turnId}: ${completed.reason}`);
        resolve(completed);
        return;
      }

      const pending = this.pendingFollowUps.get(turnId);
      if (pending) {
        console.log(`[Orchestrator] Follow-up request already pending for turn ${turnId}, waiting for existing ack`);
        const originalResolve = pending.resolve;
        pending.resolve = (result) => {
          originalResolve(result);
          resolve(result);
        };
        return;
      }

      const payload: FollowUpRequestPayload = {
        eventId,
        turnId,
        botId: this.config.botId,
        targetBotId,
        reason,
      };

      // Set up a timeout to avoid hanging forever
      const timeout = setTimeout(() => {
        this.pendingFollowUps.delete(turnId);
        const timeoutPayload: FollowUpAckPayload = {
          eventId,
          botId: this.config.botId,
          approved: false,
          reason: 'timeout',
          turnId,
        };
        resolve(timeoutPayload);
      }, 10000);

      this.pendingFollowUps.set(turnId, { eventId, resolve, timeout });

      this.sendMessage({
        type: 'request_follow_up',
        payload,
      });

      console.log(`[Orchestrator] Sent follow-up request for event ${eventId}, turn ${turnId}`, {
        targetBotId,
        reason,
      });
    });
  }

  private handleFollowUpAck(payload: FollowUpAckPayload): void {
    console.log(`[Orchestrator] Follow-up ${payload.approved ? 'approved' : 'denied'} for event ${payload.eventId}: ${payload.reason}`, {
      turnId: payload.turnId,
      queuePosition: payload.queuePosition,
    });

    const followUpKey = payload.turnId || Array.from(this.pendingFollowUps.entries())
      .find(([, pending]) => pending.eventId === payload.eventId)?.[0];

    if (!followUpKey) {
      if (payload.turnId) {
        this.completedFollowUps.set(payload.turnId, {
          payload,
          completedAt: Date.now(),
        });
        console.log(`[Orchestrator] Stored late follow-up ack for turn ${payload.turnId}`);
      }
      return;
    }

    const pending = this.pendingFollowUps.get(followUpKey);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingFollowUps.delete(followUpKey);
      const resolvedPayload: FollowUpAckPayload = {
        ...payload,
        turnId: payload.turnId || followUpKey,
      };
      this.completedFollowUps.set(followUpKey, {
        payload: resolvedPayload,
        completedAt: Date.now(),
      });
      pending.resolve(resolvedPayload);
    }
  }

  private handleResponseAck(payload: { turnId: string; status: string; nextBotId?: string }): void {
    console.log(`[Orchestrator] Response acknowledged: ${payload.turnId} (${payload.status})`, {
      nextBotId: payload.nextBotId,
    });

    orchestratorTurnJournal.markAcknowledged(payload.turnId);

    this.sendMessage({
      type: 'response_ack_received',
      payload: {
        turnId: payload.turnId,
        botId: this.config.botId,
        receivedAt: new Date(),
      },
    });
  }

  private sendMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendTurnClaimed(payload: ResponseRequestPayload): void {
    if (!payload.leaseId) {
      return;
    }

    const claimPayload: TurnClaimPayload = {
      turnId: payload.turnId,
      eventId: payload.eventId,
      botId: this.config.botId,
      instanceId: this.instanceId,
      leaseId: payload.leaseId,
    };

    this.sendMessage({
      type: 'turn_claimed',
      payload: claimPayload,
    });
  }

  private sendTurnLeaseRenewed(payload: ResponseRequestPayload): void {
    if (!payload.leaseId) {
      return;
    }

    const renewalPayload: TurnLeaseRenewedPayload = {
      turnId: payload.turnId,
      eventId: payload.eventId,
      botId: this.config.botId,
      instanceId: this.instanceId,
      leaseId: payload.leaseId,
    };

    this.sendMessage({
      type: 'turn_lease_renewed',
      payload: renewalPayload,
    });
  }

  private startLeaseRenewal(payload: ResponseRequestPayload): void {
    if (!payload.leaseId) {
      return;
    }

    this.stopLeaseRenewal(payload.turnId);

    const initialExpiry = payload.leaseExpiresAt ? new Date(payload.leaseExpiresAt).getTime() : NaN;
    const remainingMs = Number.isNaN(initialExpiry) ? 15000 : Math.max(3000, initialExpiry - Date.now());
    const renewEveryMs = Math.max(2000, Math.min(5000, Math.floor(remainingMs / 2)));

    const timer = setInterval(() => {
      if (!this.inFlightTurns.has(payload.turnId)) {
        this.stopLeaseRenewal(payload.turnId);
        return;
      }

      this.sendTurnLeaseRenewed(payload);
    }, renewEveryMs);

    // Same reasoning as the stale sweep: an interval is not a reason to keep
    // the process alive. It is retained so `stopLeaseRenewal` can cancel it,
    // but a bot that has disconnected and flushed its journal should exit on
    // its own rather than waiting out `renewEveryMs`.
    (timer as { unref?: () => void }).unref?.();

    this.leaseRenewalTimers.set(payload.turnId, timer);
  }

  private stopLeaseRenewal(turnId: string): void {
    const timer = this.leaseRenewalTimers.get(turnId);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.leaseRenewalTimers.delete(turnId);
  }

  private handleDisconnect(): void {
    // `disconnect()` closes the socket, and 'close' arrives asynchronously —
    // long after `disconnect()` reset `reconnectAttempts` to 0. Without this
    // guard, `0 < maxReconnectAttempts` was true and the intentional shutdown
    // scheduled a reconnect 5s later, resurrecting the socket after
    // `bot.destroy()`. `process.exit(0)` in the SIGINT path was hiding it.
    if (this.disconnecting) {
      console.log('[Orchestrator] Disconnect was intentional - not reconnecting');
      this.isConnected = false;
      this.connectionState = 'disconnected';
      this.ws = null;
      return;
    }

    this.isConnected = false;
    this.connectionState = 'backoff';

    for (const timer of this.leaseRenewalTimers.values()) {
      clearInterval(timer);
    }
    this.leaseRenewalTimers.clear();
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.guildUpdateRetryTimer) {
      clearTimeout(this.guildUpdateRetryTimer);
      this.guildUpdateRetryTimer = null;
    }

    // A mention queued while the socket was down belongs to a session this bot
    // cannot complete; retrying it after a reconnect would resurrect a stale
    // message. `bot/client.ts` has already swept its queue entry by then.
    if (this.mentionRetryTimer) {
      clearTimeout(this.mentionRetryTimer);
      this.mentionRetryTimer = null;
    }
    this.mentionQueue = [];
    this.mentionRetryAttempts = 0;

    for (const pending of this.pendingCollectiveKnowledgeQueries.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingCollectiveKnowledgeQueries.clear();

    // Message ids are only meaningful alongside the socket that produced them:
    // a turn in flight across a reconnect will read them from the journal.
    this.responseMessageIds.clear();

    if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`[Orchestrator] Reconnecting (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);

      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((error) => {
          console.error('[Orchestrator] Reconnection failed:', error);
        });
      }, this.config.reconnectIntervalMs);
    } else {
      console.error('[Orchestrator] Max reconnection attempts reached');
    }
  }

  isConnectedToOrchestrator(): boolean {
    return this.isConnected;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Force a guild update - useful for debugging or when guilds change
   */
  forceGuildUpdate(guilds: string[]): void {
    console.log(`[Orchestrator] Forcing guild update: ${guilds.length} guilds`);
    this.pendingGuildUpdate = guilds;
    this.refreshKnownGuilds(guilds);
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendGuildUpdate(guilds);
    } else {
      console.log('[Orchestrator] Cannot force update - not connected, will retry when connected');
      this.scheduleGuildUpdateRetry();
    }
  }

  /**
   * Get current connection status for debugging
   */
  getConnectionStatus(): { isConnected: boolean; hasPendingGuildUpdate: boolean; pendingGuildCount: number; connectionState: ConnectionState; reconnectAttempts: number; maxReconnectAttempts: number } {
    return {
      isConnected: this.isConnected,
      hasPendingGuildUpdate: this.pendingGuildUpdate !== null,
      pendingGuildCount: this.pendingGuildUpdate?.length || 0,
      // Surfaced so an operator can tell "waiting to retry" from "connected but
      // silently dead" — the two are indistinguishable from `isConnected`.
      connectionState: this.connectionState,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
    };
  }
}
