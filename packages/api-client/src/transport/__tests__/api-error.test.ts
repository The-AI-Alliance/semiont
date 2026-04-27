/**
 * Unit tests for `APIError`.
 *
 * Covers the discriminated `code` field's status-to-code mapping
 * (`classifyApiCode`) and the inheritance/details wiring that lets
 * consumers catch broadly on `SemiontError` or narrowly on `APIError`.
 */

import { describe, it, expect } from 'vitest';
import { SemiontError } from '@semiont/core';

import { APIError, type APIErrorCode } from '../http-transport';

describe('APIError', () => {
  describe('classifyApiCode (via constructor)', () => {
    const cases: Array<[number, APIErrorCode]> = [
      [400, 'api.bad-request'],
      [401, 'api.unauthorized'],
      [403, 'api.forbidden'],
      [404, 'api.not-found'],
      [409, 'api.conflict'],
      [500, 'api.server-error'],
      [502, 'api.server-error'],
      [503, 'api.server-error'],
      [504, 'api.server-error'],
      [418, 'api.error'], // not specifically classified
      [429, 'api.error'],
    ];

    it.each(cases)('status %d maps to %s', (status, expectedCode) => {
      const err = new APIError('msg', status, 'Status Text');
      expect(err.code).toBe(expectedCode);
    });
  });

  describe('shape', () => {
    it('exposes status and statusText as readonly fields', () => {
      const err = new APIError('Not Found', 404, 'Not Found');
      expect(err.status).toBe(404);
      expect(err.statusText).toBe('Not Found');
    });

    it('preserves message', () => {
      const err = new APIError('the message', 500, 'Internal Server Error');
      expect(err.message).toBe('the message');
    });

    it('sets name to APIError', () => {
      const err = new APIError('m', 400, 'Bad Request');
      expect(err.name).toBe('APIError');
    });

    it('packs status, statusText, and body into `details`', () => {
      const body = { error: 'denied', detail: 'token expired' };
      const err = new APIError('Unauthorized', 401, 'Unauthorized', body);
      expect(err.details).toEqual({
        status: 401,
        statusText: 'Unauthorized',
        body,
      });
    });

    it('omits body in details when not provided', () => {
      const err = new APIError('m', 500, 'Internal Server Error');
      expect(err.details).toEqual({
        status: 500,
        statusText: 'Internal Server Error',
        body: undefined,
      });
    });
  });

  describe('hierarchy', () => {
    it('extends SemiontError', () => {
      const err = new APIError('m', 401, 'Unauthorized');
      expect(err).toBeInstanceOf(APIError);
      expect(err).toBeInstanceOf(SemiontError);
      expect(err).toBeInstanceOf(Error);
    });

    it('catches as SemiontError', () => {
      try {
        throw new APIError('m', 403, 'Forbidden');
      } catch (err) {
        if (!(err instanceof SemiontError)) throw err;
        expect(err.code).toBe('api.forbidden');
      }
    });
  });
});
