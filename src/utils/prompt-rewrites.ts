/**
 * Ordered text substitutions applied to the FINAL outbound prompt.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Discord account's username and display name are the two strings that reach
 * the model most reliably and least controllably. `convertToTurns()` in
 * `channel-history.ts` prefixes every turn with `[<displayName>]:`, the
 * `<current-user name="…">` block in `buildSystemPrompt()` interpolates the
 * username, `<mentioned-users>` lists them, and the reply/memory context
 * repeats them. None of those are wrong — they are how the bot knows who is
 * talking — but an operator may want the model to address someone by a chosen
 * name instead ("Critter"), without touching any of that plumbing.
 *
 * The transform lives here as a **pure function** so it can be reasoned about
 * and unit-tested without a prompt tree, a database, or a provider.
 *
 * WHERE IT RUNS
 * -------------
 * At the send boundary only, on a copy. Stored history, the database and the
 * dashboard's activity log all keep the original text: rewriting those would
 * make the logs lie about what was actually said, and rewriting stored history
 * would destroy the only record of the real names. See `getPromptRewrites()`
 * in `src/services/prompts.ts` for the file loader and the two provider hooks.
 *
 * WHY NOT `\b`
 * ------------
 * `\b` is defined against `\w` = `[A-Za-z0-9_]`, so `\b` **cannot** match around
 * a name written in decorative symbols. `⋆˖⁺‧₊☽𝕔𝕣𝕚𝕥𝕥𝕖𝕣☾₊‧⁺˖⋆` starts with `⋆`, which
 * is not a word character, so no boundary exists at its start and the pattern
 * would fail to match the one string this feature exists for. Explicit
 * lookarounds over a Unicode-aware "word" class are used instead — see
 * {@link WORD_CLASS}.
 */

/**
 * A single rewrite, after normalisation.
 *
 * Every field is required post-normalisation so consumers never have to
 * re-apply a default. `regex` and `caseSensitive` default to `false` when the
 * file omits them; see {@link normalizePromptRewriteRules}.
 */
export interface PromptRewriteRule {
  /** Literal substring, or a raw pattern when `regex` is true. */
  match: string;
  /** Replacement text. May be empty (a deletion). */
  replace: string;
  /** `true` opts into treating `match` as a raw regular expression. */
  regex: boolean;
  /** `false` (the default) makes the match case-insensitive. */
  caseSensitive: boolean;
  /** `false` skips the rule without removing it from the file. */
  enabled: boolean;
}

/** A rule with its pattern already compiled, ready to run. */
export interface CompiledPromptRewrite {
  /** The compiled pattern. Always global, so every occurrence is replaced. */
  pattern: RegExp;
  /**
   * Replacement string, already escaped for literal mode.
   *
   * `$&` and `$1` are only special in a replacement string, never in a pattern,
   * so an operator writing `"replace": "$&"` for a *literal* rule must get a
   * literal `$&` — not the matched text, and not an empty `undefined`.
   */
  replacement: string;
  /** The rule this came from, for logging. */
  rule: PromptRewriteRule;
}

/**
 * The character class that counts as "inside a word" for boundary purposes.
 *
 * Deliberately Unicode-aware: `\w` would be ASCII-only, which makes `critter`
 * match inside `𝕔𝕣𝕚𝕥𝕥𝕖𝕣` and `Critter` match inside `ⓕoot` — corrupting a person's
 * name inside their own decorative handle. `\p{L}`/`\p{N}` cover letters
 * (including the mathematical-alphanumerics used for stylised names) and
 * numbers; `_` is added by hand because `\p{L}`/`\p{N}` exclude it while every
 * mainstream flavour of "word character" includes it.
 */
const WORD_CLASS = String.raw`\p{L}\p{N}_`;

/**
 * Escape every character that is special in a regular expression.
 *
 * A `RegExp.escape`-equivalent, hand-rolled rather than polyfilled: the target is
 * modern V8 via Bun, but `RegExp.escape` is recent enough that hand-rolling is
 * cheaper than a feature-detect for something called once per compiled rule.
 *
 * This is what makes `"match": "dumb.critter"` mean the literal text
 * `dumb.critter` rather than the regex `dumb.critter` — which would also match
 * `dumbXcritter` and quietly rewrite an unrelated word.
 */
