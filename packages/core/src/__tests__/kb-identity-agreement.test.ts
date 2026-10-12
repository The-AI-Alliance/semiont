/**
 * A knowledge base's did and resource identifier are computed from its domain
 * the same way in every language: every case of
 * specs/src/kb-identity/cases.json that declares a domain, run through
 * `kbDid` and `kbResource`. The launcher runs the whole table in Go
 * (apps/launcher/internal/launcher/kbidentity_agreement_test.go), reading the
 * domain from the knowledge base's config as well. Together they gate a
 * mirror that spans languages and cannot be generated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { kbDid, kbResource } from '../did-utils';

interface IdentityCase {
  why: string;
  domain: string | null;
  did: string | null;
  resource: string | null;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/kb-identity/cases.json');
const { cases } = JSON.parse(readFileSync(TABLE, 'utf-8')) as { cases: IdentityCase[] };

const declared = cases.flatMap((c) => (c.domain === null ? [] : [{ why: c.why, domain: c.domain, did: c.did, resource: c.resource }]));

describe('KB identity — kbDid and kbResource agree with the shared table', () => {
  it('the table has cases with a domain: a gate that runs nothing passes on silence', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared)('$why', (c) => {
    expect({ did: kbDid(c.domain), resource: kbResource(c.domain) }).toEqual({ did: c.did, resource: c.resource });
  });
});
