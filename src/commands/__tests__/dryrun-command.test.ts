import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * `/dryrun` — command-level behaviour, exercised end to end.
 *
 * Nothing here is mocked. `execute()` is called with a hand-rolled interaction
 * object and the real `handleMessage`, the real provider and the real (temp-dir)
 * databases run behind it. That is the point: every guarantee this command
 * claims is a claim about what happens when it is actually invoked, and a mocked
 * `handleMessage` would only prove that the command passes the right arguments —
 * which is one of the smaller halves of it.
 *
 * The pipeline is safe to run for real because a dry run is the one path in the
 * bot that cannot contact a model. `dry-run-prompt.test.ts` proves that at the
 * provider level; if this file ever hangs on a network call, that is the bug
 * these two files exist to catch.
 *
 * THE THREE THINGS PINNED HERE
 * ----------------------------
 *  1. It is owner-only, via the dispatcher's existing `ownerOnly` flag rather
 *     than a second in-command check.
 *  2. Conversation history is written under the literal name "dry run" and the
 *     owner's REAL user id — so the entries land in the owner's guild-scoped
 *     bucket and are still recognisable as not having been said.
 *  3. The stored assistant turn is a short marker, not the prompt. The prompt is
 *     several kilobytes and `CONVERSATION_MAX_HISTORY` is a rolling window
 *     measured in ENTRIES, so storing it would evict twenty real messages of
 *     context and poison every later turn in that guild.
 */

import { config } from '../../utils/config';

// `openai.ts` builds its exported singleton at module load and the SDK rejects a
// blank key, so the key has to exist before anything imports the provider.
// Mutating the evaluated config object rather than `process.env` keeps this
// independent of which test file loaded config first.
config.openai.apiKey = config.openai.apiKey || 'test-key-not-used';
config.gemini.apiKey = config.gemini.apiKey || 'test-key-not-used';

const { default: dryRunCommand } = await import('../dryrun');
const { conversationHistoryService } = await import('../../services/conversation-history');
const { dashboardLoggerService } = await import('../../services/dashboard-logger');
const { DRY_RUN_HISTORY_USERNAME } = await import('../../services/message-handler');

const OWNER_ID = '777888999000111222';
const GUILD_ID = '555666777888999000';
const OWNER_NAME = 'the operator';

interface Recorded {
  content?: string;
  flags?: number;
}

interface FakeInteraction {
  replies: Recorded[];
  edits: Recorded[];
  deferrals: Recorded[];
  followUps: Recorded[];
  interaction: Record<string, unknown>;
}

/**
 * The smallest interaction surface `/dryrun` actually touches.
 *
 * `channel` is a plain object rather than a real `TextChannel`, which is
 * realistic: `resolveHistoryChannel` exists precisely because `interaction.channel`
 * can be a cache miss. Here the follow-up `channels.fetch` also fails, so the
 * command takes its "no history available" branch — which is a branch worth
 * exercising anyway, since a dry run in a channel the bot cannot read must still
 * produce a prompt.
 */
function fakeInteraction(options: {
  message?: string | null;
  guildId?: string | null;
}): FakeInteraction {
  const replies: Recorded[] = [];
  const edits: Recorded[] = [];
  const deferrals: Recorded[] = [];
  const followUps: Recorded[] = [];

  const guildId = options.guildId === undefined ? GUILD_ID : options.guildId;

  const interaction: Record<string, unknown> = {
    options: {
      getString: (name: string) => (name === 'message' ? (options.message ?? null) : null),
      getBoolean: () => null,
      getAttachment: () => null,
    },
    channelId: '444555666777888999',
    channel: { name: 'prompt-lab', nsfw: false },
    guildId,
    guild: guildId ? { name: 'Test Guild' } : null,
    user: { id: OWNER_ID, username: OWNER_NAME },
    client: {
      user: { id: '1234567890' },
      channels: { fetch: async () => null },
    },
    deferReply: async (payload?: Recorded) => { deferrals.push(payload ?? {}); },
    editReply: async (payload: Recorded) => { edits.push(payload); },
    reply: async (payload: Recorded) => { replies.push(payload); },
    followUp: async (payload: Recorded) => { followUps.push(payload); },
  };

  return { replies, edits, deferrals, followUps, interaction };
}