export function escapeRegExpLiteral(value: string): string {
  // `-` and `/` are deliberately NOT escaped. Both are only special inside a
  // character class, and the escaped literal is never placed in one (the
  // boundary assertions use their own class around it), so escaping them buys
  // nothing. Worse than nothing: the patterns here compile with the `u` flag,
  // where `\-` and `\/` are *invalid* identity escapes and throw — so escaping
  // them would make any rule containing a hyphen or a slash fail to compile.
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape a replacement string so `$` sequences are taken literally.
 *
 * `String.prototype.replace` expands `$&`, `$1`, `` $` `` and `$'` in its
 * replacement argument. In literal mode there are no capture groups, so `$&`
 * would expand to the whole match and `$1` would expand to the empty string —
 * both silent corruptions of the operator's own text.
 */
export function escapeRegExpReplacement(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

/**
 * The bounds a literal match may not cross.
 *
 * Read D3 out loud: `'`/`’` (possessive and typographic apostrophe) and `,`
 * `.` `]` `)` (sentence and markup punctuation) are **not** word characters, so
 * a name followed by any of them still matches — which is what keeps
 * `"dumb.critter"` matching inside `"dumb.critter's"` and yielding
 * `"Critter's"`, possessive intact. Conversely a letter or digit after the
 * match blocks it, so `"critters"` does **not** match: see
 * {@link compilePromptRewriteRule} for why that asymmetry is the whole point.
 */
const LEFT_BOUNDARY = `(?<![${WORD_CLASS}])`;
const RIGHT_BOUNDARY = `(?![${WORD_CLASS}])`;

/**
 * Coerce the parsed contents of `rewrites.json` into a rule list.
 *
 * Accepts either `{ "rewrites": [ … ] }` (the documented shape, which leaves
 * room for sibling keys later) or a bare top-level array, because an operator
 * writing a list of lists should not have to know which one we parse.
 *
 * NEVER THROWS. A malformed entry is dropped with a warning and the rest of the
 * file is still honoured: this runs on the send path of every turn, and a
 * hand-edited config file must not be able to take the bot's replies down. The
 * contract for a bad file is "fewer rewrites", never "no replies".
 */
export function normalizePromptRewriteRules(raw: unknown): PromptRewriteRule[] {
  const list = extractRuleList(raw);
  if (!list) return [];

  const rules: PromptRewriteRule[] = [];
  list.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      console.warn(`⚠️ [PROMPT-REWRITES] config/rewrites.json rule ${index} is not an object — skipping it`);
      return;
    }

    const candidate = entry as Record<string, unknown>;
    const match = candidate['match'];
    if (typeof match !== 'string' || match.length === 0) {
      console.warn(`⚠️ [PROMPT-REWRITES] config/rewrites.json rule ${index} has no non-empty "match" — skipping it`);
      return;
    }

    const replace = candidate['replace'];
    if (replace !== undefined && typeof replace !== 'string') {
      console.warn(`⚠️ [PROMPT-REWRITES] config/rewrites.json rule ${index} has a non-string "replace" — skipping it`);
      return;
    }

    rules.push({
      match,
      // An omitted `replace` is a deletion, which is a legitimate rule shape
      // (redact a handle, drop an internal codename) — so it is not an error.
      replace: typeof replace === 'string' ? replace : '',
      regex: candidate['regex'] === true,
      // Off by default: these rules exist to catch the *same person* spelled
      // with different capitalisation across usernames, display names and prose.
      caseSensitive: candidate['caseSensitive'] === true,
      enabled: candidate['enabled'] !== false,
    });
  });

  return rules;
}

/** Pull the array of rule entries out of either supported file shape. */
function extractRuleList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object') {
    const nested = (raw as Record<string, unknown>)['rewrites'];
    if (Array.isArray(nested)) return nested;
    // An object with no `rewrites` key is almost certainly a typo'd shape.
    // Say so once, rather than silently doing nothing forever.
    console.warn('⚠️ [PROMPT-REWRITES] config/rewrites.json has no "rewrites" array — no rewrites applied');
  }
  return null;
}

