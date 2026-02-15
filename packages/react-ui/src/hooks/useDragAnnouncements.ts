'use client';

import { useCallback } from 'react';
import { useLiveRegion } from '../components/LiveRegion';

/**
 * Hook for announcing drag and drop operations to screen readers
 */
export function useDragAnnouncements() {
  const { announce } = useLiveRegion();

  const announceReorder = useCallback((message: string) => {
    announce(message, 'assertive');
  }, []);

  const announcePickup = useCallback((resourceName: string, position: number, total: number) => {
    announce(
      `Picked up ${resourceName}. Position ${position} of ${total}. Use arrow keys to move, space to drop.`,
      'assertive'
    );
  }, []);

  const announceDrop = useCallback((resourceName: string, newPosition: number, total: number) => {
    announce(
      `Dropped ${resourceName} at position ${newPosition} of ${total}.`,
      'assertive'
    );
  }, []);

  const announceMove = useCallback((resourceName: string, direction: 'up' | 'down', newPosition: number, total: number) => {
    announce(
      `Moved ${resourceName} ${direction} to position ${newPosition} of ${total}.`,
      'polite'
    );
  }, []);

  const announceKeyboardReorder = useCallback((resourceName: string, direction: 'up' | 'down', newPosition: number, total: number) => {
    announce(
      `${resourceName} moved ${direction} to position ${newPosition} of ${total}.`,
      'assertive'
    );
  }, []);

  const announceCannotMove = useCallback((direction: 'up' | 'down') => {
    announce(
      `Cannot move ${direction}. Already at the ${direction === 'up' ? 'top' : 'bottom'} of the list.`,
      'polite'
    );
  }, []);

  return {
    announceReorder,
    announcePickup,
    announceDrop,
    announceMove,
    announceKeyboardReorder,
    announceCannotMove
  };
}