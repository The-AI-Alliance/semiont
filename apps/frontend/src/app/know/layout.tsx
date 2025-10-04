import React from 'react';
import { UnifiedHeader } from '@/components/shared/UnifiedHeader';
import { KnowledgeNavigation } from '@/components/knowledge/KnowledgeNavigation';
import { Footer } from '@/components/Footer';
import { OpenDocumentsProvider } from '@/contexts/OpenDocumentsContext';
import { DocumentAnnotationsProvider } from '@/contexts/DocumentAnnotationsContext';

export default function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OpenDocumentsProvider>
      <DocumentAnnotationsProvider>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
          <UnifiedHeader brandingLink="/" variant="floating" />
          <div className="flex flex-1">
            <KnowledgeNavigation />
            <main className="flex-1 px-6 pb-6 flex flex-col">
              <div className="max-w-7xl mx-auto flex-1 flex flex-col w-full">
                {children}
              </div>
            </main>
          </div>
          <Footer />
        </div>
      </DocumentAnnotationsProvider>
    </OpenDocumentsProvider>
  );
}