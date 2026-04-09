/**
 * Module-scoped session-expired / permission-denied notifier.
 *
 * The provider registers itself with this module-scoped slot on mount and
 * unregisters on unmount via {@link registerAuthNotifyHandlers}. Code outside
 * the React tree (notably the React Query QueryCache.onError handler in app
 * providers) calls {@link notifySessionExpired} or {@link notifyPermissionDenied}
 * to reach the active provider.
 *
 * When no provider is mounted (e.g. on the landing page), these calls are
 * no-ops — there is nothing to notify.
 *
 * No React imports — this is plain module state. The provider effect that
 * calls `registerAuthNotifyHandlers` runs inside React but the module itself
 * is React-agnostic.
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
 * Returns an unregister callback. Intended to be called from a React useEffect
 * with the cleanup callback returned from the effect.
 *
 * Only one provider is expected to be mounted at a time. If a second provider
 * mounts before the first unmounts, its handlers replace the previous ones —
 * the previous provider becomes deaf to notifications. In practice this only
 * happens during the brief window of a React StrictMode double-mount or a
 * test that mounts and unmounts multiple providers rapidly.
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
