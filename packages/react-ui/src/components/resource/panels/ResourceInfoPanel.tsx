'use client';

import { useTranslations } from '../../../contexts/TranslationContext';
import { useEventBus } from '../../../contexts/EventBusContext';
import { formatLocaleDisplay } from '@semiont/api-client';
import './ResourceInfoPanel.css';

interface Props {
  documentEntityTypes: string[];
  documentLocale?: string | undefined;
  primaryMediaType?: string | undefined;
  primaryByteSize?: number | undefined;
  isArchived?: boolean;
}

export function ResourceInfoPanel({
  documentEntityTypes,
  documentLocale,
  primaryMediaType,
  primaryByteSize,
  isArchived = false,
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
          onClick={() => eventBus.emit('resource:clone', undefined)}
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
              onClick={() => eventBus.emit('resource:unarchive', undefined)}
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
              onClick={() => eventBus.emit('resource:archive', undefined)}
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
