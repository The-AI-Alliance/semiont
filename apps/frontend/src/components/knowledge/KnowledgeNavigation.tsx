'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  PlusIcon,
  DocumentTextIcon,
  XMarkIcon,
  ChevronLeftIcon,
  Bars3Icon
} from '@heroicons/react/24/outline';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';

// Custom telescope icon component
const TelescopeIcon = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: '1.25rem', lineHeight: '1' }}>🔭</span>
);

const fixedNavigation = [
  {
    name: 'Discover',
    href: '/know/discover',
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
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load collapsed state from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('knowledgeNavCollapsed');
    if (saved === 'true') {
      setIsCollapsed(true);
    }
  }, []);

  // Save collapsed state to localStorage
  const toggleCollapsed = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    localStorage.setItem('knowledgeNavCollapsed', newState.toString());
  };

  // Function to close a document tab
  const closeDocument = (docId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    removeDocument(docId);

    // If we're closing the currently viewed document, navigate to Discover
    if (pathname === `/know/document/${docId}`) {
      router.push('/know/discover');
    }
  };

  return (
    <nav
      className={`bg-white dark:bg-gray-900 shadow border-r border-gray-200 dark:border-gray-700 flex-shrink-0 transition-all duration-300 ease-in-out ${
        isCollapsed ? 'w-14' : 'w-64'
      }`}
    >
      <div className={`${isCollapsed ? 'p-2' : 'p-4'}`}>
        <div className="space-y-1">
          <div>
            {/* Header with collapse button */}
            <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'} mb-3`}>
              {!isCollapsed && (
                <div className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                  Knowledge
                </div>
              )}
              <button
                onClick={toggleCollapsed}
                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                title={isCollapsed ? "Expand navigation" : "Collapse navigation"}
              >
                {isCollapsed ? (
                  <Bars3Icon className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                ) : (
                  <ChevronLeftIcon className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                )}
              </button>
            </div>
            
            {/* Fixed navigation items */}
            {fixedNavigation.map((item) => {
              const isActive = pathname === item.href;

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`group flex items-center ${
                    isCollapsed ? 'justify-center px-2' : 'px-3'
                  } py-2 text-sm font-medium rounded-md transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                      : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                  title={isCollapsed ? item.name : item.description}
                >
                  <item.icon
                    className={`flex-shrink-0 h-5 w-5 ${
                      isCollapsed ? '' : '-ml-1 mr-3'
                    } ${
                      isActive
                        ? 'text-blue-500 dark:text-blue-400'
                        : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
                    }`}
                  />
                  {!isCollapsed && item.name}
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
                  className={`group flex items-center ${
                    isCollapsed ? 'justify-center px-2' : 'px-3'
                  } py-2 text-sm font-medium rounded-md transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                      : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <Link
                    href={docHref}
                    className={`flex items-center ${isCollapsed ? '' : 'flex-1 min-w-0'}`}
                    title={doc.name}
                  >
                    <DocumentTextIcon
                      className={`flex-shrink-0 h-5 w-5 ${
                        isCollapsed ? '' : '-ml-1 mr-3'
                      } ${
                        isActive
                          ? 'text-blue-500 dark:text-blue-400'
                          : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'
                      }`}
                    />
                    {!isCollapsed && <span className="truncate">{doc.name}</span>}
                  </Link>
                  {!isCollapsed && (
                    <button
                      onClick={(e) => closeDocument(doc.id, e)}
                      className="ml-1 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Close document"
                    >
                      <XMarkIcon className="h-3 w-3 text-gray-500 dark:text-gray-400" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}