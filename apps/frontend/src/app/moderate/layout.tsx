import React from 'react';
import { UnifiedHeader } from '@/components/shared/UnifiedHeader';
import { ModerationNavigation } from '@/components/moderation/ModerationNavigation';
import { ModerationAuthWrapper } from '@/components/moderation/ModerationAuthWrapper';
import { Footer } from '@/components/Footer';

// Note: Metadata removed from layout to prevent leaking moderation information
// when pages return 404 for security. Metadata should be set in individual
// page components after authentication check.

export default function ModerateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ModerationAuthWrapper>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
        <UnifiedHeader brandingLink="/" variant="standalone" />
        <div className="flex flex-1">
          <ModerationNavigation />
          <main className="flex-1 p-6">
            <div className="max-w-7xl mx-auto">
              {children}
            </div>
          </main>
        </div>
        <Footer />
      </div>
    </ModerationAuthWrapper>
  );
}