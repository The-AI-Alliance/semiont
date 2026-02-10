'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components, Selector } from '@semiont/api-client';
import type { RouteBuilder, LinkComponentProps } from '../../../contexts/RoutingContext';
import type { Annotator } from '../../../lib/annotation-registry';
import { createDetectionHandler } from '../../../lib/annotation-registry';
import { supportsDetection } from '../../../lib/resource-utils';
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
 * Simplified UnifiedAnnotationsPanel using Annotator abstraction
 *
 * Key simplifications:
 * - Single annotations array (grouped internally by motivation)
 * - Single focusedAnnotationId (motivation-agnostic)
 * - Hover state managed via event bus (no props needed)
 * - Single onCreateAnnotation handler (motivation-based dispatch)
 */
interface UnifiedAnnotationsPanelProps {
  // All annotations (grouped internally by motivation)
  annotations: Annotation[];

  // Annotators (pure static data - no handlers)
  annotators: Record<string, Annotator>;

  // Detection context (passed separately so annotators remain stable)
  detectionContext?: {
    client: any;
    rUri: any;
    setDetectingMotivation: (motivation: Motivation | null) => void;
    setMotivationDetectionProgress: (progress: any) => void;
    detectionStreamRef: any;
    cacheManager: any;
    showSuccess: (message: string) => void;
    showError: (message: string) => void;
  };

  // Single generic creation handler
  onCreateAnnotation: (motivation: Motivation, ...args: any[]) => void;

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

  // Reference-specific props (TODO: refactor these into annotator handlers)
  allEntityTypes?: string[];
  generatingReferenceId?: string | null;
  onGenerateDocument?: (referenceId: string, options: { title: string; prompt?: string }) => void;
  onCreateDocument?: (annotationUri: string, title: string, entityTypes: string[]) => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  mediaType?: string;
  referencedBy?: any[];
  referencedByLoading?: boolean;

  // Resource context
  resourceId?: string;
  initialTab?: TabKey;

  // Routing
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
}

export function UnifiedAnnotationsPanel(props: UnifiedAnnotationsPanelProps) {
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
          // Create detection handler on-demand if:
          // 1. Annotator supports detection (has detection config)
          // 2. Detection context is provided (API client, state handlers)
          // 3. Resource supports detection (is a text/* media type)
          // Note: We don't check client availability here - the handler gracefully handles null clients
          const onDetect = (
            annotator.detection &&
            props.detectionContext &&
            supportsDetection(props.mediaType)
          )
            ? createDetectionHandler(annotator, props.detectionContext)
            : undefined;

          // Create wrapper function that calls onCreateAnnotation with the annotator's motivation
          const onCreate = (...args: any[]) => props.onCreateAnnotation(annotator.motivation, ...args);

          const commonProps = {
            annotations,
            onDetect,
            onCreate,
            pendingAnnotation: props.pendingAnnotation,
            isDetecting,
            detectionProgress,
            annotateMode: props.annotateMode
          };

          // Render specific panel based on activeTab with full type safety
          if (activeTab === 'highlight') {
            return (
              <HighlightPanel
                {...commonProps}
                onCreate={onCreate}
              />
            );
          }

          if (activeTab === 'reference') {
            return (
              <ReferencesPanel
                annotations={commonProps.annotations}
                onDetect={onDetect}
                onCreate={onCreate}
                pendingAnnotation={commonProps.pendingAnnotation}
                isDetecting={commonProps.isDetecting}
                detectionProgress={commonProps.detectionProgress}
                annotateMode={commonProps.annotateMode}
                allEntityTypes={props.allEntityTypes || []}
                onGenerateDocument={props.onGenerateDocument}
                onCreateDocument={props.onCreateDocument}
                onSearchDocuments={props.onSearchDocuments}
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
                onCreate={onCreate}
              />
            );
          }

          if (activeTab === 'comment') {
            return (
              <CommentsPanel
                {...commonProps}
                onCreate={onCreate}
              />
            );
          }

          if (activeTab === 'tag') {
            return (
              <TaggingPanel
                {...commonProps}
                onCreate={onCreate}
              />
            );
          }

          return null;
        })()}
      </div>
    </div>
  );
}
