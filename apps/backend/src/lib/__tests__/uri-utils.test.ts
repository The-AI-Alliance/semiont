/**
 * Tests for URI utilities
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resourceIdToURI, uriToResourceId, annotationIdToURI, uriToAnnotationId } from '@semiont/core';
import { resourceId, annotationId } from '@semiont/core';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../../__tests__/_test-setup';

describe('URI Utilities', () => {
  let testEnv: TestEnvironmentConfig;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  describe('resourceIdToURI', () => {
    const publicURL = 'http://localhost:4000';

    it('converts resource ID to URI', () => {
      expect(resourceIdToURI(resourceId('doc-abc123'), publicURL)).toBe('http://localhost:4000/resources/doc-abc123');
    });

    it('handles BACKEND_URL with trailing slash', () => {
      expect(resourceIdToURI(resourceId('doc-abc123'), 'http://localhost:4000/')).toBe('http://localhost:4000/resources/doc-abc123');
    });

    it('handles production URLs', () => {
      expect(resourceIdToURI(resourceId('doc-abc123'), 'https://api.semiont.app')).toBe('https://api.semiont.app/resources/doc-abc123');
    });

    it('handles content-addressable resource IDs', () => {
      const contentId = 'doc-sha256:a1b2c3d4e5f6';
      expect(resourceIdToURI(resourceId(contentId), publicURL)).toBe(`http://localhost:4000/resources/${contentId}`);
    });
  });

  describe('uriToResourceId', () => {
    it('extracts resource ID from URI', () => {
      expect(uriToResourceId('http://localhost:4000/resources/doc-abc123')).toBe('doc-abc123');
    });

    it('extracts from production URLs', () => {
      expect(uriToResourceId('https://api.semiont.app/resources/doc-abc123')).toBe('doc-abc123');
    });

    it('extracts content-addressable resource IDs', () => {
      const contentId = 'doc-sha256:a1b2c3d4e5f6';
      expect(uriToResourceId(`http://localhost:4000/resources/${contentId}`)).toBe(contentId);
    });

    it('handles URLs with query parameters', () => {
      expect(uriToResourceId('http://localhost:4000/resources/doc-abc123?version=1')).toBe('doc-abc123');
    });

    it('handles URLs with hash fragments', () => {
      expect(uriToResourceId('http://localhost:4000/resources/doc-abc123#section1')).toBe('doc-abc123');
    });

    it('throws error for invalid resource URI', () => {
      expect(() => uriToResourceId('http://localhost:4000/invalid/path')).toThrow('Invalid resource URI');
    });

    it('throws error for malformed URL', () => {
      expect(() => uriToResourceId('not-a-valid-url')).toThrow();
    });
  });

  describe('annotationIdToURI', () => {
    const publicURL = 'http://localhost:4000';

    it('converts annotation ID to URI', () => {
      expect(annotationIdToURI(annotationId('anno-xyz789'), publicURL)).toBe('http://localhost:4000/annotations/anno-xyz789');
    });

    it('handles BACKEND_URL with trailing slash', () => {
      expect(annotationIdToURI(annotationId('anno-xyz789'), 'http://localhost:4000/')).toBe('http://localhost:4000/annotations/anno-xyz789');
    });

    it('handles production URLs', () => {
      expect(annotationIdToURI(annotationId('anno-xyz789'), 'https://api.semiont.app')).toBe('https://api.semiont.app/annotations/anno-xyz789');
    });

    it('handles nanoid-style annotation IDs', () => {
      const nanoidAnnotation = 'anno-V1StGXR8_Z5jdHi6B-myT';
      expect(annotationIdToURI(annotationId(nanoidAnnotation), publicURL)).toBe(`http://localhost:4000/annotations/${nanoidAnnotation}`);
    });
  });

  describe('uriToAnnotationId', () => {
    it('extracts annotation ID from URI', () => {
      expect(uriToAnnotationId('http://localhost:4000/annotations/anno-xyz789')).toBe('anno-xyz789');
    });

    it('extracts from production URLs', () => {
      expect(uriToAnnotationId('https://api.semiont.app/annotations/anno-xyz789')).toBe('anno-xyz789');
    });

    it('extracts nanoid-style annotation IDs', () => {
      const nanoidAnnotation = 'anno-V1StGXR8_Z5jdHi6B-myT';
      expect(uriToAnnotationId(`http://localhost:4000/annotations/${nanoidAnnotation}`)).toBe(nanoidAnnotation);
    });

    it('handles URLs with query parameters', () => {
      expect(uriToAnnotationId('http://localhost:4000/annotations/anno-xyz789?format=jsonld')).toBe('anno-xyz789');
    });

    it('handles URLs with hash fragments', () => {
      expect(uriToAnnotationId('http://localhost:4000/annotations/anno-xyz789#metadata')).toBe('anno-xyz789');
    });

    it('throws error for invalid annotation URI', () => {
      expect(() => uriToAnnotationId('http://localhost:4000/invalid/path')).toThrow('Invalid annotation URI');
    });

    it('throws error for malformed URL', () => {
      expect(() => uriToAnnotationId('not-a-valid-url')).toThrow();
    });
  });

  describe('Round-trip conversion', () => {
    const publicURL = 'http://localhost:4000';

    it('resource ID -> URI -> ID', () => {
      const originalId = 'doc-abc123';
      const uri = resourceIdToURI(resourceId(originalId), publicURL);
      const extractedId = uriToResourceId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('annotation ID -> URI -> ID', () => {
      const originalId = 'anno-xyz789';
      const uri = annotationIdToURI(annotationId(originalId), publicURL);
      const extractedId = uriToAnnotationId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('handles different environments consistently', () => {
      const docId = 'doc-abc123';

      // Local
      const localUri = resourceIdToURI(resourceId(docId), 'http://localhost:4000');
      expect(uriToResourceId(localUri)).toBe(docId);

      // Production
      const prodUri = resourceIdToURI(resourceId(docId), 'https://api.semiont.app');
      expect(uriToResourceId(prodUri)).toBe(docId);
    });
  });
});
