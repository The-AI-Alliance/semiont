/**
 * Unit tests for `APIError`.
 *
 * Covers the discriminated `code` field's status-to-code mapping
 * (`classifyApiCode`) and the inheritance/details wiring that lets
 * consumers catch broadly on `SemiontError` or narrowly on `APIError`.
 */

import { describe, it, expect } from 'vitest';
import { SemiontError, type TransportErrorCode } from '@semiont/core';

import { APIError } from '../http-transport';

describe('APIError', () => {
  describe('classifyApiCode (via constructor)', () => {
    const cases: Array<[number, TransportErrorCode]> = [
      [400, 'bad-request'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [409, 'conflict'],
      [500, 'unavailable'],
      [502, 'unavailable'],
      [503, 'unavailable'],
      [504, 'unavailable'],
      [418, 'error'], // not specifically classified
      [429, 'error'],
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
        expect(err.code).toBe('forbidden');
      }
    });
  });
});
