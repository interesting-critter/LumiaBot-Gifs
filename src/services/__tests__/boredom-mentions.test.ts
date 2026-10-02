import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../../utils/paths';
import { buildAllowedMentions } from '../../utils/permissions';

/**
 * `services/boredom.ts` sent spontaneous chatter with a hand-rolled
 * `allowedMentions: { parse: [] }` while every other model-output path had been
 * consolidated onto `buildAllowedMentions()`. Left alone, that invites the next
 * agent to "fix" it into the helper — so this test pins both the consolidation
 * and the fact that the two are behaviourally identical here.
 *
 * The identical part is the load-bearing bit: `channel.send` has no replied
 * message, so the helper's `repliedUser: false` cannot suppress anything, and
 * `users: []` is equivalent to not passing `users`. If that ever stops being
 * true (someone switches to `reply()`), this test's comment in the source is
 * what a reviewer needs to catch it.
 */

const source = readFileSync(join(REPO_ROOT, 'src', 'services', 'boredom.ts'), 'utf8');

describe('boredom — mention hardening is consolidated', () => {
  test('the chatter send uses the shared helper', () => {
    expect(source).toContain('allowedMentions: buildAllowedMentions()');
  });

  test('the helper is imported from utils/permissions', () => {
    expect(source).toContain("import { buildAllowedMentions } from '../utils/permissions'");
  });

  test('no hand-rolled parse:[] shape remains in this file', () => {
    // The drift this test exists to prevent.
    expect(source).not.toMatch(/allowedMentions:\s*\{\s*parse/);
  });

  test('the reason the semantics match is documented at the call site', () => {
    // A future reader who wonders whether `repliedUser: false` changed the
    // behaviour should find the answer where they are looking.
    expect(source).toContain('repliedUser: false');
    expect(source).toContain('behaviourally identical');
  });

  test('the consolidated form really is equivalent for a fresh channel send', () => {
    const shared = buildAllowedMentions();
    const previous = { parse: [] };

    // Same no-mentions guarantee...
    expect(shared.parse).toEqual(previous.parse as never[]);
    // ...same explicit-allowlist shape (empty)...
    expect(shared.users).toEqual([]);
    // ...and `repliedUser` is inert because there is no replied message.
    expect(shared.repliedUser).toBe(false);
  });
});