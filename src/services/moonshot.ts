import { config } from '../utils/config';
import { intEnv } from '../utils/env';

interface MoonshotBalance {
  cash_balance: number;
  voucher_balance: number;
  available_balance: number;
}

interface BalanceResponse {
  data: MoonshotBalance;
}

interface TokenEstimateResponse {
  data: {
    total_tokens: number;
  };
}

/** Token counts as Moonshot reports them on a chat completion. */
export interface MoonshotUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Moonshot pricing, per million tokens.
 *
 * Exported so `openai.ts` prices from exactly the same table: `/balance` reports
 * this number, and a second copy of the rates in the request path would
 * eventually disagree with it.
 */
export const COST_INPUT_PER_M = 0.90;
export const COST_CACHED_PER_M = 0.10;
export const COST_OUTPUT_PER_M = 4.00;

let lastBalance: MoonshotBalance | null = null;
let lastRequestCost: number | null = null;
/** Balance delta since the previous refresh — a cross-check, not a per-request figure. */
let lastObservedSpend: number | null = null;

/**
 * In-flight balance fetch, so overlapping turns share one HTTP request.
 *
 * `checkBalance()` is fired-and-forget after every successful response and the
 * bot runs channels in parallel, so without this guard two turns could each
 * read `lastBalance`, await the fetch, and then assign in completion order —
 * whichever landed last won, and `lastBalance` could even go *backwards*.
 */
let balanceInFlight: Promise<MoonshotBalance | null> | null = null;

/**
 * Wall-clock budget for the token-count endpoint.
 *
 * WHY THIS EXISTS
 * ---------------
 * `estimateTokenCount` sits on the chat path, awaited inline before the model
 * request. It was a bare `fetch()` with no `signal`, so an endpoint that
 * accepts the POST and never responds left the promise pending forever. The
 * caller writes `.catch(() => {})`, which handles a *rejection* but not a hang,
 * and in the tool path the call also ran before `turnDeadlineAt` was computed,
 * so the turn deadline could not cover it either. The result: the channel's
 * serialisation slot was held forever, the typing indicator never cleared, and
 * every later message in that channel queued behind it.
 *
 * 5s is generous for a tokenizer endpoint — it does no model inference — while
 * still being far below `OPENAI_TURN_DEADLINE_MS`, so it cannot eat the turn
 * budget. Read through `intEnv` so an unparseable env value falls back rather
 * than producing `NaN` (which, as `setTimeout` semantics aside, would silently
 * disable the very limit this exists to enforce).
 */
const TOKEN_ESTIMATE_TIMEOUT_MS = intEnv('MOONSHOT_TOKEN_ESTIMATE_TIMEOUT_MS', 5_000, { min: 500, max: 60_000 });

/**
 * Wall-clock budget for the balance endpoint.
 *
 * `checkBalance()` is fired-and-forget after a response, but it still runs on
 * the event loop and reuses a single shared in-flight promise: a hung request
 * would pin `balanceInFlight` non-null and make every later balance check
 * await the same never-settling promise. Bounded, same reasoning as above.
 */
const BALANCE_TIMEOUT_MS = intEnv('MOONSHOT_BALANCE_TIMEOUT_MS', 10_000, { min: 500, max: 60_000 });

/**
 * Currency symbol based on the Moonshot endpoint domain.
 * moonshot.ai reports in USD, moonshot.cn reports in Yuan.
 */
function getCurrencySymbol(): string {
  const baseUrl = (config.openai.baseUrl || '').toLowerCase();
  return baseUrl.includes('moonshot.cn') ? '¥' : '$';
}

export function getBalanceCurrency(): string {
  return getCurrencySymbol();
}

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.openai.apiKey}`,
  };
}

function getBaseUrl(): string {
  return config.openai.baseUrl!.replace(/\/+$/, '');
}

/**
 * Fetch the baseline balance at startup so subsequent requests can compute cost deltas.
 */
export async function initBalance(): Promise<void> {
  try {
    const balance = await fetchBalanceShared();
    if (balance) {
      lastBalance = balance;
      const c = getCurrencySymbol();
      console.log(
        `💰 [Moonshot] Startup balance — available: ${c}${balance.available_balance.toFixed(2)}, ` +
        `cash: ${c}${balance.cash_balance.toFixed(2)}, ` +
        `voucher: ${c}${balance.voucher_balance.toFixed(2)}`
      );
    }
  } catch (error) {
    console.warn(`⚠️ [Moonshot] Failed to fetch startup balance:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Estimate token count for a set of messages via Moonshot's tokenizer endpoint.
 */
