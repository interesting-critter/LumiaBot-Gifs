/**
 * Bot Definition Loader
 * 
 * This module provides backwards compatibility for code that imports from './bot-definition'.
 * The actual prompt loading logic has been moved to '../services/prompts' for better organization.
 * 
 * For new code, prefer importing directly from '../services/prompts' to access:
 * - getBotIdentity() - Get the full bot persona/identity
 * - getErrorMessage() - Get error message templates
 * - getCommandResponse() - Get command response templates
 * - And more dynamic prompt functions
 */

import {
  getActivePromptProfileId,
  getBotIdentity,
  getPromptCacheGeneration,
  reloadPrompts,
} from '../services/prompts';

/**
 * WHY THERE IS A CACHE AT ALL
 * ---------------------------
 * `getBotDefinition()` is called on the hot path of **every single turn** — twice
 * in `openai.ts` (`:812` and, via `buildSystemPrompt`, again for the reinforced
 * copy) and twice in `google-genai.ts` (`:293` and `:445`). `getBotIdentity()`
 * is not free: it runs the file through two regex replacements and a
 * template-variable substitution pass over a multi-kilobyte persona, producing a
 * new string every call. Caching the assembled string turns "re-derive a few KB
 * of text several times per turn" into one property read. That benefit is real
 * and is why this module exists at all rather than being a re-export of
 * `getBotIdentity`.
 *
 * WHY IT WAS WRONG
 * ----------------
 * The cache was a bare `string | null` with exactly one invalidation point,
 * `reloadBotDefinition()`. That predates prompt profiles. Once `prompts.ts`
 * learned to resolve files against an active profile, `getBotIdentity()` became
 * a *function of the active profile*, but this cache still remembered only the
 * string. So after `setActivePromptProfileId()` — which does clear `prompts.ts`'s
 * own cache — the `<identity>` block, the very first thing in the system prompt,
 * kept serving the previous profile's persona until an operator happened to save
 * a persona file through the dashboard, which incidentally calls
 * `reloadBotDefinition()`. Every *other* prompt file switched correctly, which
 * made it look like a partial feature rather than a broken one: a profile
 * holding only `persona/identity.txt` did not override exactly that one file, it
 * overrode nothing.
 *
 * WHY THE KEY IS (PROFILE, GENERATION) INSTEAD OF A BOOLEAN
 * ---------------------------------------------------------
 * The fix is not to delete the cache — that throws away the hot-path win above.
 * It is to make the cache key carry everything the assembled string depends on,
 * so correctness no longer depends on remembering to invalidate:
 *
 *   - `getActivePromptProfileId()` is the profile dimension. It is the semantic
 *     key: the same profile id always resolves to the same bytes, so a hit is
 *     safe. This is also why the fix does *not* live in `prompts.ts`: importing
 *     `prompt-selector.ts` here would be a genuine cycle (that module imports
 *     `model-selector`, which imports `prompt-selector`), and `prompts.ts` does
 *     not import this module either, so there is no callback for it to call.
 *     Keying on state we can read is strictly better than being notified about
 *     it — it cannot be forgotten by a future invalidation site.
 *
 *   - `getPromptCacheGeneration()` is the invalidation dimension, and it is
 *     already the established mechanism for exactly this problem: `clearCache()`
 *     bumps it, and `swarmui.ts` watches it for its own short-TTL config cache.
 *     Folding it in means every existing trigger — the profile switch, the
 *     dashboard's `PUT /api/persona` → `reloadPrompts()`, and
 *     `setTemplateVariables()` (which changes what `{botName}` renders to, and
 *     therefore changes this very string) — invalidates the definition without
 *     any of them having to know this module exists. Before this change,
 *     `setTemplateVariables()` was a second latent instance of the same bug: it
 *     cleared `prompts.ts`'s cache and left this one stale.
 *
 * Between those events the generation is stable and the cache holds, so the
 * per-turn saving is preserved.
 */
let cachedDefinition: { key: string; definition: string } | null = null;

/**
 * The cache key for the current state of the prompt layer.
 *
 * Both halves are cheap reads of module-level state — no I/O, no allocation
 * beyond the key string — so this is safe to call on the per-turn path.
 */
function currentDefinitionKey(): string {
  return `${getActivePromptProfileId()}:${getPromptCacheGeneration()}`;
}

/**
 * Load the bot definition from prompt storage
 * @deprecated Use getBotIdentity() from '../services/prompts' instead
 */
export function loadBotDefinition(): string {
  const key = currentDefinitionKey();

  // Return the cached definition only when it was assembled from exactly this
  // profile at exactly this cache generation.
  if (cachedDefinition !== null && cachedDefinition.key === key) {
    return cachedDefinition.definition;
  }

  const identity = getBotIdentity();
  cachedDefinition = { key, definition: identity };
  return identity;
}

/**
 * Reload the bot definition from disk
 * @deprecated Use reloadPrompts() from '../services/prompts' instead
 */
export function reloadBotDefinition(): string {
  // Drop the entry outright rather than relying on the key: this is an explicit
  // operator action ("re-read the disk now"), so it must hold even if some future
  // change makes the generation stop moving on this path. `reloadPrompts()` then
  // bumps the generation anyway, so both mechanisms agree.
  cachedDefinition = null;
  reloadPrompts();
  return loadBotDefinition();
}

/**
 * Get the cached bot definition
 * @deprecated Use getBotIdentity() from '../services/prompts' instead
 */
export function getBotDefinition(): string {
  return loadBotDefinition();
}
