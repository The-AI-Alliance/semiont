/**
 * How the gateway names the principals it acts for is one table,
 * specs/src/principals/cases.json, run here through core's builders and their
 * inverse. The conformance suite holds a running gateway to the same cases
 * (agent addresses and names included, which the gateway derives itself), and
 * the Rust gateway runs it too: a mirror across implementations, gated by one
 * table rather than generated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { agentToDid, didToAgent, userToDid } from '../did-utils';

interface PersonCase {
  why: string;
  domain: string;
  subject: string;
  did: string;
}

interface AgentCase {
  why: string;
  domain: string;
  provider: string;
  model: string;
  did: string;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/principals/cases.json');
const { people, agents } = JSON.parse(readFileSync(TABLE, 'utf-8')) as { people: PersonCase[]; agents: AgentCase[] };

describe('principals — core agrees with the shared table', () => {
  it('the table has cases of both kinds: a gate that runs nothing passes on silence', () => {
    expect(people.length).toBeGreaterThan(0);
    expect(agents.length).toBeGreaterThan(0);
  });

  it.each(people)('person: $why', (c) => {
    expect(userToDid({ subject: c.subject, domain: c.domain })).toBe(c.did);
    expect(didToAgent(c.did)).toEqual({ '@type': 'Person', '@id': c.did });
  });

  it.each(agents)('agent: $why', (c) => {
    expect(agentToDid({ domain: c.domain, provider: c.provider, model: c.model })).toBe(c.did);
    expect(didToAgent(c.did)).toMatchObject({ '@type': 'Software', '@id': c.did, provider: c.provider, model: c.model });
  });
});
