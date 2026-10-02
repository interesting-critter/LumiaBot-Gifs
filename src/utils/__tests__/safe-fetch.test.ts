import { describe, expect, mock, test } from 'bun:test';

/**
 * `safe-fetch.ts` is the SSRF boundary for every user-supplied URL the bot
 * fetches (links pasted in Discord messages). The bug it fixes: a member of any
 * server could post `http://169.254.169.254/latest/meta-data/` or
 * `http://127.0.0.1:3001/api/persona` and have the bot read it and hand the
 * contents to the model vendor.
 *
 * These tests are pure — no DNS and no sockets — so nothing here reaches a
 * private host or a real network.
 *
 * `assertPublicUrl` only calls `lookup()` when a hostname survives every
 * cheaper check, which is one branch of these tests. Rather than let that
 * branch perform a live `lookup('example.com')` — which fails for reasons
 * unrelated to the code on an offline phone or in a sandboxed CI — DNS is
 * stubbed below. The stub is process-global, so it doubles as a canary: any
 * *other* test that starts resolving real hostnames hits the throw and fails
 * loudly instead of quietly reaching the network.
 */

/** Hostnames the stub knows, mapped to the addresses they resolve to. */
const DNS_ANSWERS: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
  // All-public answer: must be accepted.
  'public.example': [{ address: '93.184.216.34', family: 4 }],
  // All-private answer: must be refused.
  'private.example': [{ address: '10.0.0.5', family: 4 }],
  // Rebinding attempt: one public + one private in the same answer. The rule is
  // "any", not "all" — this is the case a naive implementation gets wrong.
  'rebound.example': [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ],
  'v6.example': [{ address: '2606:4700:4700::1111', family: 6 }],
};

const dnsLookups: string[] = [];

mock.module('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    dnsLookups.push(hostname);
    const answer = DNS_ANSWERS[hostname];
    if (!answer) {
      throw new Error(`stubbed resolver has no answer for "${hostname}"`);
    }
    return answer;
  },
}));

// Imported dynamically so the stub is installed first. Bun re-links
// already-loaded modules on `mock.module`, so this stays order-independent even
// when another test file imported `../safe-fetch` earlier in the process.
const { assertPublicUrl, isPrivateAddress, ResponseTooLargeError, safeFetchBuffer } = await import(
  '../safe-fetch'
);

