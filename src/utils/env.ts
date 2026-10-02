/**
 * Safe parsing of tunables that arrive from the environment as strings.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The previous idiom used throughout the codebase was:
 *
 *     parseInt(process.env.PAGE_EXTRACTION_MAX_CONTENT_KB || '50') * 1024
 *     Math.max(1, parseInt(process.env.SOMETHING_LIMIT || '') || 5)
 *
 * Both fail silently and *in the dangerous direction*:
 *
 *   - `Number.parseInt('abc')` is `NaN`.
 *   - `Math.max(1, NaN)` is `NaN` — the "safety floor" protects nothing.
 *   - Every comparison against `NaN` is `false`, so a NaN limit does not just
 *     look wrong, it silently *disables the limit it was supposed to enforce*:
 *     a NaN size cap means no truncation (a 50 MB attachment lands in the
 *     prompt), and a NaN entry cap means unbounded fan-out.
 *   - `parseInt(x || '') || 5` also treats a legitimate `0` as missing, so an
 *     operator who deliberately sets `LIMIT=0` gets the default instead.
 *
 * Every helper here therefore returns the fallback unless the value parses to a
 * real, finite number, and then clamps it. Do not reintroduce bare
 * `parseInt(process.env...)` — route new tunables through these helpers.
 */

export interface NumericEnvOptions {
  /** Inclusive lower bound; values below are raised to it. */
  min?: number;
  /** Inclusive upper bound; values above are lowered to it. */
  max?: number;
}

/** True when the raw env string carries no usable payload (unset/blank). */
function rawEnv(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function clamp(value: number, opts?: NumericEnvOptions): number {
  let out = value;
  if (opts?.min !== undefined && out < opts.min) out = opts.min;
  if (opts?.max !== undefined && out > opts.max) out = opts.max;
  return out;
}

/**
 * Read an integer tunable. Falls back when unset, blank, or unparseable, then
 * clamps to `opts.min` / `opts.max`.
 */
export function intEnv(key: string, fallback: number, opts?: NumericEnvOptions): number {
  const raw = rawEnv(key);
  if (raw === undefined) return clamp(fallback, opts);
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return clamp(fallback, opts);
  return clamp(parsed, opts);
}

/**
 * Read a decimal tunable. Same rules as {@link intEnv}, but decimals are kept
 * and non-finite values (`NaN`, `Infinity`) fall back.
 */
export function floatEnv(key: string, fallback: number, opts?: NumericEnvOptions): number {
  const raw = rawEnv(key);
  if (raw === undefined) return clamp(fallback, opts);
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return clamp(fallback, opts);
  return clamp(parsed, opts);
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Read a boolean tunable. Accepts `1/true/yes/on` and `0/false/no/off`,
 * case-insensitive. Anything else (including a typo like `ture`) returns the
 * fallback rather than guessing.
 */
export function boolEnv(key: string, fallback: boolean): boolean {
  const raw = rawEnv(key);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return fallback;
}

/** Read a string tunable, falling back when unset or blank. */
export function strEnv(key: string, fallback: string): string {
  const raw = rawEnv(key);
  return raw === undefined ? fallback : raw;
}
