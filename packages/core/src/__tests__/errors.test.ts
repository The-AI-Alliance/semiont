import { describe, it, expect } from 'vitest';
import {
  SemiontError,
  ValidationError,
  ScriptError,
  NotFoundError,
  UnauthorizedError,
  ConflictError,
} from '../errors.js';

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

  describe('ValidationError', () => {
    it('sets code to VALIDATION_ERROR and forwards details', () => {
      const err = new ValidationError('bad input', { field: 'email' });
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.details).toEqual({ field: 'email' });
      expect(err.name).toBe('ValidationError');
      expect(err).toBeInstanceOf(SemiontError);
    });
  });

  describe('ScriptError', () => {
    it('defaults code to SCRIPT_ERROR', () => {
      const err = new ScriptError('script failed');
      expect(err.code).toBe('SCRIPT_ERROR');
      expect(err.name).toBe('ScriptError');
    });

    it('accepts an explicit code and details', () => {
      const err = new ScriptError('script failed', 'CUSTOM_SCRIPT_CODE', { stage: 'init' });
      expect(err.code).toBe('CUSTOM_SCRIPT_CODE');
      expect(err.details).toEqual({ stage: 'init' });
    });
  });

  describe('NotFoundError', () => {
    it('builds the message with both resource and id', () => {
      const err = new NotFoundError('User', 'u-1');
      expect(err.message).toBe("User with id 'u-1' not found");
      expect(err.code).toBe('NOT_FOUND');
      expect(err.details).toEqual({ resource: 'User', id: 'u-1' });
      expect(err.name).toBe('NotFoundError');
    });

    it('omits id from message when absent', () => {
      const err = new NotFoundError('Resource');
      expect(err.message).toBe('Resource not found');
      expect(err.details).toEqual({ resource: 'Resource', id: undefined });
    });
  });

  describe('UnauthorizedError', () => {
    it('defaults the message to "Unauthorized"', () => {
      const err = new UnauthorizedError();
      expect(err.message).toBe('Unauthorized');
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.name).toBe('UnauthorizedError');
    });

    it('accepts a custom message and details', () => {
      const err = new UnauthorizedError('token expired', { reason: 'jwt-exp' });
      expect(err.message).toBe('token expired');
      expect(err.details).toEqual({ reason: 'jwt-exp' });
    });
  });

  describe('ConflictError', () => {
    it('sets code to CONFLICT and forwards details', () => {
      const err = new ConflictError('duplicate', { field: 'email' });
      expect(err.code).toBe('CONFLICT');
      expect(err.details).toEqual({ field: 'email' });
      expect(err.name).toBe('ConflictError');
      expect(err).toBeInstanceOf(SemiontError);
    });
  });

  describe('hierarchy', () => {
    it('every subclass is catchable as SemiontError', () => {
      const errors: SemiontError[] = [
        new ValidationError('v'),
        new ScriptError('s'),
        new NotFoundError('R'),
        new UnauthorizedError(),
        new ConflictError('c'),
      ];
      for (const err of errors) {
        expect(err instanceof SemiontError).toBe(true);
      }
    });
  });
});
