/**
 * Tests for URI utilities
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { resourceIdToURI, uriToResourceId, annotationIdToURI, uriToAnnotationId } from '../uri-utils';
import { resourceId, annotationId } from '@semiont/core';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../../__tests__/_test-setup';
import { resetConfigCache } from '../../config/config';
import * as config from '../../config/config';

describe('URI Utilities', () => {
  let testEnv: TestEnvironmentConfig;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(() => {
    // Reset config cache before each test
    resetConfigCache();
  });

  describe('resourceIdToURI', () => {
    it('converts resource ID to URI', () => {
      expect(resourceIdToURI(resourceId('doc-abc123'))).toBe('http://localhost:4000/resources/doc-abc123');
    });

    it('handles BACKEND_URL with trailing slash', () => {
      vi.spyOn(config, 'getBackendConfig').mockReturnValue({ publicURL: 'http://localhost:4000/' });
      expect(resourceIdToURI(resourceId('doc-abc123'))).toBe('http://localhost:4000/resources/doc-abc123');
      vi.restoreAllMocks();
    });

    it('handles production URLs', () => {
      vi.spyOn(config, 'getBackendConfig').mockReturnValue({ publicURL: 'https://api.semiont.app' });
      expect(resourceIdToURI(resourceId('doc-abc123'))).toBe('https://api.semiont.app/resources/doc-abc123');
      vi.restoreAllMocks();
    });

    it('handles content-addressable resource IDs', () => {
      const contentId = 'doc-sha256:a1b2c3d4e5f6';
      expect(resourceIdToURI(resourceId(contentId))).toBe(`http://localhost:4000/resources/${contentId}`);
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
    it('converts annotation ID to URI', () => {
      expect(annotationIdToURI(annotationId('anno-xyz789'))).toBe('http://localhost:4000/annotations/anno-xyz789');
    });

    it('handles BACKEND_URL with trailing slash', () => {
      vi.spyOn(config, 'getBackendConfig').mockReturnValue({ publicURL: 'http://localhost:4000/' });
      expect(annotationIdToURI(annotationId('anno-xyz789'))).toBe('http://localhost:4000/annotations/anno-xyz789');
      vi.restoreAllMocks();
    });

    it('handles production URLs', () => {
      vi.spyOn(config, 'getBackendConfig').mockReturnValue({ publicURL: 'https://api.semiont.app' });
      expect(annotationIdToURI(annotationId('anno-xyz789'))).toBe('https://api.semiont.app/annotations/anno-xyz789');
      vi.restoreAllMocks();
    });

    it('handles nanoid-style annotation IDs', () => {
      const nanoidAnnotation = 'anno-V1StGXR8_Z5jdHi6B-myT';
      expect(annotationIdToURI(annotationId(nanoidAnnotation))).toBe(`http://localhost:4000/annotations/${nanoidAnnotation}`);
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
    it('resource ID -> URI -> ID', () => {
      const originalId = 'doc-abc123';
      const uri = resourceIdToURI(resourceId(originalId));
      const extractedId = uriToResourceId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('annotation ID -> URI -> ID', () => {
      const originalId = 'anno-xyz789';
      const uri = annotationIdToURI(annotationId(originalId));
      const extractedId = uriToAnnotationId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('handles different environments consistently', () => {
      const docId = 'doc-abc123';

      // Local
      vi.spyOn(config, 'getBackendConfig').mockReturnValue({ publicURL: 'http://localhost:4000' });
      const localUri = resourceIdToURI(resourceId(docId));
      expect(uriToResourceId(localUri)).toBe(docId);
      vi.restoreAllMocks();

      // Production
      vi.spyOn(config, 'getBackendConfig').mockReturnValue({ publicURL: 'https://api.semiont.app' });
      const prodUri = resourceIdToURI(resourceId(docId));
      expect(uriToResourceId(prodUri)).toBe(docId);
      vi.restoreAllMocks();
    });
  });
});