/**
 * Compile one rule, or return `null` if it cannot produce a usable pattern.
 *
 * LITERAL MODE (`regex: false`, the default)
 * ----------------------------------------
 * The pattern is the escaped literal wrapped in {@link LEFT_BOUNDARY} /
 * {@link RIGHT_BOUNDARY}. Three consequences, each one a deliberate call:
 *
 *   - `"dumb.critter"` matches `"dumb.critter's"` → `"Critter's"`. The
 *     possessive is *outside* the match, so it survives; it is not consumed and
 *     then re-emitted.
 *   - `"dumb.critter"` does **not** match `"dumb.critters"`. A trailing `s` is
 *     a word character, so the right boundary blocks it. This asymmetry with
 *     the possessive above is intentional: rewriting `"critters"` would yield
 *     `"Critics"`, turning a person's plural nickname into an insult about
 *     film critics, in a prompt nobody reviews. A rule that misses a word is
 *     recoverable; a rule that corrupts one is not, and this one runs
 *     unattended over every message in every channel.
 *   - `"dumb.critter"` does **not** match `"xdumb.critter"`. `x` is a word
 *     character, so the left boundary blocks it — no rewriting the tail of an
 *     unrelated handle.
 *
 * REGEX MODE (`regex: true`)
 * --------------------------
 * `match` is used verbatim, with **no** boundary assertions: an operator who
 * opts in owns the anchoring, and silently wrapping a `^`-anchored or
 * alternation pattern in lookarounds would change its meaning. `new RegExp`
 * still runs inside a `try`, so an invalid pattern disables that one rule
 * instead of throwing mid-turn.
 */
