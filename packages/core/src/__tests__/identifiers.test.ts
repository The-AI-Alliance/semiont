import { describe, it, expect } from 'vitest';
import { resourceId, annotationId, isResourceId, isAnnotationId } from '../identifiers.js';

describe('@semiont/core - identifiers', () => {
  describe('resourceId', () => {
    it('should create a valid resource ID from a string', () => {
      const id = resourceId('test-resource-123');
      expect(id).toBe('test-resource-123');
    });

    it('should reject URIs with slashes', () => {
      expect(() => resourceId('/resources/123')).toThrow(TypeError);
      expect(() => resourceId('resources/123')).toThrow(TypeError);
    });
  });

  describe('annotationId', () => {
    it('should create a valid annotation ID from a string', () => {
      const id = annotationId('test-annotation-456');
      expect(id).toBe('test-annotation-456');
    });

    it('should reject URIs with slashes', () => {
      expect(() => annotationId('/annotations/456')).toThrow(TypeError);
      expect(() => annotationId('annotations/456')).toThrow(TypeError);
    });
  });

  describe('isResourceId', () => {
    it('should return true for valid resource IDs', () => {
      expect(isResourceId('resource-123')).toBe(true);
      expect(isResourceId('abc123')).toBe(true);
    });

    it('should return false for URIs', () => {
      expect(isResourceId('/resources/123')).toBe(false);
      expect(isResourceId('resources/123')).toBe(false);
    });
  });

  describe('isAnnotationId', () => {
    it('should return true for valid annotation IDs', () => {
      expect(isAnnotationId('annotation-456')).toBe(true);
      expect(isAnnotationId('xyz789')).toBe(true);
    });

    it('should return false for URIs', () => {
      expect(isAnnotationId('/annotations/456')).toBe(false);
      expect(isAnnotationId('annotations/456')).toBe(false);
    });
  });
});
