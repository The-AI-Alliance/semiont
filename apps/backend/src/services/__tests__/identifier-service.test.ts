import { describe, it, expect } from 'vitest';
import {
  toResourceUri,
  toAnnotationUri,
  extractResourceId,
  extractAnnotationId,
  normalizeResourceId,
  normalizeAnnotationId,
  type IdentifierConfig,
} from '../identifier-service';
import {
  resourceId,
  annotationId,
} from '@semiont/core';
import {
  resourceUri,
  annotationUri,
} from '@semiont/api-client';

describe('Identifier Conversion Functions', () => {
  const config: IdentifierConfig = { baseUrl: 'http://localhost:4000' };

  describe('toResourceUri', () => {
    it('should convert ResourceId to ResourceUri', () => {
      const id = resourceId('abc123');
      const uri = toResourceUri(config, id);
      expect(uri).toBe('http://localhost:4000/resources/abc123');
    });

    it('should convert plain string ID to ResourceUri', () => {
      const uri = toResourceUri(config, 'abc123');
      expect(uri).toBe('http://localhost:4000/resources/abc123');
    });

    it('should pass through existing URI', () => {
      const existingUri = 'https://example.com/resources/abc123';
      const uri = toResourceUri(config, existingUri);
      expect(uri).toBe('https://example.com/resources/abc123');
    });

    it('should handle different base URLs', () => {
      const prodConfig = { baseUrl: 'https://example.com' };
      const uri = toResourceUri(prodConfig, 'abc123');
      expect(uri).toBe('https://example.com/resources/abc123');
    });

    it('should throw error if baseUrl is missing', () => {
      expect(() => toResourceUri({ baseUrl: '' }, 'abc123'))
        .toThrow('baseUrl is required');
    });
  });

  describe('toAnnotationUri', () => {
    it('should convert AnnotationId to AnnotationUri', () => {
      const id = annotationId('m-abc123xyz');
      const uri = toAnnotationUri(config, id);
      expect(uri).toBe('http://localhost:4000/annotations/m-abc123xyz');
    });

    it('should convert plain string ID to AnnotationUri', () => {
      const uri = toAnnotationUri(config, 'm-abc123xyz');
      expect(uri).toBe('http://localhost:4000/annotations/m-abc123xyz');
    });

    it('should pass through existing URI', () => {
      const existingUri = 'https://example.com/annotations/m-abc123';
      const uri = toAnnotationUri(config, existingUri);
      expect(uri).toBe('https://example.com/annotations/m-abc123');
    });

    it('should handle different base URLs', () => {
      const prodConfig = { baseUrl: 'https://example.com' };
      const uri = toAnnotationUri(prodConfig, 'm-abc123');
      expect(uri).toBe('https://example.com/annotations/m-abc123');
    });

    it('should throw error if baseUrl is missing', () => {
      expect(() => toAnnotationUri({ baseUrl: '' }, 'm-abc123'))
        .toThrow('baseUrl is required');
    });
  });

  describe('extractResourceId', () => {
    it('should extract ResourceId from ResourceUri', () => {
      const uri = resourceUri('http://localhost:4000/resources/abc123');
      const id = extractResourceId(uri);
      expect(id).toBe('abc123');
    });

    it('should extract ResourceId from plain URI string', () => {
      const id = extractResourceId('http://localhost:4000/resources/abc123');
      expect(id).toBe('abc123');
    });

    it('should handle HTTPS URIs', () => {
      const id = extractResourceId('https://example.com/resources/abc123');
      expect(id).toBe('abc123');
    });

    it('should throw error for URIs with trailing slashes', () => {
      expect(() => extractResourceId('http://localhost:4000/resources/abc123/'))
        .toThrow('Cannot extract resource ID from URI');
    });

    it('should throw error for empty ID extraction', () => {
      expect(() => extractResourceId('http://localhost:4000/resources/'))
        .toThrow('Cannot extract resource ID from URI');
    });

    it('should handle complex resource IDs', () => {
      const id = extractResourceId('http://localhost:4000/resources/test-resource-123-xyz');
      expect(id).toBe('test-resource-123-xyz');
    });
  });

  describe('extractAnnotationId', () => {
    it('should extract AnnotationId from AnnotationUri', () => {
      const uri = annotationUri('http://localhost:4000/annotations/m-abc123');
      const id = extractAnnotationId(uri);
      expect(id).toBe('m-abc123');
    });

    it('should extract AnnotationId from plain URI string', () => {
      const id = extractAnnotationId('http://localhost:4000/annotations/m-abc123');
      expect(id).toBe('m-abc123');
    });

    it('should handle HTTPS URIs', () => {
      const id = extractAnnotationId('https://example.com/annotations/m-abc123');
      expect(id).toBe('m-abc123');
    });

    it('should throw error for empty ID extraction', () => {
      expect(() => extractAnnotationId('http://localhost:4000/annotations/'))
        .toThrow('Cannot extract annotation ID from URI');
    });

    it('should handle complex annotation IDs', () => {
      const id = extractAnnotationId('http://localhost:4000/annotations/m-test-123-xyz');
      expect(id).toBe('m-test-123-xyz');
    });
  });

  describe('normalizeResourceId', () => {
    it('should return ResourceId from short ID string', () => {
      const id = normalizeResourceId(config, 'abc123');
      expect(id).toBe('abc123');
    });

    it('should extract ResourceId from URI string matching backend URL', () => {
      const id = normalizeResourceId(config, 'http://localhost:4000/resources/abc123');
      expect(id).toBe('abc123');
    });

    it('should reject URIs that do not match backend URL', () => {
      expect(() => normalizeResourceId(config, 'https://evil.com/resources/abc123'))
        .toThrow('Invalid resource URI: expected http://localhost:4000/resources/*, got https://evil.com/resources/abc123');
    });

    it('should reject URIs with wrong path (annotations instead of resources)', () => {
      expect(() => normalizeResourceId(config, 'http://localhost:4000/annotations/abc123'))
        .toThrow('Invalid resource URI: expected http://localhost:4000/resources/*');
    });

    it('should reject IDs with slashes', () => {
      expect(() => normalizeResourceId(config, 'foo/bar'))
        .toThrow('Invalid resource URI: expected http://localhost:4000/resources/*, got foo/bar');
    });
  });

  describe('normalizeAnnotationId', () => {
    it('should return AnnotationId from short ID string', () => {
      const id = normalizeAnnotationId(config, 'm-abc123');
      expect(id).toBe('m-abc123');
    });

    it('should extract AnnotationId from URI string matching backend URL', () => {
      const id = normalizeAnnotationId(config, 'http://localhost:4000/annotations/m-abc123');
      expect(id).toBe('m-abc123');
    });

    it('should reject URIs that do not match backend URL', () => {
      expect(() => normalizeAnnotationId(config, 'https://evil.com/annotations/m-abc123'))
        .toThrow('Invalid annotation URI: expected http://localhost:4000/annotations/*, got https://evil.com/annotations/m-abc123');
    });

    it('should reject URIs with wrong path (resources instead of annotations)', () => {
      expect(() => normalizeAnnotationId(config, 'http://localhost:4000/resources/m-abc123'))
        .toThrow('Invalid annotation URI: expected http://localhost:4000/annotations/*');
    });

    it('should reject IDs with slashes', () => {
      expect(() => normalizeAnnotationId(config, 'foo/bar'))
        .toThrow('Invalid annotation URI: expected http://localhost:4000/annotations/*, got foo/bar');
    });
  });

  describe('round-trip conversions', () => {
    it('should convert ResourceId to URI and back', () => {
      const originalId = resourceId('abc123');
      const uri = toResourceUri(config, originalId);
      const extractedId = extractResourceId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('should convert AnnotationId to URI and back', () => {
      const originalId = annotationId('m-abc123');
      const uri = toAnnotationUri(config, originalId);
      const extractedId = extractAnnotationId(uri);
      expect(extractedId).toBe(originalId);
    });

    it('should normalize and convert back for resources', () => {
      const uri = 'http://localhost:4000/resources/abc123';
      const id = normalizeResourceId(config, uri);
      const newUri = toResourceUri(config, id);
      expect(newUri).toBe(uri);
    });

    it('should normalize and convert back for annotations', () => {
      const uri = 'http://localhost:4000/annotations/m-abc123';
      const id = normalizeAnnotationId(config, uri);
      const newUri = toAnnotationUri(config, id);
      expect(newUri).toBe(uri);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string ID extraction gracefully', () => {
      expect(() => extractResourceId('http://localhost:4000/resources/'))
        .toThrow('Cannot extract resource ID from URI');
      expect(() => extractAnnotationId('http://localhost:4000/annotations/'))
        .toThrow('Cannot extract annotation ID from URI');
    });

    it('should handle URIs with query parameters', () => {
      const id = extractResourceId('http://localhost:4000/resources/abc123?foo=bar');
      expect(id).toBe('abc123?foo=bar');
    });

    it('should handle URIs with fragments', () => {
      const id = extractAnnotationId('http://localhost:4000/annotations/m-abc123#fragment');
      expect(id).toBe('m-abc123#fragment');
    });
  });
});
