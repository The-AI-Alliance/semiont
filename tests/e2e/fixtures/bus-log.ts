import type { ConsoleMessage, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Bus-log capture for e2e tests.
 *
 * Enables the cross-wire logging (`busLog()` in `@semiont/core`) by
 * flipping `globalThis.__SEMIONT_BUS_LOG__` at page init, then listens
 * for `console.debug` lines matching the `[bus OP]` format and
 * collects them into structured entries.
 *
 * Five ops are captured (matches the `BusOp` union in core):
 *   - `EMIT` / `RECV` — bus events (channel = `<channel>`)
 *   - `SSE`           — server SSE write (only seen if the test surfaces
 *                       backend stderr; usually not visible from a
 *                       browser-only fixture)
 *   - `PUT` / `GET`   — content uploads / downloads (channel = `'content'`)
 *
 * Tests use this for **protocol-level** assertions, not UI outcomes.
 * "Selecting text created a highlight" (UI) is weaker than
 * "`mark:create-request` was emitted, `mark:create-ok` was received
 * with matching correlationId" (protocol).
 *
 * When an OTel SDK is initialized in the page (Tier 2), each entry
 * also carries a `trace` field — the active span's W3C trace-id, first
 * 8 hex. The fixture captures it but does not require it; tests can
 * use it to correlate with span trees in the APM UI.
 */

export type BusOp = 'EMIT' | 'RECV' | 'SSE' | 'PUT' | 'GET';

export interface BusLogEntry {
  op: BusOp;
  channel: string;
  scope: string | undefined;
  /** correlationId — first 8 hex of `payload.correlationId` if present. */
  cid: string | undefined;
  /** W3C trace-id — first 8 hex of the active span, when an OTel SDK is active. */
  trace: string | undefined;
  raw: string;
  at: number;
}

const LINE_RE =
  /^\[bus (EMIT|RECV|SSE|PUT|GET)\] (\S+)(?: scope=(\S+))?(?: cid=(\S+))?(?: trace=(\S+))?/;

export class BusLogCapture {
  readonly entries: BusLogEntry[] = [];

  ingest(msg: ConsoleMessage): void {
    if (msg.type() !== 'debug') return;
    const text = msg.text();
    const m = LINE_RE.exec(text);
    if (!m) return;
    this.entries.push({
      op: m[1] as BusOp,
      channel: m[2] as string,
      scope: m[3],
      cid: m[4],
      trace: m[5],
      raw: text,
      at: Date.now(),
    });
  }

  // ── Op-specific filters ───────────────────────────────────────────────

  emits(channel: string): BusLogEntry[] {
    return this.byOp('EMIT', channel);
  }

  receives(channel: string): BusLogEntry[] {
    return this.byOp('RECV', channel);
  }

  /** Server-side SSE writes (visible only when the backend's stderr is captured). */
  sses(channel: string): BusLogEntry[] {
    return this.byOp('SSE', channel);
  }

  /** Content uploads. Channel is always `'content'`. */
  contentPuts(): BusLogEntry[] {
    return this.byOp('PUT', 'content');
  }

  /** Content downloads. Channel is always `'content'`. */
  contentGets(): BusLogEntry[] {
    return this.byOp('GET', 'content');
  }

  /** Generic op + optional channel filter. */
  byOp(op: BusOp, channel?: string): BusLogEntry[] {
    return this.entries.filter(
      e => e.op === op && (channel === undefined || e.channel === channel),
    );
  }

  // ── Polling waiters ───────────────────────────────────────────────────

  /** Poll until a RECV for `channel` (optionally matching `cid`) appears, or time out. */
  async waitForRecv(channel: string, opts: { cid?: string; timeout?: number } = {}): Promise<BusLogEntry> {
    return this.waitForOp('RECV', channel, opts);
  }

  /** Poll until an EMIT for `channel` appears. */
  async waitForEmit(channel: string, opts: { cid?: string; timeout?: number } = {}): Promise<BusLogEntry> {
    return this.waitForOp('EMIT', channel, opts);
  }

  /** Poll until a PUT on `'content'` appears. */
  async waitForPut(opts: { timeout?: number } = {}): Promise<BusLogEntry> {
    return this.waitForOp('PUT', 'content', opts);
  }

  /** Poll until a GET on `'content'` appears. */
  async waitForGet(opts: { timeout?: number } = {}): Promise<BusLogEntry> {
    return this.waitForOp('GET', 'content', opts);
  }

  /** Generic poller for any op + channel + optional cid match. */
  async waitForOp(
    op: BusOp,
    channel: string,
    opts: { cid?: string; timeout?: number } = {},
  ): Promise<BusLogEntry> {
    const timeout = opts.timeout ?? 10_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.entries.find(
        e => e.op === op && e.channel === channel && (!opts.cid || e.cid === opts.cid),
      );
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(
      `Timed out after ${timeout}ms waiting for ${op} on "${channel}"` +
        (opts.cid ? ` with cid=${opts.cid}` : '') +
        `. Recent entries: ${JSON.stringify(this.entries.slice(-10).map(e => ({ op: e.op, c: e.channel, cid: e.cid })))}`,
    );
  }

  /**
   * Assert that the given request/response pair completed with matching
   * correlationIds. Returns the completed pair for further inspection.
   */
  async expectRequestResponse(
    requestChannel: string,
    responseChannel: string,
    timeout = 20_000,
  ): Promise<{ request: BusLogEntry; response: BusLogEntry }> {
    const request = await this.waitForEmit(requestChannel, { timeout });
    expect(request.cid, `EMIT ${requestChannel} must carry a correlationId`).toBeTruthy();
    const response = await this.waitForRecv(responseChannel, { cid: request.cid, timeout });
    return { request, response };
  }

  /** Reset between phases of a test. */
  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Wire bus-log capture to a Playwright page. Returns the capture for
 * assertions. Call this once per test, before `page.goto(...)`.
 */
export async function attachBusLog(page: Page): Promise<BusLogCapture> {
  const capture = new BusLogCapture();
  await page.addInitScript(() => {
    (globalThis as unknown as { __SEMIONT_BUS_LOG__?: boolean }).__SEMIONT_BUS_LOG__ = true;
  });
  page.on('console', (msg) => capture.ingest(msg));
  return capture;
}
