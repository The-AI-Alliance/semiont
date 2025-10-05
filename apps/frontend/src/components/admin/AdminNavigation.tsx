'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  UsersIcon,
  ShieldCheckIcon,
  CommandLineIcon
} from '@heroicons/react/24/outline';

const navigation = [
  {
    name: 'Users',
    href: '/admin/users',
    icon: UsersIcon,
    description: 'User management and permissions'
  },
  {
    name: 'OAuth Settings',
    href: '/admin/security',
    icon: ShieldCheckIcon,
    description: 'View OAuth configuration'
  },
  {
    name: 'DevOps',
    href: '/admin/devops',
    icon: CommandLineIcon,
    description: 'System monitoring and management'
  },
];

export function AdminNavigation() {
  const pathname = usePathname();

  return (
    <div className="p-4">
      <div className="space-y-1">
        <div>
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
  );
}