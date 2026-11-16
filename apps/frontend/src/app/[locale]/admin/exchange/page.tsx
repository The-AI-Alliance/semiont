import AdminExchangeClient from './client';

// Authentication is handled by middleware.ts
// Only authenticated admins can reach this page

export default function AdminExchangePage() {
  return <AdminExchangeClient />;
}
