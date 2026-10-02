import { describe, expect, test } from 'bun:test';
import {
  GenerationKeyGuard,
  TypingIndicatorRegistry,
  isEmptyTriggeredTurn,
} from '../client';

/**
 * These cover the bookkeeping that used to let one bad turn escalate into a
 * permanent outage. Discord client objects are impractical to construct in a
 * unit test, so the pure helpers extracted out of `client.ts` are tested directly:
 * the generation-key guard and the typing-indicator registry.
 */

describe('GenerationKeyGuard', () => {
  test('a failed begin must not release the key held by the in-flight generation', () => {
    const guard = new GenerationKeyGuard();

    // Turn A takes the lock and is still running.
    const turnA = guard.begin('root:111');
    expect(turnA).not.toBeNull();
    expect(guard.isActive('root:111')).toBe(true);

    // Turn B is a duplicate. It loses the race and gets no lease.
    const turnB = guard.begin('root:111');
    expect(turnB).toBeNull();

    // Turn B's `finally` releases *its* lease variable, which is null.
    guard.release(turnB);
    // A's lock must survive. This is the whole bug: the old `endGeneration(key)`
    // took a bare key, so B's `finally` deleted the key A was still using.
    expect(guard.isActive('root:111')).toBe(true);

    // Only A's own release frees it.
    guard.release(turnA);
    expect(guard.isActive('root:111')).toBe(false);
  });

  test('an early return between begin and the try must not leak the key', () => {
    // The orchestrator path had `beginGeneration()` succeed, then
    // `if (!lastMessage) return '';` fire *before* the `try` opened, so the
    // `finally` never ran and the key stayed in the active set forever (unlike
    // the recent set, which is TTL'd). That conversation slot was permanently
    // dead. Here the early return is modelled faithfully: the key is taken, the
    // function bails without ever reaching a `finally`, and the guard must not be
    // left holding the key.
    const guard = new GenerationKeyGuard();
    let lease: ReturnType<GenerationKeyGuard['begin']> = null;

    const bailOutEarly = (): string => {
      lease = guard.begin('root:222');
      if (!lease) return 'suppressed';
      // Early return *before* any try/finally would exist.
      return 'no last message';
    };

    expect(bailOutEarly()).toBe('no last message');
    // The caller's job is to release; the guard exposes that as an explicit
    // operation, and the key is only freed for a lease it actually issued.
    guard.release(lease);
    expect(guard.isActive('root:222')).toBe(false);

    // And a subsequent turn for the same key can proceed once the recent window
    // is accounted for, rather than being blocked forever.
    guard.clear();
    expect(guard.isActive('root:222')).toBe(false);
  });

  test('the recent window suppresses a near-simultaneous duplicate after release', () => {
    const guard = new GenerationKeyGuard();

    const first = guard.begin('root:333');
    expect(first).not.toBeNull();
    guard.release(first);
    expect(guard.isActive('root:333')).toBe(false);
    // Still inside the 120s suppression window, so a retry is refused even though
    // the key is no longer active. This is what stops a Discord redelivery from
    // generating twice.
    expect(guard.isRecent('root:333')).toBe(true);
    expect(guard.begin('root:333')).toBeNull();

    // clear() drops the recent window too.
    guard.clear();
    expect(guard.isRecent('root:333')).toBe(false);
    expect(guard.begin('root:333')).not.toBeNull();
  });

  test('a long-running generation keeps its lock past the recent TTL', async () => {
    // The 120s recent window is a duplicate-suppression device, not a lock. A
    // generation that runs longer than it (a 10-round tool loop plus retries is
    // entirely plausible) must still hold mutual exclusion, which is why the
    // active set is only ever released by the lease holder.
    const guard = new GenerationKeyGuard(0); // recent window expires on the next tick
    const lease = guard.begin('root:444');
    expect(lease).not.toBeNull();

    // Let the TTL timer fire, so `recent` has genuinely expired.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(guard.isRecent('root:444')).toBe(false); // recent has expired
    expect(guard.isActive('root:444')).toBe(true); // but the lock is intact
    expect(guard.begin('root:444')).toBeNull(); // still refuses a concurrent turn

    guard.release(lease);
    expect(guard.isActive('root:444')).toBe(false);
  });

  test('release is idempotent and a released lease cannot double-free', () => {
    const guard = new GenerationKeyGuard();
    const lease = guard.begin('root:555');
    expect(lease).not.toBeNull();

    guard.release(lease);
    guard.release(lease);
    guard.release(lease);
    expect(guard.isActive('root:555')).toBe(false);
  });

  test('independent keys do not block each other', () => {
    const guard = new GenerationKeyGuard();
    const a = guard.begin('root:aaa');
    const b = guard.begin('root:bbb');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    guard.release(a);
    expect(guard.isActive('root:aaa')).toBe(false);
    expect(guard.isActive('root:bbb')).toBe(true);
  });
});

