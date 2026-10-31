/**
 * The knowledge base's own identity, in its two renderings: its did:web and
 * its resource identifier, both from its committed `site.domain`.
 *
 * Nothing here names a person or an agent: the gateway, in Rust, mints every
 * principal's DID, and the record reads them
 * (`specs/src/principals/cases.json`, `specs/src/principals/kind-cases.json`).
 */

/**
 * The knowledge base's own did:web identity, from its committed
 * `site.domain`, which the gateway states in the description it serves.
 *
 * Format: `did:web:<domain>` — the domain **verbatim, never encoded**. The
 * project file already stores it in did:web colon-path form
 * (`the-ai-alliance.github.io:semiont-caselaw-kb`), so encoding those colons
 * would mint a string nothing else in the system produces. The launcher
 * mints the identical string in Go (`kbconfig.go` `didWeb()`), and the two
 * MUST agree byte-for-byte: the Browser joins discovered KBs to connected
 * ones on this value, and a mismatch fails silently — looking implemented
 * while never matching.
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
 * carry. `did:web` turns the colon path into a slash path, so
 * `did:web:example.github.io:my-kb` identifies
 * `https://example.github.io/my-kb`.
 *
 * This is an IDENTIFIER, not an address. Nothing dereferences it, and it does
 * not have to equal the origin a request happened to arrive on — a knowledge
 * base reached over http in local development still identifies itself by the
 * https form, because its identity is declared, not observed. That is what
 * makes the value stable across every host, port and proxy it is reached
 * through, which is the whole reason `aud` can be checked at all.
 *
 * Derived from the SAME committed `site.domain` as `kbDid`, so the two
 * cannot drift; the launcher mints the identical string in Go
 * (`kbconfig.go` `kbResource`) and the two MUST agree byte-for-byte.
 */
export function kbResource(domain: string): string {
  return `https://${domain.split(':').join('/')}`;
}
