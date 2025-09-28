'use client';

import { notFound } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { 
  LinkIcon,
  PlusIcon,
  ExclamationCircleIcon
} from '@heroicons/react/24/outline';

export default function ReferenceTagsPage() {
  const { data: session, status } = useSession();
  const [referenceTypes, setReferenceTypes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newTag, setNewTag] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState('');
  
  // Check authentication and moderator/admin status
  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'unauthenticated') {
      notFound();
    }
    if (!session?.backendUser?.isModerator && !session?.backendUser?.isAdmin) {
      notFound();
    }
  }, [status, session]);

  // Load existing tags
  useEffect(() => {
    if (!session?.backendToken) return;

    const loadTags = async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/reference-types`, {
          headers: {
            'Authorization': `Bearer ${session.backendToken}`
          }
        });
        if (response.ok) {
          const data = await response.json();
          setReferenceTypes(data.referenceTypes || []);
        }
      } catch (error) {
        console.error('Failed to load reference types:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadTags();
  }, [session]);

  const handleAddTag = async () => {
    if (!newTag.trim()) return;
    
    setIsAdding(true);
    setError('');
    
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/reference-types`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.backendToken}`
        },
        body: JSON.stringify({ tag: newTag.trim() })
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to add tag');
      }
      
      const data = await response.json();
      setReferenceTypes(data.referenceTypes || []);
      setNewTag('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsAdding(false);
    }
  };

  // Show loading while checking session
  if (status === 'loading' || isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">Loading...</p>
      </div>
    );
  }

  // Show nothing if not moderator/admin (will be handled by notFound)
  if (!session?.backendUser?.isModerator && !session?.backendUser?.isAdmin) {
    return null;
  }

  return (
    <div className="px-4 py-8">
      {/* Page Title */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Reference Tags</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Manage semantic relationship types between documents. These tags define how documents 
          can reference and relate to each other. Tags are append-only and cannot be deleted once created.
        </p>
      </div>
        
      {/* Reference Tags Management */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start mb-6">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/20 mr-3">
            <LinkIcon className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Document Relationship Types</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Semantic relationships that can connect documents
            </p>
          </div>
        </div>

        {/* Existing tags */}
        <div className="mb-6">
          <div className="flex flex-wrap gap-2">
            {referenceTypes.map((tag) => (
              <span
                key={tag}
                className="px-3 py-1 rounded-md text-sm border bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Add new tag */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
            placeholder="Enter new reference tag..."
            className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
            disabled={isAdding}
          />
          <button
            onClick={handleAddTag}
            disabled={isAdding || !newTag.trim()}
            className="px-4 py-2 rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors bg-blue-600 hover:bg-blue-700 text-white"
          >
            {isAdding ? (
              'Adding...'
            ) : (
              <>
                <PlusIcon className="w-5 h-5 inline-block mr-1" />
                Add Tag
              </>
            )}
          </button>
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-3 flex items-center text-red-600 dark:text-red-400 text-sm">
            <ExclamationCircleIcon className="w-4 h-4 mr-1" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}