import { describe, it, expect } from 'vitest';
import { toResourceUri, toAnnotationUri } from '../identifier-utils.js';
import { resourceId, annotationId } from '@semiont/core';

describe('@semiont/event-sourcing - identifier-utils', () => {
  const config = { baseUrl: 'http://localhost:4000' };

  describe('toResourceUri', () => {
    it('should convert resource ID to URI', () => {
      const id = resourceId('test-resource-123');
      const uri = toResourceUri(config, id);

      expect(uri).toBe('http://localhost:4000/resources/test-resource-123');
    });

    it('should throw error if baseUrl is missing', () => {
      const id = resourceId('test-resource-123');
      expect(() => toResourceUri({} as any, id)).toThrow('baseUrl is required');
    });
  });

  describe('toAnnotationUri', () => {
    it('should convert annotation ID to URI', () => {
      const id = annotationId('test-annotation-456');
      const uri = toAnnotationUri(config, id);

      expect(uri).toBe('http://localhost:4000/annotations/test-annotation-456');
    });

    it('should throw error if baseUrl is missing', () => {
      const id = annotationId('test-annotation-456');
      expect(() => toAnnotationUri({} as any, id)).toThrow('baseUrl is required');
    });
  });
});
