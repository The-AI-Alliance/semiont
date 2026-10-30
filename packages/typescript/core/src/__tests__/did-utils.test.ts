import { describe, it, expect } from 'vitest';
import { kbDid, kbResource } from '../did-utils';

describe('@semiont/core - did-utils', () => {
  /**
   * The KB's own identity — not a person's, not an agent's. The launcher
   * mints the identical string in Go (`kbconfig.go` didWeb():
   * `"did:web:" + Domain`), and the two must agree byte-for-byte or the
   * Browser's identity join silently never matches.
   */
  describe('kbDid', () => {
    it('is did:web: + the declared domain, VERBATIM — colon-path form untouched', () => {
      expect(kbDid('the-ai-alliance.github.io:semiont-caselaw-kb'))
        .toBe('did:web:the-ai-alliance.github.io:semiont-caselaw-kb');
    });

    it('does NOT url-encode the domain (unlike the agent/user path segments)', () => {
      // Colons here are did:web path separators, not data — encoding them
      // would produce a string the launcher never mints.
      const did = kbDid('example.org:kb');
      expect(did).not.toContain('%3A');
      expect(did).toBe('did:web:example.org:kb');
    });
  });

  /**
   * The same committed domain, rendered as the resource identifier a token's
   * `aud` must carry. One declared fact, two renderings — which is the point:
   * a second CONFIGURED audience could disagree with the KB's identity, and
   * this one cannot.
   */
  describe('kbResource', () => {
    it('resolves the did:web colon path to its https URL', () => {
      expect(kbResource('the-ai-alliance.github.io:semiont-caselaw-kb'))
        .toBe('https://the-ai-alliance.github.io/semiont-caselaw-kb');
    });

    it('is the bare origin when the domain declares no path', () => {
      expect(kbResource('example.com')).toBe('https://example.com');
    });

    it('is https even for a domain only ever reached over http — it identifies, it does not address', () => {
      // Local development dials http://localhost:4000, and the token minted
      // for it still carries the https identity. Nothing dereferences this
      // value, so the scheme is part of the name rather than a route.
      expect(kbResource('localhost:4000')).toBe('https://localhost/4000');
    });

    it('names the same subject as kbDid, so the two cannot drift', () => {
      const domain = 'example.org:kb';
      expect(kbDid(domain)).toBe('did:web:example.org:kb');
      expect(kbResource(domain)).toBe('https://example.org/kb');
    });
  });
});
