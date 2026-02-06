'use client';

import { useMemo } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components } from '@semiont/api-client';
import { isBodyResolved } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import './StatisticsPanel.css';

type Annotation = components['schemas']['Annotation'];

interface StatisticsPanelProps {
  highlights: Annotation[];
  comments: Annotation[];
  assessments: Annotation[];
  references: Annotation[];
  tags: Annotation[];
}

export function StatisticsPanel({
  highlights,
  comments,
  assessments,
  references,
  tags
}: StatisticsPanelProps) {
  const t = useTranslations('StatisticsPanel');

  // Count stub vs resolved references
  const stubCount = useMemo(
    () => references.filter((r) => !isBodyResolved(r.body)).length,
    [references]
  );

  const resolvedCount = useMemo(
    () => references.filter((r) => isBodyResolved(r.body)).length,
    [references]
  );

  // Count entity types from references (at annotation level)
  const entityTypesList = useMemo(() => {
    const entityTypeCounts = new Map<string, number>();
    references.forEach((ref) => {
      const entityTypes = getEntityTypes(ref);
      entityTypes.forEach((type: string) => {
        entityTypeCounts.set(type, (entityTypeCounts.get(type) || 0) + 1);
      });
    });

    return Array.from(entityTypeCounts.entries()).sort((a, b) => b[1] - a[1]); // Sort by count descending
  }, [references]);

  return (
    <div className="semiont-statistics-panel">
      <div className="semiont-statistics-panel__content">
        <h2 className="semiont-statistics-panel__title">
          {t('title')}
        </h2>

        <div className="semiont-statistics-panel__list">
          {/* Highlights */}
          <div className="semiont-statistics-panel__item">
            <span className="semiont-statistics-panel__label">{t('highlights')}</span>
            <span className="semiont-statistics-panel__value">
              {highlights.length}
            </span>
          </div>

          {/* Comments */}
          <div className="semiont-statistics-panel__item">
            <span className="semiont-statistics-panel__label">{t('comments')}</span>
            <span className="semiont-statistics-panel__value">
              {comments.length}
            </span>
          </div>

          {/* Assessments */}
          <div className="semiont-statistics-panel__item">
            <span className="semiont-statistics-panel__label">{t('assessments')}</span>
            <span className="semiont-statistics-panel__value">
              {assessments.length}
            </span>
          </div>

          {/* Tags */}
          <div className="semiont-statistics-panel__item">
            <span className="semiont-statistics-panel__label">{t('tags')}</span>
            <span className="semiont-statistics-panel__value">
              {tags.length}
            </span>
          </div>

          {/* References */}
          <div className="semiont-statistics-panel__item">
            <span className="semiont-statistics-panel__label">{t('references')}</span>
            <span className="semiont-statistics-panel__value">
              {references.length}
            </span>

            {/* Sub-categories indented */}
            <div className="semiont-statistics-panel__subitems">
              <div className="semiont-statistics-panel__subitem">
                <span className="semiont-statistics-panel__sublabel">{t('stub')}</span>
                <span className="semiont-statistics-panel__subvalue">
                  {stubCount}
                </span>
              </div>
              <div className="semiont-statistics-panel__subitem">
                <span className="semiont-statistics-panel__sublabel">{t('resolved')}</span>
                <span className="semiont-statistics-panel__subvalue">
                  {resolvedCount}
                </span>
              </div>
            </div>
          </div>

          {/* Entity Types */}
          {entityTypesList.length > 0 && (
            <div className="semiont-statistics-panel__entity-types">
              <span className="semiont-statistics-panel__label">{t('entityTypes')}</span>
              <div className="semiont-statistics-panel__entity-list">
                {entityTypesList.map(([type, count]) => (
                  <div
                    key={type}
                    className="semiont-statistics-panel__entity-item"
                  >
                    <span className="semiont-statistics-panel__entity-name">{type}</span>
                    <span className="semiont-tag" data-variant="blue">
                      {count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
