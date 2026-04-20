/**
 * AuthShell — the part of the provider tree that requires authentication.
 *
 * Mounts the protected error boundary and the two auth-failure modals.
 * The session state (KB list, active KB, per-KB SemiontSession) is owned
 * by the module-scoped `SemiontBrowser` singleton, made available via
 * `<SemiontProvider>` at the app root; the modals read directly from the
 * active session's observables.
 *
 * Mount this at the top of any layout that hosts authenticated routes
 * (know/, admin/, moderate/, auth/welcome/). Do NOT mount it at the
 * locale layout level — pre-app routes (landing, OAuth flow) should not
 * trigger session validation.
 */

import React from 'react';
import { useLocation } from 'react-router-dom';
import {
  ProtectedErrorBoundary,
  SessionExpiredModal,
  PermissionDeniedModal,
} from '@semiont/react-ui';

export function AuthShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <ProtectedErrorBoundary resetKeys={[location.pathname]}>
      <SessionExpiredModal />
      <PermissionDeniedModal />
      {children}
    </ProtectedErrorBoundary>
  );
}
