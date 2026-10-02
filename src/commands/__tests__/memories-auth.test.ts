import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';
import { readFileSync } from 'node:fs';

/**
 * `/memories` had two authorisation gates and they contradicted each other.
 *
 * `ownerOnlySubcommands: ['list','view','clear','clear-user']` is checked in
 * `bot/client.ts` *before* `execute()` runs, and it compares only against
 * `config.bot.ownerId`. So by the time the in-`execute`
 * `canRunPrivilegedCommand(...)` check ran, only the owner could ever have got
 * there: the "or hold a trusted role" branch was unreachable. The comment above
 * it described a code path that could not execute, and the subcommand
 * descriptions still said "(Mod Only)" — while `/ratelimit` and `/boredom`,
 * which have no `ownerOnly` gate, made that branch genuinely live.
 *
 * The fix keeps the role gate live for the two *reads* (both now guild-scoped)
 * and keeps the two cross-guild *erasures* owner-only. These tests assert both
 * halves, because the failure mode of this bug is a gate quietly becoming dead
 * code again.
 */

const source = readFileSync(join(REPO_ROOT, 'src', 'commands', 'memories.ts'), 'utf8');

/** Extract the `ownerOnlySubcommands` array from the command literal. */
function ownerOnlySubcommands(): string[] {
  const match = /ownerOnlySubcommands:\s*\[([^\]]*)\]/.exec(source);
  if (!match?.[1]) throw new Error('ownerOnlySubcommands not found in memories.ts');
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('/memories — the role gate is reachable', () => {
  test('list and view are NOT owner-only, so a trusted role can reach them', () => {
    const gated = ownerOnlySubcommands();
    expect(gated).not.toContain('list');
    expect(gated).not.toContain('view');
  });

  test('the two cross-guild erasures ARE owner-only', () => {
    // These are the ones `bot/client.ts` owner-gates: `clear` wipes every guild
    // and `clear-user` erases a person everywhere. Guild-scoped authority must
    // not reach either.
    const gated = ownerOnlySubcommands();
    expect(gated).toContain('clear');
    expect(gated).toContain('clear-user');
  });

  test('the in-execute privileged gate is still there and is the live one', () => {
    expect(source).toContain('canRunPrivilegedCommand(interaction.user.id, interaction.member)');
  });

  test('the erasures carry a second, explicit owner check', () => {
    // Defence in depth. If a future edit drops `clear`/`clear-user` from
    // `ownerOnlySubcommands`, the role gate below would otherwise admit them.
    expect(source).toMatch(/subcommand === 'clear' \|\| subcommand === 'clear-user'/);
    expect(source).toContain('interaction.user.id !== config.bot.ownerId');
  });

  test('the erasures are checked BEFORE the role gate', () => {
    // Ordering matters: the owner check must run first, or a trusted role is
    // authorised before anything narrows them.
    const ownerCheck = source.indexOf("subcommand === 'clear' || subcommand === 'clear-user'");
    const roleGate = source.indexOf('canRunPrivilegedCommand(interaction.user.id');
    expect(ownerCheck).toBeGreaterThan(-1);
    expect(roleGate).toBeGreaterThan(ownerCheck);
  });

  test('reads stay guild-scoped, so a trusted role cannot read another guild', () => {
    expect(source).toContain('userMemoryService.listUsers(guildId)');
    expect(source).toContain('userMemoryService.getOpinionByUsername(username, guildId)');
    expect(source).toContain('const guildId = interaction.guildId ?? undefined;');
  });

  test('the erasures are the only ones NOT scoped to the guild, deliberately', () => {
    // `listMemorySummaries()` and `deleteOpinion(userId)` with no guild are the
    // owner's "forget everything" escape hatch — a partial delete is a privacy
    // failure, so erasure defaults to every scope.
    expect(source).toContain('userMemoryService.listMemorySummaries()');
    expect(source).toContain('userMemoryService.deleteOpinion(userId)');
  });
});

describe('/memories — descriptions match the gates', () => {
  test('no description still claims "(Mod Only)"', () => {
    // The lie that made this bug hard to spot from the Discord UI. Only the
    // `setDescription(...)` lines are checked — the explanatory comment quotes
    // the old wording on purpose.
    const descriptions = source.split('\n').filter((line) => /^\s*\.setDescription\(/.test(line));
    expect(descriptions.length).toBeGreaterThan(0);
    for (const line of descriptions) {
      expect(line).not.toContain('(Mod Only)');
    }
  });

  test('the read subcommands say owner or trusted role', () => {
    expect(source).toContain('(owner or trusted role)');
    expect((source.match(/\(owner or trusted role\)/g) ?? [])).toHaveLength(2);
  });

  test('the write subcommands say owner only', () => {
    expect(source).toContain("setDescription('Clear all memories in every server (owner only)')");
    expect(source).toContain("(owner only)')");
  });
});

describe('/memories — mention hardening', () => {
  test('every reply carries allowedMentions', () => {
    const replySites = source.split('\n').filter((line) => /\.(reply|editReply|update)\(\{/.test(line));
    expect(replySites.length).toBeGreaterThan(0);
    // Every reply in this file is multi-line, so the check is on the options
    // object as a whole; count `allowedMentions` against reply sites.
    const mentions = (source.match(/allowedMentions: buildAllowedMentions\(\)/g) ?? []).length;
    expect(mentions).toBeGreaterThanOrEqual(replySites.length);
  });

  test('the echoed username is neutralised before it reaches content', () => {
    // `/memories view @everyone` was its own ping.
    expect(source).toContain('neutralizeMentions(username)');
    expect(source).toContain('neutralizeMentions(opinion?.username || userId)');
  });
});