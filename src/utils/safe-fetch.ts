import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF-hardened fetch helpers.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The bot scrapes URLs that appear verbatim in Discord messages. Every member of
 * every server the bot is in can type a link, and the old code did a plain
 * `fetch(url, { redirect: 'follow' })` on it. That is a textbook SSRF sink:
 *
 *   http://127.0.0.1:3001/api/persona      -> the bot's own dashboard
 *   http://169.254.169.254/latest/meta-data/ -> cloud instance credentials
 *   http://10.0.0.5/ , http://192.168.1.1/  -> anything on the LAN
 *
 * and because `redirect: 'follow'` is automatic, a perfectly public host can
 * 302 to a private one and the check (even if it existed) would be bypassed.
 * The response body then went straight into the LLM system prompt, so the
 * stolen bytes were also exfiltrated to the model vendor.
 *
 * The rules applied here, in order:
 *   1. Scheme must be `http:` or `https:`. `file:`, `gopher:`, `data:`,
 *      `ftp:`, `blob:` etc. are rejected outright.
 *   2. No `user:password@` in the URL (credential-smuggling confusion vector).
 *   3. Hostnames ending in `.local`, `.internal`, `.localhost` or `.home.arpa`
 *      are rejected — these are split-horizon names that never appear on the
 *      public internet but always resolve somewhere internal.
 *   4. A bare IP literal is rejected when it falls in a private/reserved range.
 *   5. A hostname is resolved and rejected if **any** returned address is
 *      private. "Any" and not "all" on purpose: a DNS answer mixing one public
 *      and one private address is a rebinding attempt, not a mistake.
 *   6. Redirects are followed manually, and every hop is re-validated from
 *      step 1. A 302 to `169.254.169.254` is the actual attack, so validating
 *      only the first URL is not a defence at all.
 *
 * Remaining caveat (stated rather than hidden): this validates the URL, not the
 * socket. Between our `lookup()` and the socket `connect()` the answer can
 * change (DNS rebinding). Closing that properly means pinning the resolved
 * address into the connection, which `fetch` does not expose. The DNS answer is
 * therefore cached for the duration of a single request chain and re-checked on
 * every hop; treat this as a strong mitigation, not a proof.
 */

/** Maximum redirect hops followed by {@link safeFetch}. Each is re-validated. */
const MAX_REDIRECTS = 3;

/** Default wall-clock budget for a whole request, headers included. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default response ceiling for {@link safeFetchBuffer} / {@link safeFetchText}. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Hostname suffixes that only ever resolve inside a private network. Rejected
 * before DNS so a hostile `/etc/hosts` entry cannot even be consulted.
 */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'] as const;

/**
 * Hostnames that are private on their own, with no dot to hang a suffix off.
 * `localhost` is the obvious one; a bare `local`/`internal` resolves via the
 * search domain to something on the LAN just as reliably.
 */
const PRIVATE_HOSTNAMES = new Set(['localhost', 'local', 'internal', 'home.arpa']);

export interface SafeFetchOptions {
  /** Hard ceiling on the response body, enforced while streaming. */
  maxBytes?: number;
  /** Wall-clock budget in ms for the entire request, including redirects. */
  timeoutMs?: number;
  /** Value for the `Accept` header. */
  accept?: string;
  /**
   * Operator-pinned host allowlist. When provided, the URL host must match one
   * of these entries and the DNS / private-IP checks are skipped — the
   * operator is vouching for the host.
   *
   * Entries are either an exact host (`cdn.discordapp.com`, which also covers
   * its sub-domains) or a wildcard (`*.discordapp.com`, which covers
   * sub-domains only). Matching is on dot boundaries, never a bare suffix.
   *
   * Intended use: Discord's CDN. Note that Discord serves regional hosts such
   * as `cdn-eu.discordapp.com`, so a wildcard entry is usually what you want:
   *
   *     { allowHosts: ['*.discordapp.com', '*.discordapp.net'] }
   */
  allowHosts?: string[];
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** HTTP method. Defaults to `GET`. */
  method?: string;
}

export interface SafeFetchResult {
  response: Response;
  /** Final URL after redirects — this, not the input, is what was validated last. */
  url: string;
}

export interface SafeFetchBufferResult {
  buffer: ArrayBuffer;
  contentType: string;
  url: string;
}

export interface SafeFetchTextResult {
  text: string;
  contentType: string;
  url: string;
}

