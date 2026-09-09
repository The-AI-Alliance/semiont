/**
 * DID (Decentralized Identifier) and W3C Agent utilities
 *
 * DID:WEB shapes used in Semiont:
 *
 *   Knowledge base: did:web:<domain>
 *   Person:         did:web:<domain>:users:<email%40host>
 *   Software:       did:web:<domain>:agents:<provider>:<model>
 *
 * `<domain>` is the KB's committed `[site] domain` — one identity, with its
 * people and software peers named beneath it.
 *
 * `didToAgent` is the inverse: parse the DID, recognize whether the
 * subject is a person or a software peer, and return a typed Agent.
 *
 * Humans and software peers share the same identity *shape* (a DID
 * with a typed Agent on read). What differs is the path segment
 * (`:users:` vs `:agents:`) and the schema-typed fields each kind
 * carries on its Agent record.
 */

import type { components } from './types';

type Agent = components['schemas']['Agent'];

/**
 * The knowledge base's own did:web identity, from its committed
 * `[site] domain` (`SemiontProject.siteDomain()`).
 *
 * Format: `did:web:<domain>` — the domain **verbatim, never encoded**. The
 * config already stores it in did:web colon-path form
 * (`the-ai-alliance.github.io:semiont-caselaw-kb`), so encoding those colons
 * would mint a string nothing else in the system produces. The launcher
 * mints the identical string in Go (`kbconfig.go` `didWeb()`), and the two
 * MUST agree byte-for-byte: the Browser joins discovered KBs to connected
 * ones on this value, and a mismatch fails silently — looking implemented
 * while never matching (.plans/KB-IDENTITY-VS-ADDRESS.md).
 *
 * A KB has no did when it declares no domain; identity is declared, never
 * defaulted or inferred from an address.
 */
export function kbDid(domain: string): string {
  return `did:web:${domain}`;
}

/**
 * Convert a user object to a DID:WEB identifier.
 *
 * Format: did:web:<domain>:users:<email%40domain>
 */
export function userToDid(user: { email: string; domain: string }): string {
  return `did:web:${user.domain}:users:${encodeURIComponent(user.email)}`;
}

/**
 * Convert a software peer's (provider, model) configuration to a DID:WEB
 * identifier. Pool-vs-individual deployment is not part of identity —
 * one DID per (provider, model) on this host.
 *
 * Format: did:web:<domain>:agents:<provider>:<model%2F-encoded>
 *
 * Model strings often contain `:` and `/` (e.g. `gemma2:27b`,
 * `library/llama3`); both must be URI-encoded so DID parsing isn't
 * ambiguous.
 */
export function agentToDid(agent: { domain: string; provider: string; model: string }): string {
  return `did:web:${agent.domain}:agents:${encodeURIComponent(agent.provider)}:${encodeURIComponent(agent.model)}`;
}

/**
 * Convert a user object to a typed Person Agent with a DID:WEB identifier.
 */
export function userToAgent(user: {
  id: string;
  domain: string;
  name: string | null;
  email: string;
}): Agent {
  return {
    '@type': 'Person',
    '@id': userToDid(user),
    name: user.name || user.email,
  };
}

/**
 * Convert a software peer's configuration to a typed Software Agent.
 * The `name` is a stable human-friendly label, not a parseable join —
 * UI composes display from `provider`/`model` at render time.
 */
export function softwareToAgent(software: {
  domain: string;
  provider: string;
  model: string;
  parameters?: Record<string, unknown>;
}): Agent {
  return {
    '@type': 'Software',
    '@id': agentToDid(software),
    name: `${software.provider} ${software.model}`,
    provider: software.provider,
    model: software.model,
    ...(software.parameters && { parameters: software.parameters }),
  };
}

/**
 * Parse a DID:WEB string into a typed Agent.
 *
 * Recognizes:
 *   did:web:<host>:users:<email>           → Person  (name = decoded email)
 *   did:web:<host>:agents:<provider>:<model> → Software (provider + model)
 *
 * Anything else falls back to a Person with the trailing segment as
 * `name`. This is the read-side inverse of `userToDid`/`agentToDid`.
 *
 * **`@id` is emitted only when the input is URI-shaped**, because every Agent
 * branch declares it `format: "uri"` and `@id` is required by none of them. A
 * non-URI value fails all three branches of the `oneOf`, and wire validation is
 * per-PAYLOAD — so one bad Agent rejects an entire `browse:resources-result`,
 * denying a reply about every resource in it. Measured 2026-09-09: one resource
 * carrying a raw CUID from pre-DID events (2026-03-26) made an unfiltered listing
 * of nine permanently unreturnable.
 *
 * This is a deliberate TOLERANCE, not a compatibility shim — it carries no
 * version check, no legacy branch, no second code path. It is one function
 * declining to assert an identifier it cannot vouch for. It is also a waypoint:
 * `userId` is declared `{"type":"string"}` with "DID of the user" in a
 * DESCRIPTION that nothing enforces, and the sequence out of here is (1) clean the
 * legacy values, (2) constrain `userId` in `StoredEventResponse.json`, (3) delete
 * this tolerance as unreachable. Do not delete it before step 2: the log is
 * append-only and the offending records cannot be edited away, so a strict reader
 * today would convert a partial failure into a total one.
 */
export function didToAgent(did: string | undefined | null): Agent {
  if (!did) {
    // No `'unknown'` fabrication. `@id` is optional in every branch, so a missing
    // identifier reads as missing — and the old placeholder was strictly worse
    // than absence: it invented a value AND was itself not a URI, so it broke the
    // wire on the way past.
    return { '@type': 'Person', name: 'unknown' };
  }
  const parts = did.split(':');

  // Find the kind segment, scanning from the right so we are not fooled
  // by `host:port` colons earlier in the string.
  const agentsIdx = parts.lastIndexOf('agents');
  const usersIdx = parts.lastIndexOf('users');

  /**
   * An absolute URI, as `format: "uri"` accepts it: a scheme, a colon, and at
   * least one non-space character after it. Pinned against Ajv's own answer by
   * the round-trip test — `did:` and `a:` are schemes with nothing following and
   * Ajv rejects both, which a bare `/:/ ` check would have let through.
   */
  const uriShaped = (value: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:\S/.test(value);
  /** Spread into the result so a non-URI omits the key entirely. */
  const identity = uriShaped(did) ? { '@id': did } : {};

  if (agentsIdx >= 0 && agentsIdx === parts.length - 3) {
    const provider = decodeURIComponent(parts[agentsIdx + 1] ?? '');
    const model = decodeURIComponent(parts[agentsIdx + 2] ?? '');
    return {
      '@type': 'Software',
      ...identity,
      name: `${provider} ${model}`,
      provider,
      model,
    };
  }

  if (usersIdx >= 0 && usersIdx === parts.length - 2) {
    const name = decodeURIComponent(parts[usersIdx + 1] ?? '');
    return {
      '@type': 'Person',
      ...identity,
      name,
    };
  }

  // Unknown shape — preserve the DID as @id, derive a best-effort name
  // from the trailing segment. Treat as Person (the safer default for
  // unknown actors).
  const encoded = parts[parts.length - 1] || 'unknown';
  return {
    '@type': 'Person',
    ...identity,
    name: decodeURIComponent(encoded),
  };
}
