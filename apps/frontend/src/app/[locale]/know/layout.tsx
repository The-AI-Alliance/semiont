import React from 'react';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import { Footer } from '@/components/Footer';
import { OpenResourcesProvider } from '@semiont/react-ui';
import { ResourceAnnotationsProvider } from '@semiont/react-ui';

export default function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OpenResourcesProvider>
      <ResourceAnnotationsProvider>
        <div className="h-screen bg-gray-50 dark:bg-gray-900 flex flex-col overflow-hidden">
          <div className="flex flex-1 overflow-hidden">
            <KnowledgeSidebarWrapper />
            <main className="flex-1 px-2 pb-6 flex flex-col overflow-hidden">
              <div className="max-w-7xl mx-auto flex-1 flex flex-col w-full h-full overflow-hidden">
                {children}
              </div>
            </main>
          </div>
          <Footer />
        </div>
      </ResourceAnnotationsProvider>
    </OpenResourcesProvider>
  );
}