import { createContext, useContext } from 'react';
import type { ConnectionState } from '@semiont/api-client';

/**
 * Bus-connection state, exposed to the tree via React context so any
 * component (CollaborationPanel, future "reconnecting..." banner,
 * etc.) can react to transitions without threading a prop.
 *
 * Populated by `KnowledgeLayoutInner`, which subscribes to
 * `client.actor.state$` and writes through to this context.
 */
export const StreamStatusContext = createContext<ConnectionState>('initial');

export function useStreamStatus(): ConnectionState {
  return useContext(StreamStatusContext);
}
