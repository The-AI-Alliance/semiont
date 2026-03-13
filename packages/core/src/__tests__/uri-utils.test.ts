import { describe, it, expect } from 'vitest';
import { resourceIdToURI, annotationIdToURI, uriToAnnotationId, uriToResourceId } from '../uri-utils';
import { resourceId, annotationId } from '../identifiers';

describe('@semiont/core - uri-utils', () => {
  describe('resourceIdToURI', () => {
    it('should convert resource ID to full URI', () => {
      const id = resourceId('doc-abc123');
      const uri = resourceIdToURI(id, 'https://api.semiont.app');

      expect(uri).toBe('https://api.semiont.app/resources/doc-abc123');
    });

    it('should handle trailing slash in publicURL', () => {
      const id = resourceId('doc-abc123');
      const uri = resourceIdToURI(id, 'https://api.semiont.app/');

      expect(uri).toBe('https://api.semiont.app/resources/doc-abc123');
    });

    it('should handle publicURL without trailing slash', () => {
      const id = resourceId('test-resource');
      const uri = resourceIdToURI(id, 'https://example.com');

      expect(uri).toBe('https://example.com/resources/test-resource');
    });

    it('should work with different domains', () => {
      const id = resourceId('my-doc');
      const uri1 = resourceIdToURI(id, 'http://localhost:4000');
      const uri2 = resourceIdToURI(id, 'https://staging.example.org');

      expect(uri1).toBe('http://localhost:4000/resources/my-doc');
      expect(uri2).toBe('https://staging.example.org/resources/my-doc');
    });
  });

  describe('annotationIdToURI', () => {
    it('should convert annotation ID to full URI', () => {
      const id = annotationId('anno-xyz789');
      const uri = annotationIdToURI(id, 'https://api.semiont.app');

      expect(uri).toBe('https://api.semiont.app/annotations/anno-xyz789');
    });

    it('should handle trailing slash in publicURL', () => {
      const id = annotationId('test-annotation');
      const uri = annotationIdToURI(id, 'https://api.semiont.app/');

      expect(uri).toBe('https://api.semiont.app/annotations/test-annotation');
    });
  });

  describe('uriToResourceId', () => {
    it('should extract resource ID from full URI', () => {
      const id = uriToResourceId('https://api.semiont.app/resources/doc-abc123');
      expect(id).toBe('doc-abc123');
    });

    it('should extract resource ID from localhost URI', () => {
      const id = uriToResourceId('http://localhost:4000/resources/my-doc');
      expect(id).toBe('my-doc');
    });

    it('should return bare ID as-is', () => {
      const id = uriToResourceId('doc-abc123');
      expect(id).toBe('doc-abc123');
    });

    it('should return UUID as-is', () => {
      const id = uriToResourceId('550e8400-e29b-41d4-a716-446655440000');
      expect(id).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should throw on URI without /resources/ path', () => {
      expect(() => uriToResourceId('https://api.semiont.app/annotations/foo'))
        .toThrow('Invalid resource URI');
    });
  });

  describe('uriToAnnotationId', () => {
    it('should extract annotation ID from full URI', () => {
      const uri = 'https://api.semiont.app/annotations/anno-xyz789';
      const id = uriToAnnotationId(uri);

      expect(id).toBe('anno-xyz789');
    });

    it('should throw on invalid URI format', () => {
      expect(() => uriToAnnotationId('https://api.semiont.app/invalid'))
        .toThrow('Invalid annotation URI');
    });

    it('should throw on missing annotation path', () => {
      expect(() => uriToAnnotationId('https://api.semiont.app/'))
        .toThrow('Invalid annotation URI');
    });
  });
});