/** Thrown when a URL or a redirect target fails SSRF validation. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/** Thrown when a response body exceeds the configured byte cap. */
export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Response body exceeded the ${maxBytes} byte limit`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

// ---------------------------------------------------------------------------
// IP parsing / classification
// ---------------------------------------------------------------------------

/**
 * Strict dotted-quad parser. Returns the four octets, or null.
 *
 * Deliberately stricter than `Number(s.split('.'))`: leading `+`/`-`, octal
 * notation (`010`), whitespace, hex, and short forms like `127.1` are all
 * rejected, because every mainstream HTTP client parses them the strict way and
 * a mismatch between "what I validated" and "what I connected to" is precisely
 * the bug class this file exists to remove.
 */
function parseIPv4(input: string): [number, number, number, number] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  return [octets[0] as number, octets[1] as number, octets[2] as number, octets[3] as number];
}

/**
 * Full RFC 4291 IPv6 parser, including `::` elision and a trailing IPv4 form
 * (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`). Returns eight 16-bit groups, or null.
 */
function parseIPv6(input: string): number[] | null {
  // Three or more colons in a row is never valid.
  if (input.includes(':::')) return null;

  const elision = input.indexOf('::');
  if (elision !== -1 && input.indexOf('::', elision + 1) !== -1) return null;

  const head = elision === -1 ? input : input.slice(0, elision);
  const tail = elision === -1 ? '' : input.slice(elision + 2);

  // The dotted-quad tail may only appear as the very last element of the whole
  // address, so it is only allowed when this segment ends the address.
  const parseGroups = (segment: string, allowIpv4Tail: boolean): number[] | null => {
    if (segment === '') return [];
    const pieces = segment.split(':');
    const groups: number[] = [];

    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] as string;

      if (piece.includes('.')) {
        if (!allowIpv4Tail || i !== pieces.length - 1) return null;
        const quad = parseIPv4(piece);
        if (!quad) return null;
        // An embedded IPv4 occupies the final two 16-bit groups.
        groups.push(((quad[0] << 8) | quad[1]) >>> 0, ((quad[2] << 8) | quad[3]) >>> 0);
        continue;
      }

      if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }

    return groups;
  };

  const headGroups = parseGroups(head, elision === -1);
  if (headGroups === null) return null;
  const tailGroups = parseGroups(tail, true);
  if (tailGroups === null) return null;

  if (elision === -1) {
    return headGroups.length === 8 ? headGroups : null;
  }

  // `::` must stand for at least one group of zeros.
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 1) return null;

  return [...headGroups, ...new Array<number>(fill).fill(0), ...tailGroups];
}

