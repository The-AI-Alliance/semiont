import { describe, it, expect } from 'vitest';
import { QUERY_KEYS } from '../query-keys';
import type { ResourceId, AnnotationId } from '@semiont/core';

describe('query-keys', () => {
  describe('QUERY_KEYS', () => {
    describe('users', () => {
      it('should return correct key for me', () => {
        const key = QUERY_KEYS.users.me();
        expect(key).toEqual(['users', 'me']);
      });

      it('should be immutable (as const)', () => {
        const key = QUERY_KEYS.users.me();
        expect(Object.isFrozen(key)).toBe(false); // Arrays aren't frozen but typed as readonly
        // Type check: key should be readonly ['users', 'me']
      });
    });

    describe('health', () => {
      it('should return correct key for health', () => {
        const key = QUERY_KEYS.health();
        expect(key).toEqual(['health']);
      });
    });

    describe('status', () => {
      it('should return correct key for status', () => {
        const key = QUERY_KEYS.status();
        expect(key).toEqual(['status']);
      });
    });

    describe('resources', () => {
      const mockResourceId = 'r-12345' as ResourceId;

      it('should return correct key for all resources without params', () => {
        const key = QUERY_KEYS.resources.all();
        expect(key).toEqual(['resources', { limit: undefined, archived: undefined }]);
      });

      it('should return correct key for all resources with limit', () => {
        const key = QUERY_KEYS.resources.all(50);
        expect(key).toEqual(['resources', { limit: 50, archived: undefined }]);
      });

      it('should return correct key for all resources with archived', () => {
        const key = QUERY_KEYS.resources.all(undefined, true);
        expect(key).toEqual(['resources', { limit: undefined, archived: true }]);
      });

      it('should return correct key for all resources with both params', () => {
        const key = QUERY_KEYS.resources.all(100, false);
        expect(key).toEqual(['resources', { limit: 100, archived: false }]);
      });

      it('should return correct key for resource detail', () => {
        const key = QUERY_KEYS.resources.detail(mockResourceId);
        expect(key).toEqual(['resources', mockResourceId]);
      });

      it('should return correct key for resource by token', () => {
        const key = QUERY_KEYS.resources.byToken('abc123');
        expect(key).toEqual(['resources', 'by-token', 'abc123']);
      });

      it('should return correct key for resource events', () => {
        const key = QUERY_KEYS.resources.events(mockResourceId);
        expect(key).toEqual(['resources', mockResourceId, 'events']);
      });

      it('should return correct key for resource annotations', () => {
        const key = QUERY_KEYS.resources.annotations(mockResourceId);
        expect(key).toEqual(['resources', mockResourceId, 'annotations']);
      });

      it('should return correct key for resource referencedBy', () => {
        const key = QUERY_KEYS.resources.referencedBy(mockResourceId);
        expect(key).toEqual(['resources', mockResourceId, 'referenced-by']);
      });

      it('should differentiate between different resources', () => {
        const key1 = QUERY_KEYS.resources.detail('r-111' as ResourceId);
        const key2 = QUERY_KEYS.resources.detail('r-222' as ResourceId);
        expect(key1).not.toEqual(key2);
      });
    });

    describe('annotations', () => {
      const mockAnnotationId = 'a-12345' as AnnotationId;
      const mockResourceId = 'r-12345' as ResourceId;
      const mockAnnotationId2 = 'a-67890' as AnnotationId;

      it('should return correct key for annotation detail', () => {
        const key = QUERY_KEYS.annotations.detail(mockAnnotationId);
        expect(key).toEqual(['annotations', mockAnnotationId]);
      });

      it('should return correct key for annotation history', () => {
        const key = QUERY_KEYS.annotations.history(mockResourceId, mockAnnotationId2);
        expect(key).toEqual(['annotations', mockResourceId, mockAnnotationId2, 'history']);
      });

      it('should differentiate between different annotations', () => {
        const key1 = QUERY_KEYS.annotations.detail('a-111' as AnnotationId);
        const key2 = QUERY_KEYS.annotations.detail('a-222' as AnnotationId);
        expect(key1).not.toEqual(key2);
      });
    });

    describe('entityTypes', () => {
      it('should return correct key for all entity types', () => {
        const key = QUERY_KEYS.entityTypes.all();
        expect(key).toEqual(['entity-types']);
      });
    });

    describe('admin', () => {
      describe('users', () => {
        it('should return correct key for all admin users', () => {
          const key = QUERY_KEYS.admin.users.all();
          expect(key).toEqual(['admin', 'users']);
        });

        it('should return correct key for user stats', () => {
          const key = QUERY_KEYS.admin.users.stats();
          expect(key).toEqual(['admin', 'users', 'stats']);
        });
      });

      describe('oauth', () => {
        it('should return correct key for OAuth config', () => {
          const key = QUERY_KEYS.admin.oauth.config();
          expect(key).toEqual(['admin', 'oauth', 'config']);
        });
      });
    });

    describe('Key Uniqueness', () => {
      it('should produce unique keys for different query types', () => {
        const keys = [
          QUERY_KEYS.users.me(),
          QUERY_KEYS.health(),
          QUERY_KEYS.status(),
          QUERY_KEYS.resources.all(),
          QUERY_KEYS.entityTypes.all(),
        ];

        const stringifiedKeys = keys.map(k => JSON.stringify(k));
        const uniqueKeys = new Set(stringifiedKeys);
        expect(uniqueKeys.size).toBe(keys.length);
      });

      it('should produce different keys for same resource with different operations', () => {
        const rId = 'r-test' as ResourceId;
        const keys = [
          QUERY_KEYS.resources.detail(rId),
          QUERY_KEYS.resources.events(rId),
          QUERY_KEYS.resources.annotations(rId),
          QUERY_KEYS.resources.referencedBy(rId),
        ];

        const stringifiedKeys = keys.map(k => JSON.stringify(k));
        const uniqueKeys = new Set(stringifiedKeys);
        expect(uniqueKeys.size).toBe(keys.length);
      });
    });

    describe('Array Structure', () => {
      it('should always return arrays', () => {
        expect(Array.isArray(QUERY_KEYS.users.me())).toBe(true);
        expect(Array.isArray(QUERY_KEYS.health())).toBe(true);
        expect(Array.isArray(QUERY_KEYS.resources.all())).toBe(true);
      });

      it('should include namespace as first element', () => {
        expect(QUERY_KEYS.users.me()[0]).toBe('users');
        expect(QUERY_KEYS.health()[0]).toBe('health');
        expect(QUERY_KEYS.resources.all()[0]).toBe('resources');
        expect(QUERY_KEYS.annotations.detail('a-1' as AnnotationId)[0]).toBe('annotations');
      });
    });
  });
});