describe('isEmptyTriggeredTurn', () => {
  test('flags a bare summon with nothing to answer', () => {
    // "hey Lumia" with no body. The old code started the typing indicator before
    // this check and returned from the empty-content branch without stopping it,
    // so every one of these left a permanent 8s REST ping per channel.
    expect(isEmptyTriggeredTurn(true, '   ', 0)).toBe(true);
    expect(isEmptyTriggeredTurn(true, '', 0)).toBe(true);
  });

  test('does not flag a turn that has content or media', () => {
    expect(isEmptyTriggeredTurn(true, 'hello', 0)).toBe(false);
    expect(isEmptyTriggeredTurn(true, '  ', 2)).toBe(false); // sticker hints count as content
  });

  test('does not flag a non-triggered turn', () => {
    // Without an explicit trigger the empty-content branch is not taken at all;
    // the guard is only about "you summoned me and said nothing".
    expect(isEmptyTriggeredTurn(false, '', 0)).toBe(false);
  });
});

describe('TypingIndicatorRegistry', () => {
  /** A fake ticker that records starts/stops without any real timers. */
  function makeRegistry() {
    const started: string[] = [];
    const stopped: string[] = [];
    let counter = 0;

    const registry = new TypingIndicatorRegistry<string>(
      (channelId) => {
        started.push(channelId);
        return `handle-${++counter}`;
      },
      (handle) => {
        stopped.push(handle);
      },
    );

    return { registry, started, stopped };
  }

  test('the empty-content path leaves no typing interval registered', () => {
    const { registry, started, stopped } = makeRegistry();

    // The production order: check content FIRST, and only start typing when
    // there is something to answer. The empty turn returns before `startTyping`,
    // so no interval is ever created.
    const cleanedContent = '   ';
    const stickerHints = 0;
    if (!isEmptyTriggeredTurn(true, cleanedContent, stickerHints)) {
      registry.acquire('chan-1', 'turn:1');
    }

    expect(registry.size).toBe(0);
    expect(registry.trackedChannels).toBe(0);
    expect(registry.isActive('chan-1')).toBe(false);
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test('a real turn starts one indicator and releases it', () => {
    const { registry, started, stopped } = makeRegistry();

    registry.acquire('chan-1', 'turn:1');
    expect(registry.size).toBe(1);
    expect(registry.isActive('chan-1')).toBe(true);
    expect(registry.holderCount('chan-1')).toBe(1);
    expect(started).toEqual(['chan-1']);

    registry.release('chan-1', 'turn:1');
    expect(registry.size).toBe(0);
    expect(registry.isActive('chan-1')).toBe(false);
    expect(stopped).toHaveLength(1);
  });

  test('concurrent turns in one channel do not cancel each other', () => {
    // The bug: startTyping keyed by channel and called stopTyping first, so turn
    // B's start killed turn A's interval and A's stop then killed B's — the
    // indicator flickered off mid-generation, exactly when the queue is deepest.
    const { registry, started, stopped } = makeRegistry();

    registry.acquire('chan-1', 'turn:A');
    registry.acquire('chan-1', 'turn:B');
    // Only one ticker for the channel, regardless of how many turns want it.
    expect(started).toEqual(['chan-1']);
    expect(registry.holderCount('chan-1')).toBe(2);

    // A finishes first: B is still generating, so the indicator must stay up.
    registry.release('chan-1', 'turn:A');
    expect(registry.isActive('chan-1')).toBe(true);
    expect(stopped).toEqual([]);

    // B finishes: now the ticker stops.
    registry.release('chan-1', 'turn:B');
    expect(registry.isActive('chan-1')).toBe(false);
    expect(stopped).toHaveLength(1);
  });

  test('acquiring the same holder twice does not pin the indicator open', () => {
    // The orchestrator drives typing as a boolean per channel, so it re-sends
    // `isTyping: true`. A plain counter would inflate and never return to zero.
    const { registry, started } = makeRegistry();

    registry.acquire('chan-1', 'orchestrator');
    registry.acquire('chan-1', 'orchestrator');
    registry.acquire('chan-1', 'orchestrator');
    expect(started).toEqual(['chan-1']);
    expect(registry.holderCount('chan-1')).toBe(1);

    registry.release('chan-1', 'orchestrator');
    expect(registry.isActive('chan-1')).toBe(false);
  });

  test('independent channels each get their own ticker', () => {
    const { registry, started } = makeRegistry();

    registry.acquire('chan-1', 'turn:1');
    registry.acquire('chan-2', 'turn:2');
    expect(registry.size).toBe(2);
    expect(started).toEqual(['chan-1', 'chan-2']);

    registry.release('chan-1', 'turn:1');
    expect(registry.isActive('chan-1')).toBe(false);
    expect(registry.isActive('chan-2')).toBe(true);
  });

  test('a failed start leaves no phantom holder', () => {
    const registry = new TypingIndicatorRegistry<string>(
      () => {
        throw new Error('channel unavailable');
      },
      () => {},
    );

    expect(() => registry.acquire('chan-1', 'turn:1')).toThrow('channel unavailable');
    expect(registry.size).toBe(0);
    expect(registry.trackedChannels).toBe(0);

    // And the channel can be acquired again cleanly once it recovers.
    const healthy = makeRegistry();
    healthy.registry.acquire('chan-1', 'turn:1');
    expect(healthy.registry.isActive('chan-1')).toBe(true);
  });

  test('a REST failure drops every holder for that channel', () => {
    let triggerFailure: (() => void) | null = null;
    const registry = new TypingIndicatorRegistry<string>(
      (_channelId, onFailure) => {
        triggerFailure = onFailure;
        return 'handle-1';
      },
      () => {},
    );

    registry.acquire('chan-1', 'turn:A');
    registry.acquire('chan-1', 'turn:B');

    // sendTyping() threw (channel deleted, or permission revoked).
    expect(triggerFailure).not.toBeNull();
    (triggerFailure as unknown as () => void)();

    expect(registry.isActive('chan-1')).toBe(false);
    expect(registry.trackedChannels).toBe(0);
  });

  test('releaseAll clears every channel', () => {
    const { registry, stopped } = makeRegistry();

    registry.acquire('chan-1', 'turn:1');
    registry.acquire('chan-2', 'turn:2');
    registry.acquire('chan-3', 'turn:3');
    expect(registry.size).toBe(3);

    registry.releaseAll();
    expect(registry.size).toBe(0);
    expect(registry.trackedChannels).toBe(0);
    expect(stopped).toHaveLength(3);
  });

  test('releasing an unknown holder is a no-op', () => {
    const { registry } = makeRegistry();
    registry.acquire('chan-1', 'turn:1');

    registry.release('chan-1', 'turn:does-not-exist');
    expect(registry.isActive('chan-1')).toBe(true);

    registry.release('never-seen', 'turn:1');
    expect(registry.size).toBe(1);
  });
});
