/**
 * Module-scoped session-expired / permission-denied notifier.
 *
 * The active SemiontBrowser registers itself with this module-scoped slot
 * via {@link registerAuthNotifyHandlers}. Code outside the React tree
 * (notably the React Query QueryCache.onError handler in app providers)
 * calls {@link notifySessionExpired} or {@link notifyPermissionDenied} to
 * reach the active browser's session.
 *
 * When no browser has registered (e.g. before the singleton boots),
 * these calls are no-ops.
 *
 * No React imports — this is plain module state.
 */

type Notify = (message?: string) => void;

let activeOnSessionExpired: Notify | null = null;
let activeOnPermissionDenied: Notify | null = null;

export function notifySessionExpired(message?: string): void {
  activeOnSessionExpired?.(message);
}

export function notifyPermissionDenied(message?: string): void {
  activeOnPermissionDenied?.(message);
}

/**
 * Install handlers for session-expired and permission-denied notifications.
 * Returns an unregister callback. The SemiontBrowser ctor calls this once;
 * `dispose()` calls the unregister.
 */
export function registerAuthNotifyHandlers(handlers: {
  onSessionExpired: Notify;
  onPermissionDenied: Notify;
}): () => void {
  activeOnSessionExpired = handlers.onSessionExpired;
  activeOnPermissionDenied = handlers.onPermissionDenied;
  return () => {
    activeOnSessionExpired = null;
    activeOnPermissionDenied = null;
  };
}
