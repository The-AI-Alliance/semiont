'use client';

import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import { formatLocaleDisplay } from '@semiont/api-client';
import { resourceId as makeResourceId, type components } from '@semiont/core';
import './ResourceInfoPanel.css';

type Agent = components['schemas']['Agent'];

interface Props {
  resourceId: string;
  documentEntityTypes: string[];
  documentLocale?: string | undefined;
  primaryMediaType?: string | undefined;
  primaryByteSize?: number | undefined;
  storageUri?: string | undefined;
  isArchived?: boolean;
  dateCreated?: string | undefined;
  dateModified?: string | undefined;
  creationMethod?: string | undefined;
  wasAttributedTo?: Agent | Agent[] | undefined;
  wasDerivedFrom?: string | string[] | undefined;
  generator?: Agent | Agent[] | undefined;
}

/**
 * Panel for displaying resource metadata and management actions
 *
 * @emits yield:clone - Clone this resource
 * @emits mark:unarchive - Unarchive this resource
 * @emits mark:archive - Archive this resource
 */
export function ResourceInfoPanel({
  resourceId,
  documentEntityTypes,
  documentLocale,
  primaryMediaType,
  primaryByteSize,
  storageUri,
  isArchived = false,
  dateCreated,
  dateModified,
  creationMethod,
  wasAttributedTo,
  wasDerivedFrom,
  generator,
}: Props) {
  const t = useTranslations('ResourceInfoPanel');
  const eventBus = useEventBus();

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
      {(dateCreated || dateModified || creationMethod || wasAttributedTo || wasDerivedFrom || generator) && (
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
            {creationMethod && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('creationMethod')}</span>
                <span className="semiont-resource-info-panel__value">{creationMethod}</span>
              </div>
            )}
            {wasAttributedTo && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('attributedTo')}</span>
                <span className="semiont-resource-info-panel__value">
                  {(Array.isArray(wasAttributedTo) ? wasAttributedTo : [wasAttributedTo])
                    .map(a => a.name)
                    .join(', ')}
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
                      onClick={() => eventBus.get('browse:reference-navigate').next({ resourceId: id })}
                    >
                      {i > 0 && ', '}{id}
                    </button>
                  ))}
                </span>
              </div>
            )}
            {generator && (
              <div>
                <span className="semiont-resource-info-panel__label">{t('generatedBy')}</span>
                <span className="semiont-resource-info-panel__value">
                  {(Array.isArray(generator) ? generator : [generator])
                    .map(a => a.name)
                    .join(', ')}
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

      {/* Clone Action */}
      <div className="semiont-resource-info-panel__action-section">
        <button
          onClick={() => eventBus.get('yield:clone').next(undefined)}
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
              onClick={() => eventBus.get('mark:unarchive').next({ resourceId: makeResourceId(resourceId) })}
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
              onClick={() => eventBus.get('mark:archive').next({ resourceId: makeResourceId(resourceId) })}
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
