import React from 'react';
import { Metadata } from 'next';
import { env } from '@/lib/env';
import { AdminNavigation } from '@/components/admin/AdminNavigation';
import { AdminHeader } from '@/components/admin/AdminHeader';
import { AdminAuthWrapper } from '@/components/admin/AdminAuthWrapper';

export const metadata: Metadata = {
  title: `Admin Dashboard - ${env.NEXT_PUBLIC_SITE_NAME}`,
  description: 'Administrative interface for managing the semantic knowledge platform',
};

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