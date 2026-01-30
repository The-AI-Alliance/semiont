import { describe, it, expect } from 'vitest';
import { QUERY_KEYS } from '../query-keys';
import type { ResourceUri, AnnotationUri, ResourceAnnotationUri } from '@semiont/api-client';

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
      const mockResourceUri = 'r-12345' as ResourceUri;

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
        const key = QUERY_KEYS.resources.detail(mockResourceUri);
        expect(key).toEqual(['resources', mockResourceUri]);
      });

      it('should return correct key for resource by token', () => {
        const key = QUERY_KEYS.resources.byToken('abc123');
        expect(key).toEqual(['resources', 'by-token', 'abc123']);
      });

      it('should return correct key for resource search', () => {
        const key = QUERY_KEYS.resources.search('test query', 10);
        expect(key).toEqual(['resources', 'search', { query: 'test query', limit: 10 }]);
      });

      it('should return correct key for resource events', () => {
        const key = QUERY_KEYS.resources.events(mockResourceUri);
        expect(key).toEqual(['resources', mockResourceUri, 'events']);
      });

      it('should return correct key for resource annotations', () => {
        const key = QUERY_KEYS.resources.annotations(mockResourceUri);
        expect(key).toEqual(['resources', mockResourceUri, 'annotations']);
      });

      it('should return correct key for resource referencedBy', () => {
        const key = QUERY_KEYS.resources.referencedBy(mockResourceUri);
        expect(key).toEqual(['resources', mockResourceUri, 'referenced-by']);
      });

      it('should differentiate between different resources', () => {
        const key1 = QUERY_KEYS.resources.detail('r-111' as ResourceUri);
        const key2 = QUERY_KEYS.resources.detail('r-222' as ResourceUri);
        expect(key1).not.toEqual(key2);
      });
    });

    describe('annotations', () => {
      const mockAnnotationUri = 'a-12345' as AnnotationUri;
      const mockResourceAnnotationUri = 'r-12345/a-67890' as ResourceAnnotationUri;
      const mockResourceUri = 'r-12345' as ResourceUri;

      it('should return correct key for annotation detail', () => {
        const key = QUERY_KEYS.annotations.detail(mockAnnotationUri);
        expect(key).toEqual(['annotations', mockAnnotationUri]);
      });

      it('should return correct key for annotation history', () => {
        const key = QUERY_KEYS.annotations.history(mockResourceAnnotationUri);
        expect(key).toEqual(['annotations', mockResourceAnnotationUri, 'history']);
      });

      it('should return correct key for LLM context', () => {
        const key = QUERY_KEYS.annotations.llmContext(mockResourceUri, 'annotation-123');
        expect(key).toEqual(['annotations', 'llm-context', mockResourceUri, 'annotation-123']);
      });

      it('should differentiate between different annotations', () => {
        const key1 = QUERY_KEYS.annotations.detail('a-111' as AnnotationUri);
        const key2 = QUERY_KEYS.annotations.detail('a-222' as AnnotationUri);
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

    describe('documents (legacy alias)', () => {
      const mockResourceUri = 'r-legacy' as ResourceUri;

      it('should match resources.all for backward compatibility', () => {
        const legacyKey = QUERY_KEYS.documents.all();
        const newKey = QUERY_KEYS.resources.all();
        expect(legacyKey).toEqual(newKey);
      });

      it('should match resources.all with params', () => {
        const legacyKey = QUERY_KEYS.documents.all(50, true);
        const newKey = QUERY_KEYS.resources.all(50, true);
        expect(legacyKey).toEqual(newKey);
      });

      it('should match resources.detail', () => {
        const legacyKey = QUERY_KEYS.documents.detail(mockResourceUri);
        const newKey = QUERY_KEYS.resources.detail(mockResourceUri);
        expect(legacyKey).toEqual(newKey);
      });

      it('should match resources.byToken', () => {
        const legacyKey = QUERY_KEYS.documents.byToken('token123');
        const newKey = QUERY_KEYS.resources.byToken('token123');
        expect(legacyKey).toEqual(newKey);
      });

      it('should match resources.search', () => {
        const legacyKey = QUERY_KEYS.documents.search('query', 20);
        const newKey = QUERY_KEYS.resources.search('query', 20);
        expect(legacyKey).toEqual(newKey);
      });

      it('should match resources.events', () => {
        const legacyKey = QUERY_KEYS.documents.events(mockResourceUri);
        const newKey = QUERY_KEYS.resources.events(mockResourceUri);
        expect(legacyKey).toEqual(newKey);
      });

      it('should match resources.annotations', () => {
        const legacyKey = QUERY_KEYS.documents.annotations(mockResourceUri);
        const newKey = QUERY_KEYS.resources.annotations(mockResourceUri);
        expect(legacyKey).toEqual(newKey);
      });

      it('should match resources.referencedBy', () => {
        const legacyKey = QUERY_KEYS.documents.referencedBy(mockResourceUri);
        const newKey = QUERY_KEYS.resources.referencedBy(mockResourceUri);
        expect(legacyKey).toEqual(newKey);
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
        const rUri = 'r-test' as ResourceUri;
        const keys = [
          QUERY_KEYS.resources.detail(rUri),
          QUERY_KEYS.resources.events(rUri),
          QUERY_KEYS.resources.annotations(rUri),
          QUERY_KEYS.resources.referencedBy(rUri),
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
        expect(QUERY_KEYS.annotations.detail('a-1' as AnnotationUri)[0]).toBe('annotations');
      });
    });
  });
});
