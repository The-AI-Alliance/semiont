import React from 'react';
import { AdminNavigation } from '@/components/admin/AdminNavigation';
import { UnifiedHeader } from '@/components/shared/UnifiedHeader';
import { Footer } from '@/components/Footer';

// Note: Authentication is handled by middleware.ts for all admin routes
// This ensures centralized security and returns 404 for unauthorized users

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware has already verified admin access
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <UnifiedHeader brandingLink="/" variant="standalone" />
      <div className="flex flex-1">
        <AdminNavigation />
        <main className="flex-1 p-6 flex flex-col">
          <div className="max-w-7xl mx-auto flex-1 flex flex-col w-full">
            {children}
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}