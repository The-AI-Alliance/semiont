/**
 * Bus logging — runtime-toggleable cross-wire visibility.
 *
 * One line per event that crosses a process boundary, in a grep-able
 * format that's symmetric across frontend and backend:
 *
 *   [bus EMIT] <channel> [scope=X] [cid=<first8>] <payload>
 *   [bus RECV] <channel> [scope=X] [cid=<first8>] <payload>
 *   [bus SSE]  <channel> [scope=X] [cid=<first8>] <payload>
 *
 * Tier 1 of `.plans/OBSERVABILITY.md`. Forward-compatible with Tier 2:
 * the `cid` printed here is exactly the prefix of the W3C trace-id we
 * adopt later.
 *
 * Cost when disabled: one property read per call, zero allocations.
 *
 * Enable:
 *   - Browser:  `window.__SEMIONT_BUS_LOG__ = true` (DevTools or e2e init)
 *   - Node:     `SEMIONT_BUS_LOG=1` in the process env (read at module load)
 */

const NODE_BUS_LOG =
  typeof process !== 'undefined' && !!process.env?.SEMIONT_BUS_LOG;

export type BusOp = 'EMIT' | 'RECV' | 'SSE' | 'PUT' | 'GET';

export function busLogEnabled(): boolean {
  const g = globalThis as { __SEMIONT_BUS_LOG__?: boolean };
  if (g.__SEMIONT_BUS_LOG__) return true;
  return NODE_BUS_LOG;
}

export function busLog(
  op: BusOp,
  channel: string,
  payload: unknown,
  scope?: string,
): void {
  if (!busLogEnabled()) return;
  const cidRaw = (payload as { correlationId?: unknown } | null | undefined)?.correlationId;
  const cid = typeof cidRaw === 'string' ? cidRaw.slice(0, 8) : undefined;
  const tag =
    `[bus ${op}] ${channel}` +
    (scope ? ` scope=${scope}` : '') +
    (cid ? ` cid=${cid}` : '');
  // eslint-disable-next-line no-console
  console.debug(tag, payload);
}
