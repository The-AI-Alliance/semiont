import { describe, it, expect } from 'vitest';
import {
  toResourceUri,
  toAnnotationUri,
  type IdentifierConfig,
} from '../identifier-service';
import {
  resourceId,
  annotationId,
} from '@semiont/core';

describe('Identifier Conversion Functions', () => {
  const config: IdentifierConfig = { baseUrl: 'http://localhost:4000' };

  describe('toResourceUri', () => {
    it('should convert ResourceId to ResourceUri', () => {
      const id = resourceId('abc123');
      const uri = toResourceUri(config, id);
      expect(uri).toBe('http://localhost:4000/resources/abc123');
    });

    it('should convert plain string ID to ResourceUri', () => {
      const uri = toResourceUri(config, resourceId('abc123'));
      expect(uri).toBe('http://localhost:4000/resources/abc123');
    });

    it('should handle different base URLs', () => {
      const prodConfig = { baseUrl: 'https://example.com' };
      const uri = toResourceUri(prodConfig, resourceId('abc123'));
      expect(uri).toBe('https://example.com/resources/abc123');
    });

    it('should throw error if baseUrl is missing', () => {
      expect(() => toResourceUri({ baseUrl: '' }, resourceId('abc123')))
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
      const uri = toAnnotationUri(config, annotationId('m-abc123xyz'));
      expect(uri).toBe('http://localhost:4000/annotations/m-abc123xyz');
    });

    it('should handle different base URLs', () => {
      const prodConfig = { baseUrl: 'https://example.com' };
      const uri = toAnnotationUri(prodConfig, annotationId('m-abc123'));
      expect(uri).toBe('https://example.com/annotations/m-abc123');
    });

    it('should throw error if baseUrl is missing', () => {
      expect(() => toAnnotationUri({ baseUrl: '' }, annotationId('m-abc123')))
        .toThrow('baseUrl is required');
    });
  });
});
