/**
 * DID (Decentralized Identifier) and W3C Agent utilities
 *
 * DID:WEB shapes used in Semiont:
 *
 *   Knowledge base: did:web:<domain>
 *   Person:         did:web:<domain>:users:<subject>
 *   Software:       did:web:<domain>:agents:<provider>:<model>
 *
 * `<domain>` is the deployment's `[site] domain` — one identity, with its
 * people and software peers named beneath it. A person's `<subject>` is the
 * value of the issuer claim `[identity] subjectClaim` selects, URI-encoded
 * (VERIFIED-PROVENANCE P5): which claim is declared per deployment, never
 * inferred here, and the person's email is a fact about them, not their name.
 *
 * `didToAgent` is the inverse: parse the DID, recognize whether the
 * subject is a person or a software peer, and return a typed Agent.
 *
 * Humans and software peers share the same identity *shape* (a DID
 * with a typed Agent on read). What differs is the path segment
 * (`:users:` vs `:agents:`) and the schema-typed fields each kind
 * carries on its Agent record.
 */

import type { UserId } from './identifiers';
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
 * The knowledge base's RESOURCE identifier: its did:web rendered as the https
 * URL that DID method resolves to, and the single value a token's `aud` must
 * carry (EXTERNAL-IDENTITY). `did:web` turns the colon path into a slash path,
 * so `did:web:example.github.io:my-kb` identifies
 * `https://example.github.io/my-kb`.
 *
 * This is an IDENTIFIER, not an address. Nothing dereferences it, and it does
 * not have to equal the origin a request happened to arrive on — a knowledge
 * base reached over http in local development still identifies itself by the
 * https form, because its identity is declared, not observed. That is what
 * makes the value stable across every host, port and proxy it is reached
 * through, which is the whole reason `aud` can be checked at all.
 *
 * Derived from the SAME committed `[site] domain` as `kbDid`, so the two
 * cannot drift; the launcher mints the identical string in Go
 * (`kbconfig.go` `kbResource`) and the two MUST agree byte-for-byte.
 */
export function kbResource(domain: string): string {
  return `https://${domain.split(':').join('/')}`;
}

/**
 * A person's DID:WEB identifier from the subject the issuer asserted.
 *
 * Format: did:web:<domain>:users:<subject, URI-encoded>
 */
export function userToDid(user: { subject: string; domain: string }): UserId {
  return `did:web:${user.domain}:users:${encodeURIComponent(user.subject)}` as UserId;
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
export function agentToDid(agent: { domain: string; provider: string; model: string }): UserId {
  return `did:web:${agent.domain}:agents:${encodeURIComponent(agent.provider)}:${encodeURIComponent(agent.model)}` as UserId;
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
 *   did:web:<host>:users:<subject>         → Person  (name = decoded subject)
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
/**
 * Who a record is attributed to — derived, never asserted (VERIFIED-PROVENANCE P2).
 *
 * `requester` is the DID of whoever asked for the work: the emitter of the
 * `job:create` a write cites, as the dispatcher recorded it on `job:assigned`;
 * or the writer itself when it cites no job. `executor` is the write's own
 * `_userId`. Both are identities the gateway stamped from a token — nothing
 * here is read from a payload, which is what makes the result derived.
 *
 * The W3C/PROV fields follow from the pair:
 * - `creator` is the requester.
 * - `generator` is the executor when the executor is software. A caller may
 *   supply one to carry the model's parameters, but its identity MUST be the
 *   executor's — a generator naming someone else is exactly the assertion this
 *   function exists to make impossible, and is refused.
 * - `wasAttributedTo` is both parties in that order, collapsed to one when
 *   requester and executor are the same.
 *
 * This is the ONE place these fields are built. `lint:attribution` fails the
 * build if a second appears.
 */
export interface Attribution {
  creator: Agent;
  generator?: Agent;
  wasAttributedTo: Agent[];
}

export function attribution(chain: { requester: string; executor: string; generator?: Agent }): Attribution {
  const creator = didToAgent(chain.requester);
  const executor = didToAgent(chain.executor);
  const executorIsSoftware = executor['@type'] === 'Software';

  let generator: Agent | undefined;
  if (chain.generator !== undefined) {
    if (!executorIsSoftware) {
      throw new Error(`attribution: a generator was supplied, but the executor ${chain.executor} is not software`);
    }
    if (chain.generator['@id'] !== executor['@id']) {
      throw new Error(`attribution: generator ${String(chain.generator['@id'])} is not the executor ${chain.executor}`);
    }
    generator = chain.generator;
  } else if (executorIsSoftware) {
    generator = executor;
  }

  // The executor's Agent as it should appear: the supplied generator when
  // there is one (it carries parameters the DID does not), else the DID's.
  const executorAgent: Agent = generator !== undefined ? generator : executor;
  const wasAttributedTo = creator['@id'] === executor['@id'] ? [executorAgent] : [creator, executorAgent];
  return generator !== undefined ? { creator, generator, wasAttributedTo } : { creator, wasAttributedTo };
}

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