describe('isPrivateAddress — loopback and unspecified', () => {
  test.each([
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.254',
    '0.0.0.0',
    '0.1.2.3',
    '::1',
    '::',
    '0:0:0:0:0:0:0:1',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
});

describe('isPrivateAddress — link-local', () => {
  test.each(['169.254.169.254', '169.254.0.1', '169.254.255.255', 'fe80::1', 'fe80::abcd:1234', 'febf::1'])(
    '%s is private',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    },
  );

  test('169.253.0.1 and 169.255.0.1 are outside the link-local block', () => {
    expect(isPrivateAddress('169.253.0.1')).toBe(false);
    expect(isPrivateAddress('169.255.0.1')).toBe(false);
  });
});

describe('isPrivateAddress — RFC1918', () => {
  test.each([
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.1.1',
    '192.168.255.255',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test('172.15.x and 172.32.x are outside 172.16.0.0/12', () => {
    expect(isPrivateAddress('172.15.255.255')).toBe(false);
    expect(isPrivateAddress('172.32.0.0')).toBe(false);
  });
});

describe('isPrivateAddress — IPv6 ULA, multicast, broadcast', () => {
  test.each([
    'fc00::1',
    'fd00::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'ff02::1',
    'ff00::',
    '255.255.255.255',
    '224.0.0.1',
    '239.255.255.250',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test('febf:... is the end of fe80::/10 and fbff:... is outside it', () => {
    expect(isPrivateAddress('fbff::1')).toBe(false);
  });
});

describe('isPrivateAddress — IPv4-mapped and NAT64 IPv6', () => {
  test.each([
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    '::ffff:169.254.169.254',
    '::ffff:192.168.1.1',
    '::ffff:0:0',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test('an IPv4-mapped public address stays public', () => {
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  test('NAT64 wrapping a private IPv4 is private', () => {
    expect(isPrivateAddress('64:ff9b::127.0.0.1')).toBe(true);
  });
});

describe('isPrivateAddress — public addresses', () => {
  test.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '93.184.216.34',
  ])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('isPrivateAddress — fails closed', () => {
  test.each(['not-an-ip', '', 'example.com', '999.999.999.999', '0x7f.0.0.1', '127.1'])(
    '%s is reported private',
    (value) => {
      expect(isPrivateAddress(value)).toBe(true);
    },
  );

  test('normalises brackets, zone ids, case and trailing dots', () => {
    expect(isPrivateAddress('[::1]')).toBe(true);
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
    expect(isPrivateAddress('127.0.0.1.')).toBe(true);
    expect(isPrivateAddress('FE80::ABCD')).toBe(true);
  });
});

describe('assertPublicUrl — rejects non-http schemes', () => {
  test.each([
    'file:///etc/passwd',
    'gopher://127.0.0.1:11270/_stats',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/x',
    'blob:https://example.com/abc',
  ])('%s throws', async (raw) => {
    await expect(assertPublicUrl(raw)).rejects.toThrow();
  });
});

describe('assertPublicUrl — rejects private literals without touching DNS', () => {
  test.each([
    'http://127.0.0.1/',
    'http://127.0.0.1:3001/api/persona',
    'http://[::1]/',
    'http://[::1]:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://0.0.0.0/',
    'http://255.255.255.255/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
  ])('%s throws', async (raw) => {
    await expect(assertPublicUrl(raw)).rejects.toThrow(/non-public|private/i);
  });
});

describe('assertPublicUrl — rejects private-suffix hostnames', () => {
  test.each([
    'http://foo.internal/',
    'http://x.local/',
    'http://printer.localhost/',
    'http://nas.home.arpa/',
    'http://localhost/',
  ])('%s throws', async (raw) => {
    await expect(assertPublicUrl(raw)).rejects.toThrow(/private/i);
  });
});

describe('assertPublicUrl — rejects embedded credentials', () => {
  test('userinfo is refused', async () => {
    await expect(assertPublicUrl('http://user:pass@example.com/')).rejects.toThrow(/credentials/i);
  });
});

describe('assertPublicUrl — accepts a public host', () => {
  test('a public IP literal skips DNS entirely', async () => {
    const before = dnsLookups.length;
    const url = await assertPublicUrl('https://8.8.8.8/path');
    expect(url.hostname).toBe('8.8.8.8');
    // No resolver call is the whole point of the literal fast path.
    expect(dnsLookups.length).toBe(before);
  });

  test('a hostname resolving only to public addresses is accepted', async () => {
    const before = dnsLookups.length;
    const url = await assertPublicUrl('https://public.example/');
    expect(url.hostname).toBe('public.example');
    expect(dnsLookups.length).toBe(before + 1);
    expect(dnsLookups.at(-1)).toBe('public.example');
  });

  test('a public IPv6 answer is accepted', async () => {
    await expect(assertPublicUrl('https://v6.example/')).resolves.toBeDefined();
  });
});

describe('assertPublicUrl — DNS answers', () => {
  test('a hostname resolving to a private address is refused', async () => {
    await expect(assertPublicUrl('https://private.example/')).rejects.toThrow(/non-public address 10\.0\.0\.5/);
  });

  test('one private address in an otherwise-public answer is refused (rebinding)', async () => {
    // "Any", not "all": a mixed answer is a rebinding attempt, not a mistake.
    await expect(assertPublicUrl('https://rebound.example/')).rejects.toThrow(
      /non-public address 127\.0\.0\.1/,
    );
  });

  test('a resolver failure is surfaced, not treated as public', async () => {
    // The stub throws for anything it does not know, standing in for a host
    // that does not exist. Failing open here would be the SSRF hole.
    await expect(assertPublicUrl('https://nonexistent.example/')).rejects.toThrow(/DNS lookup failed/);
  });
});

describe('assertPublicUrl — allowHosts pinning', () => {
  const allowHosts = ['cdn.discordapp.com', 'media.discordapp.net'];

  test('accepts an allowlisted host without DNS', async () => {
    const url = await assertPublicUrl('https://cdn.discordapp.com/attachments/1/2/file.mp4', { allowHosts });
    expect(url.hostname).toBe('cdn.discordapp.com');
  });

  test('accepts a sub-domain of an allowlisted host', async () => {
    await expect(assertPublicUrl('https://a.cdn.discordapp.com/x', { allowHosts })).resolves.toBeDefined();
  });

  test('a wildcard entry covers sub-domains but not the bare domain', async () => {
    const wildcard = ['*.discordapp.com'];
    await expect(assertPublicUrl('https://cdn-eu.discordapp.com/x', { allowHosts: wildcard })).resolves.toBeDefined();
    await expect(assertPublicUrl('https://discordapp.com/x', { allowHosts: wildcard })).rejects.toThrow(/allowlist/i);
  });

  test('a sibling host is not covered — Discord CDN regionals need a wildcard', async () => {
    // Regression guard: `cdn-eu.discordapp.com` is a *sibling* of
    // `cdn.discordapp.com`, not a sub-domain, so an exact entry misses it.
    await expect(assertPublicUrl('https://cdn-eu.discordapp.com/x', { allowHosts })).rejects.toThrow(/allowlist/i);
  });

  test('rejects a host that is not allowlisted', async () => {
    await expect(assertPublicUrl('https://evil.example/x', { allowHosts })).rejects.toThrow(/allowlist/i);
  });

  test('rejects a suffix-confusion host', async () => {
    await expect(assertPublicUrl('https://notcdn.discordapp.com.evil.test/x', { allowHosts })).rejects.toThrow(
      /allowlist/i,
    );
  });

  test('an allowlisted host is still refused when it carries a private suffix', async () => {
    await expect(assertPublicUrl('https://cdn.discordapp.com.internal/', { allowHosts })).rejects.toThrow(
      /private/i,
    );
  });

  test('an allowlisted host is still refused for a non-http scheme', async () => {
    await expect(assertPublicUrl('file://cdn.discordapp.com/x', { allowHosts })).rejects.toThrow(/scheme/i);
  });
});

describe('safeFetchBuffer — response cap', () => {
  test('exports ResponseTooLargeError for callers to narrow on', () => {
    expect(new ResponseTooLargeError(10).name).toBe('ResponseTooLargeError');
    expect(new ResponseTooLargeError(10).maxBytes).toBe(10);
  });

  test('rejects a non-positive maxBytes before making any request', async () => {
    await expect(safeFetchBuffer('http://127.0.0.1/', { maxBytes: 0 })).rejects.toThrow(TypeError);
  });
});
