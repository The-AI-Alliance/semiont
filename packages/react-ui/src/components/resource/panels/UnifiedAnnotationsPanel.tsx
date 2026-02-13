'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components, Selector } from '@semiont/api-client';
import type { RouteBuilder, LinkComponentProps } from '../../../contexts/RoutingContext';
import type { Annotator } from '../../../lib/annotation-registry';
import { StatisticsPanel } from './StatisticsPanel';
import { HighlightPanel } from './HighlightPanel';
import { ReferencesPanel } from './ReferencesPanel';
import { AssessmentPanel } from './AssessmentPanel';
import { CommentsPanel } from './CommentsPanel';
import { TaggingPanel } from './TaggingPanel';
import './UnifiedAnnotationsPanel.css';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];
type TabKey = 'statistics' | 'reference' | 'highlight' | 'assessment' | 'comment' | 'tag';

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

// Tab display order - statistics first, then matches AnnotateToolbar selection group order
const TAB_ORDER: TabKey[] = ['statistics', 'reference', 'highlight', 'assessment', 'comment', 'tag'];

/**
 * Simplified UnifiedAnnotationsPanel using event-driven architecture
 *
 * Key simplifications:
 * - Single annotations array (grouped internally by motivation)
 * - Single focusedAnnotationId (motivation-agnostic)
 * - Hover state managed via event bus (no props needed)
 * - All operations managed via event bus (no callback props)
 */
interface UnifiedAnnotationsPanelProps {
  // All annotations (grouped internally by motivation)
  annotations: Annotation[];

  // Annotators (pure static data - no handlers)
  annotators: Record<string, Annotator>;

  // Mode
  annotateMode?: boolean;

  // Detection state (per motivation)
  detectingMotivation?: Motivation | null;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
    // Tag-specific progress fields
    currentCategory?: string;
    processedCategories?: number;
    totalCategories?: number;
  } | null;

  // Unified pending annotation (for creating new annotations)
  pendingAnnotation: PendingAnnotation | null;

  // Reference-specific props
  allEntityTypes?: string[];
  generatingReferenceId?: string | null;
  referencedBy?: any[];
  referencedByLoading?: boolean;

  // Resource context
  resourceId?: string;
  initialTab?: TabKey;
  initialTabGeneration?: number; // Generation counter for tab switching

  // Scroll coordination (one-time action, will be cleared after use)
  scrollToAnnotationId?: string | null;
  onScrollCompleted?: () => void;

  // Hover coordination (for bidirectional hover highlighting)
  hoveredAnnotationId?: string | null;

  // Routing
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
}

