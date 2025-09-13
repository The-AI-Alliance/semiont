import React from 'react';
import { UnifiedHeader } from '@/components/shared/UnifiedHeader';
import { KnowledgeNavigation } from '@/components/knowledge/KnowledgeNavigation';
import { Footer } from '@/components/Footer';

export default function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <UnifiedHeader brandingLink="/know" variant="standalone" />
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