import { describe, it, expect } from 'vitest';
import { principal, type Principal } from '../principal';
import { userId } from '../identifiers';

const ALICE = userId('did:web:example.com:users:alice%40example.com');
const WEAVER = userId('did:web:example.com:agents:semiont:weaver');
const BROWSER = userId('did:web:example.com:clients:browser');

describe('principal — a chain, not a choice', () => {
  it('a person acting directly carries an authority and nothing else', () => {
    const p = principal({ did: ALICE });
    expect(p.did).toBe(ALICE);
    expect(p.actor).toBeUndefined();
    expect(p.client).toBeUndefined();
  });

  it('delegated work keeps BOTH the person and the software that acted', () => {
    const p = principal({ did: ALICE, actor: WEAVER });
    expect(p.did).toBe(ALICE);
    expect(p.actor).toBe(WEAVER);
  });

  it('autonomous agent work collapses: the agent is the authority, not its own actor', () => {
    // The record stops saying "the weaver acted on behalf of the weaver".
    // This mirrors the collapse `@semiont/jobs` already performs by hand when
    // it builds PROV-O `wasAttributedTo`.
    const p = principal({ did: WEAVER, actor: WEAVER });
    expect(p.did).toBe(WEAVER);
    expect(p.actor).toBeUndefined();
  });

  it('carries the client that delivered the request, independently of the actor', () => {
    const p = principal({ did: ALICE, client: BROWSER });
    expect(p.client).toBe(BROWSER);
    expect(p.actor).toBeUndefined();
  });

  it('records all three when a person delegates through an application', () => {
    const p = principal({ did: ALICE, actor: WEAVER, client: BROWSER });
    expect([p.did, p.actor, p.client]).toEqual([ALICE, WEAVER, BROWSER]);
  });

  it('omits absent legs rather than carrying undefined keys onto the wire', () => {
    // An event is persisted as JSON: an explicit `"actor": undefined` and an
    // absent `actor` are the same to a reader, but only one of them survives
    // a round trip identically. Absence is the wire shape.
    expect(Object.keys(principal({ did: ALICE }))).toEqual(['did']);
  });

  it('refuses an authority that is not a DID', () => {
    expect(() => principal({ did: 'alice@example.com' as never })).toThrow(TypeError);
  });

  it('refuses an actor or client that is not a DID', () => {
    expect(() => principal({ did: ALICE, actor: 'weaver' as never })).toThrow(TypeError);
    expect(() => principal({ did: ALICE, client: 'browser' as never })).toThrow(TypeError);
  });

  it('is assignable where a Principal is expected', () => {
    const p: Principal = principal({ did: ALICE, actor: WEAVER });
    expect(p.did).toBe(ALICE);
  });
});
