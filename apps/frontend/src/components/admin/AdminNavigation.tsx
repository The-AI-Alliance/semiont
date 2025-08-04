'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  UsersIcon,
  ShieldCheckIcon,
  HomeIcon
} from '@heroicons/react/24/outline';

const navigation = [
  {
    name: 'Users',
    href: '/admin/users',
    icon: UsersIcon,
    description: 'User management and permissions'
  },
  {
    name: 'Security',
    href: '/admin/security',
    icon: ShieldCheckIcon,
    description: 'Security settings and OAuth management'
  },
];

export function AdminNavigation() {
  const pathname = usePathname();

  return (
    <nav className="w-64 bg-white dark:bg-gray-900 shadow border-r border-gray-200 dark:border-gray-700">
      <div className="p-4">
        <div className="space-y-1">
          {/* Return to main site */}
          <Link
            href="/"
            className="group flex items-center px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md transition-colors"
          >
            <HomeIcon className="flex-shrink-0 -ml-1 mr-3 h-5 w-5" />
            Back to Site
          </Link>
          
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
            <div className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
              Administration
            </div>
            
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-r-2 border-blue-500'
                      : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                  title={item.description}
                >
                  <item.icon
                    className={`flex-shrink-0 -ml-1 mr-3 h-5 w-5 ${
                      isActive 
                        ? 'text-blue-500 dark:text-blue-400' 
                        : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
                    }`}
                  />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}