export function UnifiedAnnotationsPanel(props: UnifiedAnnotationsPanelProps) {
  console.log('[UnifiedAnnotationsPanel] Rendering with props:', {
    annotationCount: props.annotations.length,
    resourceId: props.resourceId,
    initialTab: props.initialTab
  });

  const t = useTranslations('UnifiedAnnotationsPanel');

  // Group annotations by type using annotators
  const groups: Record<string, Annotation[]> = {
    highlight: [],
    comment: [],
    assessment: [],
    reference: [],
    tag: []
  };

  for (const ann of props.annotations) {
    const annotator = Object.values(props.annotators).find(a => a.matchesAnnotation(ann));
    if (annotator) {
      if (!groups[annotator.internalType]) {
        groups[annotator.internalType] = [];
      }
      groups[annotator.internalType].push(ann);
    }
  }

  const grouped = groups;

  // Load tab from localStorage (per-resource)
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window === 'undefined') return props.initialTab || 'statistics';

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    const stored = localStorage.getItem(storageKey);
    if (stored && TAB_ORDER.includes(stored as TabKey)) {
      return stored as TabKey;
    }

    return props.initialTab || 'statistics';
  });

  // Persist tab selection
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    localStorage.setItem(storageKey, activeTab);
  }, [activeTab, props.resourceId]);


  // Switch to initialTab when generation counter changes (e.g., when clicking annotations with different motivations)
  // Using generation counter ensures we can switch to the same tab multiple times
  useEffect(() => {
    if (props.initialTab && props.initialTabGeneration !== undefined) {
      console.log('[UnifiedAnnotationsPanel] initialTab changed to:', props.initialTab, 'generation:', props.initialTabGeneration);
      setActiveTab(props.initialTab);
    }
  }, [props.initialTabGeneration]); // Only watch generation counter, not the tab itself

  // Auto-switch to the appropriate tab when creating a new annotation
  useEffect(() => {
    if (props.pendingAnnotation) {
      // Map motivation to tab (only for motivations with corresponding tabs)
      const motivationToTab: Partial<Record<Motivation, TabKey>> = {
        'linking': 'reference',
        'commenting': 'comment',
        'tagging': 'tag',
        'assessing': 'assessment',
        'highlighting': 'highlight'
      };
      const tab = motivationToTab[props.pendingAnnotation.motivation];
      if (tab) {
        setActiveTab(tab);
      }
    }
  }, [props.pendingAnnotation]);

  const handleTabClick = (tab: TabKey) => {
    setActiveTab(tab);
  };

  // Tab button styling (matches AnnotateToolbar button style)
  const tabButtonClass = (tab: TabKey) => {
    const isActive = activeTab === tab;
    return `semiont-unified-panel__tab-button${isActive ? ' semiont-unified-panel__tab-button--active' : ''}`;
  };

  return (
    <div className="semiont-unified-panel">
      {/* Panel Title */}
      <h3 className="semiont-unified-panel__title">
        {t('title')}
      </h3>

      {/* Tab Navigation */}
      <div className="semiont-unified-panel__tabs">
        {TAB_ORDER.map(key => {
          // Statistics tab (special case - not in annotators)
          if (key === 'statistics') {
            return (
              <button
                key={key}
                onClick={() => handleTabClick(key)}
                className={tabButtonClass(key)}
                title={t(key)}
                aria-pressed={activeTab === key}
              >
                <span className="semiont-unified-panel__tab-icon">📊</span>
              </button>
            );
          }

          // Regular annotator tabs
          const annotator = props.annotators[key];
          if (!annotator) return null;

          return (
            <button
              key={key}
              onClick={() => handleTabClick(key)}
              className={tabButtonClass(key)}
              title={t(key)}
              aria-pressed={activeTab === key}
            >
              <span className="semiont-unified-panel__tab-icon">{annotator.iconEmoji}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="semiont-unified-panel__content">
        {(() => {
          // Statistics panel (special case - doesn't use annotators)
          if (activeTab === 'statistics') {
            return (
              <StatisticsPanel
                highlights={grouped.highlight || []}
                comments={grouped.comment || []}
                assessments={grouped.assessment || []}
                references={grouped.reference || []}
                tags={grouped.tag || []}
              />
            );
          }

          const annotator = props.annotators[activeTab];
          if (!annotator) return null;

          const annotations = grouped[activeTab] || [];
          const isDetecting = props.detectingMotivation === annotator.motivation;
          const detectionProgress = isDetecting ? props.detectionProgress : null;

          // Common props for all annotation panels
          const commonProps = {
            annotations,
            pendingAnnotation: props.pendingAnnotation,
            isDetecting,
            detectionProgress,
            annotateMode: props.annotateMode,
            scrollToAnnotationId: props.scrollToAnnotationId,
            onScrollCompleted: props.onScrollCompleted,
            hoveredAnnotationId: props.hoveredAnnotationId
          };

          // Render specific panel based on activeTab with full type safety
          if (activeTab === 'highlight') {
            return (
              <HighlightPanel
                {...commonProps}
              />
            );
          }

          if (activeTab === 'reference') {
            return (
              <ReferencesPanel
                annotations={commonProps.annotations}
                pendingAnnotation={commonProps.pendingAnnotation}
                isDetecting={commonProps.isDetecting}
                detectionProgress={commonProps.detectionProgress}
                annotateMode={commonProps.annotateMode}
                scrollToAnnotationId={commonProps.scrollToAnnotationId}
                onScrollCompleted={commonProps.onScrollCompleted}
                hoveredAnnotationId={commonProps.hoveredAnnotationId}
                allEntityTypes={props.allEntityTypes || []}
                generatingReferenceId={props.generatingReferenceId}
                referencedBy={props.referencedBy}
                referencedByLoading={props.referencedByLoading}
                Link={props.Link}
                routes={props.routes}
              />
            );
          }

          if (activeTab === 'assessment') {
            return (
              <AssessmentPanel
                {...commonProps}
              />
            );
          }

          if (activeTab === 'comment') {
            return (
              <CommentsPanel
                {...commonProps}
              />
            );
          }

          if (activeTab === 'tag') {
            return (
              <TaggingPanel
                {...commonProps}
              />
            );
          }

          return null;
        })()}
      </div>
    </div>
  );
}
