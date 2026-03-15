import { describe, it, expect } from 'vitest';
import { uriToResourceId } from '../uri-utils';

describe('@semiont/core - uri-utils', () => {
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
});
