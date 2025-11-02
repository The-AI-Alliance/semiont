import { describe, it, expect } from 'vitest';
import {
  resourceId,
  resourceUri,
  annotationId,
  annotationUri,
  userId,
  isResourceId,
  isResourceUri,
  isAnnotationId,
  isAnnotationUri,
  type ResourceId,
  type ResourceUri,
  type AnnotationId,
  type AnnotationUri,
  type UserId,
} from '@semiont/core';

describe('Branded Identifier Types', () => {
  describe('resourceId', () => {
    it('should create a ResourceId from a valid short ID', () => {
      const id = resourceId('abc123');
      expect(id).toBe('abc123');
    });
    it('should throw TypeError if given a URI', () => {
      expect(() => resourceId('http://localhost:4000/resources/abc123'))
        .toThrow(TypeError);
        .toThrow('Expected ResourceId, got URI');
    it('should reject IDs with slashes', () => {
      expect(() => resourceId('foo/bar')).toThrow(TypeError);
  });
  describe('resourceUri', () => {
    it('should create a ResourceUri from a valid HTTP URI', () => {
      const uri = resourceUri('http://localhost:4000/resources/abc123');
      expect(uri).toBe('http://localhost:4000/resources/abc123');
    it('should create a ResourceUri from a valid HTTPS URI', () => {
      const uri = resourceUri('https://example.com/resources/abc123');
      expect(uri).toBe('https://example.com/resources/abc123');
    it('should throw TypeError if given a short ID', () => {
      expect(() => resourceUri('abc123')).toThrow(TypeError);
      expect(() => resourceUri('abc123')).toThrow('Expected ResourceUri');
    it('should reject non-HTTP/HTTPS URIs', () => {
      expect(() => resourceUri('ftp://example.com/resources/abc')).toThrow(TypeError);
      expect(() => resourceUri('/resources/abc123')).toThrow(TypeError);
  describe('annotationId', () => {
    it('should create an AnnotationId from a valid short ID', () => {
      const id = annotationId('m-abc123xyz');
      expect(id).toBe('m-abc123xyz');
      expect(() => annotationId('http://localhost:4000/annotations/abc123'))
        .toThrow('Expected AnnotationId, got URI');
      expect(() => annotationId('foo/bar')).toThrow(TypeError);
  describe('annotationUri', () => {
    it('should create an AnnotationUri from a valid HTTP URI', () => {
      const uri = annotationUri('http://localhost:4000/annotations/abc123');
      expect(uri).toBe('http://localhost:4000/annotations/abc123');
    it('should create an AnnotationUri from a valid HTTPS URI', () => {
      const uri = annotationUri('https://example.com/annotations/abc123');
      expect(uri).toBe('https://example.com/annotations/abc123');
      expect(() => annotationUri('abc123')).toThrow(TypeError);
      expect(() => annotationUri('abc123')).toThrow('Expected AnnotationUri');
      expect(() => annotationUri('ftp://example.com/annotations/abc')).toThrow(TypeError);
  describe('userId', () => {
    it('should create a UserId from any string', () => {
      const id = userId('user-123');
      expect(id).toBe('user-123');
    it('should accept any string format', () => {
      expect(userId('alice@example.com')).toBe('alice@example.com');
      expect(userId('123')).toBe('123');
      expect(userId('user/123')).toBe('user/123');
  describe('Type guards', () => {
    describe('isResourceId', () => {
      it('should return true for short IDs', () => {
        expect(isResourceId('abc123')).toBe(true);
        expect(isResourceId('test-resource-1')).toBe(true);
      });
      it('should return false for URIs', () => {
        expect(isResourceId('http://localhost:4000/resources/abc123')).toBe(false);
        expect(isResourceId('/resources/abc123')).toBe(false);
        expect(isResourceId('foo/bar')).toBe(false);
    describe('isResourceUri', () => {
      it('should return true for HTTP/HTTPS URIs', () => {
        expect(isResourceUri('http://localhost:4000/resources/abc123')).toBe(true);
        expect(isResourceUri('https://example.com/resources/abc123')).toBe(true);
      it('should return false for short IDs', () => {
        expect(isResourceUri('abc123')).toBe(false);
      it('should return false for non-HTTP URIs', () => {
        expect(isResourceUri('ftp://example.com/resources/abc')).toBe(false);
        expect(isResourceUri('/resources/abc123')).toBe(false);
    describe('isAnnotationId', () => {
        expect(isAnnotationId('m-abc123xyz')).toBe(true);
        expect(isAnnotationId('test-annotation-1')).toBe(true);
        expect(isAnnotationId('http://localhost:4000/annotations/abc123')).toBe(false);
        expect(isAnnotationId('foo/bar')).toBe(false);
    describe('isAnnotationUri', () => {
        expect(isAnnotationUri('http://localhost:4000/annotations/abc123')).toBe(true);
        expect(isAnnotationUri('https://example.com/annotations/abc123')).toBe(true);
        expect(isAnnotationUri('m-abc123')).toBe(false);
        expect(isAnnotationUri('ftp://example.com/annotations/abc')).toBe(false);
  describe('Type safety at compile time', () => {
    it('should prevent mixing different identifier types', () => {
      const resId: ResourceId = resourceId('abc123');
      const resUri: ResourceUri = resourceUri('http://localhost:4000/resources/abc123');
      const annId: AnnotationId = annotationId('m-xyz789');
      const annUri: AnnotationUri = annotationUri('http://localhost:4000/annotations/xyz789');
      const usrId: UserId = userId('user-123');
      // These should be different types at compile time
      // TypeScript will catch these errors:
      // const wrongAssignment: ResourceUri = resId;  // ❌ Type error
      // const wrongAssignment2: AnnotationId = resId; // ❌ Type error
      // But at runtime, they're all strings
      expect(typeof resId).toBe('string');
      expect(typeof resUri).toBe('string');
      expect(typeof annId).toBe('string');
      expect(typeof annUri).toBe('string');
      expect(typeof usrId).toBe('string');
});