/** Strip `[...]`, a `%zone` suffix and trailing dots from a host string. */
function normalizeHost(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  const zone = out.indexOf('%');
  if (zone !== -1) out = out.slice(0, zone);
  while (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

/** True when `groups[0..prefix.length-1]` equals `prefix`. */
function hasPrefix(groups: number[], prefix: readonly number[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (groups[i] !== prefix[i]) return false;
  }
  return true;
}

/** Convert the final two 16-bit groups to the dotted octets of an embedded IPv4. */
function embeddedIPv4(groups: number[]): [number, number, number, number] {
  const high = groups[6] as number;
  const low = groups[7] as number;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** `::/96` — unspecified, loopback, and the deprecated IPv4-compatible form. */
const V4_COMPAT_PREFIX = [0, 0, 0, 0, 0, 0] as const;
/** `::ffff:0:0/96` — IPv4-mapped (`::ffff:127.0.0.1`). */
const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0xffff] as const;
/** `64:ff9b::/96` — NAT64 well-known prefix. */
const NAT64_PREFIX = [0x64, 0xff9b, 0, 0, 0, 0] as const;

/**
 * Is this address in a loopback, link-local, RFC1918, CGNAT, ULA, multicast,
 * reserved or otherwise non-public range?
 *
 * Fails **closed**: anything that is not a recognisable IP literal is reported
 * as private. Callers should never pass a hostname here (use
 * {@link assertPublicUrl}), and if one ever does, "not routable" is the safe
 * answer rather than "probably fine".
 */
export function isPrivateAddress(ip: string): boolean {
  const host = normalizeHost(ip);
  if (host === '') return true;

  const family = isIP(host);

  if (family === 4) {
    const quad = parseIPv4(host);
    if (!quad) return true;

    // 0.0.0.0/8        "this network" / unspecified (covers 0.0.0.0)
    if (quad[0] === 0) return true;
    // 10.0.0.0/8       RFC1918
    if (quad[0] === 10) return true;
    // 100.64.0.0/10    CGNAT
    if (quad[0] === 100 && quad[1] >= 64 && quad[1] <= 127) return true;
    // 127.0.0.0/8      loopback
    if (quad[0] === 127) return true;
    // 169.254.0.0/16   link-local (cloud metadata lives at 169.254.169.254)
    if (quad[0] === 169 && quad[1] === 254) return true;
    // 172.16.0.0/12    RFC1918
    if (quad[0] === 172 && quad[1] >= 16 && quad[1] <= 31) return true;
    // 192.0.0.0/24     IETF protocol assignments
    if (quad[0] === 192 && quad[1] === 0 && quad[2] === 0) return true;
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — documentation
    if (quad[0] === 192 && quad[1] === 0 && quad[2] === 2) return true;
    if (quad[0] === 198 && quad[1] === 51 && quad[2] === 100) return true;
    if (quad[0] === 203 && quad[1] === 0 && quad[2] === 113) return true;
    // 192.168.0.0/16   RFC1918
    if (quad[0] === 192 && quad[1] === 168) return true;
    // 198.18.0.0/15    benchmarking
    if (quad[0] === 198 && (quad[1] === 18 || quad[1] === 19)) return true;
    // 224.0.0.0/4      multicast
    if (quad[0] >= 224 && quad[0] <= 239) return true;
    // 240.0.0.0/4      reserved, includes 255.255.255.255 broadcast
    if (quad[0] >= 240) return true;

    return false;
  }

  if (family === 6) {
    const groups = parseIPv6(host);
    if (!groups) return true;

    // ::ffff:0:0/96 IPv4-mapped — recurse so ::ffff:127.0.0.1 and
    // ::ffff:169.254.169.254 are caught by the IPv4 rules above. Note the
    // URL parser rewrites these to hex form (`[::ffff:7f00:1]`), so this also
    // has to hold for callers that hand us a raw address string.
    if (hasPrefix(groups, V4_MAPPED_PREFIX)) {
      return isPrivateAddress(embeddedIPv4(groups).join('.'));
    }

    // ::/96: ::/128 unspecified, ::1/128 loopback, and the deprecated
    // IPv4-compatible form (::a.b.c.d), which also needs the IPv4 rules.
    if (hasPrefix(groups, V4_COMPAT_PREFIX)) {
      return true;
    }

    // 64:ff9b::/96 NAT64 — an embedded private IPv4 is a private target.
    if (hasPrefix(groups, NAT64_PREFIX)) {
      return isPrivateAddress(embeddedIPv4(groups).join('.'));
    }

    // 2001:db8::/32 documentation
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

    // fc00::/7 unique local addresses  (fc00..fdff)
    const first = groups[0] as number;
    if (first >= 0xfc00 && first <= 0xfdff) return true;

    // fe80::/10 link-local  (fe80..febf)
    if (first >= 0xfe80 && first <= 0xfebf) return true;

    // ff00::/8 multicast
    if (first >= 0xff00) return true;

    return false;
  }

  // Not an IP literal at all — fail closed.
  return true;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Does `host` match an allowlist entry?
 *
 * Two forms are supported:
 *   - `cdn.discordapp.com`  — exact host, or any sub-domain of it.
 *   - `*.discordapp.com`    — any sub-domain, but not the bare domain.
 *
 * Matching is always on a dot boundary, never a raw `endsWith`, so
 * `notcdn.discordapp.com` does not match `cdn.discordapp.com` and
 * `cdn.discordapp.com.evil.test` does not match either.
 */
function hostMatches(host: string, allowed: string): boolean {
  const target = normalizeHost(allowed);
  if (target === '') return false;

  if (target.startsWith('*.')) {
    const base = target.slice(2);
    if (base === '') return false;
    // Must have at least one label in front of the wildcard base.
    return host.endsWith(`.${base}`) && host.length > base.length + 1;
  }

  return host === target || host.endsWith(`.${target}`);
}

/**
 * Validate a URL for outbound fetching, or throw {@link BlockedUrlError}.
 *
 * On success returns the parsed `URL` so callers can reuse it instead of
 * re-parsing. Pass `allowHosts` to pin an operator-trusted host set; a pinned
 * host bypasses the DNS lookup and private-IP checks (the operator has vouched
 * for it) but is still subject to the scheme, userinfo and `.internal`-suffix
 * rules.
 *
 * @throws {BlockedUrlError} when the URL is malformed or points somewhere private.
 */
export async function assertPublicUrl(raw: string, opts?: { allowHosts?: string[] }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Malformed URL: ${truncate(raw)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Unsupported scheme "${url.protocol}" (only http/https are allowed)`);
  }

  if (url.username || url.password) {
    throw new BlockedUrlError('URLs with embedded credentials are not allowed');
  }

  // The URL parser keeps IPv6 literals bracketed (`[::1]`) and rewrites
  // IPv4-mapped ones to hex (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`),
  // so normalisation happens before any range check.
  const host = normalizeHost(url.hostname);
  if (host === '') {
    throw new BlockedUrlError('URL has no hostname');
  }

  if (PRIVATE_HOSTNAMES.has(host)) {
    throw new BlockedUrlError(`Refusing to fetch private hostname "${host}"`);
  }

  for (const suffix of PRIVATE_SUFFIXES) {
    if (host.endsWith(suffix)) {
      throw new BlockedUrlError(`Refusing to fetch private hostname "${host}"`);
    }
  }

  const allowHosts = opts?.allowHosts;
  if (allowHosts && allowHosts.length > 0) {
    if (!allowHosts.some((allowed) => hostMatches(host, allowed))) {
      throw new BlockedUrlError(`Host "${host}" is not in the configured allowlist`);
    }
    // Operator-pinned host: trust boundary stops here.
    return url;
  }

  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new BlockedUrlError(`Refusing to fetch non-public address "${host}"`);
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    // `all: true` so a multi-A/AAAA answer is checked in full, and `verbatim`
    // so the resolver's own ordering is preserved rather than being re-sorted.
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BlockedUrlError(`DNS lookup failed for "${host}": ${reason}`);
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(`DNS lookup returned no addresses for "${host}"`);
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new BlockedUrlError(
        `Refusing to fetch "${host}" — resolves to non-public address ${entry.address}`,
      );
    }
  }

  return url;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function truncate(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number, got ${value}`);
  }
  return Math.floor(value);
}

/** Resolve a possibly-relative `Location` header against the current URL. */
function resolveLocation(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

/**
 * Perform the request, following up to {@link MAX_REDIRECTS} redirects manually
 * and re-validating the target of **every** hop.
 */
async function requestWithValidatedRedirects(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const deadline = Date.now() + timeoutMs;

  const headers: Record<string, string> = { ...opts.headers };
  if (opts.accept && !('accept' in headers) && !('Accept' in headers)) {
    headers['Accept'] = opts.accept;
  }

  let currentUrl = rawUrl;
  let hop = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DOMException(`Request to ${truncate(currentUrl)} timed out after ${timeoutMs}ms`, 'TimeoutError');
    }

    // Re-validated every iteration: a public URL may 302 to a private one, and
    // that redirect is the actual attack.
    await assertPublicUrl(currentUrl, { allowHosts: opts.allowHosts });

    const response = await fetch(currentUrl, {
      method: opts.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
    });

    const isRedirect = response.status >= 300 && response.status < 400 && response.status !== 304;
    if (!isRedirect) {
      return { response, url: currentUrl };
    }

    const location = response.headers.get('location');
    // Release the connection; we are not going to read this body.
    await response.body?.cancel().catch(() => {});

    if (!location) {
      return { response, url: currentUrl };
    }

    hop += 1;
    if (hop > MAX_REDIRECTS) {
      throw new BlockedUrlError(`Exceeded ${MAX_REDIRECTS} redirects starting at ${truncate(rawUrl)}`);
    }

    const next = resolveLocation(location, currentUrl);
    if (!next) {
      throw new BlockedUrlError(`Unparseable redirect target ${truncate(location)}`);
    }
    currentUrl = next;
  }
}

/**
 * Read a response body, aborting the moment it exceeds `maxBytes`.
 *
 * Streaming rather than `arrayBuffer()`-then-check: the old code buffered the
 * whole body first and only compared lengths afterwards, so a hostile URL could
 * exhaust memory before the cap was ever consulted.
 */
async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = response.headers.get('content-length');
  if (declared) {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
  }

  if (!response.body) {
    const empty = await response.arrayBuffer();
    if (empty.byteLength > maxBytes) throw new ResponseTooLargeError(maxBytes);
    return empty;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored; the cap has still been enforced.
        }
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel().
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Fetch a URL with SSRF validation and a hard timeout. The response body is
 * **not** consumed — read it (bounded, via {@link safeFetchBuffer}) or cancel it.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  return requestWithValidatedRedirects(rawUrl, opts);
}

/** {@link safeFetch} plus a streaming `maxBytes` cap. */
export async function safeFetchBuffer(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchBufferResult> {
  const maxBytes = positiveInt(opts.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const { response, url } = await requestWithValidatedRedirects(rawUrl, opts);

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Request to ${truncate(url)} failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const buffer = await readCapped(response, maxBytes);
  return { buffer, contentType, url };
}

/** {@link safeFetchBuffer} with a UTF-8 decode. */
export async function safeFetchText(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchTextResult> {
  const { buffer, contentType, url } = await safeFetchBuffer(rawUrl, opts);
  return { text: new TextDecoder('utf-8').decode(buffer), contentType, url };
}
