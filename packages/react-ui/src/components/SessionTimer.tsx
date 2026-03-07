'use client';

import { useSessionExpiry } from '../hooks/useSessionExpiry';
import { formatTime } from '../lib/formatTime';

export function SessionTimer() {
  const { timeRemaining } = useSessionExpiry();
  const formattedTime = formatTime(timeRemaining);

  if (!formattedTime) return null;

  return (
    <div className="semiont-session-timer">
      Session: {formattedTime} remaining
    </div>
  );
}