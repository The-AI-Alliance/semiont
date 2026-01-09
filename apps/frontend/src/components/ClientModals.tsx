'use client';

import { SessionExpiryBanner, SessionExpiredModal } from '@semiont/react-ui';
import { PermissionDeniedModal } from '@/components/modals/PermissionDeniedModal';

/**
 * Client Component wrapper for modals and banners that use context hooks
 * This component is marked as 'use client' so static imports work without SSR
 */
export function ClientModals() {
  return (
    <>
      <SessionExpiryBanner />
      <SessionExpiredModal />
      <PermissionDeniedModal />
    </>
  );
}
