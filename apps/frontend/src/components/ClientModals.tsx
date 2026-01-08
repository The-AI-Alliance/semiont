'use client';

import dynamic from 'next/dynamic';

// Dynamically import modals and banners to avoid SSR issues with context hooks
// These are named exports from @semiont/react-ui, so we wrap them as default exports
const SessionExpiryBanner = dynamic(
  () => import('@semiont/react-ui').then(mod => {
    const Component = mod.SessionExpiryBanner;
    return { default: Component };
  }),
  { ssr: false }
);

const SessionExpiredModal = dynamic(
  () => import('@semiont/react-ui').then(mod => {
    const Component = mod.SessionExpiredModal;
    return { default: Component };
  }),
  { ssr: false }
);

const PermissionDeniedModal = dynamic(
  () => import('@/components/modals/PermissionDeniedModal').then(mod => {
    const Component = mod.PermissionDeniedModal;
    return { default: Component };
  }),
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
