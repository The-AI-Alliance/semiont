/**
 * DID (Decentralized Identifier) and W3C Agent utilities
 *
 * DID:WEB shapes used in Semiont:
 *
 *   Person:   did:web:<host>:users:<email%40host>
 *   Software: did:web:<host>:agents:<provider>:<model>
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
  const agent: Agent = {
    '@type': 'Software',
    '@id': agentToDid(software),
    name: `${software.provider} ${software.model}`,
    provider: software.provider,
    model: software.model,
  };
  if (software.parameters) {
    (agent as { parameters?: Record<string, unknown> }).parameters = software.parameters;
  }
  return agent;
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
 */
export function didToAgent(did: string | undefined | null): Agent {
  if (!did) {
    return { '@type': 'Person', '@id': 'unknown', name: 'unknown' };
  }
  const parts = did.split(':');

  // Find the kind segment, scanning from the right so we are not fooled
  // by `host:port` colons earlier in the string.
  const agentsIdx = parts.lastIndexOf('agents');
  const usersIdx = parts.lastIndexOf('users');

  if (agentsIdx >= 0 && agentsIdx === parts.length - 3) {
    const provider = decodeURIComponent(parts[agentsIdx + 1] ?? '');
    const model = decodeURIComponent(parts[agentsIdx + 2] ?? '');
    return {
      '@type': 'Software',
      '@id': did,
      name: `${provider} ${model}`,
      provider,
      model,
    };
  }

  if (usersIdx >= 0 && usersIdx === parts.length - 2) {
    const name = decodeURIComponent(parts[usersIdx + 1] ?? '');
    return {
      '@type': 'Person',
      '@id': did,
      name,
    };
  }

  // Unknown shape — preserve the DID as @id, derive a best-effort name
  // from the trailing segment. Treat as Person (the safer default for
  // unknown actors).
  const encoded = parts[parts.length - 1] || 'unknown';
  return {
    '@type': 'Person',
    '@id': did,
    name: decodeURIComponent(encoded),
  };
}
