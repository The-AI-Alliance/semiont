/**
 * AuthShell — the part of the provider tree that requires authentication.
 *
 * Bundles:
 * - KnowledgeBaseProvider     (which KB is active)
 * - AuthProvider              (validates JWT against the active KB on mount)
 * - SessionProvider           (library context, fed by useSessionManager → useAuth)
 * - AuthErrorBoundary         (catches errors from the auth chain)
 * - SessionExpiredModal       (surfaces 401s)
 * - PermissionDeniedModal     (surfaces 403s)
 *
 * Mount this at the top of any layout that hosts authenticated routes
 * (know/, admin/, moderate/, auth/welcome/). Do NOT mount it at the
 * locale layout level — pre-app routes (landing, OAuth flow) should not
 * trigger token validation.
 */

import React from 'react';
import {
  SessionProvider as CustomSessionProvider,
  SessionExpiredModal,
  PermissionDeniedModal,
} from '@semiont/react-ui';
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary';
import { AuthProvider } from '@/contexts/AuthContext';
import { KnowledgeBaseProvider, useKnowledgeBaseContext } from '@/contexts/KnowledgeBaseContext';
import { useSessionManager } from '@/hooks/useSessionManager';

/**
 * Inner shell — assumes KnowledgeBaseProvider and AuthProvider are mounted.
 * Wires SessionProvider (which depends on useSessionManager → useAuth → AuthContext)
 * and the auth-failure modals.
 */
function AuthShellInner({ children }: { children: React.ReactNode }) {
  const sessionManager = useSessionManager();
  return (
    <AuthErrorBoundary>
      <CustomSessionProvider sessionManager={sessionManager}>
        <SessionExpiredModal />
        <PermissionDeniedModal />
        {children}
      </CustomSessionProvider>
    </AuthErrorBoundary>
  );
}

/**
 * AuthShell with KB-aware re-mount.
 * Re-keys AuthProvider on activeKnowledgeBase.id so switching KBs forces
 * a fresh JWT validation against the new backend.
 */
function KnowledgeBaseAuthBridge({ children }: { children: React.ReactNode }) {
  const { activeKnowledgeBase } = useKnowledgeBaseContext();
  return (
    <AuthProvider key={activeKnowledgeBase?.id ?? '__none__'}>
      <AuthShellInner>{children}</AuthShellInner>
    </AuthProvider>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <KnowledgeBaseProvider>
      <KnowledgeBaseAuthBridge>{children}</KnowledgeBaseAuthBridge>
    </KnowledgeBaseProvider>
  );
}