export async function estimateTokenCount(
  model: string,
  messages: Array<{ role: string; content: unknown }>,
  tools?: unknown[]
): Promise<number | null> {
  try {
    const url = `${getBaseUrl()}/tokenizers/estimate-token-count`;
    const body: Record<string, unknown> = { model, messages };
    if (tools && tools.length > 0) body.tools = tools;
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      // Bounded: see TOKEN_ESTIMATE_TIMEOUT_MS. Without this the call hangs
      // forever on a non-responding endpoint.
      signal: AbortSignal.timeout(TOKEN_ESTIMATE_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`⚠️ [Moonshot] Token estimate failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const json = (await res.json()) as TokenEstimateResponse;
    const totalTokens = json.data.total_tokens;
    console.log(`🔢 [Moonshot] Estimated prompt tokens: ${totalTokens}`);
    return totalTokens;
  } catch (error) {
    console.warn(`⚠️ [Moonshot] Token estimate error:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Raw fetch of the balance endpoint.
 */
async function fetchBalance(): Promise<MoonshotBalance | null> {
  const url = `${getBaseUrl()}/users/me/balance`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
    // Bounded: see BALANCE_TIMEOUT_MS. A hung request would otherwise pin
    // `balanceInFlight` and be replayed by every later check.
    signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
  });

  if (!res.ok) {
    console.warn(`⚠️ [Moonshot] Balance check failed: ${res.status} ${res.statusText}`);
    return null;
  }

  const json = (await res.json()) as BalanceResponse;
  return json.data;
}

/**
 * Fetch the balance, reusing an in-flight request when one is already running.
 * At most one balance request is outstanding at any moment.
 */
function fetchBalanceShared(): Promise<MoonshotBalance | null> {
  if (!balanceInFlight) {
    balanceInFlight = fetchBalance().finally(() => {
      balanceInFlight = null;
    });
  }
  return balanceInFlight;
}

/**
 * Refresh the account balance.
 *
 * The balance *delta* observed here is kept only as a cross-check
 * ({@link getLastObservedSpend}): with parallel turns it covers every request
 * that completed since the previous refresh, not "the last request".
 * {@link getLastRequestCost} is instead derived per response from the API
 * `usage` object, which is unambiguous and race-free.
 */
export async function checkBalance(): Promise<MoonshotBalance | null> {
  try {
    const newBalance = await fetchBalanceShared();
    if (!newBalance) return null;

    if (lastBalance) {
      const delta = lastBalance.available_balance - newBalance.available_balance;
      // Only record positive spend (a negative delta means a top-up happened).
      lastObservedSpend = delta > 0 ? delta : 0;
      if (lastObservedSpend > 0) {
        console.log(
          `💸 [Moonshot] Balance moved ${getCurrencySymbol()}${lastObservedSpend.toFixed(4)} since the last refresh (all requests since, not one)`
        );
      }
    }

    lastBalance = newBalance;
    const c = getCurrencySymbol();
    console.log(
      `💰 [Moonshot] Balance — available: ${c}${newBalance.available_balance.toFixed(2)}, ` +
      `cash: ${c}${newBalance.cash_balance.toFixed(2)}, ` +
      `voucher: ${c}${newBalance.voucher_balance.toFixed(2)}`
    );
    return newBalance;
  } catch (error) {
    console.warn(`⚠️ [Moonshot] Balance check error:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Estimated cost of a single completed request, from the API `usage` object.
 *
 * Called synchronously from the response handler, so concurrent turns cannot
 * interleave it: each response records its own cost. Returns 0 when Moonshot
 * reported no usage data rather than guessing.
 */
export function recordUsageCost(usage: MoonshotUsage | null | undefined): number {
  if (!usage) return 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const uncached = (usage.prompt_tokens ?? 0) - cached;
  const output = usage.completion_tokens ?? 0;
  const cost = (uncached * COST_INPUT_PER_M + cached * COST_CACHED_PER_M + output * COST_OUTPUT_PER_M) / 1_000_000;
  lastRequestCost = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return lastRequestCost;
}

/**
 * Return the last fetched balance (or null if never fetched).
 */
export function getLastBalance(): MoonshotBalance | null {
  return lastBalance;
}

/**
 * Cost of the most recently completed request, in the account currency.
 * Derived from that request's `usage`, so it is a true per-request figure.
 */
export function getLastRequestCost(): number | null {
  return lastRequestCost;
}

/**
 * Balance delta observed at the most recent refresh. Useful as a sanity check
 * against {@link getLastRequestCost}; not a per-request number.
 */
export function getLastObservedSpend(): number | null {
  return lastObservedSpend;
}
