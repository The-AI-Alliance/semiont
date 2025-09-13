'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  MagnifyingGlassIcon,
  PlusIcon,
  DocumentTextIcon
} from '@heroicons/react/24/outline';

const navigation = [
  {
    name: 'Discover',
    href: '/know/search',
    icon: MagnifyingGlassIcon,
    description: 'Search and browse documents'
  },
  {
    name: 'Create',
    href: '/know/create',
    icon: PlusIcon,
    description: 'Create a new document'
  },
  {
    name: 'Document',
    href: '/know/document',
    icon: DocumentTextIcon,
    description: 'View document'
  }
];

export function KnowledgeNavigation() {
  const pathname = usePathname();
  
  // Check if we're viewing a document
  const isDocumentView = pathname?.startsWith('/know/document') ?? false;
  
  // Get the last viewed document ID from localStorage (client-side only)
  const [lastDocumentId, setLastDocumentId] = React.useState<string | null>(null);
  
  React.useEffect(() => {
    const storedId = localStorage.getItem('lastViewedDocumentId');
    setLastDocumentId(storedId);
  }, [pathname]); // Re-check when pathname changes
  
  // Filter navigation to only show Document if we have a document ID
  const filteredNavigation = navigation.filter(item => {
    if (item.name === 'Document') {
      return lastDocumentId !== null;
    }
    return true;
  });

  return (
    <nav className="w-64 bg-white dark:bg-gray-900 shadow border-r border-gray-200 dark:border-gray-700">
      <div className="p-4">
        <div className="space-y-1">
          <div>
            <div className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
              Knowledge
            </div>
            
            {filteredNavigation.map((item) => {
              let isActive = pathname === item.href;
              // Special handling for document view
              if (item.name === 'Document' && isDocumentView) {
                isActive = true;
              }
              
              // Build the href for Document link
              let href = item.href;
              if (item.name === 'Document' && lastDocumentId) {
                href = `/know/document/${lastDocumentId}`;
              }
              
              return (
                <Link
                  key={item.name}
                  href={href}
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