/** Every history row for a user, as `content` strings, oldest first. */
function historyContents(userId: string, guildId: string): string[] {
  const conversation = conversationHistoryService.getConversation(userId, guildId);
  return (conversation?.messages ?? []).map((m) => m.content);
}

beforeAll(() => {
  conversationHistoryService.clearHistory(OWNER_ID, GUILD_ID);
});

afterAll(() => {
  conversationHistoryService.clearHistory(OWNER_ID, GUILD_ID);
  conversationHistoryService.clearHistory(OWNER_ID, 'dm');
});

describe('/dryrun — shape and authorisation', () => {
  test('it is owner-only through the dispatcher flag, not an in-command check', () => {
    // `bot/client.ts` compares `interaction.user.id` against `config.bot.ownerId`
    // before `execute` runs. A second check inside the command could only ever
    // agree with that one, and would be a second thing to keep in step.
    expect(dryRunCommand.ownerOnly).toBe(true);
  });

  test('the message option is optional', () => {
    const json = dryRunCommand.data.toJSON() as {
      options?: Array<{ name: string; required?: boolean; type?: number }>;
    };
    const message = json.options?.find((o) => o.name === 'message');
    expect(message).toBeDefined();
    expect(message?.required ?? false).toBe(false);
  });

  test('attachments are accepted, as /chat does', () => {
    const json = dryRunCommand.data.toJSON() as { options?: Array<{ name: string }> };
    const names = (json.options ?? []).map((o) => o.name);
    expect(names).toContain('image');
    expect(names).toContain('video');
  });
});

describe('/dryrun — what it writes', () => {
  test('history is filed under "dry run" with the owner real user id', async () => {
    const fake = fakeInteraction({ message: 'what would you send for this?' });
    await dryRunCommand.execute(fake.interaction as never);

    const conversation = conversationHistoryService.getConversation(OWNER_ID, GUILD_ID);
    expect(conversation).not.toBeNull();
    // The REAL id, so the entries are in the owner's guild-scoped bucket…
    expect(conversation?.userId).toBe(OWNER_ID);
    // …and the literal name, so they are never mistaken for something said.
    expect(conversation?.username).toBe(DRY_RUN_HISTORY_USERNAME);
    expect(DRY_RUN_HISTORY_USERNAME).toBe('dry run');
  });

  test('both the user turn and the assistant turn are attributed to "dry run"', async () => {
    const fake = fakeInteraction({ message: 'attribution check' });
    await dryRunCommand.execute(fake.interaction as never);

    const contents = historyContents(OWNER_ID, GUILD_ID);
    // `getHistory` prefixes user turns with their stored username, so a
    // "[dry run]:" prefix is the database agreeing with the assertion above about
    // the user turn specifically — `getConversation` only reports one name for
    // the pair. `ChatMessage['content']` is a union, so it is narrowed here
    // rather than asserted on blind.
    const withNames = conversationHistoryService.getHistory(OWNER_ID, GUILD_ID);
    const attributed = withNames.some((m) =>
      typeof m.content === 'string' && m.content.startsWith(`[${DRY_RUN_HISTORY_USERNAME}]:`),
    );
    expect(attributed).toBe(true);

    // The user turn really was the text that was supplied…
    expect(contents.some((c) => c.includes('attribution check'))).toBe(true);
    // …and the assistant turn is the marker, saying in as many words that no
    // request was made.
    const assistant = contents.find((c) => c.includes('No request was made to any model'));
    expect(assistant).toBeDefined();
  });

  test('the stored assistant turn is a marker, NOT the prompt', async () => {
    // The trade-off, pinned. A multi-kilobyte "reply" in a rolling 20-entry
    // window would evict real conversation and feed prompt text back as if it
    // were something the bot had said.
    const fake = fakeInteraction({ message: 'size check' });
    await dryRunCommand.execute(fake.interaction as never);

    const assistant = historyContents(OWNER_ID, GUILD_ID)
      .find((c) => c.includes('No request was made to any model'));

    expect(assistant).toBeDefined();
    // Short enough to be a marker, not a persona.
    expect((assistant ?? '').length).toBeLessThan(500);
    // The prompt's own signature blocks are nowhere in it.
    expect(assistant).not.toContain('<reaction-instructions>');
    expect(assistant).not.toContain('[system]');
  });

  test('the dashboard entry is a dry run and carries the full prompt', async () => {
    const fake = fakeInteraction({ message: 'dashboard check' });
    await dryRunCommand.execute(fake.interaction as never);

    const entries = dashboardLoggerService.list({ source: 'dry-run' });
    const entry = entries.find((e) => e.prompt.includes('dashboard check'));
    expect(entry).toBeDefined();
    expect(entry?.username).toBe(DRY_RUN_HISTORY_USERNAME);
    // The prompt is not on the entry itself — it is keyed, de-duplicated and
    // stored once, because these payloads are far too large to keep per turn.
    expect(entry?.fullPromptId).toBeDefined();

    const fullPrompts = dashboardLoggerService.getFullPrompts([entry!]);
    const full = fullPrompts[entry!.fullPromptId!];
    expect(full).toBeDefined();
    // The bare user message, plus the assembled turn it became.
    expect(full).toContain('dashboard check');
    expect(full).toContain('[system]');
  });
});

