import { describe, it, expect } from 'vitest';
import { findBodyItem, type BodyItemIdentity } from '../annotation-utils';
import type { BodyItem } from '../event-base';

describe('@semiont/core - annotation-utils', () => {
  describe('findBodyItem', () => {
    // ── Basic identity matching ───────────────────────────────────────────

    it('finds TextualBody by type + value', () => {
      const body: BodyItem[] = [
        { type: 'TextualBody', value: 'First comment', purpose: 'commenting' },
        { type: 'TextualBody', value: 'Second comment', purpose: 'commenting' },
      ];
      const target: BodyItemIdentity = { type: 'TextualBody', value: 'Second comment' };

      expect(findBodyItem(body as any, target)).toBe(1);
    });

    it('finds SpecificResource by type + source', () => {
      const body: BodyItem[] = [
        { type: 'TextualBody', value: 'Comment', purpose: 'commenting' },
        { type: 'SpecificResource', source: 'https://example.com/ref', purpose: 'linking' },
      ];
      const target: BodyItemIdentity = { type: 'SpecificResource', source: 'https://example.com/ref' };

      expect(findBodyItem(body as any, target)).toBe(1);
    });

    it('returns -1 when no item matches', () => {
      const body: BodyItem[] = [
        { type: 'TextualBody', value: 'First comment', purpose: 'commenting' },
      ];
      const target: BodyItemIdentity = { type: 'TextualBody', value: 'Not found' };

      expect(findBodyItem(body as any, target)).toBe(-1);
    });

    it('returns -1 for non-array body', () => {
      const body = { type: 'TextualBody', value: 'Single item', purpose: 'commenting' };
      const target: BodyItemIdentity = { type: 'TextualBody', value: 'Single item' };

      expect(findBodyItem(body as any, target)).toBe(-1);
    });

    it('returns -1 for empty array', () => {
      const body: any[] = [];
      const target: BodyItemIdentity = { type: 'TextualBody', value: 'Test' };

      expect(findBodyItem(body, target)).toBe(-1);
    });

    it('skips invalid items in the array', () => {
      const body = [
        null,
        'string item',
        42,
        { type: 'TextualBody', value: 'Valid comment', purpose: 'commenting' },
      ];
      const target: BodyItemIdentity = { type: 'TextualBody', value: 'Valid comment' };

      expect(findBodyItem(body as any, target)).toBe(3);
    });

    // ── Purpose semantics (the regression guards) ─────────────────────────

    it('matches regardless of purpose when target omits purpose', () => {
      // Guards against the original bug: event 7 of the user's KB had a
      // remove op with no `purpose` field. With strict purpose equality the
      // match would silently fail and the link would never be removed.
      const body: BodyItem[] = [
        { type: 'SpecificResource', source: 'res-x', purpose: 'linking' },
      ];
      const target: BodyItemIdentity = { type: 'SpecificResource', source: 'res-x' };

      expect(findBodyItem(body as any, target)).toBe(0);
    });

    it('matches strictly when target provides purpose', () => {
      // If the caller wants to disambiguate among same-source bodies under
      // different purposes (a future W3C multi-body case), providing purpose
      // in the target makes the match strict.
      const body: BodyItem[] = [
        { type: 'SpecificResource', source: 'res-x', purpose: 'identifying' },
        { type: 'SpecificResource', source: 'res-x', purpose: 'linking' },
      ];
      const target: BodyItemIdentity = {
        type: 'SpecificResource',
        source: 'res-x',
        purpose: 'linking',
      };

      expect(findBodyItem(body as any, target)).toBe(1);
    });

    it('returns -1 when target specifies a purpose that no matching item has', () => {
      const body: BodyItem[] = [
        { type: 'SpecificResource', source: 'res-x', purpose: 'linking' },
      ];
      const target: BodyItemIdentity = {
        type: 'SpecificResource',
        source: 'res-x',
        purpose: 'identifying',
      };

      expect(findBodyItem(body as any, target)).toBe(-1);
    });

    it('returns first match when target omits purpose and multiple items share identity', () => {
      // Disambiguation falls to the caller if they care. Omitted-purpose
      // semantics is "first match wins".
      const body: BodyItem[] = [
        { type: 'SpecificResource', source: 'res-x', purpose: 'identifying' },
        { type: 'SpecificResource', source: 'res-x', purpose: 'linking' },
      ];
      const target: BodyItemIdentity = { type: 'SpecificResource', source: 'res-x' };

      expect(findBodyItem(body as any, target)).toBe(0);
    });

    it('TextualBody purpose semantics mirrors SpecificResource', () => {
      const body: BodyItem[] = [
        { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
      ];

      // Omitted purpose: matches.
      expect(
        findBodyItem(body as any, { type: 'TextualBody', value: 'Person' })
      ).toBe(0);

      // Explicit matching purpose: matches.
      expect(
        findBodyItem(body as any, { type: 'TextualBody', value: 'Person', purpose: 'tagging' })
      ).toBe(0);

      // Explicit non-matching purpose: no match.
      expect(
        findBodyItem(body as any, { type: 'TextualBody', value: 'Person', purpose: 'commenting' })
      ).toBe(-1);
    });

    // ── Caller-convenience: passing a full BodyItem works too ─────────────

    it('accepts a full BodyItem structurally (ignores extra fields)', () => {
      // View-materializer and graph-consumer pass `op.item` directly —
      // which carries purpose and possibly other fields. This should Just
      // Work because BodyItem is structurally assignable to BodyItemIdentity.
      const body: BodyItem[] = [
        { type: 'SpecificResource', source: 'res-x', purpose: 'linking' },
      ];
      const opItem: BodyItem = {
        type: 'SpecificResource',
        source: 'res-x',
        purpose: 'linking',
      };

      expect(findBodyItem(body as any, opItem)).toBe(0);
    });
  });
});
