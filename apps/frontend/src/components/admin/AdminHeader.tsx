'use client';

import React from 'react';
import Link from 'next/link';
import { env } from '@/lib/env';
import { UserMenu } from '../UserMenu';
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
          <div className="flex items-center space-x-4">
            <Link 
              href="/" 
              className="text-xl font-semibold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
            >
              {env.NEXT_PUBLIC_SITE_NAME}
            </Link>
            <span className="text-gray-400 dark:text-gray-500">/</span>
            <span className="text-lg font-medium text-gray-700 dark:text-gray-300">
              Admin Dashboard
            </span>
          </div>
          
          <div className="flex items-center space-x-4">
            <UserMenu />
          </div>
        </div>
      </div>
    </header>
  );
}