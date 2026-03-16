import LinkedDataClient from './client';

// Authentication is handled by middleware (proxy.ts)
// Only authenticated moderators/admins can reach this page

export default function LinkedDataPage() {
  return <LinkedDataClient />;
}
