import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useObservable } from '@semiont/react-ui';
import type { TagSchema } from '@semiont/core';
import type { ChatSession } from '../lib/session';

export function VocabularyModal({ name, session, onClose }: {
  name: string;
  session: ChatSession | null;
  onClose: () => void;
}) {
  const entityTypes$ = useMemo(() => session?.client.browse.entityTypes() ?? null, [session]);
  const tagSchemas$ = useMemo(() => session?.client.browse.tagSchemas() ?? null, [session]);
  const entityTypesState = useObservable(entityTypes$);
  const tagSchemasState = useObservable(tagSchemas$);
  const entityTypes = entityTypesState?.status === 'ready' ? entityTypesState.value : [];
  const tagSchemas = tagSchemasState?.status === 'ready' ? tagSchemasState.value : [];
  const [newEntityType, setNewEntityType] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isAdding) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isAdding, onClose]);

  const refresh = async () => {
    if (session === null) return;
    setRefreshError(null);
    const results = await Promise.allSettled([
      session.client.browse.entityTypes().fresh(),
      session.client.browse.tagSchemas().fresh(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      setRefreshError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
    }
  };

  const addEntityType = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = newEntityType.trim();
    if (session === null || value.length === 0 || isAdding) return;
    setAddError(null);
    setIsAdding(true);
    try {
      await session.client.frame.addEntityType(value);
      setNewEntityType('');
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="modal modal--kb-details" onClick={() => !isAdding && onClose()}>
      <section
        className="config config--modal config--knowledge-bases knowledge-bases__manage-modal vocabulary-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vocabulary-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="config__head">
          <h1 id="vocabulary-title">Vocabulary</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Vocabulary">×</button>
        </header>

        <div className="vocabulary-modal__body">
          <header className="knowledge-bases__detail-head">
            <div>
              <p className="knowledge-bases__eyebrow">Selected Knowledge Base</p>
              <h2>{name}</h2>
            </div>
            {session !== null && <button type="button" className="semiont-button" data-variant="secondary" onClick={() => void refresh()}>Refresh</button>}
          </header>

          {session === null ? (
            <p className="knowledge-bases__action-note">Connect to this Knowledge Base to view and manage its vocabulary.</p>
          ) : (
            <div className="vocabulary-modal__sections">
              <section className="vocabulary-modal__section" aria-labelledby="vocabulary-entity-types-title">
                <header>
                  <div>
                    <h2 id="vocabulary-entity-types-title">Entity types</h2>
                    <p>Types used to classify resources and annotations in this Knowledge Base.</p>
                  </div>
                  <span className="vocabulary-modal__count">{entityTypes.length}</span>
                </header>

                {entityTypesState === undefined || entityTypesState.status === 'pending' ? (
                  <p className="knowledge-bases__action-note">Loading entity types…</p>
                ) : entityTypesState.status === 'failed' ? (
                  <p className="vocabulary-modal__error" role="alert">Could not load entity types: {errorText(entityTypesState.error)}</p>
                ) : entityTypes.length === 0 ? (
                  <p className="knowledge-bases__action-note">No entity types are registered.</p>
                ) : (
                  <ul className="vocabulary-modal__entity-types">
                    {entityTypes.map((entityType) => <li key={entityType}>{entityType}</li>)}
                  </ul>
                )}

                <form className="vocabulary-modal__add-form" onSubmit={(event) => void addEntityType(event)}>
                  <label htmlFor="vocabulary-new-entity-type">Add an entity type</label>
                  <div>
                    <input
                      id="vocabulary-new-entity-type"
                      value={newEntityType}
                      onChange={(event) => setNewEntityType(event.target.value)}
                      placeholder="e.g. Organization"
                      disabled={isAdding}
                    />
                    <button type="submit" className="kb__connect" disabled={isAdding || newEntityType.trim().length === 0}>
                      {isAdding ? 'Adding…' : 'Add type'}
                    </button>
                  </div>
                  {addError !== null && <p className="vocabulary-modal__error" role="alert">{addError}</p>}
                </form>
              </section>

              <section className="vocabulary-modal__section" aria-labelledby="vocabulary-tag-schemas-title">
                <header>
                  <div>
                    <h2 id="vocabulary-tag-schemas-title">Tag schemas</h2>
                    <p>Registered schemas and their categories. Schema editing is not available yet.</p>
                  </div>
                  <span className="vocabulary-modal__count">{tagSchemas.length}</span>
                </header>

                {tagSchemasState === undefined || tagSchemasState.status === 'pending' ? (
                  <p className="knowledge-bases__action-note">Loading tag schemas…</p>
                ) : tagSchemasState.status === 'failed' ? (
                  <p className="vocabulary-modal__error" role="alert">Could not load tag schemas: {errorText(tagSchemasState.error)}</p>
                ) : tagSchemas.length === 0 ? (
                  <p className="knowledge-bases__action-note">No tag schemas are registered.</p>
                ) : (
                  <div className="vocabulary-modal__schemas">
                    {tagSchemas.map((schema) => <TagSchemaCard key={schema.id} schema={schema} />)}
                  </div>
                )}
              </section>
            </div>
          )}

          {refreshError !== null && <p className="vocabulary-modal__error" role="alert">Refresh failed: {refreshError}</p>}
        </div>
      </section>
    </div>
  );
}

function TagSchemaCard({ schema }: { schema: TagSchema }) {
  return (
    <article className="vocabulary-modal__schema">
      <header>
        <div>
          <h3>{schema.name}</h3>
          <span>{schema.domain}</span>
        </div>
        <code>{schema.id}</code>
      </header>
      <p>{schema.description}</p>
      <ul>
        {schema.tags.map((tag) => (
          <li key={tag.name}>
            <strong>{tag.name}</strong>
            <span>{tag.description}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
