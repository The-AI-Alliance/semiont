/**
 * Census gate (EXTRACT-JOBS C2 + P3): the gateway hosts NO job queue and NO
 * `job:*` handler.
 *
 * The queue and its nine `job:*` lifecycle handlers moved to the dispatcher
 * (`dispatcher-main.ts`); the gateway only ROUTES `job:*` frames across the
 * signal plane to that process. This asserts that emptiness rather than
 * trusting a reviewer to notice a job surface come back — a handler
 * re-registered here would double-handle every job command and starve the
 * dispatcher's claim, silently, and present as a 30s timeout rather than an
 * error (the failure that took the stack down twice in September).
 *
 * P3 specified this as a grep — "no `bridgeGatewayHandlers`, no
 * `startMakeMeaningGateway`, no `GATEWAY_HANDLER_*` anywhere in apps/gateway. A
 * census gate, not a one-time check." Here it is asserted, not remembered.
 *
 * Scans gateway PRODUCTION source only (not `__tests__`, whose comments recount
 * the history), with comments stripped so only code counts.
 */
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const GATEWAY_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const CODE = productionFiles(GATEWAY_SRC).map((f) => ({
  f,
  code: stripComments(readFileSync(f, 'utf-8')),
}));

describe('gateway hosts no job queue or job handler (EXTRACT-JOBS C2/P3)', () => {
  // Each removed by the extraction; each would silently re-introduce a
  // gateway-resident job surface. Grep-as-census (P3), asserted not remembered.
  test.each([
    'startMakeMeaningGateway',
    'bridgeGatewayHandlers',
    'GATEWAY_HANDLER_CHANNELS',
    'GATEWAY_HANDLER_EMITS',
    'GATEWAY_HANDLER_GROUP',
    'registerJobCommandHandlers',
  ])('gateway production code does not reference %s', (symbol) => {
    const offenders = CODE.filter(({ code }) => code.includes(symbol)).map(({ f }) => f);
    expect(offenders, `${symbol} is back in gateway production code`).toEqual([]);
  });

  test('gateway production code subscribes no job:* channel', () => {
    // The direct C2 property: no `eventBus.on('job:…')` / `.frames('job:…')`
    // handler anywhere in the gateway. Job commands are answered by the
    // dispatcher; the gateway is a plane router for them.
    const offenders = CODE
      .filter(({ code }) => /\.(?:on|frames)\('job:[^']+'\)/.test(code))
      .map(({ f }) => f);
    expect(offenders, 'gateway subscribes a job:* channel').toEqual([]);
  });
});
