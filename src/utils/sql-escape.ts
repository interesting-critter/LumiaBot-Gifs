/**
 * The one LIKE-wildcard escaper in this codebase.
 *
 * WHY A SHARED MODULE
 * -------------------
 * Three services each grew their own byte-identical copy of this helper
 * (`services/music.ts`, `services/user-memory.ts`, and an inline
 * `.replace(/[\\%_]/g, …)` inside `services/knowledge-graph.ts` while it was
 * building the `LIKE ? ESCAPE '\'` bind list). Copies of a *security* helper are
 * the problem: a fix applied to one copy silently leaves the other two
 * vulnerable, and a reviewer reading `searchTracks` has no way to know a third
 * implementation exists. One implementation, one place to audit.
 *
 * WHY IT IS NEEDED AT ALL
 * ----------------------
 * Values are always bound as parameters, so there is no SQL-injection risk from
 * them. `%` and `_` are still *pattern* metacharacters inside the bound string,
 * which is a different failure: `/music search %` built `'%%%'`, which matches
 * every row, i.e. dumped the table to any member who can type a percent sign.
 *
 * The three characters that must be escaped:
 *
 *   - `%`  — wildcard: matches any run of characters.
 *   - `_`  — wildcard: matches exactly one character.
 *   - `\`  — the `ESCAPE` character itself. Escaping it *first* is what keeps the
 *            escape unambiguous; otherwise a literal backslash in the input eats
 *            the `%` that follows it and the pattern silently widens.
 *
 * Every query using this helper must declare `ESCAPE '\'`, which SQLite needs
 * stated explicitly. Omitting the clause while still escaping backslashes is
 * merely over-escaping (safe); declaring the clause without escaping is the
 * dangerous direction, so the helper errs toward escaping.
 */
export function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}