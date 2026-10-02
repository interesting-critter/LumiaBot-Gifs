import { getAIService, getVisionService } from './google-genai';
import { parseMessage, storeParsedInformation, type ParsedMessage } from './message-parser';
import { conversationHistoryService } from './conversation-history';
import { channelHistoryService } from './channel-history';
import { getTriggerKeywords, getErrorMessage } from './prompts';
import { knowledgeGraphService } from './knowledge-graph';
import { config } from '../utils/config';
import { gifService } from './gif';
import { dashboardLoggerService, type InteractionSource } from './dashboard-logger';
import type { ChatMessage } from './openai';
import type { MusicActivity } from './user-activity';
import type { ResolveUserMention } from './user-mention-resolver';
import type { GeneratedImageAttachment } from './swarmui';

/**
 * Compiled trigger patterns.
 *
 * `wholeWord` is reused for both the "did this trigger the bot" test and the
 * "which keyword matched" scan, so the two can never disagree.
 * `stripLeading` removes a trigger keyword from the front of a message.
 */
interface TriggerPatterns {
  /** The exact array the patterns were compiled from; also the cache key. */
  source: readonly string[];
  keywords: string[];
  wholeWord: RegExp[];
  stripLeading: RegExp[];
}

const EMPTY_TRIGGER_PATTERNS: TriggerPatterns = {
  source: [],
  keywords: [],
  wholeWord: [],
  stripLeading: [],
};

let TRIGGER_PATTERNS: TriggerPatterns = EMPTY_TRIGGER_PATTERNS;

