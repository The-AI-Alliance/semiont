import { CheckIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useKnowledgeBaseContext, type KnowledgeBase } from '@/contexts/KnowledgeBaseContext';
import { useRouter } from '@/i18n/routing';

export function KnowledgeBasePanel() {
  const { knowledgeBases, activeKnowledgeBase, setActiveKnowledgeBase } = useKnowledgeBaseContext();
  const router = useRouter();

  return (
    <div className="semiont-panel">
      <div className="semiont-panel-header">
        <h2 className="semiont-panel-header__title">
          <span className="semiont-panel-header__text">Knowledge Bases</span>
          <span className="semiont-panel-header__count">({knowledgeBases.length})</span>
        </h2>
      </div>
      <div className="semiont-panel__content">
        <div className="semiont-panel__list">
          {knowledgeBases.map((kb: KnowledgeBase) => (
            <button
              key={kb.id}
              onClick={() => setActiveKnowledgeBase(kb.id)}
              className={`semiont-panel-item semiont-panel-item--clickable${kb.id === activeKnowledgeBase?.id ? ' semiont-panel-item--selected' : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              <span className="semiont-panel-text" style={{ flex: 1 }}>{kb.label}</span>
              <span className="semiont-panel-text-secondary">
                {kb.backendUrl.replace(/^https?:\/\//, '')}
              </span>
              {kb.id === activeKnowledgeBase?.id && (
                <CheckIcon style={{ width: '1rem', height: '1rem', color: 'var(--semiont-color-primary-500)', flexShrink: 0 }} />
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="semiont-panel-footer">
        <button
          onClick={() => router.push('/auth/connect')}
          className="semiont-panel-item semiont-panel-item--clickable"
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--semiont-color-primary-600)' }}
        >
          <PlusIcon style={{ width: '1rem', height: '1rem', flexShrink: 0 }} />
          <span className="semiont-panel-text" style={{ color: 'inherit' }}>Add knowledge base</span>
        </button>
      </div>
    </div>
  );
}