describe('/dryrun — what it says', () => {
  test('the reply is the emoji and nothing else', async () => {
    const fake = fakeInteraction({ message: 'reply shape' });
    await dryRunCommand.execute(fake.interaction as never);

    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0]?.content).toBe(config.dryRun.emoji);
    // The custom emoji is a named config value, not a literal at the call site.
    expect(config.dryRun.emoji).toBe('<:zak_yap:1552379447246852146>');
  });

  test('the reply is ephemeral', async () => {
    // A debugging tool has no business being visible noise in a live channel.
    const fake = fakeInteraction({ message: 'ephemeral check' });
    await dryRunCommand.execute(fake.interaction as never);

    expect(fake.deferrals).toHaveLength(1);
    // 64 is MessageFlags.Ephemeral. Compared numerically because the command
    // imports the enum rather than hardcoding the bit.
    expect(fake.deferrals[0]?.flags).toBe(64);
  });

  test('with no message, a placeholder runs and the reply says so', async () => {
    const fake = fakeInteraction({ message: null });
    await dryRunCommand.execute(fake.interaction as never);

    // The reply says the placeholder was used, because the dashboard's `prompt`
    // column would otherwise read as though real input had been given.
    expect(fake.edits[0]?.content).toContain(config.dryRun.emoji);
    expect(fake.edits[0]?.content).toContain('no message supplied');

    // And the placeholder is unmistakable in the log itself.
    const entry = dashboardLoggerService.list({ source: 'dry-run' })[0];
    expect(entry?.prompt).toContain('placeholder');
  });

  test('a whitespace-only message is treated as no message at all', async () => {
    // Discord accepts `"   "` as a perfectly valid string option, and quietly
    // dry-running an empty prompt because of trailing spaces is exactly the kind
    // of thing that wastes an afternoon.
    const fake = fakeInteraction({ message: '   ' });
    await dryRunCommand.execute(fake.interaction as never);

    expect(fake.edits[0]?.content).toContain('no message supplied');
  });

  test('the prompt is never posted into the channel', async () => {
    // The whole payload is kilobytes long and only the operator asked for it.
    const fake = fakeInteraction({ message: 'do not post me' });
    await dryRunCommand.execute(fake.interaction as never);

    for (const recorded of [...fake.edits, ...fake.replies, ...fake.followUps]) {
      expect(recorded.content ?? '').not.toContain('do not post me');
      expect(recorded.content ?? '').not.toContain('[system]');
    }
  });
});
