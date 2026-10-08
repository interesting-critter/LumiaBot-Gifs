import { describe, expect, test } from 'bun:test';
import { Collection, EmbedType } from 'discord.js';
import type { APIEmbed, Message, TextChannel } from 'discord.js';
import { buildResponseCard } from '../../utils/response-card';
import { ChannelHistoryService, extractEmbedContent } from '../channel-history';

/**
 * The bot posts its replies as an embed ("response card", `utils/response-card.ts`)
 * with no `content` alongside. Until the reader was fixed, `fetchChannelHistory`
 * filtered those messages out as empty, so the bot could not read back its own
 * replies and lost all self-continuity in channel context. These lock in the
 * read-side fix: embed text is visible, decorative chrome is not, and the plain
 * content/attachment/sticker path is byte-for-byte unchanged.
 *
 * No temp DB is needed — `ChannelHistoryService` holds no state — so the fakes
 * are the only scaffolding here. `fetchChannelHistory` is async and every test
 * goes through it rather than calling the private helpers, because the bug was
 * in the filter/reassembly inside that method, not in a testable unit.
 */

const BOT_ID = '999888777666555444';
const USER_ID = '123456789012345678';
const GIF_URL = 'https://media.tenor.com/abcdef/cat.gif';

/** discord.js exposes embeds as `Embed` instances wrapping `.data`. */
function embed(data: APIEmbed): Message['embeds'][number] {
  return { data } as unknown as Message['embeds'][number];
}

interface FakeMessageOptions {
  id: string;
  content?: string;
  embeds?: APIEmbed[];
  attachments?: Array<{ contentType?: string | null }>;
  stickers?: Array<{ name: string }>;
  authorId?: string;
  authorName?: string;
  isBot?: boolean;
}

