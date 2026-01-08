'use client';

import dynamic from 'next/dynamic';

// Dynamically import modals and banners to avoid SSR issues with context hooks
// Using standard Next.js pattern for named exports with ssr: false
const SessionExpiryBanner = dynamic(
  () => import('@semiont/react-ui').then(mod => mod.SessionExpiryBanner),
  { ssr: false }
);

const SessionExpiredModal = dynamic(
  () => import('@semiont/react-ui').then(mod => mod.SessionExpiredModal),
  { ssr: false }
);

const PermissionDeniedModal = dynamic(
  () => import('@/components/modals/PermissionDeniedModal').then(mod => mod.PermissionDeniedModal),
  { ssr: false }
);

/**
 * Client Component wrapper for modals and banners that use context hooks
 * This component is marked as 'use client' so it can use dynamic imports with ssr: false
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
