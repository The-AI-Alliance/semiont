import { CheckIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useKnowledgeBaseContext, type KnowledgeBase } from '@/contexts/KnowledgeBaseContext';
import { useRouter } from '@/i18n/routing';

export function KnowledgeBasePanel() {
  const { knowledgeBases, activeKnowledgeBase, setActiveKnowledgeBase } = useKnowledgeBaseContext();
  const router = useRouter();

  return (
    <div className="semiont-panel">
      <div className="semiont-panel__header">
        <h2 className="semiont-panel__title">Knowledge Bases</h2>
      </div>
      <div className="semiont-panel__content">
        <div className="flex flex-col gap-1">
          {knowledgeBases.map((kb: KnowledgeBase) => (
            <button
              key={kb.id}
              onClick={() => setActiveKnowledgeBase(kb.id)}
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-left w-full"
            >
              <span className="flex-1 truncate font-medium">{kb.label}</span>
              <span className="text-xs text-gray-400 truncate max-w-[140px]">
                {kb.backendUrl.replace(/^https?:\/\//, '')}
              </span>
              {kb.id === activeKnowledgeBase?.id && (
                <CheckIcon className="h-4 w-4 text-blue-500 shrink-0" />
              )}
            </button>
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={() => router.push('/auth/connect')}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700 w-full"
          >
            <PlusIcon className="h-4 w-4 shrink-0" />
            <span>Add knowledge base</span>
          </button>
        </div>
      </div>
    </div>
  );
}
