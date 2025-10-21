'use client';

import React, { useEffect } from 'react';
import type { Annotation } from '@/lib/api';

interface JsonLdViewProps {
  annotation: Annotation;
  onBack: () => void;
}

export function JsonLdView({ annotation, onBack }: JsonLdViewProps) {
  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(annotation, null, 2));
    } catch (err) {
      console.error('Failed to copy JSON-LD:', err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with back and copy buttons */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={onBack}
          className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-lg font-bold"
          title="Go back (Escape)"
        >
          &lt;
        </button>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          JSON-LD
        </h3>
        <button
          onClick={handleCopyToClipboard}
          className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 text-base"
          title="Copy to clipboard"
        >
          📋
        </button>
      </div>

      {/* JSON-LD content in fixed-width font */}
      <div className="flex-1 overflow-y-auto">
        <pre className="text-xs font-mono text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-900 p-3 rounded-lg overflow-x-auto">
          {JSON.stringify(annotation, null, 2)}
        </pre>
      </div>
    </div>
  );
}
