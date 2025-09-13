'use client';

import React, { useState, useRef, useEffect } from 'react';
import { api } from '@/lib/api-client';

interface DocumentTagsProps {
  documentId: string;
  initialTags: string[];
  onUpdate: (tags: string[]) => Promise<void>;
}

export function DocumentTags({ documentId, initialTags, onUpdate }: DocumentTagsProps) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [isEditing, setIsEditing] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  // Get available entity types for tag suggestions
  const { data: entityTypesData } = api.entityTypes.list.useQuery();
  const allEntityTypes = entityTypesData?.entityTypes || [];
  
  // Filter entity types based on search
  const filteredEntityTypes = allEntityTypes
    .filter(type => 
      type.toLowerCase().includes(tagSearchQuery.toLowerCase()) &&
      !tags.includes(type)
    )
    .slice(0, 10);

  // Update tags when props change
  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);

  // Handle clicks outside dropdown
  useEffect(() => {
    if (!showDropdown) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };

    // Use capture phase to handle before React's event handlers
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [showDropdown]);

  const handleAddTag = async (tag: string) => {
    if (!tag || tags.includes(tag)) return;
    
    const newTags = [...tags, tag];
    setTags(newTags);
    await onUpdate(newTags);
    setTagSearchQuery('');
    setShowDropdown(false);
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    const newTags = tags.filter(tag => tag !== tagToRemove);
    setTags(newTags);
    await onUpdate(newTags);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Document Tags</h3>
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {isEditing ? 'Done' : 'Edit'}
        </button>
      </div>
      
      <div className="space-y-2">
        {/* Display existing tags */}
        <div className="flex flex-wrap gap-1">
          {tags.length === 0 ? (
            <span className="text-xs text-gray-400">No tags</span>
          ) : (
            tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs"
              >
                {tag}
                {isEditing && (
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="text-gray-400 hover:text-red-500 ml-1"
                    aria-label={`Remove ${tag} tag`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))
          )}
        </div>
        
        {/* Add tag input */}
        {isEditing && (
          <div ref={dropdownRef} className="relative">
            <input
              type="text"
              placeholder="Add tag..."
              value={tagSearchQuery}
              onChange={(e) => {
                setTagSearchQuery(e.target.value);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagSearchQuery) {
                  e.preventDefault();
                  handleAddTag(tagSearchQuery);
                }
                if (e.key === 'Escape') {
                  setShowDropdown(false);
                  setTagSearchQuery('');
                }
              }}
              className="w-full px-2 py-1 text-xs border rounded bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            
            {showDropdown && filteredEntityTypes.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg max-h-40 overflow-y-auto">
                {filteredEntityTypes.map(type => (
                  <button
                    key={type}
                    onClick={() => handleAddTag(type)}
                    className="w-full px-2 py-1 text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-600"
                  >
                    {type}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}