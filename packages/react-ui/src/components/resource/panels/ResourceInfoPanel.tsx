'use client';

import { useTranslations } from '../../../contexts/TranslationContext';
import type { SemiontSession } from '@semiont/sdk';
import { formatLocaleDisplay } from '@semiont/core';
import { resourceId as makeResourceId, type components } from '@semiont/core';
import { renderAgentLabel } from './agent-label';
import './ResourceInfoPanel.css';

type Agent = components['schemas']['Agent'];

interface Props {
  /** Session carrying the client and event bus; null renders inert. */
  session: SemiontSession | null;
  resourceId: string;
  documentEntityTypes: string[];
  documentLocale?: string | undefined;
  primaryMediaType?: string | undefined;
  primaryByteSize?: number | undefined;
  storageUri?: string | undefined;
  isArchived?: boolean;
  dateCreated?: string | undefined;
  dateModified?: string | undefined;
  wasAttributedTo?: Agent | Agent[] | undefined;
  wasDerivedFrom?: string | string[] | undefined;
  generator?: Agent | Agent[] | undefined;
  /**
   * Open the resource-generate flow. UI-only — the SDK isn't involved in
   * *opening* the display (if collaborative gather ever lands, this graduates
   * to a verb). Omit to hide the Generate action.
   */
  onGenerate?: () => void;
}

/**
 * Panel for displaying resource metadata and management actions
 *
 * @emits yield:clone - Clone this resource
 * @emits mark:unarchive - Unarchive this resource
 * @emits mark:archive - Archive this resource
 */
export function ResourceInfoPanel({
  session,
  resourceId,
  documentEntityTypes,
  documentLocale,
  primaryMediaType,
  primaryByteSize,
  storageUri,
  isArchived = false,
  dateCreated,
  dateModified,
  wasAttributedTo,
  wasDerivedFrom,
  generator,
  onGenerate,
}: Props) {
  const t = useTranslations('ResourceInfoPanel');

  // Single attribution surface. `wasAttributedTo` is the canonical list
  // of responsible parties; if a producer set only `generator` we
  // render that as the attribution chain.
  const attribution: Agent[] = wasAttributedTo
    ? (Array.isArray(wasAttributedTo) ? wasAttributedTo : [wasAttributedTo])
    : (generator ? (Array.isArray(generator) ? generator : [generator]) : []);

  return (
    <div className="semiont-resource-info-panel">
      {/* Panel Title */}
      <h3 className="semiont-resource-info-panel__title">
        {t('title')}
      </h3>

      {/* Locale Section */}
      <div className="semiont-resource-info-panel__section">
        <h3 className="semiont-resource-info-panel__heading">{t('locale')}</h3>
        {documentLocale ? (
          <div className="semiont-resource-info-panel__value">
            {formatLocaleDisplay(documentLocale)}
          </div>
        ) : (
          <div className="semiont-resource-info-panel__value semiont-resource-info-panel__value--empty">
            {t('notSpecified')}
          </div>
        )}
      </div>

      {/* Representation Section */}
      {(primaryMediaType || primaryByteSize !== undefined) && (
        <div className="semiont-resource-info-panel__section">
          <h3 className="semiont-resource-info-panel__heading">{t('representation')}</h3>
          <div className="semiont-resource-info-panel__field-group">
            {primaryMediaType && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('mediaType')}</span>
                <span className="semiont-resource-info-panel__value">
                  {primaryMediaType}
                </span>
              </div>
            )}
            {primaryByteSize !== undefined && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('byteSize')}</span>
                <span className="semiont-resource-info-panel__value">
                  {primaryByteSize.toLocaleString()} bytes
                </span>
              </div>
            )}
            {storageUri && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('storageUri')}</span>
                <span className="semiont-resource-info-panel__value">
                  {storageUri}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Provenance Section */}
      {(dateCreated || dateModified || attribution.length > 0 || wasDerivedFrom) && (
        <div className="semiont-resource-info-panel__section">
          <h3 className="semiont-resource-info-panel__heading">{t('provenance')}</h3>
          <div className="semiont-resource-info-panel__field-group">
            {dateCreated && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('createdAt')}</span>
                <span className="semiont-resource-info-panel__value">
                  {new Date(dateCreated).toLocaleString()}
                </span>
              </div>
            )}
            {dateModified && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('modifiedAt')}</span>
                <span className="semiont-resource-info-panel__value">
                  {new Date(dateModified).toLocaleString()}
                </span>
              </div>
            )}
            {attribution.length > 0 && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('attributedTo')}</span>
                <span className="semiont-resource-info-panel__value">
                  {attribution.map(renderAgentLabel).join(', ')}
                </span>
              </div>
            )}
            {wasDerivedFrom && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('derivedFrom')}</span>
                <span className="semiont-resource-info-panel__value">
                  {(Array.isArray(wasDerivedFrom) ? wasDerivedFrom : [wasDerivedFrom]).map((id, i) => (
                    <button
                      key={id}
                      className="semiont-resource-info-panel__link"
                      onClick={() => session?.client.browse.navigateReference(makeResourceId(id))}
                    >
                      {i > 0 && ', '}{id}
                    </button>
                  ))}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Entity Type Tags Section */}
      {documentEntityTypes.length > 0 && (
        <div className="semiont-resource-info-panel__section">
          <h3 className="semiont-resource-info-panel__heading">{t('entityTypeTags')}</h3>
          <div className="semiont-resource-info-panel__tag-list">
            {documentEntityTypes.map((tag) => (
              <span
                key={tag}
                className="semiont-tag"
                data-variant="blue"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Generate Action — opens the resource-generate flow (UI-only) */}
      {onGenerate && (
        <div className="semiont-resource-info-panel__action-section">
          <button
            onClick={onGenerate}
            className="semiont-resource-button semiont-resource-button--secondary"
          >
            ✨ {t('generate')}
          </button>
          <p className="semiont-resource-info-panel__description">
            {t('generateDescription')}
          </p>
        </div>
      )}

      {/* Clone Action */}
      <div className="semiont-resource-info-panel__action-section">
        <button
          onClick={() => session?.client.yield.clone()}
          className="semiont-resource-button semiont-resource-button--secondary"
        >
          🔗 {t('clone')}
        </button>
        <p className="semiont-resource-info-panel__description">
          {t('cloneDescription')}
        </p>
      </div>

      {/* Archive/Unarchive Actions */}
      <div className="semiont-resource-info-panel__action-section">
        {isArchived ? (
          <>
            <button
              onClick={() => session?.client.mark.unarchive(makeResourceId(resourceId))}
              className="semiont-resource-button semiont-resource-button--secondary"
            >
              📤 {t('unarchive')}
            </button>
            <p className="semiont-resource-info-panel__description">
              {t('unarchiveDescription')}
            </p>
          </>
        ) : (
          <>
            <button
              onClick={() => session?.client.mark.archive(makeResourceId(resourceId))}
              className="semiont-resource-button semiont-resource-button--archive"
            >
              📦 {t('archive')}
            </button>
            <p className="semiont-resource-info-panel__description">
              {t('archiveDescription')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
