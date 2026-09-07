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
export declare function kbDid(domain: string): string;
/**
 * Convert a user object to a DID:WEB identifier.
 *
 * Format: did:web:<domain>:users:<email%40domain>
 */
export declare function userToDid(user: {
    email: string;
    domain: string;
}): string;
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
export declare function agentToDid(agent: {
    domain: string;
    provider: string;
    model: string;
}): string;
/**
 * Convert a user object to a typed Person Agent with a DID:WEB identifier.
 */
export declare function userToAgent(user: {
    id: string;
    domain: string;
    name: string | null;
    email: string;
}): Agent;
/**
 * Convert a software peer's configuration to a typed Software Agent.
 * The `name` is a stable human-friendly label, not a parseable join —
 * UI composes display from `provider`/`model` at render time.
 */
export declare function softwareToAgent(software: {
    domain: string;
    provider: string;
    model: string;
    parameters?: Record<string, unknown>;
}): Agent;
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
export declare function didToAgent(did: string | undefined | null): Agent;
export {};
