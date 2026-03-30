import { useState } from 'react';
import { ServerIcon, PlusIcon, CheckIcon, ChevronUpDownIcon } from '@heroicons/react/24/outline';
import { useWorkspaceContext, type Workspace } from '@/contexts/WorkspaceContext';
import { AddBackendForm } from '@/components/AddBackendForm';

interface WorkspaceSwitcherProps {
  isCollapsed: boolean;
}

export function WorkspaceSwitcher({ isCollapsed }: WorkspaceSwitcherProps) {
  const { workspaces, activeWorkspace, setActiveWorkspace } = useWorkspaceContext();
  const [isOpen, setIsOpen] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  if (showAddForm) {
    return (
      <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
        <AddBackendForm onSuccess={() => setShowAddForm(false)} />
      </div>
    );
  }

  if (isCollapsed) {
    return (
      <div className="border-t border-gray-200 dark:border-gray-700 pt-2 flex justify-center">
        <button
          onClick={() => setIsOpen(o => !o)}
          title={activeWorkspace?.label ?? 'No backend'}
          className="p-2 rounded-md text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <ServerIcon className="h-5 w-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
      <button
        onClick={() => setIsOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <ServerIcon className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate text-left">
          {activeWorkspace?.label ?? 'No backend'}
        </span>
        <ChevronUpDownIcon className="h-4 w-4 shrink-0" />
      </button>

      {isOpen && (
        <div className="mt-1 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm">
          {workspaces.map((ws: Workspace) => (
            <button
              key={ws.id}
              onClick={() => { setActiveWorkspace(ws.id); setIsOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 first:rounded-t-md"
            >
              <span className="flex-1 truncate text-left">{ws.label}</span>
              <span className="text-xs text-gray-400 truncate max-w-[120px]">{ws.backendUrl.replace(/^https?:\/\//, '')}</span>
              {ws.id === activeWorkspace?.id && <CheckIcon className="h-4 w-4 text-blue-500 shrink-0" />}
            </button>
          ))}
          <button
            onClick={() => { setIsOpen(false); setShowAddForm(true); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 border-t border-gray-100 dark:border-gray-700 rounded-b-md"
          >
            <PlusIcon className="h-4 w-4 shrink-0" />
            <span>Add backend</span>
          </button>
        </div>
      )}
    </div>
  );
}
