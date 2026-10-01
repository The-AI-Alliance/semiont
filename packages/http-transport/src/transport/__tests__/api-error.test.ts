/**
 * Unit tests for `APIError`.
 *
 * Covers the discriminated `code` field's status-to-code mapping
 * (`transportErrorCodeForStatus`), the caller-stated code of an exchange that
 * got no response, and the inheritance/details wiring that lets consumers
 * catch broadly on `SemiontError` or narrowly on `APIError`.
 */

import { describe, it, expect } from 'vitest';
import { SemiontError, type TransportErrorCode } from '@semiont/core';

import { APIError } from '../api-error';

describe('APIError', () => {
  describe('transportErrorCodeForStatus (via fromStatus)', () => {
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
      [429, 'rate-limited'],
    ];

    it.each(cases)('status %d maps to %s', (status, expectedCode) => {
      const err = APIError.fromStatus('msg', status, 'Status Text', undefined, undefined);
      expect(err.code).toBe(expectedCode);
    });
  });

  describe('withoutResponse', () => {
    const cases: TransportErrorCode[] = ['unavailable', 'error'];

    it.each(cases)('carries the code the caller states: %s', (code) => {
      const err = APIError.withoutResponse('msg', code, 'network-error');
      expect(err.code).toBe(code);
    });

    it('has no status, body, or retry wait to report', () => {
      const err = APIError.withoutResponse('Network error during upload', 'unavailable', 'network-error');
      expect(err).toBeInstanceOf(APIError);
      expect(err.name).toBe('APIError');
      expect(err.message).toBe('Network error during upload');
      expect(err.status).toBe(0);
      expect(err.statusText).toBe('network-error');
      expect(err.retryAfterMs).toBeUndefined();
      expect(err.details).toEqual({ status: 0, statusText: 'network-error', body: undefined });
    });
  });

  describe('shape', () => {
    it('exposes status and statusText as readonly fields', () => {
      const err = APIError.fromStatus('Not Found', 404, 'Not Found', undefined, undefined);
      expect(err.status).toBe(404);
      expect(err.statusText).toBe('Not Found');
    });

    it('preserves message', () => {
      const err = APIError.fromStatus('the message', 500, 'Internal Server Error', undefined, undefined);
      expect(err.message).toBe('the message');
    });

    it('sets name to APIError', () => {
      const err = APIError.fromStatus('m', 400, 'Bad Request', undefined, undefined);
      expect(err.name).toBe('APIError');
    });

    it('packs status, statusText, and body into `details`', () => {
      const body = { error: 'denied', detail: 'token expired' };
      const err = APIError.fromStatus('Unauthorized', 401, 'Unauthorized', body, undefined);
      expect(err.details).toEqual({
        status: 401,
        statusText: 'Unauthorized',
        body,
      });
    });

    it('omits body in details when not provided', () => {
      const err = APIError.fromStatus('m', 500, 'Internal Server Error', undefined, undefined);
      expect(err.details).toEqual({
        status: 500,
        statusText: 'Internal Server Error',
        body: undefined,
      });
    });
  });

  describe('hierarchy', () => {
    it('extends SemiontError', () => {
      const err = APIError.fromStatus('m', 401, 'Unauthorized', undefined, undefined);
      expect(err).toBeInstanceOf(APIError);
      expect(err).toBeInstanceOf(SemiontError);
      expect(err).toBeInstanceOf(Error);
    });

    it('catches as SemiontError', () => {
      try {
        throw APIError.fromStatus('m', 403, 'Forbidden', undefined, undefined);
      } catch (err) {
        if (!(err instanceof SemiontError)) throw err;
        expect(err.code).toBe('forbidden');
      }
    });
  });
});
