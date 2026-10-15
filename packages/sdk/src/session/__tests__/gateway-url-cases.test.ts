/**
 * The origin of a knowledge base's gateway, from its HTTP endpoint: one table,
 * specs/src/session/gateway-url-cases.json, run by every SDK.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { HttpEndpoint } from '@semiont/core';
import { kbGatewayUrl } from '../storage';

interface GatewayUrlCase {
  why: string;
  endpoint: HttpEndpoint;
  origin: string | null;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../specs/src/session/gateway-url-cases.json');
const { cases } = JSON.parse(readFileSync(TABLE, 'utf-8')) as { cases: GatewayUrlCase[] };

describe("a gateway's origin, as the shared table states it", () => {
  it.each(cases)('$why', ({ endpoint, origin }) => {
    if (origin === null) {
      expect(() => kbGatewayUrl(endpoint)).toThrow(`Invalid KB hostname: "${endpoint.host}"`);
    } else {
      expect(kbGatewayUrl(endpoint)).toBe(origin);
    }
  });
});
