/**
 * AuthShell — the part of the provider tree that requires authentication.
 *
 * Mounts the merged KnowledgeBaseSessionProvider (which owns KB list,
 * active KB, and validated session for the active KB), the auth-failure
 * modals, and the protected error boundary.
 *
 * Mount this at the top of any layout that hosts authenticated routes
 * (know/, admin/, moderate/, auth/welcome/). Do NOT mount it at the
 * locale layout level — pre-app routes (landing, OAuth flow) should not
 * trigger token validation.
 */

import React from 'react';
import { useLocation } from 'react-router-dom';
import {
  KnowledgeBaseSessionProvider,
  ProtectedErrorBoundary,
  SessionExpiredModal,
  PermissionDeniedModal,
} from '@semiont/react-ui';

export function AuthShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <KnowledgeBaseSessionProvider>
      {/* Reset the boundary on navigation so a render crash on one page
          recovers automatically when the user navigates away. */}
      <ProtectedErrorBoundary resetKeys={[location.pathname]}>
        <SessionExpiredModal />
        <PermissionDeniedModal />
        {children}
      </ProtectedErrorBoundary>
    </KnowledgeBaseSessionProvider>
  );
}
