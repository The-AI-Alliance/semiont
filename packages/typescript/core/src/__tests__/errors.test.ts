import { describe, it, expect } from 'vitest';
import { SemiontError } from '../errors.js';

describe('@semiont/core - errors', () => {
  describe('SemiontError', () => {
    it('exposes message, code, and details', () => {
      const err = new SemiontError('boom', 'TEST_CODE', { foo: 'bar' });
      expect(err.message).toBe('boom');
      expect(err.code).toBe('TEST_CODE');
      expect(err.details).toEqual({ foo: 'bar' });
      expect(err.name).toBe('SemiontError');
    });

    it('details is optional', () => {
      const err = new SemiontError('msg', 'CODE');
      expect(err.details).toBeUndefined();
    });

    it('is an Error and instanceof SemiontError', () => {
      const err = new SemiontError('m', 'c');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SemiontError);
    });

    it('captures a stack trace', () => {
      const err = new SemiontError('m', 'c');
      expect(typeof err.stack).toBe('string');
      expect(err.stack).toContain('SemiontError');
    });
  });
});
