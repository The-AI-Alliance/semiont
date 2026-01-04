/**
 * Global authentication event system for coordinating auth state across components
 */

// Custom event types for authentication
export const AUTH_EVENTS = {
  UNAUTHORIZED: 'auth:unauthorized', // 401 error from API
  FORBIDDEN: 'auth:forbidden',       // 403 error from API
  SESSION_EXPIRED: 'auth:session-expired',
} as const;

export type AuthEventType = typeof AUTH_EVENTS[keyof typeof AUTH_EVENTS];

export interface AuthEventDetail {
  message?: string;
  statusCode?: number;
  timestamp: number;
}

/**
 * Dispatch an authentication event
 */
export function dispatchAuthEvent(type: AuthEventType, detail?: Partial<AuthEventDetail>) {
  if (typeof window === 'undefined') return;

  const event = new CustomEvent(type, {
    detail: {
      timestamp: Date.now(),
      ...detail,
    },
  });

  window.dispatchEvent(event);
}

/**
 * Listen for authentication events
 */
export function onAuthEvent(
  type: AuthEventType,
  handler: (event: CustomEvent<AuthEventDetail>) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const typedHandler = (event: Event) => {
    handler(event as CustomEvent<AuthEventDetail>);
  };

  window.addEventListener(type, typedHandler);

  // Return cleanup function
  return () => {
    window.removeEventListener(type, typedHandler);
  };
}

/**
 * Dispatch a 401 Unauthorized event
 */
export function dispatch401Error(message?: string) {
  dispatchAuthEvent(AUTH_EVENTS.UNAUTHORIZED, {
    message: message || 'Your session has expired',
    statusCode: 401,
  });
}

/**
 * Dispatch a 403 Forbidden event
 */
export function dispatch403Error(message?: string) {
  dispatchAuthEvent(AUTH_EVENTS.FORBIDDEN, {
    message: message || 'You do not have permission to perform this action',
    statusCode: 403,
  });
}