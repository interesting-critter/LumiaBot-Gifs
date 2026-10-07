/**
 * Shared helpers for interpreting a `Bun.serve()` bind failure.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * `server/dashboard.ts` and `server/health.ts` both bind a listener and both
 * need to tell "this port is taken" (dashboard: try the next one; health: give
 * up immediately) from "this host/permission is wrong" (dashboard: fatal for the
 * dashboard; health: same). The logic was originally private to the dashboard,
 * which meant the second server either duplicated it — two copies of a
 * deliberately defensive check, free to drift — or grew an import edge back into
 * the dashboard module, dragging the entire admin UI (UI loading, SQLite, the
 * prompt filesystem, every service) into the import graph of a server that must
 * stay trivially small and side-effect free.
 *
 * Pure functions, no imports, no module state: this file is safe to import from
 * anywhere.
 */

/**
 * True when a bind failed because the port is taken, as opposed to a bad host
 * or a permission problem. Only this case justifies trying the next port.
 *
 * Bun surfaces the condition inconsistently across versions and platforms (an
 * `EADDRINUSE` code, or an `EADDRINUSE`/`address already in use` substring), so
 * both are checked rather than trusting either one alone.
 */
export function isAddressInUse(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EADDRINUSE') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|address already in use|port is already in use/i.test(message);
}

export function describeBindError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}