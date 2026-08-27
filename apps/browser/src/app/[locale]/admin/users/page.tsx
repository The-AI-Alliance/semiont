import AdminUsersClient from './client';

// Authentication is handled by middleware.ts
// Only authenticated admins can reach this page

export default function AdminUsersPage() {
  return <AdminUsersClient />;
}