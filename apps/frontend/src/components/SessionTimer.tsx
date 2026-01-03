'use client';

import React from 'react';
import { useSessionExpiry } from '@semiont/react-ui';
import { useFormattedTime } from '@semiont/react-ui';

export function SessionTimer() {
  const { timeRemaining } = useSessionExpiry();
  const formattedTime = useFormattedTime(timeRemaining);

  if (!formattedTime) return null;

  return (
    <div className="py-1 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-600">
      Session: {formattedTime} remaining
    </div>
  );
}