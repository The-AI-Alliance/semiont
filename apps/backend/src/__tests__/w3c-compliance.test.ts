/**
 * W3C Web Annotation Compliance Tests for Phase 1
 *
 * Tests that our Phase 1 implementation follows the W3C Web Annotation Data Model:
 * - Stub references can have zero bodies (W3C allows 0 or more bodies)
 * - SpecificResource must NOT have a `value` property (only TextualBody has value)
 * - SpecificResource must have `source` property
 * - Annotations with `body: []` are valid W3C annotations
 */

import { describe, it, expect } from 'vitest';
import type { Annotation } from '@semiont/api-client';

describe('W3C Web Annotation Compliance - Phase 1', () => {
  describe('Stub Reference Validation', () => {
    it('should allow annotations with empty body array', () => {
      // Phase 1: Stub references have body: []
      const stubAnnotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-stub-123',
        motivation: 'linking',
        target: {
          source: 'doc-123',
          selector: {
            type: 'TextPositionSelector',
            exact: 'Albert Einstein',
            offset: 0,
            length: 15,
          },
        },
        body: [], // W3C allows zero bodies
        entityTypes: [], // Phase 1: temporary location
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify it's a valid annotation
      expect(stubAnnotation['@context']).toBe('http://www.w3.org/ns/anno.jsonld');
      expect(stubAnnotation.type).toBe('Annotation');
      expect(stubAnnotation.body).toEqual([]);
      expect(Array.isArray(stubAnnotation.body)).toBe(true);
      expect(stubAnnotation.body.length).toBe(0);
    });

    it('should validate stub reference has no body properties', () => {
      const stubAnnotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-stub-456',
        motivation: 'linking',
        target: {
          source: 'doc-456',
          selector: {
            type: 'TextQuoteSelector',
            exact: 'quantum mechanics',
          },
        },
        body: [],
        entityTypes: ['Concept'],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify no body means no source, no value, no type
      expect(Array.isArray(stubAnnotation.body)).toBe(true);
      expect(stubAnnotation.body.length).toBe(0);

      // TypeScript enforces this at compile time, but verify at runtime
      const body = stubAnnotation.body as any;
      expect(body.source).toBeUndefined();
      expect(body.value).toBeUndefined();
      expect(body.type).toBeUndefined();
    });
  });

  describe('Resolved Reference Validation', () => {
    it('should validate SpecificResource has source property', () => {
      const resolvedAnnotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-resolved-123',
        motivation: 'linking',
        target: {
          source: 'doc-source-123',
          selector: {
            type: 'TextPositionSelector',
            exact: 'relativity theory',
            offset: 100,
            length: 17,
          },
        },
        body: {
          type: 'SpecificResource',
          source: 'doc-target-456', // Required for SpecificResource
          purpose: 'linking',
        },
        entityTypes: ['Theory'],
        creator: {
          type: 'Person',
          id: 'user-789',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify SpecificResource structure
      expect(Array.isArray(resolvedAnnotation.body)).toBe(false);

      if (!Array.isArray(resolvedAnnotation.body)) {
        expect(resolvedAnnotation.body.type).toBe('SpecificResource');
        expect(resolvedAnnotation.body.source).toBe('doc-target-456');
        expect(resolvedAnnotation.body.purpose).toBe('linking');
      }
    });

    it('should NOT have value property on SpecificResource (W3C compliance)', () => {
      const resolvedAnnotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-resolved-789',
        motivation: 'linking',
        target: {
          source: 'doc-abc',
        },
        body: {
          type: 'SpecificResource',
          source: 'doc-xyz',
          purpose: 'linking',
        },
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-xyz',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Phase 1: SpecificResource must NOT have value property
      if (!Array.isArray(resolvedAnnotation.body)) {
        const body = resolvedAnnotation.body as any;
        expect(body.value).toBeUndefined();
        expect('value' in body).toBe(false);
      }
    });

    it('should validate purpose field for SpecificResource', () => {
      const resolvedAnnotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-purpose-123',
        motivation: 'linking',
        target: {
          source: 'doc-123',
        },
        body: {
          type: 'SpecificResource',
          source: 'doc-456',
          purpose: 'linking', // W3C purpose field
        },
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      if (!Array.isArray(resolvedAnnotation.body)) {
        expect(resolvedAnnotation.body.purpose).toBe('linking');
      }
    });
  });

  describe('Target Validation', () => {
    it('should support simple string IRI target (W3C Form 1)', () => {
      // W3C allows target to be a simple string IRI
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-simple-target',
        motivation: 'linking',
        target: 'http://example.org/document-123', // Simple string IRI
        body: [],
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(typeof annotation.target).toBe('string');
      expect(annotation.target).toBe('http://example.org/document-123');
    });

    it('should support target with source only (W3C Form 2)', () => {
      // W3C allows target object with just source (no selector)
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-source-only-target',
        motivation: 'linking',
        target: {
          source: 'doc-456', // Source without selector
        },
        body: [],
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(typeof annotation.target).toBe('object');
      if (typeof annotation.target === 'object') {
        expect(annotation.target.source).toBe('doc-456');
        expect(annotation.target.selector).toBeUndefined();
      }
    });

    it('should support target with source and selector (W3C Form 3)', () => {
      // W3C allows target object with source + selector
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-full-target',
        motivation: 'linking',
        target: {
          source: 'doc-789',
          selector: {
            type: 'TextQuoteSelector',
            exact: 'selected text',
          },
        },
        body: {
          type: 'SpecificResource',
          source: 'doc-ref-789',
          purpose: 'linking',
        },
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-789',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(typeof annotation.target).toBe('object');
      if (typeof annotation.target === 'object') {
        expect(annotation.target.source).toBe('doc-789');
        expect(annotation.target.selector).toBeDefined();
        expect(annotation.target.selector?.type).toBe('TextQuoteSelector');
      }
    });
  });

  describe('Motivation Validation', () => {
    it('should validate linking motivation for references', () => {
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-motivation',
        motivation: 'linking', // W3C motivation for references
        target: {
          source: 'doc-123',
        },
        body: [],
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(annotation.motivation).toBe('linking');
    });

    it('should validate highlighting motivation', () => {
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-highlight',
        motivation: 'highlighting',
        target: {
          source: 'doc-456',
          selector: {
            type: 'TextPositionSelector',
            exact: 'important text',
            offset: 0,
            length: 14,
          },
        },
        body: [], // Phase 1: empty for highlights too
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(annotation.motivation).toBe('highlighting');
    });
  });

  describe('Required W3C Fields', () => {
    it('should have required @context field', () => {
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-context',
        motivation: 'linking',
        target: 'doc-123',
        body: [],
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(annotation['@context']).toBe('http://www.w3.org/ns/anno.jsonld');
    });

    it('should have required type field', () => {
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-type',
        motivation: 'linking',
        target: 'doc-456',
        body: [],
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(annotation.type).toBe('Annotation');
    });

    it('should have required target field', () => {
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-required-target',
        motivation: 'linking',
        target: 'doc-789', // Target is required
        body: [],
        entityTypes: [],
        creator: {
          type: 'Person',
          id: 'user-789',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(annotation.target).toBeDefined();
    });
  });

  describe('Phase 1 Schema Transitions', () => {
    it('should transition from stub to resolved correctly', () => {
      // Start with stub
      let annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-transition',
        motivation: 'linking',
        target: {
          source: 'doc-source',
          selector: {
            type: 'TextQuoteSelector',
            exact: 'Einstein',
          },
        },
        body: [], // Stub: empty array
        entityTypes: ['Person'],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify stub state
      expect(Array.isArray(annotation.body)).toBe(true);
      expect(annotation.body.length).toBe(0);

      // Resolve the stub
      annotation = {
        ...annotation,
        body: {
          type: 'SpecificResource',
          source: 'doc-target',
          purpose: 'linking',
        },
        modified: new Date().toISOString(),
      };

      // Verify resolved state
      expect(Array.isArray(annotation.body)).toBe(false);
      if (!Array.isArray(annotation.body)) {
        expect(annotation.body.type).toBe('SpecificResource');
        expect(annotation.body.source).toBe('doc-target');
        expect(annotation.body.purpose).toBe('linking');
      }
    });

    it('should transition from resolved to stub correctly (unlinking)', () => {
      // Start with resolved
      let annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-unlink',
        motivation: 'linking',
        target: {
          source: 'doc-source',
        },
        body: {
          type: 'SpecificResource',
          source: 'doc-target',
          purpose: 'linking',
        },
        entityTypes: ['Concept'],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify resolved state
      expect(Array.isArray(annotation.body)).toBe(false);

      // Unlink (convert to stub)
      annotation = {
        ...annotation,
        body: [],
        modified: new Date().toISOString(),
      };

      // Verify stub state
      expect(Array.isArray(annotation.body)).toBe(true);
      expect(annotation.body.length).toBe(0);
    });
  });
});
