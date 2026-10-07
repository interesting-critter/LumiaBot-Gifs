import {
  TextChannel,
  ThreadChannel,
  NewsChannel,
  VoiceChannel,
  StageChannel,
  DMChannel,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { channelHistoryService } from '../services/channel-history';
import type { ChatMessage } from '../services/openai';

/**
 * Shared "recent channel turns for a slash command" helper.
 *
 * Extracted from `src/commands/chat.ts` because `/dryrun` needs byte-identical
 * context resolution. Duplicating it would have been the easy option and the
 * wrong one: the logic below exists because an uncached channel once made a
 * command answer from a model that had never seen the channel, and a second copy
 * is a second chance at that bug with nobody watching it.
 */

/** Channel types `fetchChannelHistory` can read a message history from. */
export type HistoryCapableChannel =
  | TextChannel
  | ThreadChannel
  | NewsChannel
  | VoiceChannel
  | StageChannel
  | DMChannel;

function isHistoryCapable(channel: unknown): channel is HistoryCapableChannel {
  return channel instanceof TextChannel
    || channel instanceof ThreadChannel
    || channel instanceof NewsChannel
    || channel instanceof VoiceChannel
    || channel instanceof StageChannel
    || channel instanceof DMChannel;
}

/**
 * Resolve the interaction's channel to something with a readable history.
 *
 * WHY THIS FETCHES INSTEAD OF READING `interaction.channel`
 * --------------------------------------------------------
 * `interaction.channel` is typed `Channel | null` and is **cache-only** — it
 * resolves the channel id against the client's cache and yields `null` when the
 * channel is not in it. That is not hypothetical: an uncached channel made
 * `/chat` silently answer with no context at all, because an earlier version of
 * this helper treated a `null` channel as "no history available" and returned
 * without a word. The user got a confident reply to "what did she just say?"
 * from a model that had never seen the channel.
 *
 * So: prefer the cache, fall back to an API fetch, and only then give up — and
 * say so, rather than degrading to a silent blank.
 */
export async function resolveHistoryChannel(
  interaction: ChatInputCommandInteraction,
  logPrefix: string,
): Promise<HistoryCapableChannel | null> {
  const cached = interaction.channel;
  if (isHistoryCapable(cached)) return cached;

  if (!interaction.channelId) return null;

  try {
    const fetched = await interaction.client.channels.fetch(interaction.channelId);
    if (isHistoryCapable(fetched)) return fetched;
    console.warn(`📜 [${logPrefix}] Channel ${interaction.channelId} is ${fetched?.constructor.name ?? 'unavailable'}, which has no message history`);
    return null;
  } catch (error) {
    // Usually a permissions problem (no Read Message History). Worth saying out
    // loud: the difference between "no history exists" and "cannot read history"
    // is the difference between a correct answer and a confidently wrong one.
    console.warn(`📜 [${logPrefix}] Could not resolve channel ${interaction.channelId} for history:`, error);
    return null;
  }
}

/**
 * Recent channel turns for context, or `undefined` when there are none to give.
 *
 * Never throws: history is an enrichment, and a channel the bot cannot read must
 * still get an answer — just one without surrounding context.
 */
export async function fetchChannelTurns(
  interaction: ChatInputCommandInteraction,
  logPrefix: string,
): Promise<ChatMessage[] | undefined> {
  const channel = await resolveHistoryChannel(interaction, logPrefix);
  if (!channel) return undefined;

  try {
    const history = await channelHistoryService.fetchChannelHistory(
      channel as Parameters<typeof channelHistoryService.fetchChannelHistory>[0],
    );
    if (history.length === 0) return undefined;
    const turns = channelHistoryService.convertToTurns(history, interaction.client.user?.id);
    console.log(`📜 [${logPrefix}] Converted ${history.length} channel messages to ${turns.length} chat turns`);
    return turns;
  } catch (error) {
    console.warn(`📜 [${logPrefix}] Failed to fetch channel history:`, error);
    return undefined;
  }
}
