import { createContext, useContext } from 'react';
import type { StreamStatus } from '@semiont/react-ui';

export const StreamStatusContext = createContext<StreamStatus>('disconnected');

export function useStreamStatus(): StreamStatus {
  return useContext(StreamStatusContext);
}
