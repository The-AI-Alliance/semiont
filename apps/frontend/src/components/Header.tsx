import React from 'react';
import { env } from '@/lib/env';
import { UserMenu } from './UserMenu';

export function Header() {
  return (
    <div className="flex justify-between items-center w-full mb-8">
      <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
        {env.NEXT_PUBLIC_SITE_NAME}
      </h1>
      
      {/* Authentication Status */}
      <div className="text-right relative">
        <UserMenu />
      </div>
    </div>
  );
}