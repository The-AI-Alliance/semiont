import type { ConsoleMessage, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Bus-log capture for e2e tests.
 *
 * Enables the frontend's cross-wire logging (see busLog() in
 * `packages/api-client/src/view-models/domain/actor-vm.ts`) by flipping
 * `globalThis.__SEMIONT_BUS_LOG__` at page init, then listens for
 * `console.debug` lines matching the "[bus EMIT|RECV]" format and
 * collects them into a structured entry list.
 *
 * Tests use this to assert **protocol-level** behavior, not just UI
 * outcomes. For example, "selecting text created a highlight" (UI) is
 * weaker than "mark:create-request was emitted, mark:create-ok was
 * received with matching correlationId" (protocol).
 */

export interface BusLogEntry {
  direction: 'EMIT' | 'RECV';
  channel: string;
  scope: string | undefined;
  cid: string | undefined;
  raw: string;
  at: number;
}

const LINE_RE = /^\[bus (EMIT|RECV)\] (\S+)(?: scope=(\S+))?(?: cid=(\S+))?/;

export class BusLogCapture {
  readonly entries: BusLogEntry[] = [];

  ingest(msg: ConsoleMessage): void {
    if (msg.type() !== 'debug') return;
    const text = msg.text();
    const m = LINE_RE.exec(text);
    if (!m) return;
    this.entries.push({
      direction: m[1] as 'EMIT' | 'RECV',
      channel: m[2] as string,
      scope: m[3],
      cid: m[4],
      raw: text,
      at: Date.now(),
    });
  }

  emits(channel: string): BusLogEntry[] {
    return this.entries.filter(e => e.direction === 'EMIT' && e.channel === channel);
  }

  receives(channel: string): BusLogEntry[] {
    return this.entries.filter(e => e.direction === 'RECV' && e.channel === channel);
  }

  /** Poll until a RECV for `channel` (optionally matching `cid`) appears, or time out. */
  async waitForRecv(channel: string, opts: { cid?: string; timeout?: number } = {}): Promise<BusLogEntry> {
    const timeout = opts.timeout ?? 10_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.entries.find(
        e => e.direction === 'RECV' && e.channel === channel && (!opts.cid || e.cid === opts.cid),
      );
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(
      `Timed out after ${timeout}ms waiting for RECV on "${channel}"` +
      (opts.cid ? ` with cid=${opts.cid}` : '') +
      `. Recent entries: ${JSON.stringify(this.entries.slice(-10).map(e => ({ d: e.direction, c: e.channel, cid: e.cid })))}`,
    );
  }

  /** Poll until an EMIT for `channel` appears. */
  async waitForEmit(channel: string, opts: { timeout?: number } = {}): Promise<BusLogEntry> {
    const timeout = opts.timeout ?? 10_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.entries.find(e => e.direction === 'EMIT' && e.channel === channel);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(
      `Timed out after ${timeout}ms waiting for EMIT on "${channel}". ` +
      `Recent entries: ${JSON.stringify(this.entries.slice(-10).map(e => ({ d: e.direction, c: e.channel })))}`,
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
