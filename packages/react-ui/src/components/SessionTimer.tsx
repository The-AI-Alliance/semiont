'use client';

import React from 'react';
import { useSessionExpiry } from '@semiont/react-ui';
import { useFormattedTime } from '@semiont/react-ui';

export function SessionTimer() {
  const { timeRemaining } = useSessionExpiry();
  const formattedTime = useFormattedTime(timeRemaining);

  if (!formattedTime) return null;

  return (
    <div className="semiont-session-timer">
      Session: {formattedTime} remaining
    </div>
  );
}