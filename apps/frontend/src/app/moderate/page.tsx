'use client';

import { notFound } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { 
  TagIcon,
  LinkIcon,
  PlusIcon,
  ExclamationCircleIcon
} from '@heroicons/react/24/outline';

interface TagManagerProps {
  title: string;
  description: string;
  endpoint: string;
  tags: string[];
  onTagsUpdate: (tags: string[]) => void;
  color: 'blue' | 'purple';
}

function TagManager({ title, description, endpoint, tags, onTagsUpdate, color }: TagManagerProps) {
  const [newTag, setNewTag] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState('');
  const { data: session } = useSession();

  const handleAddTag = async () => {
    if (!newTag.trim()) return;
    
    setIsAdding(true);
    setError('');
    
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${endpoint}`, {
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
      onTagsUpdate(data.entityTypes || data.referenceTypes || []);
      setNewTag('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsAdding(false);
    }
  };

  const colorClasses = {
    blue: {
      bg: 'bg-blue-100 dark:bg-blue-900/20',
      icon: 'text-blue-600 dark:text-blue-400',
      tag: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
      button: 'bg-blue-600 hover:bg-blue-700 text-white'
    },
    purple: {
      bg: 'bg-purple-100 dark:bg-purple-900/20',
      icon: 'text-purple-600 dark:text-purple-400',
      tag: 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
      button: 'bg-purple-600 hover:bg-purple-700 text-white'
    }
  };

  const colors = colorClasses[color];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-start mb-4">
        <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${colors.bg} mr-3`}>
          {color === 'blue' ? (
            <TagIcon className={`w-6 h-6 ${colors.icon}`} />
          ) : (
            <LinkIcon className={`w-6 h-6 ${colors.icon}`} />
          )}
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{description}</p>
        </div>
      </div>

      {/* Existing tags */}
      <div className="mb-4">
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className={`px-3 py-1 rounded-md text-sm border ${colors.tag}`}
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
          placeholder="Enter new tag..."
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          disabled={isAdding}
        />
        <button
          onClick={handleAddTag}
          disabled={isAdding || !newTag.trim()}
          className={`px-4 py-2 rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${colors.button}`}
        >
          {isAdding ? (
            'Adding...'
          ) : (
            <>
              <PlusIcon className="w-5 h-5 inline-block mr-1" />
              Add
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
  );
}

export default function ModeratePage() {
  const { data: session, status } = useSession();
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [referenceTypes, setReferenceTypes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
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
        // Load entity types
        const entityResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/entity-types`, {
          headers: {
            'Authorization': `Bearer ${session.backendToken}`
          }
        });
        if (entityResponse.ok) {
          const data = await entityResponse.json();
          setEntityTypes(data.entityTypes || []);
        }

        // Load reference types
        const refResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/reference-types`, {
          headers: {
            'Authorization': `Bearer ${session.backendToken}`
          }
        });
        if (refResponse.ok) {
          const data = await refResponse.json();
          setReferenceTypes(data.referenceTypes || []);
        }
      } catch (error) {
        console.error('Failed to load tags:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadTags();
  }, [session]);

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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Tag Management</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Add new tags to expand the available options for document classification and reference relationships.
          Tags are append-only and cannot be deleted once created.
        </p>
      </div>
        
      {/* Tag Management Cards */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">Manage Tags</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TagManager
            title="Document Tags"
            description="Tags used to classify and categorize documents"
            endpoint="/api/entity-types"
            tags={entityTypes}
            onTagsUpdate={setEntityTypes}
            color="blue"
          />
          
          <TagManager
            title="Reference Types"
            description="Semantic relationship types between documents"
            endpoint="/api/reference-types"
            tags={referenceTypes}
            onTagsUpdate={setReferenceTypes}
            color="purple"
          />
        </div>
      </div>

      {/* Recent Documents Section */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">Recent Documents</h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start mb-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-900/20 mr-3">
              <svg className="w-6 h-6 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Document Activity</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">Monitor recent document submissions and modifications</p>
            </div>
          </div>
          <div className="text-center py-8">
            <svg className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">No recent documents yet</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Document activity will appear here for review</p>
          </div>
        </div>
      </div>
    </div>
  );
}