export function compilePromptRewriteRule(rule: PromptRewriteRule): CompiledPromptRewrite | null {
  // A pattern that can match the empty string would rewrite at every position
  // in the prompt. `String.replace` would not loop forever, but the result is
  // unrecoverable garbage, so the rule is refused outright.
  if (rule.match.length === 0) return null;

  const flags = `gu${rule.caseSensitive ? '' : 'i'}`;

  try {
    const pattern = rule.regex
      ? new RegExp(rule.match, flags)
      : new RegExp(`${LEFT_BOUNDARY}${escapeRegExpLiteral(rule.match)}${RIGHT_BOUNDARY}`, flags);

    return {
      pattern,
      // `$` is only special in the replacement, so only literal rules need it.
      replacement: rule.regex ? rule.replace : escapeRegExpReplacement(rule.replace),
      rule,
    };
  } catch (error) {
    console.warn(
      `⚠️ [PROMPT-REWRITES] Skipping invalid rule ${JSON.stringify(rule.match)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Compile a whole rule list, dropping any rule that will not compile. */
export function compilePromptRewriteRules(rules: readonly PromptRewriteRule[]): CompiledPromptRewrite[] {
  const compiled: CompiledPromptRewrite[] = [];
  for (const rule of rules) {
    // `enabled: false` is how an operator parks a rule without deleting it, so
    // it is honoured here rather than being treated as a malformed entry.
    if (!rule.enabled) continue;
    const one = compilePromptRewriteRule(rule);
    if (one) compiled.push(one);
  }
  return compiled;
}

/**
 * Run a compiled rule list over `text`.
 *
 * **Order is load-bearing.** Rules are applied sequentially, each to the output
 * of the one before it, so a later rule can act on an earlier rule's output —
 * which is what makes a two-step alias (`dumb.critter` → `Critter`, then
 * `Critters` → `the Critters`) possible at all, and is the reason the file is an
 * ordered array rather than a map. Reordering the same rules can therefore
 * change the output, and that is a feature, not an accident to be sorted away.
 */
export function applyCompiledPromptRewrites(text: string, compiled: readonly CompiledPromptRewrite[]): string {
  if (!text || compiled.length === 0) return text;

  let result = text;
  for (const { pattern, replacement } of compiled) {
    // `pattern` is global, so `lastIndex` is already reset by the time the same
    // compiled rule is used again — but a rule that throws mid-string (a
    // pathological backtracking pattern, say) must not cost the whole turn.
    try {
      result = result.replace(pattern, replacement);
    } catch (error) {
      console.warn(
        `⚠️ [PROMPT-REWRITES] Rule ${JSON.stringify(pattern.source)} failed and was skipped: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

/**
 * Parse a rules file and apply it to one string.
 *
 * The convenience form, for tests and for any one-off caller holding the raw
 * parsed JSON. The providers do **not** use it: they compile once per turn via
 * `compilePromptRewriteRules` and pass the compiled list down, because this
 * form re-parses and re-compiles on every call and the payload helpers call it
 * once per message part.
 */
export function applyPromptRewrites(text: string, rawConfig: unknown): string {
  return applyCompiledPromptRewrites(text, compilePromptRewriteRules(normalizePromptRewriteRules(rawConfig)));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Outbound payload helpers.
 *
 * Both providers build their send payload before the rewrites run, so these
 * return **new** arrays and **new** content objects and leave the caller's
 * structure untouched. That is what lets the dashboard's activity log capture
 * the original text from the same objects: whoever runs the log first still
 * sees the real names, whichever order the two run in.
 *
 * These take an ALREADY-COMPILED list, so the cost per turn is one
 * normalisation + compilation rather than one per message part.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Rewrite the text of OpenAI-shaped messages: `{ role, content }` where
 * `content` is a string or an array of parts carrying a `text` field.
 *
 * Constrained to bare `object` rather than `{ content: unknown }` on purpose:
 * OpenAI's own `ChatCompletionMessageParam` union declares `content` as
 * *optional* on some members, so a stricter constraint would reject exactly the
 * type this is called with and force a cast at the call site. The shapes are
 * read defensively below instead — an unrecognised one passes through.
 *
 * Non-text parts (image URLs, inline media) pass through by reference — there
 * is no text in them to rewrite, and copying base64 blobs would be wasteful.
 * The system message is rewritten too: it is the message that carries
 * `<current-user name="…">` and `<mentioned-users>`, which is where a username
 * reaches the model most often.
 */
export function rewriteOpenAIMessages<T extends object>(
  messages: readonly T[],
  compiled: readonly CompiledPromptRewrite[],
): T[] {
  if (compiled.length === 0) return messages.slice();

  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      return { ...message, content: applyCompiledPromptRewrites(content, compiled) };
    }
    if (Array.isArray(content)) {
      return { ...message, content: content.map((part: unknown) => rewriteTextBearingPart(part, compiled)) };
    }
    return message;
  });
}

/**
 * Rewrite the text parts of Gemini `contents`, i.e. `{ role, parts: [...] }`.
 *
 * Gemini carries the persona as a separate `systemInstruction`, so this covers
 * the conversation turns only — the system prompt is rewritten separately, at
 * the same boundary. `convertMessages()` also returns a `systemInstruction`
 * derived from any `system` message in the input, but both call sites discard
 * it in favour of `buildSystemPrompt()` and never send it.
 */
export function rewriteGeminiContents<T extends object>(
  contents: readonly T[],
  compiled: readonly CompiledPromptRewrite[],
): T[] {
  if (compiled.length === 0) return contents.slice();

  return contents.map((content) => {
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return content;
    return { ...content, parts: parts.map((part: unknown) => rewriteTextBearingPart(part, compiled)) };
  });
}

/**
 * Copy one content part with its `text` rewritten, if it has any.
 *
 * Shared by both providers because the two part shapes differ only in the
 * `type` discriminator, which the spread preserves. Anything without a string
 * `text` is returned unchanged.
 */
function rewriteTextBearingPart(part: unknown, compiled: readonly CompiledPromptRewrite[]): unknown {
  if (part === null || typeof part !== 'object') return part;
  const text = (part as Record<string, unknown>)['text'];
  if (typeof text !== 'string') return part;
  return { ...(part as Record<string, unknown>), text: applyCompiledPromptRewrites(text, compiled) };
}