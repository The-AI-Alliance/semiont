'use client';

import React from 'react';
import { ANNOTATORS } from '@/lib/annotation-registry';

interface PanelHeaderProps {
  annotationType: keyof typeof ANNOTATORS;
  count: number;
  title: string;
}

/**
 * Shared header for annotation panels
 *
 * Displays the annotation icon, translated title, and count in a consistent format
 */
export function PanelHeader({ annotationType, count, title }: PanelHeaderProps) {
  const metadata = ANNOTATORS[annotationType];

  return (
    <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {metadata?.iconEmoji} {title} ({count})
      </h2>
    </div>
  );
}
