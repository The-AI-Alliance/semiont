import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AUTH_EVENTS,
  dispatchAuthEvent,
  onAuthEvent,
  dispatch401Error,
  dispatch403Error,
} from '../auth-events';

describe('auth-events', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('AUTH_EVENTS', () => {
    it('defines event type constants', () => {
      expect(AUTH_EVENTS.UNAUTHORIZED).toBe('auth:unauthorized');
      expect(AUTH_EVENTS.FORBIDDEN).toBe('auth:forbidden');
      expect(AUTH_EVENTS.SESSION_EXPIRED).toBe('auth:session-expired');
    });
  });

  describe('dispatchAuthEvent', () => {
    it('dispatches a CustomEvent on window', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      dispatchAuthEvent(AUTH_EVENTS.UNAUTHORIZED, { statusCode: 401 });

      expect(spy).toHaveBeenCalledTimes(1);
      const event = spy.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe('auth:unauthorized');
      expect(event.detail.statusCode).toBe(401);
      expect(event.detail.timestamp).toBeGreaterThan(0);
    });

    it('includes a timestamp even when no detail provided', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      dispatchAuthEvent(AUTH_EVENTS.FORBIDDEN);

      const event = spy.mock.calls[0][0] as CustomEvent;
      expect(event.detail.timestamp).toBeGreaterThan(0);
    });
  });

  describe('onAuthEvent', () => {
    it('registers handler and calls it on dispatch', () => {
      const handler = vi.fn();
      const cleanup = onAuthEvent(AUTH_EVENTS.UNAUTHORIZED, handler);

      dispatchAuthEvent(AUTH_EVENTS.UNAUTHORIZED, { message: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.detail.message).toBe('test');

      cleanup();
    });

    it('returns cleanup function that removes listener', () => {
      const handler = vi.fn();
      const cleanup = onAuthEvent(AUTH_EVENTS.UNAUTHORIZED, handler);
      cleanup();

      dispatchAuthEvent(AUTH_EVENTS.UNAUTHORIZED);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not fire for different event types', () => {
      const handler = vi.fn();
      const cleanup = onAuthEvent(AUTH_EVENTS.UNAUTHORIZED, handler);

      dispatchAuthEvent(AUTH_EVENTS.FORBIDDEN);
      expect(handler).not.toHaveBeenCalled();

      cleanup();
    });
  });

  describe('dispatch401Error', () => {
    it('dispatches UNAUTHORIZED with default message', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      dispatch401Error();

      const event = spy.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe('auth:unauthorized');
      expect(event.detail.message).toBe('Your session has expired');
      expect(event.detail.statusCode).toBe(401);
    });

    it('dispatches UNAUTHORIZED with custom message', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      dispatch401Error('Token invalid');

      const event = spy.mock.calls[0][0] as CustomEvent;
      expect(event.detail.message).toBe('Token invalid');
    });
  });

  describe('dispatch403Error', () => {
    it('dispatches FORBIDDEN with default message', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      dispatch403Error();

      const event = spy.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe('auth:forbidden');
      expect(event.detail.message).toBe('You do not have permission to perform this action');
      expect(event.detail.statusCode).toBe(403);
    });

    it('dispatches FORBIDDEN with custom message', () => {
      const spy = vi.spyOn(window, 'dispatchEvent');
      dispatch403Error('Admin only');

      const event = spy.mock.calls[0][0] as CustomEvent;
      expect(event.detail.message).toBe('Admin only');
    });
  });
});