/** Messages are listed newest-first, as `channel.messages.fetch` returns them. */
function fakeMessage(options: FakeMessageOptions): Message {
  const {
    id,
    content = '',
    embeds = [],
    attachments = [],
    stickers = [],
    authorId = USER_ID,
    authorName = 'ada',
    isBot = false,
  } = options;

  return {
    id,
    content,
    embeds: embeds.map(embed),
    attachments: new Collection(attachments.map((a, i) => [`a${i}`, { ...a }])),
    stickers: new Collection(stickers.map((s, i) => [`s${i}`, { ...s }])),
    author: { id: authorId, username: authorName, displayName: authorName, bot: isBot },
    member: { displayName: authorName },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as Message;
}

/** A channel stub whose `messages.fetch` hands back the given messages. */
function fakeChannel(messages: Message[], id = '555'): TextChannel {
  return {
    id,
    messages: {
      fetch: () => new Collection(messages.map((m) => [m.id, m])),
    },
  } as unknown as TextChannel;
}

const service = new ChannelHistoryService();

async function fetchOne(options: FakeMessageOptions): Promise<string> {
  const [message] = await service.fetchChannelHistory(fakeChannel([fakeMessage(options)]));
  return message ? message.content : '';
}

describe('embed text reaches the model', () => {
  test('an embed-only message is not skipped and its description survives', async () => {
    // The exact shape of a card: no content, no attachments, no stickers.
    // Before the fix this message was discarded by the empty-message filter.
    const content = await fetchOne({
      id: '1',
      embeds: [{ description: 'i am the reply body' }],
    });

    expect(content).toBe('i am the reply body');
  });

  test('this bot\'s own card yields the description and nothing else', async () => {
    // Built with the real `buildResponseCard` so the fixture cannot drift from
    // what actually ships: author flourish, description, footer flourish, and
    // the GIF as `embed.image.url`.
    const card = buildResponseCard({ text: 'meow, obviously', gifUrl: GIF_URL })!;
    const data = card.toJSON() as APIEmbed;

    // Precondition: the card really does carry the chrome we claim to strip.
    expect(data.author?.name).toContain('☽');
    expect(data.footer?.text).toContain('arf.');
    expect(data.image?.url).toBe(GIF_URL);

    const content = await fetchOne({
      id: '1',
      embeds: [data],
      authorId: BOT_ID,
      authorName: 'Bad Kitty',
      isBot: true,
    });

    expect(content).toBe('meow, obviously');
    // No decorative author name, no footer flourish, and above all no GIF URL.
    expect(content).not.toContain('☽');
    expect(content).not.toContain('arf.');
    expect(content).not.toContain(GIF_URL);
    expect(content).not.toContain('tenor');
  });

  test('a title-only embed still contributes its title', async () => {
    expect(await fetchOne({ id: '1', embeds: [{ title: 'Server Rules' }] })).toBe('Server Rules');
  });

  test('a field-only embed contributes every field', async () => {
    const content = await fetchOne({
      id: '1',
      embeds: [{ fields: [{ name: 'Status', value: 'online' }, { name: 'Uptime', value: '3d' }] }],
    });

    expect(content).toBe('Status: online\nUptime: 3d');
  });

  test('description, title and fields are all read, in render order', async () => {
    const content = await fetchOne({
      id: '1',
      embeds: [
        {
          title: 'Build Report',
          description: 'everything is fine',
          fields: [{ name: 'Tests', value: '791 passing' }],
        },
      ],
    });

    expect(content).toBe('everything is fine\nBuild Report\nTests: 791 passing');
  });

  test('multiple embeds on one message are all considered', async () => {
    // Discord permits up to 10 per message; each is rendered as its own card, so
    // all of them have to be read rather than just the first.
    const content = await fetchOne({
      id: '1',
      embeds: [
        { title: 'first card' },
        { description: 'second card' },
        { fields: [{ name: 'third', value: 'card' }] },
      ],
    });

    expect(content).toBe('first card\n\nsecond card\n\nthird: card');
  });

  test('message content and embed text are both kept, content first', async () => {
    const content = await fetchOne({
      id: '1',
      content: 'look at this',
      embeds: [{ description: 'embed says hi' }],
    });

    expect(content).toBe('look at this\n\nembed says hi');
  });

  test('an embed whose only fields are empty contributes nothing and does not resurrect an empty message', async () => {
    const content = await fetchOne({
      id: '1',
      embeds: [{ fields: [{ name: '', value: '   ' }] }],
    });

    // Still empty, so still filtered — a message that renders as nothing must
    // not become a blank turn in the prompt.
    expect(content).toBe('');
  });
});

describe('link previews', () => {
  test('a Discord-generated link preview contributes its title, labelled', async () => {
    // Discord auto-generates a `link` embed for any message containing a URL.
    const content = await fetchOne({
      id: '1',
      content: 'https://example.com/article',
      embeds: [
        {
          type: EmbedType.Link,
          title: 'A Very Informative Article',
          description: 'scraped page blurb nobody wrote on purpose',
          url: 'https://example.com/article',
        },
      ],
    });

    expect(content).toContain('[link preview: A Very Informative Article]');
    // The label is the point: the model must not read scraped page text as
    // something a person in the channel said.
    expect(content).not.toContain('nobody wrote on purpose');
  });

  test('a link preview with no title contributes nothing', async () => {
    const content = await fetchOne({
      id: '1',
      content: 'https://example.com/redirect',
      embeds: [{ type: EmbedType.Link, url: 'https://example.com/redirect' }],
    });

    // The URL is already in `content`; an unlabelled, untitled preview would
    // only add noise.
    expect(content).toBe('https://example.com/redirect');
  });
});

describe('embed media annotation', () => {
  test('an embed with media and no text is marked, never by URL', async () => {
    // A GIF-only card: description unset, so without a marker the turn is
    // indistinguishable from a message that never rendered. The URL must not
    // appear — that is the whole reason the card exists.
    const content = await fetchOne({
      id: '1',
      embeds: [{ image: { url: GIF_URL } }],
      authorId: BOT_ID,
      isBot: true,
    });

    expect(content).toBe('[image]');
    expect(content).not.toContain(GIF_URL);
  });

  test('an embed with text is not additionally marked as an image', async () => {
    // The marker stands in for missing text. Adding `[image]` next to a
    // description would teach the model that it posted pictures.
    const content = await fetchOne({
      id: '1',
      embeds: [{ description: 'here is a cat', image: { url: GIF_URL } }],
    });

    expect(content).toBe('here is a cat');
  });
});

describe('plain messages are unchanged', () => {
  test('content, image, video, file and sticker annotations all still apply', async () => {
    const content = await fetchOne({
      id: '1',
      content: 'hello',
      attachments: [{ contentType: 'image/png' }, { contentType: 'video/mp4' }, { contentType: 'application/pdf' }],
      stickers: [{ name: 'wave' }],
    });

    expect(content).toBe('hello [image] [video] [file] [sticker: wave]');
  });

  test('a genuinely empty message with nothing attached is still filtered out', async () => {
    expect(await fetchOne({ id: '1', content: '   ' })).toBe('');
  });

  test('a message with only an attachment is still kept', async () => {
    expect(await fetchOne({ id: '1', attachments: [{ contentType: 'image/png' }] })).toBe('[image]');
  });

  test('a long plain message is truncated exactly as before', async () => {
    const long = 'x'.repeat(400);
    const content = await fetchOne({ id: '1', content: long });

    expect(content).toBe('x'.repeat(200) + '...');
  });

  test('truncation applies to embed text and does not evict annotations', async () => {
    const content = await fetchOne({
      id: '1',
      content: 'short',
      embeds: [{ description: 'y'.repeat(400) }],
      attachments: [{ contentType: 'image/png' }],
    });

    expect(content).toBe(`short\n\n${'y'.repeat(200)}... [image]`);
  });

  test('truncation never splits a surrogate pair', async () => {
    // Slicing between the halves of an emoji leaves invalid UTF-16.
    const content = await fetchOne({ id: '1', content: '🧡'.repeat(200) });

    expect(content).toBe('🧡'.repeat(100) + '...');
    expect(/[\uD800-\uDBFF]$/.test(content.replace(/\.\.\.$/, ''))).toBe(false);
  });
});

describe('the bot reads its own card back as an assistant turn', () => {
  test('a card reply round-trips to role: assistant with its description intact', async () => {
    // The user-visible symptom of the bug: the bot's own replies vanished from
    // its own context, so every turn restarted from nothing.
    const card = buildResponseCard({ text: 'the name is Lumia', gifUrl: GIF_URL })!.toJSON() as APIEmbed;

    // Newest-first, as `channel.messages.fetch` really returns them.
    const history = await service.fetchChannelHistory(
      fakeChannel([
        fakeMessage({ id: '3', content: 'are you sure?', authorId: USER_ID }),
        fakeMessage({
          id: '2',
          embeds: [card],
          authorId: BOT_ID,
          authorName: 'Bad Kitty',
          isBot: true,
        }),
        fakeMessage({ id: '1', content: 'what is your name?', authorId: USER_ID }),
      ]),
    );

    const turns = service.convertToTurns(history, BOT_ID);

    expect(turns).toEqual([
      { role: 'user', content: '[ada]: what is your name?' },
      { role: 'assistant', content: 'the name is Lumia' },
      { role: 'user', content: '[ada]: are you sure?' },
    ]);
    // The GIF link must not have leaked into the prompt via the read path.
    expect(JSON.stringify(turns)).not.toContain(GIF_URL);
  });
});

describe('extractEmbedContent', () => {
  test('handles no embeds, ten embeds, and mixed text/media embeds', () => {
    expect(extractEmbedContent([])).toEqual([]);

    const ten = Array.from({ length: 10 }, (_, i) => ({ title: `card ${i}` }));
    expect(extractEmbedContent(ten)).toHaveLength(10);

    expect(extractEmbedContent([{ image: { url: GIF_URL } }, { description: 'text' }])).toEqual([
      '[image]',
      'text',
    ]);
  });
});