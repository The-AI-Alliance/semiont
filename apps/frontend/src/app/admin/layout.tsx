import React from 'react';
import { AdminNavigation } from '@/components/admin/AdminNavigation';
import { AdminHeader } from '@/components/admin/AdminHeader';
import { AdminAuthWrapper } from '@/components/admin/AdminAuthWrapper';

// Note: Metadata removed from layout to prevent leaking admin information
// when pages return 404 for security. Metadata should be set in individual
// page components after authentication check.

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminAuthWrapper>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AdminHeader />
        <div className="flex">
          <AdminNavigation />
          <main className="flex-1 p-6">
            <div className="max-w-7xl mx-auto">
              {children}
            </div>
          </main>
        </div>
      </div>
    </AdminAuthWrapper>
  );
}