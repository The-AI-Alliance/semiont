import AdminSecurityClient from './client';

// Authentication is handled by middleware.ts
// Only authenticated admins can reach this page

export default function AdminSecurityPage() {
  return <AdminSecurityClient />;
}