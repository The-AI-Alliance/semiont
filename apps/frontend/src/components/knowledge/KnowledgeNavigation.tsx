'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { 
  PlusIcon,
  DocumentTextIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';

// Custom telescope icon component
const TelescopeIcon = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: '1.25rem', lineHeight: '1' }}>🔭</span>
);

const fixedNavigation = [
  {
    name: 'Discover',
    href: '/know/search',
    icon: TelescopeIcon,
    description: 'Search and browse documents'
  },
  {
    name: 'Compose',
    href: '/know/compose',
    icon: PlusIcon,
    description: 'Compose a new document'
  }
];

export function KnowledgeNavigation() {
  const pathname = usePathname();
  const router = useRouter();
  const { openDocuments, removeDocument } = useOpenDocuments();
  
  // Function to close a document tab
  const closeDocument = (docId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    removeDocument(docId);
    
    // If we're closing the currently viewed document, navigate to Discover
    if (pathname === `/know/document/${docId}`) {
      router.push('/know/search');
    }
  };

  return (
    <nav className="w-64 bg-white dark:bg-gray-900 shadow border-r border-gray-200 dark:border-gray-700">
      <div className="p-4">
        <div className="space-y-1">
          <div>
            <div className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
              Knowledge
            </div>
            
            {/* Fixed navigation items */}
            {fixedNavigation.map((item) => {
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
            
            {/* Document tabs */}
            {openDocuments.map((doc) => {
              const docHref = `/know/document/${doc.id}`;
              const isActive = pathname === docHref;
              
              return (
                <div
                  key={doc.id}
                  className={`group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-r-2 border-blue-500'
                      : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <Link
                    href={docHref}
                    className="flex items-center flex-1 min-w-0"
                    title={doc.name}
                  >
                    <DocumentTextIcon
                      className={`flex-shrink-0 -ml-1 mr-3 h-5 w-5 ${
                        isActive 
                          ? 'text-blue-500 dark:text-blue-400' 
                          : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
                      }`}
                    />
                    <span className="truncate">{doc.name}</span>
                  </Link>
                  <button
                    onClick={(e) => closeDocument(doc.id, e)}
                    className="ml-1 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Close document"
                  >
                    <XMarkIcon className="h-3 w-3 text-gray-500 dark:text-gray-400" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}