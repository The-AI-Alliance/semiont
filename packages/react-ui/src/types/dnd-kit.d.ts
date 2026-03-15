import type { ReactNode } from 'react';

// Fix @dnd-kit/sortable SortableContext return type for React 19
// @dnd-kit/sortable declares JSX.Element which is incompatible with React 19's types
declare module '@dnd-kit/sortable' {
  import type { UniqueIdentifier } from '@dnd-kit/core';

  export interface SortableContextProps {
    children: ReactNode;
    items: (UniqueIdentifier | { id: UniqueIdentifier })[];
    strategy?: (...args: any[]) => any;
    id?: string;
    disabled?: boolean | { draggable?: boolean; droppable?: boolean };
  }

  export function SortableContext(props: SortableContextProps): ReactNode;
}
