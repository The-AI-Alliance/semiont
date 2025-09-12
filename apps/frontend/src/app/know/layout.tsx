import React from 'react';
import { DashboardHeader } from '@/components/shared/DashboardHeader';
import { KnowledgeNavigation } from '@/components/knowledge/KnowledgeNavigation';
import { Footer } from '@/components/Footer';

export default function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <DashboardHeader />
      <div className="flex flex-1">
        <KnowledgeNavigation />
        <main className="flex-1 p-6">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}