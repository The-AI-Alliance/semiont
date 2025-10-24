/**
 * W3C Web Annotation Compliance Tests for W3C compliance
 *
 * Tests that our W3C Web Annotation implementation follows the W3C Web Annotation Data Model:
 * - Stub references can have TextualBody bodies with purpose: "tagging" for entity types
 * - Resolved references have mixed array: TextualBody (tagging) + SpecificResource (linking)
 * - SpecificResource must NOT have a `value` property (only TextualBody has value)
 * - SpecificResource must have `source` property
 * - TextualBody must have `value` property
 * - Annotations can have zero or more bodies
 */

import { describe, it, expect } from 'vitest';
import type { components } from '@semiont/api-client';
import { getEntityTypes, getBodySource, isResolved } from './helpers/annotation-helpers';

type Annotation = components['schemas']['Annotation'];

describe('W3C Web Annotation Compliance', () => {
  describe('Stub Reference Validation', () => {
    it('should allow annotations with empty body array', () => {
      // Stub references can have empty body array (no entity tags)
      const stubAnnotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-stub-123',
        motivation: 'linking',
        target: {
          source: 'doc-123',
          selector: [
            {
              type: 'TextPositionSelector',
              start: 0,
              end: 15,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'Albert Einstein',
            },
          ],
        },
        body: [], // W3C allows zero bodies
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
      if (Array.isArray(stubAnnotation.body)) {
        expect(stubAnnotation.body.length).toBe(0);
      }

      // Check entity types via helper
      expect(getEntityTypes(stubAnnotation)).toEqual([]);
      expect(isResolved(stubAnnotation)).toBe(false);
    });

    it('should allow stub reference with entity tag bodies', () => {
      // Stub with TextualBody entity tags
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
        body: [
          {
            type: 'TextualBody',
            value: 'Concept',
            purpose: 'tagging',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify body structure
      expect(Array.isArray(stubAnnotation.body)).toBe(true);
      if (Array.isArray(stubAnnotation.body)) {
        expect(stubAnnotation.body.length).toBe(1);
        const firstBody = stubAnnotation.body[0];
        expect(firstBody).toBeDefined();
        if (firstBody) {
          expect(firstBody.type).toBe('TextualBody');
          if ('value' in firstBody) {
            expect(firstBody.value).toBe('Concept');
          }
          if ('purpose' in firstBody) {
            expect(firstBody.purpose).toBe('tagging');
          }
        }
      }

      // Extract entity types
      expect(getEntityTypes(stubAnnotation)).toEqual(['Concept']);
      expect(isResolved(stubAnnotation)).toBe(false);
    });
  });

  describe('Resolved Reference Validation', () => {
    it('should validate resolved reference with entity tags and SpecificResource', () => {
      // Resolved reference has mixed body array
      const resolvedAnnotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-resolved-123',
        motivation: 'linking',
        target: {
          source: 'doc-source-123',
          selector: [
            {
              type: 'TextPositionSelector',
              start: 100,
              end: 117,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'relativity theory',
            },
          ],
        },
        body: [
          {
            type: 'TextualBody',
            value: 'Theory',
            purpose: 'tagging',
          },
          {
            type: 'SpecificResource',
            source: 'doc-target-456',
            purpose: 'linking',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-789',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify body structure
      expect(Array.isArray(resolvedAnnotation.body)).toBe(true);
      if (Array.isArray(resolvedAnnotation.body)) {
        expect(resolvedAnnotation.body.length).toBe(2);

        // First body: TextualBody with entity tag
        const firstBody = resolvedAnnotation.body[0];
        expect(firstBody).toBeDefined();
        if (firstBody) {
          expect(firstBody.type).toBe('TextualBody');
          if ('value' in firstBody) {
            expect(firstBody.value).toBe('Theory');
          }
        }

        // Second body: SpecificResource with source
        const secondBody = resolvedAnnotation.body[1];
        expect(secondBody).toBeDefined();
        if (secondBody) {
          expect(secondBody.type).toBe('SpecificResource');
          if ('source' in secondBody) {
            expect(secondBody.source).toBe('doc-target-456');
          }
        }
      }

      // Extract entity types and source
      expect(getEntityTypes(resolvedAnnotation)).toEqual(['Theory']);
      expect(getBodySource(resolvedAnnotation.body)).toBe('doc-target-456');
      expect(isResolved(resolvedAnnotation)).toBe(true);
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
        body: [
          {
            type: 'SpecificResource',
            source: 'doc-xyz',
            purpose: 'linking',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-xyz',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // SpecificResource must NOT have value property
      if (Array.isArray(resolvedAnnotation.body)) {
        const specificResource = resolvedAnnotation.body.find(b => b.type === 'SpecificResource');
        expect(specificResource).toBeDefined();
        if (specificResource) {
          const body = specificResource as any;
          expect(body.value).toBeUndefined();
          expect('value' in body).toBe(false);
        }
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
        body: [
          {
            type: 'SpecificResource',
            source: 'doc-456',
            purpose: 'linking',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      if (Array.isArray(resolvedAnnotation.body)) {
        const specificResource = resolvedAnnotation.body.find(b => b.type === 'SpecificResource');
        if (specificResource && 'purpose' in specificResource) {
          expect(specificResource.purpose).toBe('linking');
        }
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
        body: [
          {
            type: 'SpecificResource',
            source: 'doc-ref-789',
            purpose: 'linking',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-789',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(typeof annotation.target).toBe('object');
      if (typeof annotation.target === 'object' && 'source' in annotation.target) {
        expect(annotation.target.source).toBe('doc-789');
        expect(annotation.target.selector).toBeDefined();
        if (annotation.target.selector && !Array.isArray(annotation.target.selector)) {
          expect(annotation.target.selector.type).toBe('TextQuoteSelector');
        }
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
          selector: [
            {
              type: 'TextPositionSelector',
              start: 0,
              end: 14,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'important text',
            },
          ],
        },
        body: [
          {
            type: 'TextualBody',
            value: 'ImportantConcept',
            purpose: 'tagging',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(annotation.motivation).toBe('highlighting');
      expect(getEntityTypes(annotation)).toEqual(['ImportantConcept']);
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

  describe('Schema Transitions', () => {
    it('should transition from stub to resolved correctly', () => {
      // Start with stub (entity tags but no SpecificResource)
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
        body: [
          {
            type: 'TextualBody',
            value: 'Person',
            purpose: 'tagging',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify stub state
      expect(Array.isArray(annotation.body)).toBe(true);
      expect(getEntityTypes(annotation)).toEqual(['Person']);
      expect(isResolved(annotation)).toBe(false);

      // Resolve the stub (add SpecificResource to body array)
      annotation = {
        ...annotation,
        body: [
          {
            type: 'TextualBody',
            value: 'Person',
            purpose: 'tagging',
          },
          {
            type: 'SpecificResource',
            source: 'doc-target',
            purpose: 'linking',
          },
        ],
        modified: new Date().toISOString(),
      };

      // Verify resolved state
      expect(Array.isArray(annotation.body)).toBe(true);
      expect(getEntityTypes(annotation)).toEqual(['Person']);
      expect(getBodySource(annotation.body)).toBe('doc-target');
      expect(isResolved(annotation)).toBe(true);
    });

    it('should transition from resolved to stub correctly (unlinking)', () => {
      // Start with resolved (entity tags + SpecificResource)
      let annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-unlink',
        motivation: 'linking',
        target: {
          source: 'doc-source',
        },
        body: [
          {
            type: 'TextualBody',
            value: 'Concept',
            purpose: 'tagging',
          },
          {
            type: 'SpecificResource',
            source: 'doc-target',
            purpose: 'linking',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      // Verify resolved state
      expect(isResolved(annotation)).toBe(true);
      expect(getEntityTypes(annotation)).toEqual(['Concept']);

      // Unlink (remove SpecificResource, keep entity tags)
      annotation = {
        ...annotation,
        body: [
          {
            type: 'TextualBody',
            value: 'Concept',
            purpose: 'tagging',
          },
        ],
        modified: new Date().toISOString(),
      };

      // Verify stub state (entity tags preserved)
      expect(isResolved(annotation)).toBe(false);
      expect(getEntityTypes(annotation)).toEqual(['Concept']);
    });
  });

  describe('TextualBody with Purpose Tagging', () => {
    it('should validate TextualBody has value property', () => {
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-textual-body',
        motivation: 'linking',
        target: 'doc-123',
        body: [
          {
            type: 'TextualBody',
            value: 'Organization',
            purpose: 'tagging',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-123',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      if (Array.isArray(annotation.body)) {
        const textualBody = annotation.body[0];
        expect(textualBody).toBeDefined();
        if (textualBody) {
          expect(textualBody.type).toBe('TextualBody');
          if ('value' in textualBody) {
            expect(textualBody.value).toBe('Organization');
            expect(typeof textualBody.value).toBe('string');
          }
          if ('purpose' in textualBody) {
            expect(textualBody.purpose).toBe('tagging');
          }
        }
      }
    });

    it('should support multiple entity tag bodies', () => {
      const annotation: Annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-multi-tags',
        motivation: 'linking',
        target: 'doc-456',
        body: [
          {
            type: 'TextualBody',
            value: 'Person',
            purpose: 'tagging',
          },
          {
            type: 'TextualBody',
            value: 'Scientist',
            purpose: 'tagging',
          },
          {
            type: 'TextualBody',
            value: 'Physicist',
            purpose: 'tagging',
          },
        ],
        creator: {
          type: 'Person',
          id: 'user-456',
          name: 'test-user',
        },
        created: new Date().toISOString(),
      };

      expect(getEntityTypes(annotation)).toEqual(['Person', 'Scientist', 'Physicist']);
      expect(isResolved(annotation)).toBe(false);
    });
  });
});
