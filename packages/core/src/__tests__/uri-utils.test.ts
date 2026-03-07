import { describe, it, expect } from 'vitest';
import { resourceIdToURI, uriToResourceId, annotationIdToURI, uriToAnnotationId } from '../uri-utils';
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

  describe('uriToResourceId', () => {
    it('should extract resource ID from full URI', () => {
      const uri = 'https://api.semiont.app/resources/doc-abc123';
      const id = uriToResourceId(uri);

      expect(id).toBe('doc-abc123');
    });

    it('should throw on invalid URI format', () => {
      expect(() => uriToResourceId('https://api.semiont.app/invalid'))
        .toThrow('Invalid resource URI');
    });

    it('should throw on missing resource path', () => {
      expect(() => uriToResourceId('https://api.semiont.app/'))
        .toThrow('Invalid resource URI');
    });

    it('should handle different domains', () => {
      const id1 = uriToResourceId('http://localhost:4000/resources/test-123');
      const id2 = uriToResourceId('https://example.org/resources/doc-456');

      expect(id1).toBe('test-123');
      expect(id2).toBe('doc-456');
    });

    it('should handle query parameters', () => {
      const uri = 'https://api.semiont.app/resources/doc-abc123?foo=bar';
      const id = uriToResourceId(uri);

      expect(id).toBe('doc-abc123');
    });

    it('should handle fragments', () => {
      const uri = 'https://api.semiont.app/resources/doc-abc123#section';
      const id = uriToResourceId(uri);

      expect(id).toBe('doc-abc123');
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
