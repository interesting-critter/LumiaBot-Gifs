import { describe, expect, test } from 'bun:test';
import { formatPromptForLog } from '../dashboard-logger';

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

/** The `[system]` heading is the exact marker the dashboard view renders. */
function countSystemBlocks(rendered: string): number {
  return countOccurrences(rendered, '[system]');
}

const SYSTEM = 'You are Lumia. Stay in character.\nNever break the fourth wall.';

describe('formatPromptForLog', () => {
  test('emits the system prompt once when messages[0] is that same system prompt', () => {
    // This is the shape openai.ts:1225 actually passes: `systemPrompt` as the
    // first argument, and `enhancedMessages` (openai.ts:1163) whose element [0]
    // IS the system prompt.
    const rendered = formatPromptForLog(SYSTEM, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi, what can I do for you?' },
      { role: 'user', content: 'draw me a cat' },
    ]);

    expect(countSystemBlocks(rendered)).toBe(1);
    expect(countOccurrences(rendered, SYSTEM)).toBe(1);

    // Headings present, in order, system first.
    const systemAt = rendered.indexOf('[system]');
    const userAt = rendered.indexOf('[user]');
    const assistantAt = rendered.indexOf('[assistant]');
    expect(systemAt).toBe(0);
    expect(userAt).toBeGreaterThan(systemAt);
    expect(assistantAt).toBeGreaterThan(userAt);
    expect(rendered).toContain('[user]\ndraw me a cat');
  });

  test('empty or whitespace system prompts render no [system] block', () => {
    for (const blank of ['', '   ', '\n\n\t ']) {
      const rendered = formatPromptForLog(blank, [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);

      expect(countSystemBlocks(rendered)).toBe(0);
      expect(rendered).not.toContain('[system]');
      // The conversation still renders, unchanged.
      expect(rendered).toBe('[user]\nhi\n\n[assistant]\nhello');
    }
  });

  test('a blank system prompt plus system messages in the array renders no [system] block', () => {
    // Defensive pairing: the explicit argument wins, so an array-supplied system
    // entry is dropped rather than promoted.
    const rendered = formatPromptForLog('  ', [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'hi' },
    ]);

    expect(countSystemBlocks(rendered)).toBe(0);
    expect(rendered).toBe('[user]\nhi');
  });

  test('repeated system entries in the array still collapse to one [system] block', () => {
    const rendered = formatPromptForLog(SYSTEM, [
      { role: 'system', content: SYSTEM },
      { role: 'system', content: `${SYSTEM}\n(edited)` },
      { role: 'user', content: 'hi' },
      { role: 'system', content: SYSTEM },
      { role: 'assistant', content: 'hello' },
    ]);

    expect(countSystemBlocks(rendered)).toBe(1);
    // The explicit argument is the single source of truth; array copies of the
    // system prompt are not emitted at all, so their differing text is absent.
    expect(rendered).not.toContain('(edited)');
    expect(countOccurrences(rendered, SYSTEM)).toBe(1);
    expect(rendered).toBe(`[system]\n${SYSTEM}\n\n[user]\nhi\n\n[assistant]\nhello`);
  });

  test('a user turn that echoes the system prompt counts its echo, not a duplicate heading', () => {
    // Guards the naive "count occurrences of the system text" assertion: the
    // user's own text is legitimately identical, so the expected count is 2
    // (the [system] block plus the echo). The buggy renderer emits 3.
    const rendered = formatPromptForLog(SYSTEM, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: SYSTEM },
      { role: 'assistant', content: 'got it' },
    ]);

    expect(countSystemBlocks(rendered)).toBe(1);
    expect(countOccurrences(rendered, SYSTEM)).toBe(2);
    expect(rendered).toBe(`[system]\n${SYSTEM}\n\n[user]\n${SYSTEM}\n\n[assistant]\ngot it`);
  });

  test('Gemini-shaped input (user/assistant only) is unchanged', () => {
    // google-genai.ts:1901 passes `contents` mapped to user/assistant, because
    // the persona rides along as `systemInstruction` rather than inside the
    // contents array. That path was never duplicated and must stay untouched.
    const rendered = formatPromptForLog(SYSTEM, [
      { role: 'user', content: 'Stay in character\n\nhello there' },
      { role: 'assistant', content: 'hi, what can I do for you?' },
    ]);

    expect(rendered).toBe(
      `[system]\n${SYSTEM}\n\n[user]\nStay in character\n\nhello there\n\n[assistant]\nhi, what can I do for you?`,
    );
    expect(countSystemBlocks(rendered)).toBe(1);
    expect(countOccurrences(rendered, SYSTEM)).toBe(1);
  });
});