const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(https?:\/\/[^\s)]+\)/gi;
const BARE_URL_PATTERN = /https?:\/\/[^\s<>"'\)\]]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile the keyword list once.
 *
 * These patterns used to be rebuilt with `new RegExp(...)` inside the
 * per-keyword loop, for every keyword, on every message, in every guild — a
 * per-message allocation burst on the hottest path in the bot.
 */
function compileTriggers(keywords: readonly string[]): TriggerPatterns {
  const usable = keywords.filter(
    (keyword): keyword is string => typeof keyword === 'string' && keyword.trim() !== ''
  );
  return {
    source: keywords,
    keywords: usable,
    wholeWord: usable.map((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i')),
    stripLeading: usable.map((keyword) => new RegExp(`^${escapeRegExp(keyword)}[,!]?\\s*`, 'i')),
  };
}

/**
 * Keep the compiled patterns in step with `prompt_storage/config/triggers.json`.
 *
 * `getTriggerKeywords()` reads through the prompt cache, so it returns the
 * *same array object* until something clears that cache (the dashboard does,
 * via `reloadBotDefinition()` → `reloadPrompts()` → `clearCache()`, when an
 * operator saves new triggers). Comparing by reference therefore costs one
 * `Map.get` in the common case and recompiles exactly when the list changed —
 * and a stale pattern cache cannot win a comparison, because the cache key *is*
 * the list the patterns were compiled from.
 *
 * The old code read the keyword list once at module load and never again, so
 * editing triggers.json on the dashboard had no effect until a restart.
 */
function ensureTriggersFresh(): TriggerPatterns {
  const keywords = getTriggerKeywords().botMention;
  if (!Array.isArray(keywords)) {
    return TRIGGER_PATTERNS;
  }
  if (TRIGGER_PATTERNS.source !== keywords) {
    TRIGGER_PATTERNS = compileTriggers(keywords);
    console.log(`🎯 [HANDLER] Compiled ${TRIGGER_PATTERNS.wholeWord.length} trigger pattern(s)`);
  }
  return TRIGGER_PATTERNS;
}

/** Force a trigger re-read and recompile (exported for in-process reloads). */
export function reloadTriggers(): void {
  TRIGGER_PATTERNS = EMPTY_TRIGGER_PATTERNS;
  ensureTriggersFresh();
}

/** Bot mention patterns, compiled per bot id and cached (the id never changes). */
const MENTION_PATTERNS = new Map<string, { single: RegExp; global: RegExp }>();

function mentionPatterns(botId: string): { single: RegExp; global: RegExp } {
  const cached = MENTION_PATTERNS.get(botId);
  if (cached) return cached;
  // botId is a Discord snowflake (digits), so interpolating it is safe.
  const compiled = {
    single: new RegExp(`<@!?${botId}>`),
    global: new RegExp(`<@!?${botId}>`, 'g'),
  };
  MENTION_PATTERNS.set(botId, compiled);
  return compiled;
}

/**
 * Strip URLs from text so that words inside links don't trigger the bot.
 * Removes both bare URLs (https://...) and markdown links ([text](url)).
 */
function stripUrls(text: string): string {
  // Remove markdown links entirely: [link text](url)
  let stripped = text.replace(MARKDOWN_LINK_PATTERN, '$1');
  // Remove bare URLs
  stripped = stripped.replace(BARE_URL_PATTERN, '');
  return stripped;
}

/**
 * Check if a message should trigger the bot response
 * @param content - The message content
 * @param botId - The bot's user ID
 * @returns boolean indicating if bot should respond
 */
export function shouldTriggerBot(content: string, botId: string): boolean {
  ensureTriggersFresh();

  // Check if bot is mentioned (against original content, before URL stripping)
  if (mentionPatterns(botId).single.test(content)) {
    return true;
  }

  // Strip URLs so trigger words inside links don't activate the bot
  const lowerContent = stripUrls(content).toLowerCase().trim();

  // Check for trigger keywords (only match whole words/phrases)
  return TRIGGER_PATTERNS.wholeWord.some((pattern) => pattern.test(lowerContent));
}

/**
 * Extract all trigger keywords found in the message content
 * @param content - The message content
 * @returns Array of matched trigger keywords
 */
export function extractTriggerKeywords(content: string): string[] {
  ensureTriggersFresh();

  // Strip URLs so trigger words inside links are ignored
  const lowerContent = stripUrls(content).toLowerCase().trim();
  const matched: string[] = [];

  TRIGGER_PATTERNS.wholeWord.forEach((pattern, index) => {
    const keyword = TRIGGER_PATTERNS.keywords[index];
    if (keyword !== undefined && pattern.test(lowerContent)) {
      matched.push(keyword);
    }
  });

  return matched;
}

/**
 * Extract the message content without the bot mention
 * @param content - The message content
 * @returns The cleaned message content
 */
export function extractMessageContent(content: string, botId: string): string {
  ensureTriggersFresh();

  let cleaned = content;

  // Remove bot mentions
  cleaned = cleaned.replace(mentionPatterns(botId).global, '').trim();

  // Remove trigger keywords from the beginning of the message
  const lowerCleaned = cleaned.toLowerCase();
  for (const pattern of TRIGGER_PATTERNS.stripLeading) {
    if (pattern.test(lowerCleaned)) {
      cleaned = cleaned.replace(pattern, '').trim();
      break; // Only remove the first matching keyword
    }
  }

  return cleaned;
}

export interface MessageHandlerOptions {
  content: string;
  enableSearch?: boolean;
  enableKnowledgeGraph?: boolean;
  imageUrls?: string[];
  videoUrls?: { url: string; mimeType?: string }[]; // Video attachments for Gemini 3 models
  textAttachments?: { name: string; content: string }[]; // Text file attachments
  pageContents?: { url: string; title: string; content: string; excerpt?: string; siteName?: string; byline?: string }[]; // Extracted web page contents
  userId?: string;
  username?: string;
  guildId: string;
  mentionedUsers?: Map<string, string>; // userId -> username mapping for users mentioned in current message
  replyContext?: { // Context when user is replying to a message
    isReply: boolean;
    isReplyToLumia?: boolean;
    originalContent?: string;
    originalTimestamp?: string;
    originalAuthor?: string;
  };
  channelMessages?: ChatMessage[]; // Channel history converted to chat turns
  orchestratorContextNote?: string;
  currentMessageSpeaker?: {
    authorId: string;
    authorName: string;
    isBot: boolean;
    format?: 'default' | 'orchestrator';
    currentBotId?: string;
  };
  getUserListeningActivity?: (userId: string) => Promise<MusicActivity | null>;
  resolveUserMention?: ResolveUserMention;
  isNsfwChannel?: boolean;
  allowNsfwImageGeneration?: boolean;
  // Orchestrator follow-up support
  orchestratorEventId?: string;
  orchestratorTurnId?: string;
  requestFollowUp?: (eventId: string, turnId: string, targetBotId?: string, reason?: string) => Promise<{ approved: boolean; reason: string }>;
  requestCollectiveKnowledge?: (query: string, maxResults?: number) => Promise<string>;
  // Dashboard observability
  source?: InteractionSource;
  channelId?: string;
  channelName?: string;
  guildName?: string;
}

export interface MessageHandlerResponse {
  text: string;
  reactions: string[];
  attachments: GeneratedImageAttachment[];
  gifUrl?: string;
}

/**
 * Extract reactions from AI response
 * Looks for [REACT: emoji] tags in the response
 */
 function extractReactions(response: string): { text: string; reactions: string[] } {
  const reactions: string[] = [];
  
  // Match [REACT: emoji], [REACT: :emoji_name:], [REACT: <:name:id>], and full-width bracket variants
  const reactPattern = /[\[［]REACT:\s*([^\]］]+)[\]］]/gi;
  let match;
  
  while ((match = reactPattern.exec(response)) !== null) {
    if (match[1]) {
      // Split by commas or whitespace to support multiple emojis in one tag
      const items = match[1].split(/[,\s]+/).map(e => e.trim()).filter(Boolean);
      reactions.push(...items);
    }
  }
  
  // Remove the reaction tags from the text
  const text = response.replace(reactPattern, '').trim();
  
  // Clean up any extra whitespace left behind
  const cleanedText = text.replace(/\n{3,}/g, '\n\n').trim();
  
  return { text: cleanedText, reactions };
}

/**
 * How long a collective-knowledge prefetch may delay the main LLM call.
 *
 * The orchestrator's own `requestCollectiveKnowledge` resolves `empty` after a
 * hard 10s timeout, and that await sat directly in the request path: a
 * connected-but-slow or wedged orchestrator made **every** message turn stall
 * 10 seconds before the main model was even called, and the empty result was
 * injected into the system prompt anyway. Collective knowledge is a
 * nice-to-have enrichment, so it now gets a small budget and is simply dropped
 * when it does not arrive in time. The model can still query it later through
 * the tool, which has its own timeout.
 */
export const COLLECTIVE_KNOWLEDGE_PREFETCH_BUDGET_MS = 2500;

/**
 * Fetch collective knowledge within a time budget, never throwing.
 *
 * Returns `undefined` — meaning "inject nothing" — when the request is slow,
 * rejects, or resolves to an empty/whitespace result. An empty
 * `<collective-knowledge>` block is pure token cost: it tells the model that
 * nothing was found, which is worse than saying nothing at all.
 *
 * Exported for tests: this is the only part of the turn that has timing
 * behaviour, and it is pure with respect to Discord.
 */
export async function prefetchCollectiveKnowledge(
  request: (query: string) => Promise<string>,
  query: string,
  budgetMs: number = COLLECTIVE_KNOWLEDGE_PREFETCH_BUDGET_MS
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The request keeps running after the budget expires (it cannot be
  // cancelled), so it is given its own no-op handler. Without this, a late
  // rejection from the abandoned promise is an unhandled rejection that can
  // take the process down.
  const pending = request(query);
  pending.catch(() => {});

  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });

  try {
    const result = await Promise.race([pending, timeout]);
    const trimmed = typeof result === 'string' ? result.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    // Never let a prefetch failure reach the caller's generic error handler:
    // the user asked a question, and the answer does not depend on this.
    console.warn(`📚 [HANDLER] Collective knowledge prefetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Process vision content (images/videos) using a secondary vision model
 * Returns a description that can be fed into the main text model
 */
async function processVisionContent(
  content: string,
  imageUrls?: string[],
  videoUrls?: { url: string; mimeType?: string }[]
): Promise<string> {
  if (!config.vision.enabled) {
    return content;
  }
  
  const hasImages = imageUrls && imageUrls.length > 0;
  const hasVideos = videoUrls && videoUrls.length > 0;
  
  if (!hasImages && !hasVideos) {
    return content;
  }
  
  console.log(`👁️  [Vision] Processing ${hasImages ? imageUrls!.length : 0} image(s) and ${hasVideos ? videoUrls!.length : 0} video(s) with secondary model...`);
  
  try {
    const visionService = getVisionService();
    const visionPrompt = `${config.vision.promptPrefix}\n\nUser message: "${content}"`;
    
    // Create a minimal conversation for vision processing
    const visionMessages = [
      {
        role: 'user' as const,
        content: visionPrompt,
      },
    ];
    
    const visionDescription = await visionService.createChatCompletion({
      messages: visionMessages,
      images: imageUrls,
      videos: videoUrls,
      maxTokens: config.vision.maxTokens,
      temperature: config.vision.temperature,
    });
    
    console.log(`👁️  [Vision] Description received (${visionDescription.length} chars)`);
    
    // Combine the original content with the vision description
    const combinedContent = `[Vision Analysis]: ${visionDescription}\n\n[Original User Message]: ${content}`;
    
    return combinedContent;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ [Vision] Failed to process vision content: ${errorMessage}`);
    // Fall back to original content if vision processing fails
    return content;
  }
}

/**
 * Handle a message that triggered the bot
 * @param options - Message handling options
 * @returns The bot's response with potential reactions
 */
export async function handleMessage(options: MessageHandlerOptions): Promise<MessageHandlerResponse> {
    const { content, enableSearch, enableKnowledgeGraph, imageUrls, videoUrls, textAttachments, pageContents, userId, username, guildId, mentionedUsers, replyContext, channelMessages, orchestratorContextNote, currentMessageSpeaker, getUserListeningActivity, resolveUserMention, isNsfwChannel, allowNsfwImageGeneration, orchestratorEventId, orchestratorTurnId, requestFollowUp, requestCollectiveKnowledge, source, channelName, guildName } = options;

    // Dashboard observability: measure the full turn so the log shows how long
    // the bot actually took to answer, not just the model call.
    const turnStartedAt = Date.now();
    const logTurn = (
      response: MessageHandlerResponse | null,
      error?: string,
    ): void => {
      dashboardLoggerService.log({
        source: source ?? 'unknown',
        prompt: content,
        response: response?.text ?? '',
        durationMs: Date.now() - turnStartedAt,
        userId,
        username,
        channelId: options.channelId,
        channelName,
        guildId,
        guildName,
        error,
        imageCount: imageUrls?.length ?? 0,
        videoCount: videoUrls?.length ?? 0,
        attachmentCount: response?.attachments.length ?? 0,
        reactions: response?.reactions ?? [],
        gifUrl: response?.gifUrl,
        searchEnabled: shouldSearchForLog,
        knowledgeEnabled: shouldKnowledgeForLog,
        fullPrompt: fullPromptForLog,
      });
    };

    // Captured before the try block runs so the error path can still log them.
    let shouldSearchForLog = options.enableSearch;
    let shouldKnowledgeForLog = options.enableKnowledgeGraph;
    // The full system prompt is only ever assembled inside the AI service, so
    // it is handed back through the same callback pattern already used for
    // generated images. Undefined when the call throws before the service
    // reaches the send.
    let fullPromptForLog: string | undefined;

  try {
    // Parsed here (cheap, side-effect free) but only *stored* after the model
    // call succeeds — see below.
    let parsedInfo: ParsedMessage | null = null;

    // Parse message for pronouns and mentions BEFORE processing
    if (userId && username) {
      const userMap = mentionedUsers || new Map<string, string>();
      // `guildId` is threaded here so the mentions carry their scope, and again
      // at store time below. Every read of user memory is guild-scoped, so an
      // unthreaded parse/store silently writes to a bucket nothing ever reads.
      parsedInfo = parseMessage(content, userMap, username, guildId);

      if (parsedInfo.pronouns) {
        console.log(`📝 [HANDLER] Detected pronouns for ${username}: ${parsedInfo.pronouns}`);
      }

      if (parsedInfo.hasMentions) {
        console.log(`📝 [HANDLER] Parsed ${parsedInfo.mentions.length} third-party reference(s)`);
      }
    }

    // Check if GIF reactions are enabled for this server
    const isGifEnabled = gifService.isGifEnabled(guildId);

    const shouldSearch = enableSearch !== undefined ? enableSearch : true;
    const shouldQueryLocalKnowledge = enableKnowledgeGraph !== undefined
      ? enableKnowledgeGraph
      : knowledgeGraphService.hasDocuments();

    // Record the resolved values (post-default) on the dashboard entry.
    shouldSearchForLog = shouldSearch;
    shouldKnowledgeForLog = shouldQueryLocalKnowledge;

    const shouldQueryCollectiveKnowledge = typeof requestCollectiveKnowledge === 'function';

    if (shouldSearch) {
      console.log(`🔍 [HANDLER] Web search tool will be attached for model-directed use`);
    } else {
      console.log(`🔍 [HANDLER] Web search tool is disabled for this message`);
    }

    if (shouldQueryLocalKnowledge) {
      const stats = knowledgeGraphService.getStats();
      console.log(`📚 [HANDLER] Knowledge search tool will be attached (${stats.totalDocuments} docs across ${stats.totalTopics} topics)`);
    } else {
      console.log(`📚 [HANDLER] Local knowledge base tool is disabled or has no documents`);
    }

    if (shouldQueryCollectiveKnowledge) {
      console.log('📚 [HANDLER] Collective knowledge queries are available through the orchestrator');
    }

    // Log if multimodal (images or videos)
    if (imageUrls && imageUrls.length > 0) {
      console.log(`🖼️  [HANDLER] Multimodal request with ${imageUrls.length} image(s)`);
    }
    if (videoUrls && videoUrls.length > 0) {
      console.log(`🎥 [HANDLER] Video content detected: ${videoUrls.length} video(s)`);
    }

    // Log user info for memory
    if (userId && username) {
      console.log(`💭 [HANDLER] User context: ${username} (${userId})`);
    }

    // Determine if this is a vision request
    const hasImages = imageUrls && imageUrls.length > 0;
    const hasVideos = videoUrls && videoUrls.length > 0;
    const isVisionRequest = hasImages || hasVideos;
    
    // Process vision content if secondary model is configured
    let processedContent = content;
    let processedImages = imageUrls;
    let processedVideos = videoUrls;
    // Don't pass images/videos to main model since vision model already processed them
    if (isVisionRequest && config.vision.enabled) {
      processedContent = await processVisionContent(content, imageUrls, videoUrls);
      processedImages = undefined;
      processedVideos = undefined;
    }

    let collectiveKnowledgeContext: string | undefined;
    if (shouldQueryCollectiveKnowledge && requestCollectiveKnowledge) {
      console.log('📚 [HANDLER] Prefetching collective knowledge from orchestrator');
      // Bounded, failure-isolated, and empty results are dropped instead of
      // being injected as a content-free <collective-knowledge> block.
      collectiveKnowledgeContext = await prefetchCollectiveKnowledge(
        requestCollectiveKnowledge,
        processedContent
      );
      if (!collectiveKnowledgeContext) {
        console.log('📚 [HANDLER] No collective knowledge available in budget; continuing without it');
      }
    }

    // Add user message to conversation history (use processed content if vision was used)
    if (userId && username) {
      conversationHistoryService.addMessage(userId, guildId, username, 'user', processedContent);
    }

    // Get per-user conversation summary for background context in system prompt
    const conversationSummary = userId
      ? conversationHistoryService.formatHistoryForPrompt(userId, guildId)
      : '';

    // Build final turns: channel history (as real turns) + current message
    const currentMessageTurn: ChatMessage = currentMessageSpeaker
      ? channelHistoryService.convertMessageToTurn(
          {
            id: 'current-message',
            authorId: currentMessageSpeaker.authorId,
            authorUsername: currentMessageSpeaker.authorName,
            content: processedContent,
            timestamp: new Date(),
            isBot: currentMessageSpeaker.isBot,
          },
          currentMessageSpeaker.currentBotId,
          currentMessageSpeaker.format || 'default'
        )
      : { role: 'user', content: processedContent };
    const finalTurns: ChatMessage[] = [
      ...(channelMessages || []),
      currentMessageTurn,
    ];

    const generatedImages: GeneratedImageAttachment[] = [];
    const aiService = getAIService();
    const response = await aiService.createChatCompletion({
      messages: finalTurns,
      enableSearch: shouldSearch,
      enableKnowledgeGraph: shouldQueryLocalKnowledge,
      collectiveKnowledgeContext,
      images: processedImages,
      videos: processedVideos,
      textAttachments,
      pageContents,
      userId,
      username,
      guildId,
      mentionedUsers,
      replyContext,
      orchestratorContextNote,
      conversationSummary: conversationSummary || undefined,
      getUserListeningActivity,
      resolveUserMention,
      isNsfwChannel,
      allowNsfwImageGeneration,
      isGifEnabled, 
      orchestratorEventId,
      orchestratorTurnId,
      requestFollowUp,
      requestCollectiveKnowledge,
      onImageGenerated: (image: GeneratedImageAttachment) => generatedImages.push(image),
      onFullPrompt: (fullPrompt: string) => { fullPromptForLog = fullPrompt; },
    });

    // Memory writes happen only now, after the model actually produced a reply.
    //
    // They used to run before the call, so a failed generation still committed
    // them: a turn that ended in "Something went wrong" would store the user's
    // pronouns and burn one of the 15 third-party context slots, evicting a
    // genuine older memory in exchange for a turn that never happened.
    if (parsedInfo && userId && username) {
      storeParsedInformation(userId, username, parsedInfo, guildId);

      if (parsedInfo.pronouns) {
        console.log(`📝 [HANDLER] Stored pronouns for ${username}: ${parsedInfo.pronouns}`);
      }

      if (parsedInfo.hasMentions) {
        console.log(`📝 [HANDLER] Stored ${parsedInfo.mentions.length} third-party reference(s)`);
      }
    }

    // 1. Extract and resolve GIF if present (and remove <gif> tags from the text)
    const { text: textWithoutGif, gifUrl } = isGifEnabled
      ? await gifService.extractAndResolveGif(response)
      : { text: response, gifUrl: undefined };

    // 2. Extract [REACT: emoji] reactions from the remaining text
    const { text, reactions } = extractReactions(textWithoutGif);
    
    if (reactions.length > 0) {
      console.log(`😀 [HANDLER] Extracted ${reactions.length} reaction(s): ${reactions.join(', ')}`);
    }

    // Store assistant response in history
    if (userId && username) {
      conversationHistoryService.addMessage(userId, guildId, username, 'assistant', text);
    }

    const handlerResponse: MessageHandlerResponse = { text, reactions, attachments: generatedImages, gifUrl };
    logTurn(handlerResponse);

    return handlerResponse;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ [HANDLER] ${errorMessage}`);

    // Record the failure on the dashboard even though the user sees a friendly
    // error template instead of the raw message.
    logTurn(null, errorMessage);

    if (errorMessage.includes('Failed to generate response after multiple attempts') || 
        errorMessage.includes('Failed to generate response')) {
      return {
        text: getErrorMessage('multiple_attempts_failure'),
        reactions: [],
        attachments: []
      };
    } else if (errorMessage.includes('Empty response')) {
      return {
        text: getErrorMessage('empty_response'),
        reactions: [],
        attachments: []
      };
    }
    
    return {
      text: getErrorMessage('generic_error'),
      reactions: [],
      attachments: []
    };
  }
      }
