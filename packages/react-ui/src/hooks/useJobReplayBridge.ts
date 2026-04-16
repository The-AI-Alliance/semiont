'use client';

import { useEffect } from 'react';
import { createJobReplayBridge } from '@semiont/api-client';
import { useEventBus } from '../contexts/EventBusContext';

export function useJobReplayBridge(): void {
  const eventBus = useEventBus();
  useEffect(() => {
    const bridge = createJobReplayBridge(eventBus);
    return () => bridge.dispose();
  }, [eventBus]);
}
