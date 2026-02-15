'use client';

import { useSessionExpiry } from '../hooks/useSessionExpiry';
import { useFormattedTime } from '../hooks/useFormattedTime';

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