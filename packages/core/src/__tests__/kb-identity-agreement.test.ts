/**
 * A knowledge base's identity is computed the same way in both languages:
 * every case in specs/src/kb-identity/cases.json, run through the TypeScript
 * readers. The launcher runs the same table in Go
 * (apps/launcher/internal/launcher/kbidentity_agreement_test.go). Together
 * they gate a mirror that spans languages and cannot be generated.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SemiontProject } from '../project';
import { kbDid, kbResource } from '../did-utils';

interface IdentityCase {
  why: string;
  dir: string;
  config: string | null;
  name: string;
  domain: string | null;
  did: string | null;
  resource: string | null;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/kb-identity/cases.json');
const { cases } = JSON.parse(readFileSync(TABLE, 'utf-8')) as { cases: IdentityCase[] };

const parent = mkdtempSync(join(tmpdir(), 'kb-identity-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
// A project derives its state tree from XDG_STATE_HOME; none of these cases
// touches it, but constructing one requires it (project.test.ts does the same).
process.env.XDG_STATE_HOME = join(parent, 'state');

describe('KB identity — the TypeScript readers agree with the shared table', () => {
  it('the table has cases: a gate that runs nothing passes on silence', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$why', (c) => {
    const root = join(parent, c.dir);
    mkdirSync(join(root, '.semiont'), { recursive: true });
    if (c.config !== null) writeFileSync(join(root, '.semiont', 'config'), c.config);

    const project = new SemiontProject(root, { anchoredTextDir: join(root, 'anchored-text') });
    const domain = project.siteDomain() ?? null;

    expect({
      name: project.name,
      domain,
      did: domain === null ? null : kbDid(domain),
      resource: domain === null ? null : kbResource(domain),
    }).toEqual({ name: c.name, domain: c.domain, did: c.did, resource: c.resource });
  });
});
