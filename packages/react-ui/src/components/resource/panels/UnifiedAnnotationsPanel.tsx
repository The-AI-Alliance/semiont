'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import type { components } from '@semiont/api-client';
import type { RouteBuilder, LinkComponentProps } from '../../../contexts/RoutingContext';
import { groupAnnotationsByType, type Annotator, ANNOTATORS } from '../../../lib/annotation-registry';
import { StatisticsPanel } from './StatisticsPanel';
import { HighlightPanel } from './HighlightPanel';
import { ReferencesPanel } from './ReferencesPanel';
import { AssessmentPanel } from './AssessmentPanel';
import { CommentsPanel } from './CommentsPanel';
import { TaggingPanel } from './TaggingPanel';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];
type AnnotatorKey = keyof typeof ANNOTATORS;
type TabKey = 'statistics' | AnnotatorKey;

// Tab display order - statistics first, then matches AnnotateToolbar selection group order
const TAB_ORDER: TabKey[] = ['statistics', 'reference', 'highlight', 'assessment', 'comment', 'tag'];

// Panel component mapping for dynamic rendering
type PanelComponent = React.ComponentType<any>;

const PANEL_COMPONENTS: Record<TabKey, PanelComponent> = {
  statistics: StatisticsPanel,
  highlight: HighlightPanel,
  reference: ReferencesPanel,
  assessment: AssessmentPanel,
  comment: CommentsPanel,
  tag: TaggingPanel
};

/**
 * Simplified UnifiedAnnotationsPanel using Annotator abstraction
 *
 * Key simplifications:
 * - Single annotations array (grouped internally by motivation)
 * - Single focusedAnnotationId (motivation-agnostic)
 * - Single hoveredAnnotationId (motivation-agnostic)
 * - Annotators contain handlers (no explosion of onXClick, onXHover props)
 */
interface UnifiedAnnotationsPanelProps {
  // All annotations (grouped internally by motivation)
  annotations: Annotation[];

  // Annotators with injected handlers
  annotators: Record<string, Annotator>;

  // Unified state (motivation-agnostic)
  focusedAnnotationId: string | null;
  hoveredAnnotationId?: string | null;

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

  // Pending selections (for creating new annotations)
  pendingCommentSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;

  pendingTagSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;

  pendingReferenceSelection?: {
    exact: string;
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
    svgSelector?: string;
  } | null;

  // Reference-specific props (TODO: refactor these into annotator handlers)
  allEntityTypes?: string[];
  generatingReferenceId?: string | null;
  onGenerateDocument?: (referenceId: string, options: { title: string; prompt?: string }) => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  onUpdateReference?: (referenceId: string, updates: Partial<Annotation>) => void;
  onCancelDetection?: () => void;
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

  // Group annotations by type
  const grouped = groupAnnotationsByType(props.annotations);

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

  // Auto-switch to the appropriate tab when an annotation is focused
  useEffect(() => {
    if (!props.focusedAnnotationId) return;

    // Find which annotation type this focused annotation belongs to
    const focusedAnnotation = props.annotations.find(ann => ann.id === props.focusedAnnotationId);
    if (!focusedAnnotation) return;

    // Determine the annotator key for this annotation
    for (const [key, annotator] of Object.entries(props.annotators)) {
      if (annotator.matchesAnnotation(focusedAnnotation)) {
        setActiveTab(key as AnnotatorKey);
        break;
      }
    }
  }, [props.focusedAnnotationId, props.annotations, props.annotators]);

  // Auto-switch to the appropriate tab when creating a new annotation
  useEffect(() => {
    if (props.pendingCommentSelection) {
      setActiveTab('comment');
    }
  }, [props.pendingCommentSelection]);

  useEffect(() => {
    if (props.pendingTagSelection) {
      setActiveTab('tag');
    }
  }, [props.pendingTagSelection]);

  useEffect(() => {
    if (props.pendingReferenceSelection) {
      setActiveTab('reference');
    }
  }, [props.pendingReferenceSelection]);

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
          const PanelComponent = PANEL_COMPONENTS[activeTab];
          if (!PanelComponent) return null;

          // Statistics panel (special case - doesn't use annotators)
          if (activeTab === 'statistics') {
            return (
              <PanelComponent
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

          // Common props for all panels
          const commonProps = {
            annotations,
            onAnnotationClick: annotator.handlers?.onClick,
            focusedAnnotationId: props.focusedAnnotationId,
            hoveredAnnotationId: props.hoveredAnnotationId,
            onAnnotationHover: annotator.handlers?.onHover,
            onDetect: annotator.handlers?.onDetect,
            isDetecting,
            detectionProgress,
            annotateMode: props.annotateMode
          };

          // Reference panel has special props
          if (activeTab === 'reference') {
            return (
              <PanelComponent
                {...commonProps}
                onCreate={annotator.handlers?.onCreate}
                pendingSelection={props.pendingReferenceSelection}
                allEntityTypes={props.allEntityTypes || []}
                onCancelDetection={props.onCancelDetection || (() => {})}
                onGenerateDocument={props.onGenerateDocument}
                onSearchDocuments={props.onSearchDocuments}
                onUpdate={props.onUpdateReference}
                mediaType={props.mediaType}
                referencedBy={props.referencedBy}
                referencedByLoading={props.referencedByLoading}
                Link={props.Link}
                routes={props.routes}
              />
            );
          }

          // Comment panel needs onUpdate
          if (activeTab === 'comment') {
            if (!annotator.handlers?.onUpdate) return null;
            return (
              <PanelComponent
                {...commonProps}
                onUpdate={annotator.handlers.onUpdate}
                onCreate={annotator.handlers?.onCreate}
                pendingSelection={props.pendingCommentSelection}
              />
            );
          }

          // Tag panel needs onCreate and pendingSelection
          if (activeTab === 'tag') {
            return (
              <PanelComponent
                {...commonProps}
                onCreate={annotator.handlers?.onCreate}
                pendingSelection={props.pendingTagSelection}
              />
            );
          }

          // Highlight and Assessment panels use commonProps only
          return <PanelComponent {...commonProps} />;
        })()}
      </div>
    </div>
  );
}
