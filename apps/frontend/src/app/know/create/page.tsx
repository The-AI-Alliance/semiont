"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiService } from '@/lib/api-client';
import { buttonStyles } from '@/lib/button-styles';

export default function CreateDocumentPage() {
  const router = useRouter();
  const [newDocName, setNewDocName] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleCreateDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim()) return;

    setIsCreating(true);
    try {
      const response = await apiService.documents.create({
        name: newDocName,
        content: newDocContent || `# ${newDocName}\n\nStart writing your document here...`,
        contentType: 'text/markdown'
      });
      
      // Navigate to the new document
      router.push(`/documents/${response.document.id}`);
    } catch (error) {
      console.error('Failed to create document:', error);
      alert('Failed to create document. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="px-4 py-8">
      {/* Page Title */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Create New Document</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Start a new document in your knowledge base
        </p>
      </div>

      {/* Create Form */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
        <form onSubmit={handleCreateDocument} className="space-y-6">
          <div>
            <label htmlFor="docName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Document Name
            </label>
            <input
              id="docName"
              type="text"
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              placeholder="Enter document name..."
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              required
              disabled={isCreating}
            />
          </div>
          
          <div>
            <label htmlFor="docContent" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Initial Content (Optional)
            </label>
            <textarea
              id="docContent"
              value={newDocContent}
              onChange={(e) => setNewDocContent(e.target.value)}
              placeholder="Start writing your document content (Markdown supported)..."
              rows={12}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white font-mono text-sm"
              disabled={isCreating}
            />
          </div>
          
          <div className="flex gap-4 justify-end">
            <button
              type="button"
              onClick={() => router.push('/know/search')}
              disabled={isCreating}
              className={buttonStyles.tertiary.base}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isCreating || !newDocName.trim()}
              className={buttonStyles.primary.base}
            >
              {isCreating ? 'Creating...' : 'Create Document'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}