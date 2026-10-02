import { strEnv } from './env';

/**
 * The host allowlist for media the bot fetches **server-side** on behalf of a
 * Discord-supplied URL.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Discord lets `embed.image.url` / `embed.thumbnail.url` / `embed.video.url` be
 * an arbitrary http(s) URL on any host — there is no Discord-CDN restriction at
 * the API level. The bot has to download those bytes itself (Discord CDN URLs
 * carry an auth token no external model vendor can use, so they are base64
 * inlined into an outbound request). That makes the list an SSRF sink and an
 * exfiltration channel, so it has to be closed — but closing it to *only*
 * Discord silently breaks a real feature: Tenor and Giphy `gifv` embeds point
 * `video.url` at `media.tenor.com` / `media.giphy.com`, not at a Discord host.
 *
 * Hence a configurable, *additive* allowlist. Defaults to Discord's CDN
 * wildcards (regional siblings such as `cdn-eu.discordapp.com` and the newer
 * `media.discordapp.net` mean exact hosts are the wrong shape), and an operator
 * can extend it with the GIF providers they actually use.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * There is no second, "looser" matcher in this file. Host matching, wildcard
 * semantics, userinfo rejection and the `.internal`-suffix rules all stay in
 * `safe-fetch.ts`; this module only produces the list that gets handed to
 * `allowHosts`, so both call sites go through exactly one implementation.
 */

/** Used when `DISCORD_MEDIA_ALLOWED_HOSTS` is unset or blank. */
const DEFAULT_MEDIA_ALLOWED_HOSTS = ['*.discordapp.com', '*.discordapp.net'] as const;

/** A host label: alphanumeric ends, hyphens allowed inside. */
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A single allowlist entry: a dotted sequence of host labels, optionally
 * prefixed with `*.` for the sub-domain wildcard. Deliberately strict — a
 * scheme, a port, a path or an inner `*` means the operator wrote something that
 * could never match a URL host anyway, so it is dropped rather than silently
 * accepted as dead config.
 */
function isValidHostEntry(entry: string): boolean {
  const base = entry.startsWith('*.') ? entry.slice(2) : entry;
  if (base === '' || base.includes('*')) return false;
  return base.split('.').every((label) => HOST_LABEL.test(label));
}

/**
 * Parse a comma-separated allowlist. Returns the entries, lowercased, in order,
 * de-duplicated. Unparseable entries are dropped and reported via `onDrop`.
 *
 * Exported for tests; production code goes through {@link mediaAllowedHosts}.
 */
export function parseMediaAllowedHosts(raw: string, onDrop?: (entry: string) => void): string[] {
  const out: string[] = [];

  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (entry === '') continue;

    if (!isValidHostEntry(entry)) {
      onDrop?.(part.trim());
      continue;
    }

    if (!out.includes(entry)) out.push(entry);
  }

  return out;
}

// One warning per distinct bad entry, so a hot path that reads this on every
// URL does not turn a typo into a log flood.
const warnedEntries = new Set<string>();

function warnDropped(entry: string): void {
  if (warnedEntries.has(entry)) return;
  warnedEntries.add(entry);
  console.warn(
    `⚠️  [MEDIA ALLOWLIST] Ignoring unusable DISCORD_MEDIA_ALLOWED_HOSTS entry "${entry}" — ` +
      `expected a bare host or a wildcard such as "media.tenor.com" / "*.tenor.com".`,
  );
}

/**
 * The host allowlist currently in force.
 *
 * Read fresh on each call (it is a `split` over a short string, and the two
 * call sites are once per inbound message) so that it is trivially testable and
 * so an operator editing the environment does not need a restart path of a
 * different shape than the rest of the config.
 *
 * Unset or blank → Discord's CDN wildcards. When set, the operator's list is
 * used verbatim, so it is a *replacement* that can extend the defaults or
 * narrow them; anyone extending it must keep the Discord entries or every
 * Discord-supplied attachment and embed stops being fetched.
 */
export function mediaAllowedHosts(): string[] {
  const raw = strEnv('DISCORD_MEDIA_ALLOWED_HOSTS', '');
  if (raw.trim() === '') return [...DEFAULT_MEDIA_ALLOWED_HOSTS];
  return parseMediaAllowedHosts(raw, warnDropped);
}

/** Test-only: forget which bad entries have already been warned about. */
export function resetMediaAllowlistWarnings(): void {
  warnedEntries.clear();
}