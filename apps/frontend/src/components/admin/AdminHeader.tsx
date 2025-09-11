'use client';

import React from 'react';
import Link from 'next/link';
import { env } from '@/lib/env';
import { UserMenu } from '../UserMenu';
import { SemiontBranding } from '../SemiontBranding';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AdminHeader() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  // Redirect non-authenticated users
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/auth/signin');
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <header className="bg-white dark:bg-gray-900 shadow border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="animate-pulse text-gray-400">Loading...</div>
          </div>
        </div>
      </header>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <header className="bg-white dark:bg-gray-900 shadow border-b border-gray-200 dark:border-gray-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <Link 
              href="/" 
              className="hover:opacity-80 transition-opacity"
            >
              <SemiontBranding 
                size="sm" 
                showTagline={true} 
                animated={false}
                compactTagline={true}
                className="py-1"
              />
            </Link>
          </div>
          
          <div className="flex items-center space-x-4">
            <UserMenu />
          </div>
        </div>
      </div>
    </header>
  );
}