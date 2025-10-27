/**
 * Tests for URI utilities
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { documentIdToURI, uriToDocumentId, annotationIdToURI, uriToAnnotationId } from '../uri-utils';

describe('URI Utilities', () => {
  beforeEach(() => {
    // Set BACKEND_URL for tests
    process.env.BACKEND_URL = 'http://localhost:4000';
  });

  describe('documentIdToURI', () => {
    it('converts document ID to URI', () => {
      expect(documentIdToURI('doc-abc123')).toBe('http://localhost:4000/documents/doc-abc123');
    });

    it('handles BACKEND_URL with trailing slash', () => {
      process.env.BACKEND_URL = 'http://localhost:4000/';
      expect(documentIdToURI('doc-abc123')).toBe('http://localhost:4000/documents/doc-abc123');
    });

    it('handles production URLs', () => {
      process.env.BACKEND_URL = 'https://api.semiont.app';
      expect(documentIdToURI('doc-abc123')).toBe('https://api.semiont.app/documents/doc-abc123');
    });

    it('handles content-addressable document IDs', () => {
      const contentId = 'doc-sha256:a1b2c3d4e5f6';
      expect(documentIdToURI(contentId)).toBe(`http://localhost:4000/documents/${contentId}`);
    });
  });

  describe('uriToDocumentId', () => {
    it('extracts document ID from URI', () => {
      expect(uriToDocumentId('http://localhost:4000/documents/doc-abc123')).toBe('doc-abc123');
    });

    it('extracts from production URLs', () => {
      expect(uriToDocumentId('https://api.semiont.app/documents/doc-abc123')).toBe('doc-abc123');
    });

    it('extracts content-addressable document IDs', () => {
      const contentId = 'doc-sha256:a1b2c3d4e5f6';
      expect(uriToDocumentId(`http://localhost:4000/documents/${contentId}`)).toBe(contentId);
    });

    it('handles URLs with query parameters', () => {
      expect(uriToDocumentId('http://localhost:4000/documents/doc-abc123?version=1')).toBe('doc-abc123');
    });

    it('handles URLs with hash fragments', () => {
      expect(uriToDocumentId('http://localhost:4000/documents/doc-abc123#section1')).toBe('doc-abc123');
    });

    it('throws error for invalid document URI', () => {
      expect(() => uriToDocumentId('http://localhost:4000/invalid/path')).toThrow('Invalid document URI');
    });

    it('throws error for malformed URL', () => {
      expect(() => uriToDocumentId('not-a-valid-url')).toThrow();
    });
  });

  describe('annotationIdToURI', () => {
    it('converts annotation ID to URI', () => {
      expect(annotationIdToURI('anno-xyz789')).toBe('http://localhost:4000/annotations/anno-xyz789');
    });

    it('handles BACKEND_URL with trailing slash', () => {
      process.env.BACKEND_URL = 'http://localhost:4000/';
      expect(annotationIdToURI('anno-xyz789')).toBe('http://localhost:4000/annotations/anno-xyz789');
    });

    it('handles production URLs', () => {
      process.env.BACKEND_URL = 'https://api.semiont.app';
      expect(annotationIdToURI('anno-xyz789')).toBe('https://api.semiont.app/annotations/anno-xyz789');
    });

    it('handles nanoid-style annotation IDs', () => {
      const nanoidAnnotation = 'anno-V1StGXR8_Z5jdHi6B-myT';
      expect(annotationIdToURI(nanoidAnnotation)).toBe(`http://localhost:4000/annotations/${nanoidAnnotation}`);
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
    it('document ID -> URI -> ID', () => {
      const originalId = 'doc-abc123';
      const uri = documentIdToURI(originalId);
      const extractedId = uriToDocumentId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('annotation ID -> URI -> ID', () => {
      const originalId = 'anno-xyz789';
      const uri = annotationIdToURI(originalId);
      const extractedId = uriToAnnotationId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('handles different environments consistently', () => {
      const docId = 'doc-abc123';

      // Local
      process.env.BACKEND_URL = 'http://localhost:4000';
      const localUri = documentIdToURI(docId);
      expect(uriToDocumentId(localUri)).toBe(docId);

      // Production
      process.env.BACKEND_URL = 'https://api.semiont.app';
      const prodUri = documentIdToURI(docId);
      expect(uriToDocumentId(prodUri)).toBe(docId);
    });
  });